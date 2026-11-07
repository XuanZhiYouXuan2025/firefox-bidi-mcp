# 从页面提取数据

> 需要把页面内容读成数据时读这份。核心原则：**宁可报"没找到"，也不要给看起来合理的假数据**。

## 四种读法怎么选

| 场景 | 工具 | 说明 |
| --- | --- | --- |
| 单个值、少量字段 | `browser_evaluate` | 返回 `JSON.stringify({...})` 再在宿主侧解析 |
| DOM 结构 / 层级 | `browser_dom_tree` | 有深度上限，大页面要分段 |
| 可访问性语义（角色/名称） | `browser_a11y_tree` | 对语义化页面比 DOM 更稳 |
| 原始 HTML | `browser_page_source` | 大页面会很大，优先用前两个 |

## 一次读多个值，而不是多次调用

```
browser_evaluate({
  expression: "JSON.stringify({ title: document.title, price: document.querySelector('#price')?.textContent ?? null })"
})
```

⛔ 不要为每个字段单独调一次 `browser_evaluate`——N 个字段 = N 次往返。

## 判据

- **`null` 就是 `null`**：选择器没匹配到要报出来，不要用"页面上应该没有"来圆。
- **分页 / 虚拟列表只给你当前加载的那部分**：滚动列表读到 50 条，不等于总共 50 条。
  结论要写成"当前已加载的 50 条"，不是"共 50 条"。
- **读取是瞬时快照**：读的过程中页面可能已经变了；需要一致性时连续读两次对比。
- **隐藏内容也会被读到**：`textContent` 包含 `display:none` 的元素。真判断"可见"用
  `el.offsetParent !== null || el.getClientRects().length > 0`。
- **富文本有格式噪音**：`textContent` 会把换行、空格、零宽字符一起带出来，必要时先 trim + 归一化。
- **表格优先按行取**：`Array.from(document.querySelectorAll('table tbody tr')).map(tr => [...tr.cells].map(td => td.textContent.trim()))`，
  比逐格查询快且不易错位。
