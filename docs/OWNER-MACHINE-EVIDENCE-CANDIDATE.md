# 完整机器行情入库候选

应用仍为8.0.0，正式发布仍BLOCKED。本接口只使用原完整本地 machine profile；没有新DDL、云迁移、环境凭据发现、外部抓取或真实通知。

## HTTP 与事务

前缀 `/api/v2/worker/portfolio`，只允许Worker/Admin，私人响应固定no-store。构造与OpenAPI零IO。

| 端点 | 合同 |
| --- | --- |
| `POST /evidence` | 原invocation日期/ID/trigger/slot/build SHA、expected_revision/source_hash/当前policy_version、完整有序observations；每项仅code与canonical estimate_context |
| `GET /evidence/{request_id}?occurrence_date=YYYY-MM-DD&request_hash=<原正文SHA>` | 只读核对该原包的原始结果；缺失404不证明未提交，不授予重发或发送权 |

Evidence专属原正文上限128KiB；原prepare/claim/finish的16KiB不变。完整1至100基金不拆包、不截前50；服务端源包含全部账户、manual/tombstone及typed数值，Worker只取codes不重构持仓。build SHA是自报绑定，不是源码认证。

同一调用者连接与BEGIN IMMEDIATE核完整来源/当前Policy，读取并计算全部候选后，再保存全部Evidence、source health、production scope和原批次回执。复用原固定V8 INSERT与金融规则；内部核不提交/关闭/另开业务连接。原结果与回执一起提交，任一失败整批回滚；commit/close/HTTP/提交后权限撤销不证明回滚。整个30秒协作预算、2MiB返回像及原journal容量不增加，SQLite不宣称硬中断。

回执使用原不可变journal的observation kind，但以独立闭集schema `owner-machine-evidence-receipt-1` 保存。其record_id绑定发生日与request_id，hash绑定原UTF-8正文，包括空白和数字词法；等价重序列化也不是原包。同ID不同hash409，匹配原包只返回原refs、不重算或续鲜。status先严格核其合同与原production引用，但不把行情入库算为prepare/claim成功或自然Cron证据。后来source/Policy变化仍可读历史回执，但原prepare/claim必须重新独立核当前资格。

## 数据前置与时间轴

`resolveValuations`访问外部行情源，**不会**预热后端详情缓存。候选准备必须另行提供同库完整codes的`fund_detail/nav_history`。本轮不暗加100次详情请求。缓存缺失、采集时间无时区/在未来/超7天、最新NAV日期在未来/超7天、同日NAV投影冲突或未来历史整批拒绝。历史NAV最多原800条，允许合法的多年历史；7天不是所有历史记录的筛选窗口。

行情报文继续保留真实0与null、正式净值与下一净值区别。新canonical入口不接受旧字段/kind别名，不接受客户端分数或持仓。intraday的value_date不是当日则降为unavailable，源时间、base匹配与未来偏差继续复用原服务校验。合法不可用报价保留该基金的中立Evidence，不缩小完整集合。官方、stale、modeled或QDII目标估算不计入当前intraday fresh数量。

同策略历史outcome先按原production/先前日期/已知时刻谓词核全批次累计10000行、8MiB，超量整批拒绝，不截断统计。QDII附件只读一次有界公开artifact快照，仍只补同code/model的不确定性，不生成当前预测。重复Evidence保留原保存对象与created_at，不能用本次请求时间给旧证据续鲜。

## 验证边界与下一项

真实本地HTTP/SQLite覆盖完整批次、原回执、错误投影、丢响应、权限撤销与三次100基金计时。跨语言测试用实际Worker serializer进入Python parser；loopback测试用真实打包Worker调用本地后端，模拟公开行情/外部送达，验证第二次执行没有重复发送。不是实际TLS、Turso、Cloudflare Cron或ServerChan送达证据。

下一项是受控完整缓存准备、full-machine云profile/迁移与能力验证、旧发送状态保全/接入、真实自然周期、跨重启与独立恢复。正常main/Turso守卫、部署暂停、Wrangler安全阻断与版本均未放宽。参见[Worker候选](OWNER-MACHINE-WORKER-CANDIDATE.md)及[Owner同步ASGI候选](OWNER-SYNC-ASGI-CANDIDATE.md)。
