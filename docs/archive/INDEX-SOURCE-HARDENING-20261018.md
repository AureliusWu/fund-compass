# 公开指数源最小修复候选（2026-10-18）

此切片从 main `0c0f9ad093da983ab2313a05ce614fde0de28b5f` 独立回补，不包含 v9 Owner/schema9、数据库迁移、工作流、依赖或版本修改。应用仍为 8.0.0；候选通过不等于正式发布或线上数据已恢复。

## 已修复

- 公开匿名单 session/单 bootstrap，固定六核心指数及加权 `addTtmPe`/`addPb` 字段，不用等权指标或其他指数替代。
- 默认每指标只请求一次、15秒最小间隔、240秒源读取协作预算；401/403/429立即整源停止，不更换身份/网络重试，不记录 body、Cookie、CSRF 或完整 query。
- 有界严格 JSON、响应大小/记录数、真实源日期及重复日期检查；保留同日 PE/PB、六核心6/6、至少30个非重复样本、7天新鲜度和未来日拒绝。
- 原有 PE/PB 分次成功不得互相丢失；严格匹配加权列，拒绝缺失/重复/非原生类型、非有限值及日期猜测。
- 不支持的候选明确 missing/unsupported，requested 不缩水；失败不覆盖旧的有效产物。

## 直接证据与限制

10-12 自然 run [38214537636](https://github.com/AureliusWu/fund-compass/actions/runs/38214537636) 的日志显示 CSRF meta 缺失/固定映射 KeyError 等，没有该次 HTTP 状态，不能倒推为403或429。

10-18 一次单匿名 session 诊断中，前三核心 PE/PB 各200，最新实际源日期2026-10-16；第七指标中证100PE为429后立即停止，其PB及500/1000未请求。没有保存 Retry-After，值未知。该次诊断没有运行此候选生产者、写产物或触发工作流，不证明六核心恢复。

15秒与240秒只是负载/协作预算，不保证上游配额、不抢占原生 DNS，也不是整个 main 写盘硬期限。指数 API 在应用启动时加载快照，静态 JSON 更新本身不等于正在运行的 API 已重载。共享富集工作流仍可能因其他 screener 阶段失败，不能把全 workflow 红灯全部归因此源。

## 本地正常门禁

在精确 main 基线加五个代码/测试文件上，各阶段仅执行一次：专项 collection/run **143/143 passed**，全量 **721/721 passed**；full pytest28.58秒、外层30.447秒，原300秒上限未修改。正常插件、清凭据环境、新实际 `db.DB_PATH`、byte/cache关闭；exit0、未超时、输出完整、stderr空，默认DB未创建。保留30615条 Python3.14依赖/插件弃用警告。

192源前后 raw-byte 摘要 `aeb0cfb313cb8aa3672084a3c8d76b427e87933d96c43a8b8edd23c7e325bb53`，父代理逐文件独立复核漂移0。runner SHA `5f9232fc4ef9b7557c8014b6728f63b7968d44f7c30d57892c7b47e18cd7d414`；full manifest SHA `6e986efbc158e115b3c0169a0cb94043555564886df7f9d0a19e80552feca1a7`，stdout SHA `c03f2597f6387b056f9fdfdd7748eb7ed07c8086f25a681bb7d5e692ccc8a8b6`。外部证据目录 `fc-index-main-normal-author-20261018-9c64bd12`；随后只新增本文说明，不重写原 freeze。

该证据是 Windows/Python3.14.4 的隔离合成测试。Python3.12 exact-source CI、正式合入/部署、六核心真实新产物及 API 读回、自然窗口仍须分别验证；没有用本地通过为这些项目放行。
