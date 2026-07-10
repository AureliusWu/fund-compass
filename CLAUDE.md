# 司南基金 · AI 协作指南

## 项目锚点

- 中文名：司南基金
- 目录名：`fund-compass`
- 类型：Vue/FastAPI 基金选基、择时、资产分析 PWA

用户说「司南基金」时，优先定位到本仓库。

## 铁律

1. 定位是个人投资辅助，不做自动交易，不做机构级量化。
2. 评分、信号、估值、回测、AI 解读必须中立表达并保留风险提示。
3. 后端运行时保持轻量，不引入 pandas/numpy 等重依赖。
4. 从蜉蝣基金或盘中宝借鉴能力时，在本项目用 TypeScript/现有结构实现。
5. 不在代码、日志或文档示例中写真实密钥、Token、私有 URL。
6. 用户明确要求推送时才 `git push`；否则先说明提交状态。
7. 主导航保持首页、选基、自选三项；隐藏的资产、对比和高级实验能力保留，不扩张也不删除。
8. 严重过期的数据不得继续展示貌似精确的估值百分比。

## 关键文件

- `frontend/src/utils/estimate.ts`：盘中估值、海外模型、最新净值涨跌口径。
- `frontend/src/utils/presentation.ts`：主导航、自选区域、数据新鲜度、可信度与决策摘要的展示契约。
- `frontend/src/pages/WatchlistPage.vue`：自选与持仓展示。
- `frontend/src/pages/AssetsPage.vue`：资产与组合口径。
- `backend/strategy/`：评分、择时、回测、指数估值。
- `tools/estimate_push.py`：定时推送脚本。
- `tools/overseas_accuracy.py`：海外估值每日预测落账与精确净值日期结算。
- `.github/workflows/overseas-accuracy.yml`：独立于推送任务的海外精度流水线。
- `docs/ITERATION-PLAN.md`：长期计划与迭代日志。

## 估值口径

QDII/海外基金必须区分：

- 最新公布净值涨跌：用于主显示、排序、今日盈亏。
- 下一净值模型估算：用于辅助说明，不冒充官方净值。
- 海外模型估算：必须带净值基准日、行情覆盖率、样本状态和可用时的 P80 误差区间。
- 预测记录只能由同一净值归属日结算；`observed_only` 历史复盘不进入训练。
- 训练样本少于 20 条时只收集证据，不自动晋级 Challenger。

修改估值或收益口径时，至少更新 `frontend/src/utils/estimate.test.ts`、`frontend/src/utils/presentation.test.ts` 或对应后端账本测试。

## 自检

```bash
cd frontend
npm run test
npm run type-check
npm run build

cd backend
pytest
```

如果只改文档，可不跑全量测试，但要说明未运行测试。
