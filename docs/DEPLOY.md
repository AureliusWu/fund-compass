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

> 备注：免费档文件系统是临时的，重新部署后 SQLite 会重置（基金列表会在冷启动自动重新抓取；自选会丢失）。要持久化可挂载磁盘卷或换外部数据库，后续增强。

## 二、让前端指向后端

后端 CORS 已放行 `https://aureliuswu.github.io`，无需改后端。

1. GitHub 仓库 → Settings → Secrets and variables → Actions → **Variables** → New，
   - Name：`VITE_API_BASE`
   - Value：你的后端地址 + `/api`，例如 `https://fund-compass-api.onrender.com/api`
2. 触发前端重新部署：改动 `frontend/**` 后 push，或在 Actions 里手动 Run workflow（`Deploy frontend to GitHub Pages`）。
3. 打开 https://aureliuswu.github.io/fund-compass/ ，选基 / 自选 / 详情 / 对比都能拿到真实数据。

## 本地联调

```bash
# 后端（建议 Python 3.12）

生产环境必须生成并配置两个不同的高强度随机 Secret：

- `ADMIN_TOKEN`：管理员写接口和重任务。
- `WORKER_TOKEN`：Cloudflare Worker 调用组合决策接口。

二者只存 Render/Cloudflare Secret，不得使用前端 `VITE_` 变量，也不得写入仓库。所有 GET 读取接口保持公开。
cd backend
python -m venv .venv && .venv\Scripts\activate   # Windows
pip install -r requirements.txt
uvicorn main:app --reload --port 8000

# 前端（另一个终端）
cd frontend
npm install
npm run dev   # http://localhost:5173/fund-compass/ ，/api 自动代理到 8000
```
