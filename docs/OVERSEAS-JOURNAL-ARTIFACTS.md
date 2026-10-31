# 海外任务运行日记：单 main 存储

此为公开非金融运行记录的存储变更，不是 v9 发布、生产数据库切换、自然窗口成功或数据恢复证明。应用版本与自动部署暂停不变。

## 固定归档和首次边界

- `docs/archive/overseas-run-journal-20261031.json`：冻结旧日志分支末端的完整原始 JSON 字节，不重写既有失败、零产出或日期。
- `docs/archive/overseas-journal-cutover-20261031.json`：闭集字段 `profile`（`overseas-ops-cutover-1`）、`repository`、`workflow_id`、`cutover_utc`、`legacy_tip`、`legacy_last_run_number`、`seed_sha256`、`protocol_blobs`。
- `protocol_blobs` 只包含 `tools/overseas_journal_artifact.py`、`tools/record_overseas_ops.py`、`tools/overseas_run_journal.py`、`.github/workflows/overseas-accuracy.yml` 的四个固定 Git blob OID。归档时按最终提交的 LF Git blobs 核定，不能用 Windows 换行后的文件 SHA 代替 Git OID。
- 切换前暂停该 workflow、排空运行与队列，再固定时间、最后原生 `run_number`、旧分支 tip/JSON SHA；完整旧 Git 历史另存自包含 bundle，并独立恢复/fsck。bundle 不上传仓库。

只有服务器当前 `run_number == legacy_last_run_number + 1` 且没有新协议前序运行，才允许首次使用固定 seed。API 查不到前序、网络失败、删除或过期都不是再次使用 seed 的许可。

## 累计 Artifact 合同

- 每次运行使用唯一 `overseas-public-journal-{run_id}-{attempt}` Artifact；只含一个普通、不可执行的 `overseas-run-journal.json` envelope，不含源码、密钥或私人数据。保留 90 天，不覆盖旧 Artifact。
- 仅固定仓库/workflow/main 的 `schedule` 或 `workflow_dispatch`，本轮服务器必须仍为 `in_progress`、attempt 恰为 1。不能使用 GitHub 的 Re-run 重跑旧 ID；需要新建一次 dispatch。失败/取消的前序同样需要核对，不能只找 success。
- 以完整有界分页和服务器时间选择唯一最近已完成前序，要求其原生 `run_number` 恰为当前减一。编号缺口、前序 rerun、早于本轮已开始的非终态、同秒终态歧义或协议代码不符固定拒绝。排除 PR/非 main 不代表可以跨编号缺口猜历史。
- 服务器 run ID/attempt/源 SHA 与 Artifact 身份、下载 SHA-256、ZIP 全体积、唯一条目/普通文件/无执行位、有限展开、JSON 闭集和 512 KiB/366 事件 codec 全部校验。原历史 seed 前缀必须完整保留，不导入/执行任一运行的代码。
- `restored` 在 provider 工作前保存原可用状态；后续早期失败仍可上传它。`restored` 和 `check_only` **没有为本轮记录事件**，也不填补缺失的自然窗口，不把失败改成成功。
- `terminal` 只能在原历史后追加本轮真实事件。恢复时若原事件声称执行成功而服务器最终 conclusion 不是 success，保留失败并拒绝继续，不改写事件或回退旧 seed。金融结果/CI 派发/最终 Artifact 上传仍是不同真相轴。
- 金融四文件仍仅由原封闭 publisher 单次普通推 main，固定 hook 仍核服务端旧 OID。未知 push/最终 main 后检失败不重试；日志上传不推进 main，不创建或推送 ops 分支，不另派发 CI。

## 只读切换验收

`workflow_dispatch` 的 `journal_check_only=true` 只恢复并重新发布相同原 journal 字节；不调用 producer、日历、金融发布、CI 派发或事件生成。stdout 只输出固定 checkpoint、字节数、事件数、SHA 和前序身份，不输出完整日志或 Token。

实际验收至少新建两次独立 check-only dispatch：第一轮核固定 seed，第二轮必须从第一轮实际 Artifact 恢复；两轮 journal SHA/字节数/事件数应完全相同。两轮成功只证明该真实存储载体/读取链，不证明自然定时或金融数据恢复。最后独立核远端仍只有 main，部署暂停，再恢复原自然 schedule。

## 故障和保留期

GitHub Artifact 不是永久灾备，过期或删除的 Artifact 可能完全不出现在 API 中。缺失前序或编号缺口必须停，不循环下载/上传、不改账号/源、不自动重置。保留原 run/Artifact/错误，按固定 archive/bundle 与可用累计 Artifact 另做显式、审查后的新 cutover；不能伪造事件。协议四文件改变同样需要审查存储迁移，不能随手改 manifest OID 洗掉不兼容历史。

此实现不修改套餐、不启用额外云资源或付费超额；Artifact 仍受仓库自身额度和 90 天保留设置约束，不承诺永久免费持久化。实际自然任务、API/源恢复及发布门禁独立验收。
