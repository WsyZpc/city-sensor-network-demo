// Run with: node tests/frontend_smoke.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHash, webcrypto } = require('node:crypto');

const staticDir = path.join(__dirname, '..', 'templates', 'static');

async function walletPromptStartsWithAccountRequest() {
  const methods = [];
  const account = '0x' + '1'.repeat(40);
  const selected = {
    isMetaMask: true,
    async request({ method }) {
      methods.push(method);
      if (method === 'eth_requestAccounts') return [account];
      if (method === 'eth_chainId') return '0x2a5';
      throw new Error(`Unexpected wallet method: ${method}`);
    },
    on() {},
  };
  const window = { ethereum: selected, addEventListener() {}, dispatchEvent() {} };
  const ethers = {
    providers: { Web3Provider: class {
      getSigner(address) { return { address }; }
    } },
    utils: { getAddress: address => address },
  };
  vm.runInNewContext(fs.readFileSync(path.join(staticDir, 'wallet.js'), 'utf8'), { window, ethers, Event });
  const result = await window.SensorWallet.connect({ chain_id_hex: '0x2a5' });
  assert.equal(result.address, account);
  assert.equal(methods[0], 'eth_requestAccounts');
}

async function browserSamplingSurvivesOldServerSnapshots() {
  const elements = new Map();
  class Element {
    constructor(id) {
      this.id = id;
      this.textContent = '';
      this.hidden = false;
      this.disabled = false;
      this.clientWidth = 640;
      this.clientHeight = 260;
      this.children = [];
      this.listeners = {};
      this.style = {};
      this.classList = { add() {}, remove() {}, toggle() {} };
    }
    replaceChildren() { this.children = []; }
    append(...children) { this.children.push(...children); }
    setAttribute() {}
    addEventListener(type, handler) { this.listeners[type] = handler; }
  }
  const document = {
    readyState: 'complete',
    hidden: false,
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, new Element(id));
      return elements.get(id);
    },
    createElement: tag => new Element(tag),
    querySelectorAll: () => [],
    addEventListener() {},
  };
  const saved = new Map();
  const localStorage = {
    getItem: key => saved.get(key) ?? null,
    setItem: (key, value) => saved.set(key, value),
  };
  const base = Date.parse('2026-10-08T00:00:00Z');
  const reading = (sequence, offset) => ({
    node_id: 'wuhan-demo-001', sequence,
    recorded_at: new Date(base + offset * 1000).toISOString(),
    pm25_ug_m3: 26 + offset, noise_db: 53 + offset, source: 'simulated',
  });
  let sampleCount = 0;
  let walletConnected = false;
  let submittedHash = '';
  const txHash = '0x' + 'a'.repeat(64);
  const batchJson = '{"readings":[]}';
  const batchHash = createHash('sha256').update(batchJson).digest('hex');
  const demoBatch = { batch_seq: 1, file_name: 'batch-000001.json', sha256_hex: batchHash,
    reading_count: 1, sealed_at: new Date(base).toISOString() };
  const fetch = async (url, options = {}) => {
    let body;
    if (url.startsWith('/api/readings')) {
      body = { total: 12, readings: [reading(10, 0), reading(11, 1), reading(12, 2)],
        sampling_mode: 'browser', interval_seconds: 1, sampling_error: false };
    } else if (url === '/api/sample' && options.method === 'POST') {
      sampleCount += 1;
      body = reading(13, 3 + sampleCount);
    } else if (url.endsWith('/anchor') && options.method === 'POST') {
      body = { anchor_verified: true };
    } else if (url.startsWith('/api/batches')) body = {
      batches: [demoBatch],
      ...(url.includes('include_files=true') ? { batch_files: { [batchHash]: Buffer.from(batchJson).toString('base64') } } : {}),
    };
    else if (url === '/api/access') body = { authenticated: walletConnected, can_download: walletConnected };
    else if (url.startsWith('/api/auth/challenge')) body = { message: 'Demo sign-in challenge' };
    else if (url === '/api/auth/verify') body = { authenticated: true };
    else if (url === '/static/abi.json') body = [];
    else if (url === '/static/chain-config.json') {
      body = { chain_id_decimal: 677, contract_address: '0x' + '1'.repeat(40) };
    } else throw new Error(`Unexpected request: ${url}`);
    return { ok: true, json: async () => body };
  };
  const window = { addEventListener() {}, ResizeObserver: null };
  const context = { document, window, localStorage, fetch, AbortSignal, console,
    setTimeout, clearTimeout, Date, Map, Set, TextEncoder, TextDecoder,
    crypto: webcrypto, atob };
  vm.runInNewContext(fs.readFileSync(path.join(staticDir, 'app.js'), 'utf8'), context);
  await new Promise(resolve => setTimeout(resolve, 1250));
  assert.ok(sampleCount >= 2, `Expected repeat sampling, got ${sampleCount}`);
  assert.ok(Number(elements.get('total').textContent) >= 14, 'Displayed total must advance');
  assert.ok(elements.get('records').children.length > 3, 'New samples must remain visible after old snapshots');
  assert.ok(JSON.parse(saved.get('city-sensor-network:browser-readings')).length >= 2);
  assert.match(elements.get('chain-status').textContent, /配置已读取/);
  assert.equal(typeof elements.get('sample-json').listeners.click, 'function');
  assert.equal(elements.get('sample').disabled, false);
  await elements.get('wallet-login').listeners.click();
  assert.match(elements.get('error').textContent, /未检测到 MetaMask/);
  window.ethereum = {};
  const ethers = { Contract: class {
    async owner() { return '0x' + '1'.repeat(40); }
    async recordData(_streamId, dataHash, _fileName) {
      submittedHash = dataHash;
      return { hash: txHash, wait: async () => ({ status: 1, blockNumber: 12345 }) };
    }
  } };
  window.ethers = ethers;
  context.ethers = ethers;
  const SensorWallet = { async connect(config) {
    assert.equal(config.chain_id_decimal, 677);
    walletConnected = true;
    return { address: '0x' + '1'.repeat(40), provider: {}, signer: {
      signMessage: async () => '0xsignature', getAddress: async () => '0x' + '1'.repeat(40),
    } };
  } };
  window.SensorWallet = SensorWallet;
  context.SensorWallet = SensorWallet;
  await elements.get('wallet-login').listeners.click();
  assert.equal(walletConnected, true, 'Homepage wallet button must call the provider');
  assert.equal(elements.get('wallet-logout').hidden, false);
  await new Promise(resolve => setTimeout(resolve, 100));
  const cached = JSON.parse(saved.get('city-sensor-network:batch-json'));
  assert.equal(cached[batchHash], batchJson, 'Authorized listing must preserve verified original JSON');
  await elements.get('seal').listeners.click();
  const browserBatch = JSON.parse(saved.get('city-sensor-network:batches'))
    .find(batch => batch.browser_generated);
  assert.ok(browserBatch, 'Online seal must create a browser-owned batch');
  const browserJson = JSON.parse(saved.get('city-sensor-network:batch-json'))[browserBatch.sha256_hex];
  assert.ok(browserJson, 'Browser-owned batch must preserve the original JSON before anchoring');
  assert.equal(createHash('sha256').update(browserJson).digest('hex'), browserBatch.sha256_hex);
  assert.ok(JSON.parse(browserJson).readings.length >= 2);
  assert.match(elements.get('anchor-feedback').children[1].textContent, /现在可下载 JSON/);
  const localRow = elements.get('batches').children
    .find(row => row.children[3]?.children[0]?.title === '0x' + browserBatch.sha256_hex);
  assert.ok(localRow);
  await localRow.children[4].children[0].listeners.click();
  assert.equal(submittedHash, '0x' + browserBatch.sha256_hex);
  assert.match(elements.get('anchor-feedback').children[0].textContent, /主网存证成功/);
  assert.match(elements.get('anchor-feedback').children[2].href, /scan\.botchain\.ai\/tx\/0x/);
  assert.equal(JSON.parse(saved.get('city-sensor-network:anchors'))[browserBatch.sha256_hex].anchor_verified, true);
}

(async () => {
  await walletPromptStartsWithAccountRequest();
  await browserSamplingSurvivesOldServerSnapshots();
  process.stdout.write('Frontend wallet and sampling smoke checks passed.\n');
  process.exit(0);
})().catch(error => { console.error(error); process.exit(1); });
