# 完整机器 profile 的独立增量包候选

应用版本仍8.0.0。本模块不启用main/Turso，不提供迁移发送器、凭据发现、自动DDL、生产切换或重试。

`database/turso_machine_upgrade.py` 只把显式、完整的 **core schema-table9 + Owner-only** 原快照编译为一次有界条件Hrana batch，追加现有analysis三表/六个不可变trigger、machine journal/两个不可变trigger及固定marker。不是旧schema8的initialize，也没有扩大旧scope/Owner repair packet、capture、parser或固定pins。旧schema8、部分扩展、未知对象、接受验收scope的数据库均拒绝。

## 显式输入与可调用入口

输入是调用者已拥有的原生`sqlite3.Connection`：没有活动事务、attach或临时对象，已设置`query_only=1`和`foreign_keys=1`。模块不打开文件或URL。若调用者来自文件，该文件必须是受控停写后的独立原始快照；调用者自行负责保护文件与身份，并以独立保留的原字节身份传入，不能把函数自己计算的摘要当外部来源认证。

编译器只在确认原连接idle后自有BEGIN只读快照，先固定schema读快照，再核页数/页尺寸、序列化原像和末尾复核，finally只ROLLBACK自己开启的read事务；拒绝并保留调用者原有事务。这样页数与两次序列化属于同一个SQLite快照，不以第二次page_count补查假装消除race。它不证明其它进程全局停写，真实远端apply仍须原完整锁内CAS。只读本地对账同样先持有自有read快照，再复制有界镜像，返回matched/missing前重核总预算与源码指纹；演练也在全部摘要完成后作尾部预算/源码复核。

- `compile_machine_upgrade(source, expected_source_image_sha256=..., expected_resource_sha256=..., created_at=...)`：外部source-image SHA核`source.serialize()`原字节，resource SHA为外部选择的目标身份绑定；时间为固定`YYYY-MM-DDTHH:MM:SSZ`。先用page_count×page_size核原64MiB容量再序列化。
- `CompiledMachineUpgrade.safe_metadata`：重建核验后只返回闭集摘要。`body`、`statement_specs`、`artifact()`均含私人原像/参数，禁止日志、公共CI artifact或提交仓库。
- `rehydrate_machine_upgrade(source, artifact, expected_source_image_sha256=..., expected_resource_sha256=..., expected_plan_sha256=..., expected_packet_sha256=...)`：从原快照完整重编译，独立核原source/resource/plan/packet四个SHA，不信调用者替换的metadata或seal。
- `rehearse_machine_upgrade(packet)`：仅在新拥有的内存副本执行该包确切语句并核完整后像；不会写输入连接或文件。这是本地演练，不是云应用或独立数据库恢复。
- `machine_upgrade_readback_plan(packet)`：返回固定SELECT/只读PRAGMA计划，未来受控调用者必须把它们放在同一有界一致读事务内并核完整响应。没有网络实现或已核真实Hrana读回资格。
- `reconcile_machine_upgrade_local(conn, packet)`：只对显式本地一致内存读取分类`matched/missing/unknown`，全部`retry_allowed=false`。matched不是来源认证/云耐久，missing不证明原请求永未提交，不能据此重放。

## 原像、包与回执

只读捕获先验证固定manifest的Owner-only子集，才读取任何表；全部表/行/单元格、JSON、rowid、原生产scope与Owner记录均有界核验。受控内存decoder只读取已验证镜像，不把捕获的DDL字符串送给execute；新schema只由仓库固定DDL生成。原SQL拼写作为原像数据保留，不能先normalize后冒称物理schema原样不变。

同一BEGIN IMMEDIATE后先核FK开启、atan2的零符号能力、原raw schema、原header、每张旧表的原生typed值/rowid/计数；再执行固定DDL/marker，最后核目标raw schema、原header、所有旧表未变和新增marker。原`idempotency_responses`完全保留，包括之前8→9的回执；不做repair或更新旧V8投影。REAL守卫只在固定值槽使用整数精确表达式，0、NULL、字符串、BLOB和真实单ULP差异不能被JSON浮点转换抹掉。

新迁移回执使用**已新增journal本身**的不可变UPDATE/DELETE保护，不再增加表或trigger。固定`kind=observation`、保留`occurrence_id=profile:owner-machine`、`analysis_request_id=NULL`，独立文档schema为`owner-machine-upgrade-receipt-1`；该发生项不是业务日期，不会被日任务status当自然Cron成功。新journal原marker一行与原迁移回执一行同时提交；完整后像与原plan/packet/source/resource绑定。正常候选库存量raw126对象，原可选对象组合按真实autoindex计入，最多128，不删对象或抬预算换通过。

物理`_schema_version=9`与保留的`PRAGMA user_version=0/8/9`是不同轴；旧Owner升级原本保留header，本扩展也不重写它。输入已为完整machine或扩展只存在一部分时拒绝，不补齐、不覆盖旧marker、不另造迁移ID绕重复。

固定上限仍为128个对象、每语句900参数、源/目标总100000行、单元格256KiB、镜像/包/响应64MiB、16384步及30秒协作预算。它不是SQLite硬终止或provider容量证明。来源、编译器、固定manifest、原契约及相关金融/Owner代码都绑定当前源码指纹；检测漂移即拒绝。

## 未完成的云资格

真实provider需另外证明FK/session状态、只读pragma、atan2能力、单batch容量、停写排空及fresh保护备份；不能在BEGIN内设置FK后假称已经生效，也不能用空foreign_key_check等同FK开启。本模块没有HTTP sender，不能把本地SQLite通过认定为真实Turso JSON1/TEMP/TLS/提交/关闭证明。

未知写只保留原快照、原包及独立SHA，走单独固定只读核对；401/403或已绑定权限错误必须停止，不换Token、网络或重试。所有remote_applied/restore_verified/server_capabilities_verified/formal_release_qualified/retry_allowed始终false。真实业务云仓储、生产迁移、耐久/恢复和自然任务仍需各自验收。
