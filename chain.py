"""与配置中的 BOT Chain 测试网交互，只读 RPC 不会持有钱包私钥。"""

import itertools
import json
import re
import time
import urllib.error
import urllib.request

from eth_abi import decode, encode
from eth_utils import keccak, to_checksum_address


class ChainError(RuntimeError):
    """链节点无法访问，或链上数据无法核验。"""


class BotChain:
    def __init__(self, config: dict, timeout: int = 8):
        self.config = config
        self.rpc_url = config["rpc_url"]
        self.chain_id = int(config["chain_id_decimal"])
        self.address = to_checksum_address(config["contract_address"])
        self.timeout = timeout
        self._ids = itertools.count(1)
        self._network_cache_until = 0.0

    def rpc(self, method: str, params: list):
        payload = json.dumps({"jsonrpc": "2.0", "id": next(self._ids), "method": method, "params": params}).encode()
        request = urllib.request.Request(self.rpc_url, data=payload, headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                body = json.loads(response.read())
        except (OSError, TimeoutError, urllib.error.URLError, json.JSONDecodeError) as error:
            raise ChainError("暂时无法连接 BOT Chain 测试网，请稍后重试。") from error
        if body.get("error"):
            detail = body["error"].get("message", "RPC 请求失败。")
            raise ChainError(f"BOT Chain RPC：{detail}")
        return body.get("result")

    def ensure_network(self):
        if time.monotonic() < self._network_cache_until:
            return
        chain_id = int(self.rpc("eth_chainId", []), 16)
        if chain_id != self.chain_id:
            raise ChainError(f"RPC 返回 Chain ID {chain_id}，配置要求 {self.chain_id}。")
        self._network_cache_until = time.monotonic() + 30

    def call(self, signature: str, types: tuple[str, ...], values: tuple = (), output: tuple[str, ...] = ()):
        selector = keccak(text=signature)[:4]
        arguments = encode(types, values).hex() if types else ""
        result = self.rpc("eth_call", [{"to": self.address, "data": "0x" + selector.hex() + arguments}, "latest"])
        try:
            return decode(output, bytes.fromhex(result.removeprefix("0x"))) if output else result
        except (TypeError, ValueError) as error:
            raise ChainError("合约返回值与 ABI 不匹配。") from error

    def owner(self) -> str:
        try:
            self.ensure_network()
            (address,) = self.call("owner()", (), (), ("address",))
            return to_checksum_address(address)
        except Exception as error:
            if isinstance(error, ChainError):
                raise
            raise ChainError("无法读取合约 owner。") from error

    def subscription(self, address: str, stream_id: int = 0) -> dict:
        try:
            (valid,) = self.call("isValidSub(address,uint256)", ("address", "uint256"), (address, stream_id), ("bool",))
            return {"valid": bool(valid), "stream_id": stream_id}
        except Exception as error:
            if isinstance(error, ChainError):
                raise
            raise ChainError("无法读取钱包订阅状态。") from error

    def subscription_end(self, address: str, stream_id: int = 0, max_checks: int = 128):
        """用实际 ABI 的 mySubs(address,index) 查找最近订阅，不假定它返回数组。"""
        def item(index: int):
            try:
                (sub_id,) = self.call("mySubs(address,uint256)", ("address", "uint256"), (address, index), ("uint256",))
                (subscriber, sub_stream, end_time, active) = self.call(
                    "subs(uint256)", ("uint256",), (int(sub_id),), ("address", "uint256", "uint256", "bool")
                )
                return {"subscriber": to_checksum_address(subscriber), "stream_id": int(sub_stream), "end_time": int(end_time), "active": bool(active)}
            except ChainError as error:
                if "execution reverted" in str(error).lower() or "revert" in str(error).lower():
                    return None
                raise

        latest = item(0)
        if latest is None:
            return None
        low, high = 0, 1
        for _ in range(max_checks.bit_length()):
            if high >= max_checks:
                high = max_checks
                candidate = item(high)
                if candidate is not None:
                    return None
                break
            if item(high) is None:
                break
            low, high = high, high * 2
        while high - low > 1:
            middle = (low + high) // 2
            if item(middle) is None:
                high = middle
            else:
                low = middle
        for index in range(low, max(-1, low - 32), -1):
            candidate = item(index)
            if candidate and candidate["subscriber"].lower() == address.lower() and candidate["stream_id"] == stream_id:
                return candidate
        return latest if latest["stream_id"] == stream_id else None

    def verify_record_data_tx(self, tx_hash: str, batch: dict) -> dict:
        """确认钱包交易调用了目标合约，并发出与实际文件一致的事件。"""
        self.ensure_network()
        if not re.fullmatch(r"0x[0-9a-fA-F]{64}", tx_hash or ""):
            raise ChainError("交易哈希格式无效。")
        tx = self.rpc("eth_getTransactionByHash", [tx_hash])
        if tx is None:
            raise ChainError("找不到这笔链上交易。")
        if tx.get("to", "").lower() != self.address.lower():
            raise ChainError("交易目标不是配置的数据存证合约。")
        owner = self.owner()
        if tx.get("from", "").lower() != owner.lower():
            raise ChainError("只有数据存证合约 owner 才能提交该批次。")

        signature = "recordData(uint256,bytes32,string)"
        selector = "0x" + keccak(text=signature)[:4].hex()
        data = tx.get("input", "")
        if not data.startswith(selector):
            raise ChainError("交易调用的不是 recordData。")
        try:
            stream_id, data_hash, cid = decode(("uint256", "bytes32", "string"), bytes.fromhex(data[10:]))
        except (ValueError, TypeError) as error:
            raise ChainError("无法解析存证交易参数。") from error
        if int(stream_id) != int(self.config["stream_id"]):
            raise ChainError("交易使用的数据流与配置不一致。")
        if "0x" + data_hash.hex() != "0x" + batch["sha256_hex"].lower():
            raise ChainError("交易提交的哈希与批次文件不一致。")
        if cid != batch["file_name"]:
            raise ChainError("交易引用的文件名与批次不一致。")

        receipt = self.rpc("eth_getTransactionReceipt", [tx_hash])
        if not receipt or int(receipt.get("status", "0x0"), 16) != 1:
            raise ChainError("存证交易尚未成功确认。")
        expected_topic = "0x" + keccak(text="DataRecorded(uint256,bytes32,uint256,string)").hex()
        for log in receipt.get("logs", []):
            if log.get("address", "").lower() != self.address.lower():
                continue
            topics = log.get("topics", [])
            if len(topics) != 2 or topics[0].lower() != expected_topic.lower():
                continue
            if int(topics[1], 16) != int(stream_id):
                continue
            try:
                event_hash, timestamp, event_cid = decode(("bytes32", "uint256", "string"), bytes.fromhex(log["data"].removeprefix("0x")))
            except (ValueError, TypeError):
                continue
            if "0x" + event_hash.hex() == "0x" + batch["sha256_hex"].lower() and event_cid == cid:
                return {
                    "chain_id": self.chain_id,
                    "contract": self.address,
                    "stream_id": int(stream_id),
                    "submitter": to_checksum_address(tx["from"]),
                    "transaction_hash": tx_hash.lower(),
                    "block_number": int(receipt["blockNumber"], 16),
                    "timestamp": int(timestamp),
                    "data_hash": "0x" + event_hash.hex(),
                    "file_name": event_cid,
                    "verified": True,
                }
        raise ChainError("交易成功，但找不到与该批次哈希匹配的存证事件。")
