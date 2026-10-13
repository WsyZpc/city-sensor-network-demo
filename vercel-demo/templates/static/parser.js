"use strict";

const ui = Object.fromEntries([
  "parser-connect", "parser-subscribe", "parser-workspace", "parser-file", "parser-file-name",
  "parser-run", "parser-error", "parser-result", "parser-meta", "parser-count", "parser-pm25",
  "parser-noise", "parser-hash", "parser-csv", "parser-rows", "metric-pm25", "metric-noise",
  "parser-chart-caption", "parser-chart-min", "parser-chart-max", "parser-area-path", "parser-line-path",
].map(id => [id, document.getElementById(id)]));
const accessTitle = document.getElementById("parser-access-title");
const accessMessage = document.getElementById("access-message");
let allowed = false;
let parsed = null;
let chartMetric = "pm25_ug_m3";

function showError(message) {
  ui["parser-error"].textContent = message;
  ui["parser-error"].hidden = !message;
}

function updateRunButton() {
  ui["parser-run"].disabled = !allowed || !ui["parser-file"].files?.length;
}

function setAccess(access) {
  allowed = Boolean(access?.authenticated && access?.subscription?.valid);
  ui["parser-workspace"].hidden = !allowed;
  ui["parser-connect"].hidden = Boolean(access?.authenticated);
  ui["parser-subscribe"].hidden = allowed;
  if (allowed) {
    accessTitle.textContent = "订阅已验证 · 工作台已解锁";
    accessMessage.textContent = `钱包 ${access.address.slice(0, 6)}…${access.address.slice(-4)} 已获得此数据流的有效订阅。`;
  } else if (access?.authenticated) {
    accessTitle.textContent = "当前钱包尚未订阅";
    accessMessage.textContent = "登录已完成，但该数据流没有有效订阅。请先购买，再返回此页解析 JSON。";
  } else {
    accessTitle.textContent = "仅向有效订阅者开放";
    accessMessage.textContent = "连接钱包并签名登录后，系统会核对 BOT Chain 订阅状态。";
  }
  if (!allowed) { parsed = null; ui["parser-result"].hidden = true; }
  updateRunButton();
}

async function readAccess() {
  try {
    const response = await fetch("/api/access", { credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error((await response.json()).detail || "订阅状态查询失败。");
    setAccess(await response.json());
  } catch (error) {
    setAccess(null);
    accessTitle.textContent = "暂时无法核验订阅";
    accessMessage.textContent = `${error.message} 请稍后重试。`;
  }
}

async function connectWallet() {
  const button = ui["parser-connect"];
  button.disabled = true;
  button.textContent = "等待钱包确认…";
  showError("");
  try {
    const configResponse = await fetch("/static/chain-config.json", { cache: "no-store", signal: AbortSignal.timeout(8000) });
    if (!configResponse.ok) throw new Error("链配置暂时不可用。");
    const config = await configResponse.json();
    const { signer, address } = await SensorWallet.connect(config);
    const challengeResponse = await fetch(`/api/auth/challenge?address=${encodeURIComponent(address)}`, { credentials: "same-origin" });
    if (!challengeResponse.ok) throw new Error((await challengeResponse.json()).detail || "获取登录请求失败。");
    const challenge = await challengeResponse.json();
    const signature = await signer.signMessage(challenge.message);
    const loginResponse = await fetch("/api/auth/verify", {
      method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address, signature, message: challenge.message }),
    });
    if (!loginResponse.ok) throw new Error((await loginResponse.json()).detail || "钱包签名登录失败。");
    await readAccess();
  } catch (error) {
    showError(error.message || "钱包连接失败，请重试。");
  } finally {
    button.disabled = false;
    button.textContent = "连接钱包";
  }
}

function displayTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString("zh-CN", { hour12: false });
}

function format(value) { return Number(value).toFixed(1); }

function drawChart() {
  if (!parsed) return;
  const field = chartMetric;
  const values = parsed.readings.map(row => Number(row[field]));
  const low = Math.min(...values), high = Math.max(...values);
  const span = Math.max(high - low, 1);
  const points = values.map((value, index) => {
    const x = values.length === 1 ? 450 : 20 + index * 860 / (values.length - 1);
    const y = 185 - ((value - low) / span) * 140;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });
  const line = `M ${points.join(" L ")}`;
  ui["parser-line-path"].setAttribute("d", line);
  ui["parser-area-path"].setAttribute("d", `${line} L ${values.length === 1 ? 450 : 880},205 L ${values.length === 1 ? 450 : 20},205 Z`);
  const unit = field === "pm25_ug_m3" ? "μg/m³" : "dB";
  ui["parser-chart-caption"].textContent = `${field === "pm25_ug_m3" ? "PM2.5" : "噪音"} · 按采样顺序展示 ${values.length} 条记录`;
  ui["parser-chart-min"].textContent = `最低 ${format(low)} ${unit}`;
  ui["parser-chart-max"].textContent = `最高 ${format(high)} ${unit}`;
  ui["metric-pm25"].classList.toggle("active", field === "pm25_ug_m3");
  ui["metric-noise"].classList.toggle("active", field === "noise_db");
  ui["metric-pm25"].setAttribute("aria-pressed", String(field === "pm25_ug_m3"));
  ui["metric-noise"].setAttribute("aria-pressed", String(field === "noise_db"));
}

function render(result) {
  parsed = result;
  ui["parser-result"].hidden = false;
  ui["parser-meta"].textContent = `${result.node_id} · 批次 ${result.batch_seq ?? "—"} · 打包 ${displayTime(result.sealed_at)}`;
  ui["parser-count"].textContent = Number(result.reading_count).toLocaleString("zh-CN");
  ui["parser-pm25"].textContent = format(result.pm25.average);
  ui["parser-noise"].textContent = format(result.noise.average);
  ui["parser-hash"].textContent = `0x${result.sha256_hex}`;
  if (!result.declared_count_matches) showError("文件声明的记录数与实际记录数不同，请核对原始文件。解析结果按实际记录计算。");
  ui["parser-rows"].replaceChildren();
  const fragment = document.createDocumentFragment();
  for (const row of result.readings.slice(0, 100)) {
    const tr = document.createElement("tr");
    for (const value of [row.sequence, displayTime(row.recorded_at), format(row.pm25_ug_m3), format(row.noise_db)]) {
      const td = document.createElement("td");
      td.textContent = String(value);
      tr.append(td);
    }
    fragment.append(tr);
  }
  ui["parser-rows"].append(fragment);
  drawChart();
}

async function parseFile() {
  const file = ui["parser-file"].files?.[0];
  if (!allowed || !file) return;
  if (file.size > 2 * 1024 * 1024) { showError("文件超过 2 MB，请选择较小的批次 JSON。"); return; }
  const button = ui["parser-run"];
  button.disabled = true;
  button.textContent = "正在核验并解析…";
  showError("");
  try {
    const response = await fetch("/api/subscriber/parse", {
      method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
      body: file, signal: AbortSignal.timeout(30000),
    });
    const result = await response.json();
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) await readAccess();
      throw new Error(result.detail || "文件解析失败。");
    }
    render(result);
  } catch (error) {
    showError(error.message || "文件解析失败，请重试。");
  } finally {
    button.textContent = "解析数据 ↗";
    updateRunButton();
  }
}

function exportCsv() {
  if (!parsed || !allowed) return;
  const cell = value => {
    const raw = String(value);
    const safe = /^[=+@\-\t\r]/.test(raw) ? `'${raw}` : raw;
    return `"${safe.replaceAll('"', '""')}"`;
  };
  const lines = [["sequence", "recorded_at", "pm25_ug_m3", "noise_db"].join(",")];
  for (const row of parsed.readings) lines.push([row.sequence, row.recorded_at, row.pm25_ug_m3, row.noise_db].map(cell).join(","));
  const url = URL.createObjectURL(new Blob(["\ufeff", lines.join("\r\n")], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `sensor-batch-${String(parsed.batch_seq ?? "data").replace(/[^a-zA-Z0-9_-]/g, "")}.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

ui["parser-connect"].addEventListener("click", connectWallet);
document.querySelector(".parser-file-control").addEventListener("keydown", event => {
  if (event.key === "Enter" || event.key === " ") { event.preventDefault(); ui["parser-file"].click(); }
});
ui["parser-file"].addEventListener("change", () => {
  const file = ui["parser-file"].files?.[0];
  ui["parser-file-name"].textContent = file ? `${file.name} · ${(file.size / 1024).toFixed(1)} KB` : "尚未选择文件";
  ui["parser-result"].hidden = true;
  parsed = null;
  showError("");
  updateRunButton();
});
ui["parser-run"].addEventListener("click", parseFile);
ui["parser-csv"].addEventListener("click", exportCsv);
ui["metric-pm25"].addEventListener("click", () => { chartMetric = "pm25_ug_m3"; drawChart(); });
ui["metric-noise"].addEventListener("click", () => { chartMetric = "noise_db"; drawChart(); });
window.addEventListener("sensor-wallet-changed", () => {
  fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" }).finally(readAccess);
});
readAccess();
