# v9.0.0 执行记录

记录日期：2026-09-30（Asia/Shanghai）。依据 [统筹升级方案](V9.0.0-UPGRADE-PLAN.md) 实施，不是 v9 发布说明。

## 当前状态

Iteration 18 的本地基础已实现并验证。阶段出口未通过；不得迁移真实持仓或授予正式发布资格。版本仍为 `8.0.0`，基线为 `706b6ade3cec000319e4dd5eb6bd7d6cb7c510ad`；实施前重新读取的 GitHub main 与该基线一致。本批代码尚未 commit/push，未改变线上服务、数据库或旧 Gist。

| 工作项 | 已落地 | 未完成的出口 |
| --- | --- | --- |
| I18-01 | 核对正常访问路径，已确认 Turso 登录；本批日志未打印真实 Token | Turso 新凭据生成、Render 配置/验证、旧凭据撤销；页面内容控制超时 |
| I18-02 | Owner 会话 JSON 合同、初版同步/证据合同、权限与 `fund_only` 聚合不变量 | 同步字段封闭校验、任务/schema 迁移合同与对应实现；初版合同不等于接口已实现 |
| I18-03 | 后端会话路由、私人读取鉴权、内存会话、前端登录/退出、私有请求取消与清理 | 安全初始化生产 Owner 密码、部署并验收生产私人读取；多设备真实业务流程 |
| I18-04 | 专属本地 SQLite 的真实 Holding → Evidence → Policy → Decision 仓储链、幂等/故障重放、跨进程读回 | 生产应用路径隔离、Turso 不确定提交、实际 Render 重启读回 |
| I18-05 | 本地 SQLite backup 到不同文件后，经同仓储核对字段投影/引用/约束/摘要 | Turso 独立旁路恢复、受控生产导出与真实 RPO/RTO |
| I18-06 | 正式证据/独立当前元数据合同、严格 HMAC/过期/资源漂移验证器及只读 CLI；正式 gate 继续失败关闭 | 受保护真实操作执行器、证据生成器、正式 workflow 接入 |

Iteration 19–21 尚未完成：未新增真实持仓编辑、云同步、Gist 数据/机器消费者迁移；I20-01 指数重试/列选择的局部逻辑已修复，但数据源恢复、其他定期任务与连续自然观察未通过。私人 API 消费与注销清理已为后续工作铺路，但不算整个个人决策闭环已通过。

## 本批实现

- 后端新增 `service/owner_sessions.py`，提供 `/api/v2/owner/session` 的 POST/GET/DELETE。30 分钟短会话、最多 8 个；服务端仅存 Token 摘要，重启即失效。Owner 只获得声明的私人 scope，不可进入 Admin/Worker 运维写接口。保留机器私人读取兼容。
- 独立 `OWNER_PASSWORD_HASH` 使用随机盐 PBKDF2-HMAC-SHA256，600,000–2,000,000 次；初始化密码 15 个 Unicode 字符起、最多 512 UTF-8 字节。登录 body/异常不回显密码；登录限频、校验并发与输入尺寸有界。密码哈希变化立即撤销原会话。
- 会话与私人响应（包含鉴权失败）使用 `no-store`；CORS 保持明确来源。`render.yaml` 声明 `OWNER_PASSWORD_HASH` 且固定 `--workers 1`，没有写入任何真实值或自动修改云端配置。进程内限频与会话不能作为多实例方案使用。
- 前端新增模块私有内存会话和 Vant 登录面板。Owner Token 不进入 localStorage/sessionStorage/URL/SW；只向审核过的私人 API 附加 Bearer。退出/到期/401 清理快照、取消请求、拒绝迟到响应。公开行情保持可用；不将 Admin Token 交给浏览器个人分析。
- 请求层统一覆盖 fetch 和 JSON 解析的取消/超时，并正确处理 204/205。采用既有主题与三项主导航，没有增加依赖。
- `tools/persistence_candidate.py` 仅允许工具独占创建的本地候选数据库和 `v9-acceptance-*` namespace；拒绝远端 URL、旧数据库和未标记 schema。receipt 明确 `durable=false`、`formal_release_verified=false`，不能用于正式放行。

权限、错误和证据边界详见 [V9-CONTRACTS.md](V9-CONTRACTS.md)。旧 Gist/PAT 路径为兼容保留，不能提前撤销或删除。

## 本轮验证证据

以下结果均来自本次实施，不复用历史测试数量。

| 验证 | 结果 | 范围/限制 |
| --- | --- | --- |
| 后端完整 `python -m pytest -o addopts='' -q` | 717 passed，36.25 秒 | Windows / Python 3.14.4；33,561 条依赖弃用警告，非生产 Python 3.12 环境证明 |
| 最后 workflow/version/Owner cache 契约复核 | 26 passed | 声明式部署修改后重新运行；不是新增 26 个用例 |
| 独立 Owner/缓存/写权限安全复核 | 未发现阻断问题；82 passed | 重叠测试不累加到 717；额外深嵌套合成 JSON 统一 422、无输入回显；未访问云端 |
| 前端完整 `npm run test` | 35 文件 / 260 passed | 包含真实 Vue 组件挂载、会话与权限/竞态测试 |
| `npm run type-check` | passed | 不能替代运行时验收 |
| `npm run build` 与 PWA 构建门禁 | passed / 7 检查通过 | 不证明用户已安装的旧 PWA 升级或真实手机离线恢复 |
| 移动 viewport 390×844 本地 UI | 登录 → 退出 204 → 刷新仍未登录；存储无 Owner Token | 合成密码、空自选、隔离 SQLite；不是实际手机或云端持仓旅程 |
| 仓储工具专项与既有 storage/v8_repo/工具回归 | 61 passed | 新本地工具测试 22 个；跨进程与旁路恢复包含在测试内，不额外累加到 717 |
| `git diff --check` / 三份 JSON 解析 | passed | Git 提示 LF/CRLF 转换，不当作错误 |

本地 UI 的登录/退出/刷新旅程最后截图保存在执行机 Temp 中，文件为 `fund-compass-v9-owner-local-smoke.png`，SHA256 `4050a46d9ceaa2ce1c408a72aca8568d4091f0e4a6cf1b7fbae3506808b47923`。临时本地 API/Vite 测试进程已停止，合成测试库保留在 Temp，不触碰真实数据库。截图证明未登录清理后的页面，不包含真实私人资产。

## 继续执行 · 2026-09-30

本轮在上一轮本地基础上新增/复核以下结果，前述 717 个用例属于上一轮记录，不冒充当前数量。

### I18-06 验签预检

- `tools/storage_release_evidence.py` 使用标准库，严格验签并绑定受保护执行器独立取得的当前元数据；拒绝 scope/资源/SHA/schema/配置/boot/生成器 run 漂移、重复字段、额外字段、非有限值、日期/恢复不一致和过期记录。
- `tools/verify_storage_evidence.py` 只读取受限文件，key/key_id 仅取专用环境配置；拒绝已知机器/provider 凭据复用、非法 Unicode 配置与不合法输入，不打印秘密、文件路径或 payload。独立安全复核发现的复用漏检/编码异常已修复并补回归。
- 没有任意 payload 签名入口、数据库写入、网络调用或正式放行。CLI 成功仍明确 `formal_release_verified=false`。执行器尚未真实完成生产链，因此保持旧正式 workflow 和 gate 阻断，不把验签通过当成存储耐久证明。

### I20-01 局部修复与源状态

- 当前 symbol 的有界重试缓存成功 PE/PB，只在真实源日期完全相同时组装；不跨候选、任务或旧产物拼接。
- 只接受精确“滚动市盈率”“市净率”列和唯一日期列；拒绝静态 PE、等权、中位数、未知或重复列。继续保持六核心 6/6、30 条分位样本门槛、真实零/空值与失败不覆盖旧文件。
- 新增 25 个用例；没有改实际指数 artifact、依赖版本、workflow 或 unsupported 合同。
- 只读诊断确认 9/28 [run 36385342158](https://github.com/AureliusWu/fund-compass/actions/runs/36385342158) 核心 3/6。AKShare [官方修复](https://github.com/akfamily/akshare/commit/72de989c36072d9c45b6d9cd1d7f0e8ccb9cb504) 只改进 403/缺 CSRF 的错误诊断，不能解除访问限制。
- 本轮无凭据低频请求在 `2026-09-30T07:49:19Z` 观测两个官方公开页面均为 403；已停止该源请求，没有换出口、代理或尝试绕过。这个时间是探测时间，不是行情源日期。当前 artifact 实际日期仍为 2026-08-21，未把它改成今日。

### 本轮集成验证

| 检查 | 本次结果 | 证据范围 |
| --- | --- | --- |
| 后端全量 pytest | 990 passed / 43.29 秒 | Windows / Python 3.14.4；39,479 条既有依赖弃用警告，不替代 Python 3.12 CI |
| 验证器与 CLI | 201 + 47 passed | 已包含在 990；全部合成数据，无真实 key/云请求 |
| 指数富集/加载器/workflow 定向 | 108 passed | 与全量重叠，新增 25；不等于免费源恢复 |
| 前端全量测试 | 35 文件 / 260 passed | 本轮重新运行 |
| 前端类型检查 / 构建 / PWA | passed / passed / 7 of 7 | 本轮重新运行；非旧客户端升级验收 |
| Worker 测试 / 类型检查 | 3 文件 / 144 passed / passed | 未部署，未验证自然 Cron |
| diff 格式 / 四份 JSON 解析 | passed | 只有 Git LF/CRLF 提示 |
| GitHub main | 仍为 `706b6ade3cec000319e4dd5eb6bd7d6cb7c510ad` | 本轮重新读取远端；未 push |
| Render 浏览器 | Free、Live、部署 `706b6ad` | 用户重新打开后已可读；未查看或回显 Secret 值 |
| API health HTTP | 初次 20 秒读取超时/失败；再次读取 200 / 2,687 ms | `2026-09-30T08:10:20Z`、8.0.0 / `706b6ad`、libsql / turso_candidate / durable=false；仅 health 通过，不等于整体验收 |
| Turso 浏览器 | 当前 `app.turso.tech/login` | 登录页已保留供用户完成登录，未操作 Token/套餐 |

本轮额外函数基线：合成验签输入 1,631 bytes，未预热 5 次为 `0.2608 / 0.2238 / 0.2271 / 0.1943 / 0.1916 ms`，p50 `0.2238 ms`，nearest-rank p95 `0.2608 ms`。仅本地函数执行，无 HTTP/磁盘/云；没有旧实现同条件基线，不给出性能回退判定。

本轮有限数据检查仍为 `CONDITIONALLY TRUSTED`：公开 health 再次确认指数源日期 `2026-08-21`、`usable=false`，过期降级保持真实，没有发布新指数数据。不是逐基金金融准确性认证。线上 smoke/正式发布仍为 `BLOCKED`：未部署本批代码，生产 Owner 旅程、自然 Cron、应用写入跨重启与独立恢复未验收。

尚未完成真实生产生成器、凭据轮换、Owner 初始化、重启/恢复和自然任务出口；版本仍为 8.0.0，未 commit/push/tag/release，未删除 Gist。

## 性能首批基线

仅测密码哈希和校验函数，用于约束本地轻量实现。Windows / Python 3.14.4，默认 600,000 次、各 5 次、未预热；计时不含 HTTP、网络、冷启动或数据库。P95 为小样本 nearest-rank，即最大值。没有同条件旧实现基线，不给出“无性能回退”结论。

| 函数 | 5 次毫秒样本 | p50 / p95（毫秒） |
| --- | --- | --- |
| `hash_owner_password` | 360.185 / 403.945 / 364.579 / 356.900 / 353.181 | 360.185 / 403.945 |
| 合成密码校验并创建会话 | 354.105 / 368.154 / 382.418 / 375.747 / 358.299 | 368.154 / 382.418 |

生产 warm/cold、请求数量、包体与同设备前后对比继续留在 I21-04，不以此函数基线放行正式性能门禁。

## 访问阻塞与后续执行顺序

上一轮 Render 页面选择超时；用户重新打开后已恢复 Render 正常读取。此前新开的 Turso 标签停在登录页；本次用户完成登录后，正常标签清单已返回标题 `Databases | aureliuswu` 与 `https://app.turso.tech/aureliuswu`。登录状态已确认，不能再把当前阻塞描述为“未登录”。

本次浏览器控制仍在 `Emulation.setFocusEmulationEnabled` 超时；支持的页面选择、可访问性读取与 DOM 读取未获得数据库内容。已停止重复读取，保留用户标签，待刷新/恢复控制连接后继续。没有确认目标数据库/组，没有生成、复制、部署或撤销 Token，也没有修改套餐或平台 Secret。用户给定的候选文件仅包含数据库访问材料，不是组织管理凭据；没有用其绕过权限或枚举秘密。

补充轮换前的范围核对：Turso [数据库 API](https://docs.turso.tech/api-reference/databases/invalidate-tokens) 定义的是使指定数据库的全部授权 Token 失效，并说明需要短暂中断；[CLI invalidate 文档](https://docs.turso.tech/cli/db/tokens/invalidate) 另外提示所在组的全部 Token 也会失效。这些操作不是“只撤销旧 Token”，也会使操作前生成的新 Token 失效。实际 UI 尚不可读，不能假定其作用范围或存在单 Token 撤销能力。必须先确认具体入口、数据库/组和全部消费者；全量失效及中断须取得明确范围授权，不能从一般升级授权推导。

本次只更新执行记录与方案中的上述操作边界，未改业务代码，未重跑全量测试；前述测试数量仍属于各自记录的实施轮次。旧凭据的读取失败也不能独立证明撤销成功，须结合平台明确操作结果、可辨认的鉴权拒绝与同资源新凭据成功对照；`inspect`/health 的只读成功不证明写权限或耐久。

### 用户刷新后的连接复查 · 2026-09-30

用户回复“已刷新”后，在同一 IAB 连接重新检查：首次标签清单为空；按支持的恢复方式尝试在同一浏览器打开 Turso，调用 40 秒超时；随后正常连接清单确认新标签标题仍为 `Databases | aureliuswu`、URL 仍为组织数据库首页。对该新标签的页面绑定同样 40 秒超时并重置工具会话。没有取得数据库列表/管理按钮，刷新与新标签没有解决内容控制故障。Chrome/Edge 清单同时报告连接读取失败，未切换浏览器或尝试未支持的控制方法。

已经停止重复尝试。本次未输入/复制凭据、未调用管理 API、未执行生成或失效操作、未关闭用户标签，也未改变数据库、Render 配置或套餐。官方 [浏览器扩展连接排查](https://learn.chatgpt.com/docs/chrome-extension#troubleshooting) 包含重启浏览器/桌面应用的恢复建议，但未针对当前 IAB 超时给出确定修复；下一次用户重启桌面应用后重新打开当前聊天及 Turso 是恢复尝试，不是保证。不要要求重复登录或发送 Token，不清除浏览器数据/扩大权限来绕过问题。

并行只读枚举了仓库内的数据库 Token 消费者，未读取 `.env`、环境变量值、Temp 凭据或云端 Secret：

| 消费者 | 代码证据 | 轮换影响 |
| --- | --- | --- |
| Render API | `render.yaml:4,21-24`；`backend/database/db.py:529-535,942-952` | 仓库声明候选服务 `fund-compass-api-v8-candidate`，须由用户在受保护环境配置更新并重部署；真实服务/副本仍待平台核对 |
| API 仓储与 health | `backend/service/repo.py:10`、`backend/service/v8_repo.py:14`；`backend/main.py:337-354` | 共用 API 连接，没有独立数据库 Token；health 的 30 秒缓存不能证明新凭据已加载 |
| 本地候选 CLI | `tools/turso_candidate.py:53-83` | 从受控环境读取 URL/Token 并直接连接；若继续使用，需同步其秘密材料，不能打印或通过聊天交接 |
| Actions 与 Worker | `.github/workflows/` 未发现 Turso URL/Token 注入或候选 CLI 调用；`worker/src/index.ts:38` 与 `worker/wrangler.toml:17` | 通过 API 与独立机器鉴权访问，不因数据库轮换去改 Worker/Private Read Token；API 中断仍可能影响任务 |
| 验签/本地仓储工具 | `tools/verify_storage_evidence.py:37-41,133-141`；`tools/persistence_candidate.py:84-92` | 前者只禁止签名 key 复用数据库凭据；后者仅本地 SQLite，均不构成额外 Turso 网络消费者或远端验收 |

这不是完整平台资产清单。无法从仓库排除同组其他数据库/应用、手工创建的旧 Render 服务或预览实例、外部 CI/调度/备份工具，以及本机独立环境；不得只按仓库声明的一个 Render 服务执行全组失效。本轮仅文档更新及只读检查，没有改业务代码或重跑测试；I18-01 和正式发布仍未通过。

1. 用户刷新已验证未恢复连接；下一步由用户重启桌面应用，再打开当前聊天与 Turso，恢复正常页面控制后核对目标数据库/组。密码和 Token 不应粘贴到聊天，凭据输入、确认与提交由用户在正常受保护页面完成。
2. 先确认平台实际撤销语义。若支持精确撤销单个旧 Token，才采用新凭据部署验证 → 精确撤销旧凭据 → 新旧凭据对照；若只有全量失效，先取得明确范围/短暂中断授权，确认全部消费者，再执行失效 → 生成替代凭据 → 用户更新受保护配置 → 重部署验证。核对新部署标识及 health 的 30 秒缓存，不能仅凭缓存响应证明换钥生效；在初始化 Owner 前核对账号配置和免费套餐，不启用付费超额。
3. 完成生产验收 namespace 的应用读取隔离，进行受控业务写入 → Render 实际重启 → 应用读回，再做不同远端资源的恢复；保证普通 latest/outcomes/训练/通知不读到测试记录。
4. 验签器已具备本地拒绝回归；继续实现受保护执行器/可信生成器，把真实证据接入正式 workflow，再关闭 Iteration 18 出口。不能用人工签合成 fixture 放行。
5. 再按方案推进持仓/同步/机器消费者与数据任务。最后才同步 `9.0.0`、候选/自然观察/正式发布和旧 Gist 退出。

当前下一步需要正常平台访问及安全密码初始化，不能靠改 `durable=true`、降低门槛或自动改版本绕过。

## 继续执行 · 2026-10-01：候选错误诊断与远端基线同步

### 本次变更

修复 `backend/database/turso.py` 与 `tools/turso_candidate.py` 把 HTTP 拒绝、限流、服务错误全部混为通用失败的诊断缺口。适配器新增 `sqlite3.OperationalError` 子类，只携带严格整数状态和固定脱敏消息；CLI 仅信任精确适配器异常类型，401/403/429/5xx 分别输出固定码。传输错误、其他状态、伪造属性、子类、缺失/篡改状态仍通用失败，不解析提供方文本。

非 200 不读取正文、不跟随重定向，失败后连接不可复用，不自动重试。响应与会话清理保留原始错误，独立清理失败脱敏；关闭时无论清理成功与否都清除连接状态。提交/批量/关闭失败不能打印成功或 `committed=true`，也不能据此倒推请求一定未执行。401/403 只说明本次被拒，不证明 Token 撤销。使用说明已同步至 [TURSO-CANDIDATE.md](TURSO-CANDIDATE.md)。

全部新增回归使用合成地址/凭据与本地 SQLite 或模拟响应；覆盖严格类型短路、恶意比较/字符串化对象、非 200 不读正文、清理错误优先级、各阶段 CLI 脱敏和禁止重放。独立只读代码复审未发现阻断问题，其建议的 204、整数子类和恶意状态对象覆盖已补足。

### Git 与重新验证

本轮只读获取远端后发现 main 从 `706b6ad` 更新为 `fcfb140928ea1904f784da9f2e664c7eded89f74`。新增提交为 `github-actions[bot]` 的“更新海外估值精度账本”，仅涉及四份海外数据文件，与本地修改不重叠。已执行安全快进；同步前后的 42 个未提交文件 SHA256 全部相同，未覆盖原有工作。以下最终验证在快进后的本地脏工作区进行，不把远端自动数据提交当作 v9 发布。

| 检查 | 本次结果 | 边界 |
| --- | --- | --- |
| 后端全量 pytest | 1,081 passed / 44.29 秒 | Windows / Python 3.14.4；40,339 条既有依赖弃用警告，不替代 Python 3.12 CI |
| Turso/候选配置/本地隔离定向 | 159 passed / 7.19 秒 | 与全量重叠；合成数据，无云写入 |
| 前端测试 | 35 文件 / 260 passed | 本轮重新运行 |
| 前端类型检查、构建、PWA | passed / passed / 7 of 7 | 未部署本地修改；非旧客户端升级验收 |
| Worker 测试与类型检查 | 3 文件 / 144 passed / passed | 未部署，未验收自然 Cron |
| HTTP/清理/CLI 复审 | passed | 只读代码审查；没有真实凭据或云操作 |

本轮没有创建 v9 commit、push、Tag 或 Release，没有删除 Gist、生成/读取/撤销 Token、修改云配置/数据库或启用付费能力。版本仍为 8.0.0，v9 修改保留在本地。

### 当前公开生产观察

公开 API health 第一次请求在 20,195 ms 后失败/超时；第二次在 `2026-10-01T11:41:02Z` 返回 HTTP 200、JSON、656 ms。响应为 8.0.0、Render commit `fcfb140928ea1904f784da9f2e664c7eded89f74`、启动时间 `2026-10-01T19:39:17.923593+08:00`、libsql / `turso_candidate` / `durable=false`。这只能确认本次健康读取与候选身份，不能证明冷启动原因、换钥生效、生产应用跨重启读回或整体 smoke 成功。

指数估值仍为来源 `legulegu`、日期 `2026-08-21`、41 天、`usable=false`、`mapped_usable_indices=0`。过期降级保持真实，没有将缺失值补零或发布新的指数数据。有限检查结论仍为 `CONDITIONALLY TRUSTED`；未执行逐基金金融正确性认证。

### 本地函数性能对照

使用同一机器上的 HEAD 旧适配器（测量时为 `706b6ad`；远端新增提交未改适配器）与当前实现，纯模拟 `_pipeline`，每组先预热 100 次，再交替测 5 对、每样本 5,000 次。单位为每次微秒；p95 为 5 样本 nearest-rank 最大值。请求/响应全部模拟，无网络、磁盘、数据库和凭据访问。首次基准因模拟 Session 缺少 headers 失败，补齐模拟后重测；失败样本未计入结果。

| 状态 | 旧 / 新 p50（μs） | 旧 / 新 p95（μs） | 观察 |
| --- | --- | --- | --- |
| 200 | 1.1909 / 1.2656 | 1.2406 / 1.2904 | p50 +0.0747 μs，约 +6.3% |
| 401 | 1.4828 / 1.8665 | 1.5173 / 1.9003 | p50 +0.3837 μs，约 +25.9% |
| 503 | 1.5308 / 1.8414 | 1.7192 / 2.1244 | p50 +0.3106 μs，约 +20.3% |

这是严格校验和专用异常带来的可测函数开销上升，不宣称“无回退”；也不能用微秒模拟样本推导线上总延迟。生产 warm/cold、配额、流量和同设备旅程仍留在 I21-04 验收。

### 浏览器阻塞与下一道隔离门禁

本次支持的浏览器清单返回 IAB 空列表，Chrome 连接读取失败。在同一 IAB 新建 Turso 导航，`Page.navigate` 超时；随后仅获得 about:blank 标题和 Turso 组织首页地址。再次正常页面绑定 30 秒超时并重置工具会话，没有获得数据库内容。不能把旧轮次的登录状态或本次 URL 当作今日已登录/目标资源确认。已停止重复尝试，未切换连接方式或使用原生/CDP/配置文件绕过。

并行仓储审查确认：现有本地验收工具依赖**独占、带标记的完整 SQLite 数据库**，不是生产表内 namespace 隔离。它拒绝远端和混合数据库，未发现其已向生产写入验收记录的证据。但如果未来直接把合成链写入普通生产表，可能进入 latest/history/outcomes、同级比较、策略汇总、组合引用和通知 claim，并冲突于全局 Policy 前驱链。

I18-04 的后续实现必须先完成独立隔离设计与受控增量 schema 迁移：不可变 scope 元数据和记录保存同事务注册；跨 scope 引用拒绝；Policy 链 tip 按 scope 独立；业务默认查询在 ORDER/LIMIT 前排除验收记录（包括按 ID 和显式结算）；通知 claim 拒绝验收；受保护探针只允许明确验收 namespace，不伪造生产净值或成熟 Outcome。用旧 schema 副本验证迁移，再单独验收远端兼容性；不能把启动校验或 `initialize --candidate` 当作已实现增量迁移。

现有每周旧策略校准读取的是 legacy `repo.decision_outcomes`，不是 V8 Outcome；上述是未来混写风险，不声称当前隔离本地 fixture 已污染生产训练。

平台连接、精确凭据轮换与生产 Owner 初始化尚未完成；实际应用写入 → Render 重启/重部署 → 应用读回、独立远端恢复、可信证据生成器/正式 workflow 和自然任务观察继续未完成。I18-01/04/05/06 出口及正式发布仍 `BLOCKED`，不降低门禁或自动升级版本。

本轮重新查询并读取 OpenAI Docs 的 [浏览器扩展排查](https://learn.chatgpt.com/docs/chrome-extension#troubleshooting) 与 [内置 Browser](https://learn.chatgpt.com/docs/browser) 页面。前者提供重启浏览器/桌面应用等建议，后者确认内置浏览器由 Computer Use 操作，但没有给出本次 `Page.navigate` 超时的确定修复。用户重启桌面应用、回到此聊天并重新打开 Turso 后可再检查，这是恢复尝试而非保证；无需发送密码/Token，不清除用户数据或扩大权限来绕过。

## 再次继续 · 2026-10-01：同事务保留 fixture 防误写

完成 I18-04 的一个本地防守子项，不勾选其生产出口。`persistence_verification.py` 的统一 guard 已接入 `v8_repo.py` 四类 root 及组合/Outcome/组合 Outcome/通知写入。直接保留输入在远端连接前拒绝；既存引用在当前事务核对，去掉 Decision 自身的版本标记仍不能包裹合成祖先。Policy 不得继承验收 tip，混合通知批在任何 claim/duplicate 返回之前全批拒绝。

本地例外验证与写入共用 `BEGIN IMMEDIATE` 和同一 conn，不另开预检连接来授权。只允许当前 namespace 的精确 fixture；检查实际 main 文件、源码指纹、schema/immutable trigger、全部表 population 及已存完整前缀。标记本地库拒绝普通 root 和全部派生写；普通库拒绝保留 provenance。不按基金 `999999` 或自由文案识别。连接资源错位、源/标记/schema/trigger 漂移、混合数据、同 namespace 改份额且重算正确 ID、未标记既存重放等均失败且无新增记录。两连接合成测试确认 guard 与 INSERT 之间竞争写入不能提交。

为避免逐 component 的新远端请求，持久化决策及 E/H/P 祖先用一个参数化 JOIN 加载；普通远端 guard 不查询 marker。关联 JSON 的 IDs/基金必须与 SQL 投影一致，否则拒绝而不是选择另一链。通知原来的 existence lookup 被 lineage lookup 替代，响应字段增加但请求次数未由该替换增加；组合/Outcome 的额外读与 payload/扫描量仍需实际远端预算验收。

候选 CLI 同时修复以异常类名字符串识别可信错误的问题：只信正常导入的精确 VerificationError/ArgumentError 类型、内建异常 args 槽中的单个原生字符串及固定 allowlist，不调用 `str(exc)`。同名假类、子类、未知/私密文本、多 args、非字符串及自定义字符串操作均降级为固定通用失败；失败不输出成功、路径或私账。保留已有已知安全码和参数退出语义。

两路只读设计审查完成；CLI 实施分支在额度限制后中断，已保存的改动由主代理检查并补齐回归。没有购买额度、变更计费或把设计审查称作最终实现的独立复审。新源指纹覆盖仓储、verifier 和 CLI；旧本地 receipt 因源码变化按合同拒绝，不更新旧 marker/删除旧文件来通过。

### 本次验证

- 最终后端全量：**1,171 passed / 50.31 秒**，Windows / Python 3.14.4，42,386 条依赖弃用警告；不替代部署使用的 Python 3.12 CI。
- 最终边界/CLI/本地候选/V8 定向：142 passed / 21.57 秒，包含在全量中；全程合成数据，无真实云写入。
- 新增 90 项合成回归已纳入全量；包括投影漂移、精确重放、资源错位、并发锁、隐藏引用、六类通知阶段/整批原子拒绝、派生结果拒绝和 CLI 脱敏。初次新组合测试的 ID 未包含模型规范化字段，修正测试生成方式后重跑，没有放宽仓储 ID 断言。
- 本轮未改前端/Worker，未重新运行其全量、构建或真实设备验收；上一小节的 260/144/PWA 结果属于上一轮。
- HEAD/GitHub main 再读均为 `fcfb140928ea1904f784da9f2e664c7eded89f74`，本批仍未 commit/push/tag/release/deploy。schema 和正式持久化 gate 不变。

### 本地性能对照

本机临时合成 SQLite 文件，HEAD 旧仓储与当前实现，同一 business fixture；每实现预热 20 次，再交替 5 对样本，每样本 20 次真实事务写入。包括 Python/SQL/本机磁盘提交，不含 HTTP、Turso、冷启动或真实私人数据。

| 普通路径 | 旧 / 新 p50 ms | 旧 / 新 p95 ms | median 变化 / 本地预算 |
| --- | --- | --- | --- |
| 持仓写入 | 17.7281 / 17.3300 | 18.2012 / 17.9980 | -2.2% / PASS |
| scheduled 通知记录 | 16.4376 / 16.8527 | 17.0362 / 17.9594 | +2.5% / PASS |

持仓旧 5 样本：17.4472/17.7448/17.7281/18.2012/13.3986，新：17.2458/17.3300/17.9980/17.5003/14.0947；通知旧：16.2426/16.3993/16.7391/16.4376/17.0362，新：16.2975/16.9978/15.9170/16.8527/17.9594。p95 是小样本 nearest-rank 最大值，变化仅方向性，不宣称显著加速或完整无回退。没有既有通用性能 artifact 目录，本次原始样本记录于本节；生产延迟、JOIN payload/配额和扫描量仍未测。

### 线上观察和阻塞

浏览器新清单能看到 IAB 的 about:blank / Turso 首页地址，但 Edge 连接读取失败；选择该 IAB 标签仍 30 秒超时并重置会话。没有页面内容/数据库/Token 界面证据，停止重复操作，仍不能确认当前登录或作用范围。computer-use 安全边界继续暂停平台变更。

公开 health 第一次 `2026-10-01T12:33:56Z` 在 20,185 ms 后失败/超时；第二次 `2026-10-01T12:36:39Z` 返回 200 / 615 ms，8.0.0 / `fcfb140`、libsql / turso_candidate / durable=false。指数仍 `2026-08-21`、41 天、usable=false。只读健康恢复不解释首次失败原因，不证明凭据轮换、写权限、生产跨重启或整个 smoke；未改变过期数据或缺失值语义。有限数据结论 `CONDITIONALLY TRUSTED`。

这不是完整生产 scope、普通读取/原始 SQL/legacy 隔离或所有虚构数据的识别系统。未检查真实私人 source/account 是否与新保留前缀冲突，部署前需受控兼容核对。平台目标/凭据、生产 Owner、真实写入重启读回、独立远端恢复、证据生成器/workflow 和自然 Cron 仍未验收；正式发布 **BLOCKED**。版本仍为 8.0.0，未新建云资源、改云数据/配置、读取凭据或删除 Gist。

## 持续推进 · 2026-10-01：I21-02 请求与条件提案本地加固

用户再次授权按 v9 统筹方案持续执行。本轮保留现有 I18 改动与版本 8.0.0，独立推进 I21-02 的可本地验收子项。HEAD 和 GitHub main 在本轮开始及集成后重新查询均为 `fcfb140928ea1904f784da9f2e664c7eded89f74`。没有将版本号或局部测试当作正式资格，没有新建付费服务、升级套餐、调用真实 BYOK 模型或删除旧 Gist。

### 修复与合同

- 从既有 API 层提取共享 `fetchWithDeadline` / `requestJson`，保留 API no-store、204/205 与 Owner 取消兼容。deadline 包含 fetch、正文和解码；transport 忽略 abort 也会停止等待，迟到结果不能返回成功。
- 两类 AI provider 接入 30 秒总 deadline 和 caller signal；正文以流式读取限定 64 KiB、文本输出 16384 UTF-16 单元。HTTPS、无 URL 凭据/查询/片段、redirect error、credentials omit；不读取失败 body、不展示上游 error.message，不自动重试收费 POST。用户取消不保证提供方取消计费，UI 明确披露。
- 新增 `contracts/nl-filter-spec-v1.json`，运行时封闭校验单对象、未知/重复/转义同名字段、类型/枚举、有限数值、收益/费率边界及 unsupported 长度。拒绝类型转换、外围解释/代码块和部分条件执行。数字是用户确认的筛选阈值，基金收益仍来自已验证静态数据，不接受模型创造的基金数字或买卖动作。
- Screen 先验证非空且新鲜的排行再调用可选 AI；展示原需求、全条件、默认排序和数据日期，用户确认才筛选。编辑需求、取消、切模式、卸载会取消/作废待执行提案，旧 success/catch/finally 不覆盖新状态；重复按钮/键盘发送不重发同一运行请求。确认时再次检查日期，失败 finally 不再隐式发第二次静态加载。
- Screener/Managers 集合加载有独立 12 秒总 deadline（包括分片 hash）、每次最多 6 个并发分片，乱序完成按 manifest 顺序组装，失败/取消停止排队项及活动兄弟请求。只有 manifest 404 可回旧文件，503/超时/格式/hash 错不偷换代次。保留原 schema、集合/分片 hash、去重和金融 null 规则。
- Screener 内存命中重算北京日历新鲜度；Enrich fetch+JSON 6 秒、命中仍核对披露年龄；精度报告 fetch+JSON 12 秒，失败 null 不永久缓存，force generation 与 caller 取消互不串请求，消费数值形状校验避免字符串 toFixed 崩溃。
- 自由文本 `llmInterpret` / `generateStorySummary` 暂停，直接调用也固定拒绝且无网络。详情/故事页明确暂停，不恢复/展示/写入旧 `sinan_ai_text`；保留用户旧缓存和配置，不删除数据、不用规则 fallback 冒充模型结果。规则解读对评分 eligible、评分与信号 coverage、stale 和非有限值保持边界；缺超额不补零，真实零仅表示该历史区间持平，详情底部回测说明同步中立化。

这按照 data-reliability-audit 的来源/新鲜度/缺值边界收口，并采用 release-checklist 的“局部代码与正式验收分开”原则。严格条件合同和人工审核不能证明模型完整理解了自然语言；没有真实第三方模型调用/CORS 成功证据。

### 本次最终验证

| 项目 | 结果与范围 |
| --- | --- |
| 前端全量 | **42 文件 / 446 passed**；包含真实 SFC 自定义 renderer 的输入/点击/确认/取消/卸载，不是物理浏览器 |
| 前端类型/构建 | type-check、build 通过；**PWA artifact 校验 7/7**，不替代已安装旧 PWA 升级 |
| 后端全量 | **1171 项全部通过**；本轮重新运行，1171 collect-only 核对一致；Python 3.14.4 / 42,386 条依赖弃用警告，仍不替代 Python 3.12 CI |
| Worker | **3 文件 / 144 passed**；check、Wrangler `--dry-run` 通过；114.28 KiB / gzip 26.58 KiB，不是线上 deploy |
| Git | diff --check 通过，仅 LF/CRLF 提示；依赖与版本文件无本轮修改 |

故障/边界覆盖包括：AI fetch/body 永久 pending、忽略 abort、预取消/流式取消、正文超限、配置/响应形状、固定 HTTP 脱敏与零自动重试；非法/重复 JSON、真实零阈值/缺收益、unsupported 整次拒绝；静态预检未完成时取消/编辑/卸载后不启动付费解析；新旧提案倒序完成与确认前跨日过期；分片 body/hash/最终集合 hash 超时、超过 6 个分片的乱序和队列取消、404/503 区分、失败后恢复及缓存跨日。

最终另一路只读实现复审覆盖共享 request/static-collection、AI/条件合同、四个 loader、规则解读与三页完整 diff，未发现本轮新增 P0/P1 阻断；未编辑、访问真实配置或重跑全量。独立复审与主代理测试一致接受本节的有限边界，不放行生产或抹除历史缺口。

初次 Screen 测试因自定义 host 缺少 Vue v-model 所需的 addEventListener/getRootNode 失败，补齐合成 host 的实际 input 事件处理后重跑；没有改生产指令或放松业务断言。并发测试最初错误要求已完成的失败 HTTP 响应信号也取消，修正为只检查尚在途的兄弟请求；没有改变运行边界。子项测试均已纳入最终 446，不重复相加。

### 本地包体对照 · 非完整 I21-04

performance-regression-check 的比较点为本轮修改前已有本地 `dist`（`2026-10-01T11:42:53.122Z`），不是干净 HEAD/正式 release。最终产物 `2026-10-01T13:23:56.249Z`。同机、同 Node/zlib、排除 source map，统计 dist 内全部 JS/CSS；两侧各重复读取同一产物 3 次一致，不是 3 次独立构建或旅程测速。

| 指标 | 修改前 / 最终 | 增幅 | 局部判定 |
| --- | --- | --- | --- |
| JS/CSS raw bytes（58 文件） | 1,274,874 / 1,281,149 | +0.49% | PASS（<20%） |
| JS/CSS gzip bytes | 456,340 / 458,752 | +0.53% | PASS（<20%） |
| 主 index JS raw / gzip bytes | 222,974 / 224,337；83,800 / 84,250 | +0.61% / +0.54% | PASS |
| 最大 echarts JS raw / gzip | 532,397 / 182,300（两侧相同） | 0% | 未增加 |

主要变化来自共享取消/清理、严格校验及确认 UI；自由文本逻辑移除抵消部分增量，没有新增依赖。这里不报告 DOM/LCP、真实交互延迟、网络 transferred bytes、冷/热请求量或统计显著性。真实大集合在慢网络 12 秒内完成、全局多 loader 并发预算、生产 warm/cold 和设备旅程仍未测。

### 平台阻塞、数据缺口与下一步

浏览器清单本轮可见两个 IAB Turso 首页标签，其中一个标题为 Databases；Chrome 连接返回 `nodeRepl.fetch request failed`。支持的 `getTab` 绑定实际页面再次 30 秒超时并重置会话，未获得页面正文/库名/组/费用设置/Token 操作证据。按 computer-use 安全边界停止平台操作，不通过 profile/cookie/CDP/Secret 提取绕过。已请求用户只核对候选数据库名称、组和其他消费者，不发送 Token；全库/组失效必须先核对并明确授权影响范围，凭据输入/确认/提交须由用户接手。标签标题/地址和历史登录都不证明当前轮换或资源范围已确认。

本轮没有重新运行线上 smoke 或读取真实基金记录与独立权威金融源。有限本地数据/交互结论为 **CONDITIONALLY TRUSTED**，不是全应用金融准确性认证。旧 Story 页缺净值/成本补零、部分今日数据合计和日期/覆盖缺口，以及 legacy 独立评分/信号卡片统一门禁，仍待 I19-05/I20-02；自由文本暂停不修复这些原有数字。Screen 非 NL 的初始化排行/经理/基础列表生命周期、top10 穿透请求、经理日期 UI 和完整精度元数据合同也未在本轮收口。

I21-02 为本地子项通过，整个工作项未勾选。I18-01/04/05/06、生产 Owner 初始化、真实写入→宿主重启→应用读回、独立远端恢复、受保护证据生成器/workflow，I19 持仓/同步/行动链和 I20 自然产出，以及 I21 实际设备/部署验收仍未完成。正式发布继续 **BLOCKED**；三端版本仍 8.0.0，本批代码未 commit/push/tag/release/deploy。

## 2026-10-01 · 自主推进：直连路线与下一批硬化

用户要求自主实现目标、尽量不重复询问。按 release-checklist、data-reliability-audit 和 performance-regression-check 分开代码、实库只读、候选/正式证据；不启用付费资源，不降低安全门禁。

### 已解除数据库页面依赖

从用户此前明确提供的确切本机配置读取候选 URL/Token，只向工具子进程环境注入，不输出原文件/地址/凭据，也未搜索其他密钥位置。该文件不是带标准变量名的 dotenv 格式；按唯一候选 URL 与唯一凭据格式解析并核对候选主机后，`tools/turso_candidate.py --timeout 20 inspect` 实际成功：schema 8、20 张表、27,947 只公开基金，scope 为 `database_probe_only`、`formal_release_verified=false`。

全程仅只读，没有业务写入、私人账本读取、schema 迁移、凭据轮换/撤销、平台或费用设置变化。Dashboard/Chrome/MCP/CLI 登录失败不再阻断 SQL 子项；现有 Token 可读不代表安全轮换或耐久门禁完成。旧已超时 CLI 授权链接不复用。

### 本地与远端基线

`origin/main` 实时为 `5daddec42d599ce45cd88d72ad00e990c092aeaf`。确认仅三项海外公开/审核数据更新且不与 dirty 文件重叠后，从 `fcfb140` 安全 fast-forward；所有原有 v9 修改保留，无 reset/清理/强推。新 scope 合同尚未在远端迁移，本批不得直接推 main 触发 Render 自动部署。

### 经理索引日期与请求生命周期 · I20-02 / I21-02 子项

生产工具 `tools/managers.py` 的 `updated/fetched_at` 是采集时间，并非任职回报或在管规模的基准日。新增兼容 `loadManagers()` 的 `loadManagerDataset()`，保留采集日、可得采集时间、来源和 `valueDate=null`；manifest 没有的时间不从加载时钟补造。年龄按北京时间日历重算，缺失/非法/未来日期保持未知，超过 7 天只是索引历史查阅警告，不把指标宣称为当前表现。

Screen 展示采集日、年龄和“指标基准日未知”；基金数量注明“采集时在管”。本地午夜 timer 更新显示，不轮询源，卸载/切模式清理 timer、取消经理请求并拒绝迟到回调。缓存跨日不发新请求，空 fallback 集合拒绝。三文件定向 **55 passed**、type-check 通过；后续以集成结果为准。

本轮实际读取公开 Pages manager manifest/首分片：schema 2、采集日 2026-09-28、4,347 条，代表公开 ID `30777698`，manifest 没有 fetched_at、record 没有指标日期。独立读取天天基金源接口 HTTP 200，找到同 ID、12 个源字段；只核对实体/源格式与日期合同，没有宣称当前数值与历史快照一致。原始数值仍按来源历史展示，不作为实时准确性认证。

Story 缺值/覆盖及日期边界、周校准有界 GET 与私人产物防公开、不可变 root scope 旁表及默认读取隔离正在独立实现/复审。完成后的集成结果与确切范围续记，不预先勾选工作项。

## 2026-10-02 · 冻结快照集成验收

本批代码完成本地集成，继续 v9 目标，不将候选进度冒充正式发布。软件三端仍 8.0.0；物理数据库 schema 因隔离合同独立升至 9。线上真实只读 inspect 仍为 schema 8，未执行远端迁移/业务写入。

### 实现与边界

- I18-04 本地隔离：四类 root 显式 scope 与不可变元数据同事务提交；V8 默认读取先通过 production 视图再排序/limit，涵盖 latest/history/peer/结算/通知读取。循环或孤立 Policy、跨 scope 引用及 malformed/scalar 组合 JSON 不进入生产路径；远端 acceptance 写保持关闭。
- 旧 SQLite 8→9 迁移验证 typed 模型、稳定 ID/摘要、SQL 投影、引用/前驱链及 source-health/派生人口完整性，异常整批回滚，原 payload/ID 不变。已有 schema 9 缺 scope 要求显式修复，不静默重分类。独立只读复审及 88 项定向测试未发现漏筛/同事务缺陷；不替代全局原始 SQL/legacy 隔离。
- 本地备份生成在迁移锁之前，只是点时备份，不能当作并发精确回滚前像。真实迁移必须冻结写入，或实现锁内前像核验；Turso 受控增量迁移尚未实现，startup/initialize 会拒绝旧 schema 8，因此本批不得直接推 main 自动部署。
- Story 不再将缺净值/成本/日变动补零，完整覆盖才发布组合值，部分定价小计明确披露；日变动/排行需同一来源日和明确新鲜度，信号/评分需独立 evidence 与覆盖/日期门禁。所有来源日期采用完整语法和日历/时钟校验，拒绝垃圾尾部/非法时分秒与偏移；只保留来源年月日，不推断时区或改变 QDII 日期。报告生成时间单列，自由文本 AI 继续暂停。
- 周校准 GET 有界三次/150 秒总预算、单次 45 秒、8 MiB 正文与逐 read1 socket 预算；鉴权/坏 JSON/合同不重试，错误固定脱敏。没有私人 sink 时 workflow 明确 `BLOCKED_PRIVATE_SINK_REQUIRED`，不公开 upload/commit、不中断隐私保护换绿色 conclusion。此为读取/泄露风险修复，不宣称自然周任务已恢复产出。

### 最终质量门禁

| 验证 | 最终结果 | 证据范围 |
| --- | --- | --- |
| 后端 Windows | **1243 passed / 68.96 秒**，Python 3.14.4 | 隔离本地合成库，清除子进程宿主凭据 |
| 后端 Linux | **1243 passed / 79.14 秒**，Python 3.12.3 / SQLite 3.45.1 | WSL Ubuntu 24.04 隔离 venv；前后 source fingerprint 未变，与部署 Python 主次版本匹配，不是云端 CI/业务验收 |
| 前端 | **43 文件 / 491 passed**，type-check、build、**PWA 7/7** | 真实 SFC 合成 renderer；不替代物理浏览器/已安装 PWA 升级 |
| Worker | **3 文件 / 144 passed**，check、Wrangler dry-run | 本轮代码未变；114.28 KiB / gzip 26.58 KiB；未实际部署 |
| Git | diff --check 通过 | 仅 CRLF 提示；有限改动路径秘密模式检查无命中，不称全仓安全审计 |

后端两平台均有一个现有 Starlette/httpx 弃用警告，不为消除警告做无关依赖升级。先前 Linux 全套唯一失败在最终源码冻结后单项 1/1、整文件 22/22 和原顺序全套 1243/1243 均不复现；旧合成库 marker 与最终源码不符、保留合法持仓/Evidence 前缀。该状态与运行期间源码漂移守卫拒绝一致，但历史安全码未捕获，不断言精确触发点、不改守卫/marker 绕过。

### 局部包体对照

同机同压缩方法，只统计 dist/assets 的 JS/CSS（55 文件），两侧各三次重复读取同一产物，不是独立构建或真实旅程。修改前 raw 1,251,537 / gzip 451,252 bytes；最终 raw **1,264,368** / gzip **455,171** bytes，分别 **+1.03% / +0.87%**，局部预算 PASS（<20%）。与前节含 sw/workbox 的 58 文件口径不同，不能混用；无新依赖。未测真实 warm/cold、交互、跨网性能或扫描配额。

### 继续顺序与发布限制

将本批保存到独立 v9 升级分支，不推 main、不触发 Render/Pages 自动部署，不创建正式 Tag/Release。随后推进 I19-01 本地持仓表单/校验与明确待同步状态，以及显式 Turso 8→9 迁移/恢复工具的候选演练。真实私人数据上传仍需明确启用；凭据轮换、生产 Owner、应用写入→宿主重启→读回、独立远端恢复、正式 workflow/可信执行器、I19 同步/行动链和自然观察等缺口未关闭，正式发布状态 **BLOCKED**，v9 目标保持进行中。

## 2026-10-02 · I19 输入、隐私与离线迁移演练

前一批已经提交并推送到独立分支 `feat/v9-foundation-hardening`：`762c6a7ad56e1f34429f955b8cf97f292a5d63a2`。main 仍为 `5daddec42d599ce45cd88d72ad00e990c092aeaf`，没有通过主分支自动部署绕过远端 schema 8 与本地 schema 9 的差异。用户要求自主完成、尽量不重复询问；继续使用现有免费资源，不新增订阅或付费超额。

### 本批实现

- I19-01：自选页支持仅关注/持仓、账户、份额、成本净值和目标权重；同基金跨账户保持独立。严格解析拒绝负数、非有限值和类型转换，未知成本/目标保持 null，真实零份额可保存。账户改名同时保留旧 key 墓碑，冲突、存储失败、旧编辑副本不覆盖现有记录；删除持仓需要确认。
- 本地修改保留 `local_pending`，不会因 legacy Gist 上传成功冒充服务端 revision。首页和详情的私人当前行动在存在本地待确认输入时暂不展示，历史入口保留。这只是本地输入保护，完整 Holding/Policy/Decision/策略引用门禁仍待 I19-04/05。
- 共享 `fund_only` 聚合不再跨账户取最后一行或把未知份额补零；缺成本不算伪加权成本，缺目标不自动归一化。Story、Assets、Lab 对缺份额、非法/重复账户、坏本地存储及金额溢出阻断完整组合、权重和快照；非有限显示统一为未知。有效零经济持仓保持明确空状态，不制造有价组合。
- Gist PAT 不等于上传同意。旧同步需要独立、默认关闭的明确同意；撤销、换 Token、外部标签页撤销、超时、同文件新请求都取消/作废迟到结果。只允许封闭 DTO，不回显上游错误；详情不发送本地私人持仓，Lab 的私人 POST 暂待受限 Owner 接口。保留旧数据/PAT，不删除或偷偷上传。
- 自选与手动资产拒绝已观察到的旧标签页覆盖；外部事件只重载，不回写/自动上传。手动资产云端空集合不等于删除，缺少云项不删除本地项；本地变更期间迟到下载不提交。保存读回冲突时不恢复旧 raw 覆盖另一标签页的新值。原生 localStorage get/set 不是跨标签原子事务，本批不作线性一致性承诺。
- 新增离线 `turso_scope_upgrade` 的 plan/rehearse：只读明确 SQLite 快照、固定仓库 DDL 比对、typed 数据/rowid/引用/人口与摘要验证、私有内存逻辑备份恢复和应用仓储读回。无 apply 子命令，不读凭据、不访问远端、不执行输入 DDL、不调用真实应用初始化；证据固定为 `local_turso_schema_migration_rehearsal`，远端迁移/恢复和正式资格均为 false。

### 当前平台事实 · 只读

直接 SQL schema 元数据核对成功，不再依赖超时 Dashboard：远端 schema 8，54 个核心对象均匹配，另有 `turso_candidate_probe_v1` 与 `universe_import_state` 两张项目原有辅助表，分别与候选探针和全集导入工具的固定 DDL 匹配。只输出合同匹配状态，不读取私人账本行或打印 SQL/配置。当前离线合同仍拒绝这两张 extra；下一切片须显式纳入固定可选 profile 并测试，禁止任意前缀白名单。

Render 专用连接已实际读取候选服务和部署，无需浏览器登录：`srv-dab7g0n40ujc73a2ma50`，free、单实例、main/自动部署；最新 live `dep-dav6acrncjis73da03e0` 为上述 main SHA，2026-10-01T13:52:03.67132Z 完成。线上启动命令尚未应用 feature 分支的单 worker 显式限制，Owner 密码材料尚未初始化。此为平台部署元数据，不是本批上线、完整 smoke 或业务耐久验收。

本批未新增云资源、修改环境/计费、迁移云表、写业务/验收记录、轮换/撤销凭据、触发部署或删除旧 Gist。现有 Token 可读不证明权限最小化、轮换或有效期门禁完成。

### 冻结源码最终验证

| 门禁 | 结果 | 范围 |
| --- | --- | --- |
| 后端 Windows | **1308 passed / 78.16 秒**，Python 3.14.4 | 独立合成 DB 与 basetemp；子进程移除宿主凭据；48,171 条 pytest_asyncio/FastAPI 依赖弃用警告 |
| 后端 Linux | **1308 passed / 81.38 秒**，Python 3.12.3 / SQLite 3.45.1 | WSL Ubuntu 24.04 任务 venv，1 条依赖弃用警告；不是云端 CI |
| 前端全量 | **48 文件 / 657 passed / 4.39 秒** | 最后一个手动资产交错写入回归纳入全量；SFC 合成 renderer，不是物理浏览器 |
| 前端类型/构建 | type-check、build、**PWA 7/7** 通过 | 1088 modules / 11.01 秒；自动组件声明包含新表单、门禁和 Vant 输入组件 |

Linux 第一次同一冻结后端全量为 1307 passed / 1 failed：恢复 CLI 返回 `invalid_receipt_timestamps`。保留失败；单项复跑 1 passed / 3.20 秒、原 receipt 只读重放及原顺序全量均通过。122 个后端/工具/合同/workflow 源文件前后摘要为 `2ba87d662beddccca5a3de25beddff166a3bdb7214bd1513cf7ed691cdd30d43`，未漂移。控制时钟为 observed 时间之前 1 微秒可复现相同安全拒绝；真实首次墙钟回退仅为推断，未证明。不改时间守卫、原 receipt 或标记以换通过。

最终 `dist/assets` 的 JS/CSS 为 56 文件，raw **1,308,951**、gzip **466,698** bytes。对照修改前 55 文件 raw 1,264,368、gzip 452,359，分别 **+3.53% / +3.17%**，局部预算 PASS（<20%）。同机 Node v24.14.0/zlib 默认 gzip，两侧各重复读取同一产物三次一致，不是三次独立构建或旅程测速。前节 gzip 455,171 为旧压缩口径，不用于此次差值。没有新增依赖，真实设备/warm/cold/请求量未验收。

Git diff-check 通过，仅 CRLF 提示；45 个有限改动路径的常见秘密模式扫描无命中，不称全仓安全审计。Worker 本批没有改动；前批 144 项/check/dry-run 属于前批证据，不声称本次实际 deploy。

### 后续实现边界

I19-02 已完成只读设计复审：同步模型、独立 `owner-sync-schema-1` 扩展、当前状态/changes/幂等 receipt 同事务；字段 revision 防止 A→B→A 绕过，墓碑生命周期防止旧设备复活，原响应精确重放，提交结果未知仅查询 receipt。先实现隔离合成库中的仓储/失败测试，再接受限 Owner HTTP；不把新表加入自动启动迁移，也不扩张 Admin/Worker 权限。远端批次需真正 CAS 失败中止与提交协调，不能把本地事务称作远端验收。

三端应用版本仍 8.0.0，schema 9 独立管理。整个 I19-01/02、I18 持久化出口、真实 Owner/设备/PWA、自然任务观察和正式 v9 发布未完成；工作项仍未勾选，正式发布 **BLOCKED**，总目标继续进行中。

## 2026-10-02 · I19-02 候选事务与受限 HTTP

前一批检查点为 `bacbec1a0540a40bb29d5f1a94fd9ca4fc2b934a`，已推独立 v9 分支；main 仍是 `5daddec42d599ce45cd88d72ad00e990c092aeaf`。本批继续不部署、不上传真实持仓、不更改平台/计费/凭据。

### 实现与故障边界

- 原始 JSON 同步模型固定字段、key、128 KiB/8 层/200 操作与 JS 安全整数，拒绝额外字段、重复键、类型转换和非有限值。幂等原文保留数值 token；有限业务数值 `1`/`1.0` 可相等，null/零/布尔仍分开。
- 独立五表 `owner-sync-schema-1` 仅显式 SQLite 合成候选初始化，严格验证核心 schema 9 与所有对象。DDL 单项 16 KiB/对象 128 个有界读取，内部索引/sequence 缺损、未知对象、附加/temp schema 拒绝；没有加入自动启动或 Turso adapter。
- 原子状态、字段/生命周期 revision、追加 changes 与幂等 receipt；不同字段可合并，同字段 ABA、kind 变化、删除/恢复生命周期及旧设备复活均有回归。账户更名可在同批删除旧 key/创建新 key，目标碰撞整批拒绝；无变化不增加 revision，确定 409 与成功精确重放。
- 真实 SQLite 多连接/WAL 验证固定 upper 游标分页。提交前故障回滚；commit 已完成后抛错、连接 close 错误/丢失响应均为 unknown，不自动写重试或补偿删除；只读 receipt matched 可找回原结果，absent 不证明未提交。源记录与最新快照/头部完整性检查不等于防任意 SQL 篡改。
- 测试显式挂载的 Owner HTTP router 支持同步/增量读取/receipt 核对，未加入 main 或前端。Owner 与 Admin/Worker/Private Read 角色继续分离；上传同意头独立于 Gist。body 前鉴权/限频、body 5 秒、事务/commit/私有响应前摘要会话复核、固定脱敏/no-store。退出前未提交写回滚，已提交后退出仅阻止私人响应，不伪造已撤销提交。
- 离线 scope 升级的 `known-operational-v1` 显式 profile 精确保留候选已有两张辅助表（0/1/2 张组合）；未知对象和额外 trigger/index/view 仍拒绝。typed 行、rowid/sequence、独立内存恢复与计划绑定纳入验证，没有云 apply/export 能力。

### 最终冻结验证

| 门禁 | 结果 | 范围 |
| --- | --- | --- |
| Windows 后端全量 | **1576 passed / 137.28 秒**，exit 0 | Python 3.14.4；独占合成 DB/basetemp，子进程移除宿主凭据；62,763 条现有依赖弃用警告 |
| Linux 后端全量 | **1576 passed / 134.46 秒**，exit 0 | Python 3.12.3 / Ubuntu 24.04；仅 PATH/LANG/合成 FUND_DB/禁用 pycache 四个环境键，1 条 Starlette/httpx 弃用警告；不是云 CI |
| 独立只读仓储复审 | **64 passed / 5.08 秒**，exit 0 | kind ABA、删除/恢复/再删除额外验证拒绝旧请求且业务数据不变；无新 P0/P1 |
| 离线升级专项 | **109 passed**，Windows 25.01 秒 / Linux 31.84 秒 | 本地显式 profile、备份/恢复与 CLI 合成故障，不是远端恢复 |

Linux 全量一次通过；131 个后端/工具/合同/workflow 源文件前后 sorted flat `[path, rawSHA256]` 摘要为 `6eef4144dd9823fc2a4531f159e7cad805b0ca815e68af18d317a2651942a4e2`，无漂移。原 stdout 保留在工具输出；WSL `/tmp` 实体日志后续消失，不宣称有持久实体日志。首轮 HTTP 专项曾发现 JSON key 顺序导致原响应/重放字节不同，已修复为同一 canonical 响应再通过全量，不当作偶发或隐藏失败。

本批未改前端/Worker，不冒充重跑其前批 657/PWA 和 144 项证据。有限改动路径秘密模式扫描零命中，diff-check 通过，仅 CRLF 提示；不称全仓安全审计。

### 下一道门禁

先推同一 feature 检查点，通过草稿 PR 运行既有三端标准 runner CI，PR 路径明确跳过 deploy/candidate_smoke/formal_smoke，不推 main。继续实现默认关闭的客户端 durable outbox/冲突/receipt 状态机，以及受控远端逻辑快照/原子前像/提交核对和独立恢复。应用版本仍 8.0.0；真实存储出口、云同步、多设备旅程和完整引用链未完成，不能发布 v9.0.0。

## 2026-10-02 · 客户端候选队列与只读快照

上一检查点 `b4eb596457c37905837d8e1164486faa62f58d48` 已推到同一 feature 分支并创建草稿 [PR #3](https://github.com/AureliusWu/fund-compass/pull/3)。既有云 CI [36958869253](https://github.com/AureliusWu/fund-compass/actions/runs/36958869253) 全部通过，实际测试 merge SHA `523d6d2bde90c281b5d36cd34846fc57244143c1`：后端 1576、前端 657、Worker 144 项；前端类型/构建与 Worker check/dry-run 通过，deploy/candidate_smoke/formal_smoke 按 PR 条件跳过。这是上一检查点的云 CI，不是本批部署。

### 实现及独立复审

- 纯同步 DTO 对原始 JSON、封闭字段、UTF-8/重复键/安全整数/数值 token 与成功、冲突、receipt、固定 upper 分页逐项验证；共享四个独立 Python/JS 摘要向量。没有请求、存储、会话或业务初始化副作用。
- 显式注入的 IndexedDB 单槽 outbox 保存原 raw/hash，真实事务 CAS 防止跨标签争抢；事务 complete 后才返回，本地版本不因清槽归零，防止 ABA。quota/超时/损坏/不兼容结构不回退 localStorage，未知或 attempted 请求不允许删除/换 ID。
- 候选控制器默认关闭、未接入应用 UI/实际 transport/Owner Store；发送前先提交 attempted，断线或未知结果保留原字节。receipt 使用原 ID/hash；仅显式手工确认可重发相同请求。完整固定 upper pull 是基线，POST 观察到的 head 不冒充 checkpoint，不自动改旧草稿。
- Owner HTTP receipt 必须单一规范 `X-Owner-Sync-Request-Hash`；缺失/重复/错 hash 不泄露原收据，不存在/不可核对均 unknown。router 仍只由测试挂载；未来线上接入须更新显式 CORS allowlist。
- 新 schema-8 只读快照模块使用固定单批 Hrana 3 SQL 事务，校验闭集 schema、typed 行/rowid/sequence、完整性、commit/autocommit/close，仅返回私有内存。无默认网络、凭据发现、文件输出或云 apply，历史快照不是应用时原子前像。

独立复审实证两处控制器 P1：撤销发生于 transport 微任务前仍会启动 POST；同 key/kind 的错误数值成功响应会 confirmed。修复为实际调用前再核验取消/会话，以及逐 requested scalar 比对，原复现两例通过。另修复 outbox 仅请求 strict 却未核验实际 durability；降级、缺失和 getter 异常在任何写事务请求前拒绝。真实 fake-IDB commit 后、wrapper complete 前关闭会返回 closed，但重开仍保留已提交原字节；该窗口不是回滚证明。

快照最初依据协议文字闭集拒绝合法 replication_index 与无 padding BLOB；对照 [官方序列化实现](https://github.com/tursodatabase/libsql/blob/main/libsql-hrana/src/proto.rs) 离线回放五类拒绝后，显式支持 optional null/规范 u64 字符串和两种规范 BLOB 编码。未知字段、错误尾位/乱 padding 和数值类型转换仍拒绝。没有用通配字段或重试掩盖失败。

### 冻结质量门禁

| 门禁 | 本批结果 | 证据范围 |
| --- | --- | --- |
| Windows 后端全量 | **1771 passed / 179.89 秒**，exit 0 | Python 3.14.4；独占合成 DB/basetemp、移除宿主凭据；67,438 条现有依赖弃用警告 |
| Linux 后端全量 | **1771 passed / 181.46 秒**，exit 0 | Python 3.12.3 / SQLite 3.45.1；空环境+loopback 限制、独占合成 DB/basetemp；1 条 Starlette/httpx 弃用警告；只运行一次 |
| 前端全量 | **51 文件 / 801 passed / 3.25 秒** | 候选 DTO 68、outbox 48、控制器 28 项纳入；合成测试不是物理浏览器/落盘验收 |
| 前端类型/构建 | type-check、build、**PWA 7/7**，exit 0 | 1088 modules / 9.26 秒，候选模块未接生产入口 |
| 局部生产包体 | **56 文件 raw 1,308,951 / gzip 466,698 bytes** | 相同 Node/zlib 口径三次读取一致，与上一冻结包体完全相同；非真实旅程测速 |

Linux 148 个指定 backend/tools/contracts/workflows 源与固定数据文件前后摘要一致：`731b7c3377a2909bc31d73915f0ccf685df19cb630c803cb3d9c7eba34980fa6`。持久全量日志位于本机 Temp 私有任务目录，摘要 `3082d8bd31ca727bc1e8c09e0c5a55915a4f4b015281680caff6b712ca69aa29`；不宣称该指纹覆盖所有跨端文件。快照两文件分别冻结为 `2e2b5800f64f68c66f089c8f5edec7750808f6a78c4285eb3668dfdd0311df02` / `eb43680ad11291ad87d3a5068effead0b9c713b72b84748c54ed6ba0ebfbb0be`。

新增仅 dev 的 fake-indexeddb 6.2.5 固定版本，下载摘要已与官方 npm 包一致，无生产依赖升级；它是内存实现，不证明物理磁盘耐久。初次新增等价数值 fixture 误将 field revision 写成 1.0，严格整数守卫正确拒绝；fixture 改为金融数值后通过，未放宽 DTO。另有错误调用脚本名 typecheck，已改用仓库 type-check 并通过。

一次临时测试误调用 Windows Python alias，manager 在 backend/Python 下载了 runtime 后因缺 pytest 退出，未运行协议测试。原始失败保留；后续使用确切已有 Python 路径。该纯生成目录经确切路径核验已可恢复移出仓库到本机 Temp `fund-compass-python-alias-artifact-20261002-1133`，未删除/提交，不计入测试或源码证据。

上述冻结测试早于下面的真实捕获及兼容性修改，不能作为修改后源码的全量证据。本批代码仍默认关闭真实同步，未上传持仓、改云 schema/平台/计费、旋转凭据或触发部署。应用三端仍 8.0.0；远端原子迁移/提交核对、独立恢复、真实 UI/设备/Owner/引用链、自然任务与正式证据未闭合，v9.0.0 发布仍 **BLOCKED**，总目标继续。

### 真实候选读取失败及定位

第一次只读捕获返回固定 `capture_sql_failed`，没有生成快照文件。受保护目标目录复核仍为空，不称迁移/恢复成功。随后执行一次同一冻结 SQL 计划的有界只读诊断：HTTP 200、batch 第 0 步 `query_only_on` 为 `SQL_PARSE_ERROR`，BEGIN 与全部后续读取 skipped，独立 `get_autocommit`/close 成功。诊断只输出固定步骤标签和错误分类，没有回显原始 SQL、上游消息、数据或凭据；不是浏览器登录失败，也没有进入业务读取/云写入。

现场步骤与 [libSQL SQL 分类器](https://github.com/tursodatabase/libsql/blob/main/libsql-server/src/query_analysis.rs) 对 `query_only` 赋值的拒绝一致。修复采用明示的 `turso-fixed-read-v1`，保留默认严格路径、不自动降级或重试：固定事务和读取 SQL 不包含云端 DDL/DML/PRAGMA 赋值，保留 schema、typed 数据和事务关闭校验；真实 query_only 观察值单列，明确不宣称服务端强制禁止写入。修复后的测试和真实捕获另记，不覆盖此次失败。

## 2026-10-03 · 真实快照及本地恢复演练

恢复执行后核对工作区：feature HEAD 仍 `b4eb596457c37905837d8e1164486faa62f58d48`，严格默认保留，新增显式 profile 已落地。兼容性两源文件冻结 SHA 为 `3c3041a305fbc0ae1cb8922b6da47dcb2a6b44acfc0bc6f68efb2b72aa4339c7` / `36ffa53c1743f604b93676b1d221e68ce34a0bec2a5b7ce50d95aea1bf983a71`。独立只读复审无 P0/P1，隔离 snapshot 专项 **214 passed / 4.82 秒**，Python 3.14.4 / SQLite 3.50.4，1,655 条依赖弃用警告；前后两 SHA 未变。

仓库外的捕获 wrapper 显式绑定该 module SHA、候选资源、两张固定辅助表和兼容 profile，TLS/no-proxy/no-redirect/零重试/一次发送，30 秒捕获预算和 60 秒进程上限，stderr 丢弃、stdout 闭集脱敏。父代理完整审查后修复准备稿 metadata 的 dict/set union 错误，再运行 **10 项合成测试全部通过 / 1.812 秒**、PowerShell 语法检查 0 错误；旧失败和旧脚本保持不变，不以准备状态冒充执行。

真实一次捕获返回 `captured_and_locally_rehearsed`，闭集结构、typed 行/rowid/sequence、SQL commit/autocommit/close 通过：**schema 8 / 21 张表（含 SQLite sequence）/ 31,957 行**，`query_only_observed=0`，服务端写保护未验证。受保护目录仅当前用户/SYSTEM，文件 exclusive 创建、fsync/关闭并设只读；实际文件 SHA 再次核对一致。所有私人明细及凭据在仓库外，不上传 GitHub。

| 绑定 | 摘要 |
| --- | --- |
| 源文件 / 逻辑备份 | `91701641e9c19afda8f238ddc8610d05dd9f505c9aa27da9be9f78c32d0058d5` |
| 源 typed 行 | `fbd2dce0fe69b593ed964723fd6ea5ac3dd8fbc64b7cb6faf59d315993442846` |
| 源结构 | `8f80638a6e5ace5ebddb15f2843b5883a5c1a5db4a82ee7a482725770c70be80` |
| 本地计划 | `9705e911e2863e9c0d0367c32ca217fe5c83f3c150b1f58e10c36a2320b2d625` |
| 目标 typed 行 | `e222cf3d64efb6a4929c3aa758d0d1094feeb1e008e71a2c734c724a29360a0f` |
| 目标结构 | `2a1a0f72c71b4102ce00e10606456413bdf77887007adf7b0ac22618bce3ef74` |

本地 8→9 演练明确验证 `legacy_rows_unchanged`、`local_logical_restore_verified`、`repository_roots_readback_verified`、`source_file_unchanged` 为 true。捕获历史快照不是应用时原子前像；`remote_verified`/`remote_applied`/`remote_restore_verified`/`formal_release_verified` 均为 false。此次没有云端 DDL/DML、schema 迁移、持仓上传、凭据/计费/平台变化或部署。远端仍 schema 8；下一步是受控原子迁移及 unknown 提交核对，不重复要求用户浏览器操作。

修复后同一冻结源码的两平台全量通过：Windows **1812 passed / 172.91 秒**，exit 0，68,235 条现有依赖弃用警告；Linux **1812 passed / 206.80 秒**，exit 0，1 条 Starlette/httpx 弃用警告。148 个有限 source/data 文件两侧前后均为 `2f0b12260bc0b196d1902bb7d46ddca200e0b412c9bff7465331dfbb53a70217`。持久日志摘要分别为 Windows `bcb3edcbd1563c32a919bcd19314403b1d368c3998d8270eb8f5f72ea51fb809`、Linux `40b95a703b8ba80432a5b87a9cfe3b4be262f128d0fa39f58c12a70b87db5ee4`；测试均为隔离合成库，不访问真实云或凭据。

电脑控制技能仅尝试识别既有 Chrome，发现未运行后启动已安装 Chrome；状态读取被平台停止，原因是无法可靠识别当前浏览器网址以执行安全检查。已停止全部 UI 输入，不重试或改用不受支持的控制/会话提取方式；没有操作 Turso 管理页、生成密钥或更改访问。直接数据库捕获路径不依赖此能力。

提交前 fetch 发现远端状态已改变：main/原 feature 同为 `997e3b02603612498d8c0488e5884a3e86f1dd2e`，旧 PR #3 已 closed，原 feature 非快进重置。新 main 只在原 `5daddec` 之后增加海外账本数据，不包含三个 v9 feature 检查点。为保留远端当前状态，不强推/重开原 PR；本批改在新升级分支保存，再合入最新 main 数据并重新核对。上述测试早于合入；最终目标需绑定合入后的确切 SHA。

### 新分支、数据合入及最终复验

本批保存为 `51c56a5`，新分支 `feat/v9-owner-sync-snapshot-20261003` 正常合入当前 main，形成 `9c422d499cb78d936dea38e52793ebd3707d5c5b`。合入只改三份海外账本数据，逐文件 Git blob 与 main 完全一致；后端/前端模块未覆盖改写，快照两 SHA 不变。已推送并创建、附着新草稿 [PR #4](https://github.com/AureliusWu/fund-compass/pull/4)，main 和原 feature 仍 `997e3b0`，未强推或重开原 PR。

| 合入后门禁 | 结果 | 冻结证据 |
| --- | --- | --- |
| Windows 后端全量 | **1812 passed / 179.38 秒**，exit 0 | Python 3.14.4；空子进程环境、独立合成库；68,235 条依赖弃用警告 |
| Linux 后端全量 | **1812 passed / 195.20 秒**，exit 0 | Python 3.12.3 / SQLite 3.45.1；空环境/loopback guard、独立合成库；1 条依赖弃用警告 |
| 前端全量 | **51 文件 / 801 passed / 5.45 秒** | 14 条既有合成组件解析警告；不为掩盖警告做无关改写 |
| 前端类型/构建 | type-check/build、**PWA 7/7**，exit 0 | Vite 1088 modules / 11.31 秒；命令时长另含准备及验证 |
| 前端包体 | **56 文件 raw 1,308,951 / gzip 466,698 bytes** | 三次同口径读取完全相同，与先前基线无变化；非真实交互/网络性能 |

后端 148 文件前后指纹均为 `d681db01fa5ff2d9e9ef66bc6426a49d5fbbc88866d16ac6fad7c8595c9dd273`，Windows/Linux 独立新任务目录不覆盖旧证据，日志摘要分别 `9b26aa647a413958bbc2945fa3ac3e99e91c1b1de92597024687f3317c0c118c` / `5bda357623e9e96f74498d5641b7a4e02eb4ee7393d3438542e92aa8ce35ce89`。前端有限 219 tracked 文件指纹前后均为 `3ee95ebe8d067477a49b57a0b1d48d5deb55f487a261fd4971e54b39af5993e7`，完整结果摘要 `e2214f911cddbc45601718673e982b1b1c313fc8d0df057e9ed2290efdea85da`。三个本地 gate 均确认相同 HEAD，源码未漂移。

[云 CI 37095982484](https://github.com/AureliusWu/fund-compass/actions/runs/37095982484) 全部通过：head `9c422d499cb78d936dea38e52793ebd3707d5c5b`，实际 resolve/三端 checkout/Verify exact source 均为 merge SHA `40193b9101eae7418ce824c7ae8c844810e97710`。后端 **1812 passed / 55.84 秒**、前端 **801 passed**、Worker **144 passed**；前端类型/构建/PWA 及 Worker check/dry-run 通过，Worker dry-run 114.28 KiB / gzip 26.58 KiB。deploy/candidate_smoke/formal_smoke 均 skipped，是草稿 PR 回归，不是部署。公开仓库标准 runner，未启用付费 runner。

Render 专用连接只读复核：候选服务仍 free/单实例/main auto-deploy；最新 live 为 `dep-davqqf6q1p3s73djsb2g`、main `997e3b0`，2026-10-02T13:11:43.9281Z 完成；上一 `dep-dav6acrncjis73da03e0` 已 deactivated。此为中断期间现有 main 的平台元数据，不是本 feature 上线或完整 smoke。未读取 Secret/私人日志、修改环境或触发新部署。

继续保留 draft 与正式发布阻断，应用版本仍 8.0.0。下一安全切片为受控远端原子前像/迁移 receipt/unknown 核对；先用本地合成故障及容量验证，不能以本地快照、绿色 CI 或版本号替代真实云端应用/跨重启/独立恢复、完整同步与自然任务出口。

### 原子迁移 SQL 原型与真实数学能力预检

上述门禁记录提交为 `df819d1dfaf9746c828ea5563e5f06f1c88f1653` 并正常推送。独立只读复审核对 [CI 37096630658](https://github.com/AureliusWu/fund-compass/actions/runs/37096630658) success：实际 resolve/后三端 checkout 与 exact-source 断言为 merge `6fb5f4dbb288ca5001372f958837331d99ec4a7c`，parents 为当前 main `997e3b0` 和该 head。后端 **1812 passed / 57.97 秒**、前端 **801 passed / 51 文件**、Worker **144 passed / 3 文件**；类型/构建、PWA 7/7、Worker dry-run 均通过。三类 deploy/smoke 仍 skipped，不是部署。

仓库外冻结的合成原型已由父代理完整读取代码、测试、runner 与边界说明，有限文件 SHA 逐项核对，最终 **50 passed / 1.32 秒**、exit 0、541 条依赖弃用警告。31,957 个合成源行生成单 pipeline **306 steps / 每语句最多 900 args / 7,491,952 bytes**；本机 compile 1.482089 秒、apply 0.244243 秒、reconcile 0.681960 秒。失败/NULL/空 scalar 触发实际 SQL 错误，DDL/scope/version/receipt 前缀故障整事务回滚；真实本地提交后模拟丢响应、关闭重开同 id+digest 只读核对成功。原型不读取真实快照或凭据、不连接云、不编辑 repo；可变 Plan、显式 receipt rowid、完整输入准入与实际提供方容量/时限仍需正式硬化，不直接用于远端写入。

为保留真实零值而不是缩窄合法数据域，原型使用显式 `sqlite-atan2-zero-v1` 检验 REAL 正负零；缺少数学能力或语义不符会在 DDL 前失败，不降级。父代理完整审查冻结数学探针的 Python/PowerShell/两类合成测试及 README，核对源和 wrapper SHA，准备测试为 **24 项 unittest / 0.718 秒**及 **25 项 PowerShell JSON/字节管道用例**，语法错误 0。

随后仅使用用户给定的准确凭据文件、现有候选资源做**一次**有界只读数学 SELECT，无 FROM/表查询、DDL/DML、PRAGMA 赋值或第二次发送：真实 literal ±0、bound ±0、integer/REAL 绑定类型、autocommit、stream/session 关闭均为 verified true，固定 envelope `ok=true/error=null/permission_stop=false`。TLS 校验、无代理/netrc、无重定向、零重试、256 KiB/10 秒及 20 秒进程上限保持；只返回闭集布尔，不回显 URL/Token/原始结果或错误。此次四个 remote/apply/restore/formal gate 均为 false，数学能力不能证明真实迁移、并发锁、停写、恢复或持久化。

原型 source SHA 为 `29fbfdcd13ce688087936d0fd4e15882e80467d73e91f7415a5c90613b1d8019`；最终测试/容量日志摘要分别 `efabfea5b1dea25035bd7935c0b6d6444b1dc1d2b7b6d3555cb9204d066b54b2` / `957fd5150a05b890ce12985eff0a453f2bf9bf3c161c782368842f138b491b20`。数学探针/进程 wrapper SHA 分别 `0daf409e326b6afb0dd17279b752833a258686dd0a5b80f3a988751e56008f94` / `da31ff3925752daf40a2c6d3285c4793dc697be3af3c9ea5713c8d0dea4a23de`，绑定旧 snapshot module `3c3041a3`；后续 source 改变必须使旧 pin 拒绝，不能机械把历史成功改写成新源码或自动更新旧 wrapper。

### 私有 raw inventory 实现及两平台复验

已将上述缺口落实为 capture 的私有 `_schema_inventory`：保留同次历史事务的完整原始四列、SQL=NULL/internal 对象，frozen/slots/repr=False、版本域 typed 摘要及同次 resource/image/rows 内部绑定；公开 metadata、kwargs、旧两参数构造兼容，不自动执行 DDL、输出/落盘原始结构，也不授予 apply 能力。格式等价准入仍不会把原始拼写改成归一化值。未来 compiler 必须重验闭集和各项绑定并在真实锁内断言，旧文件不能补造 raw inventory。独立只读复审未发现本补丁 P0/P1。

首轮 Windows 新专项为 **1 failed / 260 passed**：故障模拟在 SQL 第一步失败后读取 skipped schema=None，导致 fake response 未生成；不是源库/云错误。修复为 SQL/cleanup 分支不读 schema，并将 raises 绑定真实固定 SQL/cleanup/schema 错误码，防止其他 fixture 异常假通过。失败日志保留，摘要 `278097c404b86d26a4ca1e47e0d9a0311f5a6b82277defd9afa42a384351f17a`；Linux 当时尚未执行，仅保留未使用 runner，不补造 Linux 失败。

| 最终门禁 | 实际结果 |
| --- | --- |
| Windows snapshot | **261 passed / 5.75 秒**；exit 0；2,102 条依赖弃用警告 |
| Linux snapshot | **261 passed / 6.01 秒**；exit 0 |
| Windows backend 全量 | **1859 passed / 169.86 秒**；exit 0；69,362 条依赖弃用警告 |
| Linux backend 全量 | **1859 passed / 177.14 秒**；exit 0；1 条 Starlette/httpx 弃用警告 |

所有上述最终门禁绑定 source `8dae7943088f805e7a7719cfb37ac85c33d5043ecfc6d30884e77817edba7298`、tests `a136d776c3b0c444ce58495bb9c3860206bd624a2ad979f54cbac40e49764d08`，有限 148 文件两平台前后指纹同为 `ddd2c995b31e84b140236e4085490d3748864bef3d675f9cf1f44c1bfc4c0e12`。Windows 专项/全量日志摘要分别 `eb0d0a4ed600f5239b000702ab2b32625005365d14c600d249bc80cb0eeace56` / `0edea56d8d44b7f4ded8317b16f5a9eb73b11cef5121ac150eacb1ce5c70c110`；Linux 专项/全量分别 `77ebe814234ea993a7a1b12af5c46eea49dc825c03a1435cc689b307a1a1c206` / `ea55c179811f0c2cdf9a4f030d25a185287f73503d3e062d272ebffa495c0f4c`。独立目录/库/basetemp，无真实云、凭据或输入快照访问。前端/Worker 未修改，最新三端 CI 另绑定提交核验。

### 私有 sidecar 实际保存与非临时备份（2026-10-03）

代码 checkpoint `1e260836acdb47769975687dd738c20df3ce1e75` 的 [CI 37097342554](https://github.com/AureliusWu/fund-compass/actions/runs/37097342554) 已 success。独立实际日志核验 resolve EVENT_SHA、4 个 checkout 和 3 个 Verify exact source 均为 merge `9163af85aff67a6517cdfba1604f4e2540c11024`。后端 **1859 passed / 51.64 秒**、pip check；前端 **801 passed / 51 文件**、type-check/build/PWA 7/7；Worker **144 passed / 3 文件**、check/dry-run 均通过。三类 deploy/smoke 仍 skipped，不是部署、耐久或正式发布证据。

新私有捕获工具由父代理全文审查并核对冻结指纹。修订 01 的合成测试虽 27/37 通过，独立复审发现大小写 JSON 键覆盖 P1 与子文件 ACL 证据 P2；没有用它执行真实捕获，原文件和失败日志均保留。修订 02 改用 Ordinal 字典、拒绝大小写碰撞/未知键，目录要求 CI|OI/None，成功前复核两个 exact 子文件 owner/ACL/只读/非 reparse。最终 **27 Python tests / 2.881 秒**、**54 PowerShell cases / parser 0**、exit 0，独立复审所报缺口闭合。helper/wrapper SHA 分别 `41f8da4a25c3124152afb084dfd6ecd046ae03fd95162e3d26faf5bd69518ad1` / `e14c935c438324255832ce5d66670b85c3f90307ea0ed433dadfb28907a75ac0`，producer 仍为上述 `8dae7943`。

随后父代理使用用户指定的准确凭据文件，对同一候选资源执行**一次**有界 fixed-read 捕获，无重试、浏览器、管理请求或云端 DDL/DML。实际 exit 0：schema 8 / **21 表 / 31,957 行**，保留同次历史原始结构；本地 8→9、独立逻辑恢复、仓储读回、旧行与源文件不变均 true。父代理再次核验文件 SHA、owner=current user、仅 user/SYSTEM 两条 Allow ACE、只读/非 reparse；原始 SQL、私人行和凭据均不进入仓库/输出。

| 私有闭合文件 | 字节数 | SHA256 |
| --- | ---: | --- |
| SQLite 源镜像 | 3,969,024 | `91701641e9c19afda8f238ddc8610d05dd9f505c9aa27da9be9f78c32d0058d5` |
| 原始结构 sidecar 文件 | 27,236 | `7f101cbb8e63243f5c640ed59bd1ca796105dd535c23b49fe3b651e46193fd08` |
| 闭集安全结果日志 | 2,517 | `818e95266256f222c6a21f57a39c468c857ae6319cd432350f47ca4a65be43b9` |

sidecar 文件摘要不是 DTO 内部 raw schema 摘要；后者只保存在私有文件，必须按版本域和 source/resource/rows 三绑定重验。新镜像与此前镜像摘要相同，表示本次读取的数据一致，不是给旧文件补造 raw inventory。此次工具调用及父进程总时长不作为远端 SQL 时长或性能门禁。

为避免 Temp 清理丢失检查点，另在仓库外 `fund-compass-private-backups/20261003-schema8-private02` 保存三个 exact 文件的非临时副本；受保护 user/SYSTEM-only 目录、CreateNew/fsync/关闭/只读、逐文件源与目标 SHA/ACL 均通过，实际 copy exit 0，原 Temp 文件未移动或删除，未复制凭据。该目录位于项目同级，不是 Git/Pages/CI artifact；本地另一份副本仍不是独立远端恢复、长期异地备份或云端耐久证明。

四个 remote/apply/restore/formal 旗标均 false，query_only_observed=0、server_write_protection_verified=false；云库仍 schema 8，应用版本仍 8.0.0。正式纯编译候选的完整前后像/回执合成验证在仓库外推进，但父代理复审又发现其 safe metadata 构造闭集不足，已合成复现并要求新修订，未集成或发送该候选。下一步仍为闭合 compiler/响应核对、真实停写/容量/原子迁移与独立远端恢复；不删除旧 Gist、不更改凭据/计费或部署。

### 纯本地迁移包集成门禁（2026-10-03）

上述文档 checkpoint `73bc1dad93dddae2980c845cd3d7bb0b5dadc065` 的 [CI 37098559780](https://github.com/AureliusWu/fund-compass/actions/runs/37098559780) 已成功。实际日志核验 resolve、4 次 checkout 与 3 次 Verify exact source 均绑定 merge `6150d0b435aaad27d08675b69c7f659a2ecf206c`，parents 为 main `997e3b0` 与该 head。后端 **1859**、前端 **801**、Worker **144** 项通过；类型检查、构建、PWA 7/7、Worker dry-run 通过；deploy/candidate_smoke/formal_smoke 均 skipped，不是部署。

旧 compiler 候选可通过 dataclass replacement 将未知私有键或伪造远端 flag 送入公开 `safe_metadata`；发送前重编译仍会拒绝，并非云写授权绕过。原失败候选和复现日志保留。新修订在构造与 getter 校验完整键闭集、exact native 类型、枚举/digest/包长度/计数/代码绑定及六项 literalFalse，getter 另核 metadata seal；198 项合成测试和全文独立复审未发现新增 P0/P1。seal 仅防元数据替换，不是签名或写入资格。

已通过 `apply_patch` 接入 `backend/database/turso_scope_packet.py`、`tests/test_turso_scope_packet.py` 与独立内存 fixture。除 compiler 首行说明外与复审冻结源一致；测试只改模块 import 并增加 function-scoped socket/默认 DB/普通迁移禁止夹具，helper 移除 TEMP 原型/全局补丁/自动 benchmark。模块未被生产 main 或路由导入，没有网络、凭据发现、文件输入或 apply。固定 DDL、完整 raw/typed 前后像、schema CAS 与新回执精确十列在同一计划事务；旧回执保留，未知结果禁止自动重放或回收。包体/参数/artifact 是私人载荷，不上传公共产物；未来发送必须用外部原始 resource/plan/packet SHA 重编译，不能只检查安全摘要。

| 项目门禁 | 实际终态 |
| --- | --- |
| Windows packet 专项 | **198 passed / 10.03 秒**，exit 0；1,681 条依赖弃用警告，stderr 空 |
| Linux packet 专项 | **198 passed / 22.23 秒**，exit 0；无 pytest 警告 |
| Windows backend 全量 | **2057 passed / 164.24 秒**，exit 0；74,022 条依赖弃用警告，stderr 空 |
| Linux backend 全量 | **2057 passed / 194.47 秒**，exit 0；1 条既有 Starlette/httpx 弃用警告 |

Windows Python 3.14 使用清空配置环境/新默认 SQLite/独立 basetemp，新增 198 项夹具禁止 socket、配置 DB 与普通迁移；不声称 Windows 全套 runner 具有全局网络封锁。Linux Ubuntu 24.04 / Python 3.12.3 / SQLite 3.45.1 使用 env-i、独立默认 DB/basetemp、禁止外部 socket 的插件；均无真实快照或凭据输入、未执行云操作。两平台有限 151 文件前后指纹均为 `cf9fd068503a0aaae92a24acaa6a7c0dc383135059e1283b057cba7a17694dce`。集成 source/tests/helper SHA 分别为 `ee01ad893e1db5c8cac4fdc082f2f0c00e2df3568b4d80a6c557f6d6eb0263e0` / `086c67dcf8520548f58c0874b2560f4e7bb928a7c362364a1333b48e29501a0c` / `24ef3868c480a323df6c91c4c5377ea97f630a0cf9f690d843418b42f74c864e`，父代理已独立读回日志及哈希。

Windows 专项/全量 stdout SHA 为 `2712929068ff8ddbb31850d493faff2c6671fd16e11dc541d77d02d6ade1f579` / `7535895cc50425e2dc18495ed2f90ba210d9bd7babc3bd6c30a2a8aee45e86a9`；Linux 专项/全量 log SHA 为 `06b3de52546a871c18ba2558b36a55761ff1b6c85d8dadd0396fa6d14752fa10` / `8ec83f6f2949e245325fe9790d77e62b17e87934d1a28032fb3b9f8e334047fa`。本批项目接入无失败 attempt；仓库外候选首次语法失败与旧漏洞复现仍保留，不混为项目终态。

仓库外 32,197 合成行容量样本产生 15,165,639 字节、586 步、最多 900 参数，本机执行 0.556947 秒；这是单次方向性本机结果，不是 Turso 事务限制/性能/云端应用证明。响应验证器仍在下一道纯本地门禁开发，无 sender 或真实对账。应用版本仍 8.0.0、云库 schema 8、六个 packet 远端资格 false；不合并 main、不创建 v9 Tag/Release、不删除 Gist、不更改凭据或收费配置。正式发布仍 BLOCKED，目标工作继续。

### 中断后基线复核与正常数据合入（2026-10-11）

恢复时 feature HEAD 为 `731297445545d0ce031acb02b8298a49a47b01b9`，工作区干净。[CI 37099567508](https://github.com/AureliusWu/fund-compass/actions/runs/37099567508) 已核对实际日志：resolve、4 次 checkout、3 次 exact-source 断言均为 merge `112ae9472a7416d6ef59d7d3a1e9af98d896e06a`，parents 为 `997e3b0` 与该 head。后端 **2057 passed / 42.02 秒**、pip check；前端 **801 passed / 51 文件**、类型/构建/PWA 7/7；Worker **144 passed / 3 文件**、类型/dry-run 通过。deploy/candidate_smoke/formal_smoke 全部 skipped，不能作为部署或耐久证据。

只读 fetch 发现 main 已至 `1231fc6b7e065275f4ef3a04a4911d60f5e8f88c`，新增 6 个 bot 提交、74 个公开数据变更，无代码/工作流变化；与 feature 相对旧 base 的变更文件无交集。已正常合入升级分支，产生 `7511d807fc7467e887277c72356de6e719f9f41d`，没有 reset、force push 或 main 合并。保留基金全集、富集、经理/筛选清单及配套哈希分片整组更新。旧 CI 不覆盖新 main 的合成 merge，最终 checkpoint 需重新绑定 CI。

海外账本 10-07 的更新是非交易日 heartbeat，仍 74 条；最后有效预测 09-29、结算 09-30。最新 audit 保留并排除 17 条错轴样本，并记录有效预测/结算 `192.6h / 168.9h` 旧化警告。不能把文件刷新日期改写为有效样本日期，也不能将非交易日 heartbeat 当成自然交易日/周任务验收。

正常 merge 的本地前端/Worker 6 门禁均 exit 0：前端 **801 / 51 文件**、type-check、build **1088 modules / 11.92 秒**、PWA **7/7**；Worker **144 / 3 文件**、type-check、Wrangler dry-run **114.28 KiB / gzip 26.58 KiB**。仅 dry-run 保留 proxy 环境警告；未安装依赖、改锁文件或部署。前后 HEAD 均为 `7511d807`，有限 240 文件指纹均为 `aefa0a1149cde3ab58e54ae116e3d6d728a9315b7334d76724f8e85e69e3de5d`，manifest SHA `64e8f5696ff755ba27145ae00bfdb5b803b2a1e5ecc4a15e771822f0188f0c67`。此证据只覆盖该前端/Worker 基线，不覆盖后续响应验证器修改或实机性能。

Render 专用连接只读核验现有候选服务 free/单实例/main auto-deploy，live 为 `dep-db34sck9v7es73cc0490`、commit `1231fc6b`，2026-10-07T13:51:44.940106Z 完成。没有读取 Secret、修改配置、创建资源或触发部署/重启。请求日志工具要求另行确认 workspace，未绕过其选择要求；不以日志缺失猜测根因。

| 公开基线检查 | 结果与证据 | 时长 |
| --- | --- | --- |
| Pages 构建身份 | `release.json` HTTP 200；commit 为 `1231fc6b` | 797 ms |
| API 首次健康请求 | 25 秒上限后取消，没有获取响应，不记 PASS | 25,300 ms |
| API 后续独立有界采样 | HTTP 200/application-json；status=ok、version=8.0.0、deployment.commit=`1231fc6b`、universe=28010 | 1,053 ms |
| 云存储资格 | engine=libsql、persistence=turso_candidate、durable=false；仍提示未完成生产跨重启读回 | 未验收 |

健康响应的 started_at 为 `2026-10-11T11:17:48.198867+08:00`。首次超时后服务启动、后续请求成功，与冷启动相符，但未取得平台日志，不能据此确证唯一根因。上述是旧版本候选的只读身份/健康采样，未执行真实浏览器旅程、升级/迁移、跨重启或独立恢复；完整生产验证 verdict 为 **BLOCKED**。应用版本仍 8.0.0；本轮没有重新查询云库 schema，不把 10-03 的 schema 8 历史观察冒充当前新证据。

### 自然任务真实失败诊断（2026-10-11）

仅用已配置 GitHub 访问只读核对实际 schedule 终态与必要脱敏日志，未手工触发、下载私人 artifact 或修改 workflow。远端 main 仍 `1231fc6b`；下列是现有 main 的自然运行，不是本分支新实现已经上线。

| 自然运行 | 实际终态及有限直接证据 |
| --- | --- |
| 10-05 [holdings 37272579779](https://github.com/AureliusWu/fund-compass/actions/runs/37272579779) | failure；holdings/screener 已成功提交，指数仅 3/6；中证100缺 PB、500全部候选为空、1000缺 PE。没有该 run 的 403 证据 |
| 10-05 [managers 37276042956](https://github.com/AureliusWu/fund-compass/actions/runs/37276042956)、[universe 37288636068](https://github.com/AureliusWu/fund-compass/actions/runs/37288636068) | success；4355 位经理/28010 只基金，不能把指数失败泛化为全部富集失败 |
| 10-05 [calibration 37278915090](https://github.com/AureliusWu/fund-compass/actions/runs/37278915090) | failure；固定必要错误 `outcome audit unavailable: TimeoutError`，上传/提交 skipped；没有鉴权失败或确定冷启动根因证据 |
| 10-05/06/07 overseas `37330956706` / `37471771672` / `37631626027` | success 但 non_trading_day，quotes/predictions/effective/settled 全零；不计真实交易窗口 |
| 10-08 [overseas 37788483412](https://github.com/AureliusWu/fund-compass/actions/runs/37788483412)、10-09 [37938597743](https://github.com/AureliusWu/fund-compass/actions/runs/37938597743) | 均 failure；delayed_same_day / quotes=21 / predictions=effective=settled=0，audit 报 ZERO_EFFECTIVE 和 STALE_EFFECTIVE_PREDICTION，数据提交 skipped |

相关 workflow 均 active；周末没有预期 schedule。海外运行预计北京时间 14:35，10-05～09 实际创建在 21:33～23:12，创建后 3～8 秒即开始；没有依据把小时级延迟确定归因并发队列。失败不提交导致 main 心跳停在 10-07，而非任务没有触发。

源码推导的额外确定阻断：2026 国庆日历下 observation=10-09 → target=10-08 → expected base=09-30，相隔 8 自然日；main 的 7 日限制使正确 base 也被拒绝。这不是读取真实基金详情的结果，不能推断 10-08 的具体拒绝分支，更不能补造历史预测或简单放宽全部陈旧来源。两个失败 run 的 consecutive-zero 均为 2，结合 main 保留旧值 1，可推断失败发生状态没有跨 run 持续留存；应独立保留运维发生状态，不能强行提交不合格财务数据。后续需逐模型日期/原因诊断、明确假日跨期规则、公开运维状态持久化与私有校准 sink 完成；六核心及真实样本门槛不降，I20 仍未完成。

进一步只读源码核验：合法国内假日日期轴不等于财务收益证据合格。现有行情字段为单日 change，不能直接作为 09-30→10-08 的跨期收益；假日修复必须逐腿具备准确 interval-return 证据，否则保留 `period_return_required` 拒绝而非降低陈旧门槛。真实 API 的 stale/data_age_hours 也不能被假日例外豁免。producer/audit/calibrate/export 需共用日期/特征合同并保留追加休市日配置，另以闭集非财务 journal 留存失败 run，不提交四个不合格财务产物。当前 heartbeat/updated_at 取抓取前时钟，workflow 写入的 GITHUB_RUN_STARTED_AT 未被 producer 消费；需明确平台创建/实际执行、脚本开始、输入完成与产物完成时间，不能把开始时间当作成功落账时间。这些是后续待实现设计，不是本轮已经修复的结论。

### 响应合同核验接入与首轮跨平台失败（2026-10-11）

接入纯本地 `turso_scope_response.py` 及 152 项隔离合成测试。必须按外部原始 resource/plan/packet SHA 重编译后，才解释提供的响应字节；前后核 compiler 与自身源码，保留 30 秒总合作预算。`acknowledged` 只表示字节满足本地合同，不认证真实传输、提交、权限或恢复；五项 remote/apply/restore/formal/retry 旗标均 false，没有生产路由导入、sender 或未知提交对账读回器。完整 87 个故障位置仍逐项实际执行，不能以枚举数量替代执行。

仓库外冻结修订 02 的第 04 次 attempt 为 **152 passed / 32.50 秒**、exit 0、stderr 空，实际打印 87 个故障位置；source SHA `313078fceff4c093cdc92181d5d888278d3c815bfeb818fe464ea56e533de7de`。旧候选漏洞复现和第 02 次 `1 failed / 146 passed` 仍保留；该失败是 origin 与原始身份失配检查顺序的固定 reason 不一致，已修复并复审，没有改写失败结果。项目测试仅改正式模块 import，接入时 tests SHA `dcb7b92463f31282df5ce6a215db44f9e980900347c4e82e56f2bb15c00d7c9b`。

| 首轮项目门禁 | 实际结果 |
| --- | --- |
| Windows packet + response | **350 passed / 45.97 秒**；exit 0，stderr 空 |
| Windows backend 全量 | **2209 passed / 277.32 秒**；exit 0，stderr 空；依赖弃用警告保留 |
| Linux packet + response | **1 failed / 349 passed / 263.80 秒**；exit 1 |
| Linux backend 全量 | **1 failed / 2208 passed / 537.40 秒**；exit 1；1 条既有 Starlette/httpx 弃用警告 |

两平台首轮绑定 HEAD `7511d807` 与有限 227 文件前后相同指纹 `bf7f1755059dadb1ba642731929cbd6b3063350e63bc99101a263dc703e6fbcf`。Windows 专项/全量 stdout SHA 分别 `ee152132e9e2f832f29b9377ebb1c9899bad436b5d66814d31d0ec738ed964db` / `d723d497ab39ced1c0a3f8fa09df078529f3827b34d3c9aaff305fe68d33e305`；Linux 专项/全量 log SHA 分别 `13090d4491f2204c5394bca465c66e796dd4c786713c5764f07e66e866ec851e` / `c1086dd1e0332f67290383e6189b98d06fcabfd06a730a4ce8a7932d44009890`，Linux manifest SHA `7e8c4436e02d84be5ff95b0bd4826a96fbc23a95040d6e590b99b5ea6b000b64`。隔离条件同前述 Windows/WSL 门禁，不是操作系统安全沙箱或云端资格。

两次 Linux 失败均为 `test_every_executable_step_fault_has_exact_prefix_rollback`：期望 rollback_acknowledged、实际 unknown_requires_reconcile。原 traceback 没有位置和固定 reason，不能先归因单次核验预算或语义错误；Windows PASS 不覆盖 Linux FAIL。原 attempt 已正常结束、完整日志保留，后续须用真实时钟/原预算/不改变返回值的隔离诊断定位，再用新源码指纹完整复验，禁止跳过 87 位、放宽时限或把旧 PASS 移植到新源码。

### 捕获阶段回调生命周期定位与最小修复（2026-10-11）

父代理与独立复审均全文读取隔离诊断及 wrapper、核对冻结 SHA 后，在同一 Ubuntu 24.04 / Python 3.12.3 / SQLite 3.45.1 / 原 venv 与 `/mnt/d` 挂载上实际运行默认模式一次；未运行 timing 模式。复用原测试的内存 fixture、文件/Socket/配置 DB 门禁，包装原 capture progress 时无条件委托并保留原返回值；不改时钟、预算、SQL 步数或清理 handler。完整 87 位实际终态为 exit 1 / 总 60.6037983 秒，1 次 BEGIN 拒绝确认、85 次回滚确认、1 次 unknown；所有旧 typed rows 均不变。

唯一 unknown 在 **index 81**：reason=`identity_invalid`，单次核验 **0.229716 秒**；该位原 capture progress 实际 `calls=1 / aborts=1 / expired=true`。直接证据支持旧捕获阶段 handler 随 `CapturedSnapshot.connection` 移交而残留，随后旧阶段到期中断编译身份准入，而非这次核验耗尽 30 秒。没有实测 Path.resolve 开销，不把挂载元数据当作已证根因。12 个有限源码、4 个诊断文件与 wrapper 前后 pin 相同；原专项/全量失败日志未改。stdout/manifest SHA 分别 `8a466291034a6751bf0222aaf576d76fe018b1f7cf5050060fc97c39ca1e8b26` / `63058b1a0cbf2226fc1c84950fcf9449e18e27da48b665e3677244c1b351e616`。stderr 132 字节仅为 WSL localhost 代理/NAT 提示，摘要 `b280c454d6f559e56eb3f5ed39f3ba084b8d1744a3ff7fe016b21ff86dea1aca`。

最小补丁只在成功交接前解除**已完成 capture 阶段**的 `set_progress_handler`，前后仍 `budget.check()`；没有改变 query_only、图像/原始结构/旧行摘要、公共 false 资格或通用 `_new_memory`，失败仍关闭私有连接。后续 compiler 的私有 reference/decoder 仍绑定独立新预算。增加 4 项内存阶段回归：旧 capture deadline 过期后有界只读查询可用且 DML 拒绝；外部原 SHA 仍触发两次真实 compile/rehydrate；捕获中原 SQLite callback 超时实际中断并关闭；新 compiler 的实际 progress 与固定 timeout 拒绝仍生效。仅做阶段 deadline 故障注入，不是假时钟或真实性能测量。87 位原测试保持，失败信息只新增固定 index/reason。

补丁 capture / lifecycle tests / response tests SHA 分别 `78d0801fba7e78bd8b72a909c8bdb2acee5e8f4a7d63e038f543ed02df4faa0d` / `3baba86338da8f8847fc0607958524ce230e0165d7d40e43e83bd8523dbca843` / `a80644f56e44d057ffc198cb701ef50267229a0ec46a0a097cd5761a4f951c4d`；响应模块 `313078fc` 与 compiler `ee01ad89` 未变。新有限清单包含 lifecycle 测试共 228 文件，指纹 `85304052e8c5fdf61b0972b6ce752d3e144961d33cdd8890e5e74520b829dfa3`。旧候选/诊断 freeze 必须拒绝新 capture digest，不更新旧 pin 或把旧 PASS 改写成修复证据；最终完整新门禁另列终态。

接入回归首轮 Windows 四组专项为 **1 failed / 614 passed / 47.31 秒**，全量为 **1 failed / 2212 passed / 200.79 秒**，均 exit 1、stderr 空、源码前后仍上述 `85304052`；原 87 位故障循环实际 PASS。唯一失败是新首项生命周期测试故意只读 INSERT 后的自动提交断言：Python SQLite 的隐式 BEGIN 在被拒绝 DML 之前开始，拒绝写入不自动结束该测试事务；数据/只读/摘要断言已通过。这不是捕获修复失败，也不放行整个门禁。专项/全量 stdout SHA 分别 `171068fc712f9963f5bc2da7d966a76858503a38c9ab926a28c870f4d68b5746` / `15ec2e0d1c708868596a948313e337b98b1f2beb4d6f1c6533317f6e5e875c9f`，原失败目录/日志保留，没有为已知测试卫生问题再启动 Linux。

全量正常结束后，经独立只读复审，仅完善测试卫生：DML 尝试前完整核对绑定；保持只读 INSERT 拒绝；显式 rollback **测试自己发起的内存事务**，再完整核对来源摘要/query_only/autocommit 与 callback/abort 计数。不删除或放宽断言，不用于真实未知提交的回放/回收，也没有修改生产补丁。最终 lifecycle tests SHA `dfa7d16182dcfe9afa5ecc92b15538076bed3af1da1ee9f5a33d81974f84514c`，有限 228 文件最终冻结 `c84d6179818c8691edd51f3a5262b60b1055190ed4ab8ad80d2b83f3cf3006cf`；新 Windows/Linux 完整复验绑定此冻结，实际终态下述记录。

最终新 attempt 的四道门禁均实际 exit 0，无 failed/error/skipped/xfail/xpass；两平台专项均打印 `synthetic_executable_fault_positions=87`：

| 修复后最终门禁 | 实际终态 |
| --- | --- |
| Windows snapshot + lifecycle + packet + response | **615 passed / 55.67 秒**，5,995 条依赖弃用警告；wall 57.310 秒、stderr 空 |
| Windows backend 全量 | **2213 passed / 224.67 秒**，79,826 条依赖弃用警告；wall 227.185 秒、stderr 空 |
| Linux 同四组专项 | **615 passed / 177.76 秒**，pytest/tee/WSL/wrapper 均 exit 0 |
| Linux backend 全量 | **2213 passed / 357.22 秒**，1 条既有 Starlette/httpx 弃用警告；pytest/tee/WSL/wrapper 均 exit 0 |

Windows Python 3.14.4 / SQLite 3.50.4 与 Linux Ubuntu 24.04 / Python 3.12.3 / SQLite 3.45.1 均使用原运行时、隔离环境/新默认 DB 与 basetemp；新增测试沿用原限定内存/Socket/配置 DB/可信源码 I/O 门禁，Linux 另有 loopback-only 插件，不声称 OS 安全沙箱。Linux 专项 UTC `03:54:52→03:57:52`，全量 `03:57:52→04:04:06`；整组 wall 562.9166954 秒。没有提高 30 秒生产预算、删除故障位置、修改依赖或重跑覆盖旧 FAIL。

四门禁前后 HEAD 为 `7511d807fc7467e887277c72356de6e719f9f41d`，228 项源码指纹均为上述 `c84d6179`；父代理另从当前全部 228 文件独立重建同值，逐文件 drift 为 0。测试的是该父 HEAD 加本次未提交冻结代码，不以父 HEAD 或此本机指纹冒充新提交的 CI 身份。Windows 专项/全量 stdout SHA 为 `7af0e4ef0b0c42d8049ea265086e6e86aed507de26e71a74d806c4522555c13d` / `0eb10aabc244d754576fe8cd5a6206692f5a94a7e9cdb662398b13dc73e7b276`，result SHA 为 `fba9f6bc49749f34d03fb9138458763786f2fec049a9892efd359de2bb950cc0` / `b0a1884279252aa7b42610c1f25f7a1e1461e016d155a5d1fd57f19860ca4342`。Linux 专项/全量 log SHA 为 `1371135111ece18bb7e17adee9b0bee6a24d4436a76d4c4b3796ef5c62199dad` / `9d6c7ce785309b1b85999003f5efd06ec532dbb5f6290aa56356cd3ffe2aad02`，manifest SHA `a530bef910cd14a8bd8ef8aabea0d15bbea6a90f874fc83d7bb76b335c257169`，日志摘要均由父代理独立读回核对。

提交前限定检查 8 个自有变更文件：敏感模式命中 1 条，经全文核对为原生合成 fixture 地址 `synthetic-candidate`，精确允许该字面量后其余命中 0；不打印或收集真实凭据/私人包/响应。远端 main 再核仍 `1231fc6b`，PR #4 仍 OPEN/DRAFT。该切片可作为升级分支 checkpoint 提交推送；不是云迁移、跨重启、独立远端恢复、真实用户/自然窗口或 v9 发布资格，三端版本仍 8.0.0。

本批 8 文件 / 1646 新增 / 3 删除已正常提交为 `2709106be090cfc1afde449a3ab8f45710590e47` 并推送升级分支，工作区在接入下一切片前干净。新 [CI 38110519958](https://github.com/AureliusWu/fund-compass/actions/runs/38110519958) 于 `2026-10-11T04:07:37Z` 实际 completed/success；父代理与独立代理均核对 resolve EVENT_SHA、4 次 checkout、3 次 exact-source 为 `35296f9c78d23236d1aea6abef9c748a6efa9ca5`，GitHub commit API 的 parents 精确为 main `1231fc6b` 与该 head。后端 **2213 passed / 50.02 秒**、pip check 无 broken requirements；前端 **801 / 51 文件 / 7.02 秒**、类型检查、1088 modules/build 7.58 秒、PWA 7/7；Worker **144 / 3 文件 / 551ms**、类型检查、dry-run 114.28 KiB/gzip 26.58 KiB 通过。deploy/candidate_smoke/formal_smoke 三 job 实际 skipped、steps 空，未发布或改变云端。

CI 警告保留：后端 1 条既有 Starlette/httpx 弃用，前端 source-map 弃用及 Vue 测试 stub 警告；前端和 Worker 的 npm ci 各报告 **7 vulnerabilities（2 moderate / 5 high）**。数量不是已证明的生产可利用性，已安排保持锁文件不变的只读 advisory/可达性核查，不能直接忽略或进行 force 升级。此 CI 只覆盖 `2709106` 的真实 PR merge，不覆盖随后 P1 变更，不替代部署、持久化/恢复、自然任务或正式 v9 验收。

### 定时任务下一切片的独立静态复审（2026-10-11）

指数 producer 的 `_valid_core_item` 在类型判断之前调用 `.get()`，且空日期可形成 `None == None`；main 对完整六核心没有 `0 <= age <= 7` 生产资格检查，因此畸形输入可能异常，完整但陈旧/未来数据可能覆盖产物。消费端仍有七日新鲜度阻断，没有证据证明本轮已经生成错误交易信号。最小候选须先检查原生对象和合法源日期，再以北京时间核验六核心年龄，拒绝未来日期，失败保留原文件；不混源/同日口径、不补零、不降低六核心门槛。

私有 GET 已有 3 次、单次 45 秒/总 150 秒的正文/socket 有界读取与固定错误，不把旧 main 的 TimeoutError 误称为当前分支缺重试。新发现的缺口是 response 关闭之后、结构检查和最终返回之前未复核期限，可能超期仍成功返回；拟补合作式真实 monotonic 检查并丢弃超期 payload，而非宣称可抢占阻塞 DNS/关闭操作。严格私有摘要 JSON 版本与独立 authenticated durable sink 是另外的合同/发布门禁，不能机械要求旧响应新增 `available:true` 或移除公开输出保护。本段记录候选接入前的静态复审；随后实施和实际验证另列，不以本段授予测试通过。

### 无浏览器候选库只读复核（2026-10-11）

使用用户明确提供的确切本机配置文件，仅识别两行格式并通过隔离子进程环境交给已全文审阅的 `tools/turso_candidate.py --timeout 5 inspect`。首次本机配置形状检查因地址/Token 顺序假定不符而在启动网络之前拒绝；安全类型识别确认实际为 Token 在前、地址在后，未输出其值或解析令牌权限。随后真实检查 exit 0 / wall 2.596 秒：`connectivity=true / schema_version=8 / schema_version_source=schema_table / table_count=20 / fund_count=28010`。仅固定 SELECT 和只读版本/结构聚合，没有 DDL/DML、初始化、迁移、轮换、重试或私人账本读取。

此处 schema 8 是 10-11 的新远端观察，不再仅引用 10-03 的旧记录；基金目录数量与本轮公开 API 基线一致。它证实可经正常数据库凭据绕过 Dashboard/OAuth 读取，仍不证明写权限、最小权限、跨宿主重启、独立恢复、免费用量或 v9 发布资格。新分支物理 schema 9 与该远端 schema 8 不兼容，不能直接合并 main 触发自动部署。

### I20 原生日期与成功返回期限最小修复（2026-10-11）

实际接入上述两处生产补丁：指数记录先校验原生对象/名称、有限原生指标及非空 canonical 源日期，再按同一北京时间瞬间拒绝未来日期与超过七日的六核心；拒绝均在创建临时文件之前完成，保留原产物字节。可选旧 partial 保留真实日期/null，整体 `updated` 仍取最旧日期，不把它冒充新鲜完整数据。私有 GET 对正常 context 关闭、旧合同结构检查和最终返回补真实 monotonic 复核；总预算不足停止，仅单次超时且仍有总预算时才允许原 GET 重试。没有提高原 3 次 / 45 秒 / 150 秒、添加鉴权重试、删掉隐私断言或宣称可抢占 DNS/清理。

新增 42 个参数化回归；实际隔离 Collect 为新文件 **42**、五文件专项 **188**、后端全量 **2255**，收集不等于测试通过。collection receipt SHA `9fec7994f70e5ed269894700e5bc0f95f15c12f1e853622a5868f87c809e0798`。旧成功 enrichment fixture 明确其原来的北京时间，保留旧日期/空值断言。新增真实 sleep/deadline 回归未伪造时钟或改生产默认参数，provider 均合成注入，未请求真实金融来源。

| 同源实际终态 | 结果 |
| --- | --- |
| Windows 五文件专项 | **188 passed / 4.69 秒**，5204 条既有弃用警告；wall 5.828 秒、exit 0、stderr 空 |
| Windows backend 全量 | **2255 passed / 262.32 秒**，81280 条既有弃用警告；wall 265.244 秒、exit 0、stderr 空，实际低于原 300 秒监督 |
| Linux 同五文件专项 | **188 passed / 6.64 秒**，pytest/tee exit 0 |
| Linux backend 全量 | **2255 passed / 389.01 秒**，1 条既有 Starlette/httpx 弃用警告；pytest/tee/WSL/wrapper exit 0 |

四项 failed/error/skipped/xfail/xpass 均 0。Windows 保留原 Python 3.14.4 / SQLite 3.50.4，Linux 原 Ubuntu 24.04 / Python 3.12.3 / SQLite 3.45.1；清空子进程环境、每次新默认 DB/basetemp、禁用 byte/cache、Linux loopback 守卫保持。Linux 专项 UTC `04:20:14→04:20:22`，全量 `04:20:22→04:27:02`；wrapper wall 411.7834892 秒。Linux 沿用原无外层硬截止，不把这次耗时称为云性能通过。

两平台测试均绑定父 HEAD `2709106be090cfc1afde449a3ab8f45710590e47` 加本次工作树、229 文件 SHA `775c95a3bed56abb6f9e28c4d35c926555e0b40467cda561c317215a94f57e6d`，pre/post 相同；父代理独立按全部文件重算并核当前逐文件 drift 0。Windows 专项/全量 stdout SHA `bf41baeae4e529196d98143dd0747fd65323294b720bed541880519d9f7ccecc` / `10bc25916a25e44c3ab4169892695c253152baabe5666115314b73e210400ce9`；result SHA `fa2b2e8b07f2b259e01ab69e846b28d343d66add311bbbfcb5a11f4aa3b05372` / `cd1f1c3d80b73795aa91fe0c7edc5f74696b3dc0d887560742a28b5a293caef7`。Linux 专项/全量 log SHA `96eac20a036ff8cf76991341a8d4b4f2dd0208e2805329def19d5b765c137b78` / `458072f4ce1fdf8fed296d4de7e8baab3abb19363038c30b4a12dbb9fe0957d6`，manifest SHA `f6fcdcdd05032f1cb425b4fc27eb4b851170919dd6da4a2c3bf41207f1a872a4`，由父代理核对真实文件与前后摘要。

此切片只关闭这两处代码健壮性缺口，不证明六核心免费源已真实恢复、private durable sink、自然连续窗口、schema 迁移、云恢复或 v9 正式发布。未更新三端 8.0.0、main、凭据、云配置、远端数据或旧失败证据；新提交的 CI 身份须随后实际核验。

该五文件切片已提交为 `3cddf47b9c402b59bfee03bc71bc83d7b03260cc` 并正常推送升级分支。[CI 38111898265](https://github.com/AureliusWu/fund-compass/actions/runs/38111898265) 于 `2026-10-11T04:34:05Z` 实际 completed/success；resolve、三端 checkout/exact-source 的 tested merge 为 `6f18bce9715ab26addc2c64ffc72eaab11544a97`，GitHub commit parents 精确为 main `1231fc6b` 与该 head。后端 **2255 passed / 87.62 秒**、pip check 无 broken requirements；前端 **801 / 51 文件**、类型检查与 build 7.49 秒；Worker **144 / 3 文件**、类型检查与 dry-run **114.28 KiB / gzip 26.58 KiB**。deploy/candidate_smoke/formal_smoke 均 skipped、steps 空，未上线。此 CI 仍使用原锁文件，前端/Worker 各 7 个 npm 漏洞警告（2 moderate / 5 high）；后续安全锁更新的本地验证与新 CI 必须另行绑定，不能用此次成功覆盖未提交依赖。

### 依赖安全锁更新与真实本地验证（2026-10-11；10-13 收口）

显式官方 npm audit 确认旧前端、Worker 锁图各有 7 项（2 moderate / 5 high），不是已证明的线上利用。仅提升 Vue、Vitest、Wrangler 的同主版本下限并导入 npm 生成的对应锁：Vue 3.5.43、Vitest 4.1.11、Wrangler 4.149.0；前端 Vite 6.4.3、TypeScript 5.6.3 不变。独立机械复核前端 28、Worker 111 个变更/新增节点及 5 个删除节点，无已有包跨主版本、同版本 integrity 替换、非 HTTPS/新非官方源；未变更的旧 npmmirror 地址原样保留，没有 force、override 或费用资源。

实际清空凭据环境、按锁 npm ci 后：前端类型检查通过，**801 tests / 51 files / 4.88s**；build 1088 modules / 11.25s，PWA **7/7**、62 precache / 763.75 KiB；官方 audit **0 vulnerabilities**。Worker 最终以实际 node tsc CLI、Vitest CLI、Wrangler CLI 验证：类型检查通过，**144 tests / 3 files / 2.64s**；仅 dry-run **114.28 KiB / gzip 26.58 KiB**，官方 audit **0 vulnerabilities**，所有阶段 exit 0。未运行 live deploy。此处产物大小仅单次快照，不是同条件 p50/p95 或真实浏览器/PWA 升级性能通过。

保留 source-map 弃用、Vue 测试 stub、Worker 合成 HTTP 503 与 dry-run 的一次网络守卫警告。Worker 早期失败为本机 launcher/空 npmrc/过严网络守卫，未收集到业务测试；旧 exit 0 的 npm 包装 typecheck 未执行真实 tsc，明确不采用。最终修正 native COMSPEC 并直接运行实际 CLI，未更改业务源码/门槛。两个 runner 创建的空目录移入 TEMP recoverable 目录，未删除用户数据。

四个 package/lock SHA 依次为 `6cd3293672e06cbba535dbde6ffb17e22940eb5446664cf8cfadb2621712380a`、`3a0518598aae3703e37f6c1a11b85765de022db827a99339e4d8abb6d672c38a`、`aaae27b85856e8d549236c2883a73dbccd9bd86c0b6a849409675ee227cf0cf6`、`f708b585e85c30d820b479d3db0835ca0169dd7f507c3dedd846d356cdcb913c`。前端 219 文件 pre/post 指纹 `c760bce161bf99c18582f1b7b98eed3e76d21cd13c4a555c05e3d11dea99bf87`；Worker 16 项 `c2c1be1f3f093f4745ad174f11900d8c9fc1b4eba0cf85d364334cdc1481f911`。前端 test/build/audit 日志 SHA `0b88ca162b59c510956163d425b1e3ddf65ef6dbc18eeded60dc0731c25b86ad` / `6e76199cb1a0e4a785b4558e2fe62c761ab495ff76bba89a818d7845b4885c28` / `fe7643ffc0fce71dee14db4d1981ff00d4d8d4c6a8f5f8e24da21a1b637736a5`；Worker manifest `cf782e41ece7755328c8a566b2d8137f3be5d7c5aa08922c6040be98758830d2`。均绑定父 HEAD `3cddf47` 加这批未提交文件，10-13 复核字节仍相同；新提交 CI 另验，不替代云迁移/恢复、自然任务或 v9 正式发布。三端应用版本仍为 8.0.0。

### 海外任务恢复日记纯核与双系统终态（2026-10-13）

新增 `tools/overseas_run_journal.py` 与 110 项合成回归，只有测试导入，尚未接入生产 workflow。日记严格限定公开原生 JSON/容量/日期/运行身份；仅保留实际 terminal 事件与最后有效公共产物指针。当前连续零按最新交易日终态重算，真正 qualified 可清除当前零/陈旧告警，但保留历史失败；随后失败再次降级。金融产出与 CI dispatch 错误分轴，不把“commit 后 CI 失败”当作金融零产出。manual/节假日/不支持日历/跨日不能冒充合格交易窗口，缺历史的精确计数为 null。传入四文件摘要/commit 不是来源签名，remote/apply/restore/formal/retry 均 false。

首轮 Windows 为 **102 passed / 7 failed / 2 errors**：六个 missing-field 测试先在 helper 取缺键失败，一项超大参数自动 pytest ID 超过 Windows 环境限制；重复键用例先撞另一输入宽度边界。保留原失败日志。仅修正测试的独立 binding、明确短 ID、边界内重复键位置，使原输入/拒绝断言实际抵达生产校验；纯核未变。独立复审无新增 P0/P1。最终实际结果：

| 门禁 | 终态 |
| --- | --- |
| Windows journal 专项 | **110 passed / 0.33s**，exit 0 |
| Windows backend 全量 | **2365 passed / 206.12s**，85,024 条既有依赖弃用；wall 208.923s、exit 0、stderr 空 |
| Linux journal 专项 | **110 passed / 0.98s**，pytest/tee exit 0 |
| Linux backend 全量 | **2365 passed / 334.31s**，1 条既有 Starlette/httpx 弃用；pytest/tee/WSL/wrapper exit 0 |

10-11 Linux 首 attempt 因应用中断而失去进程，没有 full summary/manifest，明确不是 PASS。10-13 检查原 handle 不存在、无对应 live runner 后才启动新 attempt；实际 UTC `15:14:08Z→15:19:45Z`，wall 342.196s，无外层新硬截止。沿用 Windows Python 3.14.4/SQLite 3.50.4 与 Ubuntu 24.04 Python 3.12.3/SQLite 3.45.1、清空凭据环境、新 DB/basetemp、禁 byte/cache；Linux loopback 守卫 self-check 实际通过。原回归位置、生产期限/隐私断言未放宽。

测试绑定父 HEAD `3cddf47` 加本次未提交代码，core/test SHA 为 `47f5e6685401844a9ef47fb613393e995762329885776f5fc85987f82ffc7c45` / `a59562b634eeba84b0a9c10e45b4b885ae8b167ce4fe9d2c0454643b0e379f2e`。Linux 231 项 canonical LF 源码 pre/post 指纹 `11f49eed6cb12ab304c669132822ed524a976f4e6fffe53e942dd874fe5b285f`，父代理逐文件独立重算 drift 0，repo/runner/log pin 均一致。Windows 源清单范围/分隔方式不同，不与 Linux 冒称同一个 aggregate；逐文件 core/test 相同。Windows 全量 stdout SHA `e0141f7eab60d84518d04c0aa1dcd2889fc536e3519ed6a34ef60cae47355d47`；Linux focused/full SHA `937922b278a6c38faf59b89a47ae73268252b56e32c753262500fb6043214ea1` / `8786529422ebcab7921c7e44dae7ac725f64920748d59558e5074b9ea19e4e20`，manifest `7040cc57219b47e9ef4ba808183ba9af1245460886e88cbf98dec7e976869fd0`。

这只是已验证日记算法，不是生产失败状态已持久化、提供方已恢复、连续五交易窗口/两周周期已通过。10-13 只读自然任务进一步确认：10-12 overseas heartbeat 跨日且有效数 0；10-13 同日运行抓到 21 报价但 predictions/effective/settled 全 0、audit 失败。下一步需实际 producer receipt、发布四文件绑定与失败 ops-only 持久化接线，不能靠改“成功”标签或刷新日期解除门禁。

安全依赖切片 `11f08b4` 与日记切片 `65aac4a` 已分别正常提交；在干净工作区核对主线增量 30 文件/交集 0 后，合入公开数据 main `d749647`，得到 `b51c1df5baf008e27d4216c2283b60d14c7523d3` 并正常推送升级分支。一次 PowerShell 未展开 diff range 的只读命令打印 usage；后续用显式 range 独立核对上述清单及 merge parents，没有用错误输出中的空列表作验证证据。主线本身未被合入升级代码，没有强推。

[新 CI 38421791188](https://github.com/AureliusWu/fund-compass/actions/runs/38421791188) 于 `2026-10-13T15:26:22Z` 实际 success。父代理与独立代理核对 EVENT_SHA、四次 checkout、三端 exact-source=`6edef24028b4d2719f9a6fd94b9d2b5e5ae562c0`；其 parents 精确为 main `d749647` 与上述 head，tested tree `131e01bec0bad29b861845e5ad63a469c48ddbb3` 与 head tree 相同。后端 **2365 passed/85.51s**、pip check clean；前端 **801/51 files/4.48s**、类型/build 5.28s/PWA7/7；Worker **144/3 files/1.03s**、类型/dry-run114.28KiB/gzip26.58KiB。前端/Worker 实际 npm ci 均 **0 vulnerabilities**；既有弃用/stub/合成503警告保留。deploy、formal_smoke、candidate_smoke 实际 skipped、空 steps；PR #4 body 已更新、仍 OPEN/DRAFT。此成功不覆盖随后海外诊断/派生数值未提交改动，也不证明部署或 v9 正式发布。

### 海外零产出原因与派生数值 P1 修复（2026-10-13）

实际接入固定 stage/reason 聚合计数，区分详情/日期/净值证据、超七日跨期、目标日报价缺失、覆盖不足、非法参数、fallback 与重复日记录。pipeline 只记录原因/count，不输出基金身份、净值明细或异常自由文本；没有把行情数量等同有效预测，没有放宽日期轴/七日/覆盖门槛。显式非法 min_weight 拒绝，缺省零保持原兼容；bool 和巨大整数转换不再冒充有效数字。

独立复审追踪出既有 P1：有限 base/change 可乘出无限 predicted_nav，旧有效计数仍接受。最小修复在 append 前拒绝非有限/非正/四位舍入后零，固定 `prediction_invalid_nav`；旧行有效计数同步核派生值和存在的 stored 值。结算路径跳过坏历史形状/元素，非有限实际收益或误差不改状态、不伪造 settled。缺 stored 字段的正常旧行仍兼容，不宣称整个任意 ledger 已通用净化。新增 40 项原生合成回归，独立复审确认 P1 已关闭，无新 P0/P1。

最终清凭据环境、新默认 DB/basetemp、cache/byte off 的 Windows 实测：collection 新旧专项 **65**、全量 **2405**；专项 **65 passed/0.29s**、1560 条既有依赖弃用，wall1.130s；全量 **2405 passed/202.03s**、86553 条既有弃用，wall204.664s，均 exit0、stderr空、未触及原300s监督。真实 provider/network 被 synthetic 注入；代理设置是辅助拒绝，不声称 OS 安全沙箱或提供方真实恢复。首轮更窄诊断原代码测试已正常结束才修改 P1，旧日志保留；其双 quiet 输出不作为最终计数摘要，最终明确重置 addopts 输出实际 PASS 数。

最终父 HEAD `b51c1df` 加本切片 232 文件 canonical LF 前后指纹 `dad2d5e1485043626b85e4ec19464aee370bf751690aaade1472f499a7a28bb8`，父代理全部重算/current drift0。production/test SHA `f27a3c65642aa3aec9b197f1455af2198df83287e7180cf8064559495862c592` / `f76ead071026f9a564c07eec6fb3a5b1de57a71311f173a666763ce9bd61d75d`；专项/full stdout SHA `c1d40aac3c124bedb123c86494c430cbed17be90516440c2fc5d9797ccd8b504` / `11357f73581265e774cd29c9941b4cebe410a50bee77f2327e3b8ac13f4bbc3f`；manifest `3718ce4fc65e824474b6a23c1e5a229ff032194966d9fba8f0206be8034ac9f9`。这不是真实零产出已修复或自然恢复窗口；新提交 CI 另验，仍不直接推 main/更新 v9 版本。

该切片已正常提交并推送 `92f8f73dce21bc226fd4a03aedafa3aa6b73e4d4`。[CI 38424249294](https://github.com/AureliusWu/fund-compass/actions/runs/38424249294) 于 `2026-10-13T15:43:19Z` 实际 success；父代理通过普通连接器独立读取 run/jobs/四个 job 原始日志，核 EVENT_SHA、checkout 与三端 exact-source 均为 `5ec6b50171687ff6050338d49b0b3c0bcccbbc64`。tested merge parents 为 main `d749647` 与上述 head，tested tree `f066ecd97770b5d2d810fda8f2b0e44b867aae9c` 与 head tree 相同。后端 **2405 passed/65.78s**、pip check clean；前端 **801/51 files**、类型/build 5.78s/PWA7/7；Worker **144/3 files**、类型/dry-run114.28KiB/gzip26.58KiB。两端 npm ci 均 **0 vulnerabilities**。deploy/formal_smoke/candidate_smoke 实际 skipped，未部署。普通 gh 两次 EOF、一次连接器日志传输错误均保留为技术失败，成功的普通连接器读回另计；没有认证提取、重跑 workflow 或绕过权限。更新 PR body 的 gh 请求另遇 EOF，普通连接器随后明确 403/FORBIDDEN，已停止该外部写入路径，未改凭据或尝试绕过；最新版描述仅保留本地 TEMP，远端 body 仍为先前 checkpoint，不宣称同步成功。

### 线上候选只读复核（2026-10-13）

普通 Render 连接器只读确认 `fund-compass-api-v8-candidate` 为 free、单实例、main 自动部署，latest deploy `dep-db6g8u49v7es73a3f950` live，commit `d749647e47b8bf819f4b41d1271e578f0804f49e`，不是升级分支。Pages release.json HTTP200/1.904s 同样指向该 main commit。公开 API health 首次 HTTP200/37.230s，随后 HTTP200/0.651s；`status=ok`、`version=8.0.0`、`universe=28019`、`universe_ready=true`、`started_at=2026-10-13T23:43:51.641472+08:00`。实际 database 为 libsql/turso_candidate，`durable=false`，明确尚未通过生产跨重启读回验收。

首次投影误把 scalar universe 当嵌套对象、读取不存在的 ok/persistence 字段得到 null；随后核源定义与真实顶层 keys，未将这些错误投影解释成实际缺失/健康故障。代表性公开 `/api/fund/012920` HTTP200/2.370s，latest_nav_date=2026-10-09、history800，最后四日期为09-29/09-30/10-08/10-09，error不存在。只是当前有限字段快照，不倒推此前定时零产出原因，也不是六核心来源恢复、完整浏览器 smoke、跨重启持久化或 v9 发布证明。37秒与启动时间只与冷启动相符，未读受 workspace 选择限制的 Render 日志，不能认定唯一根因。

### 读回合同核接入与门禁隔离纠正（2026-10-14）

接入 `backend/database/turso_scope_reconcile.py`：原 schema-8 捕获与外部三 SHA 完整重编译，固定只读单事务计划及全前/后像、十列 reserved receipt 两路对照，闭集 matched/missing/unknown 与权限 STOP。没有 transport、凭据读取、远端写入或重试；missing 不授予回放，matched 不认证来源或耐久，五项 remote/apply/restore/formal/retry 全 false。独立全文复审无新增 P0/P1。先前 TEMP 合成134项实际 passed/51.35s，core SHA `72535b43e7e1f11831343c2a021fe65f2aac89954a4381d6b213b1ef422e51bf`；正常接入仅删除 TEMP loader 改模块导入，再补 foreign stream+AUTH / 外部身份非法+AUTH 两项交叉回归，原断言/访问 guards 不变。集成 test SHA `4f72b3183a3716967a9564e716d771d66e2cc842f48833bc8374f53d74d2061a`，窄范围独立复核通过。

新 runner 源审发现此前 Windows helper 设置 `DEFAULT_DB_PATH` 环境变量，但当前 db.py 实际读取 `FUND_DB` 或仓库默认路径；该变量本身**没有隔离真实默认 DB**。此前 PASS 数和源码/日志结果仍是真实测试结果，撤回“仅凭这个变量已使用新默认 DB”的隔离声明。这不证明旧测试触及私人库，未追读任何私人文件。新 runner 清空凭据环境后、pytest 前显式把 `db.DB_PATH` 指向新 TEMP、断言并打印实际身份；正常插件保留，新 basetemp、byte/cache off、原300秒监督不变。

正常集成五文件门禁实际 collection751/0.97s；run **751 passed/87.25s**、7912条既有插件弃用，wall88.442s、exit0、未超时、stderr空、新默认DB未创建。实际UTC `2026-10-13T16:05:23.2878452Z→16:06:51.7335772Z`，北京时间已10-14。234项源码 pre/post SHA `f00ee9854f6fd75acf555174d30841ce31a90f42e38baa5fefebee1067893626`；父代理按全部文件独立重算/current drift0。runner SHA `c36830a1f79078f91388230124bf3fe89032a9980de46aa853e41e68b75b7e0c`、focused stdout SHA `3359661c528ef0d94c4ed1dfdee5e50b780a22cc9da468136f0b79fd6928581a`、manifest SHA `f91ef839cce0cd2a41332e69086d4deb6b8463ba6c30545876494128d58a7fb1`。backend 全量仍单独核验，不把专项或纯字节核当远端迁移/恢复/正式发布。

### 中断恢复与正常集成全量终态（2026-10-15）

上次全量 collection 为2541，但真实 run 在应用中断后失去 handle39194，没有 full stdout/stderr/manifest，只有遗留 basetemp；不计PASS。10-15先核该 handle不存在及无对应活动子进程，再检查原234项源逐文件/current drift0、原runner字节未变，才在全新 TEMP attempt 中补跑；未重用/删除旧目录、未同时启动重复 full、未提高原300秒监督或放宽任何断言/插件。

新 attempt 实际UTC `2026-10-15T05:16:28.5868989Z→05:20:46.4550757Z`，Windows Python3.14.4/SQLite3.50.4/正常pytest插件。全量 **2541 passed/252.89s**、91402条依赖/插件弃用警告，wall257.8622872s、exit0、timed_out=false、stderr空。bootstrap明确实际新 `db.DB_PATH`，未创建默认数据库。原136项集成新增测试与所有既有后端测试一并执行，未接触真实provider/私有配置/云迁移。

完整234源 raw-byte pre/post 指纹仍为 `f00ee9854f6fd75acf555174d30841ce31a90f42e38baa5fefebee1067893626`，父代理按manifest全部文件独立重算/current drift0；runner仍 `c36830a1f79078f91388230124bf3fe89032a9980de46aa853e41e68b75b7e0c`。full stdout SHA `6ab41976c9370d4261e1e656e3f0165f22442d0dd1cae09d1ec409fb6517ca3f`，manifest SHA `e23139fd659a43c649813c0f168a40091b5f0ece8d63e5694d6aec3622caaa9a`。独立恢复复审再次确认current core/test及四旧pins一致、无P0/P1；本批仍是本地合同核，不是实际发送、远端对账、应用跨重启/恢复或发布证据。

该切片最终为 `40f629e9800a8531b01ede650f80df0a08e21211`，并合入 main `d017e3941278b91afcbac305ee065358c2039d02` 的唯一新 bot 公开数据提交，3个JSON/交集0，升级 head=`1cb88dbc7901b04dc9e7a008fee62e1e30adf5ba`，已正常推送。第一次 GitHub GH007 拒绝公布私人邮箱；保留本地 before-email 备份，仅重建本轮两个未发布提交的 no-reply 元数据，两棵 tree 精确不变、CAS 更新本地分支后正常快进推送，没有关闭隐私保护/强推/改远端历史；仅本仓库以后提交改用已核账号的 no-reply，不更改其他项目或全局配置。

[CI 38686766076](https://github.com/AureliusWu/fund-compass/actions/runs/38686766076) 实际 `2026-10-15T05:26:09Z→05:28:13Z` completed/success。独立代理核 EVENT_SHA/四次checkout/三端exact-source=`d636688f9c1659fa0a3f2aeb5123f6df7c671efb`、GitData parents为d017与1cb88db，tested tree=`bdba17afdf44b35f7b14a76c1d77fc995440906f`等于该head。backend **2541/100.94s**、pip check clean；frontend **801/51/7.84s**、类型/build7.42s/PWA7/7；Worker **144/3/572ms**、类型/dry-run114.28KiB/gzip26.58KiB；两个npm ci均0 vulnerabilities。deploy/formal_smoke/candidate_smoke均skipped/steps0，不覆盖随后未提交的ops接线。

新主线公开产物显示10-14在20:17:51+08:00、比14:35晚342.86分钟，quotes21/details3/predictions3/effective3/settled0，目标净值10-13；audit warning、errors空，最后有效结算仍09-30/年龄335.4h。是旧producer的一次真实自然产出恢复，不是本轮修复已上线或五窗口/两周周期通过。

### 原生任务接线候选与双轴测试修正（2026-10-15）

接入有限 `tools/record_overseas_ops.py` 与71项合成回归、简化海外workflow：一次producer→校准→独立audit→export→确认四金融文件与main commit→exact CI dispatch，再将公开失败历史写入独立ops唯一JSON树。bootstrap只认确定不存在的ref，历史拒额外代码/可执行位/symlink，未知push/ref变化停止；不改main/index/HEAD保存运维日记，不把提前到午夜的新交易日算漏跑。金融成功与派发失败分轴，manual/假日/跨日/未知日历不冒充有效自然窗口。

首个冻结TEMP门禁实际 **180 passed/1 failed**：测试在ci_dispatch失败分支把执行原因套在金融reason，和同文件及既有journal的双轴合同冲突；production本来正确保持financial_qualified及workflow_reason=ci_dispatch_failed。原stdout SHA `365a8dbdb10052d71aec4684ca04521829822206481f98f7a8d34a079975ddce`完整保留。仅新修订测试统一检查workflow_reason，并分别强制金融reason；原outcome/pointer/base/其余断言不变，未改production/guard/插件/300秒监督、未跳过。

新8源TEMP mirror actual collection181；run **181 passed/36.48s**、2772条既有弃用，wall38.107s/exit0/无超时/stderr空；40正常插件保留、guard违规0，8原source及mirror全前后SHA一致。core SHA `3f25fe3f1208afd20f6ca045d1da848b14ab82e21851d912b4fa8bd784e4204b`，test `ecc22a216234e9ff41d8a4ce97960b0518f97156df8a8f2d5f9e7ff68ef252dc`，workflow `a5b7d3d2197d08665c77af3250a7107a65ad4a9bc1e635e317d0ea5fb91bb489`。stdout `3d1dace0aecea8a078b245da9c76dbb072ed4409b1868cd75daed599817e2813`、result `a4c84f0905aae8e81424400ed7c0b4d37f5a4334b688912538e57c51c38b1be2`、manifest `fe60fdf8af620530f9c42fac70b976ffabfa5d8ec9699879dbd911d7a307ff43`，父代理实际读结果/summary并哈希确认。此处所有Git/provider均mock；真实本地Git行为、正常仓库全量、真实远端ops分支/权限/自然恢复及UI消费仍单独验收，未在main启用。

### 定时接线全量修正与普通推送并发保护（2026-10-15）

首个正常集成全量实际为 **2609 passed / 3 failed / 259.99s**，并非PASS；3条旧workflow测试仍要求YAML里直接出现shell dispatch/API检查/export，实际逻辑已进入统一runner。保留失败stdout `c1607f2ce0ea625ca61707575d880faa073860d083db202f3babb021cce6785e`，没有改成仅检查入口存在：新合同以YAML+AST核唯一入口、明确API无旧fallback、原生六阶段及独立audit、成功门禁、四文件闭集、已确认精确SHA单次dispatch、独立ops树及未知不重推。其他writer原断言保留。

独立静态复审指出普通push自身并不绑定此前ls-remote：分支被删除或回退时仍可能成功。新增固定可信 `tools/overseas-hooks/pre-push`，仅接受本次服务端通告旧OID、请求新OID和唯一固定ref完全匹配的一行；通过hook后仍由Git接收协议核旧OID。没有force/lease、history rewrite、分支保护修改或未知重试；它不提供main+ops跨ref原子性，main最后检查后变化可能留下ops写入，必须报告失败且保留现场。

修订正常门禁actual collection254/全量2622；专项 **254 passed/1.84s**，全量 **2622 passed/253.87s**（UTC `07:05:20.5564348Z→07:09:37.0190411Z`，wall256.4597218s）。均exit0、原300s未触、正常插件/byte/cache约束保留、stderr空；实际新db.DB_PATH未创建。95784条既有依赖/插件弃用不隐去。237源raw-byte前后指纹 `bab3f14e8cce79eb70715f2c2c6767cfdb30135b817cf716e23a9572642afc9e`，父代理独立逐文件重算current drift0；之后仅补本日志与AGENTS说明。core/test/hook SHA分别 `8079376835ddf2691e12a5e5dd30b55ef2694106292c14d541c35e42f65d997f` / `2c4cb439e2072b01f0f5971fdfeb8dab768449360a61e17d4cdcb676c3d26e8d` / `ba4864242f13ecd65bceb63fd05de85dc0d3a67ce7f0e37ff4719bbcf9c33999`；workflow合同test `a7036a942f939cb849a3eb8cc91416a608ab6cc13729d376a0f51c62019c853f`。全量stdout `0902c31ecf38f86b1abff742fef6c24a0c2b26a8ce87e4bb8fc6a43a70c59fe7`，manifest `3d9737088a65fa527a3cd79e1e9ed16aa2d052f09636f23d5770b0c0b4ff8212`。

线上只读刷新：Render free/单实例/main，最新live `dep-db7n66ugekts73e3u2ag` 为 `d017e3941278b91afcbac305ee065358c2039d02`；Pages release.json HTTP200同SHA。API健康首次45.111s超时，随后HTTP200/1.034s、version8.0.0、universe28019、started_at=`2026-10-15T15:07:30.09815+08:00`、libsql/turso_candidate/durable=false。与休眠唤醒相符，但没有受控日志证据，不确认为唯一原因。get_service的实际startCommand仍无显式`--workers 1`，不能把仓库候选render.yaml当线上配置已同步。以上不证明升级分支部署、跨重启持久化、自然恢复或v9正式发布。

真实本地Git专项最终 **19 passed/51.84s**，UTC `07:24:06.197Z→07:24:59.395Z`、wall53.158s、exit0、guard0、正常40plugins、7生产输入/harness/Git二进制前后无漂移；使用固定Git.exe、新TEMP/file-only bare+work、四份纯合成文件，未用实际repo的refs/数据/配置或真实远端。761条完整命令=252candidate+509fixture；候选13次普通push全部实际启用固定hook，删除/祖先回退各前两次建链成功、第三次真实拒绝并保持已删除/回退状态，sibling同样拒绝；main最后检查后变化与成功push失去确认按原断言保留实际副作用、失败且无重试。专项不声称跨ref原子、广告后race实测、GitHub权限或自然恢复。

此前两次失败完整保留：第一轮18通过、1 oversized case在setup+teardown报2 errors，根因为pytest将大bytes参数展开到超过Windows环境变量长度，原stdout `4bd93e8882abba26df362ebf3a9e92fcaae6676297ff214883b316c53defd846`；仅加固定短ID、保持所有原输入与断言，另修独立ALL_EVENTS不再被case清空。第二轮19个fixture初始push失败、candidate0，原stdout `3440809934928ba83ccc6c956e23e783327cc6c68aa6973883fb4909703d1f02`；该轮只存child stderr SHA，不能确诊Git原始错误。新短TEMP只加受限合成stderr记录后通过，不能反推旧具体根因。没有改production/测试断言/guard/300s换绿。

最终Git专项stdout SHA `01564f11b1470c690719cedcc13a64661d48362118d3fb873184bb9ead3b457e`、result `907b17900b1a9315ac790590602e09d6d9ddf40819cdcabb72ab067ad71b9d6e`、完整journal `85e88383eb726e1eab23b80f6ed699270a5be4cc2e8f7aac436c3cb9ed0430cb`、manifest `782af045d0d1f3d228c1e6ada0c4ea36926a4f7b1a0be78bcc15243fbb741bb5`；父代理实际读summary/result/13条push结果并重算输出SHA。专用gitattributes固定hook的LF，提交还须显式100755，避免本地autocrlf=true损坏解释器行；未批量改写其他文件换行。

上述8文件切片已正常提交并推送 `8a0ee3327552889bb187bc7133a7778ee789b06e`。[CI 38698945319](https://github.com/AureliusWu/fund-compass/actions/runs/38698945319) 实际终态success/`07:30:42Z`，独立代理核四次checkout/三端exact-source=`37b69fe6357df6c8f0565633e8055e81a53307da`；GitData parents=d017+8a0ee33，merge/head tree均`7a2c8e4be8ce3edb7f3417da8cf664fa4c5d861e`，远端hook mode100755。backend **2622/126.09s**、pip check clean；frontend **801**、类型/build/PWA7/7，Worker **144**、类型/Wrangler dry-run，两端npm0 vulnerabilities。deploy/candidate_smoke/formal_smoke实际均skipped/steps空；不是主线已启用或v9发布。

### 单次物理传输接入（2026-10-15，尚未真实远端调用）

新增 `turso_scope_transport.py`，显式origin/Token、外部原始三SHA重编译、精确原字节data POST；单实例锁/一次发送、TLS验证、无环境代理/netrc、无redirect或HTTP重试，有界stream/协作30秒与源码前后核对。401/403/429保留固定STOP，任何网络/清理/校验不确定性不返回成功；Session.close仅关闭本地连接，不能代替SQL close/commit。固定读回另需显式调用，不自动跟随未知写入。顶层再主动调用会创建新实例，外部操作者仍不得回放未知结果；没有默认生产route或CLI、没有读取真实Token/备份或执行迁移。

实现364行与594行合成测试经父代理及独立代理全文静态复审，未发现P0/P1。原冻结core SHA `3a2dca89e073f7a3fdf6f147176d8a0081730803766aeb3975887b2b9135fa4f`，test `b0aa57a941862b4f961a1af4a0ac333ebf3e37dcce7e3c699822df1a7923a524`。TEMP实际 **74 passed/11.09s**（监督14.910s），collect74；两阶段exit0/stderr空/guard0，116pins前后与父代理当前重算drift0，聚合 `8315be9cb69bf3d94e50014d8f8bae761d577304ab97df0a57e381a232579260`。test stdout `075b10689b1dbf1eea98a2728983d34cc41867d5a85caf9210cce1643644334c`、manifest `b5c09e8cbe2a303155d22e5e0971180022916f3e5e6135a94058cf17ff1884ad`。

此前collect失败均保留且不计PASS：正常requests导入的urllib3 IPv6能力probe和pytest捕获/日志对Windows NUL设备的规范化与严格guard冲突，尚未执行候选。仅在全新harness中冻结严格原生NUL、导入时临时关闭可选IPv6probe并finally恢复、显式将pytest日志写本次允许的run目录；网络/文件SQL/其他文件拒绝、sticky失败、正常插件、原300s和全部候选测试断言未放宽。此为FakeSession兼容，不是实际网络/TLS/IPv6证明。正常接入只移除TEMP loader改标准模块导入及说明文字，core字节未变、test SHA=`a025bfac48dbb7e0651c96935a5c35f4250a78a8350deefbe1d6df023db3a4bd`；项目专项/全量另验，不因此关闭实际停写备份、容量、远端迁移/独立恢复与Owner业务出口。

正常接入门禁实际专项 collection214，run **214 passed/57.32s**（wall58.345s）；全量 collection2696，run **2696 passed/231.36s**，UTC `2026-10-15T07:46:44.9804281Z→07:50:38.7237840Z`、wall233.7405433s。均exit0/未超时/stderr空，正常插件、原300s监督、byte/cache约束不变；bootstrap绑定本轮全新实际db.DB_PATH，默认DB未创建。全量99387条既有依赖/插件弃用警告保留。没有读取真实Token/私有备份或调用候选数据库。

239项源raw-byte前后聚合 `a90a9de814e125e7c204f29bb72c46805f19b0f01b8f870d4796f8e3a12ac791`，父代理独立逐文件重算/current drift0后才更新本日志与计划。runner SHA `593a0a3072c03a974a0345675f91a54c11c624d4ed0a3a6bcaffc12a4c2b58da`；全量stdout SHA `2fd0751cf982446ad48cd72bcb65e1f201bb1bc224ec3fbac88f892b3381f7e9`、manifest `be545806b434435f029e2f165f7fa4b707cb9bde1c95bd4221e814fa932ae243`。这是普通项目回归与模拟发送合同证据，不是实际远端发送、迁移、持久化、恢复或正式发布；前端与Owner main入口切片另验。

该5文件传输切片已正常提交并快进推送 `c5730e177e9538d5cee7895af244cd022bf36d3c`，未包含并行Owner main或前端未提交改动；未推进main、修改版本或部署。

### Owner客户端HTTP接入（2026-10-15，默认不启动同步）

新增显式HTTP adapter，连接既有候选控制器合同与Owner内存会话；仅允许写入/changes/receipt三个封闭操作，原请求摘要与目标复验、有界UTF8原始响应，保留409/404语义。统一12秒超时覆盖懒加载/摘要/请求/正文，撤销/到期/迟到401按generation隔离；失败清理不覆盖原错误，未知写仍留outbox不自动重发。重的合同核仅在实际同步操作动态加载。构造只计算API端点指纹，不发请求/开库，不代表数据库身份、存储已就绪或UI已授权；未注册到页面，不改变默认关闭、Gist、Holding/Policy/Decision或行动门禁。

父代理与独立代理全文复审6文件无新增P0/P1。普通本地专项 **90/3 files**、全量 **862/52 files** 与vue-tsc实际通过，分别wall6.097/5.286/10.073秒。原首轮harness在Node启动前因author清单大小写排序与runner Ordinal不一致失败，日志保留不计PASS；逐路径/SHA/bytes确认221源码完全相同后，只在新TEMP修正清单顺序/digest，runner字节、源码、断言、正常工具与300秒预算均未改。最终9阶段全部exit0/pre/post PASS、无超时/输出丢失；Vue组件解析既有警告及TEMP outDir提示完整保留，未消音。

按性能技能实际3次新TEMP构建、各原7项PWA校验均通过。三份完整产物均138文件/17,071,875 bytes，digest=`1950057fc0cc8fff4d5bf83e243988fc54a3442d59bb4491b0055e6dd44c026a`；构建wall27.701/17.927/13.328秒，median17.927/worst27.701。JS38文件raw1,132,069/gzip415,717 bytes，CSS21文件208,539/64,915，HTML1,633/855；gzip是逐文件.NET GZipStream Optimal合计，不跨压缩算法或旧CI机器比较。缺少同机旧版及真实页面交互基线，不能据此宣称完整性能回归PASS。未覆盖已部署PWA、多设备/离线真实旅程或云持久化。

221源全部阶段前后及父代理当前逐项重算无漂移，Ordinal聚合 `a34002ce2b362904455b52b0d9018df1ce1bccf2084d810441c2d2b1b1d29b31`；runner SHA `1bad115afd42398a9e759dc847cc40599f4c0bc54e3adab8e3f1db3fd9504b4d`，harness-pins SHA `4e9db6f454662890297c191df4bc2b387f82cc6c6fe37a679efce2c760af7580`。full manifest `87eaa9343dba945e62e0b2790e51028295a765d7665f19ac274e1b40b93383ff`，三build manifest `ac1e258ed8ac832dc11217b8a4fabcf4e3ac0247be11e9a41de0b4ecb594c53a` / `6c08cdc4164ef7ae1157473e8c6838d45b844739fc37da02ea838d28a87a7406` / `3878bbd76068f2a899488710c2cb477fd4aa59021a3053b98f5239d299475ee7`。父代理独立读取9个真实manifest/日志并复核输出SHA；本批不关闭I19整项或v9发布。

上述9文件客户端切片已正常提交并快进推送 `4ca9077d9931b0a9d93bb8e331dc3bd97c965c73`。[CI 38704151923](https://github.com/AureliusWu/fund-compass/actions/runs/38704151923) 实际completed/success、终态更新`2026-10-15T08:16:35Z`。独立核四次checkout/三端exact-source=`b08fc70f3903537210379f34c15baba06ebbc1ce`，Git对象API parents=d017+4ca，merge/head同tree=`4b8e22a3fc3255417862d6bd2cc4d3b9301738f9`。backend **2696/130.96s**、pip check clean；frontend **862/52 files**、类型/正常build7.37s/PWA7/7；Worker **144/3 files**、类型及Wrangler仅dry-run；两端npm ci均0 vulnerabilities。deploy/candidate_smoke/formal_smoke真实skipped/steps0。前一c573 CI因后续push被取消，不将其计PASS；最终4ca覆盖两切片。

两个初次普通API读EOF原样保留，后续普通读取正常；未改网络/认证/配置或重跑工作流。父代理实际读取run/jobs/四raw日志关键行与AUDIT，并重算整套11项证据SHA无漂移，外部清单SHA=`e2defd96aee0f5e7afbc64b024b926442b1180cbd9e6a0c72ad04a75587c6bcf`。不覆盖之后未提交的Owner main/CORS切片，也不是任何部署/迁移/恢复资格。

### 配置候选的真实只读连接刷新（2026-10-15）

UTC `08:29:26.3262808Z` 使用此前明确配置的候选凭据，仅通过既有`tools/turso_candidate.py --timeout 5 inspect`读取连通性/结构和公开计数。清环境、有界30秒外部监督、无初始化/探针写入或私人账本枚举；实际exit0、wall2.794s、无超时、输出完整。结果connectivity=true、schema_table版本**8**、普通表20、fund_count28019。未打印/解码/复制/旋转Token，不依赖浏览器或更换认证。

该结果确认这份配置可以正常连到候选，不能解释为当前云库已迁到9或Owner扩展已准备，也不证明Render配置与它严格同一身份。账户配额/实际停写和锁内新备份、受控迁移、独立恢复与业务跨重启仍未验收；本次只读不能补齐这些门禁。

### 主应用Owner同步入口与存储边界（2026-10-15）

将既有受限router接入main，仅用已有、核心9与Owner扩展完整的普通本地SQLite路径；鉴权/独立consent、提交前会话重验、原始请求幂等与未知结果合同不变。工厂在解析路径/读取连接设置前拒绝Turso和所有file: URI/内存/UNC；缺库或不兼容时固定503、不创建父目录/文件、不补DDL，失败关闭连接。独立复审发现最初草案会丢弃mode=ro/immutable语义后强开rw，该草案未集成或运行；最终明确只支持普通本地文件，不重解释URI，也不宣称识别所有网络文件系统。

同次修复既有可选_schema_version读取边界：未核DDL前fetchall及任意TEXT/BLOB可无界传入Python。现在先匹配固定DDL，再以SQL typeof/值条件仅投影两个0/1、LIMIT2/fetchmany2，完整core/extension检查保留；不承诺SQLite引擎I/O时限。新增真实内存SQL回归包含1024行、巨大TEXT/BLOB、坏DDL先拒绝及正确元数据不可代替完整schema。

补齐既有V9合同要求的CORS请求header闭集，固定Authorization/Content-Type与两个Owner同步header，另保留标准safelisted headers；Pages/两个本地开发来源不扩大、无ambient credentials，未知origin/header预检拒绝且不进入存储。新增main27、metadata13、CORS9合计49项；旧“router未挂载”断言仅改为三条精确method/path合同，其他既有HTTP输入/断言保留。主应用TestClient请求与新CORS测试刻意不进入lifespan，不能当作实际启动、受控迁移、远端事务或耐久证据。

正常四阶段首次运行全部通过：专项collection/run **405/405 passed，85.25s**；全量collection/run **2745/2745 passed，254.45s**。full UTC `2026-10-15T08:28:15.0824265Z→08:32:31.9219262Z`、supervisor256.8360047s、exit0、未触原300s、输出完整、stderr空。正常插件/byte-cache约束保留，实际新db.DB_PATH默认DB未创建；105176条现存Python3.14依赖弃用警告完整保留，不静默。没有真实Owner密码/Token、远端写入或重跑换绿。

241源前后raw-byte聚合 `31fba07da21a5bca7402e108832cb407bba3417745eb9dc17da2314ea66bb9ca`，父代理独立逐文件重算current drift0后才记本段；runner SHA `9c5fc91f9f6d950480fb4f397a94a2d48e7c34aa6dab116e7f9ea32190a71569`，外部seal `94c0cd6085d5b3733a07b58721edab2f3e2e87118a5326f9ce50394569541d23`。full stdout `eea5e9ff3a075341be79a5e4bf03bad11fcb3b8c9c7cc03fe596543d3f98bb80`，manifest `373f308fd46761ee1109af75aa4c483c84b4abddec7ec39f9c11743aeb00ed2b`。本切片不开放Turso Owner写入，不修改应用8.0.0版本、Gist、Holding/Policy/Decision门禁或正式发布资格；页面仍单独接线验收。

### 启动兼容修复与显式同步面板（2026-10-18）

上一切片的 [CI 38707066968](https://github.com/AureliusWu/fund-compass/actions/runs/38707066968) 实际为 **1 failed / 2744 passed**，不是完整成功；前端862、Worker144、构建/PWA通过，三个deploy/smoke job均跳过。唯一失败依赖FastAPI内部`app.routes`平铺表示，新版依赖下得到空集合；改为公开OpenAPI的三条精确method/path合同，保留禁止开库断言。真实同步请求用例通过不能掩盖此CI失败，新提交须另验。

增加真实main lifespan回归后，又发现正常全集导入的`universe_import_state`与正常`PRAGMA optimize`生成的`sqlite_stat1`被Owner严格结构校验拒绝。首轮新专项 **1 failed / 421 passed**，原日志/合成库保留，未执行其后全量或进程测试。随后仅逐表容许这两种已存在、固定DDL的对象，不读其值、不创建或修补、不禁用优化；stat4、其他对象和相似前缀仍拒绝。新增不创建、只读/拒读值、坏DDL、巨大BLOB与真实启动回归；测试catalog腐败仅在新建`:memory:` fixture内注入。修复后正常专项 **426 passed / 91.26s**，真实启动、导入、Owner登录及写/读/回执已在TestClient中通过；全量和独立进程证据另列，不把该上下文当重启证明。

自选页新增默认关闭的“私人自选同步”候选面板，保留现有主题和三项导航。打开/登录不联网；明确本轮同意后手动完整拉取、逐账户预览、准备原包、再独立确认单次发送。发送前两处核对本机副本，unknown只核对回执/导出/关闭，不重发、不清包。撤销、退出、卸载清除私人视图；关闭/重开不删除原outbox。云端独有记录不删除、tombstone不复活、畸形输入整批阻断；不含手工资产或云端合入本机，不清local_pending，不生成持仓决策版本。原包/完整本机副本导出使用固定字段，排除Token、PAT和未知属性。

前端首轮 **1 failed / 236 passed**：新fixture把冲突字段逆序，严格解析器正确拒绝并进入unknown。修正fixture为后端真实排序，保留两字段精确显示断言，新增逆序响应仍unknown/原包保留/不重发的第19项SFC回归；没有放松生产解析器。修复后专项 **238/10文件**、全量 **912/54文件**、类型检查全部通过；三次构建及各PWA **7/7**首次通过。三份产物均143文件/17,127,163字节，完整摘要`8895ed26046aa341f374c4d161dd6db241a4c46f8f6fd2a681b8a9ed883458c6`，225源前后摘要`8969d015085340934930d8ace5c57fdf46e602da3ffee313168a7e4e638a4e62`。父代理逐一核对九manifest及原日志SHA、当前源码0漂移；保留既有renderer组件警告及外部outDir提示。

同机同.NET gzip算法对比已保存旧/新产物：总JS压缩415,717→434,816字节（+4.59%）；自选页单chunk15,082→20,304（+34.62%，局部警告）、其CSS+14.64%。按HTML入口、静态import闭包及该路由精确preload依赖核算，打开自选页的JS/CSS压缩合计165,728→173,717（+4.82%）；五项未启用同步动态模块不计常驻。该静态闭包不含API、字体、SW预缓存或实际调度。三build墙钟29.762/13.600/14.994秒，median14.994/worst29.762；旧样本日期/并行负载不同，不宣称运行时加速或I21-04通过。

前端证据位于仓库外`fc-v9ui-gate-1018-conflict-6ca8d8d2`，full manifest SHA `e2cbd17c1cbf7863249a5bd7ccdfb233634ef089d0dd56f37026be4dc1d155ac`，原失败位于`fc-v9ui-gate-1015-c18f4a72`，不覆盖。测试绑定1a394c9加本轮工作树，不以父HEAD冒充新提交CI。真实浏览器/物理PWA、远端Owner事务和迁移、独立恢复及正式版本门禁仍未通过。

本轮公开部署复核：Pages release.json与API health均报告main `0c0f9ad093da983ab2313a05ce614fde0de28b5f`，应用仍8.0.0/libsql/turso_candidate/durable=false；基金全集28019。health首请求25.005s无字节超时，第二次12.405s返回200，started_at=`2026-10-18T05:14:32.983727+00:00`；与唤醒情形相符，但未用控制面日志独立证明根因。指数源日期仍2026-08-21，年龄58天、usable=false且mapped_usable_indices=0，正确降级不等于源已恢复。Render连接器仍无用户确认的workspace，未绕过选择要求或操作云配置；本轮没有更换凭据、迁移远端、删除Gist或发布v9。

修复后的正常后端全量collection/run **2766/2766 passed**，pytest271.26s、外部监督273.866s，低于原300s；UTC `2026-10-18T05:17:41.4868228Z→05:22:15.3578944Z`、exit0、未超时、完整排空输出、stderr空，保留108728条Python3.14依赖弃用警告。正常插件、真实新默认DB隔离及原测试命令保持；默认DB未创建。243源前后摘要`7aad0de3507a24e8bb2a6a4e1010914376645f465365baeaa6bc6b7695820fdf`，父代理独立逐文件复核0漂移；full manifest=`995013e827ea10178c901a47670c945a0d9187d6e67dc216c2b3b8eac8edaf7a`，stdout=`4de20f6c1448ff6b1df2ce8f154e63c51ba99a5eb56311839f153374a6e97c67`。证据目录`fc-owner-stat1-normal-author-20261018-b3e8158d`；本机FastAPI0.116.0，不能替代新版Linux CI。

随后独立真实进程smoke一次通过，外层7.092s/exit0：正常uvicorn单worker完整启动、导入28019基金；第一次HTTP提交同基金两个不同账户（零份holding与null份watch），读回revision1及匹配原回执；关闭自有进程后，以不同PID/端口启动同一合成库。旧会话在session/sync/receipt三路均401，新登录读回完全相同page与原receipt，**没有第二次同步POST**。两次关闭后只读integrity/schema/导入回执/revision及同库fileID核对通过；记录主文件与WAL/SHM，不把物理文件SHA变化当数据丢失。Windows对自有Popen句柄terminate导致服务进程exit1，外层验证exit0；这不是优雅SIGTERM、Render重启或远端耐久证明。

父代理实际读取supervision、完整result和两份真实启动日志；scope仍`local_synthetic_process_restart_only`，remote/cloud_durability/formal均false。证据目录`fc-owner-stat1-process-author-20261018-b3e8158d/run-2ce4eec8b05a4523abc304853e5dcd8b`，外部source-pins SHA=`d421eb26974d4c9291ce3e76723c684d014c9c35162f094a270fb933131b6e21`。没有触及已有/真实持仓库、云端、Token或测试断言/预算；修复和界面作为候选checkpoint提交，新提交CI及后续Turso真实事务/迁移另行推进。

### 真实 HTTP 仓储候选、跨标签页原包绑定与公开源诊断（2026-10-18）

上一checkpoint已正常提交`f986f3d`、`48a590f`，仅合入main四份公开海外产物得到`cea4a7f0263f785162729b7a8a43be912ea28698`并推送升级分支。[CI 39100454270](https://github.com/AureliusWu/fund-compass/actions/runs/39100454270)实际success：backend2766、frontend912/54、Worker144及类型/build/PWA通过，两端npm依赖0 vulnerabilities。实际merge checkout `bdfd1228a563dc46ed2eea6c8034c51ecb24b895`的tree与cea4a7f相同；三个deploy/smoke job均skipped、steps为空，不是升级分支已部署，也不覆盖本段随后改动。

新增显式URL/Token的`service/owner_sync_turso.py`真实HTTP候选仓储，构造不联网、不读取环境凭据、不迁移或初始化；main仍不导入、不启用，原本地工厂继续拒绝Turso。仅已有core schema-table9和完整Owner扩展可进入。快照读取结束后在单次BEGIN IMMEDIATE batch内核固定schema、head、选中历史/MAX/absence、锁内容量及原生affected rows，保存原包业务结果/合法并发409回执；同ID不同hash拒绝且不泄露旧body。stream-local TEMP仅存内部标志，提交前删除；未知提交不重发，缺回执不证明回滚。HTTP driver的有界正文/严格typed解码/协作总预算是显式opt-in，legacy默认不变。固定结构核不是任意原始SQL全库防篡改，跨网络权限回调也不是事务内授权锁。

新仓储测试通过真实loopback HTTP与新建SQLite执行Hrana条件batch，不是实际Turso。第一轮正常专项collection612，实际**5 failed/607 passed**，立即停止而未跑全量；失败证据目录`fc-owner-turso-normal-author-20261018-0743a69c`，stdout SHA=`196b0382d245d213d6d46d36bfd5b1bd5919a427fd964f11b0d8ecf149b983c9`。四项暴露latest guard SQL占位符与参数顺序不一致；修复为keys→预期行→count，MAX/absence/类型检查未删，补有/无缺失键的正常与损坏快照回归。第五项仅为bootstrap测试把明确的params=None当dict；保留bootstrap断言并正确取后续参数，原13次请求/六核心等断言未放宽。旧失败日志/fixture未覆盖。

修复轮正常collection/run专项**614/614 passed**（pytest117.67s、wall119.423s），全量**2885/2885 passed**（pytest287.96s、wall290.986s）；full实际UTC `2026-10-18T06:14:18.8173912Z→06:19:09.8075379Z`。四阶段均exit0、未触原300秒、输出排空、stderr空、实际新默认DB未创建，正常插件及byte/cache约束保留；116633条Python3.14依赖/插件弃用不隐去。只余约9秒预算裕度，不宣称性能改善。248源raw-byte前后摘要`23891ebc9618e2a90735a063d81aa088d82cc0510209eeae6ff51231ce2bd302`，父代理逐文件重算current drift0。runner仍`a4f56959be715ef2faa225a39a426b003f3402f8ce6e21cd35f8eaefa856ac2a`，full manifest=`d6f0e4e23fc015ae82284875dd76aa16b34605f890128f089a0a3d02efd96a05`，stdout=`b2cecafcfae03e2871c2ac89a19fa02f644dfb68b5529532247a1d4216375f31`；证据目录`fc-owner-turso-normal-repair-author-20261018-4bd2a810`。随后staged whitespace检查发现两个新增文件各多一个EOF空行，首次提交命令在commit前停止；仅删除这两个末尾空行，完整diff各为0增/1删，ignore-blank-lines无差异。提交版仓储/test raw SHA分别为`f840f825c4642a7becd289f71c937e0bdf4d77a6492f4fec09163320b69dfc26`、`517ecf8a3479011e8237b959404520d04415d7a506a5863eea50bb1db1724aa0`，不把此字节变化隐去或改写原freeze；未为纯EOF变化重复全量。

Owner前端补hash绑定：发送/取消/结束不能误操作另一标签页替换的原包；重载已决槽须当前generation核对原hash回执；显式结束已决请求后使完整基线失效、下次从0拉取，同时保留已观察head防回退下限。unknown不清包、不自动重发。新增真实双IndexedDB handle竞争及SFC丢响应→原409回执→结束→完整拉取→新原包回归，原核心断言保留。专项248、全量**919/54文件**、类型检查通过；三次build/PWA7/7均首次exit0，三份dist完全一致143文件/17,136,616字节，摘要`78ba6acea29b093fab9128eb59feb736e2eff9329aa73877d9a22c8b9496a97e`。墙钟27.856/10.395/10.457秒；同.NET gzip总JS434977/CSS65483/HTML856字节，不是浏览器性能或I21-04通过。证据目录`fc-owner-ui-bound-gate-20261018-a924c73e`，三构建summary SHA=`135adc4b10d89372bb2ae252c5002f03713ed46eaacf7e1cedc44a4b4c4b21ff`；四份变更源码前后无漂移。

公开指数诊断核实10-12自然run38214537636的直接错误为缺CSRF meta/固定映射KeyError等，没有该日志的HTTP状态，不能倒推为403/429。10-18实际单匿名session/单bootstrap/每指标一次诊断：沪深300、上证50、上证180的PE/PB各返回200，原数据最新日期2026-10-16；第七个指标中证100PE返回**429**后立即整源停止，未请求其PB及500/1000，也未重试/换身份/网络。未保存Retry-After，值未知；259/262条样本不冒充完整日历史。证据目录`fc-i20-public-diagnostic-20261018-6ac3b192`仅含脱敏状态/日期，不含Cookie/CSRF/query。该次观察不是六核心恢复或自然窗口通过。

接入固定公开乐咕client：requests+stdlib、单匿名bootstrap、每支持指标一次、15秒最小间隔、240秒源读取协作预算；401/403/429整实例永久停止，失败不读body/不重试，标准requests代理解析保留NO_PROXY。只接受加权addTtmPe/addPb及真实非重复源日期，拒绝坏JSON/重复键/非有限值/超限/close失败，错误不含原body或自由异常文本。保留六核心6/6、同日PE/PB、30样本、7天及未来日拒绝；不支持候选显式missing/unsupported而不缩requested。它不是整main写盘硬期限、原生DNS抢占、上游配额承诺或恢复证明。本轮没有运行真实producer、覆写公开估值产物、dispatch工作流或修改云端。

为使公开定时修复不被Owner云迁移阻塞，已从main `0c0f9ad`建立独立CLI worktree，精确回补两个producer文件及三个纯指数测试文件；不含Owner/schema9、工作流、依赖、版本、数据库或秘密。App managed worktree因会话cwd为父目录返回Not a git repository，改用普通git worktree add --detach，原仓库HEAD/index不动；该临时checkout不是已注册App附件。独立静态复审通过，专属正常门禁/发布状态另记，尚不把它当main已更新。应用仍8.0.0；实际Turso JSON1/TEMP/TLS、受控迁移/停写/备份、远端耐久与独立恢复、真实浏览器和自然任务仍未验收，整个I18/I19/I20及v9正式发布继续不勾选。

### 10-18 候选 CI 与独立公开回补终态

本切片已正常提交并推送`2609e1f5d0145f115ebb09e4cc57abb07bd57f3e`，父cea4a7f。[CI 39103798112](https://github.com/AureliusWu/fund-compass/actions/runs/39103798112) attempt1于`2026-10-18T06:25:05Z`实际completed/success；四job原日志核checkout精确`a9880c9db8e06cc22699c00014b4a85376f78a2b`，Git API父为main0c0f9ad与2609e1f，整tree=`9e9e47a5349e623f4b16ac3d4f3ab897c00f161b`与目标相同。Linux Python3.12.15/FastAPI0.143.3/pytest9.1.1后端**2885 passed/1 warning/141.74s**、pip check通过；前端**919/54文件**、类型/build7.58s/PWA7/7；Worker**144/3文件**、类型/dry-run114.28KiB/gzip26.58KiB，两端npm0 vulnerabilities。deploy/candidate_smoke/formal_smoke实际skipped、steps为空；PR4仍OPEN/DRAFT/未merge，不是部署或正式发布。

根与独立代理分别读取实际run/jobs、source/merge元数据及日志，17份公开证据重新哈希漂移0。目录`fc-ci-39103798112-readonly-20261018-82f63c11`，EVIDENCE_PINS SHA=`ff9a12a6fdfddea51e41703fdd6d759478a8da05421a3c64b4a24cbf1cfecaa6`、VERIFICATION=`c1862ada9fd789b745f5ab22c4cf6e0a84b7c53358e22b7aeae1127ff524cb7c`。保留CLI不支持startedTime的初次只读字段错误，改读本机明确支持的startedAt；未派发重跑或改认证/远端元数据。

独立main回补在固定0c0f9ad加五代码/测试文件上，正常专项**143 passed/1.13s**、全量**721 passed/28.58s**，full外层30.447s；原300秒、正常插件、实际新默认DB/byte-cache隔离保持，四阶段各一次exit0/未超时/排空/默认DB未创建/stderr空。192源raw摘要`aeb0cfb313cb8aa3672084a3c8d76b427e87933d96c43a8b8edd23c7e325bb53`，根独立逐文件漂移0；full manifest=`6e986efbc158e115b3c0169a0cb94043555564886df7f9d0a19e80552feca1a7`，stdout=`c03f2597f6387b056f9fdfdd7748eb7ed07c8086f25a681bb7d5e692ccc8a8b6`，目录`fc-index-main-normal-author-20261018-9c64bd12`。之后只新增公开说明并提交`7999db1c753966ccd94a8e7ad0844c18e706e2f9`，已普通推送`fix/index-source-hardening-20261018`，远端main仍0c0f9ad。该分支没有单独Python3.12 CI或上线证明；没有为绕过已遇PR元数据403而直推main，也未用特性PR的整树测试冒充不同main回补树的CI。

本次按computer-use技能检查Chrome原生窗口：初始化/list_apps成功，确有一个Chrome窗口；首次只读get_window_state被平台安全终止，提示无法可靠识别当前浏览器URL并要求停止当前回合，已立即结束，没有继续输入/绕过。不是用户未登录的证明；没有使用Tabbit、Cookie/CDP、密钥枚举或云配置。此路径保持停止，不要求用户重复刷新。

### Holding/Decision 原子保存基础与缺失估值崩溃修复（2026-10-18）

将原`save_holding`、`save_decision`事务主体抽成调用者同连接内核，原public入口连接前纯校验顺序保留，内核再次核ID/hash、scope/引用、未来时间及幂等；只接受已有原生bool事务，不开连接、不commit/rollback/close，也不以sqlite3类型断言排除现Turso协议。新增`save_holding_and_decision`单BEGIN IMMEDIATE保存两root及scope，真实`create_decision`已改为消费此pair，返回实际首存模型。Decision失败不再遗留新Holding；Evidence仍先独立保存，失败可能留下Evidence/source事件，不称整个链原子、Owner已接通、远端事务已验证或I19-04整体完成。

新增24个参数化原生SQLite故障/幂等/外层事务回归（最终计数以collection为准），原测试断言未改。首轮正常专项collection276，实际**2 failed/274 passed/40.32s**、外层42.350s；立即停止，collection-full/full未启动。两个真实service用例都在进入pair前暴露旧`_reason_text`对未选择估值文案也急切格式化`valuation_percentile=None`的TypeError，不是原子事务失败。修复只把三个估值文案移至选中分支求值；缺失保留“估值证据不足”，不补零、不修改动作阈值/策略版本或原service fixture。新增9项回归覆盖持有/未持有×fresh/unavailable缺失，以及五个正常分位含真实0的原文案；原457行atomic测试raw SHA仍`c96d032e4a11cc78b31d684367db603ed69f4b8b745170fb6d0e8b7bde409db3`。

首轮证据目录`fc-v8-atomic-normal-author-20261018-5ce91f42`完整保留，focused manifest=`62ccedc88994977176b290ec137cad328035bafe758c018a8c447143cbe5ed2a`、stdout=`c44a0fb4fd25f48aa7547492f7a7f04a78d3cdee68a989827e4df5bf814c5275`。exit1/未超时/输出排空/stderr空/实际新默认DB未创建，249源前后无漂移；不把原失败改写成PASS，也不提高原300秒或禁用插件。准备阶段给出的不存在`test_persistence_verification.py`已在任何执行前改为实际两份persistence candidate测试，最终10项focused；此为路径核对纠正，不冒称一次pytest失败或成功。修复轮另行冻结、执行及记录，未以静态复审代替。

修复轮正常专项**285 collected / 285 passed**（pytest42.63s、外层44.652s），全量collection **2918 collected**；实际full于`2026-10-18T06:49:48.5302311Z→06:54:48.6319754Z`达到原300秒上限，**TIMEOUT、exit -1、未完成**，不得称全量通过。输出排空、stderr为空、监督无异常、实际新默认DB未创建；日志结束于旧`turso_scope_upgrade`区约90%，尚未运行到新增V8测试，因此不能据此归因新pair开销。前一轮2885全量原本仅约9秒裕度，也不能用该历史PASS替代当前2918结果。

本轮目录`fc-v8-atomic-normal-repair-author-20261018-63f8a4d2`，full manifest=`427acf57522e4b2a8333e2cd0b646262050cfe0734efb5461fb43ca03139539d`、stdout=`a0ef9c4544509d13bee7ce85869e341ea153168365dc5343c45efb95c4bb7ebf`；runner仍`43b23da1557dd4cf1ad72774b266807dac976716f9cb0cd1afa05320a2902bfb`。249源摘要`b54c5e0fa4972d1f76886496ed4fb9c37bec79bae5715c3426babc413d382a71`，根独立逐文件重算漂移0，原两项失败日志仍原样保留。超时后未盲目重跑、增加预算、禁用插件/警告或减少测试；先作独立耗时诊断，版本、部署与发布门禁继续不放行。

随后在同一冻结源码/3.14旧环境上，仅对固定8个operational-profile用例作三次隔离cProfile诊断，各60秒独立上限；全部8 passed，外层5.830/5.457/4.614秒（median5.457、worst5.830），不是重跑全量或提高门禁预算。根读取第二份原生pstats：8次fixture1.298秒、16次rehearse1.080秒、scope schema_errors0.110秒、8次Holding内核0.012秒/Decision内核0.026秒、48次preflight0.001秒；小样本主要self time在SQLite与文件I/O，不能据此解释全套约31秒累计差异或宣称生产性能通过。未为赶时限删除任何守卫、完整性核对或独立恢复。目录`fc-v8-atomic-profile-author-20261018-a1d47b8e`保留三份原始pstats/日志，输入仍249源，三次均exit0/无超时/排空/默认DB未创建/0漂移。

本机原全局环境实际Python3.14.4/pytest8.4.1，额外自动加载pytest-asyncio0.24/cov7.1；旧完整日志有112972条来自该asyncio插件的弃用警告，并非项目声明的Python3.12环境。另在仓库外新建隔离Python3.12.13环境，按两份现requirements从PyPI安装31项（FastAPI0.143.3/Starlette1.8.0/pytest9.1.1/Pydantic2.14.1），pip check通过；原默认Python/包和注册表未改。uv内置目录没有CI用的3.12.15，初次明确返回No download后按其可提供目录选3.12.13，不冒充精确同patch。3.12正常四阶段仍使用原300秒、同249源码和原10份专项/全testpaths，runner只换解释器路径；插件保持该干净requirements环境的正常自动加载，不能将跨解释器/依赖/插件的结果当作同环境代码加速，也不抹去3.14超时。新环境门禁终态另记。

新3.12环境四阶段均首次exit0：专项collection/run **285/285 passed**（pytest48.12s、外层50.224s），全量collection/run **2918/2918 passed**（pytest278.09s、外层279.839s）；full实际UTC `2026-10-18T07:07:48.3270861Z→07:12:28.1694047Z`，仍低于原300秒。正常autoload实际仅anyio4.15.1；两个警告分别为Starlette/httpx弃用及坏confidence=inf故障注入的Pydantic提示，未过滤。四次均无超时/完整排空/stderr空/实际新默认DB未创建；根独立核全部manifest/实际尾部汇总及249源漂移0，先前两项失败与3.14超时文件仍原摘要。

证据目录`fc-v8-atomic-python312-normal-author-20261018-91a3d5c8`，full manifest=`a366f2a4d154e735307b197a04059e5a39cb54809d5b054d25dabc9d571faf47`、stdout=`8be83d7fd43c5c03eed497e567a6b5fb0175bb70b525cf7868e4914229cdcf3b`；runner=`3165fd2a6c4c4217b901baefb5f965a8a7c041dfcab7eaf02f18f2e47ca7fd7c`、freeze=`e87e307c9a36208231261554625e84ad2d27963d3824fbc483655a81269dca47`，源码摘要仍`b54c5e0fa4972d1f76886496ed4fb9c37bec79bae5715c3426babc413d382a71`。这只关闭本切片的本地3.12代码门禁，不称3.14已修、生产性能优化、Owner业务链完成或部署/发布。

### 无浏览器的候选数据库真实只读能力复核（2026-10-18）

只使用此前用户明确指定的候选配置文件，通过既有普通数据库凭据完成一次真实直连检查，没有登录自动化、Cookie/CDP、Token枚举、换身份/网络或新管理权限。复用现有driver/inspect，精确只读SQL闭集后执行固定`sqlite_version/json_valid/json_extract`，禁DDL/TEMP/PRAGMA赋值/私有账本/迁移/写probe/重试；5秒socket、20秒协作总预算、1MiB请求/响应、外部30秒监督，子进程清环境/-B/-I，不导入db/main或初始化。敏感配置只在进程内存，不进参数、日志、artifact或仓库。

实际结果：**exit0/3526ms/无超时/输出排空/stderr空**，schema来源`schema_table`且仍为**8**，普通表20、公开funds计数28019，SQLite **3.47.0**，`json_valid`及固定`json_extract`均返回原生整数1；关闭成功后才输出闭集结果，5份代码输入前后摘要一致。该观察证明本次已配置路径可读、这两个JSON函数可用，不证明TEMP/JSON写用法、schema9迁移、Owner事务、凭据轮换、耐久、独立恢复、线上部署或正式资格。

证据目录`fc-turso-readonly-repair-20261018-83a04d57/run-20261018T065123833Z-10c404a9867047ee85e32f0403926c54`，manifest SHA=`57c603cf7fbc4f9b76ee10150a2f271aa671ebe7e32e4252707a7b4099fa7119`、stdout=`6f60db77d1abace917c3b0ef0715c493994695e7d841ffa107736179bbead00c`，根实际读完整结果/manifest并重算日志。外部输入seal=`8ca749202c2c7b4dfda4bb661f3d3b62f5833b90fc69404317f3b574cab3f7f6`。首份author外层存在行首-or导致的19个级联解析错误，根在任何调用前用静态Parser阻止，无凭据读取/child/HTTP；独立修订只移动8个运算符换行及固定目录/pins，静态解析0错误后才单次执行，旧稿保留。没有把这一准备错误当作Turso鉴权/服务失败，也未要求用户重复登录。

随后单次metadata-only核验**exit0/2429ms/无超时/排空/关闭成功**：schema-table8、SQLite header0、21表（含内部表）/86个结构对象，完整四列结构在私有内存逐一符合仓库固定schema8合同。可选对象明确为`turso_candidate_probe_v1`和`universe_import_state`，没有sqlite_stat1；stat4、未知对象或坏DDL仍拒绝。普通表20与含内部表21不是矛盾，不从计数推断具体profile。三个只读metadata语句分别至多一次，未读业务行；原始DDL未落盘/输出，三次观察**不是同事务一致快照**，不能用它代替后续capture、停写、新备份、业务行引用核验、远端恢复或发布资格。

两代理与根全文审阅新helper/outer及完整diff，根独立核15输入、PowerShell Parser0/Python AST0后才执行，前后pins不变。目录`fc-turso-inventory-author-20261018-a62f3c91/run-20261018T070721729Z-f2ca3a637d63437fbba95fa98853d52f`，manifest=`45293400ae53a8cb11704393e3166e8f008cdbbc9fd09115c2635116caaf32e8`、stdout=`49e337b28ad56f9c07f1191d958c18ab338fccc6c082d86f16a283f4903fd5f4`；输入seal=`762beee52c1588d3da757237fe0e923d74a42e1255592f5fde660ca37d8e7513`。不自动串行启动capture，不改变云端schema/Token/配置或计费。

### 5049 候选 CI 终态与当前 main 分离（2026-10-20）

原子pair及null修复已提交并普通推送`5049d322ce34d21d2b80ead973217d348af7d275`，父2609e1f。[CI 39106884147](https://github.com/AureliusWu/fund-compass/actions/runs/39106884147) attempt1于`2026-10-18T07:16:43Z`实际completed/success。10-20重新读取实际run/jobs与四个job日志：checkout均为`7caf81234677521679e0b932049264305f473b78`，父精确旧main0c0f9ad与5049，tree=`8bab06ead8c0b048b2669f10c770efaa2d4b1c89`与5049完全相同。后端Python3.12.15 **2918 passed/2 warnings/142.75s**、pip check；前端 **919/54文件**、类型/build4.86s/PWA7/7；Worker **144/3文件**、类型/Wrangler dry-run114.28KiB/gzip26.58KiB，两端npm0 vulnerabilities。deploy/candidate_smoke/formal_smoke均skipped且steps为空；不是已部署或正式发布。

公开证据目录`fc-ci-39106884147-readonly-20261020-6b273a4f`，VERIFICATION.retry1 SHA=`c42301f41483d6bbd711e12b05b5921860b2adc3f2bff5287ebf0c3a24332ec3`、EVIDENCE_PINS_FINAL=`9196fe71fb4d8717c30a80f008473f2ff4a3302385b3049e142132f963b6e9cd`；根实际读取API投影/真实日志并独立重算23文件漂移0。普通gh读取曾网络EOF，原零长文件保留，同配置有限重取；日志字面转义导致的首次证据解析失败与pins自身占用初稿亦保留，不伪称第一次全部成功。没有rerun/dispatch或更换认证。

本次外部核验时间`2026-10-20T07:00:47Z`：feature仍5049，PR4仍OPEN/DRAFT/未合并；远端main已到`ba67409584fa9deabeb1c4b9e68e3f78757c85ae`，比tested base前进5个bot数据提交/33产物文件。PR API的base仍旧0c，不将其当前merge_commit_sha冒充实际tested merge。已保存compare显示这些路径与5049改动无交集，但其中海外新预测缺项、季报仅fetched_at刷新、模型candidate仍rejected/collecting都须保留真实降级；不能用feature旧产物覆盖或包装为任务恢复。20项缺patch的gzip/经理payload尚未实际取字节核验，后续正常整合仍需产物/隐私校验和新tree CI。未直推main、edit被403阻止的PR、修改云库或发布版本。

### 新受保护一致快照与迁移预检拦截（2026-10-20）

继续使用已授权配置直连，不再依赖浏览器登录；没有读取浏览器凭据、枚举密钥或更换身份。外部备份工具经全文复审和独立检查后，补齐30秒观察时点边界与发布后原始哈希复核。四个正常离线阶段首次通过：Python **36 passed**、PowerShell闭集合同 **59项**、真实Windows文件/ACL **15项**；1项符号链接因宿主不能创建而明确skip。正常插件、源码31项前后pin、原默认数据库仅元数据不变/隔离库未创建均核实；没有把未执行的进程故障注入场景称为通过。工具与测试目录`fc-turso-protected-capture-author-20261020-4b8e70a1`在仓库外，validation seal=`1066eeda491d930c4e8493f8c8f879c897a085e0e74a074c8c9bd7f2873d64f8`，capture输入seal=`3f41f2c486c48fd3d762493e4779e8211a0898afe86a23d456d9173c5210a8fb`。

真实只读capture只执行一次，**exit0、子进程19681ms、未超时、stdout/stderr排空、关闭成功**；取得同事务 **schema8 / 21表 / 34,709行 / 86结构对象**，已知两辅助表profile不扩展，query_only观察为0且不称服务端写保护。新备份为仓库外受保护父目录的直接子目录`20261020-schema8-7d26e934`；source.sqlite3 **4,915,200字节**，SHA=`e88ae570aa50969f2fdf57776cbc1161dad744760e5a245587b122457c866494`。原始结构sidecar=`cea71612e0f7a441176c4eceeef332b6aad424e397947cdbb21e570b7fbc2dd1`、capture.safe=`e19e1e9e6e88a8e401df9caeef8e2a2802b47dc7b426e8ad2b4c171f84f092f2`、manifest.safe=`1f389baa1aff898814c54debc16bd9208449f85a603957af23337dd3867a9d0b`、COMPLETE=`fbed9a69c02e0033bfd4d38d5e36777980c0fc973a43e256fd34b02ce78df76c`；根另行重算六文件及全部绑定，检查只读/普通文件、current-user与SYSTEM两条ACL及owner/inheritance，无旧文件覆盖/删除。私人镜像和原始DDL不入Git/CI。

随后只对这份关闭快照执行本地`plan`，cleanenv无云凭据/网络调用、同30秒及共享5秒清理预算；实际 **exit1、1758ms、未超时/排空**，固定错误为`legacy_chain_validation_failed`，源文件与31源码pin未变。失败目录`20261020-local-plan-53c0a8d6`完整保留，manifest=`f3d79eb0bd87ddb4d7c7e622a408d38f731937bf92395ac07c9bc08de67c777b`、stderr=`5b28db46f419aeeaceaaa98ac62695498ef4eaff2beb5714ef7bac9f3fdf59cd`。没有盲目重跑、跳过旧链校验、修改私人数据或继续rehearse/apply，下一步在同一备份上做脱敏离线定位。该失败不否定一致捕获，但明确阻断这份源的迁移计划；10-03的历史恢复通过不能替代当前源。

本次只关闭“新受保护一致只读备份”子门禁；不是当前停写、凭据轮换、免费配额/Overages设置、schema9迁移、Owner云业务写入、远端恢复/重启或正式发布证明。没有新建云服务、启用付费或改云配置；应用仍8.0.0，I18/I19及v9整体不勾选。

### 旧账本精度冲突定位与 main 产物字节补验（2026-10-20）

仅在新关闭快照上做一次原校验脱敏trace、一次四root完整聚合和一次两字段ULP诊断，均cleanenv/只读/原预算，不修改源、验证器或旧失败证据。trace定位`repository_scopes.backfill_legacy_production`第411行的冗余投影比较；**76根（Evidence34/Holding7/Policy1/Decision34）全部模型、canonical payload、ID/hash及reserved前置通过**，持仓/策略/决策投影均无冲突。仅5份Evidence的`estimate`（2项）及`estimate_coverage`（5项）出现float/float差异，7项均为恰好 **1 ULP**，无更大差距、null/type/零符号混淆；其余字段不匹配0。不是已证明数据被篡改，也尚不能归因Turso/JSON或自动允许容差；继续区分存储与读取链路。原始数值、基金/账户/ID/业务摘要未输出。诊断成功只表示收集完成，`rehearsal_ok=false`，迁移仍拒绝。

三份受保护诊断目录分别`20261020-local-diagnose-6571be20`、`20261020-local-projection-9185c6af`、`20261020-local-float-6a9d2f30`，实际子进程7258/729/673ms，exit0/无超时/排空；manifest SHA依次=`8573873235d1c93ea44e170aef383f97dbc4a0ad27cd16bb2beaa045a8e0ddac`、`ec2b4bfc0462e7d017a57740dec34359cde83ea23ceb642782f2da3271490c3b`、`f041aebadc42e4ffa02a2f344752351d014f0f20e14cc769efbabef277356953`。projection子进程原始stdout完整且SHA=`c9421bcfa8c04f586be3cb43c9eb033e9982219b41186cf621576dc126c6a2b5`；父外层展示JSON的depth6警告导致一次展示解析失败，根没有重跑诊断，直接重哈希原生stdout后解析完整聚合；后续新float runner使用depth12。全部资格继续false，源仍e88ae570…。

另以普通`git fetch origin main`取得当前`ba67409584fa9deabeb1c4b9e68e3f78757c85ae`对象，不checkout/改index/推main。一次实际字节审计exit0/6.25s/stderr0，核52 Git blob身份及raw SHA：全集gzip解压3,047,005字节/28,104条并匹配meta digest，经理当前9片4,359条与legacy逐值一致、上一代9片4,358条仍保留、淘汰9旧孤儿名称摘要/行schema亦核实。33个当前JSON/解压文档隐私marker为0，但不称语义来源认证；上游独立核对、整合tree CI及生产CDN/API未验收。海外仍0有效预测/74h/models空，active/governance未变，富集只刷新fetched_at，金融归属日不变，不能包装为业务恢复。

公开字节审计目录`fc-main-byte-audit-20261020-f4a21c38`，原生stdout SHA=`e41176d82b5c38686e82eeef97ece8e2200e9ec9590cab225e62cc662483b2b9`。该原生文件实际为CP936而非UTF-8，严格解码/JSON及反编码逐字SHA通过；保留原始文件，另存保持整个原始JSON文本的UTF-8机械投影`audit.utf8-raw-text-projection.json`，SHA=`67ad26c96e2ad4879ca063361879488e1e4565e11d61e5a7dd11c2b4d9dd221f`，不是新的审计运行或原生stdout。较早的重新序列化投影会使PowerShell自动转换日期表示，原样留存但不作为精确字符串证据。源码、数据完整性、业务产出与发布继续分轴；不先更改应用版本。

### 整合 tree CI、Render 工作区与真实可用性复核（2026-10-20）

普通 merge 已将已审 main `ba67409584fa9deabeb1c4b9e68e3f78757c85ae` 的 33 产物路径整合到 feature，head 为 `e1c6520b7026bc84b9b921008c31862a64cd88d1`；逐路径与 main tree 相同。移除的 9 旧孤儿经理分片可从 Git 恢复，当前及上一代 18 分片保留。[CI 39387942990](https://github.com/AureliusWu/fund-compass/actions/runs/39387942990) attempt1 于 `2026-10-20T07:42:15Z` completed/success：四 job 实际 checkout 均 `7c6558c3fe55e8ac18c71d39395f782d0064dcab`，父为 ba674+e1c；tested merge/source API/本地目标 tree 同为 `b9d62d8d584f6a5b5e6cdd822fe5341eba0a3b4d`。后端 **2918 passed/2 warnings/141.96s**、前端 **919/54文件**、type/build7.17s/PWA7/7、Worker **144/3文件**及check/dry-run通过，两端npm0 vulnerabilities。deploy/formal_smoke/candidate_smoke仍 skipped/steps=[]。证据 `fc-ci-39387942990-readonly-20261020-a2e84d16` 的20文件根独立重哈希漂移0；pins=`64723b4617e52412290fc17a7e5ebcb3d442ed8ac34c3d7457cba8ea83af3cf0`、verification=`734b363c0af9d04a854224dbc61e50c7d3957a44253105926d7ff430c91e8761`。没有 rerun/dispatch、修改受403阻止的PR或直推main。

用户已明确选择 **My Workspace**，后续 Render MCP 调用均显式使用所确认 workspace，不再要求重新登录或发送密钥。两服务均观察为 Free/main/autoDeploy/1实例，最近 live deploy 均 ba674：候选 `srv-dab7g0n40ujc73a2ma50 / dep-dbb21mrm8hqs73buppr0`，旧主 `srv-d8v0t26rnols73fq6beg / dep-dbb21n3m8hqs73bupq2g`。服务 start command 没有显式 `--workers 1`，未将其推断为多进程或完整运行时 worker 数证明。未读取 env secret、改配置/计划、部署/重启或创建付费资源；脱敏元数据记录 SHA=`78724f3beb861347ae3839bc0cbcf16fdbbfe2a2e3232424dc12c4d1e4b41446` 不是来源签名或操作授权替代物。

`08:09:25Z` 两 API 的 health/funds 四个真实公开 GET 均在约15.625秒超时，未取得HTTP状态，原失败保留；随后同一工作区 app logs 显示旧主在 `08:10:05Z`、候选在 `08:10:14Z` 完成启动，各自后续health连续200，所读07:45起日志未匹配异常。该时序支持免费实例唤醒慢，不单靠live标记判断可用。`08:11:15Z` 明确的暖态复核四GET均200/JSON：候选health1859ms/funds2125ms，旧主1312/1297ms；两者版本8.0.0、commit ba674、目录28104、index usable=false、durable=false。候选为libsql/turso_candidate；`08:15:42Z` 再读取旧主公开database投影确认为sqlite/ephemeral。未读取私人业务。这个小样本不是五样本性能验收、前端浏览器旅程、跨重启业务读回或完整production smoke。

### JSON 浮点参数链复现；备选传输失败仍保留（2026-10-20）

对同一关闭快照绑定的34 Evidence做固定只读SQL文本表示诊断，每列29 NULL/5 float，`printf('%!.26g', ...)`再解析与capture的全部5 float位相同，但相对payload仍为estimate2项/coverage5项1ULP。单次exit0/1885ms/2POST含关闭、source/code pins未变，目录`20261020-remote-float-b07e3a42`，manifest=`333ae24ab4a1650dc940ffc7a6daa4d88548f7dc48c50d025afd9b16b0a56df2`。printf并非所有double的精确十进制展开，保留文本算法不确定性，不据此宣称实际原始二进制位或历史写入成因。

另用完全公开的128个有理数样本（63正/63负/2正零），原512参数、20秒协作/5秒socket/外部30秒监督不变。原69764字节 UNION 查询被拒；同输入单次脱敏分类只得到 native code=other/reason=unclassified，失败目录 `20261020-remote-binding-7091cd53` 与 `20261020-remote-binding-error-1fa5b208` 保留，不能猜测权限、SQL长度或拒绝原因。新 CTE VALUES 仅改查询形态至2287字节：本机真实内存SQLite对旧/新10列×128行逐值相同、5关系全部128真。云端新形态单次 **exit0/1773ms/2POST/关闭成功**，128行/全部类型完整，但float原生绑定对有理数计算及repr文本CAST有 **10 false/118 true**，repr CAST对有理数计算为 **128 true**；这复现当前JSON浮点参数路径的精度差异，不是已修复、不代表旧行成因或通用CAST方案可用。目录 `20261020-remote-binding-cte-0c739ca1`，manifest=`cf93f9fe69eae6d0329128421baff640c57879ea85df0fa77c0ae98aae2ab925`、stdout=`7d3fc9c3fd13329565a9e07552b0ebee4adecf56426a35e70ae189457b5ceb7c`；没有用户表读取、数据修复、DML/DDL或放宽旧链校验。

按 [Hrana 3 官方协议](https://github.com/tursodatabase/libsql/blob/main/docs/HRANA_3_SPEC.md)另作者了最小固定查询 Protobuf Execute+Close 候选，不是通用DBAPI实现；原10列外加公开bound echo核double位，仍128/512。离线黄金向量、边界/协议闭合/错误清理/本机SQL等价等 **15 tests passed/3.16s**。一次实际云POST **exit1/1026ms/error=remote_failed/0行**，HTTP response/session已关闭，但没有SQL Close ACK，不授予远端关闭或binary链路资格，也尚无具体HTTP状态/拒绝原因。目录 `20261020-remote-binding-protobuf-a9d427c8`，manifest=`f58449061221bde3a960da9cfd78584ce137be3eb0371fd2caebdca5c9ec0d70`、stdout=`e8fcfd4b96c5bb5942eb4e417d36861ccf2dc2aa789250f1ca355c6b93a367bb`；原helper SHA=`9b679cfb87fde10941149ab6ad22fb62c773fde106b6ba37e2c89e2bf459a4fe`未改，不重试该SELECT。官方协议能力不等于当前托管入口实际可用。

### I19 本地事务 workspace 与保守导入预览基础（2026-10-20）

新增 `utils/owner-cloud-import.ts` 的严格cloud-only基金账户预览：完整DTO/基线head、闭集与容量校验，相等noop，任意同key差异整批拒绝；云缺失不删除，tombstone/多账户/未知holding/真实0/null与已有pending原样保留。manual仅验证并明确计排除数，不假称全scope已迁移；完整baseline来源和当前generation仍由调用者controller/guard证明，不以对象形状认证。纯计划提供完整有序前后像及SHA，不带伪造updated_at/holding版本；71项专项根重跑通过。

新增显式构造 `stores/owner-workspace.ts`，同现outbox数据库的物理v1→v2只增working_copy/import_receipts，原slot/raw/hash/version/target不改；open取消共用总deadline，active upgrade中已成功put而未complete时仍abort，迟到upgrade不得初始化。业务写在三个store的同一实际strict事务中核完整前像与两版本，空槽协调epoch仅作CAS串行化，不是业务revision；非空任何state原样保护。回执与工作副本原子提交，按原id/hash核对和幂等重放，unknown不自动重跑；回滚须精确当前postimage且版本继续单调，不覆盖后续编辑。实际put后abort、commit后close/撤权、两handle竞争、prepare竞争、坏schema/slot、blocked、配额/容量、hash迟到超时均有回归。首轮一项abort分类失败后修复真实tx.onerror先于onabort的映射，未删断言；独立审查发现的初始open取消空窗及legacy Unicode合同漂移均修复并补测试。

作者专项 **155/155**，根随后实际全量 **1026 passed/56文件/5.21s**、type-check exit0、build **10.37s/PWA7/7** exit0；独立最终源码审查未发现剩余P0/P1。现outbox懒加载chunk观察5.99→6.49kB、gzip2.31→2.51kB，PWA仍67项；旧数来自CI、现数本机，非同宿主性能基线，不把构建耗时差异当运行时回归证明。新基础尚未接UI，因此不将新增模块称用户旅程已完成。

明确剩余：存储测试使用fake-indexeddb，不是真实Chrome崩溃/跨设备证据；versionchange与strict新数据初始化是两次提交，中断后缺current的v2固定拒绝、不自动重建。adoptLegacy是trusted-caller种子保存原语，不证明raw→entries业务allowlist转换或实际LS source/generation绑定；完整导出、codec、全部真实watchlist编辑权威切换、导入/回滚UI仍待实现，当前没有触发Gist或Owner云端写入。应用仍8.0.0，不勾选整个I18/I19、不推main/建v9 tag/release，也未执行Token轮换、云迁移、远端恢复、旧Gist删除或任何付费变更。

### 精确原生浮点读回与 ae150 CI（2026-10-20）

本地事务基础已正常提交/推送为 `ae150a20f73fa0402be8c67542c16f356eba9999`。[CI 39393911410](https://github.com/AureliusWu/fund-compass/actions/runs/39393911410) attempt1 于 `08:32:39Z` completed/success；四个实际 checkout 均 `eb7a0ddc52bcdfa7417f422b60050378b4e7262c`，父为 ba674+ae150，tested merge/source API/本地 tree 均 `977df679bc70dcb39ea53219e29fe88137aa8267`。后端 **2918 passed/2 warnings/95.60s**，前端 **1026/56文件**、类型/构建7.54s/PWA7/7，Worker **144/3文件**及check/dry-run通过，两个npm audit为0。部署和两类smoke均skipped/steps=[]，不是新源码上线。证据目录 `fc-ci-39393911410-readonly-20261020-38e4c29a`，verification=`f3f5c78f2871301d569e71db73072d602cfc33e8592d79143e7896941d309c98`、pins=`ac189c863b7fd4b5bfb79dc7f38720aa6e8e51d8acfb6bba8debcad20e92ca85`；根独立重哈希25文件漂移0。一次普通source API EOF保留，同身份一次补读成功；无rerun/dispatch/更换认证。

为排除 printf 文本算法的不确定性，新增仅固定只读查询的 exact-REAL oracle：通过整数mantissa与公开2的幂在服务端构造期望REAL，浮点数不经过JSON参数；34个原ID/hash完整唯一绑定，逐项核typeof及服务端数值IS结果，不输出私有值。作者纯合成 **9 passed/2.69s**，含1000个公开有限binary64逐位本机对照；外部父层首次因AGENTS合法新增规则使旧seal失配而在任何子进程/凭据/HTTP前停止，原seal保留。根比较31项仅AGENTS变化，另建新seal `df2235e7a6a856af9c4f7eec957b56b67b1e5b17000b5328ae131c8007d500a1` 并独立重核0漂移，不修改旧证据。

真实诊断一次 **exit0/1746ms/2POST/关闭**：34行完整，两个字段各29NULL/5float；estimate等32/差2，coverage等29/差5，合计5行有原生不等。目录 `20261020-remote-exact-real-d3f6a218`，manifest=`0de03cbb46d7204e80d49c8a30627d9be4d7c9e2cbd5157db1ca87dd597435d4`、stdout=`bb8f2c59e571d16fd3a48b2297adfdcb8479430fb0587a7884fcae19a3048ac8`，helper=`3ac03d242ba107d0b1a4979c1e9448a9a0d4f5e0db29a787fa6c44da6767acf0`。因此当前云端冗余标量与有效payload确有差异，不只是capture读取/printf展示；仍未证明历史插入成因、物理二进制转储或来源认证。查询绑定的是旧快照34行，不是新停写或全库当前population证明；无DML/DDL/远端修复/迁移，全部正式资格继续false。

### 明示投影修复与真实关闭快照的本地独立恢复（2026-10-20）

新增 `database/turso_projection_repair.py` 与显式CLI，不修改旧offline升级、packet、strict backfill或不可变trigger。仅固定Evidence两列、原生有限float、恰1ULP可列入私有delta；类型/null/负零/更大差距、其它列/根/衍生链损坏整批拒绝，零delta不是修复。先核原始模型/ID/hash/完整前像，再重建固定DDL内存副本，不UPDATE原表或删除trigger；原完整严格迁移与仓储读回仍为最终权威。plan绑定source文件/原serialize/完整typed前像/代码（含新CLI）/profile/有序delta/修后8像/目标9像，rehearse必须匹配同plan且从原始8像重新推导，不从已修副本冒称恢复。公开摘要无业务值/ID，明确 `legacy_rows_unchanged=false`，不可变payload/ID/hash未变，远端/apply/restore/formal均false。

独立复审发现P1：路径若先lstat再判断local，UNC可触发SMB；随后发现Windows无盘符rooted设备别名。均在首次Path.absolute/lstat/SQLite前按平台词法关闭，并加23+3无文件系统调用回归；没有实际访问UNC或读取系统凭据。作者最终新module84+CLI13+旧upgrade109为 **206 passed/40.96s**；根独立新版module+CLI+exact **139 passed/14.87s**。最终module=`0e9380960b9370faeae842fedd791fb290250ebc734a20fd369a0ce74231ea31`、tests=`3753e42dd8aee0a01fa60186a71c36a687f79833c652af9062fe2720fe503df9`、CLI=`4e3e7046d8112b0d15a7c99e59a68338e673189efdbb162909d9ac6e1708edb6`；独立最终复审0未解决P0/P1，但源码审不代替真实副本或云恢复证据。

新外部parent=`e93b9419df3b007c705f43027e133c278227f1145862ca7974ae1a96c57bbab0`，原parent/失败证据未覆盖。静态Parser0和独立保护函数复核通过，执行前后核31旧代码pin+新module/CLI及原六文件；私有目录仅current-user/SYSTEM两条受保护ACL、无reparse、CreateNew/fsync/只读，cleanenv无凭据、30秒加共享5秒监督不变。对原e88ae570…关闭备份实际plan **exit0/3673ms**，目录 `20261020-local-projection-plan-97ad2e60`，manifest=`50c166a2162854eebd8f1c63304078cc640ea14a8e5e876c4d427dc3a11b6823`、stdout=`87ce0e0bcb03c2c8e40787d54ef73638ab9796f38c5696a4aa082d7769336289`。绑定repair=`494f04b7febd94be61de1c8fe32a1707d85a096368ab9039ba63f5be7dc7e022`、delta=`dfe881af6a8410b43df139dbf2d795f001bd88ce5a53cdefc73c0a0e08f52e6d`。

随后按上述原repair SHA实际rehearse **exit0/6536ms**，目录 `20261020-local-projection-rehearse-97ad2e60`，manifest=`43d7924613177df019a53e4a5a785c0e03f18b044ef9404fea3d4da4424277e9`、stdout=`11b389f9eb3970a652f3222533f6e2a6cf5f67f7d17451447a545a9467b84a6a`。两次均无超时、排空、stderr为空；恰7cells/5rows，2estimate/5coverage，21表/34,709行保持。原始schema8独立恢复重导delta及再次严格迁移得到同target rows SHA=`067192cc5860f5df8162a8a7de39e67b724d0e31ba08040a6e59505dbc872c91`；修后8rows=`64934378cdab418fcf2a3e2de09c572587b2fda35731e01421dac6ff8e2d9620`。根另重哈希四新证据及原source，并核两新目录ACL/普通只读文件，全部一致；原source SHA仍 `e88ae570aa50969f2fdf57776cbc1161dad744760e5a245587b122457c866494`。这是本地原始恢复子门禁，不是真实云库修复、旁路云恢复或正式发布放行。

新增 `database/exact_real.py` 的opt-in固定值槽primitive，finite float分解为整数mantissa和公开2的幂，只向JSON传integer参数，unary+移除CAST expression affinity；42项含1000公开binary64逐位、本机真实CAST/TEXT差异、NULL及固定INSERT/UPDATE回归。负零/非有限/其它DBAPI类型明确拒绝。尚未接默认driver、V8 writer或迁移packet；不能称所有后续写入已修好。后续需在固定INSERT逐REAL槽接线、保留原事务/幂等/scope/引用门禁并核真实provider，未知通用SQL不得全文rewrite。

### I19 旧存储业务codec、受控导出与本地事务联测（2026-10-20）

新增 `utils/owner-legacy-seed.ts`：只接受调用者明确提供的实际v1/v2 sourceKey/raw，严格JSON（重复key/Unicode/容量/数值）及业务闭集，原raw保持不改；按真实code/trim(account)规则生成key，明确kind或历史positive shares才能分类，不造缺失name/时间。保留0/null/-0、多账户、tombstone及pending，歧义/坏行/重复key整批拒绝。实际旧watchlist公开fixture有缺name形态，当前workspace需要name因此明确拒绝并保留raw，不称全旧版本无损兼容；declared holding/null可存本机，但现upload preview仍missing_value，不冒充已确认持仓。

business export仅固定format、allowlist entries、分类counts与内部entries SHA，外部完整bytes另有SHA；复导同时核两层SHA/闭集/计数/canonical spelling。hash只证明内容一致，不认证来源、同意、实际下载或恢复完成。作者新增102项实际旧fixture/与现preview对照/篡改/roundtrip/-0通过；根新增codec→导出复核→adoptLegacy→cloud-only import→原回执rollback的fake-indexeddb联测，raw/0/null/tombstone/独立版本保持。根专项 **258/4文件/694ms**、前端全量 **1129/57文件/4.57s**、独立type-check exit0、build **6.79s/PWA7/7**通过。未接实际LS source/generation读守卫、全编辑权威切换、UI/真实浏览器或云端业务写，整项I19及v9继续未完成，无付费/Token/Gist/云配置变化。

正常Python3.12.13/pytest9.1.1/anyio4.15.1的本机后端串行全量采集 **3057** 项，但原 **300秒** 硬上限到达时仅约91%，treeKill后exit-1、双流排空，**全量未通过**，不提高阈值或套用历史PASS。完整stdout/stderr保存在仓库外 `fc-projection-full-pytest-20261020-fe0d7b9ba1ba472da5922ef06db91e57`；最后在旧 `test_turso_scope_upgrade.py` 未完成，无最终summary、stderr为空。全backend/tools源码pin不变，真实默认DB仅metadata不变，隔离fallback未创建。尚无足够逐测试耗时证据认定性能根因；下一步可按相同总deadline做两个独立正常插件分片并核全集覆盖，同时核自然GitHub串行CI，不能把分片通过称原串行Windows通过。

Worker本机 **144/3文件/2.02s**、type-check通过。首次误以为deploy wrapper接受`--dry-run`参数，被其固定pass-through拒绝，未部署；读wrapper与CI后改用既有CI同款 `npx --no-install wrangler deploy --dry-run`，**exit0/114.28KiB/gzip26.58KiB**，仅本地构建，未调用正式deploy wrapper或绕过其身份门禁执行实际发布。

### 中断证据恢复、公开产物整合与 Render 实态（2026-10-22）

上次已提交/推送的源码为 `05e9acd3d50c8a3e9bab1847285962f47b9ba780`，tree=`0323ff6d0eefd6be2a4fc819ef705985802ed563`。[CI 39398675294](https://github.com/AureliusWu/fund-compass/actions/runs/39398675294) attempt1 在10-20已 completed/success，四 job 实际 checkout=`b605eb87b5169ff21fc3f0d79204a3acba003bb4`，父为 ba674+05e9acd；merge/source API/本地 tree 一致。后端 **3057 passed/2 warnings/142.87s**，前端 **1129/57文件**、type/build5.03s/PWA7/7，Worker **144/3文件**、check/dry-run通过，两端npm0 vulnerabilities。deploy/formal_smoke/candidate_smoke均 skipped/steps=[]，不是部署或正式发布。原证据目录`fc-ci-39398675294-readonly-20261020-a53f908e`的33文件已独立重哈希；verification=`11c611a1284bae4cb14e9f624add722ee1a5649bc14389c906554fab6336ac02`、pins=`7d38ae76c35843a5a0aaba98a4dd0ad46aae6891b9b8c47849720dd55d99ce18`。本轮新改动不能沿用该PASS。

原Windows串行300秒超时保持失败、不重跑冒充通过。上次另启动的正常插件两分片进程本轮已不存在，但其完整终态已保留：`fc-backend-two-shard-run-20261020-9741a1e9e7be4fefb3c0b71562547007`，**1529+1528=3057**、77文件无重叠/遗漏，全部9171个setup/call/teardown passed，JUnit数量一致，validation220431ms、总220942ms，均在原300秒内；无skip/xfail/deselected，fallback未创建。1539个Python源码pin前后相同。新独立复核`fc-backend-two-shard-review-20261022-7fd7fca2`核17份输入；verification=`8a48b5a883c019c9409f274e8f7124d5395530747fa3b4d39c0a5d8cbd6e7acd`。原parent只保存默认DB metadata比较布尔值，不能独立重建其值；这也不是Windows串行或当前修改源码的PASS。

普通fetch发现main前进至`f8d519a13479be5ce8b9a7568517231fd2b41a22`，仅两条公开海外账本bot提交、四产物；独立复核12个Git原始blob身份和SHA、严格JSON/全量日期/全部summary/export/fingerprint。旧80记录前缀未改，新增4条预测（其中1条后来结算），最新实际有效预测仅1/3；012920为16/20 collecting，两个建信candidate仍rejected，active/history不变。不是五交易日/两周验收或业务恢复。报告`fc-main-four-artifacts-review-20261022-219ebf2a`，verification=`93006edb8d80a3bf87af593843d52fa72d0e6b02eaa21d2a6f3e021c852490de`、pins=`9182ee46f8e5ac6312d426deceb2640a11de05eae8bbf8bc96ecaeb0578b01a5`；根重算12份raw SHA无漂移后正常merge到feature，merge=`73cb9e2637c8b0aba1d6c8d8bf9d2eb5aa907a36`，不checkout/执行main代码、不推main，保留并行未提交源码。

用户已确认My Workspace，后续直接传其workspaceId，不再询问登录。Render MCP首次list服务及后来一次logs读取有传输层错误，原错误保留；同接入的get_service/list_deploys成功，无换认证或浏览器旁路。两API仍Free/main/自动部署/1实例，live commit=f8d519a，候选deploy=`dep-dbcariou01pc73d3786g`、旧主=`dep-dbcariou01pc73d37820`；未读env secret、未改配置/部署/重启/扩容。

真实公开health在`02:40:57Z`两项均15秒超时，无HTTP状态，不以live冒充可用。`02:46:22–24Z`同脚本独立后续观察，两API各5次全部200/JSON，candidate p50=430.24ms/worst=1440.86ms，旧主376.93/1325.47ms；各自started_at在02:41:22Z，支持先前处于启动空窗，但不认证精确冷启动因果。均应用8.0.0/f8d519a、目录28104、指数usable=false、durable=false，候选turso_candidate/旧主ephemeral。原脚本误投影database.backend而真实字段是engine，因此该证据不提供engine的独立读回，不从源码推断成已观测值。原失败和后续各5样本保留于Temp `fc-render-public-health-20261022-result.json` / `fc-render-public-health-20261022-followup.json`，SHA分别`0c21cce8e3d51726c0bd4b81ac2ad2820e75aeb93b36305c55ffa34cb1042319` / `cacc8ebf04426d7a97d01f42d6a5c939f23c57f124a6f4a38cca93af4a32efbf`；脚本=`7a35233ac4995397e3184c1016280e602bbac968384d2762bfab2b9c46e3feed`。样本含连接建立开销，不是纯热API基准、已验证冷启动、真实浏览器/私人业务/跨重启/恢复或新源码上线；完整deployment smoke判定仍BLOCKED。

另对两服务的公开`/api/funds?page=1&page_size=1`各一次真实GET，均200/application-json，total=28104/items=1；候选1982ms、旧主786ms。只核分页可用/形状，不是逐基金金融值认证或五样本业务接口性能。

### 固定 V8 writer 精确绑定与真实本地来源守卫（2026-10-22）

新增`database/v8_insert.py`并接入`v8_repo.py`全部十处固定INSERT。表/列/REAL槽与原schema闭集对照，旧SQL列顺序和参数表达式AST十处相同；claim原九列六参数及`'in_progress',NULL` literals不变，Decision strength/confidence仍INTEGER。原生sqlite3.Connection仅校合同后返回预生成固定模板及原tuple，其余已有SQLite协议连接只在固定REAL槽使用exact整数表达式，不猜连接身份、不改变默认driver/任意SQL。Evidence及所有health先编译再首条INSERT；原引用、未来时间、幂等、scope和事务内核生命周期不变。

独立审查实际复现一个接线P1：正常1000→999.9999的小跌，经原收益/回撤round会合法得到`-0.0`；primitive的拒负零若直接传播，会阻塞自然结算。现固定V8投影仅对原生float零遵循既有canonical_json的+0.0合同，generic primitive仍拒负零/非有限，不改原模型、payload、ID/hash、NULL、native参数或财务round规则。真实基金与组合settle路径验证原始负零模型仍保留、投影/JSON与native一致、重放不新增。作者新两文件150项、原九文件加exact-real **349 passed/1个原confidence=inf警告/32.65s**。真实turso.Connection类+本机FakeSession覆盖十INSERT、四root跨scope、双根及health故障rollback；这不是实际Turso云写入或provider存储证明。冻结writer=`e5c0968cde88ffb26228ec7d1b12f4668973e0aaf49349dbb0618e2261362381`、test=`e2e8649ecc8cbf361dd8da484803eb32f37709c73bf668754bd13c357cfe8c76`、repo=`ec3498c3b09d19f424921785ed93094ffbd858c60418529ddcc5ca932c5e9257`。

根实际正常插件两分片全量 **3165=1583+1582 passed**，collection/三阶段/JUnit/全集分区通过，validation195503ms、总195823ms仍在300秒；3个warning为每进程各一次Starlette/httpx弃用及原负测。新外部parent仅由已读旧parent增加ExpectedTotal入参、新输出目录日期和持久保存前后default metadata，未改测试/observer/插件/预算。输出`fc-backend-two-shard-run-20261022-2de7fc3c7288498ea7d704beb6eb3d2b`，summary=`6dc07c805e59877544b0c0b38ee2f83513df76b673a7ea775f71bb1fbb62e9c4`，Python pins前后同=`2f40c30bca204d1d3e7f420f433a523918a3562d078883a6a595a4952f260fcb`，默认DB前后metadata精确同值、fallback未创建。不是Windows串行或新CI/云发布通过。Worker根实际 **144/3文件/1.15s**、check、既有CI同款dry-run 114.28KiB/gzip26.58KiB通过，未部署。

来源守卫先在旧实现复现13项失败，再修实际watchlist全部commit/Owner snapshot/迟到Gist消费：深冻结sourceKey+v1Raw+v2Raw，原raw保持v2兼容；任一槽读取失败拒绝，不空覆盖。每次已观察相关storage event使generation失效，含已观察ABA；v2存在时v1仅使旧上下文失效，不合并。live store一旦观察/创建v2，其删除保留最后接纳工作副本并failclosed，不复活v1；首次启动未观察v2仍历史fallback，不是跨重启保护或原子CAS。local_pending/tombstone/明确同意及unknown不重发不变。专项五文件 **227 passed**（含真实OwnerSyncPanel/HoldingEditor SFC）；独立三文件110通过。Gist后置guard不能撤回已发PATCH/helper已写元数据，不声称完整迁移。IDB权威切换、正常编辑API、导入/回滚UI、多设备仍待完成。

同机五轮交错AB合成组件基准，1000组/轮、每组十INSERT/164参数，wire float37→0；协议编译+编码+JSON median每组0.1856879→0.3069908ms（+65.33%，绝对+0.1213029ms），native准备0.0011115→0.0038278ms（+244.38%，绝对+0.0027163ms），两项相对20%组件预算均FAIL，不能报性能全绿。假想十操作frame raw17531→18560B（+5.87%），gzip1800→1812B（+0.67%），不是实际网络压缩/SQL执行；同宿主可能同时运行测试。原生运行仅保留于作者tool输出，`fc-v8-insert-perf-20261022-f4ea9c31/result.json`是手工转录/部分浮点简写的派生报告，不是原stdout字节证据；`PROVENANCE.md`明确其局限，旧文件未覆盖、不挑快样本重跑。源脚本=`4d3e8f162f1ab87573ab772b2f54ccbbd00e55fdb2cf6d0928f9a0b38da0d51c`、派生result=`667397f2ab51ecf5a5fea7771f3253c29b45eda6a5fbc284c65dccf0cf64c072`。I21应用性能门禁继续开放，不用微小绝对成本抹掉相对回退。

### 海外逐模型精度时钟及真实历史卡修复（2026-10-22）

公开产物审查发现既有P1：018147自身最近结算仍10-16，012920的10-21结算却推进pipeline全局时钟，原attachAccuracy把旧模型标为较新。先在旧码新增跨基金、跨版本及缺settled_at三项红测（3失败/9通过，原JSON保留），然后以同code/model_version、summary版本、未排除的observation-target-v2账本记录选自身有效时间；有样本仅settled_at，零样本仅自身observed_at。缺证据、无区/坏日期、重复producer身份、未来超过5分钟均未知，不回退采集/全局/候选registry时间；非有限、0/null和96小时边界保留。严格日期轴与producer/audit现有previous-trading-date合同一致，不泛化为其它HK/同日模型。真实当前公开artifact三基金有纯本地回归，不取外源或改金融产物/active。

独立审查又发现OutcomesPage实际精度卡绕开attach函数，故同时修`OverseasAccuracyPanel.vue`，与附件共用accuracyFreshness：显示各基金自身结算/预测时间和模型，缺失明确未知，过期/未知保留指标但标“历史指标，仅供回看”，不继续无提示显示高置信。30秒时钟与visibility恢复重核，卸载abort请求/清interval/移除监听，迟到响应不回填。真实SFC自定义renderer执行13项，utility52项；这是挂载组件证据，不是真实Chrome DOM/布局/旧PWA或物理设备证明。无modelVersion的动态/风格fallback不再借active样本；旧持久估值缓存精度刷新仍属后续I21边界，不以人工重复attach测试虚构生产调用。

作者前端全量1205/58文件、type-check/build/PWA通过；根对冻结源码独立串行执行同样 **1205 passed/58文件/3.51s**、type-check exit0、build **7.30s/PWA7/7** exit0，未改版本或发布。冻结utility=`e91ec317368ccd65d203bf4dee15d661a9fc6480a54787df8da72658de36186c`、utility test=`de8e4f4ed5b2822bf6c33dea80ad61718d16a2a654f59693f0b74f10ea108ed2`、panel=`9fdbac37c333217d31edab150d575ef05788fd963ab4347d757085f4f26bf620`、panel test=`ae14b67d760bd8de18454fa002869e4cc03704bb5542b8ffca968c72d35d1aa5`。数据可靠性审查推动了实际卡片接线，不只是新增未使用helper；整体I20/I21、真实云迁移/Owner闭环/耐久/恢复与正式v9仍未完成。

### 991d9ec 的自然 CI 与安全依赖阻断（2026-10-22）

上述十二文件已正常提交并推送`991d9ecd5045af2b25c63a836a088b54db013d1c`，tree=`3f98889d5f2255a6421e66a8fefbce61936a574a`。[CI 39713953842](https://github.com/AureliusWu/fund-compass/actions/runs/39713953842) attempt1 completed/success，updated_at=`2026-10-22T02:59:59Z`；四job实际checkout均`fc064695a4bc9f5d40813ae9495b46c0b86406b2`，父为f8d519a+991d9ec，tested/source/本地tree一致。后端3165/2warnings/153.56s，前端1205/58文件、类型/build7.48s/PWA7/7，Worker144/3文件/check/dry-run114.28KiB/gzip26.58KiB。deploy与两smoke均skipped/steps=[]，不代表上线。

原CI安装日志同时明确：frontend 2moderate+1high、Worker 2moderate；npm ci不因告警退出，故功能CI成功但安全审计非clean。终态后日志取证为独立有界阶段，不延长原测试预算；首次取证超时及同身份一次EOF补读均保留。两阶段51份原件seal独立重哈希无漂移，二级报告`fc-ci-39713953842-review-20261022-1c843feb/VERIFICATION_WITH_FINDINGS.ascii.json` SHA=`1a6990602a25afb243553199f3e9e91d2d29f25dc0639b370deaf09095bbab1b`。原件明确functional_verified=true、dependency_audit_clean=false、strict_release_gate=false，不把失败改成PASS。本轮只读ls-remote再次确认feature仍991d9ec/main仍f8d519a。

只读官方安全诊断核定前端Vite6.4.3须到6.4.5，不能停在有回植遗漏的6.4.4（[官方公告](https://github.com/vitejs/vite/security/advisories/GHSA-8g5g-mxqh-grgj)）；两端Vitest及mocker最低4.1.12（[mock注入](https://github.com/vitest-dev/vitest/security/advisories/GHSA-qxg6-89mg-rqv8)、[Windows路径穿越](https://github.com/vitest-dev/vitest/security/advisories/GHSA-xp26-3454-mjgp)）。默认镜像audit返回404 NOT_IMPLEMENTED，官方一次audit超时不作0漏洞；Worker正式audit原JSON准确返回两个moderate，原件SHA=`ee1bab81cdf97fb6fc4f4fa40c75116f6f2f5745b63e5bfaca2ace2b1f842a61`。另Miniflare精确pin的Undici7.29.1有官方已披露风险（[content-encoding DoS](https://github.com/nodejs/undici/security/advisories/GHSA-xjj6-f33q-929c)），npm尚未列不代表安全；它属于CLI/dev链，不等同于生产Worker npm runtime可利用，未经兼容验收不盲改override。

前端依赖最小补丁已在工作树：manifest下限Vite^6.4.5/Vitest^4.1.12；一次官方无脚本/无audit锁生成exit0/10.707s，只有Vite、Vitest及七个同系列包九entry变动，无增删/批量换registry。原授权npm ci实际exit0/22.753s，当前安装/正式及隐藏lock元数据一致；manifest=`0e2b54905692e56b38361cc752a9699bfaa7393865e58fa7307311274b1f344a`、lock=`7326739968484411a7c99c5a1c99e62864c0572355d17d5a543a9636626fd50d`。这些不认证tarball来源/完整包内容，补丁后的1205/type/build/audit尚未执行，不能沿用旧依赖的PASS。新包engine本身兼容CI Node20/22；完整既有图实际至少需frontend20.19/worker22.12，仍须实际CI精确运行时证明。

Worker仅manifest下限改为^4.1.12；锁生成监督脚本在CreateProcess前遭执行策略拒绝，npm未运行、lock/node_modules仍4.1.11。没有重试被拦截脚本、替代launcher或改权限/认证。已向用户请求是否允许受支持的直接npm方式，尚无确认；自动goal继续不是该确认。保留这个partial但不得提交/推送或宣称升级完成，无云修改、主分支推送或Gist删除。

在不触及该限制的源码工作中，补CI的显式dev安装与独立官方audit gate：中危以上、网络或2分钟step超时使受控仓库发布链失败，原type/test/build/dry-run不移除；不证明Render自动部署配置已改变。新增合约先实测1项失败（缺include=dev），修后工作流24项全部通过（1.02s，随后安装也显式include后的最终0.80s），独立只读审查无当前P0/P1。新gate/回归/依赖及本记录均仍未提交，不以静态合约测试冒充真实registry、完整新源码CI或正式v9发布；全部原v9范围继续保留。

### 用户授权直接 npm 后的补丁与真实验证（2026-10-22）

用户随后明确授权“允许使用直接 npm 方式继续，已给你完全访问权限”。本轮只用直接 npm/正常 session 继续，未重跑被拒的监督脚本、修改权限/认证或换凭据。Worker官方lock-only exit0/10s，首次ci exit0/7s；Vitest4.1.12重解算Vite8.3.5及其兼容Rolldown/PostCSS链，非安全必需升级的版本不冒称修复特定公告。独立审查确认最终159个lock entries无增删，根加28包变化，包含Vitest家族8包、Vite/Rolldown/oxc/PostCSS及15平台bindings、外部Undici；全部变包仍dev、平台约束/engine未提高，无批量registry替换。前端仍是此前九包最小补丁。正常插件工作流合约24项再次通过。

Miniflare的外部Undici限定父版本override至7.30.1；正式lock、隐藏lock与实际Miniflare入口解析一致，Wrangler4.149.0/Miniflare5.20261006.1-alpha本身未变。父包原来精确7.29.1，故不声称仅原声明范围内升级。先新增版本守卫实际红测1失败；尝试额外Wrangler精确祖先key时npm实际EOVERRIDE（直接依赖范围为^4.149.0），后续ci亦失败，均保留原工具输出，未视为PASS；撤回该祖先key而不改Wrangler范围后，直接lock-only/ci分别exit0/891ms和6s。仅保留精确Miniflare父级规则，并用测试固定实际两级父版本，后续父升级须重新审查。

新增真实本机Miniflare/workerd兼容测试：inline合成脚本、127.0.0.1随机端口、cf:false、无项目绑定/密钥，outbound handler拒绝外发。覆盖GET/POST与body/Response clone、单块stream、204、manual302及请求前已abort，finally等待dispose；不外推为在途取消、背压、任意Miniflare功能、全网络观测或云部署。首次按旧constructor形式执行确实失败（v5需workers/config），改用该包真实导出的convertV4MiniflareOptions后两项通过，未mock成PASS。随后Worker全量146通过，正式发布入口安全测试加入后最终 **148 passed/4文件/1.12s**；check exit0，dry-run仍 **114.28KiB/gzip26.58KiB**，未实际部署。worker manifest=`1ecbf6bb0b6d4679a7d8512454000137b66d26f421fed299872034bfe2baf981`、lock=`300a343eca15767eb0181dbfa43eefca8addf6b76777f0de25e9b3a291279f4e`。

官方registry audit两端实际exit0、vulnerabilities={}：frontend469依赖、Worker158依赖，均显式include=dev、moderate门槛、fetch-retries=0/fetch-timeout=20000。**安全门禁仍未关闭**：Wrangler自己bundle了Undici7.29.1，Cloudflare API及更新fetch实际使用该内嵌副本；Miniflare override不改bundle，audit0也不覆盖它。官方[7.30.1发行说明](https://github.com/nodejs/undici/releases/tag/v7.30.1)、[DoS公告](https://github.com/nodejs/undici/security/advisories/GHSA-xjj6-f33q-929c)与[TLS公告](https://github.com/nodejs/undici/security/advisories/GHSA-2m5v-pch6-74hx)仍作为未关闭风险依据。当前latest4.151.3/Cloudflare源码仍声明旧版，不能盲升或文本替换bundle冒充修复。受支持npm run deploy入口现于Git/Wrangler启动前固定BLOCKED，无环境/参数绕过；真实入口子进程测试exit1且固定安全错误，关闭须经审查已修可信上游制品和兼容证据后显式改源码。它不是所有CLI的系统封锁；README同时暂停带认证的secret put等网络操作示例。现有线上Worker未改，不能声称其业务runtime已运行npm Undici。

前端作者直接重跑新版依赖：**1205/58文件/5.06s**、type-check exit0，三次build均exit0/PWA7/7；根另独立重跑全量 **1205/58文件/5.38s**。Vite内部build耗时9.69/7.58/9.50s，median9.50/worst9.69，不含npm/PWA全程；对旧单样本7.30s方向增长30.14%超过20%回退线，未建立受控重复旧基线/未排除宿主并发，不能定因或报性能PASS。三次JS/CSS产物61文件完全一致，raw1,371,314/gzip488,548B、无map；与构建前遗留产物逐路径摘要相同，但该旧产物来源未独立绑定，不冒充严格AB。ECharts532,397B仍低于既有600kB告警线。原前端证据在工具stdout，未手排落盘或捏造独立原文件；不代表真实浏览器/PWA/线上性能通过。

根沿原已审查正常插件双分片方案、原300秒绝对预算实跑当前后端：**3166=1583+1583全部通过**，validation234960ms/total235405ms；完整collection、互斥并集、setup/call/teardown和JUnit逐项核对，source pins与默认DB metadata前后一致，两fallback均未创建。保留3个warning（两分片Starlette弃用与既有confidence=inf负例序列化），不改成零告警。证据`fc-backend-two-shard-run-20261022-4f65a2b57563487c8f2f5ce1bb79a9d8/summary.json` SHA=`c3755888a8ff2eab066e05bb3d268d8b602a387ff2ae1fd289275c7106380203`；不是Windows串行或云业务持久化证明。

上述是依赖安全局部修复与发布入口防误放行，不是完整v9。应用保持8.0.0；未push main、改云schema/Secret/套餐、重启服务或删Gist。I18迁移/凭据/耐久/独立恢复、完整I19业务闭环、自然任务与真实设备/性能出口继续未完成，不以本地测试或registry0替代正式发布资格。

### 52c3013 的自然 CI 终态（2026-10-22）

前述依赖补丁正常提交/推送为 `52c30139737841a55d069f0ccc4ed3b480b25417`，tree=`7ef690f776fb9974600e151e24cdcc372fe250cc`。[CI 39718529158](https://github.com/AureliusWu/fund-compass/actions/runs/39718529158) attempt1 completed/success，`2026-10-22T03:47:00Z` 更新。此前同身份正常读取的日志已核实际 checkout merge=`7e241c480daee74e28e435e192fcdbe8625ec57d`，parents=f8d519a+52c3013，tree 与源一致；backend **3166 passed/2 warnings/105.93s**（Python3.12.15/pip clean）、frontend **1205/58文件**/type/build7.70s/PWA7/7（Node20.20.2/npm10.8.2）、Worker **148/4文件**/check/dry-run114.28KiB/gzip26.58（Node22.23.3/npm10.9.9）。两端独立官方 audit0。原日志通过工具输出读取，未保存独立 seal 原件；一次 EOF、gh 缓存 zip 竞争和直接日志 GET EOF 保留为取证失败，不改称网络始终无错。本轮只读 metadata 再核四 job 成功、两端 install/audit 步骤成功及三发布 job skipped/steps=[]，不以 headSha 替代 tested merge。ls-remote 仍 feature=52c3013/main=f8d519a。没有部署、main 推送、PR403旁路或 Gist 删除。

### I19 真实本机权威编辑、备份复导与异常恢复切片（2026-10-22）

这次不再停留在候选存储 helper：真实自选页挂载本机工作区，实际 HoldingEditor、自选添加/删除、选基与详情关注均等待异步 writer 成功后再提示或关闭。固定 `owner-authority-1` 定位先于 LS/Gist 加载；本轮下载、重新选择同一完整 SHA 文件、全账户及删除项预览、明确确认后才显式启用。`adoptLocal` 自行解码两槽原文并校验备份 SHA，配合实际 source/memory/generation 守卫，不只信 UI seed。物理 v3 与原 outbox 共库，保留已有 slot/working/receipt，strict 事务核完整前像并一起更新业务、时间、最近本机回执和空槽 epoch；v3 新版存储路径禁止新 null→prepared，既有原包核回执/结束仍保留。后续云制包须另做同工作区原子设计，不能撤守卫换通过。

指针与工作区是两库提交，不声称跨库原子。active 按 locator 原 target existingOnly 打开；丢库/坏结构/端点变化不建新库、不回退归档。activating 只凭原文件/ID/target/adoption 核已保存结果，包含指针已 committed 但响应 unknown 的分支；不二次 adopt。真正关闭的 workspace handle 在手工核对时 existingOnly 重开，核原 adoption 与最近同版本 id/hash，只查询不重放；同 store 在途写互斥，不允许第二次写覆盖原标识。最近回执被后续写覆盖则 unknown，原标识仅本轮内存，刷新只读当前完整 active 状态，不冒称核定刷新前未知请求。seen hint 不是权威/数据库认证，不能证明全部站点数据清除后的身份。可选 BroadcastChannel 构造被拒不阻断 store，实际每操作仍核定位；迟到 Gist 响应在应用/本地 ack 前重核持久 authority，即使未送提示事件也拒绝，但不能撤回已经发出的远端 PATCH/helper 旧元数据。

备份只覆盖自选/账户持仓、实际 0/null、tombstone、pending 历史 flags、原时间或 null、两槽原文及复导档案；手工资产/组合历史未纳入，不是全应用备份。内部摘要覆盖全部业务/时间/档案，外部摘要绑定原始完整 UTF-8；不认证来源、不通用脱敏，原文可能包含任意私人内容，不公开上传。不读凭据键、认证元数据或 outbox，不等于保证档案任意字节无秘密。新封闭格式总上限24 MiB、最多8个复导档案，单 raw/entries 仍受原2 MiB限制；超限整批拒绝，不丢旧档案。相同 key 的业务或时间任一差异均 conflict；空/重复 no-op，不覆盖或复活。显式重新关注只能创建全金融字段 null 的 watch，不恢复旧 holding。IDB 整体始终云端未确认，保留的历史 pending=false 不释放 Home/Watch/Detail 行动门禁。

交叉审查修复了三个直接路由回归：Backtest 现在显式初始化，不再永远空快捷列表；Assets/Lookthrough 消费 load 拒绝并结束加载，未知不画作0或空组合。响应式当前权威还进入资产完整性/最终快照及穿透迟到结果检查，等待 detail/compute 时变 blocked 不产生新快照或新正常结果，保留已有 refs 并显示暂停。所有写失败 UI/通用错误不再保证“原记录未修改”，改为结果未核定/勿自动重试。沿用青绿/旧金/账本视觉，不新增主导航、外部字体或依赖。

根独立 compiled-SFC + 真 Pinia/store/codec/locator/fake-IDB 四条 journey 覆盖实际面板下载 Blob→真实 File 复选→启用、真实表单0份/0成本/null权重→dispose/reload仍用 IDB、旧备份与 tombstone 冲突且直接 store 同样拒绝、缺 active workspace 不重建、捕获编辑后下载再复导至全新合成 factory/空LS及重复幂等。适配 host renderer/download、合成本地端点指纹及 Vant 确认；无 business writer mock，fetch 全禁。它不是 Chrome DOM/真实磁盘保存/设备重启/旧 PWA/云端耐久或多设备证明，也不从这四条推导 unknown 已验收。另有真实关闭 handle/已提交指针丢响应、跨 store 陈旧前像、quota/abort/档案容量及 v2 保留、原包与生命周期回归。

保留诊断失败：初次整体1283项中2项旧 InputPrivacy 点击测试仍点 icon（非可访问按钮），修选择器后原隐私/0值断言保留；后续1323项中5项仍断言旧 storage 文案，改相应文案断言而保留全部数据不变检查。最终原生 JSON **1325 passed/65文件/0失败/0pending**，report跨度5194.917ms，正常 npm 命令7.039s exit0；`fc-i19-frontend-final4-20261022-96bc2e10.json` SHA=`7d2f0b79484825661a5b596a11ccaa09887a71af86b03903e8f2bc5c73fa7989`。生成组件声明后完整 type-check 再次 exit0。不是后端或生产验证的替代；本次未改 backend/worker/依赖。

#### 同机冻结源构建对照（不是浏览器性能验收）

基线为正常 `git archive 52c3013 frontend` 到唯一 Temp，未建 managed worktree/改现 checkout；正常 tar 解包并仅以 junction 共用当前相同依赖图。manifest/lock 的归档 LF 与工作文件 CRLF raw SHA 差异如实保留，normalized-LF SHA 与 JSON semantic SHA 同时一致才允许共享，不改源码换相同。首轮成功诊断构建触发生成的 components.d.ts：基线 CRLF→LF、当前多一个 OwnerWorkspacePanel 声明，初始 source pin 拒绝测量；一次错误 EOL 假设也拒绝，均保留原失败及原冻结文件，没有放宽任意源码漂移。逐字验证仅这两项生成变化后新冻结，再做下面六次独立直接 `npm run build`（无自建 npm launcher/supervisor、timeout/kill）。原3次诊断8.50/6.43/6.61s不混作新冻结样本，也不隐去。

顺序 A/B/B/A/A/B，A=52c3013归档、B=当前；每侧3样本、每次exit0/PWA7/7，source前后固定，各侧全部 JS/CSS/HTML 字节和摘要3次一致，无map。Vite内部 A=6.71/6.56/6.53s，B=6.90/6.71/6.54s；直接单次完结命令的工具观察全程（含PWA/进程开销）A=10.7318403/10.4912049/10.2827603s，B=10.6571363/10.7210168/10.3259439s。不是用户页面延迟；两源码位于不同本机目录，文本checkout EOL及宿主缓存/背景负载并非完全控制，小样本仅方向性。

| 指标/方法 | 基线 | 当前 | 变化 | 预算与结论 |
| --- | ---: | ---: | ---: | --- |
| Vite内部秒，median / worst，n=3/侧 | 6.56 / 6.71 | 6.71 / 6.90 | median +2.29% | 20%线内；仅构建指标 |
| 工具观察整条build秒，median / worst | 10.491 / 10.732 | 10.657 / 10.721 | median +1.58% | 20%线内；非浏览器 |
| 全JS+CSS产物raw字节，含SW/registrar、不含data/map | 1,401,273 | 1,489,486 | +6.30% | 20%线内 |
| 同产物gzip9字节（非实际传输） | 498,292 | 524,433 | +5.25% | 20%线内 |
| 自选页自身JS gzip9（非完整路由依赖闭包） | 20,277 | 25,865 | +27.56% | **局部20%回退线 FAIL** |
| 自选页自身JS+CSS gzip9 | 24,688 | 30,971 | +25.45% | **局部回退，不能报全绿** |

主要增长来源：自选页新增完整工作区 UI/预览；共享 watchlist/固定定位校验进入主 chunk；新增工作区事务与备份 codec 动态块。ECharts仍532397B，低于600kB告警线；ownerSession已有静态消费，新增动态 import不能另拆chunk，Vite提示保留。最小后续优化方向为把展开后的重UI/codec继续按操作懒加载、精简共享定位依赖但保留每操作持久校验、再以实际浏览器冷热及操作五样本核完整路由/请求/主线程。不能用全产物+5.25%掩盖局部回退，也不能靠移除校验换性能成功，I21继续开放。

纯统计 helper 不启动子进程/联网/安装/构建，只有 setup 校验与本地junction、冻结、产物统计及新文件机械报告。它核HTML本地链接、manifest icons、每个precache URL/非null MD5和Workbox引用，非全部JS动态导入AST闭包；三次各侧PWA制品独立7/7。证据目录 `fc-i19-build-perf-20261022-7ef0beba85ad4cf8be4069df8e3165a8`；helper SHA=`bf844ac9278b6c691001b192a1edffe133843b1a0b15adf4afc5672648291c18`，机械 artifact-summary=`96c79bcf1412a0f539de9da551cf3617584345fbd60fff53c0e983e5e7c5e2f4`，其中六份样本根另重哈希无漂移；冻结当前frontend输入 pin=`ab9ef10420c15e18ac548af1c7c85e6b53b52bbcdaf6233cdf905250992d7408`。原build stdout/时长在工具结果，未手工伪造为原始落盘日志。

以上推进 I19-01/03 局部真实接线，不关闭整个 I18/I19/I21：未做真实云 repair/migration/credential rotation/Owner事务、Holding/Policy/Decision新链、手工资产/历史同步、机器消费者迁移、真实浏览器旧PWA/跨设备、重启读回/独立远端恢复或正式发布。Wrangler内嵌安全阻断仍在。应用保持8.0.0，未推main、改云配置/套餐/秘密、重启或删除Gist；完整v9目标继续。

### 精确迁移前后像与独立 repair+scope+Owner 包（2026-10-22）

用户允许后继续使用直接普通 npm；没有启用旧 npm supervisor、绕过 OAuth 来源校验或重试被阻断的浏览器路线。本轮没有收到平台凭据已保存的确认，不读取凭据输入文件、不调用实际云库。只完成下一段迁移代码及本地验证，不升级应用版本或放行云应用。

旧 scope packet 的 `_row_guards` 发现与 writer 相同的 JSON REAL 传参精度风险。现仅在固定 VALUES 值槽使用整数 mantissa/二次幂表达式，NULL/int/text/blob 类型与 NUL 后字节保持；负零比较使用固定 `(-0.0)` literal，generic exact_real helper 仍拒负零，不声称 REAL 落盘保留其符号。`exact_real.py` 纳入 compiler 源码指纹，原 `_wire`、严格 v1 admission/profile 和 sender 权限均未放宽。旧 v1 capability 仍需 provider 保留 JSON ±0 参数并支持 atan2，不以比较修复冒称能力通过。

新 `database/turso_owner_upgrade_packet.py` 是独立、显式 repair profile，不复用旧 scope-only 回执槽或 `synthetic_candidate=True`。先从原始私有捕获独立 plan repair SHA，编译时必须给出原 SHA 并重新推导；只承认 Evidence estimate/estimate_coverage 恰1 ULP 的有限 REAL 差异，至少一格需修复，NULL/类型/负零/更大偏差仍拒绝。原 payload/ID/hash 不改。固定 BEGIN IMMEDIATE 内先核 raw schema/完整 typed 原像/header 0或8/槽位为空，再暂移唯一固定 Evidence UPDATE trigger、精确修复并核 changes=1、立即用仓库固定 DDL 恢复，随后 scope 回填、Owner 五表与 revision0、schema-table8→9、完整后像和十列回执同事务提交；任一失败前缀回滚 DDL/业务/回执。远端 PRAGMA header 不改，源与后像均以固定只读 `pragma_user_version` 核验；该 table-valued PRAGMA 的实际 provider 能力尚未验收，失败即停止，不降级省略。

raw DDL 从不执行；目标仅对实际移除/重建的该 trigger 采用规范拼写，其余已有 raw 对象逐字保留并显式绑定目标摘要。完整原始行、修复差异、修复行、目标 raw schema/回执插入前全行、资源/源码、外部 repair/plan/packet SHA 均绑定。独立复审先真实复现4项可被重新构造的摘要事实和 header 漂移问题，后关闭：公开 counts/raw schema/trigger flag 与真实 specs、repair frame、plan frame、十列 receipt 交叉核对，constructor/getter/plan/compile/rehydrate 成功前再次核源码指纹。重建有跨验证/重编译的30秒协作总预算，不能每阶段续期；不是硬实时终止。所有远端/正式旗标仍 false。

新测试最终 **67 passed/19.56s/exit0**（正常 pytest 插件，显式清空项目静默 addopts 只为打印汇总，不改测试选择）。覆盖所有实际 statement index 故障前缀（包括重复 label 的后像）、修复/Owner/回执/commit 回滚、晚期业务/回执/Owner/scope/Evidence/Header 漂移、0/null/typed 行、完整捕获不变、独立 repair pin、原包重建、篡改摘要/原包、源码末尾漂移、总预算超时；fake monotonic 无 sleep、不绕过原验证。测试 SHA=`1536de19caf65e0606d23bff1feecf9ac4186d1cd2e1cb1966f575ea0c6eec69`，compiler=`69d00c01e4afab85f90d6f5ee4163f98ebd7875c6fa9367f0fc228417caf1195`。

精确 guard 新测试46项，连旧 packet/exact-real首轮 **286 passed/10.53s**。扩展链首两轮分别315 passed/333 setup errors、467 passed/181 setup errors，均为三个已有 fixture 的旧 compiler 固定源码 pin；只在审查允许后同步实际 LF 源码 SHA，不删业务断言、不改历史日志。最终 packet/exact-real/response/reconcile/transport 六文件 **648 passed/137.27s/exit0**。旧 compiler 新 SHA=`5d37c2df98a73ec4fdda654adffb876b14bedd1e67a800cad4a95d886fa73fae`，精确 guard 测试=`e677308d59bc516865a91539a49c2eeda578574d22d503d159b63d02cce6ce43`。

直接 `npm run test -- --run` 前端 **1325 passed/65文件/9.09s**；`npm run type-check` exit0；`npm run build` exit0/Vite13.21s/PWA7/7。ownerSession 静态/动态重复导入提示仍保留，单次有其它测试负载的构建不作性能对照，不关闭此前局部 chunk 回退。Worker直接 test **148 passed/4文件/6.12s**，check exit0；本轮未改前端/Worker/依赖、不运行带认证的 Wrangler 操作。

新编译链无旧版本同功能基线，另以同 Windows/Python3.12.13 正常 `python -c` 做3次独立合成内存样本：每次5000总行，其中4995条窄 funds 行、2修复格。plan 秒为0.543692/0.498443/0.578492（median0.543692、worst0.578492），compile0.921182/1.067130/0.930973（median0.930973、worst1.067130）。每包2,063,514字节/165steps/maxargs900，固定64MiB/16384steps/30秒/900args不变；额外 safe_metadata median0.251421/worst0.264468秒。原始 metrics 仅工具 stdout，未封存报告；进程通常导入缓存未禁写，不能宣称全进程零文件写入。没有执行这些样本包，不代表约34k行实际业务、远端事务容量/时长、网络或回归 PASS；宿主背景负载未完全控制。

正常插件两分片后端全量 **3279=1640+1639 passed**，原300秒绝对预算不变，validation210300ms/总210698ms，collection/完整全集分区/三阶段/JUnit均通过，源码pins与默认DB metadata前后相同、fallback未创建。根独立再核 Ordinal 全集无重叠/遗漏、9837个setup/call/teardown全部passed及无skip/xfail/deselected。输出目录 `fc-backend-two-shard-run-20261022-e02d93263e82459a9103f10948303b8c`，summary SHA=`588e5439a98f2353d7c6862b02729d7f06312326f4813b7eebb7d02944a8cd18`。这是正常插件合成全量，不是Windows串行、云业务或新CI证明。前端/Worker另以普通 `npm audit --include=dev --audit-level=moderate --registry=https://registry.npmjs.org` 各实际返回0漏洞/exit0；仍不认证 Wrangler 内嵌代码。

下一道实际门禁仍包括新 profile 的响应与未知提交完整对账、受控 sender 接线；优先复用已有固定私有 parser/FSM/完整image核而不放宽旧 public packet 类型/profile，完整读回必须同时核原 header、修复Evidence、全部旧表、scope、Owner与十列回执。实际所有 writer 停写/排空、Free配额/Overages、新保护备份、实际 provider 精度/能力/容量、迁移、应用写入→Render重启读回及独立远端恢复仍缺。I19 同工作区原子制包/ack、完整业务链与迁移、I20 自然窗口、I21 实机/PWA/性能亦未完成。不能将本地包或旧 transport 的通过记成云 apply、正式迁移或 v9 发布。

### 新升级 profile 的响应、完整对账与单次 HTTP 接线（2026-10-22）

前一切片已正常提交/推送 `518c576ac6a672954c33387387ea2019300a3d4a`，tree=`d9ead13449dd4229624d1ecb2381af64c46aa8c7`。[CI39727018903](https://github.com/AureliusWu/fund-compass/actions/runs/39727018903) attempt1 success、05:19:01Z完成；此前正常日志已核 backend3279/2warnings/161.64s、frontend1325/65文件/type/build6.57s/PWA7/7、Worker148/4文件/check/dry-run114.28KiB/gzip26.58，两个独立audit步骤成功。实际checkout merge=`a2f191a67689334fad8fc5e195c86c4593ab74e2`，parents=f8d519a+518c576，GitHub commit API核tree与feature一致。deploy/candidate_smoke/formal_smoke均skipped/steps=[]，不是发布。一次并行读取backend日志的CLI缓存EOF，经同接入普通串行读取成功；本轮再次只读metadata也遇EOF，不将该取证失败记成新失败或新成功，不重跑工作流、不换认证。原始日志只通过工具读取，未封存独立原件。

新增三个独立模块和对应测试，旧 public packet 类型/profile 与源码 pin 不变，不把新包伪装成 scope-only：

- `turso_owner_upgrade_response.py` 仅由新 compiler 原始三 SHA 重建准入，复用原固定私有 JSON/FSM；独立闭集 DTO 公开自己的 parser/compiler/sourcegraph SHA。完整状态机才允许 commit/not-started/rollback acknowledged，所有 remote/apply/restore/formal/retry 仍false，ack不是云提交或耐久证明。
- `turso_owner_upgrade_reconcile.py` 从同一个原始 schema8 捕获重新推导完整目标。schema8分支只有全原像+空槽才missing；schema9分支完整核修复Evidence、所有旧表/typed值、scope、Owner五表初始revision0、原header0或8和十列回执。额外空的固定schema仅用于发现SQLite INTEGER PRIMARY KEY alias的真实列名，不执行输入DDL。所有SELECT在一个固定BEGIN/COMMIT读计划，不自动切schema/发送/回放。此为停写迁移窗口对账，不代替恢复业务写入后的独立持久性验收。
- `turso_owner_upgrade_transport.py` 提供显式单次真实HTTP能力，复用原TLS/禁环境凭据/禁redirect/retry/有界stream/cleanup物理核，外层绑定新compiler/response/reconcile及共享核的源码图和原总预算。构造、源码检查不枚举或读取凭据。401/403/429、断流、清理失败等均unknown/STOP；无自动读回或第二POST。流中源码变化在返回前拒绝，但不能撤回已发出的第一请求；每调用once不是永久去重。没有CLI或应用默认路由，不代表本轮调用了云库。

独立审查实际复现并关闭四个边界：DTO在values之后才起timer导致31秒前段可返回成功；unknown权限DTO未核source；一次已绑定compiler_code_drift被后来健康读取洗成generic verification_failed并保留identity；权限错误后时钟NaN引起二次DTO构造异常。现在所有DTO校验前起timer，constructor/getter核源码；已观察identity/origin/code失败永久撤销输入资格，不凭后来的健康读取恢复。有限外层超时仍保留已绑定permission_stop；时钟本身不可信只能读出无身份/session/permission资格的unknown/time_limit，仍不可重试；source漂移只允许无资格code_drift诊断可读。原30秒为全流程协作预算，不是硬进程/云寿命保证。

本地正常插件专项最终：response **128 passed/130.71s**，包含每个真实SQL故障前缀和每次原包重编译（该单循环48.90s，不是stub准入）；transport最终source新进程重跑 **68 passed/33.50s**。reconcile修补前176通过/225.18s、补丁后40个定向passed/4.11s与174deselected如实分开；根随后对最终文件直接全量 **214 passed/202.48s**，无deselected，JUnit=`fc-owner-upgrade-reconcile-final-20261022-root.xml` SHA=`6731b2edb540942039398646f0674af659fce65e5151643997346a1747cb5839`。新增合计410项；当前完整收集 **3689**，不是新全量执行PASS。本轮没有重跑或放宽原300秒本机两分片parent；全项目将由正常CI验证，不以拆分专题替代总量。源/测试6文件hash在根测试及容量采样前后完全一致，默认DB元数据仍4149248B/2026-08-28T07:00:02.5969445Z/Archive。

最终模块SHA：response=`39ad7b0847b20630254b1d4f0d9440e55cabceebbeba739969bc72af09a82777`、reconcile=`b4c8c978173269c0eabce5d87b3764ef96f56b9a28a70a928d8062e717dd9420`、transport=`8e8fbc3b669091c6274a83c0e27569334e29c7dda6d5dc5b5c7dfab0ba5cf2c9`。对应测试SHA分别`7e9302c9c1b9841bdaf3ea04bf4baac1ca83fd6cb2471ad81d64c1e02a5e51b1`、`398743342e562b0f84b906606aceea287d6937efcb9d587773aa6f6f2e2d3803`、`e869c99b1398d7e07f94b342da8ebd94170717987a0dfdb7151258a46ef61b8d`。所有数据均合成；无私有备份/凭据文件读取或实际云访问。

按性能检查做3次独立5000总行合成内存样本（4995窄funds、2修复格）；普通Python-B，不用自制npm launcher。每次固定读请求9406B、提供的完整读回819981B；编译包在本机SQLite真实执行后才生成读回，并另用真实本机执行生成ACK输入。结果均matched/commit_acknowledged且远端/重试旗标false，原source/capture镜像未变。

| 本机组件秒，n=3 | 样本1 / 2 / 3 | median / worst |
| --- | --- | --- |
| 完整读计划构建（含重建/目标推导） | 1.810792 / 1.870864 / 1.866754 | 1.866754 / 1.870864 |
| 本机SQLite读与JSON编码 | 0.023306 / 0.031711 / 0.035242 | 0.031711 / 0.035242 |
| 完整读回核验含公开getter | 2.131159 / 2.101555 / 2.117306 | 2.117306 / 2.131159 |
| ACK响应核验含公开getter | 1.389023 / 1.412035 / 1.430776 | 1.412035 / 1.430776 |

无旧版本同功能基线，原30秒/64MiB/100000行/16384steps界限不改；只说明该窄合成样本在组件预算内，不判回归PASS。原始metrics仅工具stdout、无封存报告，不是HTTP/TLS或约34k行真实业务容量、网络吞吐、冷热浏览器/用户交互或I21性能出口。完整核对构建+核验约4秒，是维护工具计算而非现有用户API热延迟；主要成本是重复完整重建/typed行摘要/源码graph与JSON检查，后续不能靠省略这些合同或提高上限换性能。

下一道云门禁仍需实际writer库存/停写排空、Free配额/Overages与新保护备份、真实provider数学/pragma/TEMP/事务容量、受控原包应用、同应用写入→Render重启读回及独立远端恢复。未收到新平台输入已保存的确认，不重试被阻断的OAuth/浏览器路线、不读取其输入文件，不改套餐/秘密/部署/重启、不推main或删除Gist。I19同工作区原子制包/ack与业务链、手工资产/历史/机器消费者迁移，I20自然窗口、I21实机/PWA/回退预算继续未完成；应用仍8.0.0，不将本轮局部闭环或旧CI记作v9发布。

### a51940d 自然 CI 与 I19 共同基线/同库制包（2026-10-22）

上述新 profile 已正常提交/推送 `a51940d5a29d08aac1589b782bedab5b296f40d4`，tree=`5619c21facf83767fb9989398e632755070e50f0`。[CI 39729754055](https://github.com/AureliusWu/fund-compass/actions/runs/39729754055) attempt1 completed/success，updated_at=`2026-10-22T05:48:15Z`；实际测试 merge=`4c75f3cb33d0fc454858a8ba10508743bd040632`，父为 f8d519a+a51940d，GitHub commit API 独立核 tree 与 feature 完全一致。正常串行读取真实日志：后端 **3689 passed/2 warnings/200.16s**、pip check clean；前端 **1325 passed**、type/build7.39s/PWA7/7；Worker **148 passed**、check/dry-run114.28KiB/gzip26.58，两端 install 与独立 audit 均成功。deploy/candidate_smoke/formal_smoke 全 skipped/step_count0，main/线上均未变，不把这个真实全量 CI 扩大为部署或新工作树通过。

当前新 I19 片段先修共同云基线缺口，而非解除 IDB 上传守卫：保存已实际应用的 B，严格从 B→L 推本机意图；新观察 C 不能改写 B 或把所有旧本机字段变成覆盖意图。完整基线保留 manual_asset、墓碑、field/lifecycle/record revision；max=head/闭集/2MiB 只拒明显不完整 DTO，不认证分页来源、服务身份或云耐久。普通更新只携带实际变化字段旧值及 kind/deleted 守卫，删除/类型变更携带完整旧像；缺已链接基金行全批拒绝、不制造 delete，墓碑不自动复活，0/null 与原本机值保留，200 条/128KiB 最终原包限制不变。初次关联仅接同 key 业务全等或云端独有基金，差异拒绝整批；manual 留完整 B、不冒称已导入旧手工资产。

物理 v4 是独立显式调用入口，仅升级原 target 已采用且空槽的完整 v3，保留原四 store 并加 sync_metadata/current。默认启动仍 v3；完整已有 v4 可 existingOnly 重开，丢库/缺 current/坏结构不修复或回退。versionchange 与 strict 初始化仍两次提交，故障回归实际留下 v4/空 metadata 时固定拒绝，不把升级称跨提交原子。所有实际本机编辑/复导的完整 local state 新含 sync 元数据；独立 epoch 与 full base/archives/adoption/slot/receipt-count 均入最终前像，旧 local 请求不能跨新基线或换包继续写。

prepare 在事务外重推真实 B→L、严格构造/恢复原包和摘要；最终同库 strict 事务核完整前像/当前 guard 后一起写 prepared 原字节与绑定。v4 旧 outbox 全部 CAS 拒绝，不能用 legacy prepare/clear/resendUnknown 旁路；所有 pending 阻实际本机 writer。cancel 只允许原 id/hash、prepared 尚未发送槽，同事务清包/绑定并保存本机回执；本机丢响应只显式核原请求，不重做或把缺回执当回滚。重载由原 epoch/slot 还原完整制包前 envelope 并核原 preparationHash、requestHash/expected_revision 和完整 preimageHash，不重新制包/换原字节；这些 SHA 仍不是认证或防任意 raw-JS 全重封。发送/完整拉取后 ack 尚未实现，不接新 UI、会话控制器、main Turso 或云写。

独立审查实际发现并关闭：初次 context 把含 resourceFingerprint 的三字段 SlotRow 交给严格两字段 codec，23 个新 IDB 用例失败，改显式投影后通过；只核本机像会遗漏 slot+pending 同时替换原包，现完整 envelope 复核拒绝；packet.request 的 JS -0 与原 JSON 恢复的 +0 会造成原 hash 自不一致，制包先恢复为 wire DTO 再哈希，B/L 不归一化，实际 legacy '-0'→编辑 null 及新 -0 值的 IDB 重开/原回执通过。首次 npm 误在仓库根执行而 ENOENT，未运行测试，随后在 frontend 正常执行；不把错误调用记成 PASS。

合成 IDB 测试覆盖实际升级缺项窗口、两 handle 制包/关联竞争、同 epoch 异基线的陈旧实际编辑、真实 put 后 abort、提交后 close/丢响应、原包双槽替换及负零。另以真实 Pinia/watchlist/locator/backup 流程预置显式 v4 后做四条旅程：dispose/reload 原 target、真实 saveHolding/remove/备份复导保留 B/epoch/null 时间，prepared 阻实际 writer，缺 sync metadata 时 blocked 且不读取 LS 业务/不重建。业务 writer 未 mock、fetch 禁止；这不是 Chrome DOM/真实下载、已装旧 PWA、多设备或远端持久性证明。

共同 storage codec 的独立红测确实复现 **15 失败/5 通过**（只选新增组，48 原测试未选）：旧 Object.keys 闭集会接纳 getter、隐藏/symbol/特殊 prototype 字段，计数也接纳 -0。现拒非原生闭合 data object/descriptor、计数拒 -0；root 在 localState 进入 rowShape 前也先核 entry 闭集，不先执行 getter 再规范化。null-prototype 合法合同保留；尾换行原本实际已拒绝，仅统一正则与补负测，不称其为旧漏洞。红/绿原生 JSON SHA 分别 `545857aa4fd7d6bf612fc5c0a090ce2a6f042055a4613f865ff91262733a2126` / `78888ed0e50b43b73f808190114c23a354bd36f825d0dbf8120ed8e9e6100864`。最终 codec/outbox/workspace 四文件 **316 passed**；pure planner55、v4实际库42、真实Store4专项亦通过。root 对最终源码再直接 `npm test` 全量 **1596 passed/69文件/6.52s**，`npm run type-check` exit0。前端官方 `npm audit --include=dev --audit-level=moderate --registry=https://registry.npmjs.org --fetch-retries=0 --fetch-timeout=20000` 实际0漏洞/exit0，依赖未改；不扩大为 Wrangler 内嵌风险已关闭。

#### 当前片段同机五样本构建与包体对照

普通 `git archive HEAD frontend` 将 a51940d 保存为唯一 Temp ZIP，再正常 Expand-Archive；只建立 junction 共用同一 node_modules。package/lock 的 normalized-LF 字节和 JSON 语义同时一致，保留原 raw EOL 差异。首轮诊断 build（当前10.26s/基线9.75s）在最后修补前，不混入新冻结样本。全部 source/生成声明稳定后冻结，再按 A/B/B/A/A/B/B/A/A/B 做十次独立直接 `npm run build`；无 npm launcher/supervisor/kill/自动重试，每次 exit0/PWA7/7。计量 helper 仅核文件/生成新报告，不启动子进程；是前次统计 helper 的机械副本，更新基线、样本序列及冻结文件，不是换 npm 路线。

| 本地构建/制品指标 | A：a51940d | B：当前片段 | 结论 |
| --- | ---: | ---: | --- |
| Vite 内部秒，p50/p95（nearest-rank，n=5/侧） | 7.86 / 8.26 | 7.72 / 8.18 | median -1.78%，不是用户冷热延迟 |
| 工具等待全命令秒，p50/p95 | 12.807 / 12.868 | 11.669 / 12.217 | 包含 npm/PWA/进程等待，不认证真实墙钟或网络 |
| JS+CSS raw 字节，含SW/不含data/map | 1,489,486 | 1,510,734 | +1.43% |
| 同制品 gzip9 字节（非实际传输） | 524,443 | 529,617 | +0.99% |
| owner-workspace 自身 JS raw/gzip9 | 27,552 / 7,787 | 48,346 / 12,785 | gzip **+64.18%，局部20%回退线 FAIL** |
| WatchlistPage 自身 JS raw/gzip9 | 72,809 / 25,869 | 72,809 / 25,863 | 本片段 raw 不增，不抹掉前次对52c3013的局部回退 |

每侧五次 JS/CSS/HTML 和 PWA 引用/MD5 制品均逐字稳定，source 前后无漂移、无 map；ECharts532397B仍低于既有600kB线，ownerSession静态/动态重复提示保留。新增共同基线验证/制包逻辑进入已按操作加载的 workspace 块，造成该块明显增长；应后续将受控云操作/codec继续按功能懒载并复测，不能靠移除完整校验换PASS。整体小增长和构建中位数不退化不能掩盖该局部FAIL；不同目录/checkout EOL、宿主缓存/背景负载仍非完全控制，没有真实浏览器 warm/cold/API/5次用户交互或 I21 出口证明。

证据目录 `fc-i19-v4-build-20261022-cbbbaa07fe5b4ec889062d1c206bb60a`，helper SHA=`1563d3b27b9e194023c0e2cd496aaadb70876911ff1cd85aff678fdd3fa29528`；完整 frozen-file=`79c2e96e1242599c4d5b2b66779233c9ae14b6864ce88c59ea68f3cacb4a1cd2`，当前 frontend source aggregate=`b648db73f70c5d40a91e276db2ca4904846acdfd2da504dbf7a732fb8da14cac`；artifact-summary=`b5b29d8f1b64d46094892449ea473b277f40311a46a6e413b2823f9db3f42dcb`。根独立重哈希十份机械报告及 frozen pin 一致；原始 npm stdout/耗时来自直接工具记录，不伪造为封存原件或把报告 SHA 称来源认证。

本片段仍只闭合本机共同基线/原子 prepare/cancel，不是整个 I19 出口。下一步是受控原包状态迁移/单次发送、当前会话核原回执、完整固定 upper 拉取与三方合入/ack 同库提交、真实 UI/同意接线；成功 POST 只有批次记录，不得拼接旧 B 冒充完整新基线。所有 IDB 当前仍云端未确认；I18 实际迁移/轮换/停写/耐久/恢复、I19业务版本/手工资产/历史/机器消费者、I20自然窗口和I21实机/PWA/性能尚未关闭。未读凭据输入、不绕 OAuth/浏览器限制、不改云套餐/秘密/部署/重启、main 或 Gist；应用保持8.0.0。
