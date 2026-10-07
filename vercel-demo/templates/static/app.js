"use strict";

function initApp() {
  const ui = Object.fromEntries(["toggle", "sample", "error", "status", "pm25", "noise", "total", "chart", "chart-unit", "chart-range", "chart-empty", "records", "updated", "seal", "batches", "diagnostic", "wallet-login", "wallet-logout", "access-status", "anchor-stage"].map(id => [id, document.getElementById(id)]));
  const diagnostic = msg => {
    if (ui.diagnostic) ui.diagnostic.textContent = msg;
  };
  let snapshot = null;
  let batchList = [];
  let chainConfig = null;
  let chainAbi = null;
  let ethersLoading = null;
  let accessState = null;
  let accessLastChecked = 0;
  let browserSampling = true;
  let lastAutoSampleAt = 0;
  let lastAutoSealAt = Date.now();
  let actionError = "";
  const totalStorageKey = "city-sensor-network:max-total";
  const batchesStorageKey = "city-sensor-network:batches";
  const anchorsStorageKey = "city-sensor-network:anchors";
  const savedAnchors = () => {
    try { return JSON.parse(localStorage.getItem(anchorsStorageKey) || "{}"); } catch { return {}; }
  };
  const storedTotal = () => Number.parseInt(localStorage.getItem(totalStorageKey) || "0", 10) || 0;
  const rememberTotal = total => {
    const remembered = Math.max(storedTotal(), Number(total) || 0);
    localStorage.setItem(totalStorageKey, String(remembered));
    return remembered;
  };
  const countLocalSample = () => {
    const next = storedTotal() + 1;
    localStorage.setItem(totalStorageKey, String(next));
    if (snapshot) snapshot.total = Math.max(Number(snapshot.total) || 0, next);
  };
  const savedBatches = () => {
    try { return JSON.parse(localStorage.getItem(batchesStorageKey) || "[]"); } catch { return []; }
  };
  const rememberBatches = batches => {
    const byHash = new Map(savedBatches().filter(batch => batch?.sha256_hex).map(batch => [batch.sha256_hex, { ...batch, cached_only: true }]));
    for (const batch of batches) if (batch?.sha256_hex) byHash.set(batch.sha256_hex, { ...byHash.get(batch.sha256_hex), ...batch, cached_only: false });
    const result = [...byHash.values()].slice(-30);
    localStorage.setItem(batchesStorageKey, JSON.stringify(result));
    return result;
  };

async function loadEthers() {
  if (typeof window.ethers !== "undefined") return true;
  if (ethersLoading) return ethersLoading;
  ethersLoading = new Promise((resolve) => {
    const script = document.createElement("script");
    script.src = "/static/ethers.umd.min.js";
    script.onload = () => resolve(true);
    script.onerror = () => resolve(false);
    document.head.appendChild(script);
  });
  return ethersLoading;
}
let metric = "pm25_ug_m3";
let actionBusy = false;
let pollTimer;
let refreshVersion = 0;
const time = value => new Date(value).toLocaleTimeString("zh-CN", { hour12: false });

async function request(path, options = {}) {
  const response = await fetch(path, { cache: "no-store", signal: AbortSignal.timeout(8000), ...options });
  if (!response.ok) {
    let detail = "";
    try { detail = (await response.json()).detail || ""; } catch {}
    throw new Error(detail || `请求失败（${response.status}），请稍后重试。`);
  }
  return response.json();
}

function drawChart() {
  if (!snapshot?.readings.length) return;
  const readings = snapshot.readings;
  const width = Math.max(240, ui.chart.clientWidth);
  const height = ui.chart.clientHeight;
  const left = 38, right = 12, top = 15, bottom = 29;
  const values = readings.map(reading => reading[metric]);
  const minValue = Math.min(...values), maxValue = Math.max(...values);
  const padding = Math.max(2, (maxValue - minValue) * .25);
  const low = Math.max(0, Math.floor(minValue - padding));
  const high = Math.ceil(maxValue + padding);
  const timestamps = readings.map(reading => Date.parse(reading.recorded_at));
  const elapsed = timestamps.at(-1) - timestamps[0];
  const x = index => readings.length === 1 ? (left + width - right) / 2 : left + (width - left - right) * (elapsed > 0 ? (timestamps[index] - timestamps[0]) / elapsed : index / (readings.length - 1));
  const y = value => height - bottom - (value - low) / (high - low) * (height - top - bottom);
  const color = metric === "pm25_ug_m3" ? "#439985" : "#638fae";
  const points = values.map((value, index) => `${x(index)},${y(value)}`).join(" ");
  let svg = `<defs><linearGradient id="chart-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${color}" stop-opacity=".17"/><stop offset="100%" stop-color="${color}" stop-opacity=".015"/></linearGradient></defs>`;
  for (let index = 0; index <= 4; index++) {
    const value = low + (high - low) * index / 4;
    const position = y(value);
    svg += `<line x1="${left}" x2="${width - right}" y1="${position}" y2="${position}" stroke="#edf1f1" stroke-dasharray="3 4"/><text x="0" y="${position + 3}" fill="#a0afb2" font-size="9">${value.toFixed(1)}</text>`;
  }
  if (readings.length > 1) svg += `<polygon points="${x(0)},${height - bottom} ${points} ${x(readings.length - 1)},${height - bottom}" fill="url(#chart-fill)"/>`;
  svg += `<polyline points="${points}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;
  const last = readings.length - 1;
  svg += `<circle cx="${x(last)}" cy="${y(values[last])}" r="4" fill="${color}" stroke="white" stroke-width="2"/>`;
  const count = Math.min(width < 480 ? 3 : 5, readings.length);
  const indices = [...new Set(Array.from({ length: count }, (_, index) => count === 1 ? 0 : Math.round(last * index / (count - 1))))];
  for (const index of indices) {
    const anchor = count === 1 ? "middle" : index === 0 ? "start" : index === last ? "end" : "middle";
    svg += `<text x="${x(index)}" y="${height - 5}" text-anchor="${anchor}" fill="#a0afb2" font-size="9">${time(readings[index].recorded_at)}</text>`;
  }
  ui.chart.setAttribute("viewBox", `0 0 ${width} ${height}`);
  ui.chart.setAttribute("aria-label", `${metric === "pm25_ug_m3" ? "PM2.5" : "噪音"}模拟趋势，共 ${readings.length} 条记录，最新值 ${values.at(-1)}`);
  ui.chart.innerHTML = svg;
  ui["chart-unit"].textContent = metric === "pm25_ug_m3" ? "浓度 · μg/m³" : "声级 · dB";
  ui["chart-range"].textContent = `${time(readings[0].recorded_at)} — ${time(readings.at(-1).recorded_at)}`;
  ui["chart-empty"].hidden = true;
}

function renderBatches() {
  ui.batches.replaceChildren();
  if (!batchList.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 6;
  cell.textContent = '还没有批次。批次每分钟自动打包一次，也可以点击右上角“立即打包批次”。';
    row.append(cell);
    ui.batches.append(row);
    return;
  }
  const anchors = savedAnchors();
  for (const originalBatch of batchList) {
    const batch = anchors[originalBatch.sha256_hex] ? { ...originalBatch, ...anchors[originalBatch.sha256_hex] } : originalBatch;
    const row = document.createElement("tr");
    for (const value of [`#${String(batch.batch_seq).padStart(6, "0")}`, time(batch.sealed_at), batch.reading_count]) {
      const cell = document.createElement("td");
      cell.textContent = value;
      row.append(cell);
    }
    const hashCell = document.createElement("td");
    const hash = document.createElement("span");
    hash.className = "hash";
    hash.textContent = `0x${batch.sha256_hex.slice(0, 16)}…`;
    hash.title = `0x${batch.sha256_hex}`;
    hashCell.append(hash);
    row.append(hashCell);
    const chainCell = document.createElement("td");
    if (batch.anchor_verified) {
      const link = document.createElement("a");
      link.href = `${chainConfig?.explorer_url || ""}/tx/0x${batch.anchor_tx}`;
      link.target = "_blank";
      link.rel = "noopener";
      link.textContent = "已上链";
      link.className = "verify-ok";
      chainCell.append(link);
    } else {
      const btn = document.createElement("button");
      btn.className = "button primary";
      btn.style.padding = "5px 10px";
      btn.style.fontSize = "10px";
      btn.textContent = "上链";
      btn.addEventListener("click", () => anchorBatch(batch));
      chainCell.append(btn);
    }
    row.append(chainCell);
    const fileCell = document.createElement("td");
    if (batch.cached_only) {
      fileCell.textContent = "已缓存指纹";
      fileCell.title = "该批次来自之前的临时实例，文件需在生成它的页面下载。";
    } else {
      const link = document.createElement("a");
      link.href = accessState?.can_download ? `/api/batches/${batch.batch_seq}/download` : "/subscribe";
      link.textContent = accessState?.can_download ? "下载" : "先订阅";
      if (accessState?.can_download) link.setAttribute("download", batch.file_name);
      fileCell.append(link);
    }
    row.append(fileCell);
    ui.batches.append(row);
  }
  const verifiedBatches = batchList.filter(batch => batch.anchor_verified).length;
  if (ui["anchor-stage"]) {
    ui["anchor-stage"].textContent = verifiedBatches
      ? `${verifiedBatches} 个批次的交易已通过后端核验`
      : "已生成批次；完成 MetaMask 交易后才会显示存证通过";
  }
}

async function initChain() {
  try {
    const [abiRes, cfgRes] = await Promise.all([
      fetch("/static/abi.json", { cache: "no-store" }),
      fetch("/static/chain-config.json", { cache: "no-store" }),
    ]);
    chainAbi = await abiRes.json();
    chainConfig = await cfgRes.json();
  } catch (error) {
    console.warn("链配置加载失败:", error);
  }
}

async function anchorBatch(batch) {
  if (!chainConfig || !chainAbi) {
    alert("链配置未加载，请刷新页面重试。");
    return;
  }
  if (typeof window.ethereum === "undefined") {
    alert("请安装 MetaMask 浏览器钱包插件。");
    return;
  }
  const ethersLoaded = await loadEthers();
  if (!ethersLoaded) {
    alert("区块链库加载失败，请检查网络连接后重试。");
    return;
  }
  try {
    const { provider: web3Provider, signer } = await SensorWallet.connect(chainConfig);
    const owner = await new ethers.Contract(chainConfig.contract_address, chainAbi, web3Provider).owner();
    const submitter = await signer.getAddress();
    if (owner.toLowerCase() !== submitter.toLowerCase()) {
      throw new Error("当前钱包不是数据存证合约 owner；请切换部署合约的钱包账户。");
    }
    const contract = new ethers.Contract(chainConfig.contract_address, chainAbi, signer);
    const dataHash = "0x" + batch.sha256_hex;
    ui.error.hidden = true;
    const tx = await contract.recordData(chainConfig.stream_id, dataHash, batch.file_name);
    ui.error.hidden = false;
    ui.error.textContent = `交易已提交: ${tx.hash}，等待区块确认…`;
    await tx.wait();
    await request(`/api/batches/${batch.batch_seq}/anchor`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tx_hash: tx.hash, sha256_hex: batch.sha256_hex, file_name: batch.file_name }),
    });
    const anchors = savedAnchors();
    anchors[batch.sha256_hex] = { anchor_tx: tx.hash.replace(/^0x/, ""), anchor_verified: true, file_name: batch.file_name };
    localStorage.setItem(anchorsStorageKey, JSON.stringify(anchors));
    batch.anchor_tx = tx.hash.replace(/^0x/, "");
    batch.anchor_verified = true;
    ui.error.hidden = true;
    renderBatches();
    await refresh();
  } catch (error) {
    ui.error.hidden = false;
    ui.error.textContent = `上链失败: ${error.message || error}`;
  }
}

async function signInWithWallet() {
  if (!chainConfig || !(await loadEthers())) throw new Error("区块链配置尚未就绪，请稍后重试。");
  const { signer, address } = await SensorWallet.connect(chainConfig);
  const challenge = await request(`/api/auth/challenge?address=${encodeURIComponent(address)}`);
  const signature = await signer.signMessage(challenge.message);
  await request("/api/auth/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address, signature, message: challenge.message }),
  });
  return address;
}

async function walletLogin() {
  const button = ui["wallet-login"];
  if (!button) return;
  button.disabled = true;
  actionError = "";
  try {
    const address = await signInWithWallet();
    diagnostic(`钱包已验证：${address.slice(0, 6)}…${address.slice(-4)}`);
    await initChain();
    accessLastChecked = 0;
    await refreshAccess(true);
    await refresh();
  } catch (error) {
    actionError = `钱包登录失败：${error.message}`;
    ui.error.textContent = actionError;
    ui.error.hidden = false;
  } finally {
    button.disabled = false;
  }
}

async function refreshAccess(force = false) {
  const pill = ui["access-status"];
  const login = ui["wallet-login"];
  const logout = ui["wallet-logout"];
  if (!pill || !login || !logout) return;
  if (!force && Date.now() - accessLastChecked < 15000) return;
  try {
    const access = await request("/api/access");
    accessState = access;
    accessLastChecked = Date.now();
    if (!access.authenticated) {
      pill.textContent = "公开预览 · 需订阅以下载完整数据";
      login.hidden = false;
      logout.hidden = true;
    } else if (access.can_download) {
      pill.textContent = access.owner_access ? "数据提供方账户" : "有效订阅 · 可下载全部数据";
      login.textContent = "已连接";
      logout.hidden = false;
    } else {
      pill.textContent = "钱包已验证 · 请订阅以下载完整数据";
      login.textContent = "钱包已连接";
      logout.hidden = false;
    }
  } catch (error) {
    pill.textContent = "链上订阅状态暂不可用";
    ui.error.textContent = error.message;
    ui.error.hidden = false;
  }
}

function render() {
  const latest = snapshot.readings.at(-1);
  ui.pm25.textContent = latest ? latest.pm25_ug_m3.toFixed(1) : "—";
  ui.noise.textContent = latest ? latest.noise_db.toFixed(1) : "—";
  ui.total.textContent = rememberTotal(snapshot.total).toLocaleString("zh-CN");
  ui.status.textContent = snapshot.sampling_error ? "采样异常" : snapshot.sampling ? "● 自动采样中" : "Ⅱ 自动采样已暂停";
  ui.toggle.textContent = snapshot.sampling ? "暂停采样" : "继续采样";
  ui.records.replaceChildren();
  for (const reading of snapshot.readings.slice(-8).reverse()) {
    const row = document.createElement("tr");
    for (const value of [`#${String(reading.sequence).padStart(4, "0")}`, time(reading.recorded_at), reading.pm25_ug_m3.toFixed(1), reading.noise_db.toFixed(1)]) {
      const cell = document.createElement("td");
      cell.textContent = value;
      row.append(cell);
    }
    const sourceCell = document.createElement("td");
    const source = document.createElement("span");
    source.textContent = "模拟";
    sourceCell.append(source);
    row.append(sourceCell);
    ui.records.append(row);
  }
  ui.updated.textContent = `页面同步于 ${time(Date.now())} · 最新采样 ${latest ? time(latest.recorded_at) : "—"}`;
  drawChart();
}

async function refresh() {
  const version = ++refreshVersion;
  try {
    diagnostic(`第 ${version} 次刷新: 正在请求 /api/readings ...`);
    const readingsUrl = accessState?.can_download ? "/api/readings?limit=60" : "/api/readings?limit=3";
    const data = await request(readingsUrl);
    let batchData = { batches: [] };
    try {
      batchData = await request("/api/batches?limit=10");
    } catch (error) {
      actionError = `批次列表暂时无法同步，已保留浏览器中的历史指纹：${error.message}`;
    }
    if (version !== refreshVersion) return;
    diagnostic(`请求成功: total=${data.total}, batches=${batchData.batches.length}`);
    snapshot = data;
    if (data.sampling_mode === "browser") snapshot.sampling = browserSampling;
    const anchors = savedAnchors();
    const currentBatches = rememberBatches(batchData.batches);
    batchList = currentBatches.map(batch => anchors[batch.sha256_hex] ? { ...batch, ...anchors[batch.sha256_hex] } : batch);
    render();
    renderBatches();
    ui.error.hidden = !(data.sampling_error || actionError);
    ui.error.textContent = actionError || (data.sampling_error ? "自动采样失败，页面显示的是已有记录。请稍后重试。" : "");
    ui.toggle.disabled = actionBusy;
    ui.sample.disabled = actionBusy;
    ui.seal.disabled = actionBusy;
    await refreshAccess();
  } catch (error) {
    if (version !== refreshVersion) return;
    diagnostic(`请求失败: ${error.message || error}`);
    ui.error.textContent = "云端服务暂时无法连接，请稍后刷新。已有读数暂时保留。";
    ui.error.hidden = false;
    ui.status.textContent = "连接中断";
    ui.toggle.disabled = true;
    ui.sample.disabled = true;
    ui.seal.disabled = true;
    ui.updated.textContent = "连接中断 · 页面读数可能已过时";
  }
}

async function poll() {
  if (snapshot?.sampling_mode === "browser" && browserSampling && !actionBusy
      && Date.now() - lastAutoSampleAt >= Math.max(1000, snapshot.interval_seconds * 1000)) {
    actionBusy = true;
    lastAutoSampleAt = Date.now();
    try {
      await request("/api/sample", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      countLocalSample();
      if (Date.now() - lastAutoSealAt >= 60000) {
        await request("/api/batches/seal", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
        lastAutoSealAt = Date.now();
      }
    } catch (error) {
      actionError = `自动采样未完成：${error.message}`;
    } finally {
      actionBusy = false;
    }
  }
  await refresh();
  pollTimer = setTimeout(poll, 1000);
}

async function action(path, body) {
  if (actionBusy) return;
  actionError = "";
  actionBusy = true;
  ui.toggle.disabled = true;
  ui.sample.disabled = true;
  ui.seal.disabled = true;
  try {
    await request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (path === "/api/sample") countLocalSample();
    actionBusy = false;
    await refresh();
  } catch (error) {
    actionError = `操作未完成：${error.message}`;
    ui.error.textContent = actionError;
    ui.error.hidden = false;
    ui.toggle.disabled = false;
    ui.sample.disabled = false;
    ui.seal.disabled = false;
  } finally {
    actionBusy = false;
  }
}

ui.toggle.addEventListener("click", () => {
  if (snapshot?.sampling_mode === "browser") {
    browserSampling = !browserSampling;
    snapshot.sampling = browserSampling;
    actionError = "";
    lastAutoSampleAt = 0;
    render();
  } else if (snapshot) {
    action("/api/simulator", { running: !snapshot.sampling });
  }
});
window.addEventListener("sensor-wallet-changed", () => ui["wallet-logout"].click());
ui.sample.addEventListener("click", () => action("/api/sample", {}));
ui.seal.addEventListener("click", () => action("/api/batches/seal", {}));
ui["wallet-login"]?.addEventListener("click", walletLogin);
ui["wallet-logout"]?.addEventListener("click", async () => {
  try {
    await request("/api/auth/logout", { method: "POST" });
    if (ui["wallet-login"]) {
      ui["wallet-login"].hidden = false;
      ui["wallet-login"].textContent = "连接钱包以下载";
      ui["wallet-logout"].hidden = true;
    }
    accessState = null;
    accessLastChecked = 0;
    if (ui["access-status"]) ui["access-status"].textContent = "公开预览 · 需订阅以下载完整数据";
    await refresh();
  } catch (error) {
    ui.error.textContent = error.message;
    ui.error.hidden = false;
  }
});
document.querySelectorAll("[data-metric]").forEach(button => button.addEventListener("click", () => {
  metric = button.dataset.metric;
  document.querySelectorAll("[data-metric]").forEach(tab => {
    tab.classList.toggle("selected", tab === button);
    tab.setAttribute("aria-pressed", String(tab === button));
  });
  drawChart();
}));
new ResizeObserver(drawChart).observe(ui.chart);
poll();
initChain();
refreshAccess();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initApp);
} else {
  initApp();
}
