# 完整机器缓存准备候选

这是显式Worker/Admin操作，不是启动迁移、Cron附带请求或Turso运行时；应用仍8.0.0。它解决完整候选库中缺失/过期的公共详情缓存前置，不生成Evidence、Holding、Decision或通知，不放宽原machine profile、来源与行情资格守卫。

## 操作合同

`POST /api/v2/worker/portfolio/cache/prepare` 接原request_id、当前北京occurrence_date、worker_build_sha、expected_revision/source_hash/policy_version和显式原生整数request_budget=100。正文原16KiB，拒重复键、未知字段、客户端codes/持仓/缓存、bool或float预算。SHA绑定原UTF-8正文，不能用重序列化替换原包。

`GET /api/v2/worker/portfolio/cache/requests/{request_id}?occurrence_date=YYYY-MM-DD&request_hash=<原正文SHA>` 仅核原结果；缺失404不是回滚或重试许可。准备时间不要求14:30窗口，但必须是当日和实际已生效Policy，不能由预热操作取得发送权。

同一caller连接分三阶段：

1. 只读事务核完整已确认Owner来源（包括全部账户、manual/tombstone及typed数值）和当前Policy，从服务端取完整1..100 codes；核原批次回执、全部详情/历史/type缓存的完整有界前像。已有12小时内且完整有效的缓存原样复用，不修改其updated_at。
2. 事务已结束后，固定主源 `https://fund.eastmoney.com/pingzhongdata/{code}.js` 读取必要代码。每code至多1次GET、单次显式100请求预算、并发最多4、全流程共享原30秒协作预算；每请求有8秒绝对检查点和短socket超时，headers/有界正文/解析均计入。不使用legacy fetch_detail的自动fallback、取名估值或隐式重试链。
3. 原连接BEGIN IMMEDIATE重新核当日、完整source/Policy和原缓存前像；全部候选先验证，再原子保存全部缓存及原批次不可变receipt。仅对本次抓取代码显式替换公共nav_history为已验证来源的精确日期集合（最多800条），不与旧缓存做union以保留来源已撤回日期。复用代码及其它代码不改，immutable业务快照不改。任一失败整批回滚，包含DELETE后异常也恢复完整旧缓存；较新缓存不能被迟到请求覆盖。原已完成source观察时刻写入updated_at，不用提交时间给它续鲜。

## 上游与数据保护

- 默认reader是固定HTTPS匿名主源，redirect/压缩未知、坏正文、超4MiB、错基金身份、重复赋值/JSON键或无净值均拒绝。不读环境凭据、不保持Cookie、不换身份或回退其它源；401/403/429整批停止新请求。最多3个已在途的其它公共读取不能撤回，其结果没有SQL能力，晚到不能写库。30秒是协作预算，不声称硬终止任意Python/socket。
- JS仅提取固定赋值并用严格JSON解析，不执行源代码。全部历史时序须唯一递增，最新NAV与末行一致、正数且日期不在未来/超7天；原800条保留上限不变，不把多年合法历史剪成7天。未知日收益使累计收益保持null，不按0补齐；真实0费率/收益/经理ID保持0语义。
- 源观察时间必须有时区、未在未来；可选金额/收益必须原生有限数值，结构与字段闭集有界。旧过大/非文本funds.type和不可界定的原缓存不归一化为null来绕前像；它们仍需独立核对，不在准备中盲修未知原数据。
- 使用既有immutable journal observation kind中的独立 `owner-machine-cache-receipt-1` 文档，不加DDL或对象/容量预算。只读历史回执核原production Policy与时序，不拿当前source/Policy/cache替换原事实；它不是自然任务成功或当前缓存新鲜证明。
- commit/close/响应丢失或提交后撤销只能保留原id/hash核回执，不自动重发/换id或以receipt缺失证明未提交。默认collector可被内部owned测试注入，不开放为HTTP客户端能力。

## 验证与资格

测试使用隔离本地完整machine库、owned HTTP loopback、合成公开数据；覆盖默认collector真实100代码完整抓取、并发/请求预算、原子回执、丢ACK、完整来源与缓存前像变化、Policy生效/跨日、授权撤销、坏/缺/零/过期/未来数据。loopback只桥接固定HTTPS逻辑origin，不证明真实TLS、上游格式/配额、实际Turso、云耐久/恢复或生产自然运行。

2026-10-30另对公开510300做了只读功能样本：真实默认主源reader取得800条保留历史、最新净值日2026-10-29；同供应商独立正式净值API对照同日同值，没有写库。这不是独立机构认证、全部基金源稳定性或100请求配额许可。原样本/本地分冷暖计时见[MACHINE-PROFILE-CACHE-VALIDATION-20261030.json](MACHINE-PROFILE-CACHE-VALIDATION-20261030.json)。

该操作预算独立于Worker原34次行情预算；本轮不默认启用Worker或生产预热，不宣称100请求额度已获provider许可。实际云准备、停写/备份/迁移、旧Gist发送状态、真实自然周期和恢复门禁仍分别待验收。
