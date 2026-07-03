# AGENTS.md

## 项目识别

- 目录名：`fund-compass`
- 中文名：司南基金
- 当用户说「司南基金」时，指的就是本项目：`fund-compass`
- 线上形态：前端 PWA + 后端 API 的个人基金选基、择时、持仓分析工具

## 项目定位

司南基金面向个人投资者，解决“买哪只基金”和“什么时候买/卖”两个问题。它不是机构量化平台，也不做自动交易。所有评分、信号、估值、回测和 AI 解读都应保持中立表达，并明确仅供参考。

## 技术与结构

- 前端：Vue 3、Vite、TypeScript、Pinia、Vant 4、ECharts、vite-plugin-pwa。
- 后端：FastAPI、Python 3.12、SQLite。
- 前端目录：`frontend/`
- 后端目录：`backend/`
- 策略算法：`backend/strategy/`
- 数据抓取：`backend/service/`
- 离线脚本与定时任务：`tools/`
- 文档：`docs/`

## 常用命令

```bash
# 后端
cd backend
pytest
uvicorn main:app --reload --port 8000

# 前端
cd frontend
npm run test
npm run type-check
npm run build
```

## 核心约定

- 后端运行时保持轻量：不要引入 pandas/numpy 等重依赖；评分、风险、择时、回测维持纯 Python 实现。
- 从蜉蝣基金借鉴的能力，要在本项目用 TypeScript/项目现有结构重新实现，不直接修改或复制依赖 `FundVal` 文件。
- 前端直连第三方公开接口时，要接入现有容灾/源状态机制，避免静默失败。
- QDII/海外基金要区分“最新公布净值涨跌”和“下一净值估算”，不要把海外模型估值冒充当天最新净值涨跌。
- 修改算法、估值、回测、持仓收益口径时，必须补充或更新对应测试。
- 不在代码、日志、文档示例中写真实密钥、Token 或私有配置。

## 数据与部署

- 基金数据主要来自天天基金/东方财富公开接口。
- 前端部署到 GitHub Pages。
- 后端部署目标为 Render/Railway，配置见 `render.yaml`、`backend/Dockerfile` 和部署文档。
- 定时估值推送与离线补全逻辑在 `tools/` 和 `.github/workflows/` 下。

## 项目边界

- 不要把本项目与 `FundVal`（蜉蝣基金）或 `pan`（盘中宝）混淆：那两个是纯前端盘中估值工具。
- 本项目才负责选基评分、择时信号、资产页、回测实验室、数据故事和体检报告。
