# 司南基金 · 长期迭代计划

> 本文件是项目的**单一事实来源**：下一步做什么看这里，做完更新这里。配套阅读 [../CLAUDE.md](../CLAUDE.md)（工作流与铁律）。
> 维护方式：每次迭代——从「下一步队列」取最上面一项，完成后勾掉并在文末「迭代日志」记一行。

## 北极星 & 边界

- **北极星**：让个人用户「每天打开就能快速知道——哪些基金值得关注、当前适不适合买」。
- **边界**：个人辅助、非机构量化、非自动交易、非宏观预测。任何取舍都向「准确、可解释、轻量、中立」靠拢。

## 优先级原则

按 **价值 ÷ 工作量** 排序，且遵循：**工程地基/技术债 ＞ 核心算法准确度 ＞ 新功能 ＞ 体验打磨**。
理由：没有测试网时改算法极易回归；估值/信号「准不准」是产品立身之本，比多一个页面更重要。

---

## 下一步队列（从上往下做）

### P0 · 工程地基与技术债（先做，给后续改动兜底）

- [x] **前端单测**（✅ 2026-07-04）：引入 vitest，接入 CI；已覆盖 `format`、`dca`、`estimate`、`screener`、`attribution`、`lookthrough`，前端单测 52 用例全绿。
  - 价值高·工作量中。验收：关键计算函数有测试，CI 跑前端单测。
- [x] **可观测性**（✅ 2026-06-29）：eastmoney/repo/main 的静默吞错改结构化 `logging`——主源降级、退陈旧缓存、启动导入失败均可见，字段级容错保持静默不刷屏。
  - 价值中·工作量小。验收：数据源异常/降级在日志可见，便于线上定位。
- [x] **数据源健壮性**（✅ 2026-06-29）：`eastmoney.source_health()` 进程内统计主源成功/失败/失败率/最近错误/疑似降级（degraded），经 `/api/health` 暴露。
  - 价值中·工作量中。验收：主源解析异常能被发现，不再「无声失准」。
  - 注：进程内计数（重启清零、多 worker 各自独立），单实例部署够用；要跨实例/历史趋势需外部监控。

### P1 · 核心算法准确度

- [~] **V3-5 真实 PE/PB 估值（命门）**：建「基金 ↔ 跟踪指数」映射表，取指数真实 PE/PB 历史分位替换择时估值层现有的「去趋势净值分位」代理；非指数基金优雅降级到代理。**分两步推进：**
  - [x] 步骤1 数据管线（✅ 2026-06-29，经 4 轮 CI 验证）：`tools/enrich_index_valuation.py` 用乐咕乐股 `stock_index_pe_lg`/`pb_lg`（akshare 1.18.64 已移除 funddb 系列）取 6 个主流宽基（沪深300/上证50/上证180/中证100/中证500/中证1000）市值加权 PE/PB + 自算历史分位 → `index-valuation.json`；`fund_index_map.json` 种子映射；接入 `enrich.yml`（continue-on-error，第三方源不阻断其他富集）。**数据源已验证可用、数值合理。**
  - [x] 步骤2 接入（✅ 2026-06-30）：后端 `strategy/index_valuation.py` 模块导入时加载 `index-valuation.json` + `fund_index_map.json` 到内存；`timing.valuation_layer` 对已映射指数基金优先用 PE 分位（<30 低估/30-70 合理/>70 高估），非指数基金回退去趋势代理（标记 `source: "index_pe_pb"` vs `"nav_detrended"`）；前端详情页/报告页/解读模板展示 PE/PB 数值与指数名。新增 `test_index_valuation.py`（8 用例）+ `test_timing.py` 补 6 用例。后端 pytest 49 全绿，前端 type-check+build 全绿。
  - 价值高·工作量高（难在免登录的指数估值数据源）。验收：指数基金估值层用真实分位，强趋势长牛被误判高估的问题缓解；回测踏空改善；非指数基金不报错。

### P2 · 功能打磨

- [x] **V3 落地质量巡检**（✅ 2026-06-30）：逐项核实 V3-0~V3-10 十大功能。结论：九项完整落地；仅 V3-9 多源容灾有缺口——`resilience.ts` 框架（SWR/熔断/重试）已编写但未注入 `indices.ts`/`holdings.ts`/`estimate.ts` 的实际请求。已修复：在三文件中注入 `recordSource()` 调用，HomePage 源状态点灯现在可真实反映腾讯行情、东方财富、天天基金三源健康度。
- [x] **盘中「按持仓重算估值」**（✅ 2026-07-04）：`estimate.ts` 新增通用十大重仓穿透模型，定向模型缺失时按 `holdings.ts` 的公开持仓把 A股/港股/美股映射到腾讯行情并按占净值比例加权估算；保留 012920/018147 等定向模型优先，报告页同步使用最新净值涨跌/下一净值模型双口径。
  - 价值中·工作量中。注意：精度上限受「仅前十大重仓」限制，性价比中等，排在巡检之后。

### P3 · 体验与运维

- [x] 体验细节（✅ 2026-07-04）：首页 / 自选持仓 / 基金详情接入下拉刷新；自选持仓与基金详情加载态从纯转圈升级为结构化骨架屏；错误态优化——FundDetailPage 加载失败增加「重试」按钮（✅ 2026-06-30）。
- [~] 运维可见性：`/api/health` 新增 `index_valuation` 字段（数据更新时间 + 覆盖指数数）（✅ 2026-06-30）；定时任务运行状态可观测待后续。

---

## 版本节奏

- 按 ROADMAP 编号推进，每项**可独立验收、可演示**即可交付，不强求固定发布周期。
- 提交走语义化中文 commit；积累若干功能后再在 `frontend/package.json`（前端 5.x）与 `backend/main.py`（API version）统一升版本号。
- 每次合入 `main` 前：后端 `pytest` 全绿 + 前端 `type-check` & `build` 通过（CI 已自动校验）。

---

## 迭代日志（最近在前）

- **2026-07-04**
  - 体验(P3)：补齐移动端刷新与加载体验——首页、自选持仓、基金详情接入 `van-pull-refresh`；自选持仓/详情页初次加载改为 `van-skeleton` 骨架屏。前端 `type-check` ✅、`vitest` 55 ✅、`build` ✅。
  - 地基(P0)：补齐前端关键工具函数单测——新增 `screener.test.ts`、`attribution.test.ts`、`lookthrough.test.ts`，覆盖排行缓存/同类更优、收益归因、持仓穿透 enrich/top10/mixed/none 降级口径。前端 vitest 从 37 扩到 52 用例，`npm run test` ✅、`type-check` ✅、`build` ✅。P0「前端单测」收口完成。
  - 功能(P2)：盘中「按持仓重算估值」系统化——新增 `holdingsToOverseasModel`，定向海外模型缺失时自动用公开十大重仓生成穿透模型；支持 A股/港股/美股/韩国代理映射，低于 25% 可用权重时保守降级。报告页同步使用 `preferredDailyMove`，避免海外模型冒充最新净值涨跌。新增 estimate 单测 3 个。
- **2026-06-30**
  - 功能(P1/V3-5 步骤2)：真实 PE/PB 估值接入——新建 `backend/strategy/index_valuation.py` 加载器（模块级缓存、优雅降级）；`timing.valuation_layer` 对已映射指数基金优先用 PE 分位，非指数基金回退去趋势代理（新增 `source` 字段区分）；`timing_signal` 透传 `detail["code"]`。前端 `Layer` 类型扩展 PE/PB 字段，详情页/报告页/解读模板展示真实 PE/PB 与指数名。新增 `test_index_valuation.py`（8 用例）+ `test_timing.py` 补 6 用例（49 全绿）。
  - 巡检(P2/V3 落地质量)：逐项核实 V3-0~V3-10 十大功能——九项完整落地，仅 V3-9 多源容灾有缺口。修复：在 `indices.ts`/`holdings.ts`/`estimate.ts` 注入 `recordSource()` 调用，腾讯行情/东方财富/天天基金三源状态现在真实反映到 HomePage 源状态点灯。
  - 体验(P3)：FundDetailPage 加载失败增加「重试」按钮；`/api/health` 新增 `index_valuation` 数据新鲜度字段。
  - 质量门禁：后端 pytest 49 ✅ · 前端 type-check ✅ · build ✅ · vitest 28 ✅。
- **2026-06-29**
  - 修复：详情 `source`（primary/fallback）持久化——`fund_detail` 加 `source` 列 + 旧库轻量迁移（`db._migrate`），`repo._save_detail` 写入，缓存命中不再丢失。
  - 优化：`vite.config.ts` 用函数式 `manualChunks` 把 echarts+zrender 拆为独立 vendor chunk，`chunkSizeWarningLimit` 提至 600，消除构建告警。
  - 地基：新增后端 pytest 套件（`backend/tests/`，33 用例，覆盖 scoring/timing/backtest/eastmoney 解析/repo 迁移）+ GitHub Actions CI（`.github/workflows/ci.yml`：后端 pytest + 前端 type-check/build）。
  - 文档：新建 `CLAUDE.md`（AI 方向锚点）与本计划文件。
  - 地基(前端)：引入 vitest，新增 `format` / `dca` 单测（28 用例），接入 CI（`ci.yml` 前端 job 加 `npm run test`）。推进 P0「前端单测」首批落地。
  - 地基(后端)：可观测性——`eastmoney`/`repo`/`main` 静默吞错改结构化 `logging`（主源降级 / 退陈旧缓存 / 启动导入失败可见），加降级日志测试（pytest 34 用例）。完成 P0「可观测性」。
  - 地基(后端)：数据源健壮性——`eastmoney.source_health()` 统计主源成功/失败/失败率/最近错误/degraded，经 `/api/health` 暴露，加 source_health 测试（pytest 35 用例）。完成 P0「数据源健壮性」。**P0 三项全部完成。**
  - 功能(P1/V3-5 步骤1)：指数估值数据管线打通——`enrich_index_valuation.py`（乐咕乐股 `stock_index_pe_lg`/`pb_lg`，funddb 已废）+ `fund_index_map.json` + `enrich.yml`。经 4 轮 CI 校准（接口名→symbol 全称→市值加权列），产出 6 个主流宽基真实 PE/PB+历史分位、数值合理。步骤2：后端按 Pages URL 加载、接入 timing 估值层 + 补创业板/科创/海外指数源。
