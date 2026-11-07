# 坑与先例

> 从 SKILL.md §二、§六、§六点五 拆出。遇到「看起来是限制、其实是我用错了」的情况时读。
> 更细的实测记录见仓库 `docs/gotchas.md`。

### 坑 1：返回 `{}` = 工具没经过统一包装

历史原因：早期每个工具都自己调 `text(...)`，忘了包一层就会在 MCP 响应里变成 `{}`。
⭐ **2026-11-07 起 187 个工具全部改用 `defineTool` 包装器**（`src/support/define-tool.ts`）：
handler 直接返回字符串（或 `{ body, kind }`），包装器负责加 `text()` 信封并把异常转成工具错误。
⇒ **新写工具时不要再手写 try/catch + text()**，用 `defineTool` 即可；返回 `{}` 的情况只可能出现在
还残留 `server.registerTool` 的地方（当前为 0）。

### 坑 2：页面上下文没有 `Services`

`browser_evaluate` 跑在**页面**里，拿不到 `Services`/`Cc`/`Ci`/`ChromeUtils`。
要碰浏览器内部必须走 **chrome 上下文**（工具内部用 `withChrome`）。
判据：**报 `X is not defined` 且 X 是 Gecko 内部符号 ⇒ 你站错层了。**

### 坑 3：⭐ 名字相同、语义完全不同的 API

| 写法 | 实际行为 |
|---|---|
| `walker.children(node)`（**DOM** inspector） | 返回 `{ hasFirst, hasLast, nodes, from }` —— **子节点在 `.nodes` 里，不是数组** |
| `walker.children()`（**A11y** accessibility） | ⭐ **忽略参数，永远只返回那一个根文档** |
| `node.children()`（**A11y 节点**） | ✅ 这个才返回真子级数组 |

⇒ 递归前先确认你调的是哪一层的 `children`。

### 坑 4：⭐ A11y 引擎是懒启动的

不唤醒就直接用，`getAccessibleFor()` 会**挂死整个会话**（它在等 `document-ready` 事件，而该事件只在服务启用时才有）。

```js
Cc["@mozilla.org/accessibilityService;1"].getService(Ci.nsIAccessibilityService);   // 唤醒
await new Promise(r => setTimeout(r, 800));
if (!Services.appinfo.accessibilityEnabled) throw new Error('a11y 没起来');
```
`browser_a11y_tree` 已内置这段，直接调即可。

### 坑 6：⭐ 曾经「navigate / evaluate 不接受 tab 参数」——2026-10-31 已修复

旧版本它们只操作活动标签页，传 `context` 会被静默忽略。
现已支持 `context`（见 §1.5）；但**仍有少数工具只作用于活动标签页**，
传 context 前先确认该工具的 inputSchema 里有这个参数。
判据：**用 `browser_page_info { context }` 核对目标 URL**，别用「应该切过去了」推断。

### 坑 5：⭐ 元素「存在」≠「可见」

读 `body.textContent` 会把**隐藏的错误模板**一起读出来，看着像报错其实没报。
判据：**先看 `el.offsetParent || el.getClientRects().length`**，别信纯文本。

## 几个"看起来是上游限制、其实是我错了"的先例

这些我都错过一次，别重犯：

- `resource://` 加载失败 ≠ 模块不存在 ⇒ **先试 `moz-src:///`**（三个斜杠）
- `getTraits()` 只返回 `["tabbingOrder"]` ≠ 引擎没起 ⇒ 那**就是源码里唯一的一项**
- `PlacesUtils.importFromHTML/exportToHTML` 不存在 ≠ 不能导入导出 ⇒ **自己遍历 `PlacesUtils.bookmarks` 拼/解 HTML**
- `PlacesUtils.bookmarks.search({parentGuid})` ≠ 单层查询 ⇒ ⭐ **它会忽略 parentGuid 返回整棵树**，必须自己过滤 `parentGuid === guid`
- `TranslationsParent.downloadLanguageFiles(language)` ⇒ ⭐ **只吃一个参数**，多传的会被静默忽略
- 翻译没有"专用翻译 API"可用时 ⇒ **走 `about:translations` 页面**：选好 source/target、再往文本框写内容 + 派发 `input`

### 第二批（2026-10-18 豆包数据迁移时踩的）

- **`FILE_PERMISSIONS_ERROR` ≠ 文件权限有问题** ⇒ ⭐ `LoginCSVImport.importFromCSV` 在本 build 里坏了
  （`icacls` 显示 `Users:(RX)` 完全正常、换 profile 路径也一样）。**直接走 `nsILoginManager.addLoginAsync`**。
- **`nsILoginInfo.origin` 传完整 URL ≠ 存的也是完整 URL** ⇒ ⭐ **Firefox 会归一化成 `scheme + host`**
  （`https://gitee.com/auth/github/callback` 存成 `https://gitee.com`）。
  **所以比对也要用归一化后的值**，否则会误判成"一条都没落盘"。
- **`PlacesUtils.history.insert` 用 `lastVisit` ≠ 能插入** ⇒ 报
  `PageInfo: The following properties were expected: visits`。
  正解：`visits: [{ date: new Date(ms) }]`。
- **Cookie 解出来是乱码 ≠ 解密失败** ⇒ 新版 Chromium 在明文**前面加了 32 字节 `SHA256(host_key)`**，
  剥掉就对了。判据：**尾部**能看出正常格式（`.a0009g` / `eyJhbGci` / `bfd9fdd0`）。
- **`logins.json` 只有 40 条 ≠ 只有 40 条密码** ⇒ ⭐ Firefox 现在用 **`logins.db`（SQLite）**，
  `logins.json` 是旧格式遗留。要看真实登录库就查 `logins.db` 的 `loginsL` / `loginsM` 两张表。

### 第三批：读源码之前的自我提醒

- **"我没查到" ≠ "不存在"** —— 上面每一条第一批的教训，根子都是把**表面信号**当成了系统限制。
  宣布一堵墙之前，先问：**哪条命令能推翻它？**

## 六点五、⭐ 代码结构（改工具前先看这一节）

2026-11-07 重构后源码分三层：

| 位置 | 内容 |
|---|---|
| `src/index.ts` | 入口：import + `new McpServer` + 20 个 `registerXxx(server)` 调用（488 行） |
| `src/tools/*.ts` | 21 个域模块、187 个工具，每个导出 `registerXxx(server)` |
| `src/support/*.ts` | connection / output / annotations / port / strings / keys / png / dom / extension-page / **define-tool** |
| `src/bidi/` | BiDi 与 Marionette 协议客户端 |

新增一个工具的做法：

1. 在对应域文件里写
   `defineTool(server, 'browser_xxx', { title, description, inputSchema, annotations }, async (args) => ...)`
2. handler 直接返回字符串；二进制结果返回 `{ body, kind: 'png' | 'pdf' }`
3. 需要新依赖时从 `src/support/` 取，⛔ 不要在 tools 里重复实现
4. `npm run build` → 重启 MCP（⛔ 别用 `Stop-Process -Force`，见 §1.2）

### 第四批（2026-11-07 对齐 Firefox 160 时踩的）

- **`browsingContext.activate` 对 about: 特权页面报 `does not support browsing contexts in privileged scope`** ⇒
  ⭐ 这**不是 160 的回归**（160 与 159 的 activate 实现逐行相同），是 `about:home` 这类
  privilegedabout 页面本身的属性：同一个 context 导航到 http 页就能 activate。
  `browser_activate_tab` 已内置 chrome 侧 fallback（`gBrowser.selectedTab`），返回里会注明
  「selected through the chrome side」。
- **`network.getData` 的 `bytes` 是 WebDriver 值节点，不是 base64** ⇒
  ⚠️ `bytes.type === 'string'` 时 `value` 已经是原始字节的 latin1 字符串；
  按 base64 解码 146 KB 的内容只会得到 4 个垃圾字节。
  正解：按 `type` 分支（`string` → latin1，`base64` → base64）。
  `browser_get_response_body` 已修正，预览现在是可读文本。

## 第五批（2026-11-07 加 profiler 时实测的）

- **`Services.profiler.StartProfiler()` 无参数会抛 `Not enough arguments`** ⇒ 它需要
  `(entries, interval, features, threads, duration, activeTabID)`。可用值：
  `StartProfiler(1000, 1, [], [], 0, 0)`。
- **`Services.profiler.IsActive` 是方法不是属性** ⇒ 直接取值会得到 `undefined`，
  JSON.stringify 后字段整个消失（表现为「status 里没有 active 字段」）。要写 `IsActive()`。
- **`GetBufferInfo()` 也需要参数** ⇒ 不需要它时别调；`getElapsedTime()` 无参数可用。
- **profile 文件是标准 Firefox Profiler JSON** ⇒ 可以直接在 profiler.firefox.com 打开，
  不需要额外转换。
