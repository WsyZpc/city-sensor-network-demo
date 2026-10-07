"""SQLite 存储。序号在数据库事务中生成，重启或同时采样都不会覆盖记录。"""

import sqlite3
from contextlib import contextmanager
from pathlib import Path

from simulator import make_reading


class ReadingStore:
    def __init__(self, database: Path):
        self.database = database

    @contextmanager
    def connect(self):
        connection = sqlite3.connect(self.database, timeout=10)
        connection.row_factory = sqlite3.Row
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    def initialize(self):
        self.database.parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as connection:
            connection.execute("PRAGMA journal_mode=WAL")
            connection.execute("""
                CREATE TABLE IF NOT EXISTS readings (
                    sequence INTEGER PRIMARY KEY,
                    node_id TEXT NOT NULL,
                    recorded_at TEXT NOT NULL,
                    pm25_ug_m3 REAL NOT NULL CHECK(pm25_ug_m3 >= 0),
                    noise_db REAL NOT NULL CHECK(noise_db >= 0),
                    source TEXT NOT NULL CHECK(source = 'simulated')
                )
            """)

    def capture(self) -> dict:
        with self.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            last = connection.execute("SELECT * FROM readings ORDER BY sequence DESC LIMIT 1").fetchone()
            reading = make_reading(last["sequence"] + 1 if last else 1, dict(last) if last else None)
            connection.execute("""
                INSERT INTO readings (sequence, node_id, recorded_at, pm25_ug_m3, noise_db, source)
                VALUES (:sequence, :node_id, :recorded_at, :pm25_ug_m3, :noise_db, :source)
            """, reading)
            return reading

    def snapshot(self, limit: int) -> dict:
        with self.connect() as connection:
            connection.execute("BEGIN")
            total = connection.execute("SELECT COUNT(*) FROM readings").fetchone()[0]
            rows = connection.execute("SELECT * FROM readings ORDER BY sequence DESC LIMIT ?", (limit,)).fetchall()
            return {"total": total, "readings": [dict(row) for row in reversed(rows)]}
