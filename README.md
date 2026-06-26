# 司南基金 (FundSelect-PWA)

> 个人基金选基与择时辅助工具 · 司南，定方向

面向个人投资者的轻量级基金分析 PWA，解决两个核心问题：

- **选基** —— 买哪只基金：通过收益、风险、基金经理等指标建立综合评分体系
- **择时** —— 什么时候买 / 卖：通过估值、趋势、情绪三个维度生成买卖信号

不追求机构级量化平台、不追求自动交易、不追求复杂宏观预测。目标只有一个：**每天打开就能快速知道——哪些基金值得关注、当前适不适合买。**

## 技术栈

| 层 | 选型 |
|---|---|
| 前端 | Vue 3 · Vite · TypeScript · Pinia · Vant 4 · ECharts · vite-plugin-pwa |
| 后端 | FastAPI · Python 3.12+ |
| 数据分析 | Pandas · NumPy · Pandas-TA |
| 数据源 | 天天基金公开接口 > AKShare > Tushare（可选） |
| 存储 | SQLite（后端）· IndexedDB（前端） |

## V1 功能

1. **基金筛选** —— 股票/混合/指数/ETF联接；按类型、成立时间、规模、费率、经理任期筛选
2. **基金评分** —— 0–100 综合评分（收益 40% / 风险 30% / 管理 20% / 成本 10%），输出五星评级与同类排名
3. **自选基金池** —— 添加/删除/收藏，展示净值、涨跌、评分、买卖信号
4. **基金对比** —— 2–3 只横向对比（收益率/回撤/波动率/夏普/规模/经理）
5. **择时系统** —— 估值（PE/PB 百分位）+ 趋势（MA20/60/120）+ 情绪（RSI）三层信号，合成「买入 / 定投 / 持有 / 减仓」
6. **PWA** —— 手机/桌面安装、离线访问、本地缓存

## 页面

首页（市场温度 + 择时信号 + 推荐 TOP10）· 选基页 · 自选页 · 基金详情页 · 对比页

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/funds` | 基金列表 / 筛选 |
| GET | `/api/fund/{code}` | 基金详情 |
| GET | `/api/fund/{code}/score` | 基金评分 |
| GET | `/api/fund/{code}/signal` | 择时信号 |
| GET / POST / DELETE | `/api/watchlist` | 自选基金 |

## 目录结构

```
fund-compass/
├── frontend/        # Vue 3 + Vite PWA
│   └── src/         # pages / components / stores / api / utils
├── backend/         # FastAPI
│   ├── service/     # 数据源、抓取
│   ├── strategy/    # 评分、择时算法
│   ├── models/      # 数据模型
│   └── database/    # SQLite
├── docs/            # 需求规格、路线图
└── README.md
```

## 部署

- 前端：GitHub Pages（GitHub Actions 自动部署）
- 后端：Render / Railway（含 `render.yaml`、`backend/Dockerfile`、`Procfile`）
- 数据库：SQLite（无需额外服务器）

完整步骤（部署后端 + 配置 `VITE_API_BASE` 让线上接通）见 [docs/DEPLOY.md](./docs/DEPLOY.md)。

## 开发进度

分阶段路线图见 [docs/ROADMAP.md](./docs/ROADMAP.md)；原始需求规格见 [docs/FundSelect-PWA.docx](./docs/FundSelect-PWA.docx)。

本地 `D:\AI项目\fund-compass` 已关联远端 [AureliusWu/fund-compass](https://github.com/AureliusWu/fund-compass)，提交后 `git push` 即同步。

## 风险提示

本项目仅供个人学习与投资辅助使用。所有评分、信号和分析结果均基于历史数据计算，不构成任何投资建议。投资有风险，决策需谨慎。
