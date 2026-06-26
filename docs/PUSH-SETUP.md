# 司南基金 · 信号推送 + 保活 配置（V2-6）

定时任务（GitHub Actions）在交易时段每 10 分钟：从你的 Gist 读自选 → 查最新择时信号 →
**信号变化才推送**（Server酱 / 微信）→ 顺带 ping 后端，**免去 Render 冷启动**。
状态存在同一个 Gist，不写仓库（不会触发前端重新部署）。

> 不配 Secret 也不会报错，工作流只是空跑（仅保活）。配齐下面两个 Secret 才会真正推送。

## 一、开通 Server酱（安卓 / 微信，约 2 分钟）

1. 打开 <https://sct.ftqq.com> → 用**微信扫码登录**。
2. 进「SendKey」页，复制你的 **SENDKEY**（形如 `SCT xxxxxxxx`）。
3. 按页面提示**关注公众号并绑定微信**，否则收不到推送。
4. （免费版每天最多 5 条；本工具只在信号真变化时推，足够用。）

## 二、在 GitHub 仓库加两个 Secret

仓库 `AureliusWu/fund-compass` → **Settings → Secrets and variables → Actions → New repository secret**，
分别新建：

| Name | Value |
|------|-------|
| `SC_SENDKEY` | 第一步拿到的 Server酱 SENDKEY |
| `GIST_TOKEN` | 你的 GitHub Personal Access Token（**gist** 权限）——就是 App「云同步」里填的那个 |

> 没有 GIST_TOKEN？去 <https://github.com/settings/tokens> 建一个 **classic** token，
> 勾选 **gist** 作用域即可。这个 token 同时能用于 App 云同步。

## 三、确保 Gist 里有自选

定时任务从 Gist 文件 `sinan-watchlist.json` 读自选，所以：
**先在 App「自选 → 云同步」里填好 Token 并「上传」一次**，把自选推到 Gist。
（用 App 多设备同步时这步本来就会做。）

## 四、测试

仓库 → **Actions → signal-notify → Run workflow** → 勾选 / 填 `force = true` → Run。
- 看运行日志：应有 `health ok（已保活）`、`codes=N`；
- 微信应收到一条「司南基金 · 推送测试」，列出当前自选信号。收到即说明通道已通。

## 工作原理 / 注意

- **首次正式运行只播种状态、不推送**，之后某只基金信号变化（如「持有」→「买入」）才会推。
- **保活**：每次运行都会 ping `/health`，交易时段保持后端常驻。GitHub 免费定时任务可能延迟几分钟、
  偶尔跳过，所以保活并非 100% 严丝合缝；真要零冷启动得上 Render 付费档。
- **时段门控**：脚本内按 A 股 09:30–11:30 / 13:00–15:00（CST）精确判断，非交易时段直接跳过。
- 推送内容仅为数据信号，**不构成投资建议**。
- 想换通道（Bark / 邮件）：改 `tools/notify.py` 里的 `notify()` 一个函数即可，其余逻辑通用。
