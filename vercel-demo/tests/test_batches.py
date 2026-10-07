import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from batches import BatchStore
from storage import ReadingStore


class BatchTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        root = Path(self.directory.name)
        self.database = root / "sensors.sqlite3"
        self.files_dir = root / "batches"
        self.store = ReadingStore(self.database)
        self.store.initialize()
        self.batches = BatchStore(self.database, self.files_dir)
        self.batches.initialize()

    def tearDown(self):
        self.directory.cleanup()

    def test_seal_writes_file_and_records_matching_hash(self):
        for _ in range(3):
            self.store.capture()
        batch = self.batches.seal()
        self.assertEqual(batch["batch_seq"], 1)
        self.assertEqual(batch["reading_count"], 3)
        self.assertEqual(batch["first_sequence"], 1)
        self.assertEqual(batch["last_sequence"], 3)
        path = self.batches.file_path(batch)
        self.assertTrue(path.exists())
        payload = json.loads(path.read_bytes().decode("utf-8"))
        self.assertEqual(payload["reading_count"], 3)
        self.assertEqual(len(payload["readings"]), 3)
        self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), batch["sha256_hex"])

    def test_seal_without_new_readings_returns_none(self):
        self.assertIsNone(self.batches.seal())
        self.store.capture()
        first = self.batches.seal()
        self.assertIsNotNone(first)
        self.assertIsNone(self.batches.seal())

    def test_consecutive_batches_do_not_overlap(self):
        for _ in range(2):
            self.store.capture()
        first = self.batches.seal()
        for _ in range(3):
            self.store.capture()
        second = self.batches.seal()
        self.assertEqual(first["last_sequence"], 2)
        self.assertEqual(second["first_sequence"], 3)
        self.assertEqual(second["last_sequence"], 5)
        self.assertEqual(self.batches.list_recent(10)[0]["batch_seq"], 2)

    def test_batches_survive_restart(self):
        self.store.capture()
        batch = self.batches.seal()
        restarted = BatchStore(self.database, self.files_dir)
        restarted.initialize()
        loaded = restarted.get(batch["batch_seq"])
        self.assertEqual(loaded["sha256_hex"], batch["sha256_hex"])

    def test_verify_detects_tampering(self):
        self.store.capture()
        batch = self.batches.seal()
        result = self.batches.verify(batch["batch_seq"])
        self.assertTrue(result["matches"])
        path = self.batches.file_path(batch)
        content = json.loads(path.read_bytes().decode("utf-8"))
        content["readings"][0]["pm25_ug_m3"] = 999.9
        path.write_bytes(json.dumps(content, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8"))
        result = self.batches.verify(batch["batch_seq"])
        self.assertFalse(result["matches"])
        self.assertIsNone(self.batches.find_by_hash(result["file_sha256"]))

    def test_find_by_hash_accepts_0x_prefix(self):
        self.store.capture()
        batch = self.batches.seal()
        found = self.batches.find_by_hash("0x" + batch["sha256_hex"].upper())
        self.assertEqual(found["batch_seq"], batch["batch_seq"])

    def test_save_anchor_tx_records_hash(self):
        self.store.capture()
        batch = self.batches.seal()
        tx_hash = "0x" + "ab" * 32
        proof = {
            "verified": True,
            "transaction_hash": tx_hash,
            "data_hash": "0x" + batch["sha256_hex"],
            "file_name": batch["file_name"],
        }
        result = self.batches.save_anchor_tx(batch["batch_seq"], tx_hash, proof)
        self.assertTrue(result["anchor_verified"])
        self.assertEqual(result["anchor_tx"], tx_hash)
        again = self.batches.save_anchor_tx(batch["batch_seq"], "0x" + "cd" * 32, {
            **proof, "transaction_hash": "0x" + "cd" * 32,
        })
        self.assertIsNone(again)

    def test_save_anchor_tx_rejects_nonexistent_batch(self):
        self.assertIsNone(self.batches.save_anchor_tx(999, "0x" + "ab" * 32, {"verified": True}))
        self.assertIsNone(self.batches.save_anchor_tx(1, "", {"verified": True}))


if __name__ == "__main__":
    unittest.main()
