import unittest
from datetime import datetime, timedelta, timezone

from eth_keys.exceptions import BadSignature, ValidationError

from wallet_auth import WalletSessions, recover_wallet_address


# Generated independently with ethers 5 signMessage and public test private key 1.
# Never use this publicly known key for funds.
MESSAGE = "Sensor demo login · 城市数据"
ADDRESS = "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf"
SIGNATURE = (
    "0x3fd58fa026d87366dcc66982146fb163be331e9bdc50ef16d98e8b88aaab85fe367"
    "41c7fe2424af71a08118838f1058b3060b17d23ca11cac01abe883e6a75281c"
)


class WalletAuthTests(unittest.TestCase):
    def challenge(self, sessions, *, expired=False):
        token = "test-only-challenge"
        deadline = datetime.now(timezone.utc) + timedelta(seconds=-1 if expired else 60)
        sessions.challenges[token] = (ADDRESS, MESSAGE, deadline)
        return token

    def test_recovers_independent_ethers_unicode_signature(self):
        self.assertEqual(recover_wallet_address(MESSAGE, SIGNATURE), ADDRESS)
        self.assertEqual(recover_wallet_address(MESSAGE, SIGNATURE[:-2] + "01"), ADDRESS)

    def test_rejects_invalid_signature_encodings(self):
        for signature in ("", "0x00", "0x" + "00" * 65, SIGNATURE[:-2] + "02", "0x" + "ff" * 64 + "1b"):
            with self.subTest(signature=signature):
                with self.assertRaises((ValueError, BadSignature, ValidationError)):
                    recover_wallet_address(MESSAGE, signature)

    def test_login_is_one_time_and_can_be_revoked(self):
        sessions = WalletSessions()
        token = self.challenge(sessions)
        session = sessions.consume_challenge(token, ADDRESS, SIGNATURE)
        self.assertIsNotNone(session)
        self.assertEqual(sessions.get_address(session), ADDRESS)
        self.assertIsNone(sessions.consume_challenge(token, ADDRESS, SIGNATURE))
        sessions.revoke(session)
        self.assertIsNone(sessions.get_address(session))

    def test_rejects_changed_message_expired_challenge_and_other_wallet(self):
        sessions = WalletSessions()
        token = self.challenge(sessions)
        sessions.challenges[token] = (ADDRESS, MESSAGE + "!", sessions.challenges[token][2])
        self.assertIsNone(sessions.consume_challenge(token, ADDRESS, SIGNATURE))
        token = self.challenge(sessions, expired=True)
        self.assertIsNone(sessions.consume_challenge(token, ADDRESS, SIGNATURE))
        token = self.challenge(sessions)
        self.assertIsNone(sessions.consume_challenge(token, "0x" + "11" * 20, SIGNATURE))


if __name__ == "__main__":
    unittest.main()
