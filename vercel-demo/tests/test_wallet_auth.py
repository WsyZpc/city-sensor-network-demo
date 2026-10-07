import unittest
from datetime import datetime, timedelta, timezone

from eth_keys import keys
from eth_utils import keccak

from wallet_auth import WalletSessions


PRIVATE_KEY = keys.PrivateKey((1).to_bytes(32, "big"))
ADDRESS = PRIVATE_KEY.public_key.to_checksum_address()
DOMAIN = "demo.example"
URI = "https://demo.example"
CHAIN_ID = 677


def sign_message(message: str) -> str:
    payload = message.encode("utf-8")
    digest = keccak(
        b"\x19Ethereum Signed Message:\n"
        + str(len(payload)).encode("ascii")
        + payload
    )
    return "0x" + PRIVATE_KEY.sign_msg_hash(digest).to_bytes().hex()


class WalletAuthTests(unittest.TestCase):
    def setUp(self):
        self.sessions = WalletSessions()

    def challenge(self):
        token, message, _ = self.sessions.create_challenge(ADDRESS, DOMAIN, URI, CHAIN_ID)
        return token, message, sign_message(message)

    def test_signed_challenge_survives_serverless_instance_change(self):
        token, message, signature = self.challenge()
        session = self.sessions.consume_challenge(
            token,
            ADDRESS,
            signature,
            message,
            domain=DOMAIN,
            uri=URI,
            chain_id=CHAIN_ID,
        )
        self.assertIsNotNone(session)

        # A different serverless worker has no challenge or session memory.
        other_instance = WalletSessions()
        self.assertEqual(
            other_instance.get_address(
                session,
                domain=DOMAIN,
                uri=URI,
                chain_id=CHAIN_ID,
            ),
            ADDRESS,
        )

    def test_rejects_wrong_site_chain_or_wallet(self):
        token, message, signature = self.challenge()
        for overrides in (
            {"domain": "attacker.example"},
            {"uri": "https://attacker.example"},
            {"chain_id": 968},
        ):
            with self.subTest(overrides=overrides):
                expected = {"domain": DOMAIN, "uri": URI, "chain_id": CHAIN_ID}
                expected.update(overrides)
                self.assertIsNone(
                    WalletSessions().consume_challenge(
                        token,
                        ADDRESS,
                        signature,
                        message,
                        **expected,
                    )
                )
        self.assertIsNone(
            WalletSessions().consume_challenge(
                token, "0x" + "11" * 20, signature, message,
                domain=DOMAIN, uri=URI, chain_id=CHAIN_ID,
            )
        )

    def test_rejects_tampered_message_and_invalid_signature(self):
        token, message, signature = self.challenge()
        self.assertIsNone(
            WalletSessions().consume_challenge(
                token, ADDRESS, signature, message + "!",
                domain=DOMAIN, uri=URI, chain_id=CHAIN_ID,
            )
        )
        self.assertIsNone(
            WalletSessions().consume_challenge(
                token, ADDRESS, "0x" + "00" * 65, message,
                domain=DOMAIN, uri=URI, chain_id=CHAIN_ID,
            )
        )

    def test_rejects_stale_in_memory_challenge(self):
        token, message, signature = self.challenge()
        address, saved_message, _ = self.sessions.challenges[token]
        self.sessions.challenges[token] = (
            address,
            saved_message,
            datetime.now(timezone.utc) - timedelta(seconds=1),
        )
        self.assertIsNone(
            self.sessions.consume_challenge(
                token, ADDRESS, signature, message,
                domain=DOMAIN, uri=URI, chain_id=CHAIN_ID,
            )
        )


if __name__ == "__main__":
    unittest.main()
