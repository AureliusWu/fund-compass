# 司南基金迭代交接与代码审查基线

> 生成日期：2026-08-29（Asia/Shanghai）
>
> 审计基线：main / d0772acf4a423946dfcfd22779fd2bc72c76e609
>
> 版本事实：仓库与线上可验证版本仍为 7.0.1；包含 V8 候选实现，但没有 v8 tag，也不满足 V8 发布门禁。
>
> 工作范围：基于当前代码、Git 历史、测试、构建、CI 与公开生产探针进行只读分析；本文件是本轮唯一新增文件。

路径约定：除明确标成“不存在”“外部文件”或“部署生成物”的名称外，文件均相对仓库根目录。为控制表格宽度，模块章节允许继承目录前缀：后端 API 表中的 main.py 指 backend/main.py，前端页面表中的 XPage.vue 指 frontend/src/pages/XPage.vue，前端 utils/components/stores 分别指 frontend/src 下的同名目录，Worker 的 src 指 worker/src，workflow 文件指 .github/workflows。第十九节给出规范完整路径入口。

## 结论先行

- 当前 main 与 origin/main 同步，审计开始时工作树干净；v7.0.1 tag 对应 1bad16256c5677f5f6626a0c3c8e566d090ce5e4，HEAD 比该 tag 多 6 个提交。
- v7 核心的基金详情、评分、择时、回测、选基、自选、估值、PWA 与静态数据任务已经可运行。
- V8 的证据快照、不可变决策、持仓版本、个体结果、通知 claim、行动中心等代码已大体实现，但生产数据库仍是临时 SQLite，Worker 也未部署当前精确 SHA，因此只能称为 V8 候选。
- 当前发布状态是 BLOCKED：Pages 与 Render 已部署 d0772ac；生产 Worker 的 build_sha 为空，最新 CI 33246302147 仅在 Worker exact-build smoke 失败。
- 发布前最严重的代码问题是：公开 V8 读取接口会返回私人持仓/组合资产；第三方 JSONP 在存有 Gist/LLM Key 的页面同源执行；生产数据库不持久；V8 组合结算/展示链未接通。
- 本轮本地实测：后端 383 tests、前端 219 tests、Worker 99 tests 全部通过；前端和 Worker typecheck、前端 build 通过。项目没有 lint 和 coverage 门禁。

---

# 一、项目当前状态

## 1.1 基本信息

| 项目项 | 当前真实状态 | 依据 |
|---|---|---|
| 项目名称 | 司南基金 / fund-compass | README.md、frontend/package.json |
| 当前版本 | 7.0.1 | frontend/package.json、worker/package.json、frontend/src/version.ts、线上 health |
| 版本阶段 | V8 候选代码已并入 main，但未正式发布 | CHANGELOG.md、Git tag、生产 smoke |
| 前端 | Vue 3 + TypeScript + Vite + Pinia + Vue Router + Vant + ECharts | frontend/package.json |
| 形态 | Web + PWA；hash 路由 | frontend/src/router/index.ts、frontend/vite.config.ts |
| 桌面端 | 不存在 Tauri / Electron / 原生桌面壳 | 全仓未发现相应入口或配置 |
| 后端 | FastAPI + Pydantic + Uvicorn + requests | backend/main.py、backend/requirements.txt |
| 数据库 | SQLite，手写 schema/migration，WAL；无 ORM/Alembic | backend/database/db.py |
| 定时运行 | Cloudflare Worker Cron + GitHub Actions 定期数据任务 | worker/wrangler.toml、.github/workflows |
| AI / LLM | 浏览器端 BYOK 单次调用；非 Agent | frontend/src/utils/ai.ts |
| Agent / Tool / MCP | 不存在 Agent loop、Tool Registry、Tool Calling、MCP 或 sandbox | 当前代码无相关实现 |
| 前端部署 | GitHub Pages，由 CI 的 reusable workflow 实际部署 | .github/workflows/deploy.yml |
| 后端部署 | Render Web Service，GitHub 集成部署 | render.yaml |
| Worker 部署 | Cloudflare Worker；必须在干净工作树手工 npm run deploy | worker/scripts/deploy.mjs |
| 主要入口 | frontend/src/main.ts；backend/main.py；worker/src/index.ts | 当前实际启动文件 |
| 本地服务通信 | 浏览器经 HTTPS 调 FastAPI / Worker；不存在桌面 IPC | frontend/src/api/client.ts |

本地审计运行时是 Python 3.14.4、Node 24.14.0、npm 11.9.0；仓库目标/CI 使用 Python 3.12、Node 20（前端）和 Node 22（Worker）。后端 runtime.txt 指定 Python 3.12.7。

## 1.2 能力状态

| 能力 | 状态 | 说明 |
|---|---|---|
| 基金全集、详情与净值历史 | 已实现 | 本地全集启动导入，详情使用 12 小时新鲜缓存和最多 7 天 stale fallback |
| v7 评分、择时、回测、校准 | 已实现 | 前端和 API 均有消费者；仍属于旧策略链 |
| 盘中估值 / 持仓模型 / 正式净值 fallback | 已实现 | Worker 多源解析和前端口径已存在；official_nav 公开 wire contract 仍有歧义 |
| 选基与经理数据 | 已实现 | manifest + 分片 + SHA-256 校验；经理数据缺 freshness UI |
| 自选、跨设备 Gist 同步 | 已实现 | localStorage 为主、Gist 可选；并发覆盖风险尚在 |
| 持仓录入 | 部分实现 | Store 有 setHolding，但生产 UI 没有新建/编辑入口 |
| 资产、穿透、故事 | 部分实现 | 页面和计算存在；新用户入口、缺值语义和覆盖率存在问题 |
| V8 证据/决策/持仓/通知 | 已实现代码，生产未闭环 | 后端快照与 Worker claim 已实现，但持久性和生产 Worker 身份未达标 |
| V8 组合 outcome | 部分实现 | 后端 settle 代码存在；Worker 不调、前端仍读旧接口 |
| Portfolio Lab | 部分实现 / 线上不可用 | 后端要求 Admin，前端未发认证且不能安全下发 Admin Token |
| AI 点评、自然语言选基、故事摘要 | 部分实现 | Provider 多；无超时、重试、streaming、schema 校验和安全隔离 |
| Agent / Tool / MCP | 尚未实现 | 不应把普通 fetch 或 Python 数据脚本称作 Agent Tool |
| 自动交易 | 尚未实现 | 当前只提供分析、决策展示和通知，不执行交易 |
| 旧 v7 决策/结果/通知兼容链 | 已废弃方向但仍在用 | 不能立即删除；人工应急脚本和 Outcomes 页面仍有依赖 |
| akshare 后端备源 | 占位实现 | requirements.txt 只有“后续接入”注释；实际只在离线富集任务使用固定版本 |

## 1.3 当前生产事实

截至 2026-08-29 的公开证据：

- GitHub Pages release.json 与 Render deployment commit 都是 d0772ac。
- Render health：version=7.0.1，基金全集 27,586 且 ready；database.persistence=ephemeral、durable=false。
- 指数估值产物日期为 2026-08-21，age=8 天，超过 7 天门槛；6 个指数、0 个 usable。代码正确 fail-closed，不应通过放宽阈值掩盖。
- Worker health：version=7.0.1，但 build_sha=null；最近运行记录没有 last_cron_build_sha，不能归因于当前源码。
- CI run 33246302147 中三端代码门禁、Pages 部署、静态数据和 Render smoke 均成功；最终仅 Worker 精确构建身份检查失败。
- CI 对 Worker 只执行 wrangler deploy --dry-run；这不是生产部署。
- 旧 Gist 是否已经在 GitHub 真实删除：待确认。仓库和公开 health 不能证明该外部删除动作。

---

# 二、当前项目目录结构

~~~text
fund-compass/
├── .github/workflows/              CI、Pages 部署、发布 smoke、周期数据任务
├── backend/
│   ├── main.py                     FastAPI 装配、全部路由与兼容层
│   ├── database/db.py              SQLite schema、迁移、备份、连接与事务
│   ├── models/
│   │   ├── api.py                  HTTP 请求/响应模型
│   │   └── v8.py                   V8 冻结领域模型、规范 JSON、稳定 ID
│   ├── service/
│   │   ├── eastmoney.py            上游详情/净值/估值代理
│   │   ├── repo.py                 v7 缓存与旧版持久化
│   │   ├── security.py             Admin/Worker Bearer 权限与进程内限流
│   │   ├── overseas_evidence.py    已审计 QDII 证据加载
│   │   ├── v8_decisions.py         V8 决策编排
│   │   └── v8_repo.py              V8 不可变存储、幂等、结果、通知
│   ├── strategy/                   评分、择时、回测、v7/v8 决策和组合逻辑
│   ├── data/                       基金全集、策略参数、V8 基线/海外证据
│   └── tests/                      pytest 单元、存储和函数级契约测试
├── frontend/
│   ├── index.html                  Web 入口
│   ├── vite.config.ts              Pages base、PWA、分块与自动导入
│   ├── src/
│   │   ├── main.ts                 Vue/Pinia/Router 启动
│   │   ├── App.vue                 应用外壳与主导航
│   │   ├── router/index.ts         13 条 hash 路由
│   │   ├── api/client.ts           全部后端 DTO 与 HTTP client
│   │   ├── stores/                 app、funds、watchlist 状态
│   │   ├── pages/                  13 个业务页面
│   │   ├── components/             图表、V8 面板、行动中心
│   │   ├── utils/                  估值、AI、Gist、筛选、资产与导出
│   │   └── data/                   随包海外模型注册表
│   └── public/data/                选基/经理分片、富集、海外审计等静态产物
├── worker/
│   ├── src/index.ts                HTTP 路由、Cron、Gist、决策、通知主链
│   ├── src/valuation.ts            多源估值和持仓模型
│   ├── src/external.ts             外部请求超时/重试/大小边界
│   ├── scripts/deploy.mjs          精确 SHA Worker 部署包装器
│   └── wrangler.toml               Worker 变量与 14:30/14:40 Cron
├── tools/                           离线富集、校准、审计、人工应急脚本
├── docs/                            路线图、部署文档、V8 审计和原型
├── render.yaml                      Render 后端部署配置
├── CHANGELOG.md                     Unreleased / 版本记录
├── README.md                        用户与部署说明，部分内容已与代码漂移
└── AGENTS.md                        仓库协作和验证约束
~~~

目录归类：

- 核心业务代码：backend/service、backend/strategy、backend/models、worker/src、frontend/src/utils。
- UI：frontend/src/pages、frontend/src/components、frontend/src/styles.css。
- API：backend/main.py、frontend/src/api/client.ts、worker/src/index.ts 的 fetch handler。
- 数据库：backend/database/db.py；没有独立 migration 目录。
- AI：frontend/src/utils/ai.ts、interpret.ts、nlselect.ts、story.ts；没有 Agent 目录。
- 工具系统：tools 与 .github/workflows；它们是数据管道/运维脚本，不是 LLM Tool Registry。
- 配置：package files、tsconfig、vite.config、wrangler.toml、render.yaml、pytest.ini。
- 历史遗留：v7 decision/outcome/watchlist API、manual estimate/notify workflow、旧路线图和 legacy 静态大 JSON。
- 未列出 node_modules、dist、.git、缓存、数据库副本、preview 日志和 .wrangler 本地产物；这些不是项目源码。

---

# 三、本轮版本实际完成内容

Git 范围采用 v7.0.1 tag 的 peeled commit 1bad162..HEAD。总计 76 个文件，约 +13,758 / -426；当前 git describe 为 v7.0.1-6-gd0772ac。

## 3.1 V8 后端领域与持久化

### 修改内容

- 新增 EvidenceSnapshot、HoldingVersion、DecisionSnapshot、PortfolioPolicy、个体/组合 Outcome、NotificationEvent 等稳定模型。
- 使用规范 JSON + SHA-256 生成稳定 ID；V8 审计表以触发器禁止 UPDATE/DELETE。
- 新增带 request hash、lease、owner 和响应重放的幂等存储。
- 新增 V8 批量决策、组合快照、策略版本、结果结算、通知事件 API。
- QDII 结果要求精确 target NAV date；组合结果要求共同净值日期且不 forward-fill。

### 涉及文件

backend/models/v8.py、backend/models/api.py、backend/database/db.py、backend/service/v8_repo.py、backend/service/v8_decisions.py、backend/strategy/decision_v2.py、backend/main.py 及对应 test_v8_*.py。

### 修改原因

把一次性建议升级为可追溯、不可变、可评价和可审计的决策链。

### 当前结果

代码和测试已完成主要内核；生产 SQLite 临时存储、公开敏感 DTO、组合调度断链仍阻止发布。

### 是否完成

部分完成（代码约 80%，生产闭环未完成）。

## 3.2 V8 前端行动中心

### 修改内容

- 首页增加 V8 动作汇总。
- 自选增加动作筛选、排序、决策差异和 stale/低置信门禁。
- 详情增加 V8 证据、持仓版本、策略版本、不可变决策与 Outcome 面板。
- 组合实验室不再把缺失目标权重自动均分/归一化，缺失保持 null，总和必须精确为 100%。
- 选基静态产物过期时停止质量筛选、AI 选基和同类推荐。
- 修复自选增量刷新误删其他快照、过期响应回写和 QDII 文案口径。

### 涉及文件

frontend/src/components/HomeActionCenter.vue、homeActionCenter.ts、watchlist/WatchlistDecisionBoard.vue、watchlist/decisionView.ts、FundDetailV8Panel.vue、fundDetailV8Presenter.ts、frontend/src/pages/HomePage.vue、WatchlistPage.vue、FundDetailPage.vue、PortfolioLabPage.vue、ScreenPage.vue、frontend/src/utils/screener.ts、frontend/src/api/client.ts。

### 修改原因

让 V8 后端快照能在用户界面中以“可解释、可降级、不可把未知变 0”的方式被消费。

### 当前结果

三个主要视图已接入，但 Home/Watch/Detail 的 fail-closed 判定不一致；新用户仍没有持仓录入 UI；Portfolio Lab 认证断裂。

### 是否完成

部分完成。

## 3.3 Worker 定时决策与通知审计

### 修改内容

- 14:30 主窗口和 14:40 补偿窗口使用同一 natural request ID 重放不可变批次。
- 定时任务先结算个体 Outcome，再解析估值、调用 V8 组合决策、原子 claim 通知、发 Server酱并记录终态。
- 增加 scheduled / attempted / sent / failed / compensated 事件和 delivery_ambiguous 失败关闭。
- 构建健康信息增加 build_sha、last_cron_build_sha、计划/实际时间与延迟。
- 增加严格响应 schema、外部请求 10 秒超时、2 MB 上限和 GET 一次重试。
- 部署包装器要求干净工作树并注入完整 Git SHA。

### 涉及文件

worker/src/index.ts、worker/src/valuation.ts、worker/src/external.ts、worker/scripts/deploy.mjs、worker/wrangler.toml、worker/src/*.test.ts。

### 修改原因

降低定时推送重复送达、歧义送达和无法追溯部署身份的风险。

### 当前结果

99 个 Worker 测试通过，但生产 Worker 仍是无 build_sha 的旧构建；CI 只 dry-run。

### 是否完成

代码完成，生产发布未完成。

## 3.4 海外估值精度与证据

### 修改内容

- 自动提交逐步把样本数从 9 增至 10，pending 从 1 降至 0。
- 跨日延迟任务只结算，不创建新的错时预测。
- Challenger 模型仍为 collecting，不允许自动晋级。
- 最后一个修复允许“全部预测已结算时 V8 海外证据导出为空”，空 models 不再被误判为失败。

### 涉及文件

tools/overseas_accuracy.py、calibrate_overseas.py、audit_overseas_accuracy.py、export_v8_overseas_evidence.py、frontend/public/data/overseas-accuracy.json、overseas-audit.json、frontend/src/data/overseas-models.json、backend/data/overseas-evidence.json。

### 修改原因

确保 QDII 预测严格按下一正式净值日期结算，模型证据不足时不会冒充可部署信号。

### 当前结果

当前审计无 error；空 V8 模型集合是合法状态。交易日历只覆盖 2025/2026，2027 前必须扩展。

### 是否完成

本轮逻辑完成；长期运维仍需日历更新和更多样本。

## 3.5 发布与版本结果

### 修改内容

CI、Pages release.json、Render deployment 与 smoke 都强化了精确 SHA 证据；V8 主版本还会额外要求 durable database。

### 涉及文件

.github/workflows/ci.yml、deploy.yml、post-deploy-smoke.yml、worker/scripts/deploy.mjs、CHANGELOG.md。

### 修改原因

避免“测试通过”被误写成“生产已发布”。

### 当前结果

Pages/Render 已是 HEAD，Worker exact-build gate 失败；版本仍为 7.0.1 是正确状态。

### 是否完成

未完成发布。不要把当前状态标成 v8.0.0 released。

---

# 四、核心架构说明

## 4.1 运行架构

~~~mermaid
flowchart LR
    U[浏览器 / PWA] -->|Hash Router| V[Vue Pages]
    V --> P[Pinia Stores]
    V --> C[api/client.ts]
    V --> FU[浏览器 utils]
    C -->|HTTPS JSON| A[FastAPI / Render]
    FU -->|估值与持仓| W[Cloudflare Worker]
    FU -->|可选同步| G[GitHub Gist]
    FU -->|BYOK 单次请求| L[LLM Providers]
    FU -->|当前 JSONP| E[腾讯 / 东方财富]
    A --> R[repo / v8_decisions / v8_repo]
    R --> S[strategy v7 + decision_v2]
    R --> D[(SQLite)]
    R --> EM[东方财富公开 API]
    W --> EM
    W --> G
    W -->|V8 决策 / 结算 / 通知事件| A
    W --> SC[Server酱]
    GA[GitHub Actions] --> T[tools 数据脚本]
    T --> SD[版本化静态 JSON / gzip]
    GA --> PG[GitHub Pages]
    SD --> PG
~~~

## 4.2 后端模块关系

~~~mermaid
flowchart TD
    M[backend/main.py 路由] --> SEC[service/security.py]
    M --> REPO[service/repo.py v7]
    M --> VD[service/v8_decisions.py]
    M --> VR[service/v8_repo.py]
    REPO --> EAST[service/eastmoney.py]
    REPO --> DB[database/db.py]
    VD --> EAST
    VD --> OE[service/overseas_evidence.py]
    VD --> DV2[strategy/decision_v2.py]
    VD --> VR
    VR --> DB
    M --> OLD[strategy scoring/timing/backtest/portfolio]
    OLD --> REPO
~~~

main.py 同时承担应用装配、兼容路由和 V8 路由；服务层负责数据获取/编排；strategy 负责纯业务计算；db.py 负责 SQLite 生命周期。没有 ORM、消息队列、独立任务服务或后端 LLM。

## 4.3 状态与数据存储

- 前端 app Store：后端状态和市场温度。
- funds Store：详情/评分/信号/回测/聚合分析，内存 + localStorage 30 分钟缓存。
- watchlist Store：本地自选、复合持仓键、删除墓碑、Gist pull/merge/push。
- PWA：Workbox autoUpdate；API NetworkOnly，静态数据 StaleWhileRevalidate，ECharts/图标 CacheFirst。
- Worker：没有 KV、D1、R2 或 Durable Object；自选和推送状态存 GitHub Gist，整文件 PATCH，无 CAS。
- 后端：SQLite WAL + synchronous NORMAL + busy timeout；写事务使用 BEGIN IMMEDIATE。
- 文件操作：数据工具原子生成静态 JSON/分片/manifest；后端启动读取本地基金全集和策略/证据文件。没有任意用户路径写入 API，也没有 shell/command 执行入口。

## 4.4 权限控制

- 后端 Admin 写：ADMIN_TOKEN。
- 后端 Worker 写：WORKER_TOKEN；部分接口也允许 Admin。
- Token 使用 Bearer，并以安全比较验证。
- 写接口有限流，但限流只在单进程内，重启或多实例不共享。
- 公共读接口没有用户身份隔离；这导致 V8 持仓、组合结果和服务端 watchlist 的隐私问题。
- Worker POST /test 使用 ADMIN_TOKEN；会真实发送，不得用于 smoke。
- 前端 LLM Key 和 Gist PAT 保存在 localStorage；没有后端 vault 或用户会话。

## 4.5 外部接口与本地服务

- 东方财富 / 天天基金：基金全集、详情、正式净值、估值表、持仓。
- 腾讯行情：指数或持仓报价的兼容 JSONP。
- GitHub：Pages、Actions、Gist。
- Cloudflare Worker：估值、持仓、health、Cron。
- Server酱、PushPlus、Webhook：通知，其中后两者主要在人工脚本。
- LLM：DeepSeek、Qwen、OpenAI、Gemini、Moonshot、Anthropic、自定义 OpenAI-compatible。
- 乐咕乐股 / AKShare：离线指数估值富集。
- 上海证券交易所休市公告：交易日历人工可审核来源。
- 不存在本地桌面服务、Tauri command、Electron IPC、MCP server/client。

---

# 五、核心业务流程

## 5.1 基金详情与 V8 决策

~~~text
用户打开 /fund/:code
→ FundDetailPage.loadData()
→ watchlist Store 读取本地/Gist持仓
→ funds Store.analyze()
→ frontend/src/api/client.ts getAnalyze()
→ GET /api/fund/{code}/analyze
→ backend/main.py
→ service/repo.py 读 12 小时缓存或 service/eastmoney.py 拉上游
→ strategy 生成评分/信号/回测/v7 决策
→ SQLite 缓存
→ 返回旧版聚合结果
→ FundDetailPage 展示

并行：
→ fetchEstimate() → Worker /estimates
→ getHoldings() → Worker/东方财富/腾讯兼容源
→ FundDetailV8Panel → GET /api/v2/fund/{code}/decision + outcomes
→ 可选 llmInterpret() → 用户配置的 LLM Provider
~~~

注意：同一组件内切换 :code 时当前实现不会重新 load，URL 与内容可能错配。

## 5.2 选基

~~~text
用户进入 /screen
→ ScreenPage
→ GET /api/funds 获取基础全集
→ loadScreener() / loadManagers()
→ GitHub Pages manifest + 分片
→ 浏览器校验 SHA-256 和数据 freshness
→ 客户端筛选、排序、经理搜索
→ 可选 parseQuery() 调 LLM 返回筛选 JSON
→ applySpec() 应用规则
→ 过期数据时关闭质量/AI筛选与同类推荐
~~~

## 5.3 自选、持仓与 Gist

~~~text
用户添加自选
→ watchlist Store 写 localStorage
→ 可选 Gist pull
→ schema 校验、按 updatedAt 与 tombstone 合并
→ push 整个 sinan-watchlist.json
→ WatchlistPage 批量拉 Worker estimates
→ 逐基金拉 V8 decision + diff
→ decisionView.ts 执行缺失/过期/低置信 fail-closed
→ WatchlistDecisionBoard
~~~

Store 已支持 shares/cost/account/target_weight，但 UI 没有新持仓录入入口。Gist 并发上传没有 ETag/CAS。

## 5.4 Worker 14:30 / 14:40 定时推送

~~~text
Cloudflare Cron
→ runScheduled()
→ 14:30 主窗口先 POST /api/v2/outcomes/settle
→ 从 Gist 读取自选和运行状态
→ resolveValuations()
→ 东方财富估值表 → 持仓穿透模型 → 正式净值 → unavailable
→ POST /api/v2/portfolio/decisions
→ POST /api/v2/notifications/events 写 scheduled / attempted
→ attempted 获得 claimed=true 且 duplicate=false
→ Server酱发送
→ 写 sent / failed / compensated
→ Gist 写回运行状态
→ 14:40 使用同一 natural request ID 只做补偿
~~~

后端 V8 组合 settle 未被该链调用；当前只结算个体结果。

## 5.5 V8 后端决策与幂等

~~~text
Worker 批量请求
→ require_worker_or_admin + 进程内限流
→ idempotency_responses claim(request_id, endpoint, request_sha256)
→ 每只基金取 detail + EstimateContext + Holding
→ build evidence snapshot
→ build holding version
→ decision_v2 状态机与硬门禁
→ 写不可变 decision snapshot
→ 完整批次时写 portfolio snapshot
→ 保存 response 并 complete
→ 后续同请求重放原响应
~~~

当前单项失败仍会把批次标为 complete，同一 request_id 无法补齐，是高优先级缺陷。

## 5.6 结果结算

~~~text
定时或管理请求
→ POST /api/v2/outcomes/settle
→ 读取未结算决策
→ 普通基金找决策后第 5/20/60 个交易日
→ QDII 只接受精确 target_nav_date
→ 计算绝对收益、同类超额、回撤与 hit
→ 追加 outcome_evaluations

组合分支（当前未被调度）
→ POST /api/v2/portfolio/outcomes/settle
→ 所有组件取共同净值日期，不 forward-fill
→ 计算组合收益/回撤
→ 追加 portfolio_outcome_evaluations
~~~

## 5.7 周期静态数据

~~~text
GitHub Actions schedule/manual
→ tools 构建 universe / holdings / managers / screener / index valuation
→ 数量、覆盖率、哈希、旧产物回退门禁
→ 生成分片 + manifest
→ 提交前确认 origin/main 仍是生成时 base
→ 机器人提交与 push
→ 显式 dispatch 精确 SHA CI
→ Pages 构建与发布
~~~

所有定期数据写任务共享 scheduled-data-main concurrency，避免多个机器人任务同时写 main。

---

# 六、API 清单

## 6.1 FastAPI

所有路由当前集中在 backend/main.py。表中的参数只列主要字段；Pydantic 422 和内部错误不再逐项展开。

| Method | Path | 文件位置 | 功能 | 请求参数 | 返回值 | 当前状态 |
|---|---|---|---|---|---|---|
| GET | /api/health | main.py:209 | 版本、数据源、DB、策略、运维健康 | 无 | HealthResponse | 使用中 |
| GET | /api/funds | main.py:229 | 分页基金全集 | q, type, page, page_size | items/total/page | 使用中 |
| GET | /api/fund/{code} | main.py:240 | 基金详情 | code, force | detail | v7 兼容；前端使用 |
| GET | /api/fund/{code}/score | main.py:247 | 基金评分 | code, force | score | v7；前端使用 |
| GET | /api/fund/{code}/signal | main.py:253 | 择时信号 | code, force | signal | v7；前端使用 |
| GET | /api/fund/{code}/backtest | main.py:259 | 历史回测 | code, force | backtest | v7；前端使用 |
| GET | /api/fund/{code}/calibrate | main.py:265 | 单基金校准 | code, force | calibration | v7；公共重计算风险 |
| GET | /api/strategy/registry | main.py:271 | v7 策略注册表 | 无 | registry | 仅 smoke/docs |
| GET | /api/fund/{code}/decision | main.py:277 | v7 决策 | held/current/target | decision | wrapper 未被页面调用 |
| GET | /api/fund/{code}/analyze | main.py:290 | 聚合详情/评分/信号/回测/决策 | code, force | analyze bundle | 使用中 |
| POST | /api/portfolio/decisions | main.py:319 | v7 批量组合决策 | request_id, items | 决策/错误/合计/duplicate | Worker/Admin；人工应急仍用 |
| GET | /api/strategy/outcomes | main.py:386 | v7 个体结果 | 无 | 全量列表 | 前端使用，无分页 |
| GET | /api/strategy/portfolio-outcomes | main.py:392 | v7 组合结果 | 无 | 全量列表 | 前端使用，无分页 |
| GET | /api/strategy/version-comparison | main.py:398 | v7 策略版本对比 | 无 | comparison | 无仓内消费者 |
| GET | /api/v2/fund/{code}/evidence | main.py:412 | 最近 V8 证据 | 6 位 code | EvidenceSnapshot | wrapper 有、页面未用 |
| GET | /api/v2/fund/{code}/decision | main.py:421 | 最近 V8 决策及 holding | 6 位 code | Decision + Evidence + Holding | 前端使用；公开隐私 P0 |
| GET | /api/v2/fund/{code}/decision/diff | main.py:445 | 最近两次决策差异 | 6 位 code | diff | 自选使用 |
| GET | /api/v2/fund/{code}/outcomes | main.py:455 | V8 个体评价 | 6 位 code | outcome list | 详情使用 |
| POST | /api/v2/watchlist/decisions | main.py:501 | V8 自选批量决策 | V8DecisionBatchRequest | V8 batch | Worker/Admin；无仓内消费者 |
| POST | /api/v2/portfolio/decisions | main.py:509 | V8 批量决策并写组合快照 | request_id, items, context | batch + portfolio | Worker 主链 |
| POST | /api/v2/portfolio/rebalance | main.py:517 | 组合再平衡建议 | V8 batch model | rebalance | Worker/Admin；无消费者 |
| GET | /api/v2/portfolio/outcomes | main.py:540 | V8 组合评价和快照 | 无 | portfolio outcome list | 公开隐私 P0；前端未用 |
| POST | /api/v2/portfolio/outcomes/settle | main.py:545 | 结算 V8 组合结果 | ids/limit | settled/skipped/errors | Worker/Admin；无人调度 |
| GET | /api/v2/portfolio/policy | main.py:568 | 当前组合策略 | 无 | policy | wrapper 未使用 |
| POST | /api/v2/portfolio/policy | main.py:576 | 新组合策略版本 | V8PolicyRequest | policy | Admin；错误映射不完整 |
| GET | /api/v2/portfolio/policy/history | main.py:593 | 策略历史 | 无 | policy list | 无仓内消费者 |
| GET | /api/v2/strategy/registry | main.py:599 | V8 策略注册 | 无 | registry | 无仓内消费者 |
| GET | /api/v2/strategy/{version}/performance | main.py:612 | 指定策略表现 | version | performance | 无仓内消费者 |
| GET | /api/v2/strategy/candidates | main.py:619 | 策略候选比较 | 无 | candidates | 无仓内消费者 |
| POST | /api/v2/outcomes/settle | main.py:630 | 结算 V8 个体结果 | decision_ids, limit | settled/skipped/errors | Worker 主链 |
| POST | /api/v2/notifications/events | main.py:663 | 通知阶段事件与原子 claim | event model | claim/event result | Worker 主链 |
| GET | /api/v2/notifications/{decision_id} | main.py:690 | 通知审计记录 | decision_id | event list | Worker/Admin；无页面 |
| POST | /api/portfolio/lab | main.py:701 | 1–10 只基金组合模拟 | codes/weights/options | simulation | Admin；前端实际 401 |
| GET | /api/watchlist | main.py:760 | 服务端全局自选 | 无 | code list | 遗留；公开隐私 |
| POST | /api/watchlist | main.py:765 | 服务端添加自选 | code | result | Admin；前端不用 |
| DELETE | /api/watchlist/{code} | main.py:774 | 服务端删除自选 | code | result | Admin；前端不用 |
| POST | /api/admin/refresh-universe | main.py:780 | 强制刷新基金全集 | 无 | refresh status | Admin 运维 |

兼容与重复说明：

- v7 decision / portfolio decisions / outcomes 与 V8 同类接口并行；人工应急和前端旧页面尚未迁完，暂不能删除。
- REST watchlist 与前端 localStorage/Gist 是两套状态源；当前页面不使用服务端 watchlist。
- frontend/src/api/client.ts 还有 evidence、policy、registry 等只在测试出现的 wrapper。
- 多数路由没有 response_model，也没有在 OpenAPI 声明真实 401/404/409/425/429/5xx。
- fund_detail_dep 不统一校验 6 位 code，并把多类异常都映射为 404。

## 6.2 Cloudflare Worker

| Method | Path | 文件位置 | 功能 | 请求参数 | 返回值 | 当前状态 |
|---|---|---|---|---|---|---|
| GET | /estimates | worker/src/index.ts | 批量估值 | codes，1–50 个 | estimates + provider diagnostics | 公开；使用中；无限流 |
| GET | /holdings | worker/src/index.ts | 单基金持仓 | code | holdings | 公开；30 分钟缓存 |
| GET/HEAD | /health | worker/src/index.ts:1372 | 构建、配置和 Cron 健康 | 无 | health JSON | 公开；生产 build_sha 为空 |
| POST | /test | worker/src/index.ts:1388 | 真实测试推送 | Bearer Admin | send result | Admin；禁止 smoke |
| OPTIONS | 公开 GET | worker/src/index.ts | CORS 预检 | Origin | headers | 已实现 |

---

# 七、数据库结构

## 7.1 总览

- 数据库：SQLite；schema_version / PRAGMA user_version = 8。
- 定义：backend/database/db.py:28-339。
- 初始化：每次连接启用 foreign_keys 和 busy_timeout；启动设置 WAL、synchronous=NORMAL，执行 schema、手写迁移、foreign_key_check、quick_check 和 optimize。
- 事务：关键写使用 BEGIN IMMEDIATE。
- 迁移：无 Alembic、无逐版本 migration 文件；启动时补列/修表，V8 前做备份。旧 portfolio outcome 表可能重命名为 portfolio_outcome_evaluations_legacy_v8，但旧行不迁入新表。
- 本地审计：user_version=8、quick_check=ok，17 张业务表与 V8 不可变触发器存在。

以下“默认值无”表示 SQL 未声明 DEFAULT；SQLite 中未写入的可空字段自然为 NULL。

## 7.2 v7 / 兼容表

### funds

用途：基金全集基础索引。

| 字段 | 类型 | 含义 | 可空 | 默认值 |
|---|---|---|---|---|
| code | TEXT PK | 六位基金代码 | 否 | 无 |
| name, type, pinyin | TEXT | 名称、类型、拼音搜索 | 是 | NULL |

索引：idx_funds_type(type)。无外键。

### fund_detail

用途：详情和最新正式净值缓存。

| 字段 | 类型 | 含义 | 可空 | 默认值 |
|---|---|---|---|---|
| code | TEXT PK | 基金代码 | 否 | 无 |
| name, type, manager, manager_id, manager_worktime, latest_nav_date, source, updated_at | TEXT | 基础资料、经理、日期、来源、更新时间 | 是 | NULL |
| scale, buy_rate, source_rate, ret_1m, ret_6m, ret_1y, ret_3y, latest_nav | REAL | 规模、费率、收益、最新净值 | 是 | NULL |
| rank_in_type, rank_total | INTEGER | 排名 | 是 | NULL |

无外键；code 与 funds 仅靠应用层对应。

### nav_history

用途：历史单位净值与累计收益。

| 字段 | 类型 | 含义 | 可空 | 默认值 |
|---|---|---|---|---|
| code, date | TEXT，复合 PK | 基金和净值日期 | 否 | 无 |
| nav, ac_return | REAL | 单位净值、累计收益 | 是 | NULL |

主键：(code,date)。无显式 funds 外键。

### watchlist

用途：后端遗留全局自选。

| 字段 | 类型 | 含义 | 可空 | 默认值 |
|---|---|---|---|---|
| code | TEXT PK | 基金代码 | 否 | 无 |
| added_at | TEXT | 添加时间 | 是 | NULL |

当前前端不用该表。

### decision_history

用途：v7 个体决策历史。

| 字段 | 类型 | 含义 | 可空 | 默认值 |
|---|---|---|---|---|
| id | INTEGER PK AUTOINCREMENT | 行 ID | 否 | 自动 |
| code, decision_date, action, strategy_version, created_at | TEXT | 基金、日期、动作、版本、创建时间 | 否 | 无 |
| base_nav | REAL | 决策基准净值 | 否 | 无 |
| name, type, confidence, score_version, signal_version, evidence_strength, region | TEXT | 展示与版本元数据 | 是 | NULL |
| score_coverage, signal_coverage | REAL | 覆盖率 | 是 | NULL |

唯一键：(code,decision_date,strategy_version)；索引 decision_date。

### portfolio_decision_history

用途：v7 组合决策 JSON 快照。

| 字段 | 类型 | 含义 | 可空 | 默认值 |
|---|---|---|---|---|
| id | INTEGER PK AUTOINCREMENT | 行 ID | 否 | 自动 |
| snapshot_date, strategy_version, items_json, created_at | TEXT | 日期、版本、组件 JSON、创建时间 | 否 | 无 |

唯一键：(snapshot_date,strategy_version)；索引 snapshot_date。

### idempotency_requests

用途：v7 请求 ID 去重标记。

| 字段 | 类型 | 含义 | 可空 | 默认值 |
|---|---|---|---|---|
| request_id | TEXT PK | 请求 ID | 否 | 无 |
| endpoint, created_at | TEXT | 端点与时间 | 否 | 无 |

不保存 request hash 或 response，因此不是真正响应重放。

## 7.3 V8 不可变表

### evidence_snapshots

用途：决策使用的完整、可哈希证据。

| 字段 | 类型 | 含义 | 可空 | 默认值 |
|---|---|---|---|---|
| evidence_id | TEXT PK | 稳定证据 ID | 否 | 无 |
| fund_code, created_at, estimate_status, source_states_json, evidence_nodes_json, missing_fields_json, stale_fields_json, risk_flags_json, payload_json, payload_sha256 | TEXT | 标识、状态、结构化 JSON 与完整载荷 | 否 | 无 |
| score_coverage, timing_coverage, evidence_strength | REAL | 受 CHECK 约束的覆盖率/证据强度 | 否 | 无 |
| fund_name, fund_type, market_time, official_nav_date, target_nav_date, benchmark_id, trend_state, momentum_state, score_version, timing_signal, estimate_model_version | TEXT | 可选元数据 | 是 | NULL |
| official_nav, valuation_percentile, drawdown, volatility, market_temperature, score, estimate, estimate_coverage, estimate_error_p80, estimate_mae, estimate_direction_accuracy | REAL | 可选数值证据 | 是 | NULL |
| estimate_sample_count | INTEGER | 模型样本数 | 是 | NULL |

payload_sha256 唯一；索引 (fund_code,created_at DESC)、target_nav_date。

### source_health_events

用途：每个证据快照的数据源健康观测。

| 字段 | 类型 | 含义 | 可空 | 默认值 |
|---|---|---|---|---|
| event_id | TEXT PK | 事件 ID | 否 | 无 |
| evidence_id, source_id, state, observed_at, payload_json | TEXT | 证据外键、来源、状态、时间、载荷 | 否 | 无 |
| stale | INTEGER | 0/1 陈旧标记 | 否 | 无 |
| last_success, last_failure, error_class | TEXT | 可选时间与错误分类 | 是 | NULL |
| latency_ms, data_age_seconds | REAL | 延迟与数据年龄 | 是 | NULL |

外键 evidence_id → evidence_snapshots，ON DELETE RESTRICT；唯一键 (evidence_id,source_id)；来源时间索引。

### holding_versions

用途：决策时的持仓版本；包含私人财务数据。

| 字段 | 类型 | 含义 | 可空 | 默认值 |
|---|---|---|---|---|
| holding_version | TEXT PK | 稳定持仓版本 ID | 否 | 无 |
| fund_code, user_state, source, created_at, payload_json, payload_sha256 | TEXT | 基金、held/unheld、来源、时间与载荷 | 否 | 无 |
| shares, cost, market_value, current_weight, target_weight | REAL | 份额、成本、市值和权重 | 是 | NULL |
| account, updated_at | TEXT | 账户与用户更新时间 | 是 | NULL |

current/target weight 受 0–100 CHECK；payload hash 唯一；索引 (fund_code,created_at DESC)。

### portfolio_policy_versions

用途：组合约束与调仓规则版本。

| 字段 | 类型 | 含义 | 可空 | 默认值 |
|---|---|---|---|---|
| policy_version | TEXT PK | 策略版本 ID | 否 | 无 |
| name, target_allocations_json, target_ranges_json, dca_rules_json, reduce_rules_json, sell_rules_json, effective_at, created_at, source, payload_json, payload_sha256 | TEXT | 配置、规则、时间与载荷 | 否 | 无 |
| max_single_fund_weight, max_theme_weight, rebalance_band | REAL | 可选上限与带宽 | 是 | NULL |
| supersedes | TEXT FK | 被替代的旧版本 | 是 | NULL |

supersedes 自引用且 ON DELETE RESTRICT；payload hash 唯一；effective/created 索引。

### decision_snapshots

用途：V8 不可变个体决策。

| 字段 | 类型 | 含义 | 可空 | 默认值 |
|---|---|---|---|---|
| decision_id | TEXT PK | 稳定决策 ID | 否 | 无 |
| evidence_id, fund_code, holding_version, policy_version, strategy_version, user_state, action, summary, reason_codes_json, reasons_json, risks_json, invalidation_codes_json, invalidation_json, evidence_nodes_json, created_at, payload_json, payload_sha256 | TEXT | 关联、动作、解释与载荷 | 否 | 无 |
| strength, confidence | INTEGER | 0–100 强度与置信度 | 否 | 无 |
| position_guidance_json | TEXT | 可选仓位指导 | 是 | NULL |

外键指向 evidence、holding、policy；action 仅 buy/dca/watch/add/hold/reduce/sell；按 fund/time 与 versions 建索引。

### outcome_evaluations

用途：V8 个体决策的事后评价。

| 字段 | 类型 | 含义 | 可空 | 默认值 |
|---|---|---|---|---|
| outcome_id | TEXT PK | 评价 ID | 否 | 无 |
| decision_id, evaluation_kind, base_nav_date, evaluation_date, created_at, payload_json, payload_sha256 | TEXT | 决策外键、类型、日期与载荷 | 否 | 无 |
| horizon, hit | INTEGER | 0/5/20/60 天与命中标记 | 否 | 无 |
| base_nav, evaluated_nav, absolute_return, max_drawdown | REAL | 净值、收益、回撤 | 否 | 无 |
| benchmark_samples | INTEGER | 基准样本数 | 否 | 0 |
| target_nav_date | TEXT | QDII 目标日期 | 是 | NULL |
| benchmark_return, peer_excess, predicted_change, prediction_error | REAL | 可选基准/预测指标 | 是 | NULL |

外键 decision_id；唯一键 (decision_id,evaluation_kind,horizon)；payload hash 唯一。

### portfolio_decision_snapshots

用途：完整批次的组合决策快照。

| 字段 | 类型 | 含义 | 可空 | 默认值 |
|---|---|---|---|---|
| portfolio_decision_id | TEXT PK | 组合快照 ID | 否 | 无 |
| decision_date, policy_version, strategy_version, components_json, source, created_at, payload_json, payload_sha256 | TEXT | 日期、版本、组件与载荷 | 否 | 无 |
| component_count | INTEGER | 1–50 个组件 | 否 | 无 |
| current_cash_weight, target_cash_weight | REAL | 0–100 现金权重 | 否 | 无 |
| portfolio_value | REAL | 组合总值，私人数据 | 是 | NULL |

policy 外键；payload hash 唯一；created 和版本索引。

### portfolio_outcome_evaluations

用途：组合决策的 5/20/60 天评价。

| 字段 | 类型 | 含义 | 可空 | 默认值 |
|---|---|---|---|---|
| outcome_id | TEXT PK | 评价 ID | 否 | 无 |
| portfolio_decision_id, base_nav_date, evaluation_date, components_json, method, created_at, payload_json, payload_sha256 | TEXT | 组合外键、日期、组件、方法和载荷 | 否 | 无 |
| horizon | INTEGER | 5/20/60 天 | 否 | 无 |
| absolute_return, max_drawdown, current_cash_weight, cash_return, cash_contribution | REAL | 收益、回撤与现金项 | 否 | 无 |

method 固定 common_nav_dates_no_forward_fill；cash_return/cash_contribution 固定 0；唯一键 (portfolio_decision_id,horizon)。

### notification_events

用途：通知阶段、claim 和终态的追加审计。

| 字段 | 类型 | 含义 | 可空 | 默认值 |
|---|---|---|---|---|
| event_log_id | TEXT PK | 日志行 ID | 否 | 无 |
| notification_event_id, decision_id, scheduled_window, status, occurred_at, detail_json | TEXT | 通知、决策、窗口、状态、时间与详情 | 否 | 无 |
| attempt_no, natural_schedule | INTEGER | 尝试次数与自然调度标记 | 否 | 无 |
| error_class | TEXT | 错误分类 | 是 | NULL |

status 限定 scheduled/skipped/attempted/sent/failed/compensated；decision 外键；阶段唯一键防重复。

### idempotency_responses

用途：V8 请求幂等租约和响应重放。

| 字段 | 类型 | 含义 | 可空 | 默认值 |
|---|---|---|---|---|
| request_id, endpoint | TEXT，复合 PK | 幂等键 | 否 | 无 |
| request_sha256, state, created_at | TEXT | 请求哈希、in_progress/complete、创建时间 | 否 | 无 |
| response_json, owner_token, lease_expires_at, completed_at | TEXT | 响应、租约 owner/到期、完成时间 | 是 | NULL |

## 7.4 关系、兼容和删除边界

~~~mermaid
erDiagram
    EVIDENCE_SNAPSHOTS ||--o{ SOURCE_HEALTH_EVENTS : contains
    EVIDENCE_SNAPSHOTS ||--o{ DECISION_SNAPSHOTS : supports
    HOLDING_VERSIONS ||--o{ DECISION_SNAPSHOTS : freezes
    PORTFOLIO_POLICY_VERSIONS ||--o{ DECISION_SNAPSHOTS : governs
    PORTFOLIO_POLICY_VERSIONS ||--o{ PORTFOLIO_DECISION_SNAPSHOTS : governs
    DECISION_SNAPSHOTS ||--o{ OUTCOME_EVALUATIONS : evaluated_by
    DECISION_SNAPSHOTS ||--o{ NOTIFICATION_EVENTS : notified_by
    PORTFOLIO_DECISION_SNAPSHOTS ||--o{ PORTFOLIO_OUTCOME_EVALUATIONS : evaluated_by
~~~

兼容问题：

- v7 与 V8 的决策、组合、结果和幂等表双栈并存。
- V8 evidence/holding 没有 funds 外键；组合组件大量存 JSON，关联完整性依赖应用。
- 结构化列与 payload_json 重复；绕过应用写 SQL 可能产生不一致。
- _legacy_v8 表不在正常读取链，保留只为迁移取证。
- 没有保留/归档策略；快照、事件、幂等数据长期只增不减。
- 当前生产临时盘会让整个审计链在实例重建后丢失。
- 任何删除旧表/字段的工作都必须先证明人工推送、旧 Outcomes 页面和兼容客户端不再使用；本轮不得删除。

---

# 八、前端页面与组件

## 8.1 页面清单

路由使用 createWebHashHistory，适配 GitHub Pages 子路径；当前没有 catch-all 404。

| 页面 | 路由 | 入口组件 | 主要调用 | 状态 |
|---|---|---|---|---|
| 首页 | / | frontend/src/pages/HomePage.vue | health、逐只 signal、V8 decision、Worker estimates、Actions、指数 | 已实现；V8 依赖已有快照 |
| 选基 | /screen | ScreenPage.vue | funds、静态 screener/managers、可选 LLM | 已实现；过期时正确停用高风险筛选 |
| 自选 | /watch | WatchlistPage.vue | funds、V8 decision/diff、Worker estimates、Gist | 部分实现；无持仓编辑 UI |
| 对比 | /compare | ComparePage.vue | detail、score | 已实现，最多 3 只 |
| 资产 | /assets | AssetsPage.vue | detail、estimates、本地持仓/快照/Gist | 部分实现；新用户输入链断 |
| 组合实验室 | /portfolio-lab | PortfolioLabPage.vue | detail、POST /portfolio/lab | 页面存在；生产请求 401，目标权重不持久 |
| 持仓穿透 | /lookthrough | LookthroughPage.vue | detail、静态 enrich、东方财富持仓 | 已实现；覆盖率分母有偏差 |
| 基金详情 | /fund/:code | FundDetailPage.vue | analyze、estimates、holding、V8 decision/outcomes、LLM | 已实现；路由参数切换错配 |
| 体检报告 | /report/:code | ReportPage.vue | detail/score/signal/backtest、estimate、html-to-image | 已实现；stale 披露不足 |
| 回测实验室 | /backtest | BacktestPage.vue | backtest、detail、calibrate | 已实现 |
| 实盘验证 | /outcomes | OutcomesPage.vue | v7 individual/portfolio outcomes、海外精度 | 已实现旧链；V8 组合未接 |
| 数据故事 | /story | StoryPage.vue | detail/signal/score/estimate、LLM、图片导出 | 部分实现；缺值会错误转 0 |
| 运行状态 | /operations | OperationsPage.vue | API health、Worker health、GitHub Actions | 已实现，只读 |
| 未知路由 | 任意其他 | 无 | 无 | 尚未实现 404 |

三项主导航只显示首页、选基、自选，定义于 frontend/src/utils/presentation.ts:6-10。其他页面可由内部链接进入，不等于废弃。

## 8.2 主要组件与耦合

| 组件/模块 | 职责 | 观察 |
|---|---|---|
| App.vue | router-view、三项主导航、主题 | 轻量、职责清楚 |
| HomeActionCenter.vue + homeActionCenter.ts | V8 首页动作汇总 | presenter 可测，但门禁规则少于 Watch |
| WatchlistDecisionBoard.vue + decisionView.ts | 自选 V8 动作、差异、阻断 | 当前完整性门禁最严格 |
| FundDetailV8Panel.vue + fundDetailV8Presenter.ts | V8 证据/决策/结果详情 | 面板约 465 行，门禁与 Watch 不统一 |
| Chart.vue | ECharts 封装 | ECharts 已独立分块 |
| DcaCalc.vue | 定投模拟 | 一次性基准时间轴错误 |
| DecisionCard.vue | v7 决策卡 | 仍被详情使用，不是死组件 |

超大/高耦合文件：

- frontend/src/utils/estimate.ts，约 832 行：协议、缓存、新鲜度、持仓模型、JSONP、海外模型耦合。
- frontend/src/pages/AssetsPage.vue，约 811 行：加载、估值、聚合、归因、快照、诊断、手工资产、云同步和 UI。
- frontend/src/api/client.ts，约 696 行：全部领域类型和接口。
- FundDetailPage.vue 约 537 行；FundDetailV8Panel.vue 约 465 行。
- 页面目前直接混用 Store、api/client 和 utils 外部源，没有独立 service/composable 层。

临时/未完成点：

- 多个页面测试只是读取 Vue 文件做字符串断言，并未 mount。
- PortfolioLabPage 的目标权重只存在页面内存。
- setHolding 只有测试消费者，生产页面没有表单。
- 未发现明确废弃的 Vue 页面；DecisionCard 仍在使用。

---

# 九、AI / Agent 系统

## 9.1 当前真实实现

当前只有浏览器端、用户自带 Key 的一次性 LLM 请求，不是 Agent。

| 项目 | 当前实现 |
|---|---|
| Provider | DeepSeek、Qwen、OpenAI、Gemini、Moonshot、Anthropic、自定义 OpenAI-compatible |
| 默认模型 | 按 provider 在 frontend/src/utils/ai.ts:19-27 映射 |
| Key/配置 | localStorage，frontend/src/utils/ai.ts:31-55 |
| Prompt | interpret.ts:103-125、nlselect.ts:16-30、story.ts:67-94 |
| System Prompt | 每项功能在调用点构建固定中文约束；没有集中注册表 |
| 上下文 | 当前页面已获取的基金、评分、信号、持仓/故事摘要 |
| Memory | 不存在；不会跨调用保存对话 |
| Tool Calling | 不存在 |
| Tool Registry / Tool 执行 | 不存在 |
| Agent Loop / 最大轮数 | 不存在；每次一轮 |
| Streaming | 不存在 |
| 超时 | 不存在 |
| 重试 | 不存在 |
| Token 控制 | 仅固定 max_tokens=700；无输入/费用统计 |
| 温度 | 0.4 |
| MCP | 不存在 |
| 权限 | 浏览器直接使用用户 Key；没有服务端用户身份 |
| Sandbox | 不存在；也没有模型执行本地代码的能力 |
| 审计 | 不记录请求/响应审计 |
| 错误处理 | fetch/JSON 错误抛给页面；故事有规则 fallback |

## 9.2 请求流程

~~~mermaid
flowchart TD
    U[用户开启 AI 功能并配置 Provider/Key] --> LS[localStorage]
    P[页面已加载的基金/组合数据] --> PB[interpret / nlselect / story 构建 Prompt]
    LS --> A[utils/ai.ts]
    PB --> A
    A -->|OpenAI-compatible chat/completions| O[DeepSeek/Qwen/OpenAI/Moonshot/Custom]
    A -->|Gemini API shape| G[Gemini]
    A -->|Anthropic /v1/messages| H[Anthropic]
    O --> R[文本结果]
    G --> R
    H --> R
    R --> I{用途}
    I -->|点评| UI[直接展示]
    I -->|自然语言选基| J[JSON.parse + TypeScript cast]
    I -->|故事| S[摘要；失败走规则模板]
~~~

主要风险：

- nlselect.ts 对模型 JSON 只 parse 后强制转换，没有运行时 schema、枚举和数值范围校验。
- fetch 没有 AbortController timeout，Provider 卡住时 UI 可长时间等待。
- Key 与 Gist PAT 同存应用 origin 的 localStorage，而行情/持仓使用第三方 JSONP script。
- Prompt 只用于文本/JSON生成；模型不能调用后端管理接口或本地工具，因此不存在无限 Tool 调用风险。
- 不建议下一版本先建设“Agent 平台”；优先修复 Key 边界、超时和输出校验。

---

# 十、配置与环境变量

仓库没有 .env.example，也没有 dotenv 加载器。.gitignore 只明确忽略 .env.local / *.local，没有覆盖通用 .env。应增加分组模板，但不得写真实值。

## 10.1 后端与部署

| 环境变量 | 用途 | 必填 | 默认值/缺省行为 | 使用位置 |
|---|---|---:|---|---|
| RENDER_GIT_COMMIT | 线上精确 Git SHA | Render 建议 | 空字符串 | backend/main.py |
| RENDER | 判断 platform=render | 否 | 非 true 视为 local | backend/main.py |
| FUND_DB | SQLite 文件路径 | 否 | backend/fund_compass.db | backend/database/db.py |
| FUND_DB_MOUNT_PATH | 持久挂载根路径探测 | V8 生产必需之一 | 空 | backend/database/db.py |
| FUND_DB_PERSISTENCE | ephemeral/persistent 声明 | V8 生产必需 | 空；Render 当前设 ephemeral | db.py、render.yaml |
| FUND_DB_TIMEOUT_SECONDS | SQLite busy timeout | 否 | 8，最大 60 | backend/database/db.py |
| ESTIMATE_PROXY_URL | 后端估值代理 | 否 | 生产 Worker /estimates URL | backend/service/eastmoney.py |
| OVERSEAS_EVIDENCE_PATH | QDII 审计证据文件 | 否 | backend/data/overseas-evidence.json | service/overseas_evidence.py |
| STRATEGY_REGISTRY_PATH | 策略参数文件 | 否 | backend/data/strategy-params.json | strategy/registry.py |
| ADMIN_TOKEN | 管理写 API | 生产写操作是 | 无；缺失即拒绝 | service/security.py |
| WORKER_TOKEN | Worker 写 API | Worker 主链是 | 无；缺失即拒绝 | service/security.py |
| PORT | Uvicorn 监听端口 | Render 是 | 平台注入 | render.yaml startCommand |
| PYTHON_VERSION | Render Python 版本 | Render 是 | 3.12.7 | render.yaml |

## 10.2 前端

| 环境变量 | 用途 | 必填 | 默认值/缺省行为 | 使用位置 |
|---|---|---:|---|---|
| VITE_API_BASE | FastAPI 基址 | 否 | /api | frontend/src/api/client.ts、utils/resilience.ts |
| VITE_ESTIMATE_PROXY | Worker 估值 URL | 否 | 生产 Worker /estimates URL | utils/estimate.ts |
| VITE_WORKER_HEALTH | Worker health URL | 否 | 生产 Worker /health URL | pages/OperationsPage.vue |
| BASE_URL | Vite 构建基址 | 内建 | vite.config 中 /fund-compass/ | screener/managers/lookthrough/accuracy loader |

Pages workflow 只显式传 VITE_API_BASE，另外两个变量依赖硬编码默认 URL。

## 10.3 Worker

| 环境变量/绑定 | 用途 | 必填 | 默认值/缺省行为 | 使用位置 |
|---|---|---:|---|---|
| GIST_ID | 自选和运行状态 Gist | 是 | 无；不公开真实 ID | worker/src/index.ts |
| GIST_TOKEN | Gist 读写 | 是 | 无 | worker/src/index.ts |
| WECHAT_SENDKEY | Server酱发送 | 是 | 无 | worker/src/index.ts |
| FUND_API_BASE | FastAPI 基址 | V8 主链是 | wrangler.toml 配置；空则决策禁用/降级 | worker/src/index.ts |
| ADMIN_TOKEN | POST /test | 仅测试发送是 | 无 | worker/src/index.ts |
| WORKER_TOKEN | 后端 V8 写 API | V8 主链是 | 无 | worker/src/index.ts |
| WORKER_BUILD_SHA | 构建身份常量 | 真实发布是 | 不从普通 env 读；deploy.mjs --define 注入 | worker/scripts/deploy.mjs |

## 10.4 工具与工作流

| 环境变量 | 用途 | 必填 | 默认值/缺省行为 | 使用位置 |
|---|---|---:|---|---|
| FUND_API_BASE | 海外流水线/校准/人工推送后端 | 依任务 | 海外脚本默认 Render；其他脚本可为空 | overseas_accuracy.py、calibrate_strategy.py、estimate_push.py |
| API_BASE | 旧信号通知 API | 否 | Render /api | tools/notify.py |
| CALIBRATION_MIN_VALID | 策略候选最小有效样本 | 否 | 12 | tools/calibrate_strategy.py |
| CALIBRATION_MAX_FUNDS | 校准最大基金数 | 否 | 30 | tools/calibrate_strategy.py |
| OVERSEAS_MIN_SAMPLES | Challenger 最小样本 | 否 | 20 | tools/calibrate_overseas.py |
| OVERSEAS_NON_TRADING_DATES | 额外休市日，逗号分隔 | 否 | 空；内置 2025/2026 | 三个 overseas 脚本 |
| OVERSEAS_SCHEDULE_TIME | 预测计划时间 | 否 | 14:35 | tools/overseas_accuracy.py |
| OVERSEAS_PREDICTION_EARLY_MINUTES | 可接受提前分钟 | 否 | 5 | tools/overseas_accuracy.py |
| OVERSEAS_PREDICTION_LATE_MINUTES | 可接受延后分钟 | 否 | 45 | tools/overseas_accuracy.py |
| OVERSEAS_MAX_BASE_AGE_DAYS | 基准 NAV 最大年龄 | 否 | 7 | tools/overseas_accuracy.py |
| OVERSEAS_RUN_MODE | scheduled/manual | 否 | 按 GITHUB_EVENT_NAME 推断 | tools/overseas_accuracy.py |
| OVERSEAS_EFFECTIVE_MAX_AGE_HOURS | 有效模型最大年龄 | 否 | 96 | tools/audit_overseas_accuracy.py |
| OVERSEAS_ZERO_PREDICTION_LIMIT | 连续零预测告警阈值 | 否 | 2 | tools/audit_overseas_accuracy.py |
| GITHUB_EVENT_NAME | Actions 事件类型 | 平台内建 | 无 | tools/overseas_accuracy.py |
| GIST_ID | 人工推送/旧通知 Gist | 相应任务是 | 空 | estimate_push.py、notify.py |
| GIST_TOKEN | Gist 认证 | 相应任务是 | 空 | estimate_push.py、notify.py |
| WECHAT_SENDKEY | Server酱 Key | 至少一种通知渠道 | 空，可回退 SC_SENDKEY | estimate_push.py |
| SC_SENDKEY | 旧 Server酱变量 | 否 | 空 | estimate_push.py、notify.py |
| PUSHPLUS_TOKEN | PushPlus | 否 | 空 | estimate_push.py |
| PUSHPLUS_TOPIC | PushPlus topic | 否 | 空 | estimate_push.py |
| PUSHPLUS_CHANNEL | PushPlus channel | 否 | wechat | estimate_push.py |
| NOTIFY_WEBHOOK_URL | 自定义 Webhook | 否 | 空 | estimate_push.py |
| FORCE | 绕过人工时间/状态限制 | 否 | false | estimate_push.py、notify.py |
| PUSH_SLOT | 人工推送窗口 | 否 | 空 | estimate_push.py |
| SCHEDULE_CRON | 人工任务计划元数据 | 否 | 空 | estimate_push.py |
| ESTIMATE_PROXY_URL | 人工估值代理 | 否 | 与 Worker 默认端点一致 | estimate_push.py |
| ESTIMATE_PROXY | 旧代理变量别名 | 否 | 空 | estimate_push.py |
| WORKER_TOKEN | 人工脚本调用后端 | v8 写是 | 空 | estimate_push.py |

已确认的作用域缺口：

- OVERSEAS_NON_TRADING_DATES 只传到预测步骤，校准与审计步骤也读取但 workflow 未传。
- PUSHPLUS_CHANNEL 当前 workflow 未注入，只会使用 wechat 默认。
- VITE_WORKER_HEALTH / VITE_ESTIMATE_PROXY 未在 Pages workflow 显式声明。
- WORKER_BUILD_SHA 必须由部署脚本生成，不能手配 Secret。

---

# 十一、依赖情况

## 11.1 前端

生产依赖均有真实消费者：

| 依赖 | 用途 | 结论 |
|---|---|---|
| vue、vue-router | 应用与 hash 路由 | 保留 |
| pinia | app/funds/watchlist Store | 保留 |
| vant | 移动端 UI 和 toast | 保留 |
| echarts | Chart.vue | 保留；已独立分块 |
| html-to-image | Report/Story 图片导出 | 保留；动态导入 |
| vite-plugin-pwa | Workbox PWA | 保留 |
| Vite/TypeScript/Vitest/vue-tsc | 构建、测试、类型检查 | 保留 |
| unplugin-vue-components / Vant resolver | Vant 按需导入 | 保留 |

frontend/package-lock.json 存在。生产依赖 npm audit（官方 registry）为 0 vulnerabilities。未发现可以安全直接删除的 package；问题主要是未使用 wrapper 和代码，而不是依赖包。

## 11.2 Worker

Worker 没有 runtime npm dependencies；devDependencies 为 Cloudflare types、TypeScript、Vitest、Wrangler，均有用途。worker/package-lock.json 存在。

- npm audit --omit=dev：0。
- 全量 npm audit：6 个 high，直接受影响项是当前锁定的 Wrangler 4.110.0，传递涉及 miniflare、sharp、undici、nanoid、postcss。
- 风险位于开发/构建/发布工具链，不在已部署 Worker bundle；但 Wrangler 持有发布权限，应单独升级并跑完整回归。

## 11.3 后端与工具

| 文件/依赖 | 用途 | 结论 |
|---|---|---|
| backend/requirements.txt: fastapi | API/Pydantic 集成 | 保留 |
| uvicorn[standard] | ASGI 服务 | 保留 |
| requests | 东方财富等同步请求 | 保留 |
| backend/requirements-dev.txt: pytest | 测试 | 保留 |
| tools/requirements-enrich.txt: akshare==1.18.83 | 离线指数富集 | 保留在工具环境，不进入运行镜像 |
| tools/requirements-enrich.txt: requests==2.34.2 | 离线网络任务 | 保留 |

问题：

- pydantic 被直接 import，却只通过 FastAPI 传递安装；PyYAML 被测试使用，却未在 dev requirements 直接声明。
- 运行依赖只写 >=，没有 lock、上限或 hash，后端构建不可完全复现。
- pip check 本轮通过，未发现 broken requirements。
- 不存在 pyproject.toml、Poetry/Pipenv lock、Cargo.toml、Tauri/Electron 依赖。
- requirements.txt 中 akshare 的“后续接入”只是注释，不代表后端备源已实现。

---

# 十二、代码质量检查

## P0 — 阻塞 / 严重 Bug

| 问题 | 文件与位置 | 影响 | 建议修复 |
|---|---|---|---|
| 公共 V8 接口返回完整持仓/组合资产，服务端自选也公开 | backend/main.py:421-442,540-542,760-762；backend/models/v8.py:149-175,305-360 | 持久库一旦有真实数据，未认证访问者可读 shares、cost、market_value、account、portfolio_value 和精确权重 | 先关闭公开读取；设计用户级认证或严格脱敏 DTO；加 ASGI 脱敏测试 |
| 生产 V8 审计数据库是 ephemeral | render.yaml:6-19；backend/database/db.py:427-444 | 实例重建会丢决策、持仓、Outcome、通知和幂等记录 | 持久盘/外部数据库，迁移与备份，写入后重启验证 |
| 当前 Worker 源码没有生产部署证据 | worker/scripts/deploy.mjs；CI 33246302147；线上 build_sha=null | Pages/API 与 Worker 版本错位，无法证明自然 Cron 使用当前幂等逻辑 | 修完发布阻断后从干净且与 origin/main 同步的 SHA 执行 npm run deploy，再跑 exact smoke 和自然 Cron |
| 第三方 JSONP 与本地密钥同源执行 | frontend/src/utils/indices.ts:43-65、estimate.ts:568-599、holdings.ts:69-85；gist.ts:53-61、ai.ts:31-52 | 远端脚本/域被污染时可读取 Gist PAT 与 LLM Key；属条件性供应链泄露 | 行情/持仓统一走 Worker/后端 JSON 代理；CSP script-src self；浏览器安全回归 |

## P1 — 高优先级

| 问题 | 文件与位置 | 影响 | 建议修复 |
|---|---|---|---|
| Portfolio Lab 认证契约断裂 | backend/main.py:701-703；frontend/src/api/client.ts:650-657；PortfolioLabPage.vue:119 | 页面线上稳定 401；不能把 Admin Token 下发浏览器 | 引入用户级/BFF 边界，或改为可信纯前端计算 |
| V8 组合 Outcome 链未闭环 | worker/src/index.ts:805-815；frontend/src/pages/OutcomesPage.vue:23 | 后端组合快照不结算，用户只看到 v7 结果 | Worker 调 portfolio settle；前端切 V8 查询并保留迁移说明 |
| Story 缺失数据被转为 0 | StoryPage.vue:62-85 | 市值、成本、收益和 LLM 摘要可能虚假 | 复用 portfolioCoverage；完整性不足时显示不可用，不聚合 |
| 详情路由参数变化不重新加载 | FundDetailPage.vue:24,149-152,375 | URL 已是基金 B，页面仍显示基金 A | code 改 computed，watch resetAndLoad immediate |
| Home/Watch/Detail 的 V8 门禁不一致 | decisionView.ts:103-161；homeActionCenter.ts:38-58；fundDetailV8Presenter.ts:131-202 | 同一快照在不同页面给出不同动作 | 抽出统一 evaluator，并用同一 fixtures 契约测试 |
| DCA 一次性基准使用日点而非月轴，缺值转 0 | DcaCalc.vue:61-67 | 对比期间错位，可能显示虚假全损 | 在 dca.ts 建同月轴 nullable 基准函数 |
| official_nav 代理契约前后冲突 | backend/service/eastmoney.py:149-153,189-193；models/api.py:172-188；worker/src/valuation.ts:881-929 | 后端可能拒绝 Worker 正式净值并降级；公开 estimate_change 语义混乱 | 规范 value_change；official_nav 的 estimate 字段为 null；保留旧别名并加 wire test |
| 部分失败 V8 批次仍被幂等 complete | backend/service/v8_decisions.py:350-383 | 暂时失败项目无法用相同 request_id 补齐，可能留下孤链 | 仅全成功 complete，或保存逐项状态支持恢复 |
| 公共 GET 可 force 上游和触发重计算/写缓存 | main.py:84-93；service/repo.py:219-268 | 滥用网络和 CPU，错误 code 污染源健康统计 | 六位 code 校验；限制 force；给昂贵 GET 限流/缓存 |
| 新用户无持仓录入 UI | stores/watchlist.ts:166-188；调用仅在测试 | 资产、穿透、故事、组合实验室对新用户不可达 | 在自选/资产页提供新增编辑与校验 |
| 指数缓存和导出报告 stale 披露不足 | indices.ts:23-26,111-117；IndexBar.vue；ReportPage.vue:126-190 | 历史值可能被当当前值；分享报告隐去过期状态 | 缓存带 fetchedAt/valueDate/max age；报告展示来源和 stale |
| Worker 发布工具链 6 个 high | worker/package-lock.json | 发布凭据所在开发链受已知漏洞影响 | 单独升级 Wrangler/lock，99 tests + typecheck + dry-run |
| 海外日历只到 2026 | 三个 tools/overseas*.py 的内置日历 | 2027 会 calendar_unsupported | 统一日历模块并建立年度审核更新任务 |

## P2 — 中优先级

| 问题 | 文件与位置 | 影响 | 建议修复 |
|---|---|---|---|
| LLM 无超时/重试，NL JSON 无运行时校验 | frontend/src/utils/ai.ts:71-103；nlselect.ts:26-31 | UI 卡住或异常模型输出导致错误筛选 | AbortController timeout；显式 schema/枚举/范围校验 |
| Gist 合并依赖客户端时钟，push 整文件且无单飞/CAS | stores/watchlist.ts:61-70,103-107,214-215；worker/index.ts:1069-1112 | 多设备/重叠 Cron 最后写入覆盖新状态 | revision/ETag、上传前拉取合并、串行队列 |
| 穿透覆盖率排除未定价基金 | LookthroughPage.vue:28-38；utils/lookthrough.ts:114-171 | 缺净值时仍可能显示 100% | 分开显示估值覆盖与披露覆盖 |
| 组合目标权重只在页面内存 | PortfolioLabPage.vue:57-63 | 刷新后丢失 | 增加 target-only Store 更新和 Gist schema 兼容 |
| 经理数据 freshness 未传到 UI | utils/managers.ts:91-127；ScreenPage.vue:125-150 | 旧数据看起来仍有效 | loader 返回 updated/ageDays/stale |
| V8 跨页 N+1 且无共享缓存 | Home/Watch/Detail V8 loader | 20 只自选可能约 3N 请求，放大 Render 冷启动 | V8 Store、请求去重/并发上限、可选批量读 |
| 人工 estimate_push 未迁到 V8 通知 claim | tools/estimate_push.py:146-214,670-706,852-985 | 14:40 后非 FORCE 应急不可用；歧义送达可重复 | 与 Worker 共用 claim/终态，或明确退役为只诊断 |
| OVERSEAS_NON_TRADING_DATES 作用域不一致 | .github/workflows/overseas-accuracy.yml:25-51 | 预测/校准/审计可能使用不同日历 | 提升到 job env |
| Worker 公开接口无限流、缓存键接受任意 Origin | worker/src/index.ts:336-417,483-514 | 单请求最多放大约 45 个上游 GET | Cloudflare rate limiting；规范缓存键；未知 Origin 不入键 |
| Worker 自选数量与后端 50 上限不一致 | worker/src/index.ts:82-103；backend/models/api.py:207-209 | 超过 50 时整批失败 | 显式限制或分批，返回可解释状态 |
| Worker deploy 只查 dirty，不查分支/远端 | worker/scripts/deploy.mjs:38-52 | 干净旧分支也能覆盖生产，虽会被事后 smoke 发现 | 要求目标 SHA、main、origin/main 一致 |
| 后端限流和源健康仅进程内 | service/security.py、service/eastmoney.py | 重启清零，多实例不一致 | 外部共享限流/遥测或明确单实例边界 |
| OpenAPI/异常映射不完整 | backend/main.py 多数路由 | 调用方无法依赖状态契约，故障常被伪装 404 | response_model + responses；保留错误分类 |
| 组合评价采用当前权重，现金收益固定 0 | service/v8_repo.py:1423-1459；models/v8.py:400-404 | 评价口径可能不等于建议目标组合 | 明确 current/target 评价模型并版本化 |

## P3 — 低优先级 / 技术债

| 问题 | 文件与位置 | 影响 | 建议 |
|---|---|---|---|
| 大文件单体 | v8_repo.py 约 2214 行、decision_v2.py 约 1259 行、worker/index.ts 约 1397 行、AssetsPage.vue 约 811 行 | 审查和回归成本高 | 按存储/结算/通知、协议/路由/调度、领域/UI 拆分 |
| 无 lint、unused、coverage 门禁 | package scripts、tsconfig、后端配置 | 死代码与风格漂移不会失败 | 增加 ESLint/ruff 或等价工具及轻量 coverage 基线 |
| 旧静态产物残留 | public/data/screener、managers | Pages/仓库多约 10 MB 重复数据 | 生成后删 manifest 未引用分片；兼容确认后删 monolith |
| README 与真实实现漂移 | README.md、CLAUDE.md | 交接者误判 IndexedDB、Pages 顺序、人工推送角色 | 按代码修订文档 |
| 无 404 页面 | router/index.ts | 错误 URL 空白/不友好 | 添加轻量 NotFound |
| 未使用 wrapper / helper | client.ts、utils/resilience.ts、watchlist clearCloud | 维护面扩大 | 先做引用/生产遥测，再删除或接入 |

---

# 十三、重复代码与历史遗留

## 13.1 已确认的重复/遗留

- v7 与 V8 各有 decision、portfolio decision、outcome 和 idempotency 存储/API。
- REST watchlist 与 localStorage/Gist watchlist 并行，前端只用后者。
- tools/estimate_push.py 与 Worker Cron 都能发送估值通知，但契约不同。
- tools/notify.py + notify.yml 是旧信号通知人工链。
- 海外交易日历在 overseas_accuracy.py、calibrate_overseas.py、audit_overseas_accuracy.py 重复。
- 五个数据 workflow 重复远端 base 检查、提交和 CI dispatch 逻辑。
- Screener 当前 manifest 引用 21 个分片，但目录有 42 个；21 个旧分片未引用，约 2.98 MB。
- Managers manifest 引用 9 个分片，但目录有 18 个；9 个旧分片未引用，约 2.07 MB。
- legacy screener.json 约 2.98 MB，managers.json 约 2.07 MB，与分片格式并存。
- docs/ROADMAP、ROADMAP-V2、ROADMAP-V3、ITERATION-PLAN、V8 原型/审计描述不同阶段，部分已过时。
- README 声称 IndexedDB 存储，但实际只有 frontend/src/utils/cache.ts 的“未来可切换”注释，没有 IndexedDB 实现。
- CLAUDE.md 仍称 estimate_push.py 为“定时推送脚本”，实际正式 Cron 已迁到 Worker。

未发现需要报告的大段注释代码或明确 FIXME 阻断。TODO/注释中的 akshare 备源是占位，不是已实现能力。

## 13.2 建议删除候选清单

以下仅是候选，本轮不删除：

1. Manifest 未引用的旧 screener/managers 分片；可由生成脚本确定性清理。
2. legacy screener.json / managers.json；先确认旧客户端兼容窗口和 fallback 访问日志。
3. frontend/src/api/client.ts 的 getDecision、postPortfolioDecisions、REST watchlist、未接 UI 的 V8 policy/registry wrapper；先确认外部消费者。
4. frontend/src/utils/resilience.ts 中无外部引用的 sourceOk、allSourcesOk、withSWR、retry、checkBackend。
5. watchlist Store.clearCloud；若不补 UI 可移除。
6. tools/validate_signal.py；当前没有代码、workflow 或测试引用。
7. tools/notify.py + .github/workflows/notify.yml；确认旧信号人工通知不再使用后退役。
8. tools/estimate_push.py + manual-estimate-push.yml：不能直接删除，必须在“升级到 V8 claim”与“退役”中二选一。
9. backend/strategy/analyze.py::analyze_fund；主路由当前自行聚合，仅导出未调用。
10. backend/models/api.py 的 WorkerDecisionRequest 别名、v8_repo.policy_history 等无生产消费者代码；先通过静态引用和外部 API 清单确认。
11. _legacy_v8 修复表；必须先备份并确认不再需要取证。

明确暂时保留：

- DecisionCard.vue 和 v7 analyze/decision：详情仍使用。
- v7 outcomes：当前 Outcomes 页面仍使用。
- worker/valuation.ts 的旧公开字段别名：FundVal 等旧客户端仍可能依赖。
- gist.ts 的旧 ID 恢复、写锁、tombstone、复合账户 ID：旧设备迁移尚未证明完成。
- tools/fund_index_map.json：backend/strategy/index_valuation.py 真实读取。

---

# 十四、当前 Bug / 风险

## 14.1 风险矩阵

| 类别 | 真实判断 | 依据/边界 |
|---|---|---|
| 数据泄露 | 高 | 公共 V8 DTO 暴露持仓/组合；浏览器 JSONP 与本地 Key 同源 |
| 数据丢失 | 高 | Render ephemeral SQLite；Gist 整文件无 CAS |
| 状态不同步 | 高 | 详情路由复用、三处 V8 门禁不一致、V8 组合链断 |
| 数据可信度 | 中高 | Story/DCA/IndexBar/Report/Lookthrough 有明确误导路径 |
| 数据库并发 | 中 | WAL、busy timeout、BEGIN IMMEDIATE 已缓解；多实例启动迁移未证明 |
| Race Condition | 中 | Gist push/Cron 状态可能最后写入覆盖；后端 notification claim 可阻止重复发送 |
| 网络异常 | 中 | Worker 有边界；后端 requests 无 retry/backoff/circuit breaker；LLM 无 timeout |
| 权限绕过 | 高 | 不是 token 校验被绕过，而是敏感 GET 设计为公开 |
| XSS / 供应链脚本 | 高 | Vue 文本默认转义未见直接 v-html 问题；实际风险来自动态 JSONP script |
| SQL Injection | 未发现明确路径 | 仓库 SQL 写入以参数绑定为主；仍应由 ASGI/API 测试持续验证 |
| Path Traversal | 未发现公共攻击面 | 文件路径来自配置或固定目录，不来自公开用户输入 |
| Command Injection | 未发现公共攻击面 | 应用不执行 shell；deploy.mjs 参数固定且拒绝透传 |
| Windows 路径兼容 | 低/待持续验证 | Python 使用 pathlib；CI 主要 Linux，本轮 Windows 测试通过 |
| 大文件/性能 | 中 | 静态重复文件、ECharts 182.30 KiB gzip、V8 N+1、后端批量串行 |
| 内存 | 低到中 | 结果接口全量返回、静态数据在浏览器解析；未做大规模压力测试 |
| Streaming | 不适用/缺能力 | LLM 不 streaming；主要问题是无 timeout |
| Tool 无限调用 | 不存在 | 当前没有 Agent Tool loop |
| Secrets 入库 | 未发现 | filename/常见模式扫描未发现已跟踪 secret；不等于运行环境无 secret |

## 14.2 数据可靠性结论

当前用户可见数据只能评为 CONDITIONALLY TRUSTED：

- 正向：V8 稳定 ID、不变快照、QDII 精确日期、不 forward-fill、排行 stale guard、部分 nullable 门禁已实现。
- 反向：Story 会把未知变 0；DCA 基准错轴；IndexBar 旧缓存无日期；Report 丢失 stale 提示；Lookthrough 分母可能排除未定价持仓；official_nav wire contract 不一致。
- 处置原则：未知保持 null/不可用；正式 NAV、盘中估值、下一净值日海外估算必须分别命名；不要用 0 或旧值伪装。

## 14.3 发布与回滚风险

- Pages 在 smoke 前已经部署；README 对顺序描述不精确，所以 smoke 失败不代表 Pages 未更新。
- Worker 没有自动部署；手动部署前应验证 main=origin/main=目标 SHA，并记录 Cloudflare version ID。
- V8 升主版本后 smoke 会强制 durable DB；目前该门禁一定失败。
- Worker 发布后仍需等待属于新 build_sha 的自然 14:30/14:40 记录；手工 /test 或 dry-run 都不能代替。
- 回滚应保留：前端上一个 Pages artifact、Render 上一提交/数据库备份、Cloudflare 上一 version、V8 前 SQLite backup。当前 ephemeral DB 不能提供可靠数据回滚。

---

# 十五、测试情况

## 15.1 测试与门禁实测

本轮只运行测试/构建，没有为了让测试通过而改业务代码。

| 子项目 | 框架/命令 | 结果 | 说明 |
|---|---|---|---|
| 后端 | pytest；python -m pytest | PASS：383 passed in 14.80s | 函数、策略、SQLite、工具和 V8 契约 |
| 后端依赖 | pip check | PASS | 无 broken requirements |
| 前端测试 | Vitest；npm run test | PASS：32 files / 219 tests | Node 环境，以纯函数/源码契约为主 |
| 前端类型 | vue-tsc；npm run type-check | PASS | tsconfig 关闭 noUnusedLocals/Parameters |
| 前端构建 | Vite；npm run build | PASS：1064 modules，16.38s | PWA 61 entries / 677.53 KiB |
| 前端 prod audit | npm audit --omit=dev，官方 registry | PASS：0 vulnerabilities | 默认 npmmirror audit endpoint 404 后改官方 registry 重试 |
| Worker 测试 | Vitest；npm run test | PASS：3 files / 99 tests | Cron、通知、估值和部署包装器 |
| Worker 类型 | TypeScript；npm run check | PASS | tsc --noEmit |
| Worker prod audit | npm audit --omit=dev | PASS：0 vulnerabilities | 仅生产依赖视角 |
| Worker 全量 audit | npm audit | WARN：6 high | Wrangler 及其开发链；fixAvailable=true |
| Lint | 无可运行命令 | NOT_RUN | 三端都没有完整 lint 门禁 |
| Coverage | 无配置 | NOT_AVAILABLE | 不能给出可靠覆盖率百分比 |
| 浏览器/PWA E2E | 无 Playwright/Cypress | NOT_RUN | 构建成功不等于安装/离线/移动端通过 |
| 物理 Android / 已安装 PWA | 无自动化 | NOT_RUN | 不得用 viewport 模拟声称已验证 |

前端构建主要块：

- 主入口约 210.4 KiB raw / 80.14 KiB gzip。
- ECharts 约 532.4 KiB raw / 182.30 KiB gzip，已独立且不进入安装预缓存。
- FundDetail 约 19.01 KiB gzip。
- 全局 CSS 约 39.17 KiB gzip。

## 15.2 当前测试覆盖

后端覆盖较好：

- EstimateContext 的正式 NAV / intraday / QDII 矛盾字段和日期语义。
- V8 稳定 ID、不可变触发器、schema 修复和备份。
- 幂等租约、冲突、接管与响应重放。
- 个体 5/20/60 天和 QDII 精确目标日期。
- 组合共同日期、不 forward-fill。
- 通知原子 claim 和阶段状态。
- 富集、静态数据、版本和 workflow 合同。

前端覆盖较好：

- estimate、format、dca、diagnostics、portfolio coverage、screener、managers、Gist 等纯函数。
- V8 Home/Watch/Detail presenter。
- Watchlist Store 复合持仓和删除。
- API timeout 与 Worker runtime normalization。

Worker 覆盖较好：

- 估值源选择、正式净值/持仓模型、请求预算。
- 14:30/14:40 调度、自然 ID、通知 claim 和歧义送达。
- 外部请求超时、重试、大小限制与稳定错误码。
- deploy.mjs 的完整 SHA 和 dirty-worktree 限制。

## 15.3 关键缺口

- 后端没有 TestClient/httpx ASGI 级测试；路由测试多为直接调用函数并手传 _role。
- 没有真实认证依赖、CORS、状态码、OpenAPI、脱敏 DTO 测试。
- 没有 Worker official_nav → FastAPI EstimateContext 的真实 wire test。
- 没有 Portfolio Lab 前后端认证集成测试。
- 没有 V8 组合 settle → 前端展示 E2E。
- 没有生产持久卷写入后重启恢复测试。
- 上游 API 都是 mock，没有提供方 contract canary。
- 没有 50 基金批次、大自选或全量 outcomes 压力测试。
- 没有多进程并发 migration 和历史所有 schema 路径测试。
- 前端没有 @vue/test-utils/jsdom mount；AssetsPage、PortfolioLabPage、WatchlistPage、startup-performance 等测试包含源码字符串断言。
- 没有详情路由参数切换、Story 缺值、DCA 一次性基准、V8 三视图门禁一致性测试。
- 没有 AI timeout/非法 JSON、安全边界测试。
- 没有真实 Gist CAS、多设备时钟漂移、Server酱歧义响应 E2E。
- 没有属于当前 Worker build_sha 的自然 Cron 验证。

## 15.4 CI / 生产门禁

GitHub Actions run 33246302147 的代码测试、Pages deploy、静态数据/全集/Render smoke 成功；最终结论仍是 FAIL，因为 Worker target=d0772ac 而 deployed build 为空。该失败是有效发布门禁，不应忽略或手工改绿。

---

# 十六、当前版本完成度评估

稳定性使用 1–5 分，5 为最高；技术债为低/中/高。

| 模块 | 完成度 | 稳定性 | 技术债 | 说明 |
|---|---:|---:|---:|---|
| Web/PWA 应用壳与路由 | 90% | 4 | 中 | 构建和 PWA 配置稳定；缺 404 与真实 E2E |
| 基金全集/详情/cache | 88% | 4 | 中 | 主功能可用；公共 force、上游重试和异常映射需改 |
| v7 评分/择时/回测 | 85% | 4 | 中 | 成熟兼容链；逐步被 V8 替代 |
| 选基/经理/富集 | 84% | 4 | 中 | 生成门禁较强；经理 freshness、旧分片清理缺失 |
| 自选/估值 | 78% | 3 | 高 | 日常可用；JSONP、Gist CAS、持仓录入缺口 |
| 资产/穿透/组合实验室 | 58% | 2 | 高 | 页面与算法存在；输入、认证、覆盖率、持久化断链 |
| V8 决策内核 | 82% | 4 | 中 | 不可变和幂等基础较强；部分失败 complete 等缺陷 |
| V8 前端行动中心 | 74% | 3 | 中 | 三视图已接，但门禁不统一 |
| V8 Outcome/通知闭环 | 62% | 3 | 高 | 个体/通知代码较全；组合未调度，生产存储不可靠 |
| Story/Report/DCA | 55% | 2 | 高 | 可展示/导出，但有明确数据误导路径 |
| AI 辅助 | 58% | 2 | 高 | Provider 齐全；非 Agent，无 timeout/schema/隔离 |
| Worker 与定时任务 | 72% | 3 | 高 | 99 tests；生产不是当前构建，公开接口和工具链需修 |
| 部署/运维 | 60% | 3 | 高 | Pages/Render 自动化存在；DB 与 Worker 发布门禁未过 |
| 测试工程 | 70% | 3 | 中 | 单元测试数量可观；缺 ASGI/DOM/E2E/lint/coverage |

**当前整体完成度：72%**

判断依据：

- 功能代码完成度约 80%：v7 主链可用，V8 内核和界面已有较大实现。
- 生产就绪度约 55%：隐私边界、持久化、Worker 身份、组合闭环和前端数据语义仍有发布阻断。
- 以“用户数据正确、安全、可恢复、可验证部署”为高权重后综合约 72%。这不是代码行数百分比，也不表示 V8 已完成 72% 的发布。

---

# 十七、下一版本建议

## 必须做

1. 关闭公开敏感读取，建立用户级认证或脱敏 DTO。
2. 把生产数据库迁到持久存储，完成备份、迁移、重启恢复和回滚验证。
3. 移除前端第三方 JSONP 同源执行，改 Worker/后端 JSON 代理并启用 CSP。
4. 修复 official_nav wire contract，保证正式净值不冒充估值。
5. 修复 V8 部分失败批次的幂等完成语义。
6. 接通 V8 组合 settle 和 Outcomes 页面，修复 Portfolio Lab 认证边界。
7. 修复 Story 缺值转 0、FundDetail 路由错配、DCA 时间轴和 V8 门禁不一致。
8. 完成以上门禁后真实部署 Worker 精确 SHA，并等待新构建的自然 Cron 证据。

## 应该做

1. 增加新用户持仓录入/编辑与 target_weight 持久化。
2. 为 IndexBar、Report、Managers 和 Lookthrough 补 freshness/coverage 语义。
3. 增加 ASGI、Vue mount、浏览器 E2E、PWA 升级/离线和数据契约测试。
4. 给公开 Worker/API 增加限流、规范缓存键和批量并发预算。
5. 升级 Wrangler 解决 6 个 high 开发链漏洞。
6. 统一海外交易日历并补 2027，统一 workflow env。
7. 给 LLM 增加 timeout、错误分类和结构化输出校验。
8. 建立审计数据保留/归档和数据库容量监控。

## 可以做

1. V8 共享 Store、请求去重和批量只读接口，降低 N+1。
2. 拆分 v8_repo、decision_v2、Worker index、AssetsPage 和 estimate.ts。
3. 增加 404 页面、可访问性和性能预算。
4. 逐步归档旧路线图、旧分片和确认无消费者的 wrapper。
5. 增加 benchmark outcome；必须先定义可信来源和日期口径。

## 暂时不要做

1. 不要先做通用 Agent、MCP、Tool Registry 或多轮 autonomous loop；当前产品没有该需求基础。
2. 不要做自动交易或把分析动作直接映射为下单。
3. 不要拆微服务或换复杂分布式架构来掩盖当前认证/持久化问题。
4. 不要自动晋级 Challenger 模型或放宽 stale/coverage 门槛。
5. 不要直接删除 v7 API/表、legacy wire 字段或 Gist 迁移保护。
6. 不要仅改 package version 到 8.0.0；V8 发布必须由持久化、精确 Worker 和自然 Cron 证据共同证明。

建议版本策略：先在当前 7.0.1 代码基线上完成安全/数据/基础设施硬化；如果需要中间发布，可使用补丁版本。只有全部 V8 门禁通过后才创建 v8.0.0 tag 和发布说明。

---

# 十八、建议的下一版本任务拆分

## Task 1：关闭公共敏感读取

目标：任何未认证访问都不能获得私人持仓、账户、组合价值、精确权重或服务端自选。

涉及文件：backend/main.py、backend/models/v8.py、backend/models/api.py、backend/service/security.py、backend/tests。

具体修改：建立 public sanitized DTO 与 authenticated private DTO；给三个敏感 GET 加正确依赖；统一 401/403；避免把 Admin Token 当用户身份。

验收标准：ASGI 测试证明匿名响应无敏感字段；授权用户只能读自己的数据；OpenAPI 契约明确；旧公开 UI 仍能用脱敏字段渲染。

风险：可能破坏 Home/Watch/Detail 当前读取；需要先定义单用户部署与多用户身份边界。

依赖：无，第一优先级。

## Task 2：生产数据库持久化与恢复门禁

目标：Render 重启、重新部署后 V8 快照、Outcome、通知和幂等响应不丢失。

涉及文件：render.yaml、backend/database/db.py、docs/DEPLOY.md、post-deploy-smoke.yml、backend/tests/test_v8_migration.py。

具体修改：配置持久卷或外部数据库；明确 FUND_DB/FUND_DB_MOUNT_PATH；迁移前备份；增加写 marker → 重启 → 读取 smoke 和回滚步骤。

验收标准：health 显示非 ephemeral、durable=true；真实重启后 marker 和 V8 链仍在；quick_check/FK check 通过；备份可恢复。

风险：路径/权限、免费套餐限制、双实例迁移。

依赖：Task 1，避免把真实私人数据写入公开可读库。

## Task 3：移除 JSONP 并建立 CSP

目标：第三方响应不再以 script 在应用 origin 执行。

涉及文件：frontend/src/utils/indices.ts、estimate.ts、holdings.ts、worker/src/index.ts、worker/src/valuation.ts、frontend/vite.config.ts、测试。

具体修改：在 Worker/后端新增受限 JSON 代理；校验 code、响应大小、字段和 timeout；前端只 fetch JSON；部署 CSP script-src self。

验收标准：CSP 下功能可用；页面无第三方 script 注入；正常/超时/畸形/上游 5xx 测试；Key 不出现在非目标 Provider 请求。

风险：第三方字段变化、Worker 配额、缓存策略。

依赖：可与 Task 2 并行。

## Task 4：修复正式净值 wire contract

目标：official_nav、intraday estimate、QDII next-NAV estimate 在 Worker、后端和 UI 中保持同一语义。

涉及文件：worker/src/valuation.ts、worker/src/index.ts、backend/service/eastmoney.py、backend/models/api.py、frontend/src/utils/estimate.ts、三端 tests。

具体修改：official_nav 使用 value_nav/value_change；estimate_nav/estimate_change 为 null；旧 est_change 仅作带说明的兼容别名。

验收标准：真实形状 contract fixture 横跨 Worker → FastAPI → UI；缺失不转 0；smoke 分别断言五类 kind。

风险：FundVal 等旧客户端仍依赖旧字段。

依赖：先冻结兼容期，不依赖其他任务。

## Task 5：修复 V8 幂等批次恢复

目标：暂时失败的单项不会把不可恢复的部分批次标成 complete。

涉及文件：backend/service/v8_decisions.py、v8_repo.py、backend/main.py、models/api.py、test_v8_repo.py、test_v8_api.py。

具体修改：选择“全成功才 complete”或“逐项状态 + 可恢复重试”；明确组合快照只能来自完整批次；进程中断可安全接管。

验收标准：单项 5xx、进程中断、lease 过期、请求内容冲突和重复重放测试全部通过；不会重复写已成功快照。

风险：改变 Worker 对 duplicate/processing 的处理。

依赖：Task 2 提供可靠存储。

## Task 6：接通 V8 组合结果闭环

目标：组合快照自动结算，Outcomes 页面显示 V8 结果而不是仅显示 v7 历史。

涉及文件：worker/src/index.ts、backend/main.py、backend/service/v8_repo.py、frontend/src/api/client.ts、pages/OutcomesPage.vue、测试。

具体修改：主窗口调用 portfolio outcomes settle；前端增加 V8 查询和版本标签；无共同日期时明确 pending；保留 v7 兼容分区。

验收标准：从组合 decision fixture 到 5/20/60 结果和 UI 渲染的端到端测试；不 forward-fill；重复 settle 幂等。

风险：大量 NAV 查询和组合隐私。

依赖：Task 1、2、5。

## Task 7：修复前端金融数据正确性

目标：消除已确认的对象错配、未知转 0 和跨页面动作不一致。

涉及文件：FundDetailPage.vue、StoryPage.vue、DcaCalc.vue、utils/dca.ts、utils/portfolioCoverage.ts、utils/v8Decision.ts、三个 V8 presenter、相关 tests。

具体修改：监听 route code 并重置请求；Story 使用完整性聚合；DCA 使用同月轴 nullable 基准；统一 V8 evaluator。

验收标准：A→B 详情切换；缺 NAV/成本/日收益；12 个月日频；missing/stale/ID mismatch/low-confidence fixtures 全部通过且 UI 一致。

风险：改变用户已有数字显示，应在 release note 明确“修正错误口径”。

依赖：可与 Task 2–6 并行。

## Task 8：补齐持仓录入与 Portfolio Lab 边界

目标：新浏览器用户能完成添加基金、录入持仓、目标权重、资产/穿透/组合实验室全链。

涉及文件：WatchlistPage.vue、AssetsPage.vue、PortfolioLabPage.vue、stores/watchlist.ts、api/client.ts、backend/main.py。

具体修改：增加 shares/cost/account/target_weight 表单；target-only 持久化；重新设计 Portfolio Lab 为用户认证 API 或可信纯前端计算。

验收标准：空 localStorage/Gist 的 E2E 可走完全链；数值校验、取消、离线、Gist merge 和刷新持久化通过；浏览器绝不保存 Admin Token。

风险：Gist schema 兼容与多账户复合键。

依赖：Task 1 的身份决策；Task 3 后安全边界更清晰。

## Task 9：数据 freshness 与覆盖率一致化

目标：IndexBar、Report、Managers、Lookthrough 都能诚实展示日期、来源、陈旧和未覆盖。

涉及文件：utils/indices.ts、components/IndexBar.vue、ReportPage.vue、utils/managers.ts、ScreenPage.vue、LookthroughPage.vue、utils/lookthrough.ts。

具体修改：为缓存加 fetchedAt/valueDate/max age；导出报告带 stale；经理 loader 返回 dataset metadata；分离估值覆盖与持仓披露覆盖。

验收标准：过期/部分缺值 fixtures 不显示“当前”或 100%；导出图片含醒目 stale；北京时间边界测试。

风险：UI 信息密度增加。

依赖：Task 7 可共享 nullable/coverage 工具。

## Task 10：Worker 与定期任务加固

目标：公开接口、人工应急、交易日历和发布包装器达到可运维状态。

涉及文件：worker/src/index.ts、worker/scripts/deploy.mjs、tools/estimate_push.py、三个 overseas 脚本、overseas-accuracy.yml、worker/package-lock.json。

具体修改：限流和规范缓存键；自选显式分批；人工应急迁 claim 或退役；统一日历并补 2027；job env 一致；升级 Wrangler；部署前校验 main/origin/main/目标 SHA。

验收标准：99+ tests、typecheck、audit 无 high 或有审计豁免、dry-run；14:40 状态应急测试；2027 休市日测试；旧分支部署被拒绝。

风险：Cloudflare API/费用、上游配额、lockfile 大变更。

依赖：不负责真实发布；可独立完成。

## Task 11：LLM 可靠性与安全

目标：AI 功能失败时可控，结构化筛选不能接受畸形输出。

涉及文件：frontend/src/utils/ai.ts、nlselect.ts、interpret.ts、story.ts、相关 tests。

具体修改：统一 AbortController timeout；稳定错误分类；JSON schema/手写 validator；长度/范围限制；清晰的 Key 存储警告，评估 session-only 模式。

验收标准：timeout、401、429、5xx、非 JSON、非法 sort/type/极值测试；失败不改变筛选状态；不记录 Key。

风险：Provider API shape 差异。

依赖：Task 3 先关闭同源第三方脚本风险。

## Task 12：发布 v8.0.0 门禁

目标：只在生产证据完整时更新版本、tag 和发布说明。

涉及文件：frontend/package*.json、worker/package*.json、frontend/src/version.ts、backend/main.py 或版本常量、CHANGELOG.md、README.md、CI/smoke。

具体修改：运行全门禁；同步版本；提交/tag；部署 Pages/Render/Worker；验证 exact SHA、durable DB；等待属于该 SHA 的自然 14:30/14:40。

验收标准：三端本地/CI 全绿；Pages/Render/Worker SHA 一致；DB 重启验证；自然 Cron 写入 last_cron_build_sha 且通知状态可审计；回滚步骤已演练。

风险：这是发布任务，不应夹带业务修复；自然 Cron 需等待交易日。

依赖：Task 1–10 的发布阻断均关闭。Task 11 可在明确禁用 AI 时延后，但安全提示必须存在。

---

# 十九、关键文件索引

| 想了解 | 先看文件 |
|---|---|
| 项目约束 | AGENTS.md |
| 当前发布状态 | CHANGELOG.md、.github/workflows/post-deploy-smoke.yml |
| 前端入口/壳 | frontend/src/main.ts、frontend/src/App.vue |
| 前端路由 | frontend/src/router/index.ts |
| 后端 API | backend/main.py |
| 前端 API 契约 | frontend/src/api/client.ts |
| SQLite schema/migration | backend/database/db.py |
| v7 数据缓存 | backend/service/repo.py |
| 上游数据 | backend/service/eastmoney.py |
| V8 领域模型 | backend/models/v8.py、backend/models/api.py |
| V8 决策编排 | backend/service/v8_decisions.py |
| V8 存储/幂等/Outcome/通知 | backend/service/v8_repo.py |
| V8 状态机 | backend/strategy/decision_v2.py |
| 权限/限流 | backend/service/security.py |
| QDII 审计证据 | backend/service/overseas_evidence.py |
| Worker HTTP/Cron/通知 | worker/src/index.ts |
| Worker 估值 | worker/src/valuation.ts |
| 外部请求边界 | worker/src/external.ts |
| Worker 发布 | worker/scripts/deploy.mjs、worker/wrangler.toml |
| 前端状态 | frontend/src/stores/app.ts、frontend/src/stores/funds.ts、frontend/src/stores/watchlist.ts |
| 估值语义 | frontend/src/utils/estimate.ts |
| Gist 迁移/同步 | frontend/src/utils/gist.ts、stores/watchlist.ts |
| AI / LLM | frontend/src/utils/ai.ts、frontend/src/utils/interpret.ts、frontend/src/utils/nlselect.ts、frontend/src/utils/story.ts |
| V8 首页/自选/详情 | frontend/src/components/HomeActionCenter.vue、frontend/src/components/watchlist/decisionView.ts、frontend/src/components/FundDetailV8Panel.vue |
| 资产/组合 | frontend/src/pages/AssetsPage.vue、frontend/src/pages/PortfolioLabPage.vue、frontend/src/pages/LookthroughPage.vue |
| 选基数据 | frontend/src/utils/screener.ts、frontend/src/utils/managers.ts、tools/screener.py、tools/managers.py |
| 海外模型 | tools/overseas_accuracy.py、tools/calibrate_overseas.py、tools/audit_overseas_accuracy.py |
| 定期任务 | .github/workflows |
| 后端测试入口 | backend/pytest.ini、backend/tests |
| 前端/Worker 测试 | frontend/vitest.config.ts、worker/src/*.test.ts |
| 部署配置 | render.yaml、.github/workflows/deploy.yml、worker/wrangler.toml |

---

# 二十、给下一位 AI 的交接摘要

## AI HANDOFF

1. 这是一个面向中国公募基金的网页和渐进式应用。用户可以选基、维护自选、查看基金详情与盘中估值、运行评分择时和回测，并做资产、持仓穿透及组合分析。前端负责交互和部分本地计算，后端负责数据缓存、策略与审计存储，边缘 Worker 负责估值、工作日两次定时决策和微信通知，自动化任务负责生成选基、经理、持仓、指数和海外精度数据。项目不是桌面程序，也没有智能体、工具调用、模型上下文协议或自动交易。

2. 当前正式版本仍是 7.0.1，主分支提交为 d0772acf4a423946dfcfd22779fd2bc72c76e609，比版本标签多六次提交。V8 候选已经实现不可变证据、持仓、决策、策略、结果和通知模型，使用稳定哈希标识、幂等租约和响应重放，并接入首页、自选、详情以及定时通知链。它仍是候选而非正式版；不要因为代码和变更日志出现 V8 就提前修改版本、建立标签或宣称上线。

3. 架构边界必须牢记：页面会同时访问 FastAPI、Worker、Gist、静态站点数据和用户自选的语言模型；后端路由进入旧仓储或 V8 编排与仓储，再调用策略模块和 SQLite；Worker 从 Gist 读取自选，经多源估值后向后端追加决策及通知事件。前端状态主要在浏览器本地存储，并没有 README 所说的 IndexedDB。Worker 也没有耐久对象或独立数据库，状态仍通过 Gist 整文件保存。

4. 最近一轮的核心不是笼统的界面优化，而是建立可追溯闭环：快照禁止修改和删除，海外基金按精确的下一正式净值日评价，组合评价不向前填充缺失净值；主窗口和补偿窗口复用自然请求标识，通知先原子认领再发送；过期选基数据会关闭高风险筛选。最后几次自动提交只是海外精度结算，当前海外证据为空代表没有待部署证据，不是生成失败。

5. 开始工作时先读 AGENTS.md、CHANGELOG.md、backend/main.py、backend/database/db.py、两份 V8 服务、V8 决策状态机、Worker 的 index.ts 和 valuation.ts、前端 API 契约、自选 Store 及三个 V8 展示器。随后检查分支、远端和工作树，再运行本文件记录的三端测试。若发现用户未提交的修改，必须原样保留，不能通过重置或清理来获得干净状态。

6. 四个最高风险决定下一轮顺序。第一，匿名接口会返回份额、成本、账户、组合价值和精确权重。第二，生产后端使用临时 SQLite，实例重建会丢失决策、结果、通知和幂等证据。第三，保存 Gist 与模型密钥的页面会同源执行第三方 JSONP。第四，生产 Worker 没有构建提交标识，无法证明当前代码真正部署。务必先关闭匿名敏感读取，再迁移持久存储，避免把真实私人数据写进可公开查询的数据库。

7. 功能链还有明确断点：定时任务只结算个体结果，没有触发 V8 组合结算，结果页仍读取旧接口；组合实验室后端要求管理令牌而浏览器不能安全持有；新用户没有录入持仓的界面；数据故事会把缺失净值和成本变成零；同一详情组件切换基金后网址与内容可能错配；三个 V8 视图对缺失和过期的阻断不一致；定投的一次性比较使用错误时间轴。任何修复都必须让未知保持为空或不可用，绝不能用零或旧值掩盖。

8. 推荐迭代顺序是：敏感数据授权与脱敏、持久数据库及重启证明、移除 JSONP 并启用内容安全策略、统一正式净值传输口径、修复部分失败批次的幂等恢复、接通组合结算与展示、修复前端数据正确性并增加持仓入口、加固 Worker 和年度交易日历，最后才执行精确提交部署。每一步都应有接口级、跨端契约或真实浏览器测试，不能只增加读取源码文本的断言。

9. 不要轻易改变规范化 JSON、稳定标识、不可变触发器、海外目标净值日期、组合共同日期、通知自然标识、Gist 删除墓碑、复合账户键以及旧估值字段别名，它们承担审计或兼容责任。旧版接口、表、人工推送、旧结果页和静态大文件也不能直接删除；应先列出消费者、完成迁移、观察兼容窗口，再分阶段退役。禁止放宽陈旧、覆盖率和模型晋级阈值来让门禁表面通过。

10. 本地基线为后端 383、前端 219、Worker 99 项测试全部通过，前端构建和两端类型检查也通过；但项目没有代码风格、覆盖率、真实后端路由、页面挂载、端到端浏览器、物理设备或新构建自然定时验证。静态站点和后端已部署当前提交，Worker 尚未证明一致。只有匿名数据安全、数据库持久、三端提交完全一致、生产冒烟通过，并出现属于新 Worker 构建的自然 14:30/14:40 记录后，才能同步版本、建立标签并宣布 v8.0.0。
