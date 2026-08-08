# 部署指南

前端已自动部署到 GitHub Pages（push `frontend/**` 触发 Actions）。要让线上拿到真实数据，需把**后端部署到公网**并让前端指向它。

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
      - key: FUND_DB_PERSISTENCE
        value: persistent_disk
```

只有 `/var/data` 下的文件会跨部署保留。配置完成后，应在 `/api/health` 与运行状态页确认数据库模式为 `persistent_disk`。继续使用 `plan: free` 时，健康接口会明确报告 `ephemeral`，不得宣称决策闭环已持久化。

## 二、让前端指向后端

后端 CORS 已放行 `https://aureliuswu.github.io`，无需改后端。

1. GitHub 仓库 → Settings → Secrets and variables → Actions → **Variables** → New，
   - Name：`VITE_API_BASE`
   - Value：你的后端地址 + `/api`，例如 `https://fund-compass-api.onrender.com/api`
2. 触发前端重新部署：改动 `frontend/**` 后 push，或在 Actions 里手动 Run workflow（`Deploy frontend to GitHub Pages`）。
3. 打开 https://aureliuswu.github.io/fund-compass/ ，选基 / 自选 / 详情 / 对比都能拿到真实数据。

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
