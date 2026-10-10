"""数据批次：把一段时间内的读数打包为固定格式的 JSON 文件，并计算 SHA-256 指纹。

文件字节一旦写定就不再改动；指纹是对文件原始字节计算的，
任何改动（包括重新拼装 JSON 导致的格式差异）都会让指纹变化。
"""

import hashlib
import json
import re
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

from simulator import NODE_ID
from storage import Database

BATCH_WINDOW_SECONDS = 60


class BatchStore:
    def __init__(self, database: str | Path, files_dir: Path):
        self.db = Database(database)
        self.database = database
        self.files_dir = files_dir

    @contextmanager
    def connect(self):
        connection = self.db.connect()
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    def initialize(self):
        self.files_dir.mkdir(parents=True, exist_ok=True)
        with self.connect() as connection:
            self.db.execute(connection, """
                CREATE TABLE IF NOT EXISTS batches (
                    batch_seq {sequence_type} PRIMARY KEY,
                    node_id TEXT NOT NULL,
                    first_sequence INTEGER NOT NULL,
                    last_sequence INTEGER NOT NULL,
                    reading_count INTEGER NOT NULL,
                    sealed_at TEXT NOT NULL,
                    file_name TEXT NOT NULL,
                    sha256_hex TEXT NOT NULL UNIQUE,
                    anchor_tx TEXT,
                    anchor_proof TEXT,
                    file_content {blob_type}
                )
            """.format(
                sequence_type="BIGINT" if self.db.is_postgres else "INTEGER",
                blob_type="BYTEA" if self.db.is_postgres else "BLOB",
            ))
            if self.db.is_postgres:
                self.db.execute(connection, "ALTER TABLE batches ADD COLUMN IF NOT EXISTS anchor_proof TEXT")
                self.db.execute(connection, "ALTER TABLE batches ADD COLUMN IF NOT EXISTS file_content BYTEA")
            else:
                existing_columns = {row["name"] for row in self.db.execute(connection, "PRAGMA table_info(batches)")}
                if "anchor_proof" not in existing_columns:
                    self.db.execute(connection, "ALTER TABLE batches ADD COLUMN anchor_proof TEXT")
                if "file_content" not in existing_columns:
                    self.db.execute(connection, "ALTER TABLE batches ADD COLUMN file_content BLOB")

    def file_path(self, batch: dict) -> Path:
        return self.files_dir / batch["file_name"]

    @staticmethod
    def _serialize(row) -> dict:
        result = dict(row)
        result.pop("file_content", None)
        raw_proof = result.get("anchor_proof")
        try:
            proof = json.loads(raw_proof) if raw_proof else None
        except (TypeError, json.JSONDecodeError):
            proof = None
        result["anchor_proof"] = proof
        result["anchor_verified"] = bool(
            result.get("anchor_tx")
            and proof
            and proof.get("verified") is True
            and proof.get("transaction_hash", "").lower() == result["anchor_tx"].lower()
            and proof.get("data_hash", "").lower() == ("0x" + result["sha256_hex"]).lower()
            and proof.get("file_name") == result["file_name"]
        )
        return result

    def seal(self) -> dict | None:
        """把尚未打包的读数写成一个批次文件。没有新读数时返回 None。"""
        with self.connect() as connection:
            self.db.execute(connection, "BEGIN IMMEDIATE")
            self.db.lock_sequences(connection, 71002)
            sealed_upto = self.db.execute(connection,
                "SELECT COALESCE(MAX(last_sequence), 0) FROM batches"
            ).fetchone()[0]
            rows = self.db.execute(connection,
                "SELECT * FROM readings WHERE sequence > ? ORDER BY sequence", (sealed_upto,)
            ).fetchall()
            if not rows:
                return None
            batch_seq = self.db.execute(connection,
                "SELECT COALESCE(MAX(batch_seq), 0) + 1 FROM batches"
            ).fetchone()[0]
            sealed_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
            payload = {
                "batch_seq": batch_seq,
                "node_id": NODE_ID,
                "first_sequence": rows[0]["sequence"],
                "last_sequence": rows[-1]["sequence"],
                "reading_count": len(rows),
                "sealed_at": sealed_at,
                "source": "simulated",
                "readings": [
                    {
                        "sequence": row["sequence"],
                        "recorded_at": row["recorded_at"],
                        "pm25_ug_m3": row["pm25_ug_m3"],
                        "noise_db": row["noise_db"],
                    }
                    for row in rows
                ],
            }
            data = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
            file_name = f"batch-{batch_seq:06d}.json"
            sha256_hex = hashlib.sha256(data).hexdigest()
            batch = {
                "batch_seq": batch_seq,
                "node_id": NODE_ID,
                "first_sequence": rows[0]["sequence"],
                "last_sequence": rows[-1]["sequence"],
                "reading_count": len(rows),
                "sealed_at": sealed_at,
                "file_name": file_name,
                "sha256_hex": sha256_hex,
                "anchor_tx": None,
                "file_content": data,
            }
            self.db.execute(connection, """
                INSERT INTO batches (batch_seq, node_id, first_sequence, last_sequence,
                                     reading_count, sealed_at, file_name, sha256_hex, anchor_tx, file_content)
                VALUES (:batch_seq, :node_id, :first_sequence, :last_sequence,
                        :reading_count, :sealed_at, :file_name, :sha256_hex, :anchor_tx, :file_content)
            """, batch)
        (self.files_dir / file_name).write_bytes(data)
        return {key: value for key, value in batch.items() if key != "file_content"}

    def list_recent(self, limit: int) -> list[dict]:
        with self.connect() as connection:
            rows = self.db.execute(connection,
                "SELECT * FROM batches ORDER BY batch_seq DESC LIMIT ?", (limit,)
            ).fetchall()
            return [self._serialize(row) for row in rows]

    def get(self, batch_seq: int) -> dict | None:
        with self.connect() as connection:
            row = self.db.execute(connection,
                "SELECT * FROM batches WHERE batch_seq = ?", (batch_seq,)
            ).fetchone()
            return self._serialize(row) if row else None

    def find_by_hash(self, sha256_hex: str) -> dict | None:
        normalized = sha256_hex.strip().lower().removeprefix("0x")
        with self.connect() as connection:
            row = self.db.execute(connection,
                "SELECT * FROM batches WHERE sha256_hex = ?", (normalized,)
            ).fetchone()
            return self._serialize(row) if row else None

    def save_anchor_tx(self, batch_seq: int, tx_hash: str, proof: dict) -> dict | None:
        """只保存已由链客户端验证、且匹配该批次的确认交易。"""
        normalized = tx_hash.strip().lower() if tx_hash else ""
        if (not re.fullmatch(r"0x[0-9a-f]{64}", normalized)
                or not proof.get("verified")
                or proof.get("transaction_hash", "").lower() != normalized):
            return None
        with self.connect() as connection:
            row = self.db.execute(connection,
                "SELECT * FROM batches WHERE batch_seq = ?", (batch_seq,)
            ).fetchone()
            if row is None:
                return None
            if row["anchor_tx"]:
                if row["anchor_tx"].lower() != normalized:
                    return None
                existing = self._serialize(row)
                if not existing["anchor_verified"]:
                    return None
                return existing
            self.db.execute(connection,
                "UPDATE batches SET anchor_tx = ?, anchor_proof = ? WHERE batch_seq = ? AND anchor_tx IS NULL",
                (normalized, json.dumps(proof, sort_keys=True), batch_seq),
            )
            return self._serialize(self.db.execute(connection,
                "SELECT * FROM batches WHERE batch_seq = ?", (batch_seq,)
            ).fetchone())

    def verify(self, batch_seq: int) -> dict | None:
        """重新计算批次文件的指纹，与打包时记录的指纹比对。"""
        batch = self.get(batch_seq)
        if batch is None:
            return None
        data = self.file_bytes(batch_seq)
        if data is None:
            return {**batch, "file_present": False, "matches": False, "file_sha256": None}
        file_sha256 = hashlib.sha256(data).hexdigest()
        return {
            **batch,
            "file_present": True,
            "file_sha256": file_sha256,
            "matches": file_sha256 == batch["sha256_hex"],
        }

    def file_bytes(self, batch_seq: int) -> bytes | None:
        """Return exact sealed bytes from durable storage, with legacy file fallback."""
        with self.connect() as connection:
            row = self.db.execute(
                connection, "SELECT file_content, file_name FROM batches WHERE batch_seq = ?", (batch_seq,)
            ).fetchone()
            if row is None:
                return None
            if row["file_content"] is not None:
                return bytes(row["file_content"])
            path = self.files_dir / row["file_name"]
            return path.read_bytes() if path.exists() else None
