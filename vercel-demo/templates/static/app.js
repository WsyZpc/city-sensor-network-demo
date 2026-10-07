"use strict";

function initApp() {
  const ui = Object.fromEntries(["toggle", "sample", "error", "status", "pm25", "noise", "total", "chart", "chart-unit", "chart-range", "chart-empty", "records", "updated", "seal", "sample-json", "batches", "diagnostic", "wallet-login", "wallet-logout", "access-status", "chain-status", "anchor-stage", "toast"].map(id => [id, document.getElementById(id)]));
  const diagnostic = msg => {
    if (ui.diagnostic) ui.diagnostic.textContent = msg;
  };
  let snapshot = null;
  let batchList = [];
  let chainConfig = null;
  let chainAbi = null;
  let chainReady = null;
  let ethersLoading = null;
  let accessState = null;
  let accessLastChecked = 0;
  let browserSampling = true;
  let lastAutoSealAt = Date.now();
  let lastRefreshAt = 0;
  let actionError = "";
  const totalStorageKey = "city-sensor-network:max-total";
  const batchesStorageKey = "city-sensor-network:batches";
  const anchorsStorageKey = "city-sensor-network:anchors";
  const batchFilesStorageKey = "city-sensor-network:batch-json";
  const localReadingsStorageKey = "city-sensor-network:browser-readings";
  let toastTimer;
  const storageRead = (key, fallback = "") => {
    try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
  };
  const storageWrite = (key, value) => {
    try { localStorage.setItem(key, value); return true; } catch (error) {
      console.warn("浏览器本机存储不可用：", error);
      return false;
    }
  };
  const showToast = (message, isError = false) => {
    if (!ui.toast) return;
    ui.toast.textContent = message;
    ui.toast.classList.toggle("error-toast", isError);
    ui.toast.classList.add("visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => ui.toast.classList.remove("visible"), 3600);
  };
  const parseObject = (raw, fallback) => {
    try {
      const value = JSON.parse(raw);
      return value && typeof value === "object" && !Array.isArray(value) ? value : fallback;
    } catch { return fallback; }
  };
  const savedAnchors = () => parseObject(storageRead(anchorsStorageKey, "{}"), {});
  let sessionTotal = Number.parseInt(storageRead(totalStorageKey, "0"), 10) || 0;
  const storedTotal = () => sessionTotal;
  const rememberTotal = total => {
    sessionTotal = Math.max(sessionTotal, Number(total) || 0);
    storageWrite(totalStorageKey, String(sessionTotal));
    return sessionTotal;
  };
  const countLocalSample = () => {
    sessionTotal += 1;
    storageWrite(totalStorageKey, String(sessionTotal));
    if (snapshot) snapshot.total = Math.max(Number(snapshot.total) || 0, sessionTotal);
    return sessionTotal;
  };
  const savedBatches = () => {
    try {
      const value = JSON.parse(storageRead(batchesStorageKey, "[]"));
      return Array.isArray(value) ? value : [];
    } catch { return []; }
  };
  const savedLocalReadings = () => {
    try {
      const value = JSON.parse(storageRead(localReadingsStorageKey, "[]"));
      return Array.isArray(value) ? value.filter(row => row && Number.isFinite(Date.parse(row.recorded_at))
        && typeof row.pm25_ug_m3 === "number" && Number.isFinite(row.pm25_ug_m3)
        && typeof row.noise_db === "number" && Number.isFinite(row.noise_db))
        .slice(-60) : [];
    } catch { return []; }
  };
  let localReadings = savedLocalReadings();
  sessionTotal = Math.max(sessionTotal, ...localReadings.map(row => Number(row.display_sequence) || 0));
  const mergeReadings = serverReadings => {
    const byReading = new Map();
    for (const row of [...serverReadings, ...localReadings]) {
      if (!row || !row.recorded_at) continue;
      const key = `${row.recorded_at}:${row.pm25_ug_m3}:${row.noise_db}`;
      byReading.set(key, { ...byReading.get(key), ...row });
    }
    return [...byReading.values()].sort((a, b) => Date.parse(a.recorded_at) - Date.parse(b.recorded_at)).slice(-60);
  };
  const applyBrowserSample = reading => {
    if (!reading || !Number.isFinite(Date.parse(reading.recorded_at))
        || typeof reading.pm25_ug_m3 !== "number" || typeof reading.noise_db !== "number") {
      throw new Error("采样接口返回的数据无效，请稍后重试。");
    }
    const displaySequence = countLocalSample();
    localReadings = mergeReadings([]).concat({ ...reading, display_sequence: displaySequence }).slice(-60);
    storageWrite(localReadingsStorageKey, JSON.stringify(localReadings));
    if (snapshot?.sampling_mode === "browser") {
      snapshot.readings = mergeReadings(snapshot.readings);
      snapshot.total = Math.max(Number(snapshot.total) || 0, displaySequence);
      actionError = "";
      render();
      ui.error.textContent = snapshot.access_warning || "";
      ui.error.hidden = !snapshot.access_warning;
    }
  };
  const savedBatchFiles = () => parseObject(storageRead(batchFilesStorageKey, "{}"), {});
  const rememberBatchFile = (hash, contents) => {
    try {
      const files = savedBatchFiles();
      files[hash] = contents;
      const keep = new Set(savedBatches().map(batch => batch.sha256_hex).filter(Boolean).slice(-30));
      const trimmed = Object.fromEntries(Object.entries(files).filter(([key]) => keep.has(key)).slice(-30));
      return storageWrite(batchFilesStorageKey, JSON.stringify(trimmed));
    } catch (error) {
      console.warn("本机 JSON 缓存空间不足：", error);
      return false;
    }
  };
  const rememberBatches = batches => {
    const byHash = new Map(savedBatches().filter(batch => batch?.sha256_hex).map(batch => [batch.sha256_hex, { ...batch, cached_only: true }]));
    for (const batch of batches) if (batch?.sha256_hex) byHash.set(batch.sha256_hex, { ...byHash.get(batch.sha256_hex), ...batch, cached_only: false });
    const result = [...byHash.values()].slice(-30);
    storageWrite(batchesStorageKey, JSON.stringify(result));
    return result;
  };
  const cacheOriginalBatch = async (batch, encoded) => {
    if (!batch?.sha256_hex || !encoded) return false;
    const bytes = Uint8Array.from(atob(encoded), character => character.charCodeAt(0));
    const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
      .map(value => value.toString(16).padStart(2, "0")).join("");
    if (digest !== batch.sha256_hex.toLowerCase().replace(/^0x/, "")) return false;
    const contents = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    JSON.parse(contents);
    const { batch_file_base64, ...metadata } = batch;
    rememberBatches([metadata]);
    return rememberBatchFile(batch.sha256_hex, contents);
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
  }).then(loaded => {
    if (!loaded) ethersLoading = null;
    return loaded;
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
    const cachedFile = savedBatchFiles()[batch.sha256_hex];
    if (batch.cached_only) {
      const cacheLabel = document.createElement("span");
      cacheLabel.className = "cache-status";
      cacheLabel.textContent = cachedFile ? "本机缓存 · JSON 可下载" : "本机缓存 · 仅指纹";
      cacheLabel.title = cachedFile
        ? "JSON 文件保存在当前浏览器，可随时下载。"
        : "本机保存了批次编号和哈希；原始 JSON 未缓存或已清理。";
      fileCell.append(cacheLabel);
    }
    if (cachedFile || accessState?.can_download) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "button file-download";
      button.textContent = cachedFile ? "下载 JSON" : batch.cached_only ? "尝试找回 JSON" : "下载并缓存 JSON";
      button.title = cachedFile ? "从本机缓存下载已校验的 JSON" : "从服务下载、校验哈希并保存到本机";
      button.addEventListener("click", () => downloadBatchJson(batch, cachedFile));
      fileCell.append(button);
    } else {
      const link = document.createElement("a");
      link.href = "/subscribe";
      link.className = "file-subscribe";
      link.textContent = "订阅后下载";
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

  async function downloadBatchJson(batch, cachedContents = "") {
    try {
      let contents = cachedContents;
      let cached = Boolean(contents);
      let bytes;
      if (!contents) {
        if (!accessState?.can_download) {
          window.location.href = "/subscribe";
          return;
        }
        const response = await fetch(`/api/hash/${encodeURIComponent(batch.sha256_hex)}/download`, {
          cache: "no-store",
          credentials: "same-origin",
          signal: AbortSignal.timeout(12000),
        });
        if (!response.ok) {
          let detail = "";
          try { detail = (await response.json()).detail || ""; } catch {}
          if (response.status === 404 && batch.cached_only) {
            throw new Error("此批次只缓存了指纹，原始 JSON 在在线临时存储中已不可用。哈希无法还原文件；请重新生成批次并保存新的 JSON。");
          }
          throw new Error(detail || `JSON 下载失败（${response.status}）。`);
        }
        bytes = await response.arrayBuffer();
      } else {
        bytes = new TextEncoder().encode(contents);
      }
      const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
        .map(value => value.toString(16).padStart(2, "0")).join("");
      if (digest.toLowerCase() !== batch.sha256_hex.toLowerCase().replace(/^0x/, "")) {
        if (cached) {
          const files = savedBatchFiles();
          delete files[batch.sha256_hex];
          storageWrite(batchFilesStorageKey, JSON.stringify(files));
        }
        throw new Error("文件指纹与批次记录不一致，已停止下载。");
      }
      if (!contents) contents = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      JSON.parse(contents);
      if (!cached) cached = rememberBatchFile(batch.sha256_hex, contents);
      const blob = new Blob([contents], { type: "application/json;charset=utf-8" });
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = batch.file_name || `sensor-batch-${batch.batch_seq}.json`;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
      showToast(cached ? "JSON 已下载，并保存在此浏览器中。" : "JSON 已下载；浏览器存储空间不足，未能保留本机副本。", !cached);
    } catch (error) {
      showToast(error.message || "JSON 下载失败，请稍后重试。", true);
    }
  }

  async function downloadPreviewJson() {
    let readings = snapshot?.readings || [];
    if (!readings.length) {
      try { readings = (await request("/api/readings?limit=10")).readings || []; }
      catch (error) { showToast(`暂时无法生成测试文件：${error.message}`, true); return; }
    }
    if (!readings.length) {
      showToast("暂无采样数据，请稍等片刻再试。", true);
      return;
    }
    const rows = readings.slice(-10).map(({ sequence, recorded_at, pm25_ug_m3, noise_db }) => ({
      sequence, recorded_at, pm25_ug_m3, noise_db,
    }));
    const sample = {
      batch_seq: 0,
      node_id: "wuhan-demo-001",
      first_sequence: rows[0].sequence,
      last_sequence: rows.at(-1).sequence,
      reading_count: rows.length,
      sealed_at: new Date().toISOString(),
      source: "simulated_preview",
      readings: rows,
    };
    const blob = new Blob([JSON.stringify(sample, null, 2)], { type: "application/json;charset=utf-8" });
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = "sensor-preview-test.json";
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    showToast("测试 JSON 已下载，可用于验证页面试跑；它没有对应的链上存证。", false);
  }
async function initChain() {
  if (chainConfig && chainAbi) return { config: chainConfig, abi: chainAbi };
  if (chainReady) return chainReady;
  chainReady = (async () => {
    const [abiRes, cfgRes] = await Promise.all([
      fetch("/static/abi.json", { cache: "no-store", signal: AbortSignal.timeout(8000) }),
      fetch("/static/chain-config.json", { cache: "no-store", signal: AbortSignal.timeout(8000) }),
    ]);
    if (!abiRes.ok || !cfgRes.ok) throw new Error(`配置接口返回 ${!cfgRes.ok ? cfgRes.status : abiRes.status}`);
    const [abi, config] = await Promise.all([abiRes.json(), cfgRes.json()]);
    if (!Array.isArray(abi) || Number(config.chain_id_decimal) !== 677
        || !/^0x[0-9a-fA-F]{40}$/.test(config.contract_address || "")) {
      throw new Error("主网配置内容无效");
    }
    chainAbi = abi;
    chainConfig = config;
    if (ui["chain-status"]) ui["chain-status"].textContent = `BOT Chain 主网配置已读取 · Chain ID ${config.chain_id_decimal}`;
    return { config, abi };
  })().catch(error => {
    chainReady = null;
    if (ui["chain-status"]) ui["chain-status"].textContent = "主网配置暂不可用，点击钱包按钮时会重试";
    diagnostic(`BOT Chain 配置加载失败：${error.message}`);
    throw error;
  });
  return chainReady;
}

async function anchorBatch(batch) {
  if (typeof window.ethereum === "undefined") {
    alert("当前浏览器未检测到 MetaMask，请在安装了 MetaMask 的 Chrome 或 Edge 中打开在线 Demo。");
    return;
  }
  try {
    if (!savedBatchFiles()[batch.sha256_hex]) {
      await downloadBatchJson(batch);
      if (!savedBatchFiles()[batch.sha256_hex]) {
        throw new Error("上链前请先下载并缓存该批次的原始 JSON；仅有指纹无法供评审验证。");
      }
    }
    await initChain();
    if (!(await loadEthers())) throw new Error("区块链库加载失败，请检查网络后重试。");
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
    storageWrite(anchorsStorageKey, JSON.stringify(anchors));
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
  if (!window.ethereum) throw new Error("当前浏览器未检测到 MetaMask。请在安装了 MetaMask 的 Chrome 或 Edge 中打开在线 Demo。");
  await initChain();
  if (!(await loadEthers())) throw new Error("区块链库加载失败，请检查网络后重试。");
  if (!window.SensorWallet) throw new Error("钱包连接脚本未加载，请刷新页面后重试。");
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
  const originalText = button.textContent;
  button.textContent = "等待钱包确认…";
  actionError = "";
  try {
    const address = await signInWithWallet();
    diagnostic(`钱包已验证：${address.slice(0, 6)}…${address.slice(-4)}`);
    accessState = { authenticated: true, address, owner_access: false, can_download: false };
    ui["access-status"].textContent = "钱包已验证 · 正在查询订阅状态";
    button.textContent = "钱包已连接";
    button.hidden = true;
    ui["wallet-logout"].hidden = false;
    accessLastChecked = 0;
    // Authentication is complete. Let the slower chain permission lookup
    // finish in the background so the connect button responds immediately.
    void refreshAccess(true).then(() => refresh());
  } catch (error) {
    actionError = `钱包登录失败：${error.message}`;
    ui.error.textContent = actionError;
    ui.error.hidden = false;
    button.textContent = originalText;
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
    accessLastChecked = Date.now();
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
    for (const value of [`#${String(reading.display_sequence ?? reading.sequence).padStart(4, "0")}`, time(reading.recorded_at), reading.pm25_ug_m3.toFixed(1), reading.noise_db.toFixed(1)]) {
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
      batchData = await request(accessState?.can_download
        ? "/api/batches?limit=10&include_files=true"
        : "/api/batches?limit=10");
    } catch (error) {
      actionError = `批次列表暂时无法同步，已保留浏览器中的历史指纹：${error.message}`;
    }
    if (version !== refreshVersion) return;
    diagnostic(`请求成功: total=${data.total}, batches=${batchData.batches.length}`);
    snapshot = data;
    if (data.sampling_mode === "browser") {
      snapshot.sampling = browserSampling;
      snapshot.readings = mergeReadings(data.readings);
      snapshot.total = Math.max(Number(data.total) || 0, storedTotal());
    }
    lastRefreshAt = Date.now();
    const anchors = savedAnchors();
    const currentBatches = rememberBatches(batchData.batches);
    for (const batch of batchData.batches) {
      const encoded = batchData.batch_files?.[batch.sha256_hex];
      if (encoded && !savedBatchFiles()[batch.sha256_hex]) {
        try { await cacheOriginalBatch(batch, encoded); }
        catch (error) { console.warn("批次 JSON 缓存失败：", error); }
      }
    }
    batchList = currentBatches.map(batch => anchors[batch.sha256_hex] ? { ...batch, ...anchors[batch.sha256_hex] } : batch);
    render();
    renderBatches();
    ui.error.hidden = !(data.sampling_error || actionError || data.access_warning);
    ui.error.textContent = actionError || data.access_warning || (data.sampling_error ? "自动采样失败，页面显示的是已有记录。请稍后重试。" : "");
    ui.toggle.disabled = actionBusy;
    ui.toggle.textContent = snapshot.sampling_mode === "browser"
      ? (browserSampling ? "暂停采样" : "继续采样")
      : (snapshot.sampling ? "暂停采样" : "继续采样");
    ui.sample.disabled = actionBusy;
    ui.sample.innerHTML = "<span>＋</span> 采样一次";
    ui.seal.disabled = actionBusy;
    ui.seal.textContent = "立即打包批次";
    void refreshAccess();
  } catch (error) {
    if (version !== refreshVersion) return;
    diagnostic(`请求失败: ${error.message || error}`);
    ui.error.textContent = "云端服务暂时无法连接，请稍后刷新。已有读数暂时保留。";
    ui.error.hidden = false;
    ui.status.textContent = "连接中断";
    ui.toggle.disabled = false;
    ui.toggle.textContent = "重试连接";
    ui.sample.disabled = false;
    ui.sample.textContent = "重新加载数据";
    ui.seal.disabled = false;
    ui.seal.textContent = "重新加载批次";
    ui["sample-json"].disabled = false;
    ui.updated.textContent = "连接中断 · 页面读数可能已过时";
  }
}

async function poll() {
  const started = Date.now();
  try {
    if (!snapshot || Date.now() - lastRefreshAt >= 10000) await refresh();
    if (snapshot?.sampling_mode === "browser" && browserSampling && !document.hidden && !actionBusy) {
      const reading = await request("/api/sample", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      applyBrowserSample(reading);
      if (Date.now() - lastAutoSealAt >= 60000) {
        lastAutoSealAt = Date.now();
        try {
          const batch = await request("/api/batches/seal", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
          if (batch.batch_file_base64) await cacheOriginalBatch(batch, batch.batch_file_base64);
        }
        catch (error) { actionError = `批次自动打包未完成：${error.message}`; }
        await refresh();
      }
    }
  } catch (error) {
    actionError = `自动采样未完成：${error.message}`;
    ui.error.textContent = actionError;
    ui.error.hidden = false;
    diagnostic(actionError);
  } finally {
    pollTimer = setTimeout(poll, Math.max(0, 1000 - (Date.now() - started)));
  }
}

async function action(path, body) {
  if (actionBusy) return;
  actionError = "";
  actionBusy = true;
  ui.toggle.disabled = true;
  ui.sample.disabled = true;
  ui.seal.disabled = true;
  try {
    const result = await request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (path === "/api/sample") applyBrowserSample(result);
    if (path === "/api/batches/seal" && result.batch_file_base64) {
      const cached = await cacheOriginalBatch(result, result.batch_file_base64);
      if (!cached) showToast("批次已生成，但本机 JSON 缓存失败。请立即点击下载并保存文件。", true);
    }
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
  if (!snapshot) {
    void refresh();
  } else if (snapshot.sampling_mode === "browser") {
    browserSampling = !browserSampling;
    snapshot.sampling = browserSampling;
    actionError = "";
    render();
  } else if (snapshot) {
    action("/api/simulator", { running: !snapshot.sampling });
  }
});
ui["sample-json"].addEventListener("click", downloadPreviewJson);
window.addEventListener("sensor-wallet-changed", () => ui["wallet-logout"].click());
ui.sample.addEventListener("click", () => action("/api/sample", {}));
ui.seal.addEventListener("click", () => action("/api/batches/seal", {}));
ui["wallet-login"]?.addEventListener("click", walletLogin);
ui["wallet-logout"]?.addEventListener("click", async () => {
  try {
    await request("/api/auth/logout", { method: "POST" });
    if (ui["wallet-login"]) {
      ui["wallet-login"].hidden = false;
      ui["wallet-login"].textContent = "连接 MetaMask";
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
if (window.ResizeObserver) new ResizeObserver(drawChart).observe(ui.chart);
else window.addEventListener("resize", drawChart);
poll();
void initChain().catch(error => console.warn("BOT Chain 配置加载失败:", error));
refreshAccess();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initApp);
} else {
  initApp();
}
