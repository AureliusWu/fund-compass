# 司南基金 · 微信推送配置

当前有两类推送：

- `estimate-push`：交易日北京时间 **14:30 / 14:40 / 14:50**，推送自选基金盘中涨跌幅。
- `signal-notify`：交易时段检查择时信号变化，变化时才推送，并顺带 ping 后端保活。

状态存在同一个 Gist，不写仓库（不会触发前端重新部署）。

> 不配 Secret 也不会报错，工作流只是空跑。配齐下面 Secret 才会真正推送。

## 一、开通微信推送（Server酱 SendKey，约 2 分钟）

1. 打开 <https://sct.ftqq.com> → 用**微信扫码登录**。
2. 进「SendKey」页，复制你的 **SENDKEY**（形如 `SCT xxxxxxxx`）。
3. 按页面提示**关注公众号并绑定微信**，否则收不到推送。
4. （免费版每天最多 5 条；本工具只在信号真变化时推，足够用。）

## 二、在 GitHub 仓库加两个 Secret

仓库 `AureliusWu/fund-compass` → **Settings → Secrets and variables → Actions → New repository secret**，
分别新建：

| Name | Value |
|------|-------|
| `WECHAT_SENDKEY` | 第一步拿到的 Server酱 SENDKEY |
| `GIST_TOKEN` | 你的 GitHub Personal Access Token（**gist** 权限）——就是 App「云同步」里填的那个 |

> 兼容旧配置：如果你已经有 `SC_SENDKEY`，脚本仍会继续使用；新建时建议用 `WECHAT_SENDKEY`。

> 没有 GIST_TOKEN？去 <https://github.com/settings/tokens> 建一个 **classic** token，
> 勾选 **gist** 作用域即可。这个 token 同时能用于 App 云同步。

## 三、确保 Gist 里有自选

定时任务从 Gist 文件 `sinan-watchlist.json` 读自选，所以：
**先在 App「自选 → 云同步」里填好 Token 并「上传」一次**，把自选推到 Gist。
（用 App 多设备同步时这步本来就会做。）

## 四、测试

自选涨跌幅：

仓库 → **Actions → estimate-push → Run workflow** → 勾选 `force = true` → 可选填 `slot = 14:30` → Run。

- 微信应收到一条「司南基金 · 自选涨跌幅（14:30）」。
- `force = true` 只用于测试，不会占用当天正式推送 slot。

择时信号：

仓库 → **Actions → signal-notify → Run workflow** → 勾选 `force = true` → Run。

- 看运行日志：应有 `health ok（已保活）`、`codes=N`；
- 微信应收到一条「司南基金 · 推送测试」，列出当前自选信号。

## 五、已排查的定时问题

- GitHub Actions 的 schedule 是尽力而为，可能延迟甚至跳过；近期日志里 `estimate-push` 曾延迟到北京时间 18 点后才执行。
- 旧版脚本用 `last_date` 去重，一天最多只会推一条，不可能满足 14:30 / 14:40 / 14:50 三次推送。
- 新版改为按 `slot` 去重：当天 `14:30`、`14:40`、`14:50` 各最多推一次。

## 工作原理 / 注意

- **estimate-push** 每个交易日下午尝试推送三次自选涨跌幅，非交易日或当日无盘中估值会跳过。
- **signal-notify** 首次正式运行只播种状态、不推送，之后某只基金信号变化（如「持有」→「买入」）才会推。
- **保活**：每次运行都会 ping `/health`，交易时段保持后端常驻。GitHub 免费定时任务可能延迟几分钟、
  偶尔跳过，所以保活并非 100% 严丝合缝；真要零冷启动得上 Render 付费档。
- **时段门控**：脚本内按 A 股 09:30–11:30 / 13:00–15:00（CST）精确判断，非交易时段直接跳过。
- 推送内容仅为数据信号，**不构成投资建议**。
- 想换通道（Bark / 邮件）：改 `tools/notify.py` 里的 `notify()` 一个函数即可，其余逻辑通用。
