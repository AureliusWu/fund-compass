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

- [~] **前端单测**：引入 vitest，接入 CI。首批已覆盖 `format` + `dca`（28 用例，✅ 2026-06-29）；剩余 `estimate` / `screener` / `attribution` / `lookthrough` 等留后续补齐。
  - 价值高·工作量中。验收：关键计算函数有测试，CI 跑前端单测。
- [x] **可观测性**（✅ 2026-06-29）：eastmoney/repo/main 的静默吞错改结构化 `logging`——主源降级、退陈旧缓存、启动导入失败均可见，字段级容错保持静默不刷屏。
  - 价值中·工作量小。验收：数据源异常/降级在日志可见，便于线上定位。
- [x] **数据源健壮性**（✅ 2026-06-29）：`eastmoney.source_health()` 进程内统计主源成功/失败/失败率/最近错误/疑似降级（degraded），经 `/api/health` 暴露。
  - 价值中·工作量中。验收：主源解析异常能被发现，不再「无声失准」。
  - 注：进程内计数（重启清零、多 worker 各自独立），单实例部署够用；要跨实例/历史趋势需外部监控。

### P1 · 核心算法准确度

- [~] **V3-5 真实 PE/PB 估值（命门）**：建「基金 ↔ 跟踪指数」映射表，取指数真实 PE/PB 历史分位替换择时估值层现有的「去趋势净值分位」代理；非指数基金优雅降级到代理。**分两步推进：**
  - [~] 步骤1 数据管线（2026-06-29）：`tools/enrich_index_valuation.py`（akshare 取指数 PE/PB → `frontend/public/data/index-valuation.json`）+ `tools/fund_index_map.json` 种子映射 + 接入 `enrich.yml`（首轮 continue-on-error 容错）。**待 CI 跑后据 `[diag]` 日志校准列名/接口，再去掉容错。**
  - [ ] 步骤2 接入：后端按 Pages URL 加载指数估值 JSON，`timing.valuation_layer` 对指数基金用真实分位、非指数降级；前端详情页展示真实分位。
  - 价值高·工作量高（难在免登录的指数估值数据源）。验收：指数基金估值层用真实分位，强趋势长牛被误判高估的问题缓解；回测踏空改善；非指数基金不报错。

### P2 · 功能打磨

- [ ] **V3 落地质量巡检**：对照 [ROADMAP-V3.md](./ROADMAP-V3.md) 逐项核实已落地功能（持仓穿透 / 富集筛选 / NL 选基 / 收益归因 / 多源容灾 / 快照…）的实际质量，补缺口、修边角。
  - 价值中·工作量中。验收：每项功能在真实数据下复核通过。
- [ ] **盘中「按持仓重算估值」（可选）**：基于已有十大重仓（`holdings.ts`）+ 成分股实时行情自建盘中估值，主要补天天基金 `gsz` 缺失的品种（尤其 QDII）。
  - 价值中·工作量中。注意：精度上限受「仅前十大重仓」限制，性价比中等，排在巡检之后。

### P3 · 体验与运维

- [ ] 体验细节：骨架屏 / 下拉刷新 / 错误态优化。
- [ ] 运维可见性：后端健康与定时任务（enrich / estimate-push / notify）运行状态的可观测。

---

## 版本节奏

- 按 ROADMAP 编号推进，每项**可独立验收、可演示**即可交付，不强求固定发布周期。
- 提交走语义化中文 commit；积累若干功能后再在 `frontend/package.json`（前端 5.x）与 `backend/main.py`（API version）统一升版本号。
- 每次合入 `main` 前：后端 `pytest` 全绿 + 前端 `type-check` & `build` 通过（CI 已自动校验）。

---

## 迭代日志（最近在前）

- **2026-06-29**
  - 修复：详情 `source`（primary/fallback）持久化——`fund_detail` 加 `source` 列 + 旧库轻量迁移（`db._migrate`），`repo._save_detail` 写入，缓存命中不再丢失。
  - 优化：`vite.config.ts` 用函数式 `manualChunks` 把 echarts+zrender 拆为独立 vendor chunk，`chunkSizeWarningLimit` 提至 600，消除构建告警。
  - 地基：新增后端 pytest 套件（`backend/tests/`，33 用例，覆盖 scoring/timing/backtest/eastmoney 解析/repo 迁移）+ GitHub Actions CI（`.github/workflows/ci.yml`：后端 pytest + 前端 type-check/build）。
  - 文档：新建 `CLAUDE.md`（AI 方向锚点）与本计划文件。
  - 地基(前端)：引入 vitest，新增 `format` / `dca` 单测（28 用例），接入 CI（`ci.yml` 前端 job 加 `npm run test`）。推进 P0「前端单测」首批落地。
  - 地基(后端)：可观测性——`eastmoney`/`repo`/`main` 静默吞错改结构化 `logging`（主源降级 / 退陈旧缓存 / 启动导入失败可见），加降级日志测试（pytest 34 用例）。完成 P0「可观测性」。
  - 地基(后端)：数据源健壮性——`eastmoney.source_health()` 统计主源成功/失败/失败率/最近错误/degraded，经 `/api/health` 暴露，加 source_health 测试（pytest 35 用例）。完成 P0「数据源健壮性」。**P0 三项全部完成。**
  - 功能(P1/V3-5 步骤1)：指数估值数据管线——新增 `tools/enrich_index_valuation.py`（akshare 取指数 PE/PB 分位）+ `tools/fund_index_map.json` 种子映射 + 接入 `enrich.yml`（首轮容错+诊断打印）。待 CI 验证数据源、校准列名后，步骤2再接入估值层。
