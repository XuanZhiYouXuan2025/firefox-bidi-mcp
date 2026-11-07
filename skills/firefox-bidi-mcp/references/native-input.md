# 需要真人输入时（Cua 配合）

> 从 SKILL.md §四 拆出。HTML5 拖放、DevTools 取色器这类只认真实 OS 输入的动作读这份。

## 需要"真人输入"时（本 MCP 做不到的部分）

HTML5 拖放、DevTools 取色器这类**只认真实 OS 输入**的东西，
BiDi 的 `input.performActions` 和 PostMessage **都不行**。

⇒ 改用 **Cua**（真 SendInput/UIA）配合本 MCP：
1. `browser_element_screen_coords` 拿目标在**屏幕**上的坐标
2. Cua 用坐标点击/拖拽

⚠️ Cua 的 `scope:"desktop"` **不能带 `pid`/`window_id`**；桌面点击要求目标窗口在前台
⇒ `bring_to_front` 之后**立刻**点击，中间别插别的调用。
`press_key`（PostMessage）**不需要前台**，适合有快捷键/默认按钮的对话框。

### ⭐ Cua 报 `this session has ended`：先别换 PowerShell（可恢复）

⭐ **2026-10-18 查清：这是用法问题，不是 Cua 坏了。** 错误原文已经给了答案：
`call start_session explicitly to reuse its label`。

| 项 | 事实 |
|---|---|
| 触发 | 对**已经 `end` 的 `session` 标签**继续调用；`list_sessions` 这类依赖 transport lease 的工具在嵌入式 SDK 下也报同一句（本来就不可用） |
| 为什么「每调一次就断」 | DSH 的 Cua 接入是**进程内单例**，原样转发参数、**不重建 session、不重试** ⇒ 持续带同一个已结束标签就一直报 |
| ✅ 恢复 | `start_session({session:「同一个标签」})` 后复用；**日常调用干脆不传 `session`**（隐式 session 自动管理） |
| ⛔ 别做 | 不用重启 DSH；不用立刻换 PowerShell |

**只有 `start_session` 也救不回来（驱动真的崩了）时，才走下面的 PowerShell 退路。**

### Cua 真不可用时的退路（PowerShell）

Cua 报 `this session has ended` 且 `start_session` 后仍不可用时，别硬耗，直接换 PowerShell：

```powershell
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class M {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int ht, bool repaint);
}
'@
[M]::SetCursorPos(893, 563); Start-Sleep -Milliseconds 300
[M]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero)   # 左键按下
[M]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero)   # 左键抬起
```

⚠️ **对话框可能跑到屏幕外**（右边/下面都看不到按钮）。
`MoveWindow(hwnd, x, y, w, ht, true)` 拉回可见区域再点 —— `hwnd` 取自 `(Get-Process -Id <pid>).MainWindowHandle`。

**取坐标的办法**：全屏截图 → `PIL` 裁剪目标区域 → 放大 → 目测像素坐标 → 按缩放比例换算回原图。
（`cua_driver_native__set_window_frame` 对这类 Electron 对话框经常报
`window frame did not settle`，直接用 `MoveWindow` 更可靠。）

### ⭐ Cua 的三条硬纪律（上游风险，务必遵守）

1. **同一时刻只让一个实例启用** —— Cua 不预留桌面，多实例会抢鼠标键盘。
2. **只做可逆动作** —— 取消不承诺回滚，已发出的输入收不回来；关键动作前先截图确认状态。
3. **原生崩溃可能带走宿主** —— Cua 与 DSH 共享进程，崩了会终止该实例；别在主力上做高危桌面操作。
