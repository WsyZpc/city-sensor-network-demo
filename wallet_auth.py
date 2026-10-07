"""本地演示用的一次性钱包签名登录。私钥始终留在钱包中。"""

import re
import secrets
import threading
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
            "Sign in to verify wallet ownership and request private sensor data. "
            "This signature sends no transaction and spends no tokens.\n\n"
            f"URI: {uri}\n"
            "Version: 1\n"
            f"Chain ID: {chain_id}\n"
            f"Nonce: {nonce}\n"
            f"Issued At: {now.isoformat(timespec='seconds').replace('+00:00', 'Z')}\n"
            f"Expiration Time: {(now + timedelta(seconds=self.challenge_seconds)).isoformat(timespec='seconds').replace('+00:00', 'Z')}"
        )
        token = secrets.token_urlsafe(32)
        with self._lock:
            self._prune(now)
            self.challenges[token] = (address, message, now + timedelta(seconds=self.challenge_seconds))
        return token, message, self.challenge_seconds

    def consume_challenge(self, token: str, address: str, signature: str) -> str | None:
        now = datetime.now(timezone.utc)
        with self._lock:
            item = self.challenges.pop(token, None)
        if item is None or item[2] <= now or item[0].lower() != address.lower():
            return None
        try:
            recovered = recover_wallet_address(item[1], signature)
        except (ValueError, TypeError, BadSignature, ValidationError):
            return None
        if recovered.lower() != address.lower():
            return None
        session = secrets.token_urlsafe(32)
        with self._lock:
            self.sessions[session] = (address, now + timedelta(seconds=self.ttl_seconds))
        return session

    def get_address(self, session: str | None) -> str | None:
        if not session:
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
