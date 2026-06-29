# 司南基金 · AI 协作指南

> 本文件每次会话自动加载，是所有 AI 的**方向锚点**。动手前先读这里，再看 [docs/ITERATION-PLAN.md](./docs/ITERATION-PLAN.md) 的「下一步队列」挑任务。

## 这是什么

面向个人投资者的轻量级基金分析 PWA，解决两件事：**选基**（买哪只）+ **择时**（何时买卖）。
前端 Vue3+Vite+TS+Vant+ECharts（部署 GitHub Pages），后端 FastAPI+SQLite（评分/择时/回测纯 Python 实现）。
完整产品说明与 API 见 [README.md](./README.md)。

## 铁律（不可违背）

1. **定位**：个人辅助工具。**不做**机构级量化、自动交易、复杂宏观预测。措辞中立，凡信号/评分都附免责声明。
2. **不碰 FundVal**：移植自蜉蝣基金（FundVal）的功能一律在本项目用 TS **全新复刻**，绝不修改 FundVal 任何文件。
3. **后端零重依赖**：运行时只用 `fastapi`/`uvicorn`/`requests`，分析算法纯 Python 实现，不引入 pandas/numpy。测试依赖单列 `requirements-dev.txt`。
4. **安全**：不在代码注释或日志输出任何密钥/token；改认证相关代码先提示安全影响。
5. **提交**：语义化中文 commit（`feat`/`fix`/`test`/`chore`/`docs`）；**不自动 `git push`**，提交与推送都等用户确认。

## 当前状态（2026-06）

- **V1（M0–M5）、V2（V2-0~V2-7）已上线**；**V3** 功能多数已落地（详见 [docs/ROADMAP-V3.md](./docs/ROADMAP-V3.md)）。
- **已知最大功能缺口**：V3-5「真实 PE/PB 估值」未做——择时估值层目前仍是「去趋势净值分位」代理（见 `backend/strategy/timing.py` 顶部注释）。这是路线图自标的「命门」。
- **工程地基**：后端已有 pytest 单测 + GitHub Actions CI（`ci.yml`）；前端尚无单测（仅 type-check + build 把关）。

## 每日迭代工作流

1. **定方向**：读本文件 → 看 [docs/ITERATION-PLAN.md](./docs/ITERATION-PLAN.md) 顶部「下一步队列」，挑最上面一项（已按 价值÷工作量 排好；工程债/地基优先于新功能）。
2. **实现**：遵守上面铁律。新功能优先复用现有 utils/strategy，不重复造轮子。
3. **自测（硬性门槛，必须全绿才算完成）**：
   - 后端：`cd backend && pytest`
   - 前端：`cd frontend && npm run type-check && npm run build`
   - 动了算法或数据逻辑 → 必须补/改对应单测。
4. **验收**：对照该任务在 ROADMAP / ITERATION-PLAN 里的「验收」标准自检。
5. **收尾**：更新 ITERATION-PLAN（勾掉完成项 + 在「迭代日志」记一行）；按语义化规范提交，等用户确认推送。

## 本地启动 & 测试

```bash
# 后端（建议 Python 3.12，见 backend/runtime.txt）
cd backend
python -m venv .venv && .venv\Scripts\activate          # Windows
pip install -r requirements.txt -r requirements-dev.txt
uvicorn main:app --reload --port 8000                    # 首次启动自动抓全量基金入库
pytest                                                    # 跑测试

# 前端（端口 5173，/api 代理到 8000）
cd frontend
npm install
npm run dev
npm run type-check && npm run build                      # 提交前自检
```

## 文档地图

| 文件 | 用途 |
|---|---|
| [README.md](./README.md) | 产品总览、功能、API、部署 |
| [docs/ITERATION-PLAN.md](./docs/ITERATION-PLAN.md) | **长期滚动计划 + 下一步队列 + 迭代日志（每天更新）** |
| [docs/ROADMAP.md](./docs/ROADMAP.md) / [ROADMAP-V2](./docs/ROADMAP-V2.md) / [ROADMAP-V3](./docs/ROADMAP-V3.md) | 分阶段功能清单（backlog 来源） |
| [docs/DEPLOY.md](./docs/DEPLOY.md) / [docs/PUSH-SETUP.md](./docs/PUSH-SETUP.md) | 部署与定时推送配置 |
