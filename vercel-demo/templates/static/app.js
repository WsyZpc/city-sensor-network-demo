"use strict";

function initApp() {
  const ui = Object.fromEntries(["toggle", "sample", "error", "status", "pm25", "noise", "total", "chart", "chart-unit", "chart-range", "chart-empty", "records", "updated", "seal", "sample-json", "batches", "diagnostic", "wallet-login", "wallet-logout", "access-status", "chain-status", "anchor-stage", "anchor-feedback", "toast"].map(id => [id, document.getElementById(id)]));
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
  const lastSealedSequenceKey = "city-sensor-network:last-local-sealed-sequence";
  const localBatchNumberKey = "city-sensor-network:last-local-batch-number";
  const anchorFeedbackStorageKey = "city-sensor-network:last-anchor-feedback";
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
  const canProduce = () => Boolean(accessState?.authenticated && accessState?.owner_access);
  const canDownload = () => Boolean(accessState?.authenticated && accessState?.can_download);
  const updateProtectedControls = () => {
    ui.seal.disabled = actionBusy || !canProduce();
    ui.seal.textContent = canProduce()
      ? snapshot?.sampling_mode === "browser" ? "生成可上链批次" : "立即打包批次"
      : accessState?.authenticated ? "仅数据方可打包" : "连接数据方钱包后打包";
    ui["sample-json"].disabled = !canDownload();
    ui["sample-json"].title = canDownload() ? "下载测试 JSON" : "连接数据方或有效订阅钱包后可下载";
    if (batchList.length) renderBatches();
  };
  const transactionHash = hash => hash?.startsWith("0x") ? hash : `0x${hash}`;
  const setAnchorFeedback = (message, { stage = "idle", txHash = "", blockNumber = 0, sha256Hex = "" } = {}) => {
    if (!ui["anchor-feedback"]) return;
    const container = ui["anchor-feedback"];
    container.replaceChildren();
    container.className = `anchor-feedback ${stage}`;
    const title = document.createElement("strong");
    title.textContent = stage === "confirmed" ? "✓ BOT Chain 主网存证成功" : "链上存证演示";
    const detail = document.createElement("span");
    detail.textContent = message;
    container.append(title, detail);
    if (txHash) {
      const link = document.createElement("a");
      link.href = `${chainConfig?.explorer_url || "https://scan.botchain.ai"}/tx/${transactionHash(txHash)}`;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = `查看主网交易 ${transactionHash(txHash).slice(0, 10)}…${transactionHash(txHash).slice(-6)}`;
      container.append(link);
    }
    if (stage === "confirmed") storageWrite(anchorFeedbackStorageKey, JSON.stringify({ message, stage, txHash, blockNumber, sha256Hex }));
  };
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
  const canonicalJson = value => JSON.stringify(value, (_key, item) => {
    if (!item || Array.isArray(item) || typeof item !== "object") return item;
    return Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]]));
  });
  const sealBrowserBatch = async (automatic = false) => {
    if (!canProduce()) throw new Error("请先用数据提供方钱包签名登录，再生成可上链批次。");
    const lastSealed = Number(storageRead(lastSealedSequenceKey, "0")) || 0;
    const readings = localReadings.filter(row => Number(row.display_sequence) > lastSealed);
    if (!readings.length) {
      if (!automatic) showToast("还没有新的本机采样记录。请先等一次采样，再生成批次。", true);
      return null;
    }
    const batchSeq = Math.max(Date.now(), (Number(storageRead(localBatchNumberKey, "0")) || 0) + 1);
    const payload = {
      batch_seq: batchSeq,
      node_id: snapshot?.node_id || "wuhan-demo-001",
      first_sequence: readings[0].display_sequence,
      last_sequence: readings.at(-1).display_sequence,
      reading_count: readings.length,
      sealed_at: new Date().toISOString(),
      source: "simulated-browser",
      readings: readings.map(row => ({
        sequence: row.display_sequence,
        recorded_at: row.recorded_at,
        pm25_ug_m3: row.pm25_ug_m3,
        noise_db: row.noise_db,
      })),
    };
    const contents = canonicalJson(payload);
    const bytes = new TextEncoder().encode(contents);
    const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
      .map(value => value.toString(16).padStart(2, "0")).join("");
    const batch = {
      batch_seq: batchSeq,
      node_id: payload.node_id,
      first_sequence: payload.first_sequence,
      last_sequence: payload.last_sequence,
      reading_count: readings.length,
      sealed_at: payload.sealed_at,
      file_name: `browser-batch-${batchSeq}.json`,
      sha256_hex: hash,
      browser_generated: true,
      anchor_verified: false,
    };
    rememberBatches([batch]);
    if (!savedBatches().some(item => item.sha256_hex === hash) || !rememberBatchFile(hash, contents)) {
      throw new Error("浏览器空间不足，未能保存批次原文件；请清理空间后重试。");
    }
    storageWrite(localBatchNumberKey, String(batchSeq));
    storageWrite(lastSealedSequenceKey, String(payload.last_sequence));
    batchList = savedBatches();
    renderBatches();
    if (!automatic) {
      setAnchorFeedback(`批次已保存 ${readings.length} 条采样，SHA-256：0x${hash.slice(0, 16)}…；现在可下载 JSON 并点击“上链”。`, { stage: "ready", sha256Hex: hash });
      showToast("可上链批次已生成，原始 JSON 已保存在此浏览器。", false);
    }
    return batch;
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
    cell.textContent = "还没有批次。数据提供方连接钱包后可生成可上链批次。";
    row.append(cell);
    ui.batches.append(row);
    return;
  }
  const anchors = savedAnchors();
  for (const originalBatch of [...batchList].sort((a, b) =>
    Number(Boolean(b.browser_generated)) - Number(Boolean(a.browser_generated))
      || Date.parse(b.sealed_at) - Date.parse(a.sealed_at))) {
    const batch = anchors[originalBatch.sha256_hex] ? { ...originalBatch, ...anchors[originalBatch.sha256_hex] } : originalBatch;
    const cachedFile = savedBatchFiles()[batch.sha256_hex];
    const row = document.createElement("tr");
    for (const value of [batch.browser_generated ? `本机 #${String(batch.batch_seq).slice(-6)}` : `#${String(batch.batch_seq).padStart(6, "0")}`, time(batch.sealed_at), batch.reading_count]) {
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
      link.href = `${chainConfig?.explorer_url || "https://scan.botchain.ai"}/tx/${transactionHash(batch.anchor_tx)}`;
      link.target = "_blank";
      link.rel = "noopener";
      link.textContent = "✓ 已上链 · 查看交易 ↗";
      link.className = "verify-ok";
      chainCell.append(link);
    } else if (batch.cached_only && !cachedFile) {
      const missing = document.createElement("span");
      missing.className = "cache-status";
      missing.textContent = "原文件缺失 · 暂不可上链";
      missing.title = "仅有 SHA-256 无法还原原始文件；请生成新的可上链批次。";
      chainCell.append(missing);
    } else if (!canProduce()) {
      const locked = document.createElement("span");
      locked.className = "cache-status";
      locked.textContent = accessState?.authenticated ? "仅数据方可上链" : "登录数据方钱包后上链";
      chainCell.append(locked);
    } else {
      const btn = document.createElement("button");
      btn.className = "button primary";
      btn.style.padding = "5px 10px";
      btn.style.fontSize = "10px";
      btn.textContent = "上链";
      btn.addEventListener("click", () => anchorBatch(batch, btn));
      chainCell.append(btn);
    }
    row.append(chainCell);
    const fileCell = document.createElement("td");
    if (batch.cached_only || batch.browser_generated) {
      const cacheLabel = document.createElement("span");
      cacheLabel.className = "cache-status";
      cacheLabel.textContent = cachedFile
        ? batch.browser_generated ? "本机生成 · 原文件已保存" : "本机缓存 · JSON 可下载"
        : "本机缓存 · 仅指纹";
      cacheLabel.title = cachedFile
        ? "JSON 文件保存在当前浏览器，可随时下载。"
        : "本机保存了批次编号和哈希；原始 JSON 未缓存或已清理。";
      fileCell.append(cacheLabel);
    }
    if (canDownload()) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "button file-download";
      button.textContent = cachedFile ? "下载 JSON" : batch.cached_only ? "尝试找回 JSON" : "下载并缓存 JSON";
      button.title = cachedFile ? "从本机缓存下载已校验的 JSON" : "从服务下载、校验哈希并保存到本机";
      button.addEventListener("click", () => downloadBatchJson(batch, cachedFile));
      fileCell.append(button);
    } else if (!accessState?.authenticated) {
      const connect = document.createElement("button");
      connect.type = "button";
      connect.className = "button file-download";
      connect.textContent = "登录后下载";
      connect.addEventListener("click", walletLogin);
      fileCell.append(connect);
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
      if (!canDownload()) {
        showToast(accessState?.authenticated ? "请先购买有效订阅，再下载批次 JSON。" : "请先连接钱包并签名登录，再下载批次 JSON。", true);
        return false;
      }
      let contents = cachedContents;
      let cached = Boolean(contents);
      let bytes;
      if (!contents) {
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
      return true;
    } catch (error) {
      showToast(error.message || "JSON 下载失败，请稍后重试。", true);
      return false;
    }
  }

  async function downloadPreviewJson() {
    if (!canDownload()) {
      showToast("连接数据方或有效订阅钱包后才能下载测试 JSON。", true);
      return;
    }
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

async function anchorBatch(batch, button) {
  if (!canProduce()) {
    showToast("只有数据提供方钱包签名登录后才能提交存证。", true);
    return;
  }
  if (typeof window.ethereum === "undefined") {
    alert("当前浏览器未检测到 MetaMask，请在安装了 MetaMask 的 Chrome 或 Edge 中打开在线 Demo。");
    return;
  }
  let submittedTxHash = "";
  button.disabled = true;
  button.textContent = "准备中…";
  try {
    if (!savedBatchFiles()[batch.sha256_hex]) {
      await downloadBatchJson(batch);
      if (!savedBatchFiles()[batch.sha256_hex]) {
        throw new Error("上链前请先下载并缓存该批次的原始 JSON；仅有指纹无法供评审验证。");
      }
    }
    setAnchorFeedback(`正在连接 MetaMask，准备提交批次 ${batch.browser_generated ? "本机" : "#"}${batch.batch_seq} 的指纹…`, { stage: "pending", sha256Hex: batch.sha256_hex });
    await initChain();
    if (!(await loadEthers())) throw new Error("区块链库加载失败，请检查网络后重试。");
    const { provider: web3Provider, signer } = await SensorWallet.connect(chainConfig);
    const owner = await new ethers.Contract(chainConfig.contract_address, chainAbi, web3Provider).owner();
    const submitter = await signer.getAddress();
    if (owner.toLowerCase() !== submitter.toLowerCase()) {
      throw new Error("当前钱包不是数据存证合约 owner；请切换部署合约的钱包账户。");
    }
    setAnchorFeedback("请在 MetaMask 中确认 BOT Chain 主网交易。", { stage: "pending", sha256Hex: batch.sha256_hex });
    const contract = new ethers.Contract(chainConfig.contract_address, chainAbi, signer);
    const dataHash = "0x" + batch.sha256_hex;
    ui.error.hidden = true;
    const tx = await contract.recordData(chainConfig.stream_id, dataHash, batch.file_name);
    submittedTxHash = tx.hash;
    button.textContent = "等待确认…";
    setAnchorFeedback("交易已提交，正在等待 BOT Chain 区块确认。", { stage: "pending", txHash: tx.hash, sha256Hex: batch.sha256_hex });
    ui.error.hidden = false;
    ui.error.textContent = `交易已提交: ${tx.hash}，等待区块确认…`;
    const receipt = await tx.wait();
    if (receipt?.status !== 1) throw new Error("交易未成功执行，请在区块浏览器检查回执。");
    setAnchorFeedback(`交易已进入区块 #${receipt.blockNumber}，正在核对合约事件与文件指纹。`, { stage: "pending", txHash: tx.hash, blockNumber: receipt.blockNumber, sha256Hex: batch.sha256_hex });
    const proof = await request(`/api/batches/${batch.batch_seq}/anchor`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tx_hash: tx.hash, sha256_hex: batch.sha256_hex, file_name: batch.file_name }),
    });
    if (!proof.anchor_verified) throw new Error("交易已确认，但后端未通过存证核验。");
    const anchors = savedAnchors();
    anchors[batch.sha256_hex] = { anchor_tx: tx.hash.replace(/^0x/, ""), anchor_verified: true, file_name: batch.file_name };
    storageWrite(anchorsStorageKey, JSON.stringify(anchors));
    batch.anchor_tx = tx.hash.replace(/^0x/, "");
    batch.anchor_verified = true;
    ui.error.hidden = true;
    setAnchorFeedback(`区块 #${receipt.blockNumber} · SHA-256 0x${batch.sha256_hex.slice(0, 16)}… 已由链上事件核对。可下载 JSON 到“验证文件”页复核。`, { stage: "confirmed", txHash: tx.hash, blockNumber: receipt.blockNumber, sha256Hex: batch.sha256_hex });
    showToast("BOT Chain 主网存证成功，可点击交易链接查看。", false);
    renderBatches();
    await refresh();
  } catch (error) {
    ui.error.hidden = false;
    ui.error.textContent = `${submittedTxHash ? "交易已提交，但页面核验未完成" : "尚未完成上链"}: ${error.message || error}`;
    setAnchorFeedback(submittedTxHash
      ? "交易已提交；请先打开区块浏览器查看真实状态，避免重复提交。"
      : `尚未提交链上交易：${error.message || error}`, { stage: "pending", txHash: submittedTxHash, sha256Hex: batch.sha256_hex });
    button.disabled = false;
    button.textContent = "上链";
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
    updateProtectedControls();
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
    updateProtectedControls();
  } catch (error) {
    accessLastChecked = Date.now();
    accessState = { authenticated: false, owner_access: false, can_download: false };
    pill.textContent = "链上订阅状态暂不可用";
    ui.error.textContent = error.message;
    ui.error.hidden = false;
    updateProtectedControls();
  }
}

function render() {
  const latest = snapshot.readings.at(-1);
  ui.pm25.textContent = latest ? latest.pm25_ug_m3.toFixed(1) : "—";
  ui.noise.textContent = latest ? latest.noise_db.toFixed(1) : "—";
  ui.total.textContent = rememberTotal(snapshot.total).toLocaleString("zh-CN");
  const durable = snapshot.persistent_storage === true;
  const storageFoot = document.getElementById("storage-foot");
  const storageDetail = document.getElementById("storage-detail");
  if (storageFoot) storageFoot.textContent = durable ? `已保存至${snapshot.storage_backend === "postgresql" ? "云端数据库" : "本机 SQLite"}` : "临时存储 · 重启可能清空";
  if (storageDetail) storageDetail.textContent = durable
    ? `已写入${snapshot.storage_backend === "postgresql" ? "共享 PostgreSQL 数据库" : "本机 SQLite 数据库"}，服务重启后仍可读取`
    : "当前使用实例临时数据库，重启后数据可能重置；配置 DATABASE_URL 启用持久化";
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
    updateProtectedControls();
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
    updateProtectedControls();
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
      if (canProduce() && Date.now() - lastAutoSealAt >= 60000) {
        lastAutoSealAt = Date.now();
        try { await sealBrowserBatch(true); }
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
ui.seal.addEventListener("click", async () => {
  if (!canProduce()) {
    showToast("请先用数据提供方钱包签名登录。订阅用户可以下载，只有数据方可以打包和上链。", true);
    return;
  }
  if (snapshot?.sampling_mode !== "browser") {
    action("/api/batches/seal", {});
    return;
  }
  if (actionBusy) return;
  actionBusy = true;
  ui.seal.disabled = true;
  try { await sealBrowserBatch(); }
  catch (error) { showToast(`批次生成失败：${error.message || error}`, true); }
  finally { actionBusy = false; updateProtectedControls(); }
});
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
    updateProtectedControls();
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
const previousProof = parseObject(storageRead(anchorFeedbackStorageKey, "{}"), {});
if (previousProof.stage === "confirmed" && previousProof.txHash) {
  setAnchorFeedback(previousProof.message, previousProof);
}
updateProtectedControls();
poll();
void initChain().catch(error => console.warn("BOT Chain 配置加载失败:", error));
refreshAccess();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initApp);
} else {
  initApp();
}
