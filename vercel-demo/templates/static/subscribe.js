'use strict';

const BOT_CHAIN_TESTNET = {
    chainId: '0x3c8',
    chainName: 'BOT Chain Testnet',
    nativeCurrency: { name: 'BOHR', symbol: 'BOT', decimals: 18 },
    rpcUrls: ['https://rpc.bohr.life'],
    blockExplorerUrls: ['https://test.bohrchain.com'],
};
const STREAM_ID = 0;

const ui = {
    connect: document.getElementById('connect'),
    subscribe: document.getElementById('subscribe'),
    walletInfo: document.getElementById('wallet-info'),
    chainId: document.getElementById('chain-id'),
    networkName: document.getElementById('network-name'),
    address: document.getElementById('address'),
    balance: document.getElementById('balance'),
    subscriptionStatus: document.getElementById('subscription-status'),
    subscriptionEnd: document.getElementById('subscription-end'),
    streamInfo: document.getElementById('stream-info'),
    streamName: document.getElementById('stream-name'),
    pricePerDay: document.getElementById('price-per-day'),
    days: document.getElementById('days'),
    totalPrice: document.getElementById('total-price'),
};

let provider, signer, contract, config;
const MAX_SUBSCRIPTION_INDEX = 8192;

function isMissingSubscriptionIndex(error) {
    return error.code === 'CALL_EXCEPTION' || /execution reverted|revert|panic code/i.test(error.message || '');
}

async function findLastSubscription(address) {
    const lookup = async index => {
        try {
            return await contract.mySubs(address, index);
        } catch (error) {
            if (isMissingSubscriptionIndex(error)) return null;
            throw error;
        }
    };
    if (await lookup(0) === null) return null;
    let low = 0, high = 1;
    while (high < MAX_SUBSCRIPTION_INDEX && await lookup(high) !== null) {
        low = high;
        high = Math.min(high * 2, MAX_SUBSCRIPTION_INDEX);
    }
    if (high === MAX_SUBSCRIPTION_INDEX && await lookup(high) !== null) {
        throw new Error('该账户的订阅记录过多，暂时无法显示最近到期时间。');
    }
    while (high - low > 1) {
        const middle = Math.floor((low + high) / 2);
        if (await lookup(middle) === null) high = middle;
        else low = middle;
    }
    for (let index = low; index >= Math.max(0, low - 64); index--) {
        const id = await lookup(index);
        if (id === null) continue;
        const sub = await contract.subs(id);
        if (sub.subscriber.toLowerCase() === address.toLowerCase()
            && sub.streamId.toNumber() === STREAM_ID) return sub;
    }
    return null;
}

async function loadConfig() {
    const [abiRes, cfgRes] = await Promise.all([
        fetch('/static/abi.json', { cache: 'no-store' }),
        fetch('/static/chain-config.json', { cache: 'no-store' }),
    ]);
    return { abi: await abiRes.json(), config: await cfgRes.json() };
}

async function init() {
    try {
        const loaded = await loadConfig();
        config = loaded.config;
        const readOnlyProvider = new ethers.providers.JsonRpcProvider(config.rpc_url);
        const readOnlyContract = new ethers.Contract(config.contract_address, loaded.abi, readOnlyProvider);
        const stream = await readOnlyContract.streams(STREAM_ID);
        const pricePerDayWei = stream.pricePerDay;
        const pricePerDayEth = ethers.utils.formatEther(pricePerDayWei);
        ui.streamName.textContent = stream.name;
        ui.pricePerDay.textContent = pricePerDayEth;
        ui.streamInfo.textContent = `数据流 #${STREAM_ID} · ${pricePerDayEth} BOT/天 · 状态: ${stream.active ? '活跃' : '已停用'}`;
        updateTotalPrice();
    } catch (error) {
        ui.streamInfo.textContent = `加载链上信息失败: ${error.message}`;
    }
}

function updateTotalPrice() {
    const priceText = ui.pricePerDay.textContent;
    if (!priceText || priceText === '—') return;
    const days = parseInt(ui.days.value) || 0;
    const total = parseFloat(priceText) * days;
    ui.totalPrice.textContent = `${total.toFixed(6)} BOT`;
}

async function connectWallet() {
    if (typeof window.ethereum === 'undefined') {
        alert('请安装 MetaMask 浏览器钱包插件。');
        return;
    }
    try {
        await window.ethereum.request({ method: 'eth_requestAccounts' });
        provider = new ethers.providers.Web3Provider(window.ethereum);
        signer = provider.getSigner();
        const network = await provider.getNetwork();

        if (network.chainId !== config.chain_id_decimal) {
            try {
                await window.ethereum.request({
                    method: 'wallet_addEthereumChain',
                    params: [BOT_CHAIN_TESTNET],
                });
                provider = new ethers.providers.Web3Provider(window.ethereum);
                signer = provider.getSigner();
                if ((await provider.getNetwork()).chainId !== config.chain_id_decimal) {
                    alert(`钱包尚未切换到 BOT Chain 测试网（Chain ID ${config.chain_id_decimal}）。`);
                    return;
                }
            } catch (addError) {
                alert(`请在 MetaMask 中切换到 BOT Chain 测试网（Chain ID ${config.chain_id_decimal}）。`);
                return;
            }
        }

        const abi = await (await fetch('/static/abi.json', { cache: 'no-store' })).json();
        contract = new ethers.Contract(config.contract_address, abi, signer);
        const address = await signer.getAddress();
        const challengeResponse = await fetch(`/api/auth/challenge?address=${encodeURIComponent(address)}`, { credentials: 'same-origin' });
        if (!challengeResponse.ok) throw new Error((await challengeResponse.json()).detail || '获取登录签名失败。');
        const challenge = await challengeResponse.json();
        const signature = await signer.signMessage(challenge.message);
        const loginResponse = await fetch('/api/auth/verify', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ address, signature }),
        });
        if (!loginResponse.ok) throw new Error((await loginResponse.json()).detail || '钱包签名登录失败。');
        await updateWalletInfo();

        ui.connect.textContent = '钱包已验证';
        ui.connect.disabled = true;
        ui.subscribe.disabled = false;
        ui.walletInfo.hidden = false;
    } catch (error) {
        console.error('连接钱包失败:', error);
        alert('连接钱包失败: ' + (error.message || '未知错误'));
    }
}

async function updateWalletInfo() {
    try {
        const address = await signer.getAddress();
        const balance = await provider.getBalance(address);
        const network = await provider.getNetwork();

        ui.chainId.textContent = network.chainId;
        ui.networkName.textContent = config.chain_name;
        ui.address.textContent = address;
        ui.balance.textContent = ethers.utils.formatEther(balance) + ' BOT';

        try {
            const valid = await contract.isValidSub(address, STREAM_ID);
            ui.subscriptionStatus.textContent = valid ? '✓ 已订阅' : '未订阅';
            ui.subscriptionStatus.className = valid ? 'verify-ok' : '';

            if (valid) {
                const sub = await findLastSubscription(address);
                if (sub) {
                    ui.subscriptionEnd.textContent = new Date(sub.endTime.toNumber() * 1000).toLocaleString('zh-CN', { hour12: false });
                } else {
                    ui.subscriptionStatus.textContent = '有效；未找到该数据流的订阅记录';
                    ui.subscriptionEnd.textContent = '—';
                }
            } else {
                ui.subscriptionEnd.textContent = '—';
            }
        } catch (error) {
            ui.subscriptionStatus.textContent = '查询失败';
        }
    } catch (error) {
        console.error('更新钱包信息失败:', error);
        ui.address.textContent = '获取失败';
        ui.balance.textContent = '—';
        ui.subscriptionStatus.textContent = '—';
        ui.subscriptionEnd.textContent = '—';
    }
}

async function subscribe() {
    const days = parseInt(ui.days.value);
    if (!days || days < 1) {
        alert('请输入有效的订阅天数。');
        return;
    }
    ui.subscribe.disabled = true;
    ui.subscribe.textContent = '交易中…';
    try {
        const pricePerDay = (await contract.streams(STREAM_ID)).pricePerDay;
        const cost = pricePerDay.mul(days);
        const tx = await contract.subscribe(STREAM_ID, days, { value: cost });
        ui.subscribe.textContent = '等待确认…';
        await tx.wait();
        alert('订阅成功！交易哈希: ' + tx.hash);
        await updateWalletInfo();
    } catch (error) {
        console.error('订阅失败:', error);
        alert('订阅失败: ' + (error.message || '未知错误'));
    } finally {
        ui.subscribe.disabled = false;
        ui.subscribe.textContent = '购买订阅';
    }
}

ui.connect.addEventListener('click', connectWallet);
ui.subscribe.addEventListener('click', subscribe);
ui.days.addEventListener('input', updateTotalPrice);
init();

if (window.ethereum?.on) {
    window.ethereum.on('accountsChanged', () => window.location.reload());
    window.ethereum.on('chainChanged', () => window.location.reload());
}
