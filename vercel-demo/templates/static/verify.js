'use strict';

const ui = {
    fileInput: document.getElementById('file-input'),
    verify: document.getElementById('verify'),
    verifyResult: document.getElementById('verify-result'),
    selectedFile: document.getElementById('selected-file'),
    fileName: document.getElementById('file-name'),
    fileSize: document.getElementById('file-size'),
    localHash: document.getElementById('local-hash'),
    claimedHash: document.getElementById('claimed-hash'),
    registryStatus: document.getElementById('registry-status'),
    chainStatus: document.getElementById('chain-status'),
    anchorTx: document.getElementById('anchor-tx'),
    blockTime: document.getElementById('block-time'),
    blockNumber: document.getElementById('block-number'),
    verifyStatus: document.getElementById('verify-status'),
    fraudDownload: document.getElementById('download-fraud-sample'),
    fraudStatus: document.getElementById('fraud-demo-status'),
};

let chainConfig = null;
let chainAbi = null;
let provider = null;
let initPromise = null;
const anchorsStorageKey = 'city-sensor-network:anchors';

function savedAnchor(hash) {
    try { return JSON.parse(localStorage.getItem(anchorsStorageKey) || '{}')[hash] || null; } catch { return null; }
}

function init() {
    if (provider && chainConfig && chainAbi) return Promise.resolve();
    if (initPromise) return initPromise;
    initPromise = (async () => {
        const [abiRes, cfgRes] = await Promise.all([
            fetch('/static/abi.json', { cache: 'no-store', signal: AbortSignal.timeout(8000) }),
            fetch('/static/chain-config.json', { cache: 'no-store', signal: AbortSignal.timeout(8000) }),
        ]);
        if (!abiRes.ok || !cfgRes.ok) throw new Error('链配置接口暂不可用。');
        chainAbi = await abiRes.json();
        chainConfig = await cfgRes.json();
        if (!Array.isArray(chainAbi) || Number(chainConfig.chain_id_decimal) !== 677) {
            throw new Error('BOT Chain 主网配置无效。');
        }
        provider = new ethers.providers.JsonRpcProvider(chainConfig.rpc_url);
    })().catch(error => { initPromise = null; throw error; });
    return initPromise;
}

async function sha256Hex(buffer) {
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

function randomHex(byteCount) {
    const bytes = crypto.getRandomValues(new Uint8Array(byteCount));
    return '0x' + Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

function downloadFraudSample() {
    const now = new Date().toISOString();
    const id = randomHex(8).slice(2);
    const fileName = `unverified-sensor-demo-${id}.json`;
    const payload = {
        demo_notice: '演示用未存证文件；以下读数、指纹与交易哈希均为模拟内容。',
        batch_seq: Number.parseInt(id.slice(0, 8), 16),
        node_id: `unverified-demo-${id}`,
        created_at: now,
        claimed_sha256: randomHex(32),
        claimed_anchor_tx: randomHex(32),
        readings: [{ sequence: 1, recorded_at: now, pm25_ug_m3: 28.4, noise_db: 55.2, source: 'simulated-unverified' }],
    };
    const blob = new Blob([JSON.stringify(payload, null, 2) + '\n'], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    ui.fraudStatus.textContent = `已下载 ${fileName}。请在下方选择它，然后点击“验证文件”。`;
}

function showVerificationFailure(message) {
    ui.verifyStatus.textContent = `未通过链上存证验证：${message}`;
    ui.verifyStatus.className = 'verify-bad';
}

async function verifyFile() {
    const file = ui.fileInput.files[0];
    if (!file) {
        alert('请选择一个批次 JSON 文件。');
        return;
    }
    ui.verify.disabled = true;
    ui.verify.textContent = '验证中…';
    try {
        const buffer = await file.arrayBuffer();
        const hash = await sha256Hex(buffer);
        const dataHashBytes32 = '0x' + hash;
        let payload;
        try {
            payload = JSON.parse(new TextDecoder().decode(buffer));
        } catch {
            throw new Error('文件不是有效的 JSON，无法验证。');
        }
        if (!payload || !Array.isArray(payload.readings) || !Number.isInteger(payload.batch_seq)) {
            throw new Error('JSON 缺少批次号或 readings 数组，无法验证。');
        }

        ui.fileName.textContent = file.name;
        ui.fileSize.textContent = `${file.size} 字节`;
        ui.localHash.textContent = dataHashBytes32;
        const claimedHash = typeof payload.claimed_sha256 === 'string' ? payload.claimed_sha256 : '';
        ui.claimedHash.textContent = claimedHash
            ? `${claimedHash}（${claimedHash.toLowerCase() === dataHashBytes32.toLowerCase() ? '一致' : '与实算指纹不一致'}）`
            : '—';
        ui.claimedHash.className = claimedHash && claimedHash.toLowerCase() !== dataHashBytes32.toLowerCase()
            ? 'hash claim-mismatch' : 'hash';
        ui.registryStatus.textContent = '查询中…';
        ui.chainStatus.textContent = '查询链上事件…';
        ui.anchorTx.textContent = '—';
        ui.blockTime.textContent = '—';
        ui.blockNumber.textContent = '—';
        ui.verifyStatus.textContent = '—';
        ui.verifyStatus.className = '';
        ui.verifyResult.hidden = false;

        const metadataResponse = await fetch(`/api/hash/${hash}`, { cache: 'no-store', signal: AbortSignal.timeout(8000) });
        if (!metadataResponse.ok && metadataResponse.status !== 404) {
            throw new Error(`项目指纹索引暂不可用（${metadataResponse.status}），无法得出未登记结论。`);
        }
        const registeredBatch = metadataResponse.ok ? await metadataResponse.json() : null;
        ui.registryStatus.textContent = registeredBatch ? '✓ 已收录服务端批次' : '未收录云端；继续核验链上凭证';
        const localAnchor = savedAnchor(hash);
        const batch = registeredBatch || (localAnchor ? {
            sha256_hex: hash,
            file_name: localAnchor.file_name,
            anchor_tx: localAnchor.anchor_tx,
            anchor_verified: true,
        } : null);
        if (localAnchor?.anchor_verified && batch && !batch.anchor_verified) {
            batch.anchor_tx = localAnchor.anchor_tx;
            batch.file_name = localAnchor.file_name;
            batch.anchor_verified = true;
        }
        const claimedTx = typeof payload.claimed_anchor_tx === 'string' && /^0x[0-9a-fA-F]{64}$/.test(payload.claimed_anchor_tx)
            ? payload.claimed_anchor_tx : '';
        const txHash = batch?.anchor_tx || claimedTx;
        if (!txHash) {
            ui.chainStatus.textContent = '没有可核验的交易哈希';
            showVerificationFailure(registeredBatch ? '批次已登记，但尚未提供存证交易。' : '项目索引未登记，也没有交易线索。');
            return;
        }
        await init();
        ui.anchorTx.textContent = txHash;
        const receipt = await provider.getTransactionReceipt(txHash.startsWith('0x') ? txHash : `0x${txHash}`);
        if (!receipt) {
            ui.chainStatus.textContent = batch ? '登记的交易暂时查无回执' : '文件声称的交易在主网上查无回执';
            showVerificationFailure('找不到可核验的主网存证交易。');
            return;
        }
        if (receipt.status !== 1) throw new Error('存证交易未成功确认。');
        const contract = new ethers.Contract(chainConfig.contract_address, chainAbi, provider);
        const event = receipt.logs
            .filter(log => log.address.toLowerCase() === chainConfig.contract_address.toLowerCase())
            .map(log => { try { return contract.interface.parseLog(log); } catch { return null; } })
            .find(parsed => parsed
                && parsed.name === 'DataRecorded'
                && parsed.args.streamId.toNumber() === Number(chainConfig.stream_id)
                && parsed.args.dataHash.toLowerCase() === dataHashBytes32.toLowerCase()
                && parsed.args.cid === (batch?.file_name || file.name));

        if (!event) {
            throw new Error('交易回执里没有与文件哈希、数据流和批次文件名都匹配的存证事件。');
        }
        ui.chainStatus.textContent = '✓ 已从 BOT Chain 回执核对存证事件';
        if (!registeredBatch) ui.registryStatus.textContent = '未收录云端；链上凭证已匹配';
        ui.anchorTx.textContent = receipt.transactionHash;
        const block = await provider.getBlock(receipt.blockNumber);
        if (!block) throw new Error('区块时间暂不可读取。');
        ui.blockTime.textContent = new Date(block.timestamp * 1000).toLocaleString('zh-CN', { hour12: false });
        ui.blockNumber.textContent = receipt.blockNumber;
        if (claimedHash && claimedHash.toLowerCase() !== dataHashBytes32.toLowerCase()) {
            showVerificationFailure('文件自称的指纹与实际 SHA-256 不一致。');
        } else {
            ui.verifyStatus.textContent = '✓ 验证通过：文件 SHA-256 与交易回执中的链上存证一致';
            ui.verifyStatus.className = 'verify-ok';
        }
    } catch (error) {
        ui.chainStatus.textContent = '查询失败';
        showVerificationFailure(error.message || String(error));
    } finally {
        ui.verify.disabled = false;
        ui.verify.textContent = '验证文件';
    }
}

ui.verify.addEventListener('click', verifyFile);
ui.fraudDownload.addEventListener('click', downloadFraudSample);
ui.fileInput.addEventListener('change', () => {
    const file = ui.fileInput.files[0];
    ui.selectedFile.textContent = file ? `${file.name} · ${(file.size / 1024).toFixed(1)} KB` : '尚未选择文件';
    ui.verify.disabled = !file;
    ui.verify.textContent = file ? '验证文件' : '选择文件后验证';
});
void init().catch(error => console.warn('链配置暂未加载，验证时将重试:', error));
