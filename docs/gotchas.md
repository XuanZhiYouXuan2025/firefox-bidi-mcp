# 踩坑与实测记录

> 这里放「读过就少踩一次」的知识：Firefox 内部 API 的反直觉行为、工具实现层面的坑、以及实测结论。
>
> **这不是必读文档**。操作纪律见 [`../skills/firefox-bidi-mcp/SKILL.md`](../skills/firefox-bidi-mcp/SKILL.md)；本文件按需查。

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

## 六、AutoConfig（部署级特权脚本）在 Firefox 159.0 上不工作

**结论**：`defaults/pref/*.js` + `general.config.filename` + 安装根脚本这条社区通行做法，在本机 Developer Edition 159.0 上**实测无效**；社区实现 `fx-autoconfig` 原样复刻同样无效。

### 现象（可复现）

- `defaults/pref/config-prefs.js` 设置 `general.config.filename`，脚本放安装根 —— 部署正确，`pref()` 也确实被加载（用自定义 pref 验证过）
- 但 `prefs-read` topic 上 **observer 数量为 0**（Marionette chrome 上下文实测）
- `MOZ_LOG=MCD:5` 的日志文件**被创建但 0 字节** —— `nsReadConfig::readConfigFile()` 从未执行

### 已排除的假设（均有源码或实测依据）

| 假设 | 排除依据 |
|---|---|
| 构建禁用 autoconfig | `@mozilla.org/readconfig;1` 实测可创建，`pref-config-startup` category 已注册 |
| 需要 User 值触发 | `GetValue(PrefValueKind, nsACString&)` 走 `WantValueKind`，`!HasUserValue()` 时回落 Default |
| `defaults/pref` 不扫描 | `pref_LoadPrefsInDir` 按 `.js` 后缀全收 |
| `NS_GRE_DIR` 指向别处 | 与 `defaults/pref` 同源（`mGREDir`），后者已验证可用 |
| sandbox 阻挡 | 已设 `sandbox_enabled=false`；失败时应弹框或报 console，两者都没出现 |
| 版本代码不同 | 按 `application.ini` 的 SourceStamp 精确 commit 重下，与 tip 对比无差异 |
| 日志系统故障 | `MOZ_LOG=nsHostResolver:5` 产出 268 KB 日志，机制正常 |

### 未闭合的点

`Preferences.cpp:4667` 的 `GetCString("general.config.filename", ..., PrefValueKind::User)` 在源码层面应该成功（`WantValueKind` 有回落），但运行时组件创建没有发生。静态读代码无法解释这个差距，需要运行时注入观测点。

### 附带踩坑：`MOZ_LOG_FILE` 会被追加扩展名

`Logging.h` 里 `#define MOZ_LOG_FILE_EXTENSION ".moz_log"`，`ExpandLogFileName` 会给不以该后缀结尾的路径追加它。

```bash
# 设 MOZ_LOG_FILE=D:/tmp/mcd.log
# 实际文件是 D:/tmp/mcd.log.moz_log   ← 找错文件名会误判成「日志没生效」
```

### 影响

原生拖放和交互式取色器都依赖这条通道（需要 content 进程里的特权执行点），因此在 159.0 上两者都做不到。替代见 [SKILL.md](../skills/firefox-bidi-mcp/SKILL.md) 与 [dsh-integration.md](dsh-integration.md)。
