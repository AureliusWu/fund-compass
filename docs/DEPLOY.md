# 部署指南

前端只通过 `CI` 的可复用 Pages 作业部署。CI 锁定 `origin/main` 的精确提交，后端、前端和 Worker 门禁全部通过后才部署并执行生产 smoke。由 GitHub Actions 生成并提交的持仓、经理、基金全集、海外精度或校准数据，会在提交成功后带精确 SHA 重试派发一次 `CI`；这样既能让 Pages 跟进静态数据，又不会依赖 `GITHUB_TOKEN` push 自动触发新工作流，也不会形成提交循环。要让线上拿到真实数据，还需把**后端部署到公网**并让前端指向它。

## 一、部署后端（任选其一）

后端是 FastAPI，启动命令统一为：
```
uvicorn main:app --host 0.0.0.0 --port $PORT
```

### 方案 A：Render（推荐，有免费档）
1. 登录 [Render](https://render.com) → New → Blueprint，选本仓库。
2. Render 会读取根目录 `render.yaml` 自动建一个 Python Web Service（rootDir=backend）。
3. 部署完成后得到地址，如本次零成本候选服务 `https://fund-compass-api-v8-candidate.onrender.com`。

> 或不用 Blueprint：New → Web Service，Root Directory 填 `backend`，Build `pip install -r requirements.txt`，Start `uvicorn main:app --host 0.0.0.0 --port $PORT`。

### 方案 B：Railway
1. 登录 [Railway](https://railway.app) → New Project → Deploy from GitHub repo。
2. Service 的 Root Directory 设为 `backend`，Build 命令设为 `pip install -r requirements.txt`，Start 命令使用本页顶部的 `uvicorn` 命令。本仓库没有 `Dockerfile` 或 `Procfile`，不得依赖不存在的自动识别文件。
3. 拿到公网域名。

> 重要：Render Free Web Service 的文件系统是临时的，实例休眠、重启或重新部署都会丢失 SQLite。免费档只适合临时体验，不能把自选、决策账本、组合快照或幂等记录视为耐久数据。

### 当前零成本发布边界

用户已撤销 Render Starter 和持久盘的付费授权。本次创建的并行候选服务
`fund-compass-api-v8-candidate` 明确使用 Render Free（$0/月），没有磁盘；仓库只保留
`render.yaml` 的 Free 定义，不保留可能误触发付费资源的 Blueprint。候选公网 API 为
`https://fund-compass-api-v8-candidate.onrender.com`，其 SQLite 文件系统是临时的，健康接口必须
诚实报告 `persistence: ephemeral`、`durable: false`。

这意味着服务休眠、重启或重新部署后，自选、决策账本、Outcome、通知幂等记录和其他数据库
内容都可能丢失。代码级 schema、备份和失败关闭测试通过，不能把它改写成生产持久化已通过；
现有 V8 persistence gate 会拒绝该配置。本次只能部署未发布候选用于验证，正式 v8.0.0
发布状态必须保持 **`BLOCKED`**，不得创建版本标签。
当前 v8.0.0 生产方案因此仍是候选部署，而不是正式发布。

零成本发布顺序：

1. 冻结候选 Free 服务真实 URL、Render deployment ID、Pages deployment、Worker version ID 与目标提交 SHA，不创建或升级到任何付费资源。
2. 在候选 Free 服务配置三个彼此不同的 `ADMIN_TOKEN` / `WORKER_TOKEN` / `PRIVATE_READ_TOKEN`，并部署同一目标 SHA。
3. 将 GitHub Actions Secret `FUND_API_BASE`、Pages 变量 `VITE_API_BASE` 和 Worker 后端地址统一指向已核验的 `https://fund-compass-api-v8-candidate.onrender.com`。
4. 用 `/api/health` 核对版本、源码身份以及 `ephemeral / durable=false`；生产 persistence gate 必须失败并保持发布阻断，不能把它降级为警告或伪装为持久化成功。
5. Pages、API、Worker、隐私脱敏、canonical wire 与精确 SHA 可以作为候选部署证据，但在真实 `durable=true` 前不得创建 v8.0.0 标签或宣称正式发布。

后端只在未来真正配置持久存储且以下条件全部满足时，才会在 `/api/health` 报告 `persistent_disk` 与 `durable: true`：

- 显式配置了 `FUND_DB` 与 `FUND_DB_MOUNT_PATH`，且二者均为绝对路径；挂载目录不能直接声明为根文件系统；
- 数据库文件位于声明的挂载目录内；
- 挂载目录真实存在、是系统挂载点，并且对服务进程可写。

任一检查失败时，健康接口会报告 `misconfigured` 与 `durable: false`，但不会暴露服务器路径。未来若启用持久存储，仍须执行数据库写入与读取，并确认记录经过重启或再次部署后存在；不能只依据环境变量或单次健康检查宣称持久化完成。

当前 `render.yaml` 明确配置 `ephemeral`，不得把它当作耐久数据回滚或备份来源，也不得在文档、健康状态或发布结论中声称 `durable=true`。在获得新的明确授权和真实跨重启证据前，不执行付费持久化方案。

本地门禁会经正式仓储 API 写入 Evidence → Source Health → Holding/Policy → Decision
→ QDII/Portfolio Outcome → Notification/Idempotency 完整审计链。第二个 Python 进程
按稳定 ID 读回并验证缺失值、目标日期、不可变重放与来源事件；随后使用与生产相同
的原子备份函数生成一致性副本，恢复到独立路径并由第三个进程再次读回，同时核对
`PRAGMA user_version`、`quick_check`、`integrity_check` 与 `foreign_key_check`。

自动迁移备份先写 `.bak.partial`，校验通过后才原子发布为 `.bak`；V8 补列、缺失
schema 对象和文件型 `file:` URI 也必须先备份。比当前代码更新的未来 schema 版本
会在备份、WAL 或迁移写入前拒绝启动。以上仍只证明本地 SQLite 和恢复流程；因为
临时目录不是经过运行时验证的挂载点，测试要求 health 的 `durable` 为 `false`。
只有在未来存在真实挂载、备份/恢复、整链读写和跨重启复验证据时，才能解除
生产持久化阻断；本次零成本候选部署不会解除该门禁。

## 二、让前端指向后端

后端 CORS 已放行 `https://aureliuswu.github.io`，无需改后端。

1. GitHub 仓库 → Settings → Secrets and variables → Actions → **Variables** → New，
   - Name：`VITE_API_BASE`
   - Value：你的后端地址 + `/api`，本次为 `https://fund-compass-api-v8-candidate.onrender.com/api`
2. 触发前端重新部署：push 到 `main`，或在 Actions 中手工运行 `CI` 并传入当前 `main` 的完整 40 位提交 SHA。`Deploy frontend to GitHub Pages` 是可复用子工作流，不能绕过 CI 单独发布。
3. 打开 https://aureliuswu.github.io/fund-compass/ ，选基 / 自选 / 详情 / 对比都能拿到真实数据。

## 发布与回滚

发布必须绑定同一个精确提交完成以下闭环：本地全量门禁 → push `main` → CI → Pages → Render → 必要时部署 Worker → `post-deploy-smoke`。Pages 的 `release.json` 必须等于目标 SHA；API 健康接口的 Render commit 必须是目标提交本身，或是目标提交的祖先且 `backend/` 与 `render.yaml` 内容逐字节等价（纯静态数据提交不会强迫 Render 重部署）。smoke 必须使用 GitHub Secret `FUND_API_BASE` 指向经过核验的真实 Free API，验证 V8 契约并确认其诚实报告 `ephemeral / durable=false`；V8 persistence gate 必须因此拒绝正式发布，不能把失败降级为警告或通过。Worker 有源码变化时还必须核对实际部署 version，只有版本号相同不能证明部署。其他代码与生产契约门禁通过也只能形成未发布候选，在真实 `durable=true` 前不得创建版本标签。自动数据提交也要经过显式调度的 CI/Pages 链路，不能只看到仓库数据更新就认为生产静态数据已经更新。

选基、经理和持仓静态数据使用 schema v2 清单与内容哈希；生产 smoke 会下载全部分片，核对 SHA-256、行数、唯一性、披露日期与明细文件。指数估值只接受真实源日期和可用核心 PE 分位，任务运行日期不能替代行情日期。定期任务状态页只统计自然 `schedule` 运行；手工验收结果必须单独记录，不能遮盖最近一次自然失败。

GitHub schedule 不保证金融时点准时。海外精度任务必须保存真实观察时间与调度延迟，迟到样本不得回填为计划时刻；观察日、目标净值归属日和基准净值日必须分别记录。自然定时产出仍需后续交易日证据，手工 workflow 只验证代码链路且默认禁止模型自动晋级。

Worker 的 HTTP 健康和估值烟测不会触发通知；禁止在发布烟测中调用受保护的 `POST /test` 或运行 `manual-estimate-push`。自然 Cron 是否成功，只能由部署后的工作日北京时间 14:30/14:40 的新记录证明，不能用 Worker 部署成功代替。

v8.0.0 发布前冻结以下回滚证据：上一正式标签与提交、最新数据提交、Pages deployment、现有 Free 服务 URL 与 Render deployment、Worker version ID。切流失败时，只能把 `FUND_API_BASE`、`VITE_API_BASE` 和 Worker 后端地址回指到**已部署同版隐私加固代码或经逐项验证等价**的 Free 路由；不得热回滚到会公开完整 V8 私人 DTO 的旧版本。对回滚 SHA 重跑 CI/Worker 验证，不使用强推或把 `main` 重置到旧标签。Worker 使用 Wrangler 的精确 version ID 回滚。Free SQLite 是临时数据，只能回滚应用路由，不能充当数据备份；重启后数据库内容丢失属于已知且未解除的风险。

## 本地联调

生产环境必须生成并配置三个彼此不同的高强度随机 Secret：

- `ADMIN_TOKEN`：管理员写接口和重任务。
- `WORKER_TOKEN`：Cloudflare Worker 调用组合决策接口。
- `PRIVATE_READ_TOKEN`：仅供服务所有者读取脱敏前的私人 DTO；不得复用 Admin/Worker Token。

凭证只进入确有调用需要的 Secret 存储：`ADMIN_TOKEN` 仅放 Render；`WORKER_TOKEN` 放 Render、Cloudflare Worker，并供 GitHub 的手动估值任务使用；`PRIVATE_READ_TOKEN` 放 Render 和需要读取私人校准证据的 GitHub Actions。三者不得使用前端 `VITE_` 变量、localStorage 或写入仓库。匿名 owner 数据 GET 统一返回 HTTP 403；需要完整持仓、组合、策略结果、运行活动或服务端 watchlist 的 private GET 必须携带 `PRIVATE_READ_TOKEN`。公开 health 不再返回最近决策/结算时间或候选策略治理聚合；服务所有者可从 `/api/private/operations` 和 `/api/private/strategy/registry` 读取完整数据。

每周策略校准作业还必须在 GitHub Actions Secrets 配置同名 `PRIVATE_READ_TOKEN`。作业只读 `/api/private/strategy/outcomes`；Token 缺失、鉴权失败、响应脱敏或契约异常时会失败关闭，不会把未知实盘样本当成 0 并提交错误治理状态。

当前校准作业的两个输出都会进入公开 Git/Pages，因此仅在已验证实盘样本为空且没有旧的私人治理证据时允许生成公开产物。一旦存在私人样本、汇总或历史退化周期，作业在抓取公开校准数据及写文件前明确失败，保留已有 JSON 和 active 策略；不得通过清空数据、删历史或移除门禁恢复任务。私人治理必须先迁入经过认证的持久存储，再恢复该分支的自动校准。这是本轮有意保留的失败关闭限制，不是已完成的定期任务恢复。

```bash
# 后端（建议 Python 3.12）
cd backend
python -m venv .venv && .venv\Scripts\activate   # Windows
pip install -r requirements.txt
uvicorn main:app --reload --port 8000

# 前端（另一个终端）
cd frontend
npm install
npm run dev   # http://localhost:5173/fund-compass/ ，/api 自动代理到 8000
```
