# 历史材料归档

## 指数源修复候选（2026-10-18）

`INDEX-SOURCE-HARDENING-20261018.md` 原文来自
`fix/index-source-hardening-20261018` 的提交
`7999db1c753966ccd94a8e7ad0844c18e706e2f9`，原 Git blob 为
`ef8800d0c4f9001d640831bde5967b04d8905816`。归档只改变保存位置，
不改写其中历史运行、告警、未完成门禁或失败记录；这些不是当前线上恢复证明。

截至本次清理前的远端 main `5c2f030b8b58bad48b923dbd9f2f9ecd29d4aa48`，
该旧分支的两个生产脚本和两份既有测试已与 main 逐字节相同，无需再次整笔合并。
单独保留的 `backend/tests/test_index_valuation_producer_boundaries.py` 来自同一提交，
原 blob 为 `03700a3d56892ea08f0fef141a869755c5d52cc4`，含 37 个合成边界用例。
它不访问真实行情源，不写正式产物，也不证明六核心数据已恢复。

## 协调代码历史备份

本地 `codex-backup/v9-reconcile-20261015-before-email` 的原始 head 为
`ae36815e523ee9dadb6f514932f8248b3330f8d9`。其中业务补丁
`743a3c391bdb97f084e00caacb5a8d5da3131a15` 与 main 的
`40f629e9800a8531b01ede650f80df0a08e21211` 具有相同 stable patch-id。
协调生产模块相同；main 的测试源码 pin 已随其后编译器更新，不能用旧备份回退。

## 验证及删除边界

- Windows 的 `core.autocrlf=true` 可能改变已签定原始源码的字节。
  原生 SHA 校验失败不能改 pin 放行；使用固定提交的 `git archive` 导出 LF 原文后，
  按原测试、原 fixture 和原校验值验证，并分别保留两次结果。
- 仅在补充测试与档案进入 main、相关回归通过后，才将两条旧分支导出为自包含 Git bundle。
  备份保存在本机 Git 元数据之外的独立目录或 Git 元数据内的专用归档目录，不上传公开仓库。
- 删除前须 `git bundle verify`，再从 bundle 独立恢复两条 refs，核原 head 与对象完整性。
  同时保留旧工作区的文件清单、未提交状态及恢复说明。
- 旧临时工作区的 344 项删除代表原文件缺失，不应提交或合并至 main。
  只移除核准的旧工作区与两条固定 head 引用，保留 main 和 `ops/overseas-run-journal`。
- 本次只补测试、归档和清理历史引用。应用保持 8.0.0；部署暂停与正式发布门禁
  仍遵循 [CODE-ONLY-MERGE-HOLD.md](../CODE-ONLY-MERGE-HOLD.md)。
