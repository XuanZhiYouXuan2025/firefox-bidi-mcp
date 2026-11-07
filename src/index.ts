/**
 * firefox-bidi-mcp — an MCP server that drives the whole Firefox browser.
 *
 * Design (see `.investigations/000-架构设计/架构设计-MCP化.md`):
 *  - ONE channel: a direct WebDriver BiDi WebSocket to Firefox. Page-level
 *    work (DOM, click, input, screenshots, network) and browser-chrome work
 *    (toolbars, prefs, windows, add-ons) both go through it — the chrome side
 *    via `browsingContext.getTree {moz:scope:"chrome"}` plus `script.evaluate`.
 *  - No browser extension is required, and none is planned: a user-clickable
 *    UI of our own is not needed.
 *  - Firefox must be launched with `--remote-debugging-port=<port>` and, to
 *    reach the chrome context, `MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1`.
 *
 * Human-in-the-loop (decided 2026-10-15): approval lives on the *MCP client*
 * side, not in the browser. Every tool therefore carries `annotations`, so a
 * client can require confirmation before the tools that actually change
 * something: `readOnlyHint: false` marks those, and `destructiveHint: true`
 * marks the ones whose effect outlives the session (prefs, navigation).
 */

import { z } from 'zod'
import { McpServer } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib'
import { BidiClient } from './bidi/client.js'
import { port } from './support/port.js'
import { currentClient, shutdown } from './support/connection.js'
import { registerAddons } from './tools/addons.js'
import { registerAutomation } from './tools/automation.js'
import { registerBookmarks } from './tools/bookmarks.js'
import { registerCertificates } from './tools/certificates.js'
import { registerMisc } from './tools/misc.js'
import { registerDevtools } from './tools/devtools.js'
import { registerExtensions } from './tools/extensions.js'
import { registerLogins } from './tools/logins.js'
import { registerHistory } from './tools/history.js'
import { registerInfo } from './tools/info.js'
import { registerNetwork } from './tools/network.js'
import { registerPage } from './tools/page.js'
import { registerPrefs } from './tools/prefs.js'
import { registerProfiler } from './tools/profiler.js'
import { registerPrompts } from './tools/prompts.js'
import { registerStorage } from './tools/storage.js'
import { registerInputExt } from './tools/input-ext.js'
import { registerTabOps } from './tools/tab-ops.js'
import { registerUi } from './tools/ui.js'
import { registerTabs } from './tools/tabs.js'
import { registerWindows } from './tools/windows.js'







// The MCP client closing stdin means this server is done; that path can still
// await, so the session is released properly instead of leaking.
process.stdin.once('end', () => {
  void shutdown().finally(() => process.exit(0))
})
process.stdin.once('close', () => {
  void shutdown().finally(() => process.exit(0))
})
process.once('SIGINT', () => {
  void shutdown().finally(() => process.exit(130))
})
process.once('SIGTERM', () => {
  void shutdown().finally(() => process.exit(143))
})
// Last resort: 'exit' handlers cannot await, but closing the socket is still
// better than leaving the connection open.
process.once('exit', () => {
  void currentClient()?.close()
})







// What the certificate preferences looked like before relax() touched them. Only as durable
// as this server process — restart the server (or Firefox) and it is gone, which the tool says.
let certPrefsBefore: Record<string, { hadUserValue: boolean; type: string; value: unknown }> | null = null

// Id of the preload script that hides navigator.webdriver (browser_hide_automation_flags).
let hideFlagsScriptId = ''












serveStdio(() => {
  const server = new McpServer(
    { name: 'firefox-bidi-mcp', version: '0.1.0' },
    { capabilities: { tools: {} } },
  )

  registerAddons(server)
  registerAutomation(server)
  registerBookmarks(server)
  registerCertificates(server)
  registerMisc(server)
  registerDevtools(server)
  registerExtensions(server)
  registerLogins(server)
  registerHistory(server)
  registerInfo(server)
  registerNetwork(server)
  registerPage(server)
  registerPrefs(server)
  registerProfiler(server)
  registerPrompts(server)
  registerStorage(server)
  registerInputExt(server)
  registerTabOps(server)
  registerUi(server)
  registerTabs(server)
  registerWindows(server)

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  


  

  

  

  

  

  

  return server
})
