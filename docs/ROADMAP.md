# FundSelect-PWA 实施路线图

分阶段交付，每阶段都能独立验收、可演示。原始需求见 [FundSelect-PWA.docx](./FundSelect-PWA.docx)。

> 原则：先走通骨架再填功能；后端算法与前端展示解耦；每阶段结束都能 `git push` 部署一个可见版本。

---

## M0 · 脚手架 / 走通骨架

搭起能跑、能部署的空架子，确认前后端与部署链路通畅。

- monorepo：`frontend/`（Vue 3 + Vite + TS + Pinia + Vant 4 + vite-plugin-pwa）、`backend/`（FastAPI）、`docs/`
- 前端：路由 + 底部 Tabbar（Vant）+ 五个空页面（首页 / 选基 / 自选 / 详情 / 对比）
- 后端：`GET /api/health`
- 部署：前端 GitHub Pages（Actions 自动部署），后端先本地 `uvicorn`

**验收**：前端 `npm run dev`、后端 `uvicorn` 都能起；线上能打开空壳 PWA。

## M1 · 数据层 & 基础 API

打通数据源与缓存，拿到真实基金数据。

- 数据源接入：天天基金公开接口（主）+ AKShare（备）；抓取与本地缓存策略
- SQLite 模型：基金基本信息、历史净值、基金经理
- API：`GET /api/funds`（列表 + 筛选）、`GET /api/fund/{code}`（详情）

**验收**：能取到真实基金列表与详情，筛选条件（类型/规模/费率/成立时间/经理任期）生效。

## M2 · 基金评分系统

晨星思想的 0–100 综合评分。

- 指标计算（Pandas/NumPy）：近 1/3 年收益、同类排名、最大回撤、波动率、夏普、费率、经理任期
- 权重：收益 40% / 风险 30% / 管理 20% / 成本 10%
- 输出：综合评分 + 五星评级 + 同类排名
- API：`GET /api/fund/{code}/score`

**验收**：评分可解释、同类排名合理。

## M3 · 择时系统

三层信号模型 → 买卖建议。

- 估值层：PE / PB 百分位 → 低估 / 合理 / 高估
- 趋势层：MA20 / MA60 / MA120 → 上升 / 横盘 / 下降
- 情绪层：RSI → 超卖 / 中性 / 超买（Pandas-TA）
- 信号合成：买入 / 定投 / 持有 / 减仓
- API：`GET /api/fund/{code}/signal`

**验收**：信号合理且可回溯解释每一层依据。

## M4 · 前端功能页

五个页面接真实数据贯通。

- 首页：市场温度 + 当前择时信号 + 推荐 TOP10
- 选基页：条件筛选 + 排名列表（名称 / 评分 / 五星）
- 自选页：自选列表 + 买卖信号 + 涨跌；`GET/POST/DELETE /api/watchlist`
- 详情页：基本信息 + 净值走势 + 收益曲线 + 风险指标 + 评分明细 + 当前信号（ECharts）
- 对比页：2–3 只基金横向比较（收益率/回撤/波动率/夏普/规模/经理）
- 前端架构：Pinia stores、api 封装、IndexedDB 缓存

**验收**：五页功能在真实数据下全部贯通。

## M5 · PWA & 部署收尾

- vite-plugin-pwa：manifest + Service Worker + 离线访问 + 本地缓存 + 安装
- 部署：前端 GitHub Pages（Actions）、后端 Railway / Render、数据库 SQLite

**验收**：可手机/桌面安装、离线可用、线上端到端完整。

---

## V2（暂不开发，V1 稳定后再议）

回测系统 · 基金组合分析 · 定投计算器 · 消息推送 · AI 基金解读 · 多账户资产管理

## 风险提示

仅供个人学习与投资辅助。所有评分、信号、分析均基于历史数据，不构成投资建议。投资有风险，决策需谨慎。
