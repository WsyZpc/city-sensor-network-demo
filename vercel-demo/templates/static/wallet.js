"use strict";
// Use the account explicitly authorized by the selected provider, not signer index 0.
window.SensorWallet = (() => {
  let connecting = false;
  const boundProviders = new WeakSet();
  async function connect(config) {
    const injected = window.ethereum;
    const selected = injected?.providers?.find(p => p.isMetaMask) || injected;
    if (!selected) throw new Error("未检测到钱包。请在安装并启用 MetaMask 的 Chrome/Edge 中打开此网址。");
    connecting = true;
    try {
      let accounts = await selected.request({ method: "eth_requestAccounts" });
      if (!accounts?.length) throw new Error("钱包没有授权任何账户。请解锁 MetaMask，并在连接此网站时勾选一个账户。");
      const chainId = config.chain_id_hex;
      if ((await selected.request({ method: "eth_chainId" })).toLowerCase() !== chainId.toLowerCase()) {
        try {
          await selected.request({ method: "wallet_switchEthereumChain", params: [{ chainId }] });
        } catch (error) {
          if (Number(error.code ?? error.data?.originalError?.code) !== 4902) throw error;
          await selected.request({ method: "wallet_addEthereumChain", params: [{
            chainId, chainName: config.chain_name,
            nativeCurrency: { name: "BOT", symbol: "BOT", decimals: 18 },
            rpcUrls: [config.rpc_url], blockExplorerUrls: [config.explorer_url]
          }] });
          await selected.request({ method: "wallet_switchEthereumChain", params: [{ chainId }] });
        }
      }
      // Switching networks can change the account permissions exposed by a wallet.
      accounts = await selected.request({ method: "eth_requestAccounts" });
      if (!accounts?.length) throw new Error("切换网络后未获取到账户，请在 MetaMask 中重新授权本站。");
      if ((await selected.request({ method: "eth_chainId" })).toLowerCase() !== chainId.toLowerCase()) {
        throw new Error(`请切换到 ${config.chain_name}（Chain ID ${config.chain_id_decimal}）。`);
      }
      const provider = new ethers.providers.Web3Provider(selected, "any");
      const address = ethers.utils.getAddress(accounts[0]);
      if (selected.on && !boundProviders.has(selected)) {
        const changed = () => { if (!connecting) window.dispatchEvent(new Event("sensor-wallet-changed")); };
        selected.on("accountsChanged", changed);
        selected.on("chainChanged", changed);
        boundProviders.add(selected);
      }
      return { provider, signer: provider.getSigner(address), address };
    } catch (error) {
      if (Number(error.code) === 4001) throw new Error("你取消了钱包授权或网络切换，可以再次点击连接。");
      if (Number(error.code) === -32002) throw new Error("MetaMask 有一个待处理请求，请打开钱包扩展完成授权。");
      throw error;
    } finally {
      connecting = false;
    }
  }
  return { connect };
})();
