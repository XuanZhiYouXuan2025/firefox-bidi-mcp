# 会话、窗口与容器

> 需要「保留现场」「恢复到某个状态」「把一组页面隔离开」时读这份。

## 一、保存与恢复整个会话

```
browser_save_session({ path: '<绝对路径>.json' })   ← 只读：把当前窗口+标签写进文件
... 做危险操作 / 让用户试用 / 关掉一些标签 ...
browser_restore_session({ path: '<同一个文件>' })   ← ⚠️ 会替换当前所有窗口和标签
```

**判据**：恢复后用 `browser_list_tabs` 核对标签数与 URL。

**陷阱**：
- `restore_session` 是**替换**不是合并。恢复前先 save 一次，否则现场的变更回不去。
- 文件是 Firefox 的 SessionStore 格式；⛔ 不要手改。
- 恢复会重新加载页面，**登录态和 localStorage 会保留**（同一档案），但页面内未提交的表单会丢。

## 二、窗口与视口

| 想要 | 工具 |
| --- | --- |
| 列出窗口及几何 | `browser_list_windows` |
| 当前窗口状态/位置/尺寸 | `browser_get_window_geometry` |
| 最大化/最小化/全屏 | `browser_set_window_state` |
| 移到屏幕坐标 | `browser_set_window_position`（多屏可以是负坐标） |
| 窗口像素尺寸 | `browser_set_window_size` |
| **页面视口**尺寸 | `browser_set_viewport`（影响截图分辨率） |

**判据**：改完用 `browser_get_window_geometry` 读回。

**陷阱**：
- `set_viewport` 的覆盖**跨会话持久**，而且会改变截图的像素尺寸 —— 用完要清（`viewport: null`，且**不要**同时传 devicePixelRatio）。
- `set_window_size` 是窗口像素，不是页面 CSS 像素；要模拟手机尺寸用 `set_viewport`。

## 三、容器（user context）隔离

```
browser_list_user_contexts()            ← "default" 永远存在
browser_create_container()              ← 返回新容器 id
browser_new_tab({ url, userContext: id })   ← 在该容器里开标签（cookie/storage 独立）
browser_remove_container({ id })        ← 丢弃容器里的一切
```

**判据**：同一个站点在两个容器里，登录态应互不影响。

**陷阱**：容器不是"隐身模式"，它只是隔离存储；指纹、IP、缓存仍共享。

## 四、多窗口协作

```
browser_new_window({ url })        ← 新窗口，拿到 context
browser_move_tab_to_window({ ... })  ← 把已有标签移到新窗口（多屏时有用）
browser_close_window({ context })  ← 关整个窗口
```

**判据**：`browser_list_windows` 里的窗口数符合预期。

**陷阱**：新窗口会抢前台。用户在看别的东西时，操作完用 `browser_activate_tab` 把他的标签切回去。
