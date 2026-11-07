# 常见任务的步骤配方

> 单点知识看 connection / recovery / debugging / extraction / interaction；
> 这份是**多步流程**：每一步用什么工具、在哪一步判断成败、常见失败怎么处理。
> 每个配方都按「做 → 验 → 失败怎么办」写，⛔ 不要只用眼睛看「应该成功了」。


## 零、已验证流程索引（先查这里，再考虑重探索）

**做法**：同一个站点/同一类任务第二次做时，先看这张表。命中就按记录的步骤走，不要再从头摸索；
**做完之后把新验证的流程补进来**（含站点、入口 URL、关键选择器、判据、失效迹象）。

| 流程 | 站点 / 场景 | 入口 | 关键判据 | 最后验证 |
| --- | --- | --- | --- | --- |
| （示例）采集搜索结果 | github.com | `/search?q=<kw>&type=issues` | 结果列表出现 `[data-testid="results-list"]` | 2026-11-07 |
| （示例）填登录表单 | 任意 | `browser_find_login_form` 先探字段 | 登录后标志出现（不是 URL 变化） | — |

**格式约定**：
- 「入口」写**可直接导航的 URL 或工具调用**，不要写「点那个按钮」
- 「关键判据」必须是**可程序化判断**的（选择器 / 文本 / 数量），不是「看起来好了」
- 「最后验证」写日期；**超过 3 个月没验证的按失效处理**，先重验再用

---

## 一、采集一个列表页的全部数据

```
1. browser_navigate({ url, wait: 'interactive' })
2. browser_wait_for({ selector: '<结果项选择器>', timeoutMs: 15000 })   ← 等结果，不等 spinner
3. browser_evaluate({ expression: '...JSON.stringify(rows)...' })        ← 一次取整页，别逐条查
4. 找"下一页"：browser_evaluate 查它的 href；有 → 步骤 1；没有 → 结束
5. 汇总
```

**判据**：第 2 步必须命中。等不到就是页面没加载出来，别硬调用第 3 步（会拿到空数组然后以为"没有数据"）。

**陷阱**：
- **虚拟列表/无限滚动只给你当前加载的**。判据：`rows.length` 在滚动前后是否变化。
- **分页大小可能被 URL 控制**（`?page=2&size=100`），优先改 URL 而不是点"下一页"。
- 数据量大时让 `browser_evaluate` 返回 `JSON.stringify`，输出层会落盘，不会撑爆上下文。

## 二、填一个真实表单

```
1. browser_find_login_form()        ← 若是登录/注册表单，先探字段名
2. browser_take_snapshot()          ← 拿到每个字段的 @eN
3. browser_fill_by_uid({ uid, value }) × N   ← 真实按键，框架受控输入也认
   （要一次填很多、且不担心受控组件时，可用 browser_fill_form 走一趟往返）
4. browser_evaluate 读回每个字段的 value  ← 验证真的写进去了
5. 提交：browser_click_by_uid({ uid: '@eN' })
6. browser_wait_for({ selector: '<成功标记>', timeoutMs: 20000 })
```

**为什么优先 UID**：CSS selector 一旦页面结构变了就可能选中别的元素（尤其是列表里的 `.btn`）；
UID 绑定到具体节点，元素没了会报错而不是点错。

**判据**：第 3 步的读回值必须与输入一致。**不一致 ⇒ 受控组件没接受直接赋值**，改用 `browser_type` 逐个敲。

**陷阱**：
- `browser_fill_form` 是**直接赋值 + 派发事件**，React/Vue 的受控输入可能丢弃它。
- 提交按钮可能是 `<button type="submit">`，也可能拦截在 JS 里 —— 优先用真实点击而不是 `form.submit()`。
- 提交后**不要立刻读结果**，先 `browser_wait_for` 等成功标记。

## 三、登录（用已有账号密码）

```
1. browser_find_login_form()                ← 看字段名和 action
2. browser_navigate({ url: '<登录页>' })
3. browser_fill_login({ origin, username, password, submit: true })
4. browser_wait_for({ selector: '<登录后标志>', timeoutMs: 20000 })
```

**判据**：登录后标志（用户头像、退出按钮、"我的"之类）出现才算成功，URL 变了不算。

**陷阱**：
- ⛔ 密码只能来自用户明确提供，并从工具参数直传；**不要写进日志、不要回显**。
- 需要验证码/短信/扫码 ⇒ 停下来告诉用户（见 [native-input](native-input.md) 的 Cua 路径）。

## 四、截长图 / 生成 PDF

```
- 视口截图：browser_screenshot({})
- 整页长图：browser_screenshot({ fullPage: true })        ← 内部滚动拼接，恢复滚动位置
- 单个滚动容器：browser_screenshot({ selector: '<容器>' })
- 正式文档：browser_pdf({})                                ← 覆盖整个文档，包括视口外的部分
```

**判据**：长图的像素高度应明显大于视口高度；若相等，说明 `fullPage` 没生效（页面本身不可滚动）。

**陷阱**：固定定位元素（`position: fixed` 的导航栏）在拼接长图时会重复出现或遮住内容 —— 需要时先临时隐藏它再截。

## 五、多标签并行任务

```
1. browser_new_window({ url: '<任务页>' }) 或 browser_new_tab({ url })
2. 记下返回的 context id
3. 之后所有页面动作都传 context: <id>      ← 不抢前台
4. 需要用户看结果时：browser_activate_tab({ context })
5. 收尾：browser_close_tab({ context }) / browser_close_window({ context })
```

**判据**：每一步的 `browser_page_info({ context })` 应是同一个 URL，**不会漂到别的标签**。

**陷阱**：
- ⛔ 不传 context 的工具会作用于**活动标签**——如果用户正在前台看别的页面，会误操作。
- 新窗口可能被系统带到前台（抢焦点）；需要时用 `browser_activate_tab` 把用户原来的标签切回去。
- 用户可能正在用这个浏览器 ⇒ 先读 [cooperation](cooperation.md)。

## 六、迁移书签 / 历史 / 密码（我们独有的能力）

```
书签：browser_bookmarks_export({ path })  →  换浏览器后 browser_bookmarks_import({ path })
历史：browser_import_history({ path })     ← JSON: [{url, title, lastVisit, visitCount}]
密码：browser_import_logins_from_file({ path })  ← JSON: [{origin, user, password}]
```

**判据**：导入后用对应的 `browser_list_*` 读回，条目数对得上。

**陷阱**（实测）：
- `origin` 会被归一化成 `scheme + host`，比对时要用归一化后的值。
- 书签导出是 Netscape HTML 格式，文件里没有收藏时间。
- 密码导入按 `origin + username` 去重，重复会被静默合并。

## 七、改设置并验证

```
1. browser_search_prefs({ query: '<关键词>' })   ← 先找到 pref 名
2. browser_get_pref({ name })                    ← 记下原值
3. browser_set_pref({ name, value })
4. browser_get_pref({ name })                    ← 读回确认
5. 收尾：改回原值（或用 browser_reset_pref 恢复默认）
```

**判据**：第 4 步读回的值等于写入值。**不等 ⇒ 这个 pref 被锁定或需要重启**。

**陷阱**：有些 pref 只在启动时读（如远程调试端口），改了要重启 Firefox 才生效 —— 在答复里说清楚。
