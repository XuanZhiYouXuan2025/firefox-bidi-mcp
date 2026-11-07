# 用 context 参数锁定目标标签页

> 从 SKILL.md §1.5 拆出。需要后台操作、不抢用户前台时读这份。

## 用 `context` 参数锁定目标标签页（2026-10-31 已升级工具）

**背景**：升级前 `browser_navigate` / `browser_evaluate` / `browser_click` / `browser_type` 的
`inputSchema` **没有** tab/context 参数，只作用于**当前活动标签页**；把窗口 id / tab id 传进去会被忽略，
动作落到用户前台标签页（实测把用户的 DSH GUI 导航到了 Z-Library）。

**2026-10-31 起**：以下页面工具已增加可选 **`context`** 参数
（browsing context id，来自 `browser_list_tabs`），`withPage`/`withBidi` 会优先用它而不是活动页：

`browser_navigate` · `browser_evaluate` · `browser_click` · `browser_type` ·
`browser_page_info` · `browser_screenshot` · `browser_scroll` · `browser_hover` · `browser_press_key`

⭐ **指定 `context` 时不需要 `activate_tab`，也不会抢前台**——BiDi 直接对目标 context 执行命令。
⚠️ **源码改了 dist 后必须重启 MCP 才生效**；重启不要 `Stop-Process -Force`（见 §1.2）。

**后台操作流程**（不抢用户前台）：

1. `browser_new_window { url: <目标页> }` 或 `browser_new_tab { url }` 拿到新标签的 **context id**；
2. 之后页面动作都传 `context: <该 id>`：
   `navigate { url, context }` · `evaluate { expression, context }` ·
   `click { selector, context }` · `type { selector, text, context }` ·
   `page_info { context }` · `screenshot { context }` · `scroll { deltaY, context }` ·
   `hover { selector, context }` · `press_key { key, context }`；
3. 用 `browser_list_tabs` 校验目标标签的 URL（只读，不切前台）；
4. 收工 `close_tab` / `close_window`。

**仍不支持 `context` 的工具**（如 `upload_file` / `pdf` / `mouse_action` / `set_viewport` 等，2026-10-31 时点）：
沿用旧流程——`activate_tab` 后操作，并用 `page_info` 校验；不支持 `context` 的工具会作用于活动标签页。

⛔ **不要**把窗口 id（clientWindow）当 tab context 传；两者不同，先用 `browser_list_tabs` 拿 context id。
