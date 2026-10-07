'use strict';

const ui = {
    fileInput: document.getElementById('file-input'),
    verify: document.getElementById('verify'),
    verifyResult: document.getElementById('verify-result'),
    fileName: document.getElementById('file-name'),
    fileSize: document.getElementById('file-size'),
    localHash: document.getElementById('local-hash'),
    chainStatus: document.getElementById('chain-status'),
    anchorTx: document.getElementById('anchor-tx'),
    blockTime: document.getElementById('block-time'),
    blockNumber: document.getElementById('block-number'),
    verifyStatus: document.getElementById('verify-status'),
};

let chainConfig = null;
let chainAbi = null;
let provider = null;

async function init() {
    try {
        const [abiRes, cfgRes] = await Promise.all([
            fetch('/static/abi.json', { cache: 'no-store' }),
            fetch('/static/chain-config.json', { cache: 'no-store' }),
        ]);
        chainAbi = await abiRes.json();
        chainConfig = await cfgRes.json();
        provider = new ethers.providers.JsonRpcProvider(chainConfig.rpc_url);
    } catch (error) {
        console.error('初始化失败:', error);
    }
}

async function sha256Hex(buffer) {
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

async function verifyFile() {
    const file = ui.fileInput.files[0];
    if (!file) {
        alert('请选择一个批次 JSON 文件。');
        return;
    }
    if (!provider || !chainConfig) {
        alert('链配置未加载，请刷新页面重试。');
        return;
    }
    ui.verify.disabled = true;
    ui.verify.textContent = '验证中…';
    try {
        const buffer = await file.arrayBuffer();
        const hash = await sha256Hex(buffer);
        const dataHashBytes32 = '0x' + hash;

        ui.fileName.textContent = file.name;
        ui.fileSize.textContent = `${file.size} 字节`;
        ui.localHash.textContent = dataHashBytes32;
        ui.chainStatus.textContent = '查询链上事件…';
        ui.anchorTx.textContent = '—';
        ui.blockTime.textContent = '—';
        ui.blockNumber.textContent = '—';
        ui.verifyStatus.textContent = '—';
        ui.verifyStatus.className = '';
        ui.verifyResult.hidden = false;

        const metadataResponse = await fetch(`/api/hash/${hash}`, { cache: 'no-store' });
        if (!metadataResponse.ok) throw new Error('这个文件指纹不在当前项目的批次记录中。');
        const batch = await metadataResponse.json();
        if (!batch.anchor_verified || !batch.anchor_tx) {
            ui.chainStatus.textContent = '项目记录中尚无已核实的链上交易';
            ui.verifyStatus.textContent = '✗ 文件尚无可验证的链上存证';
            ui.verifyStatus.className = 'verify-bad';
            return;
        }

        const receipt = await provider.getTransactionReceipt(`0x${batch.anchor_tx}`);
        if (!receipt || receipt.status !== 1) throw new Error('存证交易暂时无法读取或未成功确认。');
        const contract = new ethers.Contract(chainConfig.contract_address, chainAbi, provider);
        const event = receipt.logs
            .filter(log => log.address.toLowerCase() === chainConfig.contract_address.toLowerCase())
            .map(log => { try { return contract.interface.parseLog(log); } catch { return null; } })
            .find(parsed => parsed
                && parsed.name === 'DataRecorded'
                && parsed.args.streamId.toNumber() === Number(chainConfig.stream_id)
                && parsed.args.dataHash.toLowerCase() === dataHashBytes32.toLowerCase()
                && parsed.args.cid === batch.file_name);

        if (!event) {
            throw new Error('交易回执里没有与文件哈希、数据流和批次文件名都匹配的存证事件。');
        }
        ui.chainStatus.textContent = '✓ 已从 BOT Chain 回执核对存证事件';
        ui.anchorTx.textContent = receipt.transactionHash;
        const block = await provider.getBlock(receipt.blockNumber);
        if (!block) throw new Error('区块时间暂不可读取。');
        ui.blockTime.textContent = new Date(block.timestamp * 1000).toLocaleString('zh-CN', { hour12: false });
        ui.blockNumber.textContent = receipt.blockNumber;
        ui.verifyStatus.textContent = '✓ 验证通过：文件 SHA-256 与交易回执中的链上存证一致';
        ui.verifyStatus.className = 'verify-ok';
    } catch (error) {
        ui.chainStatus.textContent = '查询失败';
        ui.verifyStatus.textContent = `验证失败: ${error.message || error}`;
        ui.verifyStatus.className = 'verify-bad';
    } finally {
        ui.verify.disabled = false;
        ui.verify.textContent = '验证文件';
    }
}

ui.verify.addEventListener('click', verifyFile);
init();
