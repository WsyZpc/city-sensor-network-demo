const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');
const ethers = require('../templates/static/ethers.umd.min.js');
const source = fs.readFileSync(require.resolve('../templates/static/wallet.js'), 'utf8');
const config = { chain_id_hex: '0x3c8', chain_id_decimal: 968, chain_name: 'Test', rpc_url: 'https://example.org', explorer_url: 'https://example.org' };
const address = '0x1111111111111111111111111111111111111111';
function wallet(options = {}) {
  let chain = options.chain || '0x3c8';
  const calls = [], listeners = {};
  return { isMetaMask: true, calls, listeners,
    on(name, fn) { listeners[name] = fn; },
    async request({ method, params }) {
      calls.push(method);
      if (method === 'eth_accounts') return [];
      if (method === 'eth_requestAccounts') return options.empty ? [] : [address];
      if (method === 'eth_chainId') return chain;
      if (method === 'wallet_switchEthereumChain') {
        if (options.reject) throw Object.assign(new Error('Rejected'), {code: 4001});
        chain = params[0].chainId; listeners.chainChanged?.(chain); return null;
      }
      throw new Error('Unexpected RPC ' + method);
    }
  };
}
function helper(ethereum) {
  const window = { ethereum, dispatchEvent() {} };
  vm.runInNewContext(source, {window, ethers, Event, WeakSet});
  return window.SensorWallet;
}
test('authorized address works even when eth_accounts is empty; select MetaMask among providers', async () => {
  const selected = wallet();
  const other = { request() { throw new Error('Wrong provider'); } };
  const {signer} = await helper({providers:[other,selected]}).connect(config);
  assert.equal(await signer.getAddress(), address);
  assert.equal(selected.calls.includes('eth_accounts'), false);
});
test('switch network and request account authorization again', async () => {
  const selected = wallet({chain:'0x1'});
  const connected = await helper(selected).connect(config);
  assert.equal(connected.address, address);
  assert.equal(selected.calls.filter(x=>x==='eth_requestAccounts').length, 2);
  assert.ok(selected.calls.includes('wallet_switchEthereumChain'));
});
test('empty authorization produces a useful error', async () => {
  await assert.rejects(helper(wallet({empty:true})).connect(config), /没有授权任何账户/);
});
test('cancelled network switch is reported without proceeding', async () => {
  await assert.rejects(helper(wallet({chain:'0x1',reject:true})).connect(config), /取消了钱包授权/);
});
test('browser sampling supports automatic, paused, manual, resumed and hidden-page behavior', async () => {
  let total=1, now=10000;
  const timers=[], elements=new Map();
  class Element {
    constructor(){ this.handlers={}; this.clientWidth=400; this.clientHeight=200; this.classList={toggle(){}}; }
    addEventListener(name,fn){this.handlers[name]=fn;}
    replaceChildren(){} append(){} setAttribute(){}
    click(){return this.handlers.click?.();}
  }
  const document={readyState:'complete',hidden:false, getElementById(id){if(!elements.has(id))elements.set(id,new Element());return elements.get(id);}, querySelectorAll(){return [];},createElement(){return new Element();},head:new Element()};
  const window={ethers,addEventListener(){}};
  class Clock extends Date {static now(){return now;}}
  const fetch=async(path,options={})=>{
    let body={};
    if(path.startsWith('/api/readings')) body={total,readings:[{sequence:total,recorded_at:new Date(now).toISOString(),pm25_ug_m3:25,noise_db:50}],sampling:false,sampling_mode:'browser',interval_seconds:5};
    else if(path.startsWith('/api/batches?')) body={batches:[]};
    else if(path==='/api/sample') { assert.equal(options.method,'POST');total++;body={sequence:total}; }
    else if(path==='/api/access') body={authenticated:false};
    else if(path==='/static/chain-config.json') body=config;
    return {ok:true,json:async()=>body};
  };
  const js=fs.readFileSync(require.resolve('../templates/static/app.js'),'utf8');
  vm.runInNewContext(js,{window,document,fetch,Date:Clock,AbortSignal,ResizeObserver:class{observe(){}},setTimeout(fn){timers.push(fn);},console});
  await new Promise(setImmediate);
  async function poll(){now+=6000;await timers.shift()();}
  await poll();assert.equal(total,2);
  elements.get('toggle').click();await poll();assert.equal(total,2);
  await elements.get('sample').click();assert.equal(total,3);
  elements.get('toggle').click();document.hidden=true;await poll();assert.equal(total,3);
  document.hidden=false;await poll();assert.equal(total,4);
});
