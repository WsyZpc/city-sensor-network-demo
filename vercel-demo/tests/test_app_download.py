import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException

import app as webapp


OWNER = "0x" + "11" * 20
SUBSCRIBER = "0x" + "22" * 20
HASH = "a" * 64


class FakeChain:
    def __init__(self, owner=OWNER, subscribed=False):
        self._owner = owner
        self._subscribed = subscribed

    def owner(self):
        return self._owner

    def subscription(self, address, stream_id):
        return {"valid": self._subscribed}


class FakeBatches:
    def __init__(self, path):
        self.path = path

    def find_by_hash(self, sha256_hex):
        if sha256_hex.removeprefix("0x") != HASH:
            return None
        return {"sha256_hex": HASH, "file_name": "sensor-batch-test.json"}

    def file_path(self, batch):
        return self.path


class BatchDownloadTests(unittest.TestCase):
    def test_download_by_hash_requires_access_and_returns_exact_file(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "sensor-batch-test.json"
            path.write_text('{"readings":[]}', encoding="utf-8")
            request = object()
            with (
                patch.object(webapp, "required_address", return_value=OWNER),
                patch.object(webapp, "chain", FakeChain()),
                patch.object(webapp, "batches", FakeBatches(path)),
            ):
                response = webapp.download_batch_by_hash(HASH, request)
                self.assertEqual(Path(response.path), path)
                self.assertEqual(response.media_type, "application/json")

    def test_download_by_hash_rejects_non_subscriber(self):
        request = object()
        with (
            patch.object(webapp, "required_address", return_value=SUBSCRIBER),
            patch.object(webapp, "chain", FakeChain(owner=OWNER, subscribed=False)),
        ):
            with self.assertRaises(HTTPException) as error:
                webapp.download_batch_by_hash(HASH, request)
        self.assertEqual(error.exception.status_code, 403)


if __name__ == "__main__":
    unittest.main()
