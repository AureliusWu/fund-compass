# AGENTS.md

## 项目识别

- 目录名：`fund-compass`
- 中文名：司南基金
- 用户说「司南基金」时，指本项目。
- 线上形态：前端 PWA + 后端 API 的个人基金选基、择时、持仓分析工具。

## 项目定位

司南基金面向个人投资者，解决「买哪只基金」和「什么时候买/卖」两个问题。它不是机构量化平台，也不做自动交易。所有评分、信号、估值、回测、AI 解读都应保持中立，并明确仅供参考。

## 技术结构

- 前端：Vue 3、Vite、TypeScript、Pinia、Vant 4、ECharts、vite-plugin-pwa。
- 后端：FastAPI、Python 3.12、SQLite。
- `frontend/`：前端页面、组件、状态、工具函数。
- `backend/`：API、数据源、策略算法、SQLite。
- `tools/`：离线补全、估值推送、通知脚本。
- `docs/`：部署、路线图、推送配置、迭代记录。

## 常用命令

```bash
cd frontend
npm run test
npm run type-check
npm run build

cd backend
pytest
uvicorn main:app --reload --port 8000
```

## 核心约定

- 后端运行时保持轻量，不引入 pandas/numpy；算法维持纯 Python。
- 从蜉蝣基金借鉴能力时，在本项目用 TypeScript 和现有结构重新实现。
- 修改估值、回测、评分、收益口径时，必须补/改测试。
- QDII/海外基金要区分「最新公布净值涨跌」和「下一净值估算」。
- 前端直连第三方公开接口时，要接入容灾/源状态机制。
- 不在代码、日志、文档示例中写真实密钥或 Token。

## 项目边界

- `FundVal`（蜉蝣基金）和 `pan`（盘中宝）是纯前端盘中估值工具。
- 本项目负责选基评分、择时信号、资产页、回测实验室、数据故事和体检报告。
