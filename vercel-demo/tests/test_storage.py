import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from storage import ReadingStore


class StorageTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.database = Path(self.directory.name) / "sensors.sqlite3"
        self.store = ReadingStore(self.database)
        self.store.initialize()

    def tearDown(self):
        self.directory.cleanup()

    def test_restart_preserves_readings_and_continues_sequence(self):
        first = self.store.capture()
        restarted = ReadingStore(self.database)
        restarted.initialize()
        second = restarted.capture()
        self.assertEqual(first["sequence"], 1)
        self.assertEqual(second["sequence"], 2)
        snapshot = restarted.snapshot(60)
        self.assertEqual(snapshot["total"], 2)
        self.assertEqual(snapshot["readings"][0], first)

    def test_simultaneous_sampling_does_not_overwrite_data(self):
        with ThreadPoolExecutor(max_workers=4) as pool:
            readings = list(pool.map(lambda _: self.store.capture(), range(20)))
        self.assertEqual(sorted(item["sequence"] for item in readings), list(range(1, 21)))
        self.assertEqual(self.store.snapshot(60)["total"], 20)

    def test_history_limit_returns_latest_in_chronological_order(self):
        for _ in range(5):
            self.store.capture()
        snapshot = self.store.snapshot(3)
        self.assertEqual(snapshot["total"], 5)
        self.assertEqual([item["sequence"] for item in snapshot["readings"]], [3, 4, 5])
        for item in snapshot["readings"]:
            self.assertEqual(item["source"], "simulated")
            self.assertGreaterEqual(item["pm25_ug_m3"], 0)
            self.assertGreaterEqual(item["noise_db"], 0)
            self.assertTrue(item["recorded_at"].endswith("+00:00"))


if __name__ == "__main__":
    unittest.main()
