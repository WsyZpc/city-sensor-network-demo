# Vercel 线上版 · 城市传感器网络

在线站点：<https://city-sensor-network-demo.vercel.app/>。这是仓库中正在部署的 FastAPI 副本；项目介绍与完整操作流程见[根目录 README](../README.md)。本页记录在线版的运行方式与交付边界。

## 页面与操作

- `/`：产品介绍与数据提供方、企业开发者、公众的体验指引。
- `/console`：页面可见时约每秒请求一次模拟采样；游客只能看少量公开预览。合约 owner 钱包签名登录后可手动打包、下载原始 JSON，并提交 BOT Chain 主网存证。
- `/subscribe`：读取数据流的实时价格、订阅天数与预计费用；钱包确认 `subscribe` 交易后，服务端按链上 `isValidSub` 判断有效期。
- `/parser`：有效订阅者上传批次 JSON，查看统计、趋势、逐条记录并导出 CSV。页面显示当前登录钱包，可刷新链上状态或重新验证；`POST /api/subscriber/parse` 会在服务端再次核验订阅，最多接受 2 MB、5,000 条记录，不持久保存上传原文。合约 owner 如果没有有效订阅也不能使用解析接口。
- `/verify`：浏览器本地计算文件的 SHA-256，核对 BOT Chain 交易回执中的 `DataRecorded` 事件；提供未存证 JSON 对照样例。

登录签名只证明钱包归属，不花 Gas。购买订阅和 `recordData` 存证均为需要 MetaMask 确认、消耗 BOT 的主网交易。当前读数由程序模拟，不代表武汉真实监测结果；链上指纹只能证明文件与存证时一致。

## 文件与存储

在线版优先使用 `DATABASE_URL` 指向的 PostgreSQL 数据库，保存服务端读数、批次元数据和原始 JSON 字节。若没有配置有效连接串，则回退到 Vercel 实例临时存储，实例重建后数据可能丢失。云端仍保有原文的服务端批次，可由合约 owner 或有效订阅钱包重新登录后受控下载；下载前会核对文件 SHA-256。

浏览器生成的 `browser-batch` 原始 JSON 只保存在当前浏览器，需由数据方及时下载备份并交付。即使其指纹已经上链，换设备后也无法从指纹还原原文件。订阅只控制本站后续的受控下载与解析，已经下载的文件无法撤回，也可以被其他软件读取。

## BOT Chain 主网配置

- Chain ID：`677`；RPC：<https://rpc.botchain.ai>；原生代币：`BOT`。
- 合约：[`0xC55793411e9fC98288bA09976D607cEAf94650bB`](https://scan.botchain.ai/address/0xC55793411e9fC98288bA09976D607cEAf94650bB)。
- 数据流：`0`；订阅价格以合约实时查询结果为准。
- 前端 ABI 与网络配置：[`templates/static/abi.json`](templates/static/abi.json)、[`templates/static/chain-config.json`](templates/static/chain-config.json)。
- `contracts/DataAttestation.sol` 是早期草稿，并非已部署的 `SensorDataMarket` 合约源码。

## 本地启动与测试

需要 Python 3.11 或更高版本。进入本目录后：

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe app.py
```

macOS / Linux 将 `.\.venv\Scripts\python.exe` 换成 `.venv/bin/python`。浏览器打开 <http://127.0.0.1:8000>。本地未配置 `DATABASE_URL` 时使用 SQLite。GitHub 文件页面本身不能运行 FastAPI。

检查命令：

```powershell
.\.venv\Scripts\python.exe -m unittest discover -s tests -v
node tests/frontend_smoke.cjs
node tests/test_verify_demo.cjs
```

## Vercel 部署

导入整个仓库，将项目的 **Root Directory** 设为 `vercel-demo`。在 Vercel 项目环境变量中配置 `DATABASE_URL`（PostgreSQL 连接串），然后重新部署；不要把数据库密码提交到 Git。Vercel Serverless 实例不保证后台循环常驻，因此在线采样由可见的控制台页面触发，也可手动点击“采样一次”。

评审前建议准备两个钱包角色并走通：数据方打包、下载和上链；订阅者购买、下载、解析；最后用原始 JSON 验证存证。当前尚无真实传感器、设备身份校验、质押防作弊或生产级数据 API。
