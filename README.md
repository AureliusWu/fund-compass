# 司南基金 (fund-compass)

> 个人基金选基与择时辅助工具 · 司南，定方向

司南基金是面向个人投资者的轻量级基金分析 PWA，解决两个核心问题：

- 选基：买哪只基金。
- 择时：什么时候买、定投、持有或减仓。

本项目只做投资辅助，不做自动交易，不构成投资建议。

## 技术栈

| 层 | 选型 |
|---|---|
| 前端 | Vue 3 · Vite · TypeScript · Pinia · Vant 4 · ECharts · vite-plugin-pwa |
| 后端 | FastAPI · Python 3.12 · SQLite |
| 算法 | 纯 Python，评分 / 风险 / 择时 / 回测不依赖 pandas/numpy |
| 数据源 | 天天基金 / 东方财富公开接口 |
| 本地存储 | SQLite · IndexedDB · localStorage |

## 功能

- 基金筛选、自然语言筛选、同类更优。
- 基金评分：收益、风险、管理、成本四维评分。
- 择时信号：估值、趋势、情绪三层信号。
- **决策卡片（V6）**：综合评分 + 择时 + 回测 → 分批买入 / 继续定投 / 持有观望等可执行动作；自选页批量决策摘要；14:30 推送可升级为决策摘要（配置 `FUND_API_BASE`）。
- **受约束自迭代回测**：单基金训练/留出验证、跨基金聚合门槛、参数版本注册表与自动回滚；只有满足样本数、支持率、超额收益和回撤约束的候选才会晋级。
- 指数 PE/PB 估值分位与净值代理降级。
- 基金对比、回测实验室、体检报告。
- 自选与持仓、跨账户资产、大类配置、持仓穿透。
- QDII/海外基金盘中估值与最新净值涨跌口径区分。
- 数据故事、组合诊断、定投测算、提醒与推送。
- PWA、离线缓存、暗黑模式、导入导出。

## 目录结构

```text
fund-compass/
├── frontend/        # Vue 3 + Vite PWA
├── backend/         # FastAPI + SQLite
├── tools/           # 离线补全、估值推送、通知
├── docs/            # 部署、路线图、推送配置
└── README.md
```

## 本地开发

```bash
# 后端
cd backend
pip install -r requirements.txt -r requirements-dev.txt
uvicorn main:app --reload --port 8000
pytest

# 前端
cd frontend
npm install
npm run dev
npm run test
npm run type-check
npm run build
```

## API 概览

- `GET /api/health`
- `GET /api/funds`
- `GET /api/fund/{code}`
- `GET /api/fund/{code}/score`
- `GET /api/fund/{code}/signal`
- `GET /api/fund/{code}/backtest`
- `GET /api/fund/{code}/analyze`
- `GET / POST / DELETE /api/watchlist`
- `POST /api/admin/refresh-universe`

## 部署

- 前端：GitHub Pages。
- 后端：Render / Railway。
- 配置参考：`docs/DEPLOY.md`、`docs/PUSH-SETUP.md`、`render.yaml`。

## 项目关系

- `fund-compass`：司南基金，本项目。
- `FundVal`：蜉蝣基金，纯前端基金盘中估值 PWA。
- `pan`：盘中宝，移动端基金盘中估值 PWA。

## 风险提示

所有评分、信号、估值、回测和 AI 解读都基于公开数据与模型计算，仅供个人参考，不构成投资建议。
