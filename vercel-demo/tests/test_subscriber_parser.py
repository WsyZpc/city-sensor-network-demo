import hashlib
import json
import unittest
from unittest.mock import patch

from fastapi import HTTPException

import app as webapp
from chain import ChainError


ADDRESS = "0x" + "22" * 20


class FakeChain:
    def __init__(self, valid=False, offline=False, owner=ADDRESS):
        self.valid = valid
        self.offline = offline
        self.calls = 0
        self._owner = owner

    def owner(self):
        return self._owner

    def subscription(self, address, stream_id):
        self.calls += 1
        if self.offline:
            raise ChainError("RPC unavailable")
        return {"valid": self.valid}


class SubscriberParserTests(unittest.TestCase):
    def setUp(self):
        self.payload = {
            "batch_seq": 7,
            "node_id": "wuhan-demo-001",
            "sealed_at": "2026-10-13T08:00:00Z",
            "reading_count": 2,
            "readings": [
                {"sequence": 1, "recorded_at": "2026-10-13T07:59:59Z", "pm25_ug_m3": 20, "noise_db": 50},
                {"sequence": 2, "recorded_at": "2026-10-13T08:00:00Z", "pm25_ug_m3": 30, "noise_db": 60},
            ],
        }
        self.contents = json.dumps(self.payload, ensure_ascii=False).encode("utf-8")

    def post(self, contents=None):
        class FakeRequest:
            async def stream(self):
                yield self_contents

        self_contents = self.contents if contents is None else contents
        coroutine = webapp.parse_subscriber_file(FakeRequest())
        try:
            coroutine.send(None)
        except StopIteration as done:
            return done.value
        raise AssertionError("The in-memory test request unexpectedly suspended")

    def test_public_shell_but_guest_cannot_parse(self):
        self.assertTrue(str(webapp.parser_page().path).endswith("parser.html"))
        chain = FakeChain(valid=True)
        with patch.object(webapp, "session_address", return_value=None), patch.object(webapp, "chain", chain):
            with self.assertRaises(HTTPException) as error:
                self.post()
        self.assertEqual(error.exception.status_code, 401)
        self.assertEqual(chain.calls, 0)

    def test_owner_subscription_status_is_not_falsely_marked_invalid(self):
        chain = FakeChain(valid=True, owner=ADDRESS)
        with patch.object(webapp, "session_address", return_value=ADDRESS), patch.object(webapp, "chain", chain):
            access = webapp.access_status(object())
            result = self.post()
        self.assertTrue(access["owner_access"])
        self.assertTrue(access["subscription"]["valid"])
        self.assertTrue(access["can_download"])
        self.assertEqual(result["reading_count"], 2)
        self.assertEqual(chain.calls, 2)

    def test_logged_in_wallet_without_subscription_cannot_parse(self):
        chain = FakeChain(valid=False)
        with patch.object(webapp, "session_address", return_value=ADDRESS), patch.object(webapp, "chain", chain):
            with self.assertRaises(HTTPException) as error:
                self.post()
        self.assertEqual(error.exception.status_code, 403)
        self.assertIn("有效订阅", error.exception.detail)
        self.assertEqual(chain.calls, 1)

    def test_valid_subscriber_gets_stats_rows_and_exact_fingerprint(self):
        with patch.object(webapp, "session_address", return_value=ADDRESS), patch.object(webapp, "chain", FakeChain(valid=True)):
            result = self.post()
        self.assertEqual(result["sha256_hex"], hashlib.sha256(self.contents).hexdigest())
        self.assertEqual(result["reading_count"], 2)
        self.assertEqual(result["pm25"], {"min": 20, "max": 30, "average": 25, "latest": 30})
        self.assertEqual(result["noise"]["average"], 55)
        self.assertTrue(result["declared_count_matches"])
        self.assertEqual(len(result["readings"]), 2)

    def test_parser_rejects_invalid_json_and_oversize(self):
        with patch.object(webapp, "session_address", return_value=ADDRESS), patch.object(webapp, "chain", FakeChain(valid=True)):
            with self.assertRaises(HTTPException) as invalid:
                self.post(b"not-json")
            self.assertEqual(invalid.exception.status_code, 422)
            with self.assertRaises(HTTPException) as oversize:
                self.post(b"x" * (webapp.MAX_PARSE_BYTES + 1))
            self.assertEqual(oversize.exception.status_code, 413)
            broken = {**self.payload, "readings": [{**self.payload["readings"][0], "pm25_ug_m3": "25"}]}
            with self.assertRaises(HTTPException) as malformed:
                self.post(json.dumps(broken).encode())
            self.assertEqual(malformed.exception.status_code, 422)

    def test_chain_failure_denies_access(self):
        with patch.object(webapp, "session_address", return_value=ADDRESS), patch.object(webapp, "chain", FakeChain(offline=True)):
            with self.assertRaises(HTTPException) as error:
                self.post()
        self.assertEqual(error.exception.status_code, 503)


if __name__ == "__main__":
    unittest.main()
