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
3. 部署完成后得到地址，如 `https://fund-compass-api.onrender.com`。

> 或不用 Blueprint：New → Web Service，Root Directory 填 `backend`，Build `pip install -r requirements.txt`，Start `uvicorn main:app --host 0.0.0.0 --port $PORT`。

### 方案 B：Railway
1. 登录 [Railway](https://railway.app) → New Project → Deploy from GitHub repo。
2. Service 的 Root Directory 设为 `backend`；仓库内已含 `Dockerfile` 与 `Procfile`，Railway 会自动识别。
3. 拿到公网域名。

> 重要：Render Free Web Service 的文件系统是临时的，实例休眠、重启或重新部署都会丢失 SQLite。免费档只适合临时体验，不能把自选、决策账本、组合快照或幂等记录视为耐久数据。

### 生产持久化

Render 持久盘仅支持付费 Web Service。确认费用后，把服务升级到付费实例，并在 Blueprint 中配置磁盘与数据库路径：

```yaml
services:
  - type: web
    name: fund-compass-api
    plan: starter
    disk:
      name: fund-compass-data
      mountPath: /var/data
      sizeGB: 1
    envVars:
      - key: FUND_DB
        value: /var/data/fund_compass.db
      - key: FUND_DB_MOUNT_PATH
        value: /var/data
      - key: FUND_DB_PERSISTENCE
        value: persistent_disk
```

只有 `/var/data` 下的文件会跨部署保留。后端只有在以下条件全部满足时，才会在 `/api/health` 报告 `persistent_disk` 与 `durable: true`：

- 显式配置了 `FUND_DB` 与 `FUND_DB_MOUNT_PATH`，且二者均为绝对路径；挂载目录不能直接声明为根文件系统；
- 数据库文件位于声明的挂载目录内；
- 挂载目录真实存在、是系统挂载点，并且对服务进程可写。

任一检查失败时，健康接口会报告 `misconfigured` 与 `durable: false`，但不会暴露服务器路径。部署完成后，还应执行一次数据库写入与读取，并确认记录经过重启或再次部署后仍然存在；不能只依据环境变量或单次健康检查宣称持久化完成。

挂载新磁盘不会自动迁移临时文件系统中的旧 SQLite 文件。若旧数据需要保留，必须在重启或重新部署前制作一致性备份并单独导入持久盘。继续使用 `plan: free` 时，健康接口会明确报告 `ephemeral`，不得宣称决策闭环已持久化。

当前 v7.0.0 生产方案仍使用 `render.yaml` 的 `plan: free`，预期健康状态必须是 `persistence: ephemeral`、`durable: false`。版本发布不会自动购买磁盘、迁移数据库或改变这一边界。

## 二、让前端指向后端

后端 CORS 已放行 `https://aureliuswu.github.io`，无需改后端。

1. GitHub 仓库 → Settings → Secrets and variables → Actions → **Variables** → New，
   - Name：`VITE_API_BASE`
   - Value：你的后端地址 + `/api`，例如 `https://fund-compass-api.onrender.com/api`
2. 触发前端重新部署：push 到 `main`，或在 Actions 中手工运行 `CI` 并传入当前 `main` 的完整 40 位提交 SHA。`Deploy frontend to GitHub Pages` 是可复用子工作流，不能绕过 CI 单独发布。
3. 打开 https://aureliuswu.github.io/fund-compass/ ，选基 / 自选 / 详情 / 对比都能拿到真实数据。

## 发布与回滚

发布必须绑定同一个精确提交完成以下闭环：本地全量门禁 → push `main` → CI → Pages → Render → 必要时部署 Worker → `post-deploy-smoke`。Pages 的 `release.json`、API 健康接口的 Render commit 与目标 SHA 必须一致；Worker 有源码变化时还必须核对实际部署 version，只有版本号相同不能证明部署。全部通过后才创建版本标签。自动数据提交也要经过显式调度的 CI/Pages 链路，不能只看到仓库数据更新就认为生产静态数据已经更新。

选基、经理和持仓静态数据使用 schema v2 清单与内容哈希；生产 smoke 会下载全部分片，核对 SHA-256、行数、唯一性、披露日期与明细文件。指数估值只接受真实源日期和可用核心 PE 分位，任务运行日期不能替代行情日期。定期任务状态页只统计自然 `schedule` 运行；手工验收结果必须单独记录，不能遮盖最近一次自然失败。

GitHub schedule 不保证金融时点准时。海外精度任务必须保存真实观察时间与调度延迟，迟到样本不得回填为计划时刻；观察日、目标净值归属日和基准净值日必须分别记录。自然定时产出仍需后续交易日证据，手工 workflow 只验证代码链路且默认禁止模型自动晋级。

Worker 的 HTTP 健康和估值烟测不会触发通知；禁止在发布烟测中调用受保护的 `POST /test` 或运行 `manual-estimate-push`。自然 Cron 是否成功，只能由部署后的工作日北京时间 14:30/14:40 的新记录证明，不能用 Worker 部署成功代替。

v7.0.0 发布前冻结以下回滚证据：上一正式标签与提交、最新数据提交、Pages deployment、Render deployment、Worker version ID。回滚应用反向提交保留后续自动生成的数据提交，不使用强推或把 `main` 重置到旧标签；Worker 使用 Wrangler 的精确 version ID 回滚。Render 免费 SQLite 不具备耐久性，因此代码回滚不等于数据库数据恢复。

## 本地联调

生产环境必须生成并配置两个不同的高强度随机 Secret：

- `ADMIN_TOKEN`：管理员写接口和重任务。
- `WORKER_TOKEN`：Cloudflare Worker 调用组合决策接口。

二者只存 Render/Cloudflare Secret，不得使用前端 `VITE_` 变量，也不得写入仓库。所有 GET 读取接口保持公开。

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
