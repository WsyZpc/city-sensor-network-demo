import tempfile
import unittest
import base64
import hashlib
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException

import app as webapp
from chain import ChainError


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
    def test_authorized_batch_listing_includes_verified_original_file(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "sensor-batch-test.json"
            data = b'{"readings":[]}'
            path.write_bytes(data)
            fingerprint = hashlib.sha256(data).hexdigest()

            class RecentBatches:
                def list_recent(self, limit):
                    return [{"sha256_hex": fingerprint, "file_name": path.name}]

                def file_path(self, batch):
                    return path

            with (
                patch.object(webapp, "session_address", return_value=OWNER),
                patch.object(webapp, "chain", FakeChain()),
                patch.object(webapp, "batches", RecentBatches()),
            ):
                result = webapp.list_batches(object(), limit=10, include_files=True)
            self.assertEqual(base64.b64decode(result["batch_files"][fingerprint]), data)

    def test_unauthorized_batch_listing_never_includes_file(self):
        class RecentBatches:
            def list_recent(self, limit):
                return [{"sha256_hex": HASH, "file_name": "batch.json"}]

        with (
            patch.object(webapp, "session_address", return_value=None),
            patch.object(webapp, "batches", RecentBatches()),
        ):
            result = webapp.list_batches(object(), limit=10, include_files=True)
        self.assertNotIn("batch_files", result)

    def test_corrupt_original_is_not_exported(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "batch.json"
            path.write_bytes(b'{}')
            with patch.object(webapp, "batches", FakeBatches(path)):
                self.assertIsNone(webapp.batch_file_base64({"file_name": path.name, "sha256_hex": HASH}))

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


class ReadingsFallbackTests(unittest.TestCase):
    def test_rpc_failure_keeps_public_sampling_available(self):
        class OfflineChain:
            def owner(self):
                raise ChainError("RPC unavailable")

        class PreviewStore:
            def snapshot(self, limit):
                self.limit = limit
                return {"total": 12, "readings": []}

        preview_store = PreviewStore()
        with (
            patch.object(webapp, "session_address", return_value=OWNER),
            patch.object(webapp, "chain", OfflineChain()),
            patch.object(webapp, "store", preview_store),
            patch.object(webapp.app.state, "sampling", False, create=True),
            patch.object(webapp.app.state, "sampling_error", False, create=True),
        ):
            result = webapp.readings(object(), limit=60)
        self.assertEqual(preview_store.limit, 3)
        self.assertTrue(result["preview_only"])
        self.assertIn("公开预览", result["access_warning"])


if __name__ == "__main__":
    unittest.main()
