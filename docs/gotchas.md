# 踩坑与实测记录

> 这里放「读过就少踩一次」的知识：Firefox 内部 API 的反直觉行为、工具实现层面的坑、以及实测结论。
>
> **这不是必读文档**。操作纪律见 [`../skills/browser-mcp/SKILL.md`](../skills/browser-mcp/SKILL.md)；本文件按需查。

## 一、Firefox 内部 API：看起来是限制，其实是用法错了

- **`resource://` 加载失败 ≠ 模块不存在** ⇒ 先试 `moz-src:///`（三个斜杠）
- **`getTraits()` 只返回 `["tabbingOrder"]` ≠ 引擎没起** ⇒ 那确实就是源码里唯一的一项
- **`PlacesUtils.importFromHTML` / `exportToHTML` 不存在 ≠ 不能导入导出** ⇒ 自己遍历 `PlacesUtils.bookmarks` 拼/解 HTML
- **`PlacesUtils.bookmarks.search({parentGuid})` ≠ 单层查询** ⇒ 它会忽略 `parentGuid` 返回整棵树，必须自己过滤 `parentGuid === guid`
- **`TranslationsParent.downloadLanguageFiles(language)` 只吃一个参数** ⇒ 多传的会被静默忽略
- **没有"专用翻译 API"时** ⇒ 走 `about:translations` 页面：选好 source/target，再往文本框写内容并派发 `input` 事件

### 登录库与历史

- **`FILE_PERMISSIONS_ERROR` ≠ 文件权限有问题** ⇒ `LoginCSVImport.importFromCSV` 在部分 build 里是坏的（`icacls` 显示权限完全正常、换 profile 路径也一样）。直接走 `nsILoginManager.addLoginAsync`
- **`nsILoginInfo.origin` 传完整 URL ≠ 存的也是完整 URL** ⇒ Firefox 会归一化成 `scheme + host`（`https://example.com/auth/callback` 存成 `https://example.com`）。比对时也要用归一化后的值，否则会误判成"一条都没落盘"
- **`PlacesUtils.history.insert` 用 `lastVisit` ≠ 能插入** ⇒ 报 `PageInfo: The following properties were expected: visits`。正解：`visits: [{ date: new Date(ms) }]`
- **`logins.json` 只有几十条 ≠ 只有这么多密码** ⇒ 新版 Firefox 用 `logins.db`（SQLite），`logins.json` 是旧格式遗留。真实登录库看 `logins.db` 的 `loginsL` / `loginsM` 两张表

### Cookie

- **Cookie 解出来是乱码 ≠ 解密失败** ⇒ 新版 Chromium 系在明文**前面加了 32 字节 `SHA256(host_key)`**，剥掉即可。判据：**尾部**能看出正常格式（`.a0009g` / `eyJhbGci` / `bfd9fdd0`）

## 二、工具实现层面

- **返回 `{}` ⇒ 忘了 `text()`**：每个工具的返回值必须用 `text(...)` 包一层，裸字符串在 MCP 响应里会变成 `{}`
- **A11y 引擎是懒启动的**：不唤醒就用 `getAccessibleFor()` 会**挂死整个会话**（它在等一个只在该服务启用后才有的 `document-ready` 事件）。
  `browser_a11y_tree` 已内置唤醒逻辑，直接调即可；自己写 `browser_evaluate` 时要照做：
  ```js
  Cc["@mozilla.org/accessibilityService;1"].getService(Ci.nsIAccessibilityService);
  await new Promise(r => setTimeout(r, 800));
  if (!Services.appinfo.accessibilityEnabled) throw new Error('a11y 没起来');
  ```
- **名字相同、语义完全不同的 API**：

  | 写法 | 实际行为 |
  |---|---|
  | `walker.children(node)`（**DOM** inspector） | 返回 `{ hasFirst, hasLast, nodes, from }` —— 子节点在 `.nodes` 里，**不是数组** |
  | `walker.children()`（**A11y** accessibility） | ⭐ **忽略参数，永远只返回那一个根文档** |
  | `node.children()`（**A11y 节点**） | ✅ 这个才返回真子级数组 |

  ⇒ 递归前先确认调的是哪一层的 `children`。
- **元素「存在」≠「可见」**：读 `body.textContent` 会把隐藏的错误模板一起读出来，看着像报错其实没报。判据：先看 `el.offsetParent || el.getClientRects().length`，别信纯文本。

## 三、会话与连接

- **客户端被杀不会发 `session.end`**，会泄漏会话，之后所有调用报 `Maximum number of active sessions` 或 `already has an active BiDi session` —— 只能重启 Firefox 才清得掉
- **先别急着重启浏览器**：多数时候是本机有一个僵住的 MCP 进程占着会话，处理它比重启浏览器便宜
- **⛔ 不要用 `Stop-Process -Force` 硬杀**：那是 `TerminateProcess`，Node 的 `SIGTERM`/`SIGINT`/stdin-end 处理器都来不及跑，`shutdown()` 里的 `session.end` 不会发出 ⇒ 会话照样泄漏。优先走优雅退出（关 stdin / `Ctrl+C` / 能触发 `SIGTERM` 处理器的路径）
- **跨进程不能"接管"旧会话**：BiDi 一个 session 绑一条 WebSocket，没有 resume/attach；旧连接断了但 session 未 end 时，新连接既不能复用也不能结束它
- **`browsing-context` id 每次 `session.new` 都会变** ⇒ 别缓存，用 URL 片段匹配

## 四、一处历史遗留

早期版本的 `navigate` / `evaluate` 只作用于活动标签页，传 `context`/`tab_id` 会被**静默忽略**（不报错），于是你以为在操作自己开的窗口、实际改的是用户前台标签页。
现在这些工具已支持可选 `context` 参数；仍不支持 `context` 的工具（如 `upload_file` / `pdf` / `mouse_action` / `set_viewport`）仍作用于活动标签页 —— 用后请以 `browser_page_info` 核对。
