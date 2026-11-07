# 网站问题排查

> 用户说"这个页面坏了/登录不上/数据不对"时读这份。工具：`browser_network_requests`、
> `browser_console_logs`、`browser_collect_response_body` + `browser_get_response_body`。

## 四步：记录 → 开收集 → 复现 → 读证据

1. **先写清楚两句话**：观察到什么问题、期望是什么。没有预期就没有"坏"。
2. **开收集器（必须在导航/复现之前）**：
   ```
   browser_collect_response_body({})
   ```
   ⚠️ 它是**事后补不回来的**——请求发生前没开，就没有响应体可读（与 BrowserSkill 的
   "earlier traffic cannot be recovered" 同理）。
3. **复现**：用 `browser_navigate` / `browser_click` / `browser_type` 走一遍，或者让用户自己操作。
4. **读证据**（按这个顺序，别跳）：
   | 看什么 | 工具 |
   | --- | --- |
   | 请求列表、状态码、耗时 | `browser_network_requests({ limit: 50 })` |
   | 某个请求的响应体 | `browser_get_response_body({ requestId })` |
   | 前端报错 | `browser_console_logs({})` |
   | 页面当前状态 | `browser_page_info` / `browser_evaluate` |
   | 页面渲染是否正常 | `browser_screenshot({ fullPage: true })` |
5. **收尾**：`browser_network_intercept({ action: "stop" })` 关掉拦截（collect 会开它）。

## 判据（这几条最容易判错）

- **HTTP 200 ≠ 业务成功**：接口返回 200 但 body 里是 `{"code":500}` 的情况很常见。**读 body**。
- **时序关联 ≠ 因果**：A 请求失败、B 请求也失败，不代表 B 是 A 引起的。只按实际记录说，
  不要编造中间步骤。
- **事件缓冲只有 500 条**：长时间操作后早期事件会被挤掉。关键请求的 `requestId` 要当场记下来。
- **console 的 source 要分清**：页面错误 / 扩展错误 / 浏览器错误，混在一起会误导。
- **`no matching network events` 不代表没请求**：可能是订阅时间太晚（本 MCP 在建立连接时订阅，
  连接之后才记录）。
- **响应体可能被压缩**：`browser_get_response_body` 已按 `content-encoding` 解压；如果预览仍是
  二进制，会明确输出字节数与头部 hex，不会给乱码。

## 常见的"看起来是网站问题、其实是环境问题"

| 现象 | 先排除 |
| --- | --- |
| 请求全部失败 | 本地服务没起 / 端口不对（curl 一下） |
| 登录态丢失 | 用的是测试档案（不含用户登录态），不是网站坏了 |
| 页面白屏 | `browser_page_source` 看是不是 `about:neterror`（导航失败页） |
| 某些请求 pending | `browser_network_intercept` 开着，请求被 hold 了 → `browser_network_continue_all` |
