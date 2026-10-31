# 司南基金 (fund-compass)

<!-- project-badges:start -->
[![Version](https://img.shields.io/github/v/tag/AureliusWu/fund-compass?sort=semver&style=flat-square&label=version)](https://github.com/AureliusWu/fund-compass/tags) [![Build](https://github.com/AureliusWu/fund-compass/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/AureliusWu/fund-compass/actions/workflows/ci.yml) [![Last commit](https://img.shields.io/github/last-commit/AureliusWu/fund-compass?style=flat-square)](https://github.com/AureliusWu/fund-compass/commits/main)
<!-- project-badges:end -->

当前版本：`8.0.0`。v9 仍是候选开发线，未正式发布。

个人基金选基、择时与持仓分析 PWA，核心回答“买哪只”和“什么时候买 / 持有 / 减仓”。所有评分、信号、估值、回测和 AI 解读仅供参考，不做自动交易。

## 核心能力

- 基金筛选、评分、对比、回测和同类分析。
- 估值、趋势、情绪、动量与证据强度驱动的择时信号。
- 自选、持仓、组合诊断、再平衡与跨账户资产视图。
- QDII / 海外估值与逐日误差账本，区分正式净值和模型估算。
- Vue 3 PWA + FastAPI 后端；GitHub Pages、Render / Railway 与 Cloudflare Worker 组成部署链。
- 私人 Owner 数据、运维权限和模型晋级保持独立鉴权与审计边界。

## 本地开发

```bash
# 后端
cd backend
pip install -r requirements.txt -r requirements-dev.txt
pytest
uvicorn main:app --reload --port 8000

# 前端
cd frontend
npm ci
npm run test
npm run type-check
npm run build
```

## AI / 维护者入口

修改前先读 [AGENTS.md](AGENTS.md)。复杂数据语义、Owner 会话、持久化、估值与发布门禁以该文件和对应 `docs/` 为准。

- `当前版本：x.y.z` 是作品集同步会读取的机器入口，请保留该格式。
- 部署：`docs/DEPLOY.md`。
- 命名与版本：`docs/NAMING-CONVENTIONS.md`。
- 当前候选执行记录：`docs/V9-EXECUTION-LOG.md`。
- 私人持仓同步边界：`docs/OWNER-PORTFOLIO-FULL-SYNC.md`。
- 历史 Iteration / 验收 / 迁移细节继续留在 `docs/`，不要堆回 README。

README 只描述产品、当前版本和最小开发入口；详细 API、历史功能批次、发布审计和部署流水以代码、`AGENTS.md` 与 `docs/` 为事实源。