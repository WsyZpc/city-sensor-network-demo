"""SQLite/PostgreSQL 采样存储。"""

import re
import sqlite3
from contextlib import contextmanager
from pathlib import Path

from simulator import make_reading


class HybridRow(dict):
    """A PostgreSQL row that supports column names and SQLite-style indexes."""

    def __getitem__(self, key):
        if isinstance(key, int):
            return tuple(self.values())[key]
        return super().__getitem__(key)


def _hybrid_row(cursor):
    columns = [column.name for column in cursor.description]

    def make_row(values):
        return HybridRow(zip(columns, values))

    return make_row


class Database:
    """Small adapter allowing local SQLite and hosted PostgreSQL storage."""

    def __init__(self, location: str | Path):
        self.location = str(location)
        self.is_postgres = self.location.startswith(("postgres://", "postgresql://"))

    def connect(self):
        if self.is_postgres:
            try:
                import psycopg
            except ImportError as error:
                raise RuntimeError("PostgreSQL storage requires psycopg. Install requirements.txt.") from error
            return psycopg.connect(self.location, row_factory=_hybrid_row, connect_timeout=10)
        path = Path(self.location)
        path.parent.mkdir(parents=True, exist_ok=True)
        connection = sqlite3.connect(path, timeout=10)
        connection.row_factory = sqlite3.Row
        return connection

    def execute(self, connection, sql: str, parameters=None):
        if self.is_postgres:
            if sql in ("BEGIN IMMEDIATE", "BEGIN"):
                return connection.execute("SELECT 1")
            if isinstance(parameters, dict):
                sql = re.sub(r"(?<!:):([A-Za-z_]\w*)", r"%(\1)s", sql)
            else:
                sql = sql.replace("?", "%s")
        return connection.execute(sql, parameters or ())

    def lock_sequences(self, connection, key: int):
        if self.is_postgres:
            self.execute(connection, "SELECT pg_advisory_xact_lock(?)", (key,))


class ReadingStore:
    def __init__(self, database: str | Path):
        self.db = Database(database)
        self.database = database

    @contextmanager
    def connect(self):
        connection = self.db.connect()
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    def initialize(self):
        if not self.db.is_postgres:
            self.database.parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as connection:
            if not self.db.is_postgres:
                self.db.execute(connection, "PRAGMA journal_mode=WAL")
            self.db.execute(connection, """
                CREATE TABLE IF NOT EXISTS readings (
                    sequence {sequence_type} PRIMARY KEY,
                    node_id TEXT NOT NULL,
                    recorded_at TEXT NOT NULL,
                    pm25_ug_m3 REAL NOT NULL CHECK(pm25_ug_m3 >= 0),
                    noise_db REAL NOT NULL CHECK(noise_db >= 0),
                    source TEXT NOT NULL CHECK(source = 'simulated')
                )
            """.format(sequence_type="BIGINT" if self.db.is_postgres else "INTEGER"))

    def capture(self) -> dict:
        with self.connect() as connection:
            self.db.execute(connection, "BEGIN IMMEDIATE")
            self.db.lock_sequences(connection, 71001)
            last = self.db.execute(connection, "SELECT * FROM readings ORDER BY sequence DESC LIMIT 1").fetchone()
            reading = make_reading(last["sequence"] + 1 if last else 1, dict(last) if last else None)
            self.db.execute(connection, """
                INSERT INTO readings (sequence, node_id, recorded_at, pm25_ug_m3, noise_db, source)
                VALUES (:sequence, :node_id, :recorded_at, :pm25_ug_m3, :noise_db, :source)
            """, reading)
            return reading

    def snapshot(self, limit: int) -> dict:
        with self.connect() as connection:
            self.db.execute(connection, "BEGIN")
            total = self.db.execute(connection, "SELECT COUNT(*) FROM readings").fetchone()[0]
            rows = self.db.execute(connection, "SELECT * FROM readings ORDER BY sequence DESC LIMIT ?", (limit,)).fetchall()
            return {"total": total, "readings": [dict(row) for row in reversed(rows)]}
