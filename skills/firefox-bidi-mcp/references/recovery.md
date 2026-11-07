# 出错与恢复

> 报错、超时、会话占满、收工没清干净时读这份。原则：**先判症状再动手，别盲目重放**——
> 动作可能已经生效了。

## 一、症状 → 先查什么

| 症状 | 先查 | 处置 |
|---|---|---|
| `Maximum number of active sessions` / `already has an active BiDi session` | 是否有僵住的 MCP 进程占着会话 | 见 §二 |
| `System access is required` | Firefox 启动时没带 `MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1` | 只能重启 Firefox 补 |
| 工具返回 `{}` | 工具没经过统一包装 | 见 [gotchas](gotchas.md) |
| `Browsing Context with id ... not found` | context id 每次 `session.new` 都会变 | 重新 `browser_list_tabs` 拿新 id |
| 超时 | 页面忙、请求被拦截（interception 开着） | 先 inspect 当前状态，再决定是否重试 |
| `unsupported operation: ... privileged scope` | about: 特权页面 | 见 [gotchas](gotchas.md)（activate 回退） |
| 页面看起来"卡住" | 是不是 `browser_network_intercept` 开着把请求 hold 住了 | `browser_network_continue_all` 释放 |

## 二、会话泄漏（一个 Firefox 只能有一个 BiDi 会话）

客户端被杀不会发 `session.end`，会话就泄漏了。**先别急着重启浏览器**——多数时候是本机有个僵住的
MCP 进程占着，处理它比重启便宜。

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*dist\index.js*' } |
  Select-Object ProcessId, CreationDate
```

**判据**：某进程的 `CreationDate` **早于** Firefox 的启动时间 ⇒ 它就是占着会话的元凶。

**正确顺序**：
1. 先走**优雅退出**（关闭 stdin / Ctrl+C / 任何能触发 Node `SIGTERM` 处理器的路径）；
2. 再启动新进程；
3. 用 `browser_list_tabs` 验证；仍报 `already has an active BiDi session` ⇒ 只能**重启 Firefox**。

⛔ **不要用 `Stop-Process -Force`**：那是 `TerminateProcess`，`session.end` 来不及发，
会话照样泄漏。完整背景见 [connection](connection.md)。

## 三、通用重试纪律

1. **先看效果再重试**：超时/未知结果时，动作可能已经生效（点击、导航、提交）。用只读工具确认。
2. **两次没有进展就换路**：同一动作重试两次仍失败 ⇒ 停下来读 [gotchas](gotchas.md)，
   或者改用别的工具组合，不要第三次硬试。
3. **报错优先读错误原文**：BiDi 的错误消息通常直接说了原因（`Expected "context" to be a string`、
   `Unable to parse URL`、`invalid argument: moz:scope is not the name of a known capability`）。
4. **别把症状当结论**："我没查到" ≠ "不存在"——先确认查询本身是否用对了 API。

## 四、收工的幂等

`--stop` 失败或中断时，**重复同一条 stop 命令**即可：

- 已经停掉的情况会返回 `nothing is listening on port N — already stopped`，
  并清掉残留的 pid 记录；
- 端口还被占着时，脚本会打印真正占用的 pid 列表，并在必要时升级到 `taskkill /T /F`；
- 仍然失败会明确报错（`the instance did not stop`），不会假装成功。

**收工验证四项**（缺一条都算没做完）：
1. `netstat` 里该端口不再 LISTENING
2. 带该档案的 `firefox.exe` 进程数为 0（**窗口也算遗留**）
3. 自己开的测试档案目录已删除
4. 改过的 pref 已恢复（`browser_troubleshoot` 的 `modifiedPreferences` 复查）
