// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * 数据存证合约（DataAttestation）
 *
 * 把每个数据批次的 SHA-256 指纹登记到 BOT Chain 上。
 * 买家下载批次文件后，可以重新计算文件指纹，与链上记录比对，
 * 从而验证数据在打包之后是否被篡改。
 *
 * 注意：本合约只能证明"文件与存证时一致"，不能证明传感器测得准确。
 */
contract DataAttestation {
    address public owner;

    // 节点白名单：node_id => 已授权提交的钱包地址
    mapping(string => address) public nodeSubmitter;

    // 批次存证：node_id => batch_seq => 指纹
    mapping(string => mapping(uint256 => bytes32)) public batchHash;

    // 批次提交者：node_id => batch_seq => 提交者地址
    mapping(string => mapping(uint256 => address)) public batchSubmitter;

    // 批次提交时间：node_id => batch_seq => 区块时间戳
    mapping(string => mapping(uint256 => uint256)) public batchSealedAt;

    // 存证事件
    event BatchAnchored(string indexed nodeId, uint256 indexed batchSeq, bytes32 indexed dataHash, address submitter, uint256 sealedAt);

    // 交易哈希查询事件（前端通过日志查询，比 mapping 更灵活）
    modifier onlyOwner() {
        require(msg.sender == owner, "only owner");
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    /// @notice 登记一个节点及其授权提交者地址
    /// @param nodeId  节点编号，例如 "wuhan-demo-001"
    /// @param submitter 该节点被允许提交存证的钱包地址
    function registerNode(string memory nodeId, address submitter) external onlyOwner {
        require(bytes(nodeId).length > 0, "empty nodeId");
        require(submitter != address(0), "zero submitter");
        nodeSubmitter[nodeId] = submitter;
    }

    /// @notice 把一个批次的 SHA-256 指纹登记上链
    /// @param nodeId  节点编号
    /// @param batchSeq 批次序号（与后端 batches 表一致）
    /// @param dataHash 批次文件原始字节的 SHA-256，作为 bytes32 传入
    function anchorBatch(string memory nodeId, uint256 batchSeq, bytes32 dataHash) external {
        require(nodeSubmitter[nodeId] == msg.sender, "not authorized submitter");
        require(dataHash != bytes32(0), "zero hash");
        require(batchHash[nodeId][batchSeq] == bytes32(0), "batch already anchored");

        batchHash[nodeId][batchSeq] = dataHash;
        batchSubmitter[nodeId][batchSeq] = msg.sender;
        batchSealedAt[nodeId][batchSeq] = block.timestamp;

        emit BatchAnchored(nodeId, batchSeq, dataHash, msg.sender, block.timestamp);
    }

    /// @notice 查询某个批次的链上指纹，用于买家校验
    function getBatchHash(string memory nodeId, uint256 batchSeq) external view returns (bytes32) {
        return batchHash[nodeId][batchSeq];
    }

    /// @notice 校验：给定指纹是否与链上记录一致
    function verify(string memory nodeId, uint256 batchSeq, bytes32 dataHash) external view returns (bool) {
        return batchHash[nodeId][batchSeq] != bytes32(0) && batchHash[nodeId][batchSeq] == dataHash;
    }
}
