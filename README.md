# 司南基金 (fund-compass)

当前版本：`6.0.0`。

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
- **决策卡片（v6.0.0）**：点击基金后由后端实时读取东方财富估值表，结合评分、估值、趋势、动量、回测和持仓状态，明确输出买入 / 分批定投 / 观望或加仓 / 持有 / 减仓 / 卖出，并展示强度、数据时间、风险与结论变化条件。
- **受约束自迭代回测**：单基金训练/留出验证、跨基金聚合门槛、参数版本注册表与自动回滚；只有满足样本数、支持率、超额收益和回撤约束的候选才会晋级。
- **实盘结果闭环（V8）**：决策按动作、置信度、基金类型统计 5/20/60 日命中率、收益、同类超额和回撤，原始决策不可事后改写。
- **证据质量监控（V9）**：海外净值日期状态机、同类基准 leave-one-out、滚动误差分位、账本审计告警与可审计 CSV 导出。
- **组合实验室（V10）**：多基金共同历史回测、风险贡献、有效持仓数、压力情景和受约束再平衡；组合建议按 20/60 日结果留痕。
- **真实证据闭环（V11）**：海外精度任务独立于估值推送，每个交易日先保存当时预测、后按同一净值归属日结算；自选估值行展示净值基准、覆盖率、样本状态和 P80 误差，严重过期的数据不显示伪精确值。
- **可信度与韧性收口（V12）**：统一收益序列口径；评分执行 70% 数据覆盖门槛并展示版本；过期缓存、指数估值和市场温度显式降级；接口具备超时与页面错误恢复；组合回测仅使用共同净值日期。
- **数据身份与交互一致性（V13）**：基金经理使用公开 ID 精确定位在管基金；持仓提醒按稳定事件指纹去重并自动清理旧重复记录；自选估值列使用统一响应式轨道，桌面与移动端保持对齐。
- **温度、评分与建议可信度（Iteration 15）**：温度统一表示拥挤风险；量能结合涨跌方向确认；评分采用几何年化与风险调整指标；择时输出数据覆盖率和证据强度，证据不足时只观察。
- **长期命名与时效一致性（Iteration 16）**：采用 SemVer、Iteration、稳定工作项 ID 和独立优先级；估值新鲜度按交易日判断；决策附带可追溯方法论证据链。
- **实盘验收与生产化收口（Iteration 17）**：写接口分权鉴权、限流和幂等；推送 14:40 自动补偿；模型版本只读比较；基金全集构建期生成；统一运维状态与 Pydantic API 契约。
- 指数 PE/PB 估值分位与净值代理降级。
- 基金对比、回测实验室、体检报告。
- 自选与持仓、跨账户资产、大类配置、持仓穿透。
- QDII/海外基金盘中估值与最新净值涨跌口径区分；018147、012920 等模型保存逐日预测误差，按时间留出验证受控校准，并展示覆盖率、样本量和历史误差区间。
- 首页合并市场与自选温度，系统状态简化为服务/数据/任务三盏灯；主导航仅保留首页、选基、自选，高级分析路由继续保留。
- 数据故事、组合诊断、定投测算、提醒与推送。
- PWA、离线缓存、暗黑模式、导入导出。
- 排行和基金经理静态索引采用清单加分片加载，避免单次解析 2-3 MB JSON 阻塞页面。

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
npm ci
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
- `GET /api/strategy/registry`
- `GET /api/strategy/outcomes`
- `POST /api/portfolio/decisions`
- `POST /api/portfolio/lab`
- `GET /api/strategy/portfolio-outcomes`
- `GET / POST / DELETE /api/watchlist`
- `POST /api/admin/refresh-universe`

## 部署

- 前端：GitHub Pages。
- 后端：Render / Railway。
- 实时决策：前端调用 Render 后端，后端直接请求现行估值源；Service Worker 不缓存 `/api`。
- 14:30 自选决策推送由 Cloudflare Workers Cron 执行；GitHub Actions 的估值/信号任务仅保留手动应急入口。
- GitHub Actions 只承担测试、构建、Pages 部署和持仓/经理/校准等低频离线任务。
- 配置参考：`docs/DEPLOY.md`、`docs/PUSH-SETUP.md`、`render.yaml`。
- 命名规范：`docs/NAMING-CONVENTIONS.md`。

## 项目关系

- `fund-compass`：司南基金，本项目。
- `FundVal`：蜉蝣基金，纯前端基金盘中估值 PWA。
- `pan`：盘中宝，移动端基金盘中估值 PWA。

## 风险提示

所有评分、信号、估值、回测和 AI 解读都基于公开数据与模型计算，仅供个人参考，不构成投资建议。
