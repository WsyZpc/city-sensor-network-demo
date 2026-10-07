"""本地演示用的一次性钱包签名登录。私钥始终留在钱包中。"""

import re
import secrets
import threading
import base64
import json
from datetime import datetime, timedelta, timezone

from eth_keys import keys
from eth_keys.exceptions import BadSignature, ValidationError
from eth_utils import keccak, to_checksum_address


def recover_wallet_address(message: str, signature: str) -> str:
    """恢复 MetaMask personal_sign / ethers.signMessage 的 EIP-191 签名地址。

    只使用签名恢复功能，避免导入 eth-account 的密钥文件加密依赖。
    消息长度按 UTF-8 字节数计算，兼容包含中文的签名消息。
    """
    if not re.fullmatch(r"0x[0-9a-fA-F]{130}", signature or ""):
        raise ValueError("钱包签名必须为 65 字节的十六进制字符串。")
    raw = bytes.fromhex(signature[2:])
    recovery_id = raw[64]
    if recovery_id in (27, 28):
        recovery_id -= 27
    if recovery_id not in (0, 1):
        raise ValueError("钱包签名的恢复标记无效。")
    payload = message.encode("utf-8")
    digest = keccak(b"\x19Ethereum Signed Message:\n" + str(len(payload)).encode("ascii") + payload)
    parsed = keys.Signature(signature_bytes=raw[:64] + bytes([recovery_id]))
    return parsed.recover_public_key_from_msg_hash(digest).to_checksum_address()


class WalletSessions:
    _STATEMENT = (
        "Sign in to verify wallet ownership and request private sensor data. "
        "This signature sends no transaction and spends no tokens."
    )

    def __init__(self, ttl_seconds: int = 3600, challenge_seconds: int = 300):
        self.ttl_seconds = ttl_seconds
        self.challenge_seconds = challenge_seconds
        self.challenges: dict[str, tuple[str, str, datetime]] = {}
        self.sessions: dict[str, tuple[str, datetime]] = {}
        self._lock = threading.Lock()

    @staticmethod
    def normalize_address(address: str) -> str:
        if not re.fullmatch(r"0x[0-9a-fA-F]{40}", address or ""):
            raise ValueError("请输入有效的 EVM 钱包地址。")
        try:
            return to_checksum_address(address)
        except ValueError as error:
            raise ValueError("钱包地址的校验和格式无效。") from error

    def create_challenge(self, address: str, domain: str, uri: str, chain_id: int) -> tuple[str, str, int]:
        address = self.normalize_address(address)
        now = datetime.now(timezone.utc)
        nonce = secrets.token_hex(16)
        message = (
            f"{domain} wants you to sign in with your Ethereum account:\n"
            f"{address}\n\n"
            f"{self._STATEMENT}\n\n"
            f"URI: {uri}\n"
            "Version: 1\n"
            f"Chain ID: {chain_id}\n"
            f"Nonce: {nonce}\n"
            f"Issued At: {now.isoformat(timespec='seconds').replace('+00:00', 'Z')}\n"
            f"Expiration Time: {(now + timedelta(seconds=self.ttl_seconds)).isoformat(timespec='seconds').replace('+00:00', 'Z')}"
        )
        token = secrets.token_urlsafe(32)
        with self._lock:
            self._prune(now)
            self.challenges[token] = (address, message, now + timedelta(seconds=self.challenge_seconds))
        return token, message, self.challenge_seconds

    def consume_challenge(
        self,
        token: str,
        address: str,
        signature: str,
        message: str | None = None,
        *,
        domain: str | None = None,
        uri: str | None = None,
        chain_id: int | None = None,
    ) -> str | None:
        now = datetime.now(timezone.utc)
        with self._lock:
            item = self.challenges.pop(token, None)
        if item is not None:
            expected, signed_message, challenge_expiration = item
            if message is not None and message != signed_message:
                return None
        else:
            signed_message = message
            if signed_message is None and token.startswith("v1."):
                # Backward compatibility for challenge cookies issued before
                # clients sent the signed message in the verify request.
                encoded = token[3:]
                encoded += "=" * (-len(encoded) % 4)
                try:
                    signed_message = base64.urlsafe_b64decode(encoded.encode()).decode("utf-8")
                except (ValueError, UnicodeError):
                    return None
            if signed_message is None:
                return None
            expected = address
            challenge_expiration = now + timedelta(seconds=self.challenge_seconds)

        try:
            expected = self.normalize_address(expected)
            if expected.lower() != self.normalize_address(address).lower():
                return None
            parts = self._parse_message(signed_message)
            if parts["address"].lower() != expected.lower():
                return None
            if domain is not None and parts["domain"] != domain:
                return None
            if uri is not None and parts["uri"] != uri:
                return None
            if chain_id is not None and int(parts["chain_id"]) != int(chain_id):
                return None
            issued_at = datetime.fromisoformat(parts["issued_at"].replace("Z", "+00:00"))
            signed_expiration = datetime.fromisoformat(parts["expiration"].replace("Z", "+00:00"))
        except (ValueError, TypeError, KeyError):
            return None
        if (
            challenge_expiration <= now
            or issued_at > now + timedelta(seconds=30)
            or issued_at < now - timedelta(seconds=self.challenge_seconds)
            or signed_expiration <= now
            or signed_expiration > issued_at + timedelta(seconds=self.ttl_seconds)
        ):
            return None
        try:
            recovered = recover_wallet_address(signed_message, signature)
        except (ValueError, TypeError, BadSignature, ValidationError):
            return None
        if recovered.lower() != expected.lower():
            return None
        # The signed challenge itself is a short-lived, domain-bound session
        # proof. Every Vercel instance can validate it without shared memory.
        proof = json.dumps(
            {"message": signed_message, "signature": signature},
            separators=(",", ":"),
        ).encode("utf-8")
        return "v2." + base64.urlsafe_b64encode(proof).decode("ascii").rstrip("=")

    @classmethod
    def _parse_message(cls, message: str) -> dict[str, str]:
        pattern = (
            r"(?P<domain>[^\s]+) wants you to sign in with your Ethereum account:\n"
            r"(?P<address>0x[0-9a-fA-F]{40})\n\n"
            + re.escape(cls._STATEMENT)
            + r"\n\nURI: (?P<uri>https?://[^\s]+)\n"
            r"Version: 1\n"
            r"Chain ID: (?P<chain_id>[0-9]+)\n"
            r"Nonce: (?P<nonce>[0-9a-f]{32})\n"
            r"Issued At: (?P<issued_at>[0-9T:.+\-Z]+)\n"
            r"Expiration Time: (?P<expiration>[0-9T:.+\-Z]+)"
        )
        match = re.fullmatch(pattern, message or "")
        if not match:
            raise ValueError("签名挑战格式无效。")
        return match.groupdict()

    def get_address(
        self,
        session: str | None,
        *,
        domain: str | None = None,
        uri: str | None = None,
        chain_id: int | None = None,
    ) -> str | None:
        if not session:
            return None
        if session.startswith("v2."):
            try:
                encoded = session[3:]
                encoded += "=" * (-len(encoded) % 4)
                payload = json.loads(base64.urlsafe_b64decode(encoded.encode()).decode("utf-8"))
                message = payload["message"]
                signature = payload["signature"]
                parts = self._parse_message(message)
                address = self.normalize_address(parts["address"])
                if domain is not None and parts["domain"] != domain:
                    return None
                if uri is not None and parts["uri"] != uri:
                    return None
                if chain_id is not None and int(parts["chain_id"]) != int(chain_id):
                    return None
                now = datetime.now(timezone.utc)
                issued_at = datetime.fromisoformat(parts["issued_at"].replace("Z", "+00:00"))
                expires_at = datetime.fromisoformat(parts["expiration"].replace("Z", "+00:00"))
                if issued_at > now + timedelta(seconds=30) or expires_at <= now or expires_at > issued_at + timedelta(seconds=self.ttl_seconds):
                    return None
                recovered = recover_wallet_address(message, signature)
                return address if recovered.lower() == address.lower() else None
            except (ValueError, UnicodeError, TypeError, KeyError, BadSignature, ValidationError):
                return None
        now = datetime.now(timezone.utc)
        with self._lock:
            item = self.sessions.get(session)
            if item is None or item[1] <= now:
                self.sessions.pop(session, None)
                return None
            return item[0]

    def revoke(self, session: str | None):
        if session:
            with self._lock:
                self.sessions.pop(session, None)

    def _prune(self, now: datetime):
        self.challenges = {key: value for key, value in self.challenges.items() if value[2] > now}
        self.sessions = {key: value for key, value in self.sessions.items() if value[1] > now}
        if len(self.challenges) > 5000:
            self.challenges = dict(list(self.challenges.items())[-2500:])
        if len(self.sessions) > 10000:
            self.sessions = dict(list(self.sessions.items())[-5000:])
