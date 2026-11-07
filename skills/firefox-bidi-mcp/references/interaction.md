# 交互语义（点击 / 输入 / 等待 / 拖拽）

> 动作不生效、或者"看起来点了但没反应"时读这份。

## 点击

`browser_click` 走**真实鼠标事件**（pointerMove → pointerDown → pointerUp），不是 `element.click()`。
所以：页面看到的是 `isTrusted: true` 的事件，依赖真实事件的行为（focus、hover 态）都会触发。

**前置条件**：元素必须能算出可见矩形。报 `selector did not match a visible element` 说明
选择器没匹配到、或者元素尺寸为 0（`display:none` / 尚未布局）。

## 输入

`browser_type` 也是真实按键事件（每个字符 keyDown + keyUp），不是直接写 `value`。
受控输入框（React/Vue 的 `onChange`）只有这种方式才会反应。

- 长文本按 **200 字符/批**发送（内部实现），几千字符不会有问题
- 输入前会自动 click 一次拿焦点；如果目标不可点击，先修可点击性

## 等待（我们没有内置 wait-for-element）

三条路，按推荐顺序：

1. **`browser_navigate` 的 `wait` 参数**：`complete`（默认）/ `interactive` / `none`。
   下载类 URL 用 `none`。
2. **轮询判断**（脚本里最常用）：
   ```
   browser_evaluate({ expression: "new Promise(r => { const t0 = Date.now(); const i = setInterval(() => { if (document.querySelector('#done')) { clearInterval(i); r('ok') } else if (Date.now() - t0 > 10000) { clearInterval(i); r('timeout') } }, 100) })" })
   ```
   注意 `awaitPromise: true`（工具默认开），返回的 `'timeout'` 要当失败处理。
3. **固定等待**：`browser_evaluate({ expression: "new Promise(r => setTimeout(r, 500))" })`——
   最不可靠，只在确认页面已经稳定时用于小延迟。

### 等待的竞态（重要）

"加载指示器消失"**可能早于加载开始**——指示器还没来得及出现就判定为"已完成"。
需要等结果时，**等一个结果标记**（成功提示、目标元素出现），不要等"指示器消失"。

## 可见 vs 可操作

| 判断 | 方法 |
| --- | --- |
| 元素存在 | `querySelector` 非 null |
| 元素可见 | `el.offsetParent !== null \|\| el.getClientRects().length > 0` |
| 元素可点 | 可见 + 没被 `disabled` + 没被遮挡（`document.elementFromPoint` 命中它） |

"存在" ≠ "可见" ≠ "可点击"——三步都要过。

## 拖拽 / 长按 / 鼠标按键

- `browser_drag`：真实按下-移动-松开；HTML5 拖放另见 `browser_drag_html5`（有上游 bug，见 [gotchas](gotchas.md)）
- `browser_key_hold`：按住 N 毫秒（游戏、修饰键）
- `browser_mouse_action`：右键/中键/双击/长按
- 这几个都会抢前台吗？**不会**——它们走 BiDi 的 `input.performActions`，对指定 context 生效
