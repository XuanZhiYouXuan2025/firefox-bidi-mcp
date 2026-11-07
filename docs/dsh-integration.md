# 与 DeepSeek Harness 配合

> 本文件描述 **DSH 专属**的集成方式。非 DSH 用户可忽略——MCP server 本身不依赖 DSH。

## 一、安装技能

`skills/browser-mcp/` 是一个 DSH 技能。Windows 下以 junction 方式挂进 DSH 的 skills 目录：

```powershell
./scripts/install-skill.ps1 -DshHome <你的 DSH_HOME>
```

DSH 看到的是 junction，改仓库里的 `SKILL.md`，DSH 侧立刻就是新的，不用复制。

## 二、DSH 实例占着浏览器时的处置

**触发判据**（可检验）：`browser_list_tabs` 的结果里**存在 URL 指向本 DSH 实例 Web GUI 的标签页**（形如 `http://127.0.0.1:<本实例端口>/`）⇒ 视为「用户可能正在通过浏览器使用本实例」。

- 标签页在、但窗口最小化或在后台，**一样算**——无法可靠知道用户什么时候回来看，按最保守的处理
- 用户用别的浏览器（Chrome/Edge/系统默认浏览器）打开 GUI ⇒ **不触发**

**处置**：凡是要操作页面的动作——导航、点击、输入、运行 JS、滚动、关闭/移动标签、改设置——先用 `browser_new_window` 把目标页以「同档案新窗口」打开，之后所有动作都带这个新窗口的 context id。

⛔ 不要在用户的窗口里 `navigate` / 点击 / 输入 / 关闭标签——那会把用户正在看的内容换掉。

| 概念 | 含义 |
|---|---|
| **同档案** | Firefox 单个实例内的新窗口天然共享同一 profile（cookie / 登录态 / 书签 / 历史都在）⇒ 直接 `browser_new_window` 即可 |
| ⛔ **不要**用 `launch-firefox.mjs`「为了隔离」 | 它带 `-no-remote --new-instance`，起的是另一个实例/另一个档案，登录态全空，还可能占满 BiDi 会话 |

- **只读动作不触发**：`browser_list_*` / `browser_get_*` / `browser_screenshot` 直接读用户窗口即可
- **例外**：用户明确说「就在当前标签做」时，按用户说的做
- **收工**：自己开的新窗口操作完默认关掉；若结果需要用户看（登录成功页 / 待确认的表单），保留并在答复里说明「我开了一个新窗口，标签是 X」
- 新窗口可能被系统带到前台。需要时用 `browser_activate_tab` 把用户的原标签切回前台

**为什么**：本实例 GUI 的标签页是用户的工作现场；在上面导航/切页/关闭，等于把用户正在看的东西换掉，代价远大于「另开一个窗口」。

## 三、需要「真人输入」时：配合 Cua

有两类动作绕不过去，但原因不同——**不是「BiDi 支持不了」这么笼统**：

- **HTML5 拖放**：BiDi 的 input 模块只有 `performActions` / `releaseActions` / `setFiles`，没有 CDP 那种 `Input.dispatchDragEvent`，只能用 pointer actions 模拟；而 Firefox 的模拟拖放有**未修复**的上游 bug（Bugzilla 1515879「HTML5 drag and drop doesn't work」，`resolution` 为空、无人认领），合成的 move 不会变成 `dragover`/`drop`。
- **DevTools 取色器**：这是 DevTools 私有 API（`inspector.pickColorFromPage`），**不在 BiDi 规范范围内**；且 Firefox 的实现要求真实指针事件，合成点击不认。

⇒ 这类用 **Cua**（真 SendInput/UIA）配合本 MCP：

1. `browser_element_screen_coords` 拿目标在**屏幕**上的坐标
2. Cua 用坐标点击/拖拽

⚠️ Cua 的 `scope:"desktop"` **不能带 `pid`/`window_id`**；桌面点击要求目标窗口在前台 ⇒ `bring_to_front` 之后**立刻**点击，中间别插别的调用。`press_key`（PostMessage）**不需要前台**，适合有快捷键/默认按钮的对话框。

### Cua 报 `this session has ended`

错误原文已经给了答案：`call start_session explicitly to reuse its label`。

| 项 | 事实 |
|---|---|
| 触发 | 对**已经 `end` 的 `session` 标签**继续调用 |
| 为什么「每调一次就断」 | DSH 的 Cua 接入是**进程内单例**，原样转发参数、不重建 session、不重试 |
| ✅ 恢复 | `start_session({session: 同一个标签})` 后复用；日常调用干脆不传 `session` |
| ⛔ 别做 | 不用重启 DSH；不用立刻换 PowerShell |

### Cua 的三条硬纪律

1. **同一时刻只让一个实例启用**——Cua 不预留桌面，多实例会抢鼠标键盘
2. **只做可逆动作**——已发出的输入收不回来；关键动作前先截图确认状态
3. **原生崩溃可能带走宿主**——Cua 与 DSH 共享进程，崩了会终止该实例；别在主力上做高危桌面操作

## 四、本地开发与验证（个人版）

```bash
npm install
npm run build            # tsc
npm run gen-docs         # 重生成 skills/browser-mcp/references/tools.md
npm run smoke            # 协议层冒烟（不需要浏览器）
npm run smoke:browser    # 起 Firefox + 18 个域只读调用 + 自动停
npm run smoke:browser -- --writes   # 再加 activate_tab 的 chrome 回退测试
```

`smoke-test.mjs` 通过**真实 MCP stdio 协议**驱动 `dist/index.js`，所以它同时验证
「能编译」和「能启动」。

环境变量：

| 变量 | 作用 |
|---|---|
| `DSH_BROWSER_BIDI_PORT` | BiDi 端口（默认 9222；MCP 会先读 dynamic-start 的端口文件） |
| `DSH_BROWSER_MARIONETTE_PORT` | Marionette 端口（默认 2828，仅 GPC 等用） |
| `DSH_BROWSER_MAX_OUTPUT_CHARS` | 单次工具返回上限（默认 1,000,000 字符） |
| `DSH_BROWSER_OUTPUT_DIR` | 超大结果落盘目录（默认系统临时目录） |
| `SMOKE_PROFILE` / `SMOKE_PORT` | 冒烟脚本用的测试档案与端口 |

**测试纪律**：冒烟脚本用独立测试档案（默认 `<系统临时目录>/BidiTest160`，可用 `SMOKE_PROFILE` 覆盖），
⛔ 不碰主力实例与主力档案；脚本自己起停 Firefox，但档案目录要自己删。
