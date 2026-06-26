# Fund Compass V3.3–V3.13 开源方案调研

> 目标：V3-3~V3-13 各功能，先在 GitHub 找可复用的开源实现，避免重复造轮子。
> V3-0 / V3-1 / V3-2 已完成，不在此调研范围。
> ⭐ star 数为 2026-06 检索时的近似值；**许可证务必在采用前再核对一遍**。
> 调研日期：2026-06-26。

## 0. 总体结论（先看这里）

1. **AKShare（`akfamily/akshare`，MIT，~11k★）是中国市场数据的总枢纽**：基金完整持仓、指数 PE/PB
   历史估值、基金排名/评级、行业配置都有现成接口。V3-3 / V3-4 / V3-5 / V3-9 的数据层基本可由它一库解决。
   代价：Python + pandas，需在后端引入一个 pandas/akshare 数据层（当前后端是纯 Python 无 pandas）。
   **建议放进「GitHub Actions 定时富集任务」离线跑，把结果写成 JSON/SQLite 供前端/轻后端读，不进实时请求路径**
   （避免拖累 Render 冷启动）。

2. **西方组合管理 App 多为 copyleft，只能参考架构、不能抄代码进司南**：
   `ghostfolio`(AGPLv3)、`wealthfolio`(AGPLv3)、`maybe`(AGPLv3，**已停止维护**)、`portfolio-performance`(EPL)。
   它们的「多账户数据模型、绩效归因(TWR/MWR)、净值历史」值得学，但直接 copy 会传染许可证。

3. **真正能直接抄/用的是 MIT/BSD/Apache 库**：`ffn`(绩效指标)、`PyPortfolioOpt`/`Riskfolio-Lib`(资产配置优化)、
   `yjs`(本地优先同步)、`vanna`(自然语言→SQL)、`SheetJS`(导出 xlsx)。

4. **有些功能没有「轮子」可抄，本就该自己写**：持仓穿透的聚合逻辑、选基筛选 UI、同类更优排序——
   数据用开源（akshare），业务逻辑自建。

---

## V3-3 · 持仓穿透（Position Look-through）

| 仓库 | URL | ⭐ | 技术栈 | 可复用模块 | 许可证 |
|---|---|---|---|---|---|
| akfamily/akshare | https://github.com/akfamily/akshare | ~11k | Python | `fund_portfolio_hold_em`（基金完整持仓，非仅前十）、`fund_individual_*` | MIT |
| ghostfolio/ghostfolio | https://github.com/ghostfolio/ghostfolio | ~6k | NestJS+Angular+Prisma | 「按 holding/sector 聚合敞口」的展示思路（参考，AGPL 勿抄码） | AGPLv3 |

- **映射司南**：用 akshare 全量持仓替代/补充 V3-2 的天天基金前十大；把自选/持仓里每只基金的成分股
  按权重聚合 → 组合真实个股暴露、行业分布、个股集中度。
- **可复用度**：数据 High（akshare），聚合逻辑无现成轮子、自建（Low）。
- **Copy 优先级**：**High**（数据层直接用 akshare）。

## V3-4 · 选基筛选（Fund Screener）

| 仓库 | URL | ⭐ | 技术栈 | 可复用模块 | 许可证 |
|---|---|---|---|---|---|
| akfamily/akshare | https://github.com/akfamily/akshare | ~11k | Python | `fund_open_fund_rank_em`(排名)、基金评级、规模/费率/收益富集字段 | MIT |
| waditu/tushare | https://github.com/waditu/tushare | ~13k | Python | 基金基本面备源（需积分） | BSD(核对) |

- **映射司南**：定时富集任务把热门基金详情入库（规模/费率/近N年收益/回撤/夏普/经理任期），
  `/api/funds` 支持多维筛选+排序。**筛选 UI 自建**（无通用 JS 选基器可抄）。
- **Copy 优先级**：**High**（数据），UI 自建。

## V3-5 · 真实 PE/PB 估值

| 仓库 | URL | ⭐ | 技术栈 | 可复用模块 | 许可证 |
|---|---|---|---|---|---|
| akfamily/akshare | https://github.com/akfamily/akshare | ~11k | Python | `index_value_name_funddb`、`stock_index_pe_lg`、`stock_a_indicator_lg`（乐咕乐股指数 PE/PB 历史） | MIT |

- **映射司南**：指数基金 → 跟踪指数（沪深300/中证500/中证白酒…）→ 取指数 PE/PB 历史分位，
  替换当前 timing 的「净值分位代理」，直接修掉强趋势长牛被误判高估的命门。需维护一张「基金↔指数」映射表。
- **Copy 优先级**：**High**（数据即核心；映射表自建）。

## V3-6 · 自然语言选基

| 仓库 | URL | ⭐ | 技术栈 | 可复用模块 | 许可证 |
|---|---|---|---|---|---|
| vanna-ai/vanna | https://github.com/vanna-ai/vanna | ~13k | Python | Text-to-SQL（RAG + LLM）：自然语言→SQL 查 V3-4 的基金库 | MIT |

- **映射司南**：若 V3-4 把基金放进 SQL，vanna 可把「近三年年化>15%、回撤<20%、规模>50亿的混合基金」转 SQL。
  **更轻方案**：直接用 Claude function-calling 把自然语言映射到我们自定义的筛选 schema（复用 V2-5 的 key 开关，零新依赖）。
- **Copy 优先级**：**Medium**（vanna 可选；优先走 function-calling）。

## V3-7 · 同类更优推荐

- **无现成轮子**，本就该自建：在 V3-4 富集库里按「同类型 + 评分更高 + 费率更低 + 回撤更小」排序取 Top N。
- 参考：`ghostfolio` 的对比视图交互（AGPL，参考勿抄）。
- **Copy 优先级**：**Low**（建立在 V3-4 之上，纯业务逻辑）。

## V3-8 · 绩效归因（Performance Attribution）

| 仓库 | URL | ⭐ | 技术栈 | 可复用模块 | 许可证 |
|---|---|---|---|---|---|
| pmorissette/ffn | https://github.com/pmorissette/ffn | ~2k | Python | TWR、最大回撤、夏普、CAGR 等指标**公式**（MIT 可直接搬） | MIT |
| pmorissette/bt | https://github.com/pmorissette/bt | ~2.3k | Python | 组合回测框架（可参考） | MIT |
| braverock/PerformanceAnalytics | https://github.com/braverock/PerformanceAnalytics | ~- | R | 归因/风险数学**参考**（GPL，抄公式不抄码） | GPL |
| ghostfolio/ghostfolio | https://github.com/ghostfolio/ghostfolio | ~6k | TS | TWR/MWR 实现参考（AGPL，参考） | AGPLv3 |

- **映射司南**：今日/本月收益拆解到每只基金、每个账户贡献度；时间加权收益(TWR)、Modified Dietz。
  公式标准化，**从 ffn(MIT) 搬实现最干净**。
- **Copy 优先级**：**Medium-High**（ffn 公式 MIT 友好）。

## V3-9 · 多源容灾

- **AKShare 本身就是多源聚合**；容灾本质是「主源失败→备源」的 fallback 链——司南在 indices.ts/holdings.ts/estimate.ts
  已经在用这个模式（gtimg / push2 / 多 secid 兜底）。无需引第三方库。
- 参考：`akshare` 各 source 模块的降级写法。
- **Copy 优先级**：**Low**（模式自建；若后端采用 akshare 抽象则 High）。

## V3-10 · 组合历史净值曲线

| 仓库 | URL | ⭐ | 技术栈 | 可复用模块 | 许可证 |
|---|---|---|---|---|---|
| apache/echarts | （已是司南依赖） | ~62k | JS | 时间序列折线/面积图 | Apache-2.0 |
| pmorissette/ffn | https://github.com/pmorissette/ffn | ~2k | Python | 净值序列统计（CAGR/波动/回撤） | MIT |
| ghostfolio/ghostfolio | https://github.com/ghostfolio/ghostfolio | ~6k | TS | 每日快照 schema 参考（AGPL） | AGPLv3 |

- **映射司南**：每日存一次组合总资产快照（localStorage/Gist），echarts 画曲线。快照逻辑自建。
- **Copy 优先级**：**Low-Medium**（图表用已有 echarts；快照自建）。

## V3-11 · 体验工程（暗黑模式 / 导出）

| 仓库 | URL | ⭐ | 技术栈 | 可复用模块 | 许可证 |
|---|---|---|---|---|---|
| youzan/vant | （已是司南依赖） | ~24k | Vue | **内置暗黑主题** `ConfigProvider theme="dark"`，零新依赖 | MIT |
| SheetJS/sheetjs | https://github.com/SheetJS/sheetjs | ~36k | JS | `XLSX.utils` 导出 Excel/CSV | Apache-2.0 |
| bubkoo/html-to-image | （V3-1 已用） | ~6k | JS | DOM→PNG（已集成） | MIT |

- **映射司南**：暗黑模式直接用 Vant ConfigProvider（drop-in）；自选/资产导出 xlsx 用 SheetJS。
- **Copy 优先级**：**High**（全是 drop-in）。

## V3-12 · 多账户同步

| 仓库 | URL | ⭐ | 技术栈 | 可复用模块 | 许可证 |
|---|---|---|---|---|---|
| yjs/yjs | https://github.com/yjs/yjs | ~17k | JS | CRDT（`Y.Map`/`Y.Array`）无冲突合并，本地优先同步 | MIT |
| automerge/automerge | https://github.com/automerge/automerge | ~3k | JS/Rust | CRDT + Git 式变更历史 | MIT |
| ghostfolio / wealthfolio | 见上 | - | - | 多账户数据模型参考（AGPL，勿抄码） | AGPLv3 |

- **映射司南**：当前 Gist + `updated_at` 后写赢，对「你+朋友各自账号」这种个人规模**已经够用**。
  若将来要多人实时协作，再升级到 yjs（MIT）做无冲突合并。复合键 `账户|code` 迁移仍是自建。
- **Copy 优先级**：**Medium**（yjs 可选升级；现阶段不必引）。

## V3-13 · 大类资产配置

| 仓库 | URL | ⭐ | 技术栈 | 可复用模块 | 许可证 |
|---|---|---|---|---|---|
| robertmartin8/PyPortfolioOpt | https://github.com/robertmartin8/PyPortfolioOpt | 5.2k | Python | 有效前沿、Black-Litterman、HRP、`DiscreteAllocation` | MIT |
| dcajasn/Riskfolio-Lib | https://github.com/dcajasn/Riskfolio-Lib | ~3k | Python | 风险平价/更多配置模型 | BSD-3(核对) |
| pmorissette/ffn | https://github.com/pmorissette/ffn | ~2k | Python | `calc_erc_weights` 风险平价权重 | MIT |

- **映射司南**：展示当前大类配置(简单)→可选「建议配置」(PyPortfolioOpt 优化)。对个人记账，先做「当前配置可视化」，
  优化是进阶（可能过度设计）。
- **Copy 优先级**：**Medium**（PyPortfolioOpt 强但可能 overkill；先做可视化）。

---

## 一、Top 20 值得 clone 的仓库

| # | 仓库 | ⭐ | 许可证 | 用途 |
|---|---|---|---|---|
| 1 | akfamily/akshare | ~11k | MIT | **中国市场数据总枢纽**（V3-3/4/5/9） |
| 2 | robertmartin8/PyPortfolioOpt | 5.2k | MIT | 资产配置优化（V3-13） |
| 3 | pmorissette/ffn | ~2k | MIT | 绩效指标公式（V3-8/10） |
| 4 | pmorissette/bt | ~2.3k | MIT | 组合回测参考 |
| 5 | SheetJS/sheetjs | ~36k | Apache-2.0 | 导出 xlsx（V3-11） |
| 6 | yjs/yjs | ~17k | MIT | 本地优先同步（V3-12，可选） |
| 7 | vanna-ai/vanna | ~13k | MIT | 自然语言→SQL（V3-6） |
| 8 | dcajasn/Riskfolio-Lib | ~3k | BSD-3 | 风险平价配置（V3-13） |
| 9 | ghostfolio/ghostfolio | ~6k | AGPLv3 | 多账户/归因**架构参考** |
| 10 | wealthfolio/wealthfolio | 5.1k | AGPLv3 | 本地优先记账**架构参考** |
| 11 | portfolio-performance/portfolio | ~3.9k | EPL | 绩效/风险计算**参考** |
| 12 | maybe-finance/maybe | ~36k(停维护) | AGPLv3 | 个人理财数据模型参考 |
| 13 | braverock/PortfolioAnalytics | - | GPL | 组合优化数学参考 |
| 14 | braverock/PerformanceAnalytics | - | GPL | 归因/风险数学参考 |
| 15 | waditu/tushare | ~13k | BSD(核对) | 基金数据备源（V3-9） |
| 16 | automerge/automerge | ~3k | MIT | CRDT 同步（V3-12 备选） |
| 17 | bubkoo/html-to-image | ~6k | MIT | DOM→图片（V3-1 已用，导出复用） |
| 18 | youzan/vant | ~24k | MIT | 暗黑主题（已依赖） |
| 19 | apache/echarts | ~62k | Apache-2.0 | 历史曲线（已依赖） |
| 20 | wilsonfreitas/awesome-quant | ~20k | - | 量化资源清单（持续发现新轮子） |

## 二、Top 10 可直接「抄/用」的模块（许可证友好优先）

1. **akshare `fund_portfolio_hold_em`** — 基金完整持仓（V3-3 穿透）。MIT。
2. **akshare `stock_index_pe_lg` / `index_value_name_funddb`** — 指数 PE/PB 历史分位（V3-5）。MIT。
3. **akshare `fund_open_fund_rank_em` + 评级/规模/费率** — 选基富集字段（V3-4）。MIT。
4. **ffn 绩效指标公式**（TWR/最大回撤/夏普/CAGR）— V3-8/10。MIT，可直接移植成纯 TS/Python。
5. **PyPortfolioOpt `EfficientFrontier` / `HRPOpt` / `DiscreteAllocation`** — V3-13 配置优化。MIT。
6. **SheetJS `XLSX.utils.json_to_sheet` + `writeFile`** — V3-11 导出。Apache-2.0，前端 drop-in。
7. **Vant `ConfigProvider theme="dark"`** — V3-11 暗黑（配置非 copy，零新依赖）。
8. **yjs `Y.Map`/`Y.Array` + provider** — V3-12 升级到无冲突同步时再用。MIT。
9. **vanna 的 prompt/RAG 结构** 或 **Claude function-calling schema** — V3-6 自然语言选基。MIT。
10. **PerformanceAnalytics 的归因公式（Modified Dietz / TWR）** — 抄数学不抄码（GPL）。

## 三、开发顺序建议（按依赖与「价值÷工作量」）

1. **先搭数据地基**：把 **akshare 富集任务**（GitHub Actions 离线跑 → JSON/SQLite）作为 V3-4 的底座，
   它同时解锁 V3-5（指数估值）、V3-3（全量持仓穿透）、V3-7（同类更优依赖富集库）。**这是 V3 的关键路径。**
2. **顺手低成本**：V3-11（暗黑 Vant 内置 + SheetJS 导出，drop-in）任何时候插空做。
3. **V3-3 持仓穿透**：在 V3-2 基础上，用 akshare 全量持仓做组合聚合。
4. **V3-5 真实 PE/PB**：富集任务里加指数估值 + 基金↔指数映射表，升级 timing 估值层。
5. **V3-8 收益归因**：搬 ffn 公式（MIT），资产页做今日/本月归因。
6. **V3-6 自然语言选基**：优先 Claude function-calling（轻），vanna 备选。
7. **V3-7 同类更优**：纯排序，建立在富集库上。
8. **V3-10 历史曲线 / V3-12 跨账户 / V3-13 配置**：收尾；同步现阶段用 Gist 时间戳合并即可，yjs 留作升级；
   配置先做可视化、PyPortfolioOpt 优化作进阶。

> 许可证红线：**AGPL/GPL/EPL 仓库（ghostfolio / wealthfolio / maybe / portfolio-performance / R 系）只参考架构与公式，
> 不把其源码 copy 进司南**（司南若想保持宽松许可）。要 copy 代码只从 MIT/BSD/Apache 仓库（akshare / ffn /
> PyPortfolioOpt / SheetJS / yjs / vanna）。

## 来源
- [akfamily/akshare](https://github.com/akfamily/akshare)
- [ghostfolio/ghostfolio](https://github.com/ghostfolio/ghostfolio)
- [maybe-finance/maybe](https://github.com/maybe-finance/maybe)
- [robertmartin8/PyPortfolioOpt](https://github.com/robertmartin8/PyPortfolioOpt)
- [portfolio-performance/portfolio](https://github.com/portfolio-performance/portfolio)
- [wealthfolio/wealthfolio](https://github.com/wealthfolio/wealthfolio)
- [braverock/PortfolioAnalytics](https://github.com/braverock/PortfolioAnalytics) · [pmorissette/ffn](https://github.com/pmorissette/ffn)
- [yjs/yjs](https://github.com/yjs/yjs) · [automerge/automerge](https://github.com/automerge/automerge)
- [vanna-ai/vanna](https://github.com/vanna-ai/vanna) · [SheetJS/sheetjs](https://github.com/SheetJS/sheetjs)
- [wilsonfreitas/awesome-quant](https://github.com/wilsonfreitas/awesome-quant)
