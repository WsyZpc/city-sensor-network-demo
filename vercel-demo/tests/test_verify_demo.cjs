// Run with: node tests/test_verify_demo.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHash, webcrypto } = require('node:crypto');

async function main() {
  const elements = new Map();
  const downloaded = [];
  const blobs = new Map();
  const contractAddress = '0x' + '1'.repeat(40);
  const validTx = '0x' + 'a'.repeat(64);
  let mode = 'fraud';
  let receiptChecks = 0;
  let currentHash = '';
  let currentFileName = '';

  class Element {
    constructor(id) {
      this.id = id;
      this.textContent = '';
      this.className = '';
      this.hidden = false;
      this.disabled = false;
      this.files = [];
      this.listeners = {};
    }
    addEventListener(type, handler) { this.listeners[type] = handler; }
    click() { downloaded.push({ name: this.download, blob: blobs.get(this.href) }); }
    remove() {}
  }
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, new Element(id));
      return elements.get(id);
    },
    createElement: tag => new Element(tag),
    body: { appendChild() {} },
  };
  const fetch = async url => {
    if (url === '/static/abi.json') return { ok: true, json: async () => [] };
    if (url === '/static/chain-config.json') return {
      ok: true, json: async () => ({ chain_id_decimal: 677, rpc_url: 'https://example.invalid', contract_address: contractAddress, stream_id: 0 }),
    };
    if (url.startsWith('/api/hash/')) {
      if (mode === 'server-error') return { ok: false, status: 500 };
      if (mode === 'fraud') return { ok: false, status: 404 };
      return { ok: true, json: async () => ({ file_name: currentFileName, anchor_tx: validTx, anchor_verified: true }) };
    }
    throw new Error(`Unexpected request ${url}`);
  };
  const ethers = {
    providers: { JsonRpcProvider: class {
      async getTransactionReceipt(txHash) {
        receiptChecks++;
        if (mode !== 'valid' || txHash !== validTx) return null;
        return { status: 1, transactionHash: validTx, blockNumber: 42, logs: [{ address: contractAddress }] };
      }
      async getBlock() { return { timestamp: 1791777600 }; }
    } },
    Contract: class {
      interface = { parseLog: () => ({
        name: 'DataRecorded', args: { streamId: { toNumber: () => 0 }, dataHash: '0x' + currentHash, cid: currentFileName },
      }) };
    },
  };
  let blobNumber = 0;
  const URL = {
    createObjectURL(blob) { const url = `blob:${++blobNumber}`; blobs.set(url, blob); return url; },
    revokeObjectURL() {},
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'templates', 'static', 'verify.js'), 'utf8'), {
    document, fetch, ethers, crypto: webcrypto, Blob, TextDecoder, AbortSignal,
    URL, localStorage: { getItem: () => null }, setTimeout() {}, console, alert() {},
  });

  const input = elements.get('file-input');
  const verify = elements.get('verify');
  const download = elements.get('download-fraud-sample');
  download.listeners.click();
  download.listeners.click();
  assert.equal(downloaded.length, 2);
  assert.notEqual(downloaded[0].name, downloaded[1].name, 'Each sample must have a fresh fingerprint');
  const fraud = JSON.parse(await downloaded[0].blob.text());
  assert.ok(Array.isArray(fraud.readings));
  assert.match(fraud.claimed_sha256, /^0x[0-9a-f]{64}$/);
  assert.match(fraud.claimed_anchor_tx, /^0x[0-9a-f]{64}$/);

  async function chooseAndVerify(blob, name) {
    input.files = [{ name, size: blob.size, arrayBuffer: () => blob.arrayBuffer() }];
    input.listeners.change();
    await verify.listeners.click();
  }
  await chooseAndVerify(downloaded[0].blob, downloaded[0].name);
  assert.match(elements.get('claimed-hash').textContent, /与实算指纹不一致/);
  assert.match(elements.get('registry-status').textContent, /未找到/);
  assert.match(elements.get('chain-status').textContent, /查无回执/);
  assert.match(elements.get('verify-status').textContent, /未通过链上存证验证/);
  assert.equal(elements.get('verify-status').className, 'verify-bad');
  assert.equal(receiptChecks, 1, 'The claimed transaction must be checked on-chain');

  mode = 'server-error';
  await chooseAndVerify(downloaded[0].blob, downloaded[0].name);
  assert.match(elements.get('verify-status').textContent, /索引暂不可用/);
  assert.equal(receiptChecks, 1, 'A server error must not be mistaken for a missing record');

  mode = 'valid';
  currentFileName = 'real-batch.json';
  const realBlob = new Blob([JSON.stringify({ batch_seq: 7, readings: [{ pm25_ug_m3: 20 }] })], { type: 'application/json' });
  currentHash = createHash('sha256').update(Buffer.from(await realBlob.arrayBuffer())).digest('hex');
  await chooseAndVerify(realBlob, currentFileName);
  assert.match(elements.get('registry-status').textContent, /找到对应批次/);
  assert.match(elements.get('chain-status').textContent, /已从 BOT Chain 回执核对/);
  assert.equal(elements.get('verify-status').className, 'verify-ok');
  console.log('Unanchored sample and verified batch checks passed.');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
