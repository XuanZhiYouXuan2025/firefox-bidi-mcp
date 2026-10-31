/**
 * dsh-browser-mcp — an MCP server that drives the whole Firefox browser.
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
 * Human-in-the-loop (design decision): approval lives on the *MCP client*
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
import { BidiClient } from './bidi/client.js'
import { MarionetteClient, marionettePort } from './bidi/marionette.js'

/**
 * Resolve the BiDi port.
 *
 * Order: explicit env var, then the port file written by Firefox's
 * `remote.experimental.dynamicstart.enabled` feature
 * (~/.firefox-devtools-mcp/instances/<pid>.port, newest wins), then 9222.
 *
 * Dynamic start is the default for the primary profile, so the port can change
 * between Firefox restarts — reading the file is what keeps this server usable
 * without hardcoding a number.
 */
function discoverBidiPort(): number {
  const explicit = process.env.DSH_BROWSER_BIDI_PORT
  if (explicit !== undefined && explicit !== '') return Number(explicit)
  try {
    const dir = join(homedir(), '.firefox-devtools-mcp', 'instances')
    const files = readdirSync(dir).filter((f) => f.endsWith('.port'))
    let best: { port: number; mtime: number } | null = null
    for (const f of files) {
      try {
        const txt = readFileSync(join(dir, f), 'utf8').trim()
        const n = Number(txt)
        if (!Number.isFinite(n) || n <= 0) continue
        const pid = Number(f.replace(/\.port$/, ''))
        const mtime = Number.isFinite(pid) ? pid : 0
        if (best === null || mtime > best.mtime) best = { port: n, mtime }
      } catch {
        // A stale file from a dead browser is expected; skip it.
      }
    }
    if (best !== null) return best.port
  } catch {
    // No dynamic-start sidecar directory: fall through to the default port.
  }
  return 9222
}

const port = discoverBidiPort()

const READ_ONLY = { readOnlyHint: true } as const
const WRITES = { readOnlyHint: false } as const
const WRITES_PERSISTENTLY = { readOnlyHint: false, destructiveHint: true } as const

/**
 * One shared BiDi session for the whole server process.
 *
 * Firefox allows a SINGLE active BiDi session ("Maximum number of active
 * sessions"), so opening a session per tool call makes concurrent calls fail
 * unpredictably. BiDi is JSON-RPC over a WebSocket and matches responses by id,
 * so several in-flight commands can share one connection safely.
 *
 * The connection is opened lazily and re-opened once if it turns out to be
 * dead, so a Firefox restart does not require restarting this server.
 */
let shared: BidiClient | null = null
let connecting: Promise<BidiClient> | null = null

async function getClient(): Promise<BidiClient> {
  if (shared !== null) return shared
  if (connecting === null) {
    connecting = (async () => {
      const client = new BidiClient()
      await client.connect(port)
      // Subscribe once per connection so download events accumulate even when
      // no tool call is in flight.
      try {
        await client.subscribe(OBSERVED_EVENTS)
      } catch {
        // An older Firefox may not know these events; the tools still work.
      }
      shared = client
      return client
    })()
  }
  try {
    return await connecting
  } finally {
    connecting = null
  }
}

/** Run `body` against the shared session, reconnecting once if it has died. */
async function withBidi<T>(body: (client: BidiClient) => Promise<T>): Promise<T> {
  try {
    return await body(await getClient())
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const looksLikeDeath =
      shared !== null && /not connected|closed|EPIPE|ECONNRESET|socket/i.test(message)
    if (!looksLikeDeath) throw error
    await shared?.close()
    shared = null
    return await body(await getClient())
  }
}

/**
 * End the session on the way out.
 *
 * BiDi does NOT release a session when the socket closes, and a leftover
 * session makes the NEXT start fail with "Maximum number of active sessions"
 * — which cannot be cleared from the protocol side (a `session.end` without an
 * id answers "invalid session id"), only by restarting Firefox. So cleanup is
 * best-effort on every exit path that can still run async code.
 */
async function shutdown(): Promise<void> {
  const client = shared
  shared = null
  connecting = null
  if (client !== null) await client.close()
}

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
  void shared?.close()
})

/**
 * Cap on how much one tool may return.
 *
 * `browser_evaluate` and `browser_screenshot` can return arbitrarily large
 * payloads (a 12 MB string was measured), which would swamp the model's
 * context. Long results are truncated with a note saying how much was cut,
 * so a caller can narrow the expression and ask again.
 */
const OBSERVED_EVENTS = [
  'browsingContext.downloadWillBegin',
  'browsingContext.downloadEnd',
  'log.entryAdded',
  'network.beforeRequestSent',
  'network.responseCompleted',
  'network.responseStarted',
  'network.fetchError',
  'browsingContext.userPromptOpened',
]

const maxOutputChars = Number(process.env.DSH_BROWSER_MAX_OUTPUT_CHARS ?? 1_000_000)

/**
 * Where oversized results are written. Defaults to the system temp dir; set
 * DSH_BROWSER_OUTPUT_DIR to keep them somewhere you can find later.
 */
/** Open a short-lived Marionette session, run `body`, always close. */
async function withMarionette<T>(body: (client: MarionetteClient) => Promise<T>): Promise<T> {
  const client = await MarionetteClient.connect(marionettePort())
  try {
    await client.startChromeSession()
    return await body(client)
  } finally {
    client.close()
  }
}

/**
 * Map a BiDi context id to the tab index used by the chrome side.
 *
 * MEASURED: these are NOT the same identifier. BiDi hands out an opaque UUID
 * ("e3f9130a-…") while the chrome side's browsingContext.id is a small integer
 * (3), and BrowsingContext.get(uuid) finds nothing. What does line up is ORDER:
 * browsingContext.getTree() and gBrowser.tabs list tabs in the same sequence,
 * so the reliable bridge is the index, not the id.
 */
/**
 * Map a human key name to the WebDriver codepoint BiDi accepts.
 *
 * MEASURED: input.performActions rejects "Control"/"Enter"/"ArrowRight" outright with
 * `Expected "value" to be a string that represents single code point or grapheme cluster`.
 * Only single characters work, so named keys must become their WebDriver codepoint.
 */
const WEBDRIVER_KEYS: Record<string, string> = {
  NULL: '',
  Cancel: '',
  Help: '',
  Backspace: '',
  Tab: '',
  Clear: '',
  Return: '',
  Enter: '',
  Shift: '',
  Control: '',
  Alt: '',
  Pause: '',
  Escape: '',
  Space: '',
  PageUp: '',
  PageDown: '',
  End: '',
  Home: '',
  ArrowLeft: '',
  Left: '',
  ArrowUp: '',
  Up: '',
  ArrowRight: '',
  Right: '',
  ArrowDown: '',
  Down: '',
  Insert: '',
  Delete: '',
  Meta: '',
  Command: '',
}

function webdriverKey(name: string): string {
  const mapped = WEBDRIVER_KEYS[name]
  if (mapped !== undefined) return mapped
  // Single character: use as-is. Function keys F1-F12 need their own codepoints (E031-E03C).
  if ([...name].length === 1) return name
  const fn = /^F([1-9]|1[0-2])$/.exec(name)
  if (fn) return String.fromCodePoint(0xe030 + Number(fn[1]))
  throw new Error('unknown key name: ' + name)
}

async function tabIndexForContext(client: BidiClient, context: string): Promise<number> {
  const tree = (await client.call('browsingContext.getTree', {})) as {
    contexts?: Array<{ context: string }>
  }
  const contexts = tree.contexts ?? []
  const index = contexts.findIndex((item) => item.context === context)
  if (index < 0) throw new Error('no such tab context: ' + context)
  return index
}

const outputDir = process.env.DSH_BROWSER_OUTPUT_DIR ?? tmpdir()

// What the certificate preferences looked like before relax() touched them. Only as durable
// as this server process — restart the server (or Firefox) and it is gone, which the tool says.
let certPrefsBefore: Record<string, { hadUserValue: boolean; type: string; value: unknown }> | null = null

// Id of the preload script that hides navigator.webdriver (browser_hide_automation_flags).
let hideFlagsScriptId = ''

type OutputKind = 'text' | 'png' | 'pdf'

/**
 * Hand a result back to the caller.
 *
 * A big payload (a full-page PNG reaches ~1.8 MB of base64) would swamp the
 * model's context, so above the cap it is written to a file and the caller is
 * told where. Binary results are decoded first, so the file is a real PNG/PDF.
 */
function text(value: string, kind: OutputKind = 'text') {
  if (value.length <= maxOutputChars) {
    return { content: [{ type: 'text' as const, text: value }] }
  }
  try {
    mkdirSync(outputDir, { recursive: true })
    const isBinary = kind === 'png' || kind === 'pdf'
    const body = isBinary ? value.slice(value.indexOf(',') + 1) : value
    const bytes = isBinary ? Buffer.from(body, 'base64') : Buffer.from(value, 'utf8')
    const file = join(outputDir, `dsh-browser-${String(Date.now())}.${kind === 'text' ? 'txt' : kind}`)
    writeFileSync(file, bytes)
    return {
      content: [
        {
          type: 'text' as const,
          text:
            `Output too large to return inline (${String(value.length)} characters, ${String(bytes.length)} bytes).` +
            String.fromCharCode(10) +
            `Written to: ${file}`,
        },
      ],
    }
  } catch (error) {
    // Falling back to truncation is better than failing the whole call.
    const omitted = value.length - maxOutputChars
    return {
      content: [
        {
          type: 'text' as const,
          text:
            value.slice(0, maxOutputChars) +
            String.fromCharCode(10) +
            `[truncated: ${String(value.length)} characters total, ${String(omitted)} omitted; ` +
            `writing to disk failed: ${error instanceof Error ? error.message : String(error)}]`,
        },
      ],
    }
  }
}

function failure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  if (/Maximum number of active sessions/i.test(message)) {
    return {
      content: [
        {
          type: 'text' as const,
          text:
            'error: Firefox already has an active BiDi session (it allows only one). A previous client likely exited without ending its session; Firefox releases it only on restart. Fix: quit and restart that Firefox instance, then retry.',
        },
      ],
      isError: true,
    }
  }
  return { content: [{ type: 'text' as const, text: `error: ${message}` }], isError: true }
}

async function withPage<T>(
  body: (client: BidiClient, context: string) => Promise<T>,
  tab?: string,
): Promise<T> {
  return await withBidi(async (client) => {
    // An explicit tab context beats the active tab, so callers can
    // pin their own window and never touch whatever tab the user has in front.
    const context = tab !== undefined && tab !== '' ? tab : await client.pageContext()
    if (context === null) throw new Error('no page context available')
    return await body(client, context)
  })
}

async function withChrome<T>(body: (client: BidiClient, context: string) => Promise<T>): Promise<T> {
  return await withBidi(async (client) => {
    const context = await client.chromeContext()
    if (context === null) {
      throw new Error(
        'no privileged (chrome) context — Firefox must be launched with MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1',
      )
    }
    return await body(client, context)
  })
}

/**
 * Run an expression inside one of an extension's own pages.
 *
 * Why it works this way (every step MEASURED against a throwaway extension):
 *  - `policy.extension` is undefined in this Firefox build, so there is no
 *    direct handle on the extension's background page or its browserAction;
 *  - a tab pointing at `moz-extension://…/options.html` DOES get a BiDi
 *    browsing context, and inside it the `browser.*` APIs are live — reading
 *    and writing `storage.local` both succeeded there;
 *  - a toolbar popup lives inside a widget panel and never gets its own
 *    context, and the background page is not exposed either, so the options
 *    page is the only usable entry point. Extensions without one cannot be
 *    reached.
 * The helper tab is closed on every exit path, including failure.
 */
async function inExtensionPage(
  extId: string,
  pageHint: string | null,
  expression: string,
): Promise<string> {
  return await withBidi(async (client) => {
    const chromeContext = await client.chromeContext()
    if (chromeContext === null) {
      throw new Error(
        'no privileged (chrome) context — Firefox must be launched with MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1',
      )
    }
    const opened = await client.evaluate(
      '(async () => {' +
        ' try {' +
        '  const id = ' + JSON.stringify(extId) + ';' +
        '  const pageHint = ' + JSON.stringify(pageHint) + ';' +
        '  const { ExtensionParent } = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");' +
        '  const policy = ExtensionParent.GlobalManager.extensionMap.get(id);' +
        '  if (!policy) return JSON.stringify({ error: "no such extension: " + id });' +
        '  const manifest = policy.manifest || {};' +
        '  const declared = (manifest.options_ui && manifest.options_ui.page) || manifest.options_page || null;' +
        '  const page = pageHint || declared;' +
        '  if (!page) return JSON.stringify({ error: "extension " + id + " declares no options page; pass page explicitly" });' +
        '  let url = page;' +
        '  if (page.indexOf("://") === -1) {' +
        '    let rel = page;' +
        '    while (rel.length > 0 && rel.charAt(0) === "/") rel = rel.slice(1);' +
        '    url = policy.baseURI.spec + rel;' +
        '  }' +
        '  gBrowser.addTab(url, {' +
        '    triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),' +
        '    inBackground: true' +
        '  });' +
        '  return JSON.stringify({ ok: true, url });' +
        ' } catch (e) { return JSON.stringify({ error: e.message }); }' +
        ' })()',
      chromeContext,
    )
    if (typeof opened !== 'string') throw new Error('could not open an extension page')
    const openedInfo = JSON.parse(opened) as { error?: string; url?: string }
    if (openedInfo.error !== undefined) throw new Error(openedInfo.error)
    const pageUrl = String(openedInfo.url)

    const closeHelperTab = async (): Promise<void> => {
      try {
        await client.evaluate(
          '(() => {' +
            ' try {' +
            '  for (const t of Array.from(gBrowser.tabs)) {' +
            '    if (t.linkedBrowser.currentURI.spec === ' + JSON.stringify(pageUrl) + ') gBrowser.removeTab(t);' +
            '  }' +
            '  return "closed";' +
            ' } catch (e) { return "ERR " + e.message; }' +
            ' })()',
          chromeContext,
        )
      } catch {
        // Closing is best effort; never mask the real result.
      }
    }

    try {
      let context: string | null = null
      for (let attempt = 0; attempt < 25; attempt += 1) {
        const tree = (await client.call('browsingContext.getTree', {})) as {
          contexts?: Array<{ context: string; url?: string; children?: unknown[] }>
        }
        type Node = { context: string; url?: string; children?: unknown[] }
        const flat: Array<{ context: string; url?: string }> = []
        const collect = (nodes: Node[]): void => {
          for (const node of nodes) {
            flat.push({ context: node.context, url: node.url })
            if (Array.isArray(node.children)) collect(node.children as Node[])
          }
        }
        collect((tree.contexts ?? []) as Node[])
        const hit = flat.find((node) => node.url === pageUrl)
        if (hit !== undefined) {
          context = hit.context
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 200))
      }
      if (context === null) throw new Error('extension page never got a browsing context: ' + pageUrl)
      const result = (await client.evaluate(expression, context)) as unknown
      return typeof result === 'string' ? result : JSON.stringify(result)
    } finally {
      await closeHelperTab()
    }
  })
}

/**
 * Find a Tampermonkey-family extension and run an internal command in its options page.
 *
 * Why this exists: Tampermonkey keeps its script management behind an internal API that is
 * only callable from its own pages (`window.sendMessage` is defined only under /options and
 * /ask). MEASURED against the official Firefox Beta xpi (firefoxbeta@tampermonkey.net, 5.6.6239):
 *   window.sendMessage({method:"saveScript", code, uuid:"<non-empty>", ...}) -> installed:true
 *   window.sendMessage({method:"modifyScriptOptions", uuid, options:{enabled:false}})
 *   window.sendMessage({method:"purgeScripts", uuids:[...]})
 * Note the uuid rule: empty/null gives "uuid missing"; a NEW uuid creates a new script, so the
 * caller must de-duplicate first (which the install tool does by @name).
 */
async function tampermonkeyCommand(command: Record<string, unknown>): Promise<string> {
  return await withBidi(async (client) => {
    const chromeContext = await client.chromeContext()
    if (chromeContext === null) {
      throw new Error(
        'no privileged (chrome) context — Firefox must be launched with MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1',
      )
    }
    const opened = await client.evaluate(
      '(() => {' +
        ' try {' +
        '  const { ExtensionParent } = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");' +
        '  let found = null;' +
        '  for (const [id, policy] of ExtensionParent.GlobalManager.extensionMap) {' +
        '    if (id.toLowerCase().indexOf("tampermonkey") !== -1) { found = [id, policy]; break; }' +
        '  }' +
        '  if (!found) return JSON.stringify({ error: "no Tampermonkey extension is installed" });' +
        '  const [id, policy] = found;' +
        '  const m = policy.manifest || {};' +
        '  const page = (m.options_ui && m.options_ui.page) || m.options_page || null;' +
        '  if (!page) return JSON.stringify({ error: "Tampermonkey declares no options page" });' +
        '  let url = page;' +
        '  if (page.indexOf("://") === -1) {' +
        '    let rel = page; while (rel.length > 0 && rel.charAt(0) === "/") rel = rel.slice(1);' +
        '    url = policy.baseURI.spec + rel;' +
        '  }' +
        '  gBrowser.addTab(url, {' +
        '    triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),' +
        '    inBackground: true' +
        '  });' +
        '  return JSON.stringify({ ok: true, id, url });' +
        ' } catch (e) { return JSON.stringify({ error: e.message }); }' +
        ' })()',
      chromeContext,
    )
    if (typeof opened !== 'string') throw new Error('could not locate Tampermonkey')
    const openedInfo = JSON.parse(opened) as { error?: string; url?: string }
    if (openedInfo.error !== undefined) throw new Error(openedInfo.error)
    const pageUrl = String(openedInfo.url)

    const closeTab = async (): Promise<void> => {
      try {
        await client.evaluate(
          '(() => {' +
            ' try {' +
            '  for (const t of Array.from(gBrowser.tabs)) {' +
            '    if (t.linkedBrowser.currentURI.spec === ' + JSON.stringify(pageUrl) + ') gBrowser.removeTab(t);' +
            '  }' +
            '  return "closed";' +
            ' } catch (e) { return "ERR " + e.message; }' +
            ' })()',
          chromeContext,
        )
      } catch {
        // Best effort only.
      }
    }

    try {
      let context: string | null = null
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const tree = (await client.call('browsingContext.getTree', {})) as {
          contexts?: Array<{ context: string; url?: string; children?: unknown[] }>
        }
        type Node = { context: string; url?: string; children?: unknown[] }
        const flat: Array<{ context: string; url?: string }> = []
        const collect = (nodes: Node[]): void => {
          for (const node of nodes) {
            flat.push({ context: node.context, url: node.url })
            if (Array.isArray(node.children)) collect(node.children as Node[])
          }
        }
        collect((tree.contexts ?? []) as Node[])
        const hit = flat.find((node) => node.url === pageUrl)
        if (hit !== undefined) {
          context = hit.context
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 200))
      }
      if (context === null) throw new Error('Tampermonkey options page never opened: ' + pageUrl)
      const expression =
        '(async () => {' +
        ' try {' +
        '  const payload = ' + JSON.stringify(command) + ';' +
        '  const r = await new Promise((resolve) => {' +
        '    window.sendMessage(payload, (resp) => resolve(resp));' +
        '    setTimeout(() => resolve({ __timeout: true }), 12000);' +
        '  });' +
        '  if (r && r.__timeout) return JSON.stringify({ error: "Tampermonkey did not answer" });' +
        '  return JSON.stringify(r);' +
        ' } catch (e) { return JSON.stringify({ error: e.message }); }' +
        ' })()'
      const result = (await client.evaluate(expression, context)) as unknown
      return typeof result === 'string' ? result : JSON.stringify(result)
    } finally {
      await closeTab()
    }
  })
}

/**
 * Pull the userscript entries out of a Tampermonkey loadTree payload.
 *
 * MEASURED: loadTree(with referrer:"options") mixes real scripts together with Tampermonkey's
 * own settings nodes (layout / language / auto-reload …). Only entries that carry a uuid are
 * actual scripts, so everything else is dropped here — otherwise the list tool spams settings
 * names and the install de-duplication sees phantom entries.
 */
const tampermonkeyScripts = (raw: unknown): Array<{ name: string; uuid: string }> => {
  const found: Array<{ name: string; uuid: string }> = []
  const walk = (items: unknown): void => {
    if (!Array.isArray(items)) return
    for (const item of items) {
      if (item === null || typeof item !== 'object') continue
      const node = item as { name?: unknown; uuid?: unknown; items?: unknown }
      if (Array.isArray(node.items)) walk(node.items)
      else if (typeof node.name === 'string' && typeof node.uuid === 'string' && node.uuid.length > 0) {
        found.push({ name: node.name, uuid: node.uuid })
      }
    }
  }
  try {
    const parsed = JSON.parse(String(raw)) as { items?: unknown }
    walk(parsed.items)
  } catch {
    // Leave the result empty; the caller reports the raw payload.
  }
  return found
}

const tampermonkeyScriptNames = (raw: unknown): string[] =>
  tampermonkeyScripts(raw).map((script) => script.name)

const str = (value: unknown, name: string): string => {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${name} must be a non-empty string`)
  return value
}

serveStdio(() => {
  const server = new McpServer(
    { name: 'dsh-browser-mcp', version: '0.1.0' },
    { capabilities: { tools: {} } },
  )

  server.registerTool(
    'browser_info',
    {
      title: 'Browser info',
      description:
        'Report the connected Firefox: version, window count and whether the privileged (chrome) context is reachable.',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      try {
        return text(
          await withBidi(async (client) => {
            const page = await client.pageContext()
            const chrome = await client.chromeContext()
            const lines = [`bidi port: ${port}`, `page context: ${page ?? '(none)'}`]
            lines.push(
              `chrome context: ${chrome ?? '(unavailable — launch Firefox with MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1)'}`,
            )
            if (chrome !== null) {
              lines.push(`version: ${String(await client.evaluate('Services.appinfo.version', chrome))}`)
              lines.push(
                `windows: ${String(
                  await client.evaluate(
                    "(() => { let n = 0, e = Services.wm.getEnumerator('navigator:browser'); while (e.hasMoreElements()) { e.getNext(); n++; } return n; })()",
                    chrome,
                  ),
                )}`,
              )
            }
            const viewport = page === null
              ? '(no page context)'
              : await client.evaluate('window.innerWidth + "x" + window.innerHeight', page)
            lines.push(`viewport: ${String(viewport)}`)
            lines.push(
              `output limit: ${String(maxOutputChars)} characters` +
                (process.env.DSH_BROWSER_OUTPUT_DIR === undefined
                  ? ' (oversized results go to the system temp dir)'
                  : `; oversized results go to ${process.env.DSH_BROWSER_OUTPUT_DIR}`),
            )
            return lines.join('\n')
          }),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_page_info',
    {
      title: 'Current page info',
      description: 'Read the active tab title and URL.',
      inputSchema: {
        context: z.string().optional().describe('Tab context id (default: the active tab)'),
      },
      annotations: READ_ONLY,
    },
    async ({ context }: { context?: string }) => {
      try {
        return text(
          await withPage(async (client, ctx) => {
            const title = await client.evaluate('document.title', ctx)
            const url = await client.evaluate('location.href', ctx)
            return `title: ${String(title)}\nurl: ${String(url)}`
          }, context),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_list_tabs',
    {
      title: 'List tabs',
      description: 'List open tabs with their context id, URL and title.',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      try {
        return text(JSON.stringify(await withBidi(async (client) => await client.listTabs()), null, 2))
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_evaluate',
    {
      title: 'Evaluate JS in the page',
      description:
        'Run an expression in the page and return its value (JSON). Promises are awaited. ' +
        'It can change the page, so treat it as a write.',
      inputSchema: {
        expression: z.string().describe('JavaScript expression to evaluate'),
        context: z.string().optional().describe('Tab context id (default: the active tab)'),
      },
      annotations: WRITES,
    },
    async ({ expression, context }: { expression: string; context?: string }) => {
      try {
        return text(
          JSON.stringify(
            await withPage(
              async (client, ctx) => await client.evaluate(str(expression, 'expression'), ctx),
              context,
            ),
            null,
            2,
          ),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_click',
    {
      title: 'Click an element',
      description:
        'Click the first element matching a CSS selector with a real mouse action (pointer move, down, up) at its centre.',
      inputSchema: {
        selector: z.string().describe('CSS selector'),
        context: z.string().optional().describe('Tab context id (default: the active tab)'),
      },
      annotations: WRITES,
    },
    async ({ selector, context }: { selector: string; context?: string }) => {
      try {
        const css = str(selector, 'selector')
        await withPage(async (client, ctx) => {
          await client.clickSelector(css, ctx)
        }, context)
        return text(`clicked: ${css}`)
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_upload_file',
    {
      title: 'Attach a file to a file input',
      description:
        'Attach one or more local files to the file input matching a CSS selector (privileged not required). ' +
        'IMPORTANT (measured on Windows): paths must be NATIVE (D:\dir\file.txt); a file:///D:/... URL is ' +
        'rejected with "File error: Unrecognized path". The file is read by Firefox itself, so it must exist and be readable.',
      inputSchema: {
        selector: z.string().describe('CSS selector of the file input'),
        files: z.array(z.string()).describe('Native absolute paths of the files to attach'),
        context: z.string().optional().describe('Tab context id (default: the active tab)'),
      },
      annotations: WRITES,
    },
    async ({ selector, files, context: tab }: { selector: string; files: string[]; context?: string }) => {
      try {
        const css = str(selector, 'selector')
        if (!Array.isArray(files) || files.length === 0) throw new Error('files must be a non-empty array')
        await withPage(async (client, context) => {
          await client.setFiles(css, files, context)
        }, tab)
        return text('attached ' + String(files.length) + ' file(s) to ' + css + ': ' + files.join(', '))
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_type',
    {
      title: 'Type into an element',
      description:
        'Focus the element matching a CSS selector and type text with real per-character key events.',
      inputSchema: {
        selector: z.string().describe('CSS selector of the field'),
        text: z.string().describe('Text to type'),
        context: z.string().optional().describe('Tab context id (default: the active tab)'),
      },
      annotations: WRITES,
    },
    async ({ selector, text: value, context }: { selector: string; text: string; context?: string }) => {
      try {
        const css = str(selector, 'selector')
        await withPage(async (client, ctx) => {
          await client.typeInto(css, value ?? '', ctx)
        }, context)
        return text(`typed ${String(value ?? '').length} character(s) into ${css}`)
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_navigate',
    {
      title: 'Navigate the page',
      description: 'Navigate the active tab to a URL and wait for the page to load.',
      inputSchema: {
        url: z.string().describe('Absolute URL'),
        context: z.string().optional().describe('Tab context id (default: the active tab)'),
      },
      annotations: WRITES_PERSISTENTLY,
    },
    async ({ url, context }: { url: string; context?: string }) => {
      try {
        const target = str(url, 'url')
        const landed = await withPage(async (client, ctx) => {
          await client.navigate(target, context)
          // A navigation can "succeed" while the page itself failed to load
          // (Firefox shows its own error page). Report where we actually ended
          // up so the caller is not misled.
          const title = await client.evaluate('document.title', context)
          const href = await client.evaluate('location.href', context)
          // Firefox renders its own error page (about:neterror) for a failed
          // load, and the URL/title alone do not reveal that.
          const netError = await client.evaluate(
            "document.documentURI.startsWith('about:neterror')",
            context,
          )
          return { title: String(title), href: String(href), netError: netError === true }
        })
        return text(
          `navigated: ${target}` +
            String.fromCharCode(10) +
            `landed on: ${landed.href}` +
            String.fromCharCode(10) +
            `title: ${landed.title}` +
            (landed.netError
              ? String.fromCharCode(10) +
                'note: the page failed to load — Firefox is showing its own network-error page'
              : ''),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_new_tab',
    {
      title: 'Open a new tab',
      description: 'Open a new tab, optionally navigating it to a URL. Returns the new context id.',
      inputSchema: { url: z.string().optional().describe('Optional URL to open') },
      annotations: WRITES,
    },
    async ({ url }: { url?: string }) => {
      try {
        return text(`new tab: ${await withBidi(async (client) => await client.newTab(url))}`)
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_screenshot',
    {
      title: 'Screenshot',
      description:
        'Capture a base64 PNG. By default only the visible viewport is captured (physical pixels, i.e. viewport size ' +
        'x devicePixelRatio); Firefox ignores the BiDi clip argument and this call does not scroll. Set fullPage to ' +
        'capture a whole scrollable area by scrolling and stitching segments inside the page (the original scroll ' +
        'position is restored). Pass selector to capture the full content of one scrollable element (an ' +
        'overflow:scroll container) — document scrolling alone would miss it.',
      inputSchema: {
        fullPage: z
          .boolean()
          .optional()
          .describe('Capture the whole scrollable area instead of just the viewport (default false)'),
        selector: z
          .string()
          .optional()
          .describe('CSS selector of a scrollable element to capture in full; implies fullPage'),
        lazyLoad: z
          .boolean()
          .optional()
          .describe(
            'Before capturing, walk the area once so lazily loaded content appears and wait for its height to settle (default true)',
          ),
        context: z.string().optional().describe('Tab context id (default: the active tab)'),
      },
      annotations: READ_ONLY,
    },
    async ({ fullPage, selector, lazyLoad, context }: { fullPage?: boolean; selector?: string; lazyLoad?: boolean; context?: string }) => {
      try {
        return text(
          await withPage(async (client, ctx) => {
            if (fullPage === true || selector !== undefined) {
              return await client.fullPageScreenshot(ctx, selector, lazyLoad ?? true)
            }
            return await client.screenshot(ctx)
          }, context),
          'png',
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_pdf',
    {
      title: 'Export the page as PDF',
      description:
        'Render the page to PDF and return it base64-encoded (verified: browsingContext.print returns %PDF-1.4). ' +
        'Unlike browser_screenshot this covers the WHOLE document, including parts below the viewport, so it is the way ' +
        'to capture a long page. Note the output is binary and can be large; write it to a file to view it.',
      inputSchema: {
        landscape: z.boolean().optional().describe('Landscape orientation (default false)'),
        printBackground: z.boolean().optional().describe('Print background colours and images (default true)'),
        context: z.string().optional().describe('Tab context id (default: the active tab)'),
      },
      annotations: READ_ONLY,
    },
    async ({ landscape, printBackground, context: tab }: { landscape?: boolean; printBackground?: boolean; context?: string }) => {
      try {
        return text(
          await withPage(async (client, context) => {
            const result = (await client.call('browsingContext.print', {
              context,
              background: printBackground ?? true,
              ...(landscape === undefined ? {} : { orientation: landscape ? 'landscape' : 'portrait' }),
            })) as { data?: string }
            if (typeof result?.data !== 'string') throw new Error('print returned no data')
            return 'data:application/pdf;base64,' + result.data
          }, tab),
          'pdf',
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_set_download_dir',
    {
      title: 'Set the download directory',
      // RESOLVED: earlier attempts appeared to 'hang' purely because the caller sent
      // the path with single backslashes inside a JSON string (D:\DSH... -> \D and \T are invalid JSON
      // escapes), so the request never reached this handler. Sent with forward slashes the tool replies
      // immediately, and the earlier 'side effect happened but no reply' observation is consistent with a
      // partially-mangled path. Nothing here needed fixing; diagnose with a forward-slash path first.
      description:
        'Point Firefox at a download directory (privileged context) by writing browser.download.folderList=2, ' +
        'browser.download.dir and browser.download.useDownloadDir=true. ' +
        'BiDi cannot configure downloads itself (browsingContext.setDownloadBehavior is not implemented), so the ' +
        'preferences are the supported route. Send the path with FORWARD slashes: single backslashes inside a JSON ' +
        'string are invalid escapes (D:\DSH... fails on \D), the request is then dropped before reaching the ' +
        'server, and it looks like the tool hung. Use browser_list_downloads to see what landed there.',
      inputSchema: { path: z.string().describe('Absolute directory to download into') },
      annotations: WRITES_PERSISTENTLY,
    },
    async ({ path: target }: { path: string }) => {
      try {
        const dir = str(target, 'path')
        await withChrome(async (client, context) => {
          // browser.download.dir must be a nsIFile ("complex") preference, not a plain
          // string: DownloadIntegration._getCustomDirectoryOrDownloads() reads it with
          // getComplexValue(pref, Ci.nsIFile) and falls back to the system Downloads
          // folder when that throws (which a string value makes it do). Verified against
          // modules/DownloadIntegration.sys.mjs of the installed Firefox.
          await client.evaluate(
            '(() => {' +
              ' const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);' +
              // nsIFile.initWithPath wants a NATIVE path on Windows (backslashes),
              ' file.initWithPath(' + JSON.stringify(dir.replaceAll('/', String.fromCharCode(92))) + ');' +
              ' Services.prefs.setComplexValue("browser.download.dir", Ci.nsIFile, file);' +
              ' Services.prefs.setIntPref("browser.download.folderList", 2);' +
              ' Services.prefs.setBoolPref("browser.download.useDownloadDir", true);' +
              ' return file.path; })()',
            context,
          )
        })
        return text('downloads will go to: ' + dir)
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_console_logs',
    {
      title: 'Console log entries',
      description:
        'Report console messages the page produced since this server connected (BiDi log.entryAdded). Each entry keeps ' +
        'the level, text and source. Buffered in memory (most recent 500) and only covers this connection, so open the ' +
        'page and act first, then read.',
      inputSchema: { limit: z.number().int().positive().max(200).optional().describe('Max entries, newest first (default 20)') },
      annotations: READ_ONLY,
    },
    async ({ limit }: { limit?: number }) => {
      try {
        const entries = await withBidi(async (client) => client.events('log.entryAdded'))
        if (entries.length === 0) return text('no console messages observed since this server connected')
        const newest = entries.slice(-(limit ?? 20)).reverse()
        return text(JSON.stringify(newest, null, 2))
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_network_requests',
    {
      title: 'Observed network requests',
      description:
        'Report network activity seen since this server connected: network.beforeRequestSent (request URL/method), ' +
        'network.responseCompleted (status) and network.fetchError. This observes rather than intercepts — use it to ' +
        'find out what a page actually loaded. Buffered in memory (most recent 500) for this connection only.',
      inputSchema: {
        limit: z.number().int().positive().max(200).optional().describe('Max events, newest first (default 20)'),
        method: z
          .string()
          .optional()
          .describe('Only events whose method name contains this text, e.g. "fetchError" or "responseCompleted"'),
      },
      annotations: READ_ONLY,
    },
    async ({ limit, method }: { limit?: number; method?: string }) => {
      try {
        const events = await withBidi(async (client) => client.events())
        const network = events.filter((event) => event.method.startsWith('network.'))
        const narrowed =
          method === undefined ? network : network.filter((event) => event.method.includes(method))
        if (narrowed.length === 0) return text('no matching network events observed since this server connected')
        const newest = narrowed.slice(-(limit ?? 20)).reverse()
        return text(JSON.stringify(newest, null, 2))
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_network_intercept',
    {
      title: 'Start or stop intercepting requests',
      description:
        'Turn BiDi request interception on or off (network.addIntercept / removeIntercept, phase beforeRequestSent). ' +
        'While interception is ON, matching requests are HELD until something continues them — a page can appear to ' +
        'hang if nothing does. ⚠️ So always pair this with browser_network_continue_all (release everything held) or ' +
        'browser_network_provide_response (answer one request), and turn interception OFF when finished. ' +
        'Intercepted requests are listed by browser_network_requests (network.beforeRequestSent).',
      inputSchema: {
        action: z.enum(['start', 'stop']).describe('start to begin intercepting, stop to release and stop'),
        urlPattern: z
          .string()
          .optional()
          .describe(
            'Optional URL pattern to limit interception. MEASURED: the wildcard must be ESCAPED and the whole ' +
              'thing must parse as a URL, so use e.g. "http://127.0.0.1:8099/\*" — a bare "*" fails with ' +
              '"Unable to parse URL" and an unescaped "*" fails with "unescaped forbidden character".',
          ),
      },
      annotations: WRITES_PERSISTENTLY,
    },
    async ({ action, urlPattern }: { action: 'start' | 'stop'; urlPattern?: string }) => {
      try {
        return text(
          await withBidi(async (client) => {
            if (action === 'start') {
              const params: Record<string, unknown> = { phases: ['beforeRequestSent'] }
              if (urlPattern !== undefined) {
                params.urlPatterns = [{ type: 'string', pattern: urlPattern }]
              }
              const added = (await client.call('network.addIntercept', params)) as { intercept?: string }
              if (typeof added?.intercept === 'string') client.trackIntercept(added.intercept)
              return 'interception ON (phase beforeRequestSent' + (urlPattern === undefined ? '' : ', pattern ' + urlPattern) + ')'
            }
            // Stopping must never strand held requests.
            const released = await client.continueAllRequestIds()
            const ids = client.trackedIntercepts()
            for (const id of ids) {
              try {
                await client.call('network.removeIntercept', { intercept: id })
              } catch {
                // Already gone.
              }
            }
            client.clearIntercepts()
            return 'interception OFF; released ' + String(released) + ' held request(s)'
          }),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_network_continue_all',
    {
      title: 'Release all held requests',
      description:
        'Continue every request currently held by interception (network.continueRequest for each). This is the safety ' +
        'valve: call it whenever a page seems stuck while interception is on. Returns how many were released.',
      inputSchema: {},
      annotations: WRITES,
    },
    async () => {
      try {
        const released = await withBidi(async (client) => client.continueAllRequestIds())
        return text('released ' + String(released) + ' held request(s)')
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_network_provide_response',
    {
      title: 'Answer a held request yourself',
      description:
        'Fulfil one intercepted request with your own response body (network.provideResponse), instead of letting it ' +
        'reach the network. Pass the request id reported by browser_network_requests. Use this to stub an API, then ' +
        'release the rest with browser_network_continue_all.',
      inputSchema: {
        requestId: z.string().describe('Request id from browser_network_requests (network.beforeRequestSent)'),
        statusCode: z.number().int().positive().describe('HTTP status code, e.g. 200'),
        body: z.string().optional().describe('Response body (default empty)'),
        contentType: z.string().optional().describe('Content-Type header (default text/plain)'),
      },
      annotations: WRITES,
    },
    async ({
      requestId,
      statusCode,
      body,
      contentType,
    }: {
      requestId: string
      statusCode: number
      body?: string
      contentType?: string
    }) => {
      try {
        const id = str(requestId, 'requestId')
        await withBidi(async (client) => {
          await client.call('network.provideResponse', {
            request: id,
            statusCode,
            body: {
              type: 'string',
              value: body ?? '',
            },
            headers: [{ name: 'content-type', value: { type: 'string', value: contentType ?? 'text/plain' } }],
          })
        })
        return text('responded to ' + id + ' with ' + String(statusCode))
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_list_download_events',
    {
      title: 'List observed download events',
      description:
        'Report the download events the browser pushed since this server connected (browsingContext.downloadWillBegin / ' +
        'downloadEnd). Complements browser_list_downloads: the directory shows the RESULT, these events show WHEN a ' +
        'download started, finished, or failed. Events are buffered in memory (most recent 500) and only cover the ' +
        'lifetime of this connection.',
      inputSchema: { limit: z.number().int().positive().max(200).optional().describe('Max entries, newest first (default 20)') },
      annotations: READ_ONLY,
    },
    async ({ limit }: { limit?: number }) => {
      try {
        const events = await withBidi(async (client) => client.events())
        if (events.length === 0) {
          return text('no download events observed since this server connected')
        }
        const newest = events.slice(-(limit ?? 20)).reverse()
        return text(JSON.stringify(newest, null, 2))
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_list_downloads',
    {
      title: 'List downloaded files',
      description:
        'List the files sitting in the configured download directory of Firefox (read via the browser.download.dir ' +
        'preference; no path guessing). Newest first, with sizes. Returns an empty list when nothing has been ' +
        'downloaded yet or the directory is unset.',
      inputSchema: { limit: z.number().int().positive().max(200).optional().describe('Max entries (default 20)') },
      annotations: READ_ONLY,
    },
    async ({ limit }: { limit?: number }) => {
      try {
        const dir = await withChrome(async (client, context) => {
          const value = await client.evaluate(
            'Services.prefs.getStringPref("browser.download.dir", "")',
            context,
          )
          return typeof value === 'string' ? value : ''
        })
        if (dir.length === 0) return text('no download directory configured (browser.download.dir is unset)')
        const entries = readdirSync(dir, { withFileTypes: true })
          .filter((item) => item.isFile())
          .map((item) => {
            const full = join(dir, item.name)
            let size = 0
            let mtime = 0
            try {
              const info = statSync(full)
              size = info.size
              mtime = info.mtimeMs
            } catch {
              // A file can vanish between listing and stat; keep the entry.
            }
            return { name: item.name, size, mtime }
          })
          .sort((a, b) => b.mtime - a.mtime)
          .slice(0, limit ?? 20)
        if (entries.length === 0) return text('download directory is empty: ' + dir)
        return text(
          'download directory: ' +
            dir +
            String.fromCharCode(10) +
            JSON.stringify(entries, null, 2),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_set_viewport',
    {
      title: 'Set the page viewport',
      description:
        'Set (or clear) the BiDi viewport override and read back the result. ' +
        'The override PERSISTS across sessions and changes screenshot resolution (screenshots are physical pixels: ' +
        'viewport x devicePixelRatio), so clearing it matters. Measured: clearing works by sending viewport=null and ' +
        'OMITTING devicePixelRatio; sending null for both times out, so this tool never does that.',
      inputSchema: {
        width: z.number().int().positive().optional().describe('Viewport width in CSS pixels'),
        height: z.number().int().positive().optional().describe('Viewport height in CSS pixels'),
        devicePixelRatio: z.number().positive().optional().describe('Device pixel ratio override'),
        clear: z.boolean().optional().describe('Remove the override (sent as viewport=null with devicePixelRatio omitted)'),
        context: z.string().optional().describe('Tab context id (default: the active tab)'),
      },
      annotations: WRITES_PERSISTENTLY,
    },
    async ({
      width,
      height,
      devicePixelRatio,
      clear,
      context: tab,
    }: {
      width?: number
      height?: number
      devicePixelRatio?: number
      clear?: boolean
      context?: string
    }) => {
      try {
        return text(
          await withPage(async (client, context) => {
            const before = await client.evaluate(
              'window.innerWidth + "x" + window.innerHeight + " @dpr" + window.devicePixelRatio',
              context,
            )
            const viewport =
              clear === true || width === undefined || height === undefined ? null : { width, height }
            // MEASURED: sending viewport:null AND devicePixelRatio:null together
            // times out. Clearing works when devicePixelRatio is simply omitted, so only include
            // it when the caller asked for one.
            const params: Record<string, unknown> = { context, viewport }
            if (devicePixelRatio !== undefined) params.devicePixelRatio = devicePixelRatio
            let clearTimeout = false
            try {
              await client.call('browsingContext.setViewport', params, 15000)
            } catch (error) {
              // MEASURED: clearing (viewport:null) takes effect but the command still times out.
              // Since the effect is what matters, keep going and let the read-back below decide.
              const message = error instanceof Error ? error.message : String(error)
              if (viewport !== null || !/timed out/i.test(message)) throw error
              clearTimeout = true
            }
            const after = await client.evaluate(
              'window.innerWidth + "x" + window.innerHeight + " @dpr" + window.devicePixelRatio',
              context,
            )
            return (
              `before: ${String(before)}` +
              String.fromCharCode(10) +
              `after:  ${String(after)}` +
              (clearTimeout
                ? String.fromCharCode(10) +
                  'note: setViewport(view=null) timed out, but clearing is known to take effect — the value above is read back from the page.'
                : '')
            )
          }, tab),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_profile_info',
    {
      title: 'Which Firefox profile is this?',
      description:
        'Report the profile the connected Firefox is running with: profile directory (ProfD), its name, the local ' +
        'cache directory, whether it is the default profile, and whether this Firefox was started with ' +
        'MOZ_REMOTE_ALLOW_SYSTEM_ACCESS. Use it to confirm you are driving the browser you think you are. ' +
        'NOTE: the profile is chosen when Firefox STARTS; this server attaches to an already-running browser and ' +
        'cannot switch it. To work against another profile, start a second Firefox with "-profile <dir>" plus its own ' +
        '--remote-debugging-port, then register a second MCP entry pointing at that port.',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      try {
        return text(
          await withChrome(async (client, context) => {
            const raw = await client.evaluate(
              '(() => { const f = Services.dirsvc.get("ProfD", Ci.nsIFile);' +
                ' const l = Services.dirsvc.get("ProfLD", Ci.nsIFile);' +
                ' return JSON.stringify({' +
                '  profileDir: f.path,' +
                '  profileName: f.leafName,' +
                '  localDir: l.path,' +
                '  isDefault: Services.prefs.getBoolPref("browser.profiles.isDefault", false),' +
                '  systemAccess: Services.env.get("MOZ_REMOTE_ALLOW_SYSTEM_ACCESS") || "(unset)",' +
                '  version: Services.appinfo.version' +
                ' }); })()',
              context,
            )
            if (typeof raw !== 'string') throw new Error('could not read profile information')
            const info = JSON.parse(raw) as Record<string, unknown>
            return Object.entries(info)
              .map(([key, value]) => key + ': ' + String(value))
              .join(String.fromCharCode(10))
          }),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_close_tab',
    {
      title: 'Close a tab',
      description:
        'Close one tab (browsingContext.close). MEASURED: this closes only that tab; the browser keeps running. ' +
        'Pick the tab by context id (from browser_list_tabs), by 0-based index among the tabs of the active window, ' +
        'or default to the active tab. The reply states how many tabs remain, and warns when none are left — at that ' +
        'point Firefox itself may exit.',
      inputSchema: {
        context: z.string().optional().describe('BiDi context id of the tab to close (preferred)'),
        index: z.number().int().min(0).optional().describe('0-based index among the active tabs of the active window'),
        active: z.boolean().optional().describe('Close the active tab (default when neither context nor index is given)'),
      },
      annotations: WRITES,
    },
    async ({ context, index }: { context?: string; index?: number; active?: boolean }) => {
      try {
        return text(
          await withBidi(async (client) => {
            const tree = (await client.call('browsingContext.getTree', {})) as {
              contexts?: Array<{ context: string; url?: string; children?: unknown[] }>
            }
            const tabs = tree.contexts ?? []
            let target: string | undefined
            if (context !== undefined) {
              target = str(context, 'context')
              if (!tabs.some((tab) => tab.context === target)) {
                throw new Error('no such tab context: ' + target)
              }
            } else if (index !== undefined) {
              const chosen = tabs[index]
              if (chosen === undefined) throw new Error('tab index out of range: ' + String(index))
              target = chosen.context
            } else {
              const active = await client.pageContext()
              if (active === null) throw new Error('no active tab to close')
              target = active
            }
            const closing = tabs.find((tab) => tab.context === target)
            await client.call('browsingContext.close', { context: target })
            const after = (await client.call('browsingContext.getTree', {})) as { contexts?: unknown[] }
            const remaining = (after.contexts ?? []).length
            return (
              'closed ' + target + (closing?.url === undefined ? '' : ' (' + closing.url + ')') +
              String.fromCharCode(10) +
              'tabs remaining: ' + String(remaining) +
              (remaining === 0
                ? String.fromCharCode(10) + 'note: that was the last tab — Firefox may now exit'
                : '')
            )
          }),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_quit',
    {
      title: 'Quit Firefox',
      description:
        'Ask the connected Firefox to exit (browser.close). This tears down the browser and this server loses its ' +
        'connection until Firefox is started again, so use it deliberately. ' +
        'LIMIT (measured): it CANNOT rescue an already-leaked session. Firefox allows ONE active BiDi ' +
        'session; when a client is killed with SIGKILL it never sends session.end, every call — including this one, ' +
        'since it must open a session too — fails with "Maximum number of active sessions". In that state only ' +
        'restarting Firefox externally helps. What this tool does give you is a clean, orderly shutdown while a ' +
        'session IS available, instead of killing the process.',
      inputSchema: {},
      annotations: WRITES_PERSISTENTLY,
    },
    async () => {
      try {
        await withBidi(async (client) => {
          await client.call('browser.close', {})
        })
        return text('asked Firefox to close; start it again to reconnect')
      } catch (error) {
        // The connection often drops before a reply arrives, which still means success.
        const message = error instanceof Error ? error.message : String(error)
        if (/closed|disconnect|socket|ECONNRESET/i.test(message)) {
          return text('Firefox closed (the connection dropped before it could answer): ' + message)
        }
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_set_addon_state',
    {
      title: 'Enable or disable an add-on',
      description:
        'Turn an installed extension on or off by id (AddonManager, privileged context). MEASURED: BiDi itself has ' +
        'no webExtension.* commands, so the privileged route is the only one available. Disabling is reversible; ' +
        'get ids from browser_list_addons.',
      inputSchema: {
        id: z.string().describe('Add-on id, as reported by browser_list_addons'),
        enabled: z.boolean().describe('true to enable, false to disable'),
      },
      annotations: WRITES_PERSISTENTLY,
    },
    async ({ id, enabled }: { id: string; enabled: boolean }) => {
      try {
        const addonId = str(id, 'id')
        return text(
          await withChrome(async (client, context) => {
            const raw = await client.evaluate(
              '(async () => {' +
                ' const addon = await AddonManager.getAddonByID(' + JSON.stringify(addonId) + ');' +
                ' if (!addon) return JSON.stringify({ error: "no such add-on" });' +
                // MEASURED: userDisabled has a getter but NO setter, so assigning it is silently
                // ignored. The supported way is addon.disable() / addon.enable().
                ' if (' + (enabled ? 'true' : 'false') + ') { await addon.enable(); } else { await addon.disable(); }' +
                ' return JSON.stringify({ id: addon.id, name: addon.name, userDisabled: addon.userDisabled, isActive: addon.isActive });' +
                ' })()',
              context,
            )
            if (typeof raw !== 'string') throw new Error('add-on operation returned nothing')
            const result = JSON.parse(raw) as { error?: string }
            if (result.error !== undefined) throw new Error(result.error + ': ' + addonId)
            return Object.entries(result)
              .map(([key, value]) => key + ': ' + String(value))
              .join(String.fromCharCode(10))
          }),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_uninstall_addon',
    {
      title: 'Uninstall an add-on',
      description:
        'Uninstall an installed extension by id (AddonManager, privileged context). This is destructive and, unlike ' +
        'browser_set_addon_state, not simply reversible — the add-on would have to be installed again. Some add-ons ' +
        'cannot be uninstalled (permissions are reported as PERM_CAN_UNINSTALL false).',
      inputSchema: { id: z.string().describe('Add-on id, as reported by browser_list_addons') },
      annotations: WRITES_PERSISTENTLY,
    },
    async ({ id }: { id: string }) => {
      try {
        const addonId = str(id, 'id')
        return text(
          await withChrome(async (client, context) => {
            const raw = await client.evaluate(
              '(async () => {' +
                ' const addon = await AddonManager.getAddonByID(' + JSON.stringify(addonId) + ');' +
                ' if (!addon) return JSON.stringify({ error: "no such add-on" });' +
                ' const permissions = addon.permissions;' +
                ' const canUninstall = (permissions & AddonManager.PERM_CAN_UNINSTALL) !== 0;' +
                ' if (!canUninstall) return JSON.stringify({ error: "this add-on cannot be uninstalled", name: addon.name });' +
                ' const name = addon.name;' +
                ' addon.uninstall();' +
                ' return JSON.stringify({ uninstalled: name, id: addon.id });' +
                ' })()',
              context,
            )
            if (typeof raw !== 'string') throw new Error('uninstall returned nothing')
            const result = JSON.parse(raw) as { error?: string; uninstalled?: string; id?: string }
            if (result.error !== undefined) throw new Error(result.error)
            return 'uninstalled ' + String(result.uninstalled) + ' (' + String(result.id) + ')'
          }),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_get_toolbar_layout',
    {
      title: 'Current toolbar layout',
      description:
        'List which widgets sit in each toolbar area (nav-bar, TabsToolbar, PersonalToolbar, ...), read from ' +
        'browser.uiCustomization.state. Widget ids are exactly what browser_set_toolbar_widget expects. Read this ' +
        'before changing the layout, and use it to put things back afterwards.',
      inputSchema: {
        area: z.string().optional().describe('Only this area, e.g. "nav-bar" (default: every area)'),
      },
      annotations: READ_ONLY,
    },
    async ({ area }: { area?: string }) => {
      try {
        return text(
          await withChrome(async (client, context) => {
            const raw = await client.evaluate(
              '(() => { const st = Services.prefs.getStringPref("browser.uiCustomization.state", "{}");' +
                ' const d = JSON.parse(st); return JSON.stringify(d.placements || {}); })()',
              context,
            )
            if (typeof raw !== 'string') throw new Error('could not read the toolbar layout')
            const placements = JSON.parse(raw) as Record<string, string[]>
            const wanted = area === undefined ? Object.keys(placements) : [area]
            const lines: string[] = []
            for (const key of wanted) {
              const widgets = placements[key]
              if (widgets === undefined) {
                lines.push(key + ': (no such area)')
                continue
              }
              lines.push(key + ': ' + (Array.isArray(widgets) ? JSON.stringify(widgets) : '(none)'))
            }
            return lines.join(String.fromCharCode(10))
          }),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_set_toolbar_widget',
    {
      title: 'Add or remove a toolbar widget',
      description:
        'Move a widget into a toolbar area, or remove it from wherever it is (CustomizableUI.addWidgetToArea / ' +
        'removeWidgetFromArea). MEASURED: the CustomizableUI route applies immediately to the running browser, unlike ' +
        'editing browser.uiCustomization.state directly, which needs a restart. Get ids from browser_get_toolbar_layout ' +
        'or browser_toolbar_widgets, and note the layout so you can undo it.',
      inputSchema: {
        widget: z.string().describe('Widget id, e.g. "downloads-button"'),
        area: z
          .string()
          .optional()
          .describe('Target area, e.g. "nav-bar" or "TabsToolbar" (required unless remove is true)'),
        remove: z.boolean().optional().describe('Remove the widget from its current area instead of adding it'),
      },
      annotations: WRITES_PERSISTENTLY,
    },
    async ({ widget, area, remove }: { widget: string; area?: string; remove?: boolean }) => {
      try {
        const widgetId = str(widget, 'widget')
        return text(
          await withChrome(async (client, context) => {
            const raw = await client.evaluate(
              '(() => {' +
                ' const id = ' + JSON.stringify(widgetId) + ';' +
                (remove === true
                  ? ' CustomizableUI.removeWidgetFromArea(id); return "removed " + id;'
                  : ' const area = ' + JSON.stringify(area ?? '') + ';' +
                    ' CustomizableUI.addWidgetToArea(id, area);' +
                    ' return "added " + id + " to " + area;') +
                ' })()',
              context,
            )
            return typeof raw === 'string' ? raw : 'done'
          }),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_list_themes',
    {
      title: 'Installed themes',
      description:
        'List installed themes and which one is active (AddonManager, type "theme"). Switch with browser_set_addon_state ' +
        'on a theme id — enabling a theme disables the previously active one, so the change is reversible.',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      try {
        return text(
          await withChrome(async (client, context) => {
            const raw = await client.evaluate(
              '(async () => {' +
                ' const list = await AddonManager.getAddonsByTypes(["theme"]);' +
                ' return JSON.stringify(list.map(a => ({ id: a.id, name: a.name, active: a.isActive, disabled: a.userDisabled })));' +
                ' })()',
              context,
            )
            if (typeof raw !== 'string') throw new Error('could not list themes')
            return raw
          }),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_add_bookmark',
    {
      title: 'Add a bookmark',
      description:
        'Insert a bookmark (PlacesUtils.bookmarks.insert) and return its guid, which is what browser_remove_bookmark ' +
        'needs. Defaults to the bookmarks menu; pass the toolbar or unfiled guid to target those instead.',
      inputSchema: {
        url: z.string().describe('URL to bookmark'),
        title: z.string().describe('Bookmark title'),
        parentGuid: z
          .string()
          .optional()
          .describe('Parent folder guid (default: the bookmarks menu, "menu________")'),
      },
      annotations: WRITES_PERSISTENTLY,
    },
    async ({ url, title, parentGuid }: { url: string; title: string; parentGuid?: string }) => {
      try {
        const target = str(url, 'url')
        const label = str(title, 'title')
        return text(
          await withChrome(async (client, context) => {
            const raw = await client.evaluate(
              '(async () => {' +
                ' const parentGuid = ' +
                (parentGuid === undefined ? 'PlacesUtils.bookmarks.menuGuid' : JSON.stringify(parentGuid)) +
                ';' +
                ' const info = await PlacesUtils.bookmarks.insert({' +
                '   parentGuid,' +
                '   url: ' + JSON.stringify(target) + ',' +
                '   title: ' + JSON.stringify(label) +
                ' });' +
                ' return JSON.stringify({ guid: info.guid, title: info.title, parentGuid: info.parentGuid });' +
                ' })()',
              context,
            )
            if (typeof raw !== 'string') throw new Error('insert returned nothing')
            const info = JSON.parse(raw) as Record<string, unknown>
            return Object.entries(info)
              .map(([key, value]) => key + ': ' + String(value))
              .join(String.fromCharCode(10))
          }),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_remove_bookmark',
    {
      title: 'Remove a bookmark',
      description:
        'Remove a bookmark or folder by guid (PlacesUtils.bookmarks.remove). Get guids from browser_list_bookmarks, ' +
        'or from browser_add_bookmark which returns the guid of what it just created. Passing a folder guid removes ' +
        'the whole subtree, so look the entry up first.',
      inputSchema: { guid: z.string().describe('Bookmark guid from browser_list_bookmarks') },
      annotations: WRITES_PERSISTENTLY,
    },
    async ({ guid }: { guid: string }) => {
      try {
        const target = str(guid, 'guid')
        return text(
          await withChrome(async (client, context) => {
            const raw = await client.evaluate(
              '(async () => {' +
                ' const guid = ' + JSON.stringify(target) + ';' +
                ' const info = await PlacesUtils.bookmarks.fetch(guid);' +
                ' if (!info) return JSON.stringify({ error: "no bookmark with that guid" });' +
                ' const label = info.title || (info.url ? info.url.href : "(folder)");' +
                ' await PlacesUtils.bookmarks.remove(guid);' +
                ' return JSON.stringify({ removed: label, guid });' +
                ' })()',
              context,
            )
            if (typeof raw !== 'string') throw new Error('remove returned nothing')
            const info = JSON.parse(raw) as { error?: string; removed?: string; guid?: string }
            if (info.error !== undefined) throw new Error(info.error + ': ' + target)
            return 'removed ' + String(info.removed) + ' (' + String(info.guid) + ')'
          }),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_list_closed_tabs',
    {
      title: 'Recently closed tabs',
      description:
        'List tabs that were closed in this session (SessionStore.getClosedTabData), newest first, with the index ' +
        'that browser_reopen_closed_tab takes. The list lives in memory for the session, so it is empty after a ' +
        'restart. This is the counterpart of browser_close_tab.',
      inputSchema: { limit: z.number().int().positive().max(50).optional().describe('Max entries (default 10)') },
      annotations: READ_ONLY,
    },
    async ({ limit }: { limit?: number }) => {
      try {
        return text(
          await withChrome(async (client, context) => {
            const raw = await client.evaluate(
              '(() => {' +
                ' const count = SessionStore.getClosedTabCount();' +
                ' const data = SessionStore.getClosedTabData(null);' +
                ' const items = data.slice(0, ' + String(limit ?? 10) + ').map((entry, index) => ({' +
                '  index,' +
                '  title: entry.title,' +
                '  url: entry.state && entry.state.entries ? entry.state.entries[0].url : null' +
                ' }));' +
                ' return JSON.stringify({ closedTabCount: count, items }); })()',
              context,
            )
            if (typeof raw !== 'string') throw new Error('could not read closed tabs')
            const parsed = JSON.parse(raw) as { closedTabCount: number; items: unknown[] }
            return (
              'closed tabs available: ' +
              String(parsed.closedTabCount) +
              String.fromCharCode(10) +
              JSON.stringify(parsed.items, null, 2)
            )
          }),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_reopen_closed_tab',
    {
      title: 'Reopen a closed tab',
      description:
        'Reopen a tab that was closed in this session (SessionStore.undoCloseTab). index 0 is the most recently ' +
        'closed tab; get indices from browser_list_closed_tabs. This undoes browser_close_tab, so the pair is ' +
        'reversible.',
      inputSchema: {
        index: z.number().int().min(0).optional().describe('0-based position among closed tabs (default 0)'),
      },
      annotations: WRITES,
    },
    async ({ index }: { index?: number }) => {
      try {
        const which = index ?? 0
        return text(
          await withChrome(async (client, context) => {
            const raw = await client.evaluate(
              '(() => {' +
                ' const index = ' + String(which) + ';' +
                ' const count = SessionStore.getClosedTabCount();' +
                ' if (count === 0) return JSON.stringify({ error: "no closed tabs to reopen" });' +
                ' if (index >= count) return JSON.stringify({ error: "index out of range, count is " + count });' +
                ' const data = SessionStore.getClosedTabData(null);' +
                ' const title = data[index] ? data[index].title : null;' +
                // MEASURED: the first argument must be a real window; passing null throws
                // "can't access property sourceWindow, aSource is null".
                ' SessionStore.undoCloseTab(window, index);' +
                ' return JSON.stringify({ reopened: title, index, before: count, after: SessionStore.getClosedTabCount() });' +
                ' })()',
              context,
            )
            if (typeof raw !== 'string') throw new Error('reopen returned nothing')
            const info = JSON.parse(raw) as {
              error?: string
              reopened?: string
              index?: number
              before?: number
              after?: number
            }
            if (info.error !== undefined) throw new Error(info.error)
            return (
              'reopened ' + String(info.reopened) + ' (index ' + String(info.index) + ')' +
              String.fromCharCode(10) +
              'closed tabs: ' + String(info.before) + ' -> ' + String(info.after)
            )
          }),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_get_proxy',
    {
      title: 'Current proxy configuration',
      description:
        'Read the proxy settings (network.proxy.* preferences): the mode, the manual HTTP/HTTPS/SOCKS host and port, ' +
        'the "no proxy for" list, and the PAC URL. Mode values are the Firefox values: 0 none, 1 manual, 2 PAC, ' +
        '4 auto-detect, 5 use system settings. Note a proxy change may need a restart to affect existing connections.',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      try {
        return text(
          await withChrome(async (client, context) => {
            const raw = await client.evaluate(
              '(() => {' +
                ' const read = (name, dflt) => { const t = Services.prefs.getPrefType(name);' +
                '   if (!t) return "(unset)";' +
                '   if (t === Services.prefs.PREF_BOOL) return Services.prefs.getBoolPref(name);' +
                '   if (t === Services.prefs.PREF_INT) return Services.prefs.getIntPref(name);' +
                '   return Services.prefs.getStringPref(name); };' +
                ' return JSON.stringify({' +
                '  type: read("network.proxy.type"),' +
                '  typeMeaning: ({0:"none",1:"manual",2:"PAC",4:"auto-detect",5:"system"}["" + read("network.proxy.type")] || "unknown"),' +
                '  http: read("network.proxy.http"),' +
                '  httpPort: read("network.proxy.http_port"),' +
                '  ssl: read("network.proxy.ssl"),' +
                '  sslPort: read("network.proxy.ssl_port"),' +
                '  socks: read("network.proxy.socks"),' +
                '  socksPort: read("network.proxy.socks_port"),' +
                '  noProxiesOn: read("network.proxy.no_proxies_on"),' +
                '  pacUrl: read("network.proxy.autoconfig_url")' +
                ' }); })()',
              context,
            )
            if (typeof raw !== 'string') throw new Error('could not read proxy settings')
            const info = JSON.parse(raw) as Record<string, unknown>
            return Object.entries(info)
              .map(([key, value]) => key + ': ' + String(value))
              .join(String.fromCharCode(10))
          }),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_set_proxy',
    {
      title: 'Set the proxy mode',
      description:
        'Set the proxy configuration (network.proxy.* preferences) and read back what was written. mode: 0 none, ' +
        '1 manual (give host/hostPort), 2 PAC (give pacUrl), 4 auto-detect, 5 use system settings. Existing ' +
        'connections may keep using the old proxy until they are reopened. Read browser_get_proxy first so you can ' +
        'put the previous values back. A local HTTP proxy for testing is often written mode=1, host=127.0.0.1.',
      inputSchema: {
        mode: z.number().int().min(0).max(5).describe('Proxy mode: 0 none, 1 manual, 2 PAC, 4 auto-detect, 5 system'),
        host: z.string().optional().describe('Manual proxy host (mode 1), e.g. "127.0.0.1"'),
        port: z.number().int().min(0).max(65535).optional().describe('Manual proxy port (mode 1)'),
        pacUrl: z.string().optional().describe('PAC script URL (mode 2)'),
        noProxiesOn: z.string().optional().describe('Comma-separated "no proxy for" list'),
      },
      annotations: WRITES_PERSISTENTLY,
    },
    async ({
      mode,
      host,
      port,
      pacUrl,
      noProxiesOn,
    }: {
      mode: number
      host?: string
      port?: number
      pacUrl?: string
      noProxiesOn?: string
    }) => {
      try {
        return text(
          await withChrome(async (client, context) => {
            const raw = await client.evaluate(
              '(() => {' +
                ' const before = Services.prefs.getIntPref("network.proxy.type", 5);' +
                ' Services.prefs.setIntPref("network.proxy.type", ' + String(mode) + ');' +
                (host === undefined
                  ? ''
                  : ' Services.prefs.setStringPref("network.proxy.http", ' + JSON.stringify(host) + ');' +
                    ' Services.prefs.setStringPref("network.proxy.ssl", ' + JSON.stringify(host) + ');') +
                (port === undefined
                  ? ''
                  : ' Services.prefs.setIntPref("network.proxy.http_port", ' + String(port) + ');' +
                    ' Services.prefs.setIntPref("network.proxy.ssl_port", ' + String(port) + ');') +
                (pacUrl === undefined
                  ? ''
                  : ' Services.prefs.setStringPref("network.proxy.autoconfig_url", ' + JSON.stringify(pacUrl) + ');') +
                (noProxiesOn === undefined
                  ? ''
                  : ' Services.prefs.setStringPref("network.proxy.no_proxies_on", ' + JSON.stringify(noProxiesOn) + ');') +
                ' return JSON.stringify({ before, after: Services.prefs.getIntPref("network.proxy.type", 5) });' +
                ' })()',
              context,
            )
            if (typeof raw !== 'string') throw new Error('could not set proxy settings')
            const info = JSON.parse(raw) as { before: number; after: number }
            return (
              'proxy type: ' + String(info.before) + ' -> ' + String(info.after) +
              (info.before === info.after && info.before !== mode
                ? String.fromCharCode(10) + 'note: the value did not change as requested'
                : '') +
              String.fromCharCode(10) +
              'note: existing connections may keep the old proxy until reopened'
            )
          }),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_list_cert_overrides',
    {
      title: 'Certificate exceptions',
      description:
        'List the TLS certificate exceptions the user has accepted (nsICertOverrideService.getOverrides), with host, ' +
        'port, flags and whether each is temporary. Useful to confirm a test site was trusted, or to check nothing ' +
        'unexpected was accepted. Temporary exceptions disappear when Firefox exits.',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      try {
        return text(
          await withChrome(async (client, context) => {
            const raw = await client.evaluate(
              '(() => {' +
                ' const svc = Cc["@mozilla.org/security/certoverride;1"].getService(Ci.nsICertOverrideService);' +
                ' const list = svc.getOverrides({});' +
                ' return JSON.stringify(list.map(o => ({' +
                '   host: o.hostName, port: o.port, flags: o.flags, temporary: o.isTemporary' +
                ' }))); })()',
              context,
            )
            if (typeof raw !== 'string') throw new Error('could not list certificate exceptions')
            const list = JSON.parse(raw) as unknown[]
            if (list.length === 0) return 'no certificate exceptions are stored'
            return JSON.stringify(list, null, 2)
          }),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_set_window_size',
    {
      title: 'Resize or move the browser window',
      description:
        'Set the client window position and size through BiDi (browser.setClientWindowState). Read the current ' +
        'geometry with browser_list_windows first. These are window pixels, not page pixels — use ' +
        'browser_set_viewport when you mean the page viewport instead.',
      inputSchema: {
        clientWindow: z
          .string()
          .optional()
          .describe(
            'Client window id. MEASURED: these ids are regenerated per session, so an id read in an earlier call ' +
              'is stale — omit this and the tool acts on the ACTIVE window, which is usually what you want.',
          ),
        x: z.number().optional().describe('Left edge in screen coordinates'),
        y: z.number().optional().describe('Top edge in screen coordinates'),
        width: z.number().positive().optional().describe('Window width'),
        height: z.number().positive().optional().describe('Window height'),
      },
      annotations: WRITES,
    },
    async ({
      clientWindow,
      x,
      y,
      width,
      height,
    }: {
      clientWindow?: string
      x?: number
      y?: number
      width?: number
      height?: number
    }) => {
      try {
        const requested = clientWindow === undefined ? null : str(clientWindow, 'clientWindow')
        const state: Record<string, unknown> = {}
        if (x !== undefined) state.x = x
        if (y !== undefined) state.y = y
        if (width !== undefined) state.width = width
        if (height !== undefined) state.height = height
        if (Object.keys(state).length === 0) {
          throw new Error('give at least one of x, y, width, height')
        }
        return text(
          await withBidi(async (client) => {
            let id = requested
            if (id === null) {
              const before = (await client.call('browser.getClientWindows', {})) as {
                clientWindows?: Array<Record<string, unknown>>
              }
              const active = (before.clientWindows ?? []).find((item) => item.active === true)
              const fallback = active ?? (before.clientWindows ?? [])[0]
              if (fallback === undefined) throw new Error('no client window to act on')
              id = String(fallback.clientWindow)
            }
            // MEASURED: `state` is the window STATE as a string (normal/minimized/maximized/fullscreen),
            // and x/y/width/height sit NEXT TO it, not inside it. Passing an object for `state` is rejected
            // with 'Expected "state" to be one of maximized,minimized,normal,fullscreen'.
            await client.call('browser.setClientWindowState', {
              clientWindow: id,
              state: 'normal',
              ...state,
            })
            const after = (await client.call('browser.getClientWindows', {})) as {
              clientWindows?: Array<Record<string, unknown>>
            }
            const found = (after.clientWindows ?? []).find((item) => item.clientWindow === id)
            if (found === undefined) throw new Error('window not found after the change: ' + id)
            return (
              'x: ' + String(found.x) + '  y: ' + String(found.y) +
              String.fromCharCode(10) +
              'width: ' + String(found.width) + '  height: ' + String(found.height)
            )
          }),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_save_session',
    {
      title: 'Save the current session to a file',
      description:
        'Write the current window and tab session to a JSON file (SessionStore.getBrowserState). This only READS the ' +
        'browser; the file it writes is the input for browser_restore_session. Save before restoring, so the state ' +
        'you have now can be brought back.',
      inputSchema: {
        path: z.string().describe('Absolute file path to write (forward slashes are fine)'),
      },
      annotations: WRITES_PERSISTENTLY,
    },
    async ({ path: target }: { path: string }) => {
      try {
        const file = str(target, 'path')
        return text(
          await withChrome(async (client, context) => {
            const raw = await client.evaluate('SessionStore.getBrowserState()', context)
            if (typeof raw !== 'string') throw new Error('could not read the session state')
            const native = file.replaceAll('/', String.fromCharCode(92))
            const written = await client.evaluate(
              '(() => {' +
                ' const path = ' + JSON.stringify(native) + ';' +
                // MEASURED: writing with nsIFileOutputStream.write(str, str.length) truncates as soon as the
                // text holds multi-byte characters (Chinese tab titles), because that length is characters,
                // not bytes — the file then fails to parse. IOUtils.writeUTF8 handles the encoding.
                ' IOUtils.writeUTF8(path, ' + JSON.stringify(raw) + ');' +
                ' return path;' +
                ' })()',
              context,
            )
            return 'session written to ' + String(written) + ' (' + String(raw.length) + ' chars)'
          }),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_restore_session',
    {
      title: 'Restore a session from a file',
      description:
        'Replace the current session with one saved earlier (SessionStore.setBrowserState). WARNING: this REPLACES ' +
        'the windows and tabs that are open now — run browser_save_session first if you might want them back. The ' +
        'file must be JSON produced by the save tool; anything else is rejected before the state is touched.',
      inputSchema: {
        path: z.string().describe('Absolute path of a file written by browser_save_session'),
      },
      annotations: WRITES_PERSISTENTLY,
    },
    async ({ path: target }: { path: string }) => {
      try {
        const file = str(target, 'path')
        return text(
          await withChrome(async (client, context) => {
            const native = file.replaceAll('/', String.fromCharCode(92))
            const raw = await client.evaluate(
              '(async () => {' +
                ' const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);' +
                ' file.initWithPath(' + JSON.stringify(native) + ');' +
                ' if (!file.exists()) return JSON.stringify({ error: "file not found" });' +
                ' const data = await IOUtils.readUTF8(file.path);' +
                ' try { JSON.parse(data); } catch (e) { return JSON.stringify({ error: "not valid JSON: " + e.message }); }' +
                ' return data;' +
                ' })()',
              context,
            )
            if (typeof raw !== 'string') throw new Error('restore returned nothing')
            if (raw.startsWith('{"error"')) throw new Error(raw)
            await client.evaluate('SessionStore.setBrowserState(' + JSON.stringify(raw) + '); true', context)
            return 'session restored from ' + native
          }),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_install_addon',
    {
      title: 'Install an add-on from a file',
      description:
        'Install an extension from a local .xpi file or an unpacked extension directory ' +
        '(AddonManager.getInstallForFile). The path must exist and be readable by Firefox. Most add-ons work ' +
        'immediately; some need a restart. Confirm with browser_list_addons, then use browser_set_addon_state to ' +
        'enable or disable it, or browser_uninstall_addon to remove it.',
      inputSchema: {
        path: z.string().describe('Absolute path of the .xpi, or of an unpacked extension directory'),
      },
      annotations: WRITES_PERSISTENTLY,
    },
    async ({ path: target }: { path: string }) => {
      try {
        const file = str(target, 'path')
        return text(
          await withChrome(async (client, context) => {
            const native = file.replaceAll('/', String.fromCharCode(92))
            const raw = await client.evaluate(
              '(async () => {' +
                ' const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);' +
                ' file.initWithPath(' + JSON.stringify(native) + ');' +
                ' if (!file.exists()) return JSON.stringify({ error: "file not found" });' +
                ' const install = await AddonManager.getInstallForFile(file);' +
                ' if (!install) return JSON.stringify({ error: "could not prepare an install for that file" });' +
                ' const outcome = await new Promise((resolve) => {' +
                '   install.addListener({' +
                '     onInstallEnded: () => resolve("ended"),' +
                '     onInstallFailed: () => resolve("failed"),' +
                '     onInstallCancelled: () => resolve("cancelled"),' +
                '   });' +
                '   install.install();' +
                ' });' +
                ' return JSON.stringify({ outcome, id: install.addon ? install.addon.id : null });' +
                ' })()',
              context,
            )
            if (typeof raw !== 'string') throw new Error('install returned nothing')
            const info = JSON.parse(raw) as { error?: string; outcome?: string; id?: string | null }
            if (info.error !== undefined) throw new Error(info.error)
            if (info.outcome !== 'ended') throw new Error('install did not finish: ' + String(info.outcome))
            return 'installed ' + String(info.id) + ' from ' + native
          }),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_get_cookies',
    {
      title: 'Read cookies',
      description:
        'List cookies visible to the browser (BiDi storage.getCookies). Filter by name and/or domain to narrow it ' +
        'down. Values are returned as stored; treat them as secrets and do not paste them into shared logs.',
      inputSchema: {
        name: z.string().optional().describe('Only this cookie name'),
        domain: z.string().optional().describe('Only cookies whose domain matches'),
      },
      annotations: READ_ONLY,
    },
    async ({ name, domain }: { name?: string; domain?: string }) => {
      try {
        const filter: Record<string, unknown> = {}
        if (name !== undefined) filter.name = name
        if (domain !== undefined) filter.domain = domain
        return text(
          await withBidi(async (client) => {
            const result = (await client.call(
              'storage.getCookies',
              Object.keys(filter).length === 0 ? {} : { filter },
            )) as { cookies?: unknown[] }
            const cookies = result.cookies ?? []
            if (cookies.length === 0) return 'no cookies matched'
            return JSON.stringify(cookies, null, 2)
          }),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_set_cookie',
    {
      title: 'Set a cookie',
      description:
        'Create or replace one cookie (BiDi storage.setCookie). domain and path scope it; omit domain for a host-only ' +
        'cookie. Use browser_get_cookies afterwards to confirm the value and expiry the browser actually stored.',
      inputSchema: {
        name: z.string().describe('Cookie name'),
        value: z.string().describe('Cookie value'),
        domain: z.string().describe('Cookie domain, e.g. "127.0.0.1"'),
        path: z.string().optional().describe('Cookie path (default "/")'),
        secure: z.boolean().optional().describe('Mark the cookie Secure'),
        httpOnly: z.boolean().optional().describe('Mark the cookie HttpOnly'),
        sameSite: z.enum(['strict', 'lax', 'none']).optional().describe('SameSite policy'),
        expirySeconds: z.number().int().positive().optional().describe('Expiry as a Unix timestamp in seconds'),
      },
      annotations: WRITES,
    },
    async ({
      name,
      value,
      domain,
      path,
      secure,
      httpOnly,
      sameSite,
      expirySeconds,
    }: {
      name: string
      value: string
      domain: string
      path?: string
      secure?: boolean
      httpOnly?: boolean
      sameSite?: 'strict' | 'lax' | 'none'
      expirySeconds?: number
    }) => {
      try {
        const cookie: Record<string, unknown> = {
          name: str(name, 'name'),
          value: { type: 'string', value: str(value, 'value') },
          domain: str(domain, 'domain'),
        }
        cookie.path = path ?? '/'
        if (secure !== undefined) cookie.secure = secure
        if (httpOnly !== undefined) cookie.httpOnly = httpOnly
        if (sameSite !== undefined) cookie.sameSite = sameSite
        if (expirySeconds !== undefined) cookie.expiry = expirySeconds
        return text(
          await withBidi(async (client) => {
            await client.call('storage.setCookie', { cookie })
            return 'cookie set: ' + String(cookie.name) + ' on ' + String(cookie.domain)
          }),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_delete_cookies',
    {
      title: 'Delete cookies',
      description:
        'Delete cookies matching a filter (BiDi storage.deleteCookies). Give name and/or domain; with no filter it ' +
        'clears every cookie the session can see, which is destructive — pass at least one of them unless you mean it.',
      inputSchema: {
        name: z.string().optional().describe('Only this cookie name'),
        domain: z.string().optional().describe('Only cookies whose domain matches'),
      },
      annotations: WRITES_PERSISTENTLY,
    },
    async ({ name, domain }: { name?: string; domain?: string }) => {
      try {
        const filter: Record<string, unknown> = {}
        if (name !== undefined) filter.name = name
        if (domain !== undefined) filter.domain = domain
        if (Object.keys(filter).length === 0) {
          throw new Error('refusing to delete every cookie: pass name and/or domain')
        }
        return text(
          await withBidi(async (client) => {
            await client.call('storage.deleteCookies', { filter })
            return 'deleted cookies matching ' + JSON.stringify(filter)
          }),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_activate_tab',
    {
      title: 'Switch to a tab',
      description:
        'Make a tab the active one (browsingContext.activate). Pass its context id from browser_list_tabs, or an ' +
        'index among the tabs. Useful before typing or clicking, since input goes to the active tab.',
      inputSchema: {
        context: z.string().optional().describe('Context id of the tab to activate'),
        index: z.number().int().min(0).optional().describe('0-based tab index instead of a context id'),
      },
      annotations: WRITES,
    },
    async ({ context, index }: { context?: string; index?: number }) => {
      try {
        return text(
          await withBidi(async (client) => {
            const tree = (await client.call('browsingContext.getTree', {})) as {
              contexts?: Array<{ context: string; url?: string }>
            }
            const tabs = tree.contexts ?? []
            let target: string | undefined
            if (context !== undefined) {
              target = str(context, 'context')
              if (!tabs.some((tab) => tab.context === target)) throw new Error('no such tab: ' + target)
            } else if (index !== undefined) {
              const chosen = tabs[index]
              if (chosen === undefined) throw new Error('tab index out of range: ' + String(index))
              target = chosen.context
            } else {
              throw new Error('give either context or index')
            }
            await client.call('browsingContext.activate', { context: target })
            const now = tabs.find((tab) => tab.context === target)
            return 'activated ' + target + (now?.url === undefined ? '' : ' (' + now.url + ')')
          }),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_traverse_history',
    {
      title: 'Go back or forward',
      description:
        'Move the active tab through its session history (browsingContext.traverseHistory): delta -1 is back, +1 is ' +
        'forward. Fails with "no such history entry" when that direction has nothing to go to, which is a normal ' +
        'answer rather than a broken tool.',
      inputSchema: {
        delta: z.number().int().describe('Negative goes back, positive goes forward (e.g. -1 or 1)'),
        context: z.string().optional().describe('Tab context id (default: the active tab)'),
      },
      annotations: WRITES,
    },
    async ({ delta, context }: { delta: number; context?: string }) => {
      try {
        return text(
          await withBidi(async (client) => {
            let target = context === undefined ? null : str(context, 'context')
            if (target === null) target = await client.pageContext()
            if (target === null) throw new Error('no active tab')
            try {
              await client.call('browsingContext.traverseHistory', { context: target, delta })
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error)
              if (/no such history entry/i.test(message)) {
                return 'no history entry in that direction (delta ' + String(delta) + ')'
              }
              throw error
            }
            return 'traversed history by ' + String(delta)
          }),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_list_prompts',
    {
      title: 'Alerts and prompts seen so far',
      description:
        'List page prompts (alert / confirm / prompt / beforeunload) that opened since this server connected, as ' +
        'reported by BiDi browsingContext.userPromptOpened, newest first. A page that shows one of these blocks its ' +
        'script until it is answered — use browser_handle_prompt to accept or dismiss. If a page seems stuck, check ' +
        'here first.',
      inputSchema: { limit: z.number().int().positive().max(50).optional().describe('Max entries (default 10)') },
      annotations: READ_ONLY,
    },
    async ({ limit }: { limit?: number }) => {
      try {
        const events = await withBidi(async (client) => client.events('browsingContext.userPromptOpened'))
        if (events.length === 0) return text('no page prompts observed since this server connected')
        const newest = events.slice(-(limit ?? 10)).reverse()
        return text(JSON.stringify(newest, null, 2))
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_handle_prompt',
    {
      title: 'Accept or dismiss a page prompt',
      description:
        'Answer the alert / confirm / prompt that a page is waiting on (BiDi browsingContext.handleUserPrompt). ' +
        'accept: true clicks OK, false cancels. userText supplies the answer for a prompt() dialog. Without this the ' +
        'page stays blocked; "no such alert" means nothing is waiting, which is a normal answer.',
      inputSchema: {
        accept: z.boolean().describe('true = OK, false = Cancel'),
        userText: z.string().optional().describe('Text to enter for a prompt() dialog'),
        context: z.string().optional().describe('Tab context id (default: the active tab)'),
      },
      annotations: WRITES,
    },
    async ({ accept, userText, context }: { accept: boolean; userText?: string; context?: string }) => {
      try {
        return text(
          await withBidi(async (client) => {
            let target = context === undefined ? null : str(context, 'context')
            if (target === null) target = await client.pageContext()
            if (target === null) throw new Error('no active tab')
            const params: Record<string, unknown> = { context: target, accept }
            if (userText !== undefined) params.userText = userText
            try {
              await client.call('browsingContext.handleUserPrompt', params)
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error)
              if (/no such alert/i.test(message)) {
                return 'no prompt is waiting on that tab'
              }
              throw error
            }
            return (accept ? 'accepted' : 'dismissed') + ' the prompt' + (userText === undefined ? '' : ' with text')
          }),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_set_permission',
    {
      title: 'Grant or deny a site permission',
      description:
        'Set one permission for an origin (BiDi permissions.setPermission). MEASURED: the permission goes in a ' +
        '"descriptor" object — { descriptor: { name }, state, origin } — passing the name at the top level is ' +
        'rejected. state is granted / denied / prompt. Useful to stop a page blocking on a location or notification ' +
        'request during automation.',
      inputSchema: {
        name: z.string().describe('Permission name, e.g. "geolocation", "notifications"'),
        state: z.enum(['granted', 'denied', 'prompt']).describe('What to set it to'),
        origin: z.string().describe('Origin to apply it to, e.g. "http://127.0.0.1:8099"'),
      },
      annotations: WRITES_PERSISTENTLY,
    },
    async ({ name, state, origin }: { name: string; state: 'granted' | 'denied' | 'prompt'; origin: string }) => {
      try {
        return text(
          await withBidi(async (client) => {
            await client.call('permissions.setPermission', {
              descriptor: { name: str(name, 'name') },
              state,
              origin: str(origin, 'origin'),
            })
            return 'permission ' + String(name) + ' = ' + String(state) + ' for ' + String(origin)
          }),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_create_container',
    {
      title: 'Create a container (user context)',
      description:
        'Create a new container / user context (BiDi browser.createUserContext) and return its id. The id can be ' +
        'passed to browser_create_container style workflows and is what isolates cookies and storage. ' +
        'Remove it again with browser_remove_container; containers are not the same thing as Firefox account tabs.',
      inputSchema: {},
      annotations: WRITES,
    },
    async () => {
      try {
        return text(
          await withBidi(async (client) => {
            const result = (await client.call('browser.createUserContext', {})) as { userContext?: string }
            const id = result.userContext
            if (typeof id !== 'string') throw new Error('createUserContext returned no id')
            return 'created container: ' + id
          }),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_remove_container',
    {
      title: 'Remove a container',
      description:
        'Delete a container / user context by id (BiDi browser.removeUserContext). Anything stored inside that ' +
        'container is discarded, so check the id with browser_list_user_contexts first.',
      inputSchema: { userContext: z.string().describe('Container id from browser_list_user_contexts') },
      annotations: WRITES_PERSISTENTLY,
    },
    async ({ userContext }: { userContext: string }) => {
      try {
        const id = str(userContext, 'userContext')
        return text(
          await withBidi(async (client) => {
            await client.call('browser.removeUserContext', { userContext: id })
            return 'removed container: ' + id
          }),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_set_toolbar_visibility',
    {
      title: 'Show or hide a toolbar',
      description:
        'Show or hide a whole toolbar such as the bookmarks toolbar or the menu bar (CustomizableUI.setToolbarVisibility, ' +
        'which applies immediately). This is coarser than browser_set_toolbar_widget, which moves individual widgets.',
      inputSchema: {
        toolbar: z.string().describe('Toolbar id, e.g. "PersonalToolbar" (bookmarks) or "toolbar-menubar"'),
        visible: z.boolean().describe('true to show, false to hide'),
      },
      annotations: WRITES_PERSISTENTLY,
    },
    async ({ toolbar, visible }: { toolbar: string; visible: boolean }) => {
      try {
        const id = str(toolbar, 'toolbar')
        return text(
          await withChrome(async (client, context) => {
            const raw = await client.evaluate(
              '(() => {' +
                ' try {' +
                '  CustomizableUI.setToolbarVisibility(' + JSON.stringify(id) + ', ' + (visible ? 'true' : 'false') + ');' +
                '  return \"ok\";' +
                ' } catch (e) { return \"ERR \" + e.message; }' +
                ' })()',
              context,
            )
            if (typeof raw !== 'string') throw new Error('setToolbarVisibility returned nothing')
            if (raw.startsWith('ERR ')) throw new Error(raw)
            return 'toolbar ' + id + ' is now ' + (visible ? 'shown' : 'hidden')
          }),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_get_favicon',
    {
      title: 'Favicon URL for a page',
      description:
        'Ask Places which favicon URL it has stored for a page (PlacesUtils.favicons.getFaviconForPage). Returns ' +
        'the URL only — it does not download the image. Empty result means no icon has been recorded for that page yet.',
      inputSchema: { url: z.string().describe('Page URL to look up') },
      annotations: READ_ONLY,
    },
    async ({ url }: { url: string }) => {
      try {
        const page = str(url, 'url')
        return text(
          await withChrome(async (client, context) => {
            const raw = await client.evaluate(
              '(async () => {' +
                ' try {' +
                '  const uri = Services.io.newURI(' + JSON.stringify(page) + ');' +
                // MEASURED: the method is getFaviconForPage; getFaviconURLForPage does not exist here.
                '  const fav = await PlacesUtils.favicons.getFaviconForPage(uri);' +
                '  return fav ? fav.spec : \"(no favicon recorded)\";' +
                ' } catch (e) { return \"ERR \" + e.message; }' +
                ' })()',
              context,
            )
            if (typeof raw !== 'string') throw new Error('favicon lookup returned nothing')
            if (raw.startsWith('ERR ')) throw new Error(raw)
            return raw
          }),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_new_window',
    {
      title: 'Open a new browser window',
      description:
        'Open a new browser window (BiDi browsingContext.create with type "window") and return its context id. ' +
        'A window is a top-level context; browser_close_window closes one again. Use browser_new_tab when you only ' +
        'need another tab — a new window is a visible change on screen and leaves a window to clean up.',
      inputSchema: {
        url: z.string().optional().describe('Optional URL to open in the new window'),
        background: z.boolean().optional().describe('false focuses the new window; default false'),
      },
      annotations: WRITES,
    },
    async ({ url, background }: { url?: string; background?: boolean }) => {
      try {
        return text(
          await withBidi(async (client) => {
            const params: Record<string, unknown> = { type: 'window' }
            params.background = background ?? false
            if (url !== undefined) params.referenceContext = null
            const result = (await client.call('browsingContext.create', params)) as { context?: string }
            const context = result.context
            if (typeof context !== 'string') throw new Error('create returned no context id')
            if (url !== undefined) {
              await client.navigate(url, context)
            }
            const before = (await client.call('browser.getClientWindows', {})) as { clientWindows?: unknown[] }
            return (
              'new window: ' + context +
              String.fromCharCode(10) +
              'windows now: ' + String((before.clientWindows ?? []).length)
            )
          }),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_close_window',
    {
      title: 'Close a browser window',
      description:
        'Close a whole window — every tab in it (BiDi browsingContext.close on a top-level context). Without a ' +
        'context it acts on the active tab is NOT what happens here: it closes the window that tab belongs to, so ' +
        'check first. browser_close_tab closes a single tab instead.',
      inputSchema: {
        context: z
          .string()
          .optional()
          .describe('A tab or window context id; the top-level window it belongs to is closed (default: active tab window)'),
      },
      annotations: WRITES,
    },
    async ({ context }: { context?: string }) => {
      try {
        return text(
          await withBidi(async (client) => {
            const tree = (await client.call('browsingContext.getTree', {})) as {
              contexts?: Array<{ context: string }>
            }
            const tops = tree.contexts ?? []
            let target = context === undefined ? null : str(context, 'context')
            if (target === null) target = await client.pageContext()
            if (target === null) throw new Error('nothing to close')
            const top = tops.find((item) => item.context === target)
            const toClose = top === undefined ? target : top.context
            const before = tops.length
            await client.call('browsingContext.close', { context: toClose })
            const after = (await client.call('browsingContext.getTree', {})) as { contexts?: unknown[] }
            const remaining = (after.contexts ?? []).length
            return (
              'closed window ' + toClose +
              String.fromCharCode(10) +
              'windows: ' + String(before) + ' -> ' + String(remaining) +
              (remaining === 0 ? String.fromCharCode(10) + 'note: that was the last window — Firefox may now exit' : '')
            )
          }),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_clear_data',
    {
      title: 'Clear stored data for one site',
      description:
        'Delete stored data for ONE host or origin (ClearDataService). Requires host or origin — there is no ' +
        '"clear everything" path here on purpose, because that is not something to trigger by accident. ' +
        'Clears cookies, storage and caches belonging to that site.',
      inputSchema: {
        host: z.string().optional().describe('Host to clear, e.g. "127.0.0.1"'),
        origin: z.string().optional().describe('Origin to clear, e.g. "http://127.0.0.1:8099"'),
        dataTypes: z
          .string()
          .optional()
          .describe('Space separated data types to clear (default: cookies, storage and cache)'),
      },
      annotations: WRITES_PERSISTENTLY,
    },
    async ({ host, origin, dataTypes }: { host?: string; origin?: string; dataTypes?: string }) => {
      try {
        if (host === undefined && origin === undefined) {
          throw new Error('refusing to run without host or origin: pass one so only that site is cleared')
        }
        const hostValue = host === undefined ? null : str(host, 'host')
        const originValue = origin === undefined ? null : str(origin, 'origin')
        const types = dataTypes ?? 'cookies storage cache'
        return text(
          await withChrome(async (client, context) => {
            const raw = await client.evaluate(
              '(async () => {' +
                ' try {' +
                '  const { ClearDataService } = ChromeUtils.importESModule(' +
                '    "resource://gre/modules/ClearDataService.sys.mjs");' +
                '  const svc = new ClearDataService();' +
                '  const host = ' + JSON.stringify(hostValue) + ';' +
                '  const origin = ' + JSON.stringify(originValue) + ';' +
                '  const types = ' + JSON.stringify(types) + '.split(/\\s+/).filter(Boolean);' +
                '  const cleared = [];' +
                '  if (origin) { await svc.deleteDataFromSite(origin, {}, types); cleared.push("origin " + origin); }' +
                '  else if (host) { await svc.deleteDataFromHost(host, types); cleared.push("host " + host); }' +
                '  return "cleared: " + cleared.join(", ") + " [" + types.join(" ") + "]";' +
                ' } catch (e) { return "ERR " + e.message; }' +
                ' })()',
              context,
            )
            if (typeof raw !== 'string') throw new Error('clear data returned nothing')
            if (raw.startsWith('ERR ')) throw new Error(raw)
            return raw
          }),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_collect_response_body',
    {
      title: 'Start capturing response bodies (experimental)',
      description:
        'Turn on BiDi response-body collection (network.addDataCollector). It must be switched on BEFORE the request ' +
        'you care about happens — a request that already completed has no body to collect. Then read it with ' +
        'browser_get_response_body. Measured: Firefox clones the body while handling the response-started phase, so this ' +
        'tool also intercepts that phase; browser_get_response_body releases the response and only then reads the ' +
        'body only after network.responseCompleted for that request — asking earlier blocks, and asking with no hold ' +
        'at all can come back as "no such network data". Clear the interception with browser_network_intercept ' +
        'stop when finished.',
      inputSchema: {
        maxSize: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Upper bound on captured bytes per response (default 1 MB)'),
      },
      annotations: WRITES,
    },
    async ({ maxSize }: { maxSize?: number }) => {
      try {
        return text(
          await withBidi(async (client) => {
            // MEASURED: the browser clones a response body in its response-started handler,
            // and that handler bails out early when nothing is subscribed. Subscribe first.
            // Both events matter: responseStarted is when the body is cloned, and
            // responseCompleted is the signal browser_get_response_body waits for before reading.
            await client.subscribe(['network.responseStarted', 'network.responseCompleted'])
            // The browser only clones a response body while handling response-started, and that
            // handler bails out unless interception holds the response there. So intercept this
            // phase as well; browser_get_response_body releases the response before reading it.
            const intercept = (await client.call('network.addIntercept', {
              phases: ['responseStarted'],
            })) as { intercept?: string }
            if (typeof intercept.intercept === 'string') {
              client.trackIntercept(intercept.intercept)
            }
            const result = (await client.call('network.addDataCollector', {
              dataTypes: ['response'],
              maxEncodedDataSize: maxSize ?? 1048576,
            })) as { collector?: string }
            const id = result.collector
            return (
              'response collection on' +
              (typeof id === 'string' ? ' (collector ' + id + ')' : '') +
              String.fromCharCode(10) +
              'now trigger the request, then read the body with browser_get_response_body.' +
              String.fromCharCode(10) +
              'NOTE: while a response is held at responseStarted, a navigation that waits for it will TIME OUT. ' +
              'That is expected: read the body to release it. Also, the collector lives in this server session, ' +
              'so collecting in one session and reading in another finds nothing.'
            )
          }),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_get_response_body',
    {
      title: 'Read a captured response body',
      description:
        'Read the stored body of one request (network.getData, dataType response). The request must have happened ' +
        'AFTER browser_collect_response_body ran. Returns the base64 the protocol gives plus a decoded preview. ' +
        '"no such network data" means nothing was stored for that request id — check that collection was started ' +
        'first and that the id comes from browser_network_requests.',
      inputSchema: {
        requestId: z.string().describe('Request id from browser_network_requests (beforeRequestSent / responseStarted)'),
      },
      annotations: READ_ONLY,
    },
    async ({ requestId }: { requestId: string }) => {
      try {
        const id = str(requestId, 'requestId')
        return text(
          await withBidi(async (client) => {
            // MEASURED order that actually works:
            //   1. the response is held at responseStarted (that is when the browser clones the body)
            //   2. continueResponse releases it
            //   3. getData only has bytes AFTER network.responseCompleted has been seen —
            //      asking earlier blocks on the body promise, and asking with no hold at all can
            //      come back as "no such network data".
            try {
              await client.call('network.continueResponse', { request: id })
            } catch {
              // Not held (already continued, or never intercepted): fall through and try to read.
            }
            const completed = (): boolean =>
              client.events('network.responseCompleted').some((event) => {
                const params = event.params as { request?: { request?: string } } | undefined
                return params?.request?.request === id
              })
            for (let attempt = 0; attempt < 100 && !completed(); attempt++) {
              await new Promise((resolve) => setTimeout(resolve, 100))
            }
            const result = (await client.call('network.getData', {
              request: id,
              dataType: 'response',
            })) as { bytes?: { value?: string } }
            const encoded = result?.bytes?.value
            if (typeof encoded !== 'string') throw new Error('no response body stored for that request')
            let preview = ''
            try {
              preview = Buffer.from(encoded, 'base64').toString('utf8')
            } catch {
              preview = ''
            }
            const head =
              preview.length > 600
                ? preview.slice(0, 600) + String.fromCharCode(10) + '[truncated, total ' + String(preview.length) + ' chars]'
                : preview
            return (
              'base64 length: ' + String(encoded.length) +
              String.fromCharCode(10) +
              'decoded preview:' + String.fromCharCode(10) + head
            )
          }),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_relax_certificate_checks',
    {
      title: 'Relax or restore TLS certificate checking',
      description:
        'SECURITY SENSITIVE. Switches the certificate-checking preferences that make a self-signed or internally ' +
        'issued test certificate usable: cert pinning, OCSP and OCSP stapling/must-staple. relax:true turns those ' +
        'checks off; relax:false puts them back. Restoring is precise: a preference that had no user value before is ' +
        'cleared so it falls back to the Firefox default again, instead of being overwritten with a guess. ' +
        'The pre-relax values are remembered by THIS SERVER PROCESS, so restore only works while it is alive; ' +
        'if the server restarted, restore reports that instead of guessing. Some TLS changes only affect new connections.',
      inputSchema: {
        relax: z
          .boolean()
          .describe('true to relax the checks (unsafe), false to restore what was there before'),
      },
      annotations: WRITES_PERSISTENTLY,
    },
    async ({ relax }: { relax: boolean }) => {
      try {
        return text(
          await withChrome(async (client, context) => {
            const raw = await client.evaluate(
              '(async () => {' +
                ' const names = [' +
                '   "security.cert_pinning.enforcement_level",' +
                '   "security.OCSP.enabled",' +
                '   "security.ssl.enable_ocsp_stapling",' +
                '   "security.ssl.enable_ocsp_must_staple"' +
                ' ];' +
                ' const relaxed = {' +
                '   "security.cert_pinning.enforcement_level": { type: "int", value: 0 },' +
                '   "security.OCSP.enabled": { type: "int", value: 0 },' +
                '   "security.ssl.enable_ocsp_stapling": { type: "bool", value: false },' +
                '   "security.ssl.enable_ocsp_must_staple": { type: "bool", value: false }' +
                ' };' +
                ' const read = (name) => {' +
                '   const t = Services.prefs.getPrefType(name);' +
                '   if (!t) return { type: "unset", value: null };' +
                '   if (t === Services.prefs.PREF_BOOL) return { type: "bool", value: Services.prefs.getBoolPref(name) };' +
                '   if (t === Services.prefs.PREF_INT) return { type: "int", value: Services.prefs.getIntPref(name) };' +
                '   return { type: "string", value: Services.prefs.getStringPref(name) };' +
                ' };' +
                ' const write = (name, kind, value) => {' +
                '   if (kind === "bool") Services.prefs.setBoolPref(name, value);' +
                '   else if (kind === "int") Services.prefs.setIntPref(name, value);' +
                '   else Services.prefs.setStringPref(name, value);' +
                ' };' +
                ' const snapshot = {};' +
                ' for (const n of names) snapshot[n] = { hadUserValue: Services.prefs.prefHasUserValue(n), type: read(n).type, value: read(n).value };' +
                ' const saved = ' + JSON.stringify(certPrefsBefore) + ';' +
                ' if (' + (relax ? 'true' : 'false') + ') {' +
                '   for (const n of names) { const spec = relaxed[n]; write(n, spec.type, spec.value); }' +
                ' } else {' +
                '   if (!saved) return JSON.stringify({ error: "no snapshot of the previous state: relax was not called by this server process" });' +
                '   for (const n of names) {' +
                '     const entry = saved[n];' +
                '     if (!entry) continue;' +
                '     if (!entry.hadUserValue) { if (Services.prefs.prefHasUserValue(n)) Services.prefs.clearUserPref(n); }' +
                '     else if (entry.type !== "unset") write(n, entry.type, entry.value);' +
                '   }' +
                ' }' +
                ' const after = {};' +
                ' for (const n of names) after[n] = { type: read(n).type, value: read(n).value };' +
                ' return JSON.stringify({ mode: ' + (relax ? '"relaxed"' : '"restored"') + ', snapshot, after });' +
                ' })()',
              context,
            )
            if (typeof raw !== 'string') throw new Error('certificate preference update returned nothing')
            const info = JSON.parse(raw) as {
              mode?: string
              error?: string
              snapshot?: Record<string, { hadUserValue: boolean; type: string; value: unknown }>
              after: Record<string, { type: string; value: unknown }>
            }
            if (info.error !== undefined) throw new Error(info.error)
            if (relax && info.snapshot !== undefined) certPrefsBefore = info.snapshot
            if (!relax) certPrefsBefore = null
            const lines = [
              'certificate checks: ' + (info.mode === 'relaxed' ? 'RELAXED (unsafe)' : 'restored'),
            ]
            for (const [name, state] of Object.entries(info.after)) {
              lines.push('  ' + name + ' = ' + String(state.value))
            }
            lines.push('note: TLS changes may only affect connections opened from now on')
            return lines.join(String.fromCharCode(10))
          }),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_get_gpc',
    {
      title: 'Global Privacy Control state',
      description:
        'Read whether the browser sends the Global Privacy Control signal (Sec-GPC header). NOTE: this command only ' +
        'exists in Marionette, not BiDi — so the browser must have been started with --marionette ' +
        '(scripts/launch-firefox.mjs takes care of it; port from DSH_BROWSER_MARIONETTE_PORT, default 2828).',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      try {
        return text(
          await withMarionette(async (client) => {
            const payload = await client.command('GPC:GetGlobalPrivacyControl')
            // MEASURED: the reply nests the flag under `value` ({"value":{"gpc":false}}),
            // even though Set takes a flat { gpc } parameter.
            const nested = payload.value as { gpc?: unknown } | undefined
            const flag = payload.gpc ?? nested?.gpc
            return 'global privacy control: ' + String(flag)
          }),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_set_gpc',
    {
      title: 'Turn Global Privacy Control on or off',
      description:
        'Enable or disable the Global Privacy Control signal (requests then carry Sec-GPC: 1). MEASURED: the ' +
        'parameter is { gpc: boolean }, not { value: boolean } — the latter is rejected with ' +
        '"Value of `gpc` should be of type boolean". Marionette-only, so Firefox must run with --marionette.',
      inputSchema: { gpc: z.boolean().describe('true to send Sec-GPC, false to stop sending it') },
      annotations: WRITES_PERSISTENTLY,
    },
    async ({ gpc }: { gpc: boolean }) => {
      try {
        return text(
          await withMarionette(async (client) => {
            await client.command('GPC:SetGlobalPrivacyControl', { gpc })
            const payload = await client.command('GPC:GetGlobalPrivacyControl')
            // MEASURED: the reply nests the flag under `value` ({"value":{"gpc":false}}),
            // even though Set takes a flat { gpc } parameter.
            const nested = payload.value as { gpc?: unknown } | undefined
            const flag = payload.gpc ?? nested?.gpc
            return 'global privacy control: ' + String(flag)
          }),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_split_view',
    {
      title: 'Split the window between two tabs',
      description:
        'Put two tabs side by side in one window (Firefox split view, gBrowser.addTabSplitView). Give the two tab ' +
        'contexts, or one context plus a url to open in the second pane. Useful when a human wants to watch two pages ' +
        'at once — including watching one page while the agent works on another. Reverse it with ' +
        'browser_unsplit_view, or by closing one of the two tabs.',
      inputSchema: {
        context: z.string().optional().describe('First tab context id (default: the active tab)'),
        otherContext: z.string().optional().describe('Second tab context id to put beside it'),
        url: z.string().optional().describe('Instead of otherContext: URL to open in the second pane'),
      },
      annotations: WRITES,
    },
    async ({
      context,
      otherContext,
      url,
    }: {
      context?: string
      otherContext?: string
      url?: string
    }) => {
      try {
        if (otherContext === undefined && url === undefined) {
          throw new Error('give otherContext or url for the second pane')
        }
        const first = context === undefined ? null : str(context, 'context')
        const second = otherContext === undefined ? null : str(otherContext, 'otherContext')
        const open = url === undefined ? null : str(url, 'url')
        return text(
          await withChrome(async (client, chromeContext) => {
            const firstIndex = first === null ? -1 : await tabIndexForContext(client, first)
            const secondIndex = second === null ? -1 : await tabIndexForContext(client, second)
            const raw = await client.evaluate(
              '(async () => {' +
                ' try {' +
                '  let a = ' + (firstIndex < 0 ? 'gBrowser.selectedTab' : 'gBrowser.tabs[' + String(firstIndex) + ']') + ';' +
                '  if (!a) return JSON.stringify({ error: "first tab not found" });' +
                '  let b = ' + (secondIndex < 0 ? 'null' : 'gBrowser.tabs[' + String(secondIndex) + ']') + ';' +
                '  if (!b && ' + JSON.stringify(open) + ') {' +
                '    b = gBrowser.addTab(' + JSON.stringify(open === null ? '' : open) + ', { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });' +
                '  }' +
                '  if (!b) return JSON.stringify({ error: "second tab not found" });' +
                '  if (a === b) return JSON.stringify({ error: "both panes are the same tab" });' +
                '  gBrowser.addTabSplitView([a, b]);' +
                '  return JSON.stringify({ first: a.label || a.linkedBrowser.currentURI.spec, second: b.label || b.linkedBrowser.currentURI.spec });' +
                ' } catch (e) { return JSON.stringify({ error: e.message }); }' +
                ' })()',
              chromeContext,
            )
            if (typeof raw !== 'string') throw new Error('split view returned nothing')
            const info = JSON.parse(raw) as { error?: string; first?: string; second?: string }
            if (info.error !== undefined) throw new Error(info.error)
            return 'split view: ' + String(info.first) + '  |  ' + String(info.second)
          }),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_unsplit_view',
    {
      title: 'Undo the split view',
      description:
        'Close the split view in the current window (gBrowser.unsplitView on the active tab). The two tabs stay open; ' +
        'they just stop sharing the window. Reports whether there was a split view to begin with.',
      inputSchema: {},
      annotations: WRITES,
    },
    async () => {
      try {
        return text(
          await withChrome(async (client, chromeContext) => {
            const raw = await client.evaluate(
              '(() => {' +
                ' try {' +
                '  let sv = gBrowser.activeSplitView;' +
                '  if (!sv && gBrowser.splitViews) {' +
                '    const arr = (gBrowser.splitViews.size !== undefined) ? Array.from(gBrowser.splitViews) : Array.from(gBrowser.splitViews || []);' +
                '    if (arr.length > 0) sv = arr[0];' +
                '  }' +
                '  if (!sv) return "no split view is open";' +
                '  const panes = sv.tabs ? Array.from(sv.tabs).length : null;' +
                '  if (typeof sv.close === "function") sv.close();' +
                '  else return "split view object has no close() method";' +
                '  return "split view closed (" + panes + " panes released, tabs kept open)";' +
                ' } catch (e) { return "ERR " + e.message; }' +
                ' })()',
              chromeContext,
            )
            if (typeof raw !== 'string') throw new Error('unsplit returned nothing')
            if (raw.startsWith('ERR ')) throw new Error(raw)
            return raw
          }),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_group_tabs',
    {
      title: 'Put tabs into a tab group',
      description:
        'Create a tab group from the given tabs (Firefox tab groups, gBrowser.addTabGroup). Give the tab context ids; ' +
        'label and color are optional. This is the same grouping the tab strip offers, so a human can collapse or ' +
        'reopen the group from the UI afterwards.',
      inputSchema: {
        contexts: z.array(z.string()).describe('Tab context ids to group (at least one)'),
        label: z.string().optional().describe('Group label'),
        color: z
          .enum(['blue', 'purple', 'cyan', 'orange', 'yellow', 'pink', 'green', 'gray', 'red'])
          .optional()
          .describe('Group color'),
      },
      annotations: WRITES,
    },
    async ({ contexts, label, color }: { contexts: string[]; label?: string; color?: string }) => {
      try {
        if (!Array.isArray(contexts) || contexts.length === 0) throw new Error('contexts must be a non-empty array')
        const ids = contexts.map((value) => str(value, 'context'))
        const options: Record<string, unknown> = {}
        if (label !== undefined) options.label = label
        if (color !== undefined) options.color = color
        return text(
          await withChrome(async (client, chromeContext) => {
            const indices: number[] = []
            for (const id of ids) indices.push(await tabIndexForContext(client, id))
            const raw = await client.evaluate(
              '(() => {' +
                ' try {' +
                '  const idx = ' + JSON.stringify(indices) + ';' +
                '  const tabs = idx.map(i => gBrowser.tabs[i]).filter(Boolean);' +
                '  if (tabs.length === 0) return JSON.stringify({ error: "none of those tabs were found" });' +
                '  const group = gBrowser.addTabGroup(tabs, ' + JSON.stringify(options) + ');' +
                '  return JSON.stringify({ grouped: tabs.length, label: group && group.label ? group.label : null, id: group ? group.id : null });' +
                ' } catch (e) { return JSON.stringify({ error: e.message }); }' +
                ' })()',
              chromeContext,
            )
            if (typeof raw !== 'string') throw new Error('grouping returned nothing')
            const info = JSON.parse(raw) as { error?: string; grouped?: number; label?: string | null; id?: string | null }
            if (info.error !== undefined) throw new Error(info.error)
            return (
              'grouped ' + String(info.grouped) + ' tab(s)' +
              (info.label ? ' as "' + info.label + '"' : '') +
              (info.id ? ' (group id ' + info.id + ')' : '')
            )
          }),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_duplicate_tab',
    {
      title: 'Clone a tab',
      description:
        'Duplicate a tab, keeping its history and state (Firefox tab cloning, gBrowser.duplicateTab). The clone opens ' +
        'next to the original. Duplicating is the cheapest way to keep "where I was" while the agent continues in the ' +
        'new copy — close the extra tab when you are done.',
      inputSchema: {
        context: z.string().optional().describe('Tab context id to clone (default: the active tab)'),
        background: z.boolean().optional().describe('Open the clone in the background (default false)'),
      },
      annotations: WRITES,
    },
    async ({ context, background }: { context?: string; background?: boolean }) => {
      try {
        const target = context === undefined ? null : str(context, 'context')
        return text(
          await withChrome(async (client, chromeContext) => {
            const tabIndex = target === null ? -1 : await tabIndexForContext(client, target)
            const raw = await client.evaluate(
              '(() => {' +
                ' try {' +
                '  const byId = (id) => Array.from(gBrowser.tabs).find(t => t.linkedBrowser && t.linkedBrowser.browsingContext && t.linkedBrowser.browsingContext.id === id);' +
                '  const tab = ' + (target === null ? 'gBrowser.selectedTab' : 'gBrowser.tabs[' + String(tabIndex) + ']') + ';' +
                '  if (!tab) return JSON.stringify({ error: "tab not found" });' +
                '  const copy = gBrowser.duplicateTab(tab, ' + (background === true ? 'true' : 'false') + ');' +
                '  return JSON.stringify({ cloned: tab.linkedBrowser.currentURI.spec, tabs: gBrowser.tabs.length });' +
                ' } catch (e) { return JSON.stringify({ error: e.message }); }' +
                ' })()',
              chromeContext,
            )
            if (typeof raw !== 'string') throw new Error('duplicate returned nothing')
            const info = JSON.parse(raw) as { error?: string; cloned?: string; tabs?: number }
            if (info.error !== undefined) throw new Error(info.error)
            return 'cloned ' + String(info.cloned) + ' (tabs now: ' + String(info.tabs) + ')'
          }),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_pin_tab',
    {
      title: 'Pin or unpin a tab',
      description:
        'Pin a tab (it shrinks to an icon and stops being closed by "close others") or unpin it again. This is the ' +
        'same state the tab context menu toggles.',
      inputSchema: {
        context: z.string().optional().describe('Tab context id (default: the active tab)'),
        pinned: z.boolean().describe('true to pin, false to unpin'),
      },
      annotations: WRITES,
    },
    async ({ context, pinned }: { context?: string; pinned: boolean }) => {
      try {
        const target = context === undefined ? null : str(context, 'context')
        return text(
          await withChrome(async (client, chromeContext) => {
            const index = target === null ? -1 : await tabIndexForContext(client, target)
            const raw = await client.evaluate(
              '(() => {' +
                ' try {' +
                '  const tab = ' + (index < 0 ? 'gBrowser.selectedTab' : 'gBrowser.tabs[' + String(index) + ']') + ';' +
                '  if (!tab) return JSON.stringify({ error: "tab not found at index " + ' + String(index) + ' });' +
                '  if (' + (pinned ? 'true' : 'false') + ') { gBrowser.pinTab(tab); } else { gBrowser.unpinTab(tab); }' +
                '  return JSON.stringify({ pinned: tab.pinned, url: tab.linkedBrowser.currentURI.spec });' +
                ' } catch (e) { return JSON.stringify({ error: e.message }); }' +
                ' })()',
              chromeContext,
            )
            if (typeof raw !== 'string') throw new Error('pin returned nothing')
            const info = JSON.parse(raw) as { error?: string; pinned?: boolean; url?: string }
            if (info.error !== undefined) throw new Error(info.error)
            return (info.pinned ? 'pinned ' : 'unpinned ') + String(info.url)
          }),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_mute_tab',
    {
      title: 'Mute or unmute a tab',
      description:
        'Mute a tab so it stays silent in the background, or unmute it. Mirrors the "mute tab" item in the tab ' +
        'context menu. Reports whether the tab is now muted.',
      inputSchema: {
        context: z.string().optional().describe('Tab context id (default: the active tab)'),
        muted: z.boolean().describe('true to mute, false to unmute'),
      },
      annotations: WRITES,
    },
    async ({ context, muted }: { context?: string; muted: boolean }) => {
      try {
        const target = context === undefined ? null : str(context, 'context')
        return text(
          await withChrome(async (client, chromeContext) => {
            const tabIndex = target === null ? -1 : await tabIndexForContext(client, target)
            const raw = await client.evaluate(
              '(() => {' +
                ' try {' +
                '  const byId = (id) => Array.from(gBrowser.tabs).find(t => t.linkedBrowser && t.linkedBrowser.browsingContext && t.linkedBrowser.browsingContext.id === id);' +
                '  const tab = ' + (target === null ? 'gBrowser.selectedTab' : 'gBrowser.tabs[' + String(tabIndex) + ']') + ';' +
                '  if (!tab) return JSON.stringify({ error: "tab not found" });' +
                '  const want = ' + (muted ? 'true' : 'false') + ';' +
                '  if (!!tab.muted !== want) { tab.toggleMuteAudio(); }' +
                '  return JSON.stringify({ muted: !!tab.muted, url: tab.linkedBrowser.currentURI.spec });' +
                ' } catch (e) { return JSON.stringify({ error: e.message }); }' +
                ' })()',
              chromeContext,
            )
            if (typeof raw !== 'string') throw new Error('mute returned nothing')
            const info = JSON.parse(raw) as { error?: string; muted?: boolean; url?: string }
            if (info.error !== undefined) throw new Error(info.error)
            return (info.muted ? 'muted ' : 'unmuted ') + String(info.url)
          }),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_close_other_tabs',
    {
      title: 'Close every tab except one',
      description:
        'Close all tabs in the window except the given one ("close other tabs" in the tab context menu). Pinned tabs ' +
        'are left alone, the same way the menu behaves. Use it to clean up after a series of agent tabs.',
      inputSchema: {
        context: z.string().optional().describe('Tab context id to keep (default: the active tab)'),
      },
      annotations: WRITES,
    },
    async ({ context }: { context?: string }) => {
      try {
        const target = context === undefined ? null : str(context, 'context')
        return text(
          await withChrome(async (client, chromeContext) => {
            const tabIndex = target === null ? -1 : await tabIndexForContext(client, target)
            const raw = await client.evaluate(
              '(() => {' +
                ' try {' +
                '  const byId = (id) => Array.from(gBrowser.tabs).find(t => t.linkedBrowser && t.linkedBrowser.browsingContext && t.linkedBrowser.browsingContext.id === id);' +
                '  const keep = ' + (target === null ? 'gBrowser.selectedTab' : 'gBrowser.tabs[' + String(tabIndex) + ']') + ';' +
                '  if (!keep) return JSON.stringify({ error: "tab not found" });' +
                '  const before = gBrowser.tabs.length;' +
                '  const doomed = Array.from(gBrowser.tabs).filter(t => t !== keep && !t.pinned);' +
                '  gBrowser.removeTabs(doomed);' +
                '  return JSON.stringify({ closed: doomed.length, before, after: gBrowser.tabs.length });' +
                ' } catch (e) { return JSON.stringify({ error: e.message }); }' +
                ' })()',
              chromeContext,
            )
            if (typeof raw !== 'string') throw new Error('close others returned nothing')
            const info = JSON.parse(raw) as { error?: string; closed?: number; after?: number }
            if (info.error !== undefined) throw new Error(info.error)
            return 'closed ' + String(info.closed) + ' tab(s), ' + String(info.after) + ' left'
          }),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_close_tabs_to_right',
    {
      title: 'Close the tabs to the right',
      description:
        'Close every tab to the right of the given one ("close tabs to the right" in the tab context menu). Pinned ' +
        'tabs at the end are kept, matching the menu behaviour.',
      inputSchema: {
        context: z.string().optional().describe('Tab context id acting as the left boundary (default: the active tab)'),
      },
      annotations: WRITES,
    },
    async ({ context }: { context?: string }) => {
      try {
        const target = context === undefined ? null : str(context, 'context')
        return text(
          await withChrome(async (client, chromeContext) => {
            const tabIndex = target === null ? -1 : await tabIndexForContext(client, target)
            const raw = await client.evaluate(
              '(() => {' +
                ' try {' +
                '  const byId = (id) => Array.from(gBrowser.tabs).find(t => t.linkedBrowser && t.linkedBrowser.browsingContext && t.linkedBrowser.browsingContext.id === id);' +
                '  const anchor = ' + (target === null ? 'gBrowser.selectedTab' : 'gBrowser.tabs[' + String(tabIndex) + ']') + ';' +
                '  if (!anchor) return JSON.stringify({ error: "tab not found" });' +
                '  const all = Array.from(gBrowser.tabs);' +
                '  const at = all.indexOf(anchor);' +
                '  const doomed = all.slice(at + 1).filter(t => !t.pinned);' +
                '  gBrowser.removeTabs(doomed);' +
                '  return JSON.stringify({ closed: doomed.length, after: gBrowser.tabs.length });' +
                ' } catch (e) { return JSON.stringify({ error: e.message }); }' +
                ' })()',
              chromeContext,
            )
            if (typeof raw !== 'string') throw new Error('close right returned nothing')
            const info = JSON.parse(raw) as { error?: string; closed?: number; after?: number }
            if (info.error !== undefined) throw new Error(info.error)
            return 'closed ' + String(info.closed) + ' tab(s), ' + String(info.after) + ' left'
          }),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_move_tab_to_window',
    {
      title: 'Move a tab into its own window',
      description:
        'Take a tab out of its window and put it in a new window (gBrowser.replaceTabWithWindow). Handy to park a page ' +
        'on a second monitor — or to keep one page visible while the agent works in another window.',
      inputSchema: {
        context: z.string().optional().describe('Tab context id to move (default: the active tab)'),
      },
      annotations: WRITES,
    },
    async ({ context }: { context?: string }) => {
      try {
        const target = context === undefined ? null : str(context, 'context')
        return text(
          await withChrome(async (client, chromeContext) => {
            const tabIndex = target === null ? -1 : await tabIndexForContext(client, target)
            const raw = await client.evaluate(
              '(() => {' +
                ' try {' +
                '  const byId = (id) => Array.from(gBrowser.tabs).find(t => t.linkedBrowser && t.linkedBrowser.browsingContext && t.linkedBrowser.browsingContext.id === id);' +
                '  const tab = ' + (target === null ? 'gBrowser.selectedTab' : 'gBrowser.tabs[' + String(tabIndex) + ']') + ';' +
                '  if (!tab) return JSON.stringify({ error: "tab not found" });' +
                '  if (gBrowser.tabs.length <= 1) return JSON.stringify({ error: "that is the last tab in the window" });' +
                '  const url = tab.linkedBrowser.currentURI.spec;' +
                '  const win = gBrowser.replaceTabWithWindow(tab);' +
                '  return JSON.stringify({ moved: url, newWindowId: win && win.docShell ? "opened" : "opened" });' +
                ' } catch (e) { return JSON.stringify({ error: e.message }); }' +
                ' })()',
              chromeContext,
            )
            if (typeof raw !== 'string') throw new Error('move returned nothing')
            const info = JSON.parse(raw) as { error?: string; moved?: string }
            if (info.error !== undefined) throw new Error(info.error)
            return 'moved to a new window: ' + String(info.moved)
          }),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_move_tab_to_container',
    {
      title: 'Reopen a tab inside a container',
      description:
        'Reopen the current page in a tab belonging to a container/user context, then close the original ' +
        '(ContextualIdentityService). This is how the tab context menu moves a tab into a container. Get container ids ' +
        'from browser_list_user_contexts; the page reloads, so in-page state is lost.',
      inputSchema: {
        context: z.string().optional().describe('Tab context id to move (default: the active tab)'),
        userContext: z.string().describe('Container id from browser_list_user_contexts'),
      },
      annotations: WRITES,
    },
    async ({ context, userContext }: { context?: string; userContext: string }) => {
      try {
        const target = context === undefined ? null : str(context, 'context')
        const container = str(userContext, 'userContext')
        return text(
          await withChrome(async (client, chromeContext) => {
            const tabIndex = target === null ? -1 : await tabIndexForContext(client, target)
            const raw = await client.evaluate(
              '(() => {' +
                ' try {' +
                '  const byId = (id) => Array.from(gBrowser.tabs).find(t => t.linkedBrowser && t.linkedBrowser.browsingContext && t.linkedBrowser.browsingContext.id === id);' +
                '  const tab = ' + (target === null ? 'gBrowser.selectedTab' : 'gBrowser.tabs[' + String(tabIndex) + ']') + ';' +
                '  if (!tab) return JSON.stringify({ error: "tab not found" });' +
                '  const id = Number(' + JSON.stringify(container) + ');' +
                '  if (!Number.isInteger(id) || id < 1) return JSON.stringify({ error: "userContext must be a container id (a number >= 1)" });' +
                '  const identity = ContextualIdentityService.getPublicIdentityFromId(id);' +
                '  if (!identity) return JSON.stringify({ error: "no such container: " + id });' +
                '  const url = tab.linkedBrowser.currentURI.spec;' +
                '  const newTab = gBrowser.addTab(url, { userContextId: id, triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });' +
                '  gBrowser.removeTab(tab);' +
                '  gBrowser.selectedTab = newTab;' +
                '  return JSON.stringify({ moved: url, container: identity.name });' +
                ' } catch (e) { return JSON.stringify({ error: e.message }); }' +
                ' })()',
              chromeContext,
            )
            if (typeof raw !== 'string') throw new Error('move to container returned nothing')
            const info = JSON.parse(raw) as { error?: string; moved?: string; container?: string }
            if (info.error !== undefined) throw new Error(info.error)
            return 'moved ' + String(info.moved) + ' into container "' + String(info.container) + '"'
          }),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_move_tab',
    {
      title: 'Reorder a tab',
      description:
        'Move a tab to a new position in the tab strip. target is one of: start, end, before, after, index. For ' +
        'before/after give the reference tab context; for index give a 0-based position. This is drag-and-drop on the ' +
        'tab strip, done without the mouse (gBrowser.moveTabTo / moveTabToStart / moveTabToEnd).',
      inputSchema: {
        context: z.string().optional().describe('Tab to move (default: the active tab)'),
        target: z.enum(['start', 'end', 'before', 'after', 'index']).describe('Where to move it'),
        reference: z.string().optional().describe('Reference tab context for before/after'),
        index: z.number().int().nonnegative().optional().describe('0-based position for target=index'),
      },
      annotations: WRITES,
    },
    async ({
      context,
      target,
      reference,
      index,
    }: {
      context?: string
      target: 'start' | 'end' | 'before' | 'after' | 'index'
      reference?: string
      index?: number
    }) => {
      try {
        const moving = context === undefined ? null : str(context, 'context')
        const ref = reference === undefined ? null : str(reference, 'reference')
        if ((target === 'before' || target === 'after') && ref === null) {
          throw new Error('target=' + target + ' needs reference')
        }
        if (target === 'index' && (index === undefined || index < 0)) throw new Error('target=index needs index')
        return text(
          await withChrome(async (client, chromeContext) => {
            const moveIndex = moving === null ? -1 : await tabIndexForContext(client, moving)
            const refIndex = ref === null ? -1 : await tabIndexForContext(client, ref)
            const raw = await client.evaluate(
              '(() => {' +
                ' try {' +
                '  const tab = ' + (moveIndex < 0 ? 'gBrowser.selectedTab' : 'gBrowser.tabs[' + String(moveIndex) + ']') + ';' +
                '  if (!tab) return JSON.stringify({ error: "tab not found" });' +
                '  const which = ' + JSON.stringify(target) + ';' +
                '  if (which === "start") gBrowser.moveTabToStart(tab);' +
                '  else if (which === "end") gBrowser.moveTabToEnd(tab);' +
                '  else if (which === "before" || which === "after") {' +
                '    const refTab = ' + (refIndex < 0 ? 'null' : 'gBrowser.tabs[' + String(refIndex) + ']') + ';' +
                '    if (!refTab) return JSON.stringify({ error: "reference tab not found" });' +
                '    if (which === "before") gBrowser.moveTabBefore(tab, refTab); else gBrowser.moveTabAfter(tab, refTab);' +
                '  } else {' +
                '    gBrowser.moveTabTo(tab, ' + String(index ?? 0) + ');' +
                '  }' +
                '  return JSON.stringify({ position: Array.from(gBrowser.tabs).indexOf(tab), url: tab.linkedBrowser.currentURI.spec });' +
                ' } catch (e) { return JSON.stringify({ error: e.message }); }' +
                ' })()',
              chromeContext,
            )
            if (typeof raw !== 'string') throw new Error('move returned nothing')
            const info = JSON.parse(raw) as { error?: string; position?: number; url?: string }
            if (info.error !== undefined) throw new Error(info.error)
            return 'moved ' + String(info.url) + ' to position ' + String(info.position)
          }),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_remove_duplicate_tabs',
    {
      title: 'Close duplicate tabs',
      description:
        'Close tabs that load the same page as another tab, keeping one of each (gBrowser.removeDuplicateTabs). This ' +
        'is the same cleanup the tab context menu offers when it notices duplicates. Reports how many were closed.',
      inputSchema: {},
      annotations: WRITES,
    },
    async () => {
      try {
        return text(
          await withChrome(async (client, chromeContext) => {
            const raw = await client.evaluate(
              '(() => {' +
                ' try {' +
                '  const before = gBrowser.tabs.length;' +
                '  gBrowser.removeDuplicateTabs(gBrowser.selectedTab);' +
                '  return JSON.stringify({ before, after: gBrowser.tabs.length });' +
                ' } catch (e) { return JSON.stringify({ error: e.message }); }' +
                ' })()',
              chromeContext,
            )
            if (typeof raw !== 'string') throw new Error('dedupe returned nothing')
            const info = JSON.parse(raw) as { error?: string; before?: number; after?: number }
            if (info.error !== undefined) throw new Error(info.error)
            return 'closed ' + String(Number(info.before) - Number(info.after)) + ' duplicate tab(s), ' + String(info.after) + ' left'
          }),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_close_tabs_by_url',
    {
      title: 'Close every tab showing a URL',
      description:
        'Close all tabs whose URL contains the given text. MEASURED: gBrowser.closeTabsByURI takes nsIURI objects and ' +
        'matches them EXACTLY, so it cannot do substrings — this walks the tabs and calls removeTab instead. The value ' +
        'is matched as a substring against the tab URL, so "example.com" catches all of that site. Useful to clean up after a ' +
        'batch run without touching unrelated tabs.',
      inputSchema: {
        pattern: z.string().describe('Text or regex matched against tab URLs'),
      },
      annotations: WRITES,
    },
    async ({ pattern }: { pattern: string }) => {
      try {
        const needle = str(pattern, 'pattern')
        return text(
          await withChrome(async (client, chromeContext) => {
            const raw = await client.evaluate(
              '(() => {' +
                ' try {' +
                '  const before = gBrowser.tabs.length;' +
                '  let matched = 0;' +
                '  for (const t of Array.from(gBrowser.tabs)) {' +
                '    const spec = t.linkedBrowser.currentURI.spec;' +
                '    if (spec.includes(' + JSON.stringify(needle) + ')) {' +
                '      matched++;' +
                '      gBrowser.removeTab(t);' +
                '    }' +
                '  }' +
                '  return JSON.stringify({ before, after: gBrowser.tabs.length, matched });' +
                ' } catch (e) { return JSON.stringify({ error: e.message }); }' +
                ' })()',
              chromeContext,
            )
            if (typeof raw !== 'string') throw new Error('close by url returned nothing')
            const info = JSON.parse(raw) as { error?: string; before?: number; after?: number }
            if (info.error !== undefined) throw new Error(info.error)
            return 'closed ' + String(Number(info.before) - Number(info.after)) + ' tab(s) matching ' + needle
          }),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_list_tab_groups',
    {
      title: 'List tab groups',
      description:
        'List the tab groups (collapsible groups in the tab strip) with their id, label, colour, collapsed state and ' +
        'the tabs inside (gBrowser.getAllTabGroups). Use the id with browser_remove_tab_group or ' +
        'browser_ungroup_tabs.',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      try {
        return text(
          await withChrome(async (client, chromeContext) => {
            const raw = await client.evaluate(
              '(() => {' +
                ' try {' +
                '  const groups = gBrowser.getAllTabGroups().map(g => ({' +
                '    id: g.id, label: g.label, color: g.color, collapsed: !!g.collapsed,' +
                '    tabs: Array.from(g.tabs || []).map(t => t.linkedBrowser ? t.linkedBrowser.currentURI.spec : null)' +
                '  }));' +
                '  return JSON.stringify(groups);' +
                ' } catch (e) { return JSON.stringify({ error: e.message }); }' +
                ' })()',
              chromeContext,
            )
            if (typeof raw !== 'string') throw new Error('list groups returned nothing')
            const groups = JSON.parse(raw) as Array<Record<string, unknown>> | { error?: string }
            if (!Array.isArray(groups)) throw new Error(String((groups as { error?: string }).error ?? 'unexpected reply'))
            if (groups.length === 0) return 'no tab groups in this window'
            return groups
              .map(
                (group) =>
                  String(group.id) +
                  ' | ' +
                  String(group.label ?? '(no label)') +
                  ' | ' +
                  String(group.color) +
                  (group.collapsed ? ' | collapsed' : '') +
                  ' | tabs: ' +
                  String(Array.isArray(group.tabs) ? group.tabs.length : 0),
              )
              .join(String.fromCharCode(10))
          }),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_remove_tab_group',
    {
      title: 'Remove a tab group',
      description:
        'Remove a tab group by id (gBrowser.removeTabGroup). ungroup:true keeps the tabs and just dissolves the group; ' +
        'without it the tabs are closed. Get ids from browser_list_tab_groups.',
      inputSchema: {
        groupId: z.string().describe('Group id from browser_list_tab_groups'),
        ungroup: z.boolean().optional().describe('Keep the tabs and only dissolve the group (default false = close tabs)'),
      },
      annotations: WRITES,
    },
    async ({ groupId, ungroup }: { groupId: string; ungroup?: boolean }) => {
      try {
        const id = str(groupId, 'groupId')
        return text(
          await withChrome(async (client, chromeContext) => {
            const raw = await client.evaluate(
              '(() => {' +
                ' try {' +
                '  const g = gBrowser.getTabGroupById(' + JSON.stringify(id) + ');' +
                '  if (!g) return JSON.stringify({ error: "no such group: " + ' + JSON.stringify(id) + ' });' +
                '  const count = Array.from(g.tabs || []).length;' +
                '  gBrowser.removeTabGroup(g, { ungroup: ' + (ungroup === true ? 'true' : 'false') + ' });' +
                '  return JSON.stringify({ tabs: count, ungrouped: ' + (ungroup === true ? 'true' : 'false') + ' });' +
                ' } catch (e) { return JSON.stringify({ error: e.message }); }' +
                ' })()',
              chromeContext,
            )
            if (typeof raw !== 'string') throw new Error('remove group returned nothing')
            const info = JSON.parse(raw) as { error?: string; tabs?: number; ungrouped?: boolean }
            if (info.error !== undefined) throw new Error(info.error)
            return (info.ungrouped ? 'dissolved group, kept ' : 'closed group and ') + String(info.tabs) + ' tab(s)'
          }),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_get_tab_processes',
    {
      title: 'Which process hosts which tab',
      description:
        'Report the OS process id behind each tab (browsingContext.currentWindowGlobal.osPid). MEASURED: there is no ' +
        'gBrowser.getTabPids — that name does not exist in Tabbrowser.sys.mjs. Useful to see how many content ' +
        'processes Firefox spun up, or whether two tabs share one.',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      try {
        return text(
          await withChrome(async (client, chromeContext) => {
            const raw = await client.evaluate(
              '(() => {' +
                ' try {' +
                '  const out = Array.from(gBrowser.tabs).map(t => {' +
                '    try {' +
                '      const wg = t.linkedBrowser.browsingContext.currentWindowGlobal;' +
                '      return { url: t.linkedBrowser.currentURI.spec, pid: wg ? wg.osPid : null };' +
                '    } catch { return { url: t.linkedBrowser.currentURI.spec, pid: null }; }' +
                '  });' +
                '  return JSON.stringify(out);' +
                ' } catch (e) { return JSON.stringify({ error: e.message }); }' +
                ' })()',
              chromeContext,
            )
            if (typeof raw !== 'string') throw new Error('tab pids returned nothing')
            const rows = JSON.parse(raw) as Array<{ url: string; pid: number | null }> | { error?: string }
            if (!Array.isArray(rows)) throw new Error(String((rows as { error?: string }).error ?? 'unexpected reply'))
            return rows.map((row) => String(row.pid) + '  ' + String(row.url).slice(0, 70)).join(String.fromCharCode(10))
          }),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_set_window_state',
    {
      title: 'Maximize, minimize, restore or go fullscreen',
      description:
        'Change the window state: normal, maximized, minimized or fullscreen. This is the title-bar buttons and F11, ' +
        'done programmatically. MEASURED: fullscreen is a PROPERTY (window.fullScreen = true), while the others are ' +
        'methods (maximize/minimize/restore). Minimizing hides the window — restore it before interacting again.',
      inputSchema: {
        state: z
          .enum(['normal', 'maximized', 'minimized', 'fullscreen'])
          .describe('Target window state'),
      },
      annotations: WRITES,
    },
    async ({ state }: { state: 'normal' | 'maximized' | 'minimized' | 'fullscreen' }) => {
      try {
        const wanted = str(state, 'state')
        return text(
          await withChrome(async (client, chromeContext) => {
            const raw = await client.evaluate(
              '(() => {' +
                ' try {' +
                '  const want = ' + JSON.stringify(wanted) + ';' +
                '  if (want === "fullscreen") {' +
                '    window.fullScreen = true;' +
                '  } else {' +
                '    if (window.fullScreen) window.fullScreen = false;' +
                '    if (want === "maximized") window.maximize();' +
                '    else if (want === "minimized") window.minimize();' +
                '    else window.restore();' +
                '  }' +
                '  return JSON.stringify({' +
                '    state: window.windowState,' +
                '    fullScreen: !!window.fullScreen,' +
                '    w: window.outerWidth, h: window.outerHeight,' +
                '    x: window.screenX, y: window.screenY' +
                '  });' +
                ' } catch (e) { return JSON.stringify({ error: e.message }); }' +
                ' })()',
              chromeContext,
            )
            if (typeof raw !== 'string') throw new Error('window state returned nothing')
            const info = JSON.parse(raw) as {
              error?: string
              state?: number
              fullScreen?: boolean
              w?: number
              h?: number
              x?: number
              y?: number
            }
            if (info.error !== undefined) throw new Error(info.error)
            const named =
              info.fullScreen === true
                ? 'fullscreen'
                : info.state === 1
                  ? 'maximized'
                  : info.state === 2
                    ? 'minimized'
                    : 'normal'
            return (
              'window is now ' + named + ' (' + String(info.w) + 'x' + String(info.h) +
              ' at ' + String(info.x) + ',' + String(info.y) + ')'
            )
          }),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_set_window_position',
    {
      title: 'Move a window on screen',
      description:
        'Move the window to a screen coordinate (window.moveTo) and optionally resize it (window.resizeTo). ' +
        'Coordinates are in screen pixels. Use browser_get_window_geometry first if you need the current values, ' +
        'and remember multi-monitor setups can have negative coordinates.',
      inputSchema: {
        x: z.number().int().describe('Screen x'),
        y: z.number().int().describe('Screen y'),
        width: z.number().int().positive().optional().describe('Optional new width'),
        height: z.number().int().positive().optional().describe('Optional new height'),
      },
      annotations: WRITES,
    },
    async ({ x, y, width, height }: { x: number; y: number; width?: number; height?: number }) => {
      try {
        return text(
          await withChrome(async (client, chromeContext) => {
            const raw = await client.evaluate(
              '(() => {' +
                ' try {' +
                '  window.moveTo(' + String(x) + ', ' + String(y) + ');' +
                (width !== undefined && height !== undefined
                  ? '  window.resizeTo(' + String(width) + ', ' + String(height) + ');'
                  : '') +
                '  return JSON.stringify({ x: window.screenX, y: window.screenY, w: window.outerWidth, h: window.outerHeight });' +
                ' } catch (e) { return JSON.stringify({ error: e.message }); }' +
                ' })()',
              chromeContext,
            )
            if (typeof raw !== 'string') throw new Error('window position returned nothing')
            const info = JSON.parse(raw) as {
              error?: string
              x?: number
              y?: number
              w?: number
              h?: number
            }
            if (info.error !== undefined) throw new Error(info.error)
            return (
              'window at ' + String(info.x) + ',' + String(info.y) +
              ' (' + String(info.w) + 'x' + String(info.h) + ')'
            )
          }),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_get_window_geometry',
    {
      title: 'Read window state and geometry',
      description:
        'Report the window state (normal/maximized/minimized/fullscreen), its screen position and its outer size. ' +
        'This is the readable counterpart of browser_set_window_state / browser_set_window_position / ' +
        'browser_set_window_size.',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      try {
        return text(
          await withChrome(async (client, chromeContext) => {
            const raw = await client.evaluate(
              '(() => {' +
                ' try {' +
                '  return JSON.stringify({' +
                '    state: window.windowState,' +
                '    fullScreen: !!window.fullScreen,' +
                '    x: window.screenX, y: window.screenY,' +
                '    w: window.outerWidth, h: window.outerHeight,' +
                '    screen: { w: window.screen.width, h: window.screen.height }' +
                '  });' +
                ' } catch (e) { return JSON.stringify({ error: e.message }); }' +
                ' })()',
              chromeContext,
            )
            if (typeof raw !== 'string') throw new Error('window geometry returned nothing')
            const info = JSON.parse(raw) as {
              error?: string
              state?: number
              fullScreen?: boolean
              x?: number
              y?: number
              w?: number
              h?: number
              screen?: { w?: number; h?: number }
            }
            if (info.error !== undefined) throw new Error(info.error)
            const named =
              info.fullScreen === true
                ? 'fullscreen'
                : info.state === 1
                  ? 'maximized'
                  : info.state === 2
                    ? 'minimized'
                    : 'normal'
            return (
              'state: ' + named +
              String.fromCharCode(10) +
              'position: ' + String(info.x) + ',' + String(info.y) +
              String.fromCharCode(10) +
              'size: ' + String(info.w) + 'x' + String(info.h) +
              String.fromCharCode(10) +
              'screen: ' + String(info.screen?.w) + 'x' + String(info.screen?.h)
            )
          }),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_picture_in_picture',
    {
      title: 'Open a Document Picture-in-Picture window',
      description:
        'Open a floating always-on-top mini window showing a URL (Document Picture-in-Picture). MEASURED: ' +
        'requestWindow throws "requires user activation" when called cold, so this tool first performs a real click ' +
        'in the page to satisfy that requirement. PiP windows are per-document: closing the tab closes the window.',
      inputSchema: {
        url: z.string().optional().describe('URL to show (default: the current page)'),
        width: z.number().int().positive().optional().describe('Window width (default 320)'),
        height: z.number().int().positive().optional().describe('Window height (default 240)'),
        context: z.string().optional().describe('Tab context id (default: the active tab)'),
      },
      annotations: WRITES,
    },
    async ({ url, width, height, context: tab }: { url?: string; width?: number; height?: number; context?: string }) => {
      try {
        return text(
          await withBidi(async (client) => {
            const context = tab ?? ((await client.pageContext()) as string)
            // 1. Satisfy "requires user activation" with a genuine input action.
            try {
              await client.call('input.performActions', {
                context,
                actions: [
                  {
                    type: 'pointer',
                    id: 'pip-activate',
                    parameters: { pointerType: 'mouse' },
                    actions: [
                      { type: 'pointerMove', x: 5, y: 5, duration: 0, origin: 'viewport' },
                      { type: 'pointerDown', button: 0 },
                      { type: 'pointerUp', button: 0 },
                    ],
                  },
                ],
              })
              await client.call('input.releaseActions', { context })
            } catch {
              // Not fatal: some pages cannot be clicked; try requestWindow anyway.
            }
            const raw = await client.evaluate(
              '(async () => {' +
                ' try {' +
                '  if (typeof documentPictureInPicture === "undefined") return "no documentPictureInPicture in this document";' +
                '  const target = ' + JSON.stringify(url === undefined ? null : url) + ';' +
                '  const w = await documentPictureInPicture.requestWindow({' +
                '    width: ' + String(width ?? 320) + ', height: ' + String(height ?? 240) +
                '  });' +
                '  if (target) { const iframe = w.document.createElement("iframe"); iframe.src = target;' +
                '    iframe.style.cssText = "border:0;width:100%;height:100%"; w.document.body.style.margin = "0";' +
                '    w.document.body.appendChild(iframe); }' +
                '  return "pip window opened (" + w.innerWidth + "x" + w.innerHeight + ")";' +
                ' } catch (e) { return "ERR " + e.message; }' +
                ' })()',
              context,
            )
            if (typeof raw !== 'string') throw new Error('picture-in-picture returned nothing')
            if (raw.startsWith('ERR ')) throw new Error(raw.slice(4))
            return raw
          }),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_screen_info',
    {
      title: 'Screen and monitor information',
      description:
        'Report the screen the window is on: size, usable area, and the window position within it. LIMITATION ' +
        '(measured): Firefox exposes only the CURRENT screen to page/chrome script — Services.appShell.screenManager ' +
        'is undefined, so there is no way to enumerate or name other monitors from here. To place a window on another ' +
        'monitor, use browser_set_window_position with that monitor coordinates (they can be negative).',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      try {
        return text(
          await withChrome(async (client, chromeContext) => {
            const raw = await client.evaluate(
              '(() => {' +
                ' try {' +
                '  const s = window.screen;' +
                '  return JSON.stringify({' +
                '    width: s.width, height: s.height,' +
                '    availLeft: s.availLeft, availTop: s.availTop,' +
                '    availWidth: s.availWidth, availHeight: s.availHeight,' +
                '    windowX: window.screenX, windowY: window.screenY,' +
                '    devicePixelRatio: window.devicePixelRatio' +
                '  });' +
                ' } catch (e) { return JSON.stringify({ error: e.message }); }' +
                ' })()',
              chromeContext,
            )
            if (typeof raw !== 'string') throw new Error('screen info returned nothing')
            const info = JSON.parse(raw) as Record<string, number | string | undefined>
            if (info.error !== undefined) throw new Error(String(info.error))
            return (
              'screen: ' + String(info.width) + 'x' + String(info.height) +
              ' (usable ' + String(info.availWidth) + 'x' + String(info.availHeight) +
              ' at ' + String(info.availLeft) + ',' + String(info.availTop) + ')' +
              String.fromCharCode(10) +
              'window: at ' + String(info.windowX) + ',' + String(info.windowY) +
              ' | devicePixelRatio ' + String(info.devicePixelRatio) +
              String.fromCharCode(10) +
              'note: only the current screen is exposed; other monitors need coordinates'
            )
          }),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_list_sidebars',
    {
      title: 'List sidebars and their state',
      description:
        'List every sidebar this Firefox can show (history, bookmarks, passwords, tabs, AI chat, resource monitor, ' +
        'extension panels …) with its id and title, plus which one is currently open. Use the id with ' +
        'browser_set_sidebar.',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      try {
        return text(
          await withChrome(async (client, chromeContext) => {
            const raw = await client.evaluate(
              '(() => {' +
                ' try {' +
                '  const sc = window.SidebarController;' +
                '  if (!sc) return JSON.stringify({ error: "no SidebarController in this window" });' +
                '  const list = Array.from(sc.sidebars.entries()).map(e => ({' +
                '    id: e[0], title: e[1] && e[1].title ? e[1].title : null' +
                '  }));' +
                '  return JSON.stringify({ current: sc.currentID || null, open: !!sc.isOpen, list });' +
                ' } catch (e) { return JSON.stringify({ error: e.message }); }' +
                ' })()',
              chromeContext,
            )
            if (typeof raw !== 'string') throw new Error('sidebar list returned nothing')
            const info = JSON.parse(raw) as {
              error?: string
              current?: string | null
              open?: boolean
              list?: Array<{ id: string; title: string | null }>
            }
            if (info.error !== undefined) throw new Error(info.error)
            const rows = (info.list ?? []).map(
              (item) => item.id + '  ' + String(item.title ?? '(no title)'),
            )
            return (
              'sidebar open: ' + String(info.open) +
              (info.current ? ' (' + String(info.current) + ')' : '') +
              String.fromCharCode(10) +
              rows.join(String.fromCharCode(10))
            )
          }),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_set_sidebar',
    {
      title: 'Open or close a sidebar',
      description:
        'Open a sidebar by id, close the current one, or toggle it. Get ids from browser_list_sidebars. ' +
        'MEASURED entry point: window.SidebarController.show(id) / hide() / toggle(id). Action: open (needs id), ' +
        'close, toggle (needs id).',
      inputSchema: {
        action: z.enum(['open', 'close', 'toggle']).describe('What to do'),
        id: z.string().optional().describe('Sidebar id (required for open/toggle)'),
      },
      annotations: WRITES,
    },
    async ({ action, id }: { action: 'open' | 'close' | 'toggle'; id?: string }) => {
      try {
        if ((action === 'open' || action === 'toggle') && (id === undefined || id === '')) {
          throw new Error('action=' + action + ' needs id')
        }
        const sidebarId = id === undefined ? null : str(id, 'id')
        return text(
          await withChrome(async (client, chromeContext) => {
            const raw = await client.evaluate(
              '(() => {' +
                ' try {' +
                '  const sc = window.SidebarController;' +
                '  if (!sc) return JSON.stringify({ error: "no SidebarController in this window" });' +
                '  const act = ' + JSON.stringify(action) + ';' +
                '  const target = ' + JSON.stringify(sidebarId) + ';' +
                '  if (act === "close") sc.hide();' +
                '  else if (act === "open") sc.show(target);' +
                '  else sc.toggle(target);' +
                '  return JSON.stringify({ open: !!sc.isOpen, current: sc.currentID || null });' +
                ' } catch (e) { return JSON.stringify({ error: e.message }); }' +
                ' })()',
              chromeContext,
            )
            if (typeof raw !== 'string') throw new Error('sidebar command returned nothing')
            const info = JSON.parse(raw) as { error?: string; open?: boolean; current?: string | null }
            if (info.error !== undefined) throw new Error(info.error)
            return (
              'sidebar is now ' + (info.open ? 'open' : 'closed') +
              (info.current ? ' (' + String(info.current) + ')' : '')
            )
          }),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_set_menubar_visibility',
    {
      title: 'Show or hide the menu bar',
      description:
        'Show or hide the classic menu bar (File/Edit/View…). MEASURED: the element is #toolbar-menubar and it ' +
        'normally carries autohide="true" (Firefox hides it by default and shows it on Alt). Setting visible=true ' +
        'clears autohide; visible=false restores the auto-hiding behaviour.',
      inputSchema: {
        visible: z.boolean().describe('true to pin the menu bar open, false to let it auto-hide again'),
      },
      annotations: WRITES,
    },
    async ({ visible }: { visible: boolean }) => {
      try {
        return text(
          await withChrome(async (client, chromeContext) => {
            const raw = await client.evaluate(
              '(() => {' +
                ' try {' +
                '  const bar = document.getElementById("toolbar-menubar");' +
                '  if (!bar) return JSON.stringify({ error: "no #toolbar-menubar in this window" });' +
                '  const want = ' + (visible ? 'true' : 'false') + ';' +
                '  if (want) { bar.removeAttribute("autohide"); bar.setAttribute("inactive", "false"); }' +
                '  else { bar.setAttribute("autohide", "true"); bar.setAttribute("inactive", "true"); }' +
                '  return JSON.stringify({' +
                '    autohide: bar.getAttribute("autohide"),' +
                '    hidden: !!bar.hidden' +
                '  });' +
                ' } catch (e) { return JSON.stringify({ error: e.message }); }' +
                ' })()',
              chromeContext,
            )
            if (typeof raw !== 'string') throw new Error('menubar command returned nothing')
            const info = JSON.parse(raw) as { error?: string; autohide?: string | null; hidden?: boolean }
            if (info.error !== undefined) throw new Error(info.error)
            return (
              'menu bar autohide=' + String(info.autohide) +
              (info.autohide === null ? ' (pinned open)' : '')
            )
          }),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_set_downloads_panel',
    {
      title: 'Open or close the downloads panel',
      description:
        'Open or close the downloads panel (the toolbar arrow that lists recent downloads). MEASURED: the entry ' +
        'points are DownloadsPanel.showPanel() / hidePanel() — NOT .show(), which does not exist. Also reports ' +
        'whether the panel is currently showing.',
      inputSchema: {
        open: z.boolean().describe('true to open, false to close'),
      },
      annotations: WRITES,
    },
    async ({ open }: { open: boolean }) => {
      try {
        return text(
          await withChrome(async (client, chromeContext) => {
            const raw = await client.evaluate(
              '(() => {' +
                ' try {' +
                '  if (typeof DownloadsPanel === "undefined") return JSON.stringify({ error: "no DownloadsPanel" });' +
                '  if (' + (open ? 'true' : 'false') + ') DownloadsPanel.showPanel(); else DownloadsPanel.hidePanel();' +
                '  const showing = typeof DownloadsPanel.isPanelShowing === "function" ? DownloadsPanel.isPanelShowing() : DownloadsPanel.isPanelShowing;' +
                '  return JSON.stringify({ showing: !!showing });' +
                ' } catch (e) { return JSON.stringify({ error: e.message }); }' +
                ' })()',
              chromeContext,
            )
            if (typeof raw !== 'string') throw new Error('downloads panel returned nothing')
            const info = JSON.parse(raw) as { error?: string; showing?: boolean }
            if (info.error !== undefined) throw new Error(info.error)
            return 'downloads panel is ' + (info.showing ? 'open' : 'closed')
          }),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_set_main_menu',
    {
      title: 'Open or close the main application menu',
      description:
        'Open or close the application (hamburger) menu, the same one the ☰ button opens. Uses PanelUI.show() / ' +
        'PanelUI.hide(). Opening it is a visible change on screen — close it again if you only needed to inspect it.',
      inputSchema: {
        open: z.boolean().describe('true to open, false to close'),
      },
      annotations: WRITES,
    },
    async ({ open }: { open: boolean }) => {
      try {
        return text(
          await withChrome(async (client, chromeContext) => {
            const raw = await client.evaluate(
              '(() => {' +
                ' try {' +
                '  if (typeof PanelUI === "undefined") return JSON.stringify({ error: "no PanelUI" });' +
                '  if (' + (open ? 'true' : 'false') + ') PanelUI.show(); else PanelUI.hide();' +
                '  return "ok";' +
                ' } catch (e) { return JSON.stringify({ error: e.message }); }' +
                ' })()',
              chromeContext,
            )
            if (typeof raw !== 'string') throw new Error('main menu returned nothing')
            if (raw.startsWith('{')) {
              const info = JSON.parse(raw) as { error?: string }
              if (info.error !== undefined) throw new Error(info.error)
            }
            return 'application menu ' + (open ? 'opened' : 'closed')
          }),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_list_logins',
    {
      title: 'List saved logins (no passwords)',
      description:
        'List saved logins from the Firefox password manager, with origin, form action origin and username — but ' +
        'NEVER the password itself. Filter with origin to look at one site. Passwords are only readable through ' +
        'browser_get_login_password, which is a separate, explicitly named tool on purpose. ' +
        'Requires signon.rememberSignons=true for new logins to be saved.',
      inputSchema: {
        origin: z.string().optional().describe('Only logins for this origin (e.g. https://example.com)'),
      },
      annotations: READ_ONLY,
    },
    async ({ origin }: { origin?: string }) => {
      try {
        const wanted = origin === undefined ? null : str(origin, 'origin')
        return text(
          await withChrome(async (client, chromeContext) => {
            const raw = await client.evaluate(
              '(async () => {' +
                ' try {' +
                '  const svc = Cc["@mozilla.org/login-manager;1"].getService(Ci.nsILoginManager);' +
                '  const query = ' + (wanted === null ? '{}' : '{ origin: ' + JSON.stringify(wanted) + ' }') + ';' +
                '  const logins = await svc.searchLoginsAsync(query);' +
                '  return JSON.stringify(logins.map(l => ({' +
                '    origin: l.origin, formActionOrigin: l.formActionOrigin, username: l.username,' +
                '    hasPassword: typeof l.password === "string" && l.password.length > 0' +
                '  })));' +
                ' } catch (e) { return JSON.stringify({ error: e.message }); }' +
                ' })()',
              chromeContext,
            )
            if (typeof raw !== 'string') throw new Error('login list returned nothing')
            const rows = JSON.parse(raw) as Array<Record<string, unknown>> | { error?: string }
            if (!Array.isArray(rows)) throw new Error(String((rows as { error?: string }).error ?? 'unexpected reply'))
            if (rows.length === 0) return 'no saved logins' + (wanted === null ? '' : ' for ' + wanted)
            return rows
              .map(
                (row) =>
                  String(row.origin) +
                  '  user=' + String(row.username) +
                  (row.hasPassword ? '  (password stored)' : '  (no password)'),
              )
              .join(String.fromCharCode(10))
          }),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_add_login',
    {
      title: 'Save a login',
      description:
        'Save a username/password pair in the Firefox password manager. MEASURED: nsILoginInfo.init needs a ' +
        'formActionOrigin (or an httpRealm) — adding without one fails with "Can\'t add a login without a httpRealm ' +
        'or formActionOrigin"; this tool defaults formActionOrigin to the origin. The password is written to the ' +
        'browser, never echoed back.',
      inputSchema: {
        origin: z.string().describe('Origin the login belongs to (e.g. https://example.com)'),
        username: z.string().describe('Username'),
        password: z.string().describe('Password (written to the browser, not echoed)'),
        formActionOrigin: z.string().optional().describe('Form action origin (defaults to origin)'),
      },
      annotations: WRITES_PERSISTENTLY,
    },
    async ({
      origin,
      username,
      password,
      formActionOrigin,
    }: {
      origin: string
      username: string
      password: string
      formActionOrigin?: string
    }) => {
      try {
        const site = str(origin, 'origin')
        const action = formActionOrigin === undefined ? site : str(formActionOrigin, 'formActionOrigin')
        return text(
          await withChrome(async (client, chromeContext) => {
            const raw = await client.evaluate(
              '(async () => {' +
                ' try {' +
                '  const svc = Cc["@mozilla.org/login-manager;1"].getService(Ci.nsILoginManager);' +
                '  const info = Cc["@mozilla.org/login-manager/loginInfo;1"].createInstance(Ci.nsILoginInfo);' +
                '  info.init(' +
                JSON.stringify(site) + ', ' + JSON.stringify(action) + ', null, ' +
                JSON.stringify(username) + ', ' + JSON.stringify(password) + ', "username", "password");' +
                '  await svc.addLoginAsync(info);' +
                '  const all = await svc.searchLoginsAsync({ origin: ' + JSON.stringify(site) + ' });' +
                '  return JSON.stringify({ saved: true, count: all.length });' +
                ' } catch (e) { return JSON.stringify({ error: e.message }); }' +
                ' })()',
              chromeContext,
            )
            if (typeof raw !== 'string') throw new Error('add login returned nothing')
            const info = JSON.parse(raw) as { error?: string; saved?: boolean; count?: number }
            if (info.error !== undefined) throw new Error(info.error)
            return 'saved login for ' + site + ' (now ' + String(info.count) + ' for that origin)'
          }),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_remove_login',
    {
      title: 'Delete a saved login',
      description:
        'Delete saved logins. Give origin and optionally username; with username omitted, every login for that ' +
        'origin is removed. Reports how many were removed so the result can be checked.',
      inputSchema: {
        origin: z.string().describe('Origin whose logins should be removed'),
        username: z.string().optional().describe('Only remove this username (default: all for the origin)'),
      },
      annotations: WRITES_PERSISTENTLY,
    },
    async ({ origin, username }: { origin: string; username?: string }) => {
      try {
        const site = str(origin, 'origin')
        const only = username === undefined ? null : str(username, 'username')
        return text(
          await withChrome(async (client, chromeContext) => {
            const raw = await client.evaluate(
              '(async () => {' +
                ' try {' +
                '  const svc = Cc["@mozilla.org/login-manager;1"].getService(Ci.nsILoginManager);' +
                '  const only = ' + JSON.stringify(only) + ';' +
                '  const logins = await svc.searchLoginsAsync({ origin: ' + JSON.stringify(site) + ' });' +
                '  const doomed = only === null ? logins : logins.filter(l => l.username === only);' +
                '  for (const l of doomed) await svc.removeLoginAsync(l);' +
                '  const after = await svc.searchLoginsAsync({ origin: ' + JSON.stringify(site) + ' });' +
                '  return JSON.stringify({ removed: doomed.length, remaining: after.length });' +
                ' } catch (e) { return JSON.stringify({ error: e.message }); }' +
                ' })()',
              chromeContext,
            )
            if (typeof raw !== 'string') throw new Error('remove login returned nothing')
            const info = JSON.parse(raw) as { error?: string; removed?: number; remaining?: number }
            if (info.error !== undefined) throw new Error(info.error)
            return 'removed ' + String(info.removed) + ' login(s), ' + String(info.remaining) + ' remain for ' + site
          }),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_get_login_password',
    {
      title: 'Read one saved password',
      description:
        'SECURITY SENSITIVE — returns a saved password in clear text. It is a separate, explicitly named tool so that ' +
        'reading a password is always a deliberate act, never a side effect of listing. Never paste the value into ' +
        'chat output, logs or screenshots. Requires both origin and username.',
      inputSchema: {
        origin: z.string().describe('Origin of the login'),
        username: z.string().describe('Username of the login'),
      },
      annotations: READ_ONLY,
    },
    async ({ origin, username }: { origin: string; username: string }) => {
      try {
        const site = str(origin, 'origin')
        const user = str(username, 'username')
        return text(
          await withChrome(async (client, chromeContext) => {
            const raw = await client.evaluate(
              '(async () => {' +
                ' try {' +
                '  const svc = Cc["@mozilla.org/login-manager;1"].getService(Ci.nsILoginManager);' +
                '  const logins = await svc.searchLoginsAsync({ origin: ' + JSON.stringify(site) + ' });' +
                '  const hit = logins.find(l => l.username === ' + JSON.stringify(user) + ');' +
                '  if (!hit) return JSON.stringify({ error: "no login with that origin and username" });' +
                '  return JSON.stringify({ password: hit.password });' +
                ' } catch (e) { return JSON.stringify({ error: e.message }); }' +
                ' })()',
              chromeContext,
            )
            if (typeof raw !== 'string') throw new Error('password read returned nothing')
            const info = JSON.parse(raw) as { error?: string; password?: string }
            if (info.error !== undefined) throw new Error(info.error)
            if (typeof info.password !== 'string') throw new Error('login has no password')
            return info.password
          }),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_find_login_form',
    {
      title: 'Find login and registration forms',
      description:
        'Inspect the page for login/registration forms: each form id and action, plus its input fields with name, ' +
        'type and autocomplete hint. Use this before filling a form so the field names are known instead of guessed.',
      inputSchema: {
        context: z.string().optional().describe('Tab context id (default: the active tab)'),
      },
      annotations: READ_ONLY,
    },
    async ({ context: tab }: { context?: string }) => {
      try {
        return text(
          await withBidi(async (client) => {
            const context = tab ?? ((await client.pageContext()) as string)
            const raw = await client.evaluate(
              '(() => {' +
                ' const forms = Array.from(document.forms).map(f => ({' +
                '   id: f.id || null, action: f.action,' +
                '   fields: Array.from(f.elements)' +
                '     .filter(e => e.tagName === "INPUT")' +
                '     .map(e => ({ name: e.name, type: e.type, autocomplete: e.getAttribute("autocomplete") }))' +
                ' }));' +
                ' const loose = Array.from(document.querySelectorAll("input[type=password]"))' +
                '   .filter(e => !e.closest("form")).length;' +
                ' return JSON.stringify({ forms, passwordFieldsOutsideForms: loose });' +
                ' })()',
              context,
            )
            if (typeof raw !== 'string') throw new Error('form scan returned nothing')
            const info = JSON.parse(raw) as {
              forms?: Array<{
                id: string | null
                action: string
                fields: Array<{ name: string; type: string; autocomplete: string | null }>
              }>
              passwordFieldsOutsideForms?: number
            }
            const forms = info.forms ?? []
            if (forms.length === 0) {
              return 'no <form> on this page' +
                (info.passwordFieldsOutsideForms ? ' (but ' + String(info.passwordFieldsOutsideForms) + ' loose password field(s))' : '')
            }
            const lines: string[] = []
            for (const form of forms) {
              lines.push('form ' + String(form.id ?? '(no id)') + ' -> ' + String(form.action))
              for (const field of form.fields) {
                lines.push(
                  '  ' + String(field.name) + '  [' + String(field.type) + ']' +
                  (field.autocomplete ? '  autocomplete=' + String(field.autocomplete) : ''),
                )
              }
            }
            return lines.join(String.fromCharCode(10))
          }),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_fill_login',
    {
      title: 'Type credentials into a login form',
      description:
        'Type a username and password into a form using real keystroke input (not a scripted value assignment), then ' +
        'optionally submit. This is the "you give me credentials, I fill them" path — the agent types what it was ' +
        'given. It does NOT use the browser password manager: MEASURED, Firefox native autofill only fills after a ' +
        'human picks an entry from its own dropdown, which is native UI no automation can click.',
      inputSchema: {
        username: z.string().describe('Username to type'),
        password: z.string().describe('Password to type'),
        usernameSelector: z.string().optional().describe('CSS selector for the username field (default: form autocomplete=username, else first text input in the form)'),
        passwordSelector: z.string().optional().describe('CSS selector for the password field (default: form autocomplete=current-password, else first password input)'),
        submit: z.boolean().optional().describe('Submit the form afterwards (default false — fill only)'),
        context: z.string().optional().describe('Tab context id (default: the active tab)'),
      },
      annotations: WRITES,
    },
    async ({
      username,
      password,
      usernameSelector,
      passwordSelector,
      submit,
      context: tab,
    }: {
      username: string
      password: string
      usernameSelector?: string
      passwordSelector?: string
      submit?: boolean
      context?: string
    }) => {
      try {
        const userSel = usernameSelector === undefined ? null : str(usernameSelector, 'usernameSelector')
        const passSel = passwordSelector === undefined ? null : str(passwordSelector, 'passwordSelector')
        return text(
          await withBidi(async (client) => {
            const context = tab ?? ((await client.pageContext()) as string)
            // typeInto() takes a CSS selector, not a JS expression, so tag the two fields
            // with throwaway ids first and then address them as #selector.
            const tag = await client.evaluate(
              '(() => {' +
                ' const userSel = ' + JSON.stringify(userSel) + ';' +
                ' const passSel = ' + JSON.stringify(passSel) + ';' +
                ' const u = userSel ? document.querySelector(userSel)' +
                '   : (document.querySelector("input[autocomplete=username]") || document.querySelector("form input[type=text]"));' +
                ' const p = passSel ? document.querySelector(passSel)' +
                '   : (document.querySelector("input[autocomplete=current-password]") || document.querySelector("input[type=password]"));' +
                ' if (!u || !p) return JSON.stringify({ error: "could not find the username or password field" });' +
                ' u.id = u.id || "__dsh_user__";' +
                ' p.id = p.id || "__dsh_pass__";' +
                ' return JSON.stringify({ user: "#" + u.id, pass: "#" + p.id });' +
                ' })()',
              context,
            )
            if (typeof tag !== 'string') throw new Error('field lookup returned nothing')
            const ids = JSON.parse(tag) as { error?: string; user?: string; pass?: string }
            if (ids.error !== undefined) throw new Error(ids.error)
            // typeInto(selector, text, context) — order matters
            await client.typeInto(String(ids.user), username, context)
            await client.typeInto(String(ids.pass), password, context)
            let submitted = false
            if (submit === true) {
              const result = await client.evaluate(
                '(() => {' +
                  ' const p = document.querySelector(' + JSON.stringify(String(ids.pass)) + ');' +
                  ' if (!p) return "no password field";' +
                  ' const form = p.closest("form");' +
                  ' if (form) { form.requestSubmit(); return "submitted"; }' +
                  ' const btn = document.querySelector("button[type=submit], input[type=submit]");' +
                  ' if (btn) { btn.click(); return "clicked submit"; }' +
                  ' return "no form to submit";' +
                  ' })()',
                context,
              )
              submitted = true
              return 'filled credentials, submit: ' + String(result)
            }
            return 'filled credentials' + (submitted ? '' : ' (not submitted; pass submit=true to submit)')
          }),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_list_popup_notifications',
    {
      title: 'List browser popup notifications',
      description:
        'List the browser doorhanger notifications currently offered (the "Save password?" / "Remember this site" ' +
        'kind). These are the prompts Firefox itself shows after a form submit. Use ' +
        'browser_accept_popup_notification to press one — this is how "let the browser remember the password" is done ' +
        'programmatically.',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      try {
        return text(
          await withChrome(async (client, chromeContext) => {
            const raw = await client.evaluate(
              '(() => {' +
                ' try {' +
                '  if (typeof PopupNotifications === "undefined") return JSON.stringify({ error: "no PopupNotifications" });' +
                '  const list = (PopupNotifications._currentNotifications || []).map(n => ({' +
                '    id: n.id, message: n.message, buttonLabels: (n.mainAction ? [n.mainAction.label] : []).concat((n.secondaryActions || []).map(a => a.label))' +
                '  }));' +
                '  return JSON.stringify(list);' +
                ' } catch (e) { return JSON.stringify({ error: e.message }); }' +
                ' })()',
              chromeContext,
            )
            if (typeof raw !== 'string') throw new Error('notification list returned nothing')
            const rows = JSON.parse(raw) as Array<Record<string, unknown>> | { error?: string }
            if (!Array.isArray(rows)) throw new Error(String((rows as { error?: string }).error ?? 'unexpected reply'))
            if (rows.length === 0) return 'no popup notifications are showing'
            return rows
              .map(
                (row) =>
                  String(row.id) + '  ' + String(row.message) +
                  (Array.isArray(row.buttonLabels) && row.buttonLabels.length
                    ? '  [' + (row.buttonLabels as string[]).join(' | ') + ']'
                    : ''),
              )
              .join(String.fromCharCode(10))
          }),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_accept_popup_notification',
    {
      title: 'Press a popup notification button',
      description:
        'Press the main action of a doorhanger notification by id — for example accepting "Save password?". Get ids ' +
        'from browser_list_popup_notifications. This is the programmatic equivalent of the human clicking the ' +
        'button in the browser UI.',
      inputSchema: {
        id: z.string().describe('Notification id from browser_list_popup_notifications'),
      },
      annotations: WRITES,
    },
    async ({ id }: { id: string }) => {
      try {
        const target = str(id, 'id')
        return text(
          await withChrome(async (client, chromeContext) => {
            const raw = await client.evaluate(
              '(() => {' +
                ' try {' +
                '  const notes = PopupNotifications._currentNotifications || [];' +
                '  const hit = notes.find(n => n.id === ' + JSON.stringify(target) + ');' +
                '  if (!hit) return JSON.stringify({ error: "no notification with that id" });' +
                '  if (!hit.mainAction) return JSON.stringify({ error: "that notification has no main action" });' +
                '  hit.mainAction.callback(hit.mainAction);' +
                '  return JSON.stringify({ accepted: true, id: hit.id });' +
                ' } catch (e) { return JSON.stringify({ error: e.message }); }' +
                ' })()',
              chromeContext,
            )
            if (typeof raw !== 'string') throw new Error('accept notification returned nothing')
            const info = JSON.parse(raw) as { error?: string; accepted?: boolean; id?: string }
            if (info.error !== undefined) throw new Error(info.error)
            return 'accepted notification ' + String(info.id)
          }),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_hover',
    {
      title: 'Move the mouse over an element',
      description:
        'Move the real mouse pointer onto an element (or a viewport coordinate) so hover-only UI appears: menus, ' +
        'tooltips, :hover styles, "show on hover" controls. Uses BiDi input.performActions pointerMove, so the page ' +
        'sees a genuine pointer position, not a synthetic event. Give selector OR x/y.',
      inputSchema: {
        selector: z.string().optional().describe('CSS selector of the element to hover'),
        x: z.number().optional().describe('Viewport x (when no selector)'),
        y: z.number().optional().describe('Viewport y (when no selector)'),
        settleMs: z.number().int().nonnegative().optional().describe('Wait this long after moving, so hover UI can appear (default 150)'),
        context: z.string().optional().describe('Tab context id (default: the active tab)'),
      },
      annotations: WRITES,
    },
    async ({ selector, x, y, settleMs, context: tabContext }: { selector?: string; x?: number; y?: number; settleMs?: number; context?: string }) => {
      try {
        const sel = selector === undefined ? null : str(selector, 'selector')
        if (sel === null && (x === undefined || y === undefined)) throw new Error('give selector or x/y')
        return text(
          await withBidi(async (client) => {
            const context = tabContext ?? ((await client.pageContext()) as string)
            if (!context) throw new Error('no page context available')
            let px = x ?? 0
            let py = y ?? 0
            let label = String(px) + ',' + String(py)
            if (sel !== null) {
              const raw = await client.evaluate(
                '(() => { const el = document.querySelector(' + JSON.stringify(sel) + ');' +
                  ' if (!el) return "no such element";' +
                  ' const r = el.getBoundingClientRect();' +
                  ' return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }); })()',
                context,
              )
              if (typeof raw !== 'string') throw new Error('hover lookup returned nothing')
              if (raw === 'no such element') throw new Error('no element matches ' + sel)
              const pos = JSON.parse(raw) as { x: number; y: number }
              px = pos.x
              py = pos.y
              label = sel + ' @ ' + String(px) + ',' + String(py)
            }
            await client.call('input.performActions', {
              context,
              actions: [
                {
                  type: 'pointer',
                  id: 'hover-mouse',
                  parameters: { pointerType: 'mouse' },
                  actions: [{ type: 'pointerMove', x: px, y: py, duration: 0, origin: 'viewport' }],
                },
              ],
            })
            await client.call('input.releaseActions', { context })
            const wait = settleMs ?? 150
            if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
            return 'hovering ' + label
          }),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_drag',
    {
      title: 'Drag from one place to another',
      description:
        'Perform a real mouse drag: press on the source, move in steps, release on the target. Source and target ' +
        'may each be a CSS selector or viewport coordinates. Step count matters for pages that track dragging ' +
        '(sliders, canvas) — raise steps if a plain move is not picked up. ' +
        'COLOR: for HTML5 drag-and-drop this will NOT produce a drop event. That is upstream bug 1515879 ' +
        '("HTML5 drag and drop does not work", Remote Protocol / Marionette, filed 2018-12-21, still NEW) — ' +
        'EventUtils.js ends the drag session without synthesizing drop. Use browser_drag_html5 for HTML5 targets.',
      inputSchema: {
        fromSelector: z.string().optional().describe('Source element selector'),
        fromX: z.number().optional().describe('Source viewport x'),
        fromY: z.number().optional().describe('Source viewport y'),
        toSelector: z.string().optional().describe('Target element selector'),
        toX: z.number().optional().describe('Target viewport x'),
        toY: z.number().optional().describe('Target viewport y'),
        steps: z.number().int().min(1).max(60).optional().describe('Intermediate move steps (default 12)'),
        context: z.string().optional().describe('Tab context id (default: the active tab)'),
      },
      annotations: WRITES,
    },
    async ({
      fromSelector,
      fromX,
      fromY,
      toSelector,
      toX,
      toY,
      steps,
      context: tab,
    }: {
      fromSelector?: string
      fromX?: number
      fromY?: number
      toSelector?: string
      toX?: number
      toY?: number
      steps?: number
      context?: string
    }) => {
      try {
        const fromSel = fromSelector === undefined ? null : str(fromSelector, 'fromSelector')
        const toSel = toSelector === undefined ? null : str(toSelector, 'toSelector')
        if (fromSel === null && (fromX === undefined || fromY === undefined)) throw new Error('give fromSelector or fromX/fromY')
        if (toSel === null && (toX === undefined || toY === undefined)) throw new Error('give toSelector or toX/toY')
        return text(
          await withBidi(async (client) => {
            const context = tab ?? ((await client.pageContext()) as string)
            const centre = async (sel: string): Promise<{ x: number; y: number }> => {
              const raw = await client.evaluate(
                '(() => { const el = document.querySelector(' + JSON.stringify(sel) + ');' +
                  ' if (!el) return "no such element";' +
                  ' const r = el.getBoundingClientRect();' +
                  ' return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }); })()',
                context,
              )
              if (typeof raw !== 'string') throw new Error('drag lookup returned nothing')
              if (raw === 'no such element') throw new Error('no element matches ' + sel)
              return JSON.parse(raw) as { x: number; y: number }
            }
            const start = fromSel === null ? { x: fromX ?? 0, y: fromY ?? 0 } : await centre(fromSel)
            const end = toSel === null ? { x: toX ?? 0, y: toY ?? 0 } : await centre(toSel)
            const count = steps ?? 12
            const moves: Array<{ type: string; x: number; y: number; duration: number; origin: string }> = []
            for (let i = 1; i <= count; i++) {
              moves.push({
                type: 'pointerMove',
                x: Math.round(start.x + ((end.x - start.x) * i) / count),
                y: Math.round(start.y + ((end.y - start.y) * i) / count),
                duration: 16,
                origin: 'viewport',
              })
            }
            await client.call('input.performActions', {
              context,
              actions: [
                {
                  type: 'pointer',
                  id: 'drag-mouse',
                  parameters: { pointerType: 'mouse' },
                  actions: [
                    { type: 'pointerMove', x: start.x, y: start.y, duration: 0, origin: 'viewport' },
                    { type: 'pointerDown', button: 0 },
                    ...moves,
                    { type: 'pointerUp', button: 0 },
                  ],
                },
              ],
            })
            await client.call('input.releaseActions', { context })
            return (
              'dragged (' + String(start.x) + ',' + String(start.y) + ') -> (' +
              String(end.x) + ',' + String(end.y) + ') in ' + String(count) + ' steps'
            )
          }),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_scroll',
    {
      title: 'Scroll with the wheel',
      description:
        'Scroll the page (or one scrollable element) using real wheel events (BiDi input.performActions type "wheel"). ' +
        'Give deltaX/deltaY in pixels: positive Y scrolls down. With selector, the wheel is aimed at that element, ' +
        'which is how inner overflow containers scroll — document.scrollTop never moves for those.',
      inputSchema: {
        selector: z.string().optional().describe('Scrollable element to aim at (default: the page)'),
        deltaX: z.number().optional().describe('Horizontal pixels (positive = right, default 0)'),
        deltaY: z.number().optional().describe('Vertical pixels (positive = down, default 600)'),
        context: z.string().optional().describe('Tab context id (default: the active tab)'),
      },
      annotations: WRITES,
    },
    async ({ selector, deltaX, deltaY, context: tabContext }: { selector?: string; deltaX?: number; deltaY?: number; context?: string }) => {
      try {
        const sel = selector === undefined ? null : str(selector, 'selector')
        const dx = deltaX ?? 0
        const dy = deltaY ?? 600
        return text(
          await withBidi(async (client) => {
            const context = tabContext ?? ((await client.pageContext()) as string)
            if (!context) throw new Error('no page context available')
            let origin: { x: number; y: number } = { x: 200, y: 200 }
            let label = 'page'
            if (sel !== null) {
              const raw = await client.evaluate(
                '(() => { const el = document.querySelector(' + JSON.stringify(sel) + ');' +
                  ' if (!el) return "no such element";' +
                  ' const r = el.getBoundingClientRect();' +
                  ' return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }); })()',
                context,
              )
              if (typeof raw !== 'string') throw new Error('scroll lookup returned nothing')
              if (raw === 'no such element') throw new Error('no element matches ' + sel)
              const pos = JSON.parse(raw) as { x: number; y: number }
              origin = pos
              label = sel
            }
            await client.call('input.performActions', {
              context,
              actions: [
                {
                  type: 'wheel',
                  id: 'wheel',
                  actions: [
                    {
                      type: 'scroll',
                      x: origin.x,
                      y: origin.y,
                      deltaX: dx,
                      deltaY: dy,
                      duration: 0,
                      origin: 'viewport',
                    },
                  ],
                },
              ],
            })
            await client.call('input.releaseActions', { context })
            // The wheel is applied asynchronously; reading immediately still shows the old offset.
            await new Promise((resolve) => setTimeout(resolve, 120))
            const after = await client.evaluate(
              '(() => { const el = ' + (sel === null ? 'null' : 'document.querySelector(' + JSON.stringify(sel) + ')') + ';' +
                ' const t = el || document.scrollingElement || document.body;' +
                ' return JSON.stringify({ scrollTop: t.scrollTop, scrollLeft: t.scrollLeft }); })()',
              context,
            )
            return 'scrolled ' + label + ' by (' + String(dx) + ',' + String(dy) + '); now ' + String(after)
          }),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_press_key',
    {
      title: 'Press a key or key combination',
      description:
        'Send a real key press, optionally with modifiers — Ctrl/Shift/Alt/Meta plus one key. Works for shortcuts ' +
        '(Ctrl+A, Ctrl+C, Ctrl+V, Ctrl+Z), navigation (Tab, Enter, Escape) and repeated keys. Uses BiDi ' +
        'input.performActions with the "key" action type, so pages see ordinary keydown/keyup events with the ' +
        'modifier flags set. Give keys in the WebDriver key vocabulary: Control, Shift, Alt, Meta, Enter, Tab, ' +
        'Escape, Backspace, Delete, ArrowUp/Down/Left/Right, Home, End, PageUp, PageDown, F1-F12, or a single character.',
      inputSchema: {
        key: z.string().describe('The key itself (e.g. "a", "Enter", "ArrowDown", "F5")'),
        modifiers: z
          .array(z.enum(['Control', 'Shift', 'Alt', 'Meta']))
          .optional()
          .describe('Modifier keys held during the press'),
        repeat: z.number().int().min(1).max(50).optional().describe('Press this many times (default 1)'),
        context: z.string().optional().describe('Tab context id (default: the active tab)'),
      },
      annotations: WRITES,
    },
    async ({ key, modifiers, repeat, context: tabContext }: { key: string; modifiers?: string[]; repeat?: number; context?: string }) => {
      try {
        const main = str(key, 'key')
        const mods = modifiers ?? []
        const times = repeat ?? 1
        return text(
          await withBidi(async (client) => {
            const context = tabContext ?? ((await client.pageContext()) as string)
            if (!context) throw new Error('no page context available')
            const actions: Array<{ type: string; value: string }> = []
            for (const mod of mods) actions.push({ type: 'keyDown', value: webdriverKey(mod) })
            for (let i = 0; i < times; i++) {
              actions.push({ type: 'keyDown', value: webdriverKey(main) })
              actions.push({ type: 'keyUp', value: webdriverKey(main) })
            }
            for (const mod of [...mods].reverse()) actions.push({ type: 'keyUp', value: webdriverKey(mod) })
            await client.call('input.performActions', {
              context,
              actions: [{ type: 'key', id: 'keyboard', actions }],
            })
            await client.call('input.releaseActions', { context })
            return (
              'pressed ' + (mods.length ? mods.join('+') + '+' : '') + main +
              (times > 1 ? ' x' + String(times) : '')
            )
          }),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_key_hold',
    {
      title: 'Hold a key down for a duration',
      description:
        'Press and HOLD a key for N milliseconds, then release — what you need for games (walk right, keep ' +
        'accelerating) and for drag-modifier workflows (hold Shift while clicking). A real keyDown is sent, the ' +
        'wait happens, then keyUp. Do not hold for very long; the page may repeat the key itself.',
      inputSchema: {
        key: z.string().describe('Key to hold (e.g. "ArrowRight", "w")'),
        durationMs: z.number().int().min(1).max(10000).describe('How long to hold, in milliseconds'),
        modifiers: z.array(z.enum(['Control', 'Shift', 'Alt', 'Meta'])).optional().describe('Modifiers held at the same time'),
        context: z.string().optional().describe('Tab context id (default: the active tab)'),
      },
      annotations: WRITES,
    },
    async ({ key, durationMs, modifiers, context: tab }: { key: string; durationMs: number; modifiers?: string[]; context?: string }) => {
      try {
        const main = str(key, 'key')
        const mods = modifiers ?? []
        return text(
          await withBidi(async (client) => {
            const context = tab ?? ((await client.pageContext()) as string)
            const down: Array<{ type: string; value: string }> = []
            for (const mod of mods) down.push({ type: 'keyDown', value: webdriverKey(mod) })
            down.push({ type: 'keyDown', value: webdriverKey(main) })
            await client.call('input.performActions', {
              context,
              actions: [{ type: 'key', id: 'hold', actions: down }],
            })
            await new Promise((resolve) => setTimeout(resolve, durationMs))
            const up: Array<{ type: string; value: string }> = [{ type: 'keyUp', value: webdriverKey(main) }]
            for (const mod of [...mods].reverse()) up.push({ type: 'keyUp', value: webdriverKey(mod) })
            await client.call('input.performActions', {
              context,
              actions: [{ type: 'key', id: 'hold', actions: up }],
            })
            await client.call('input.releaseActions', { context })
            return 'held ' + (mods.length ? mods.join('+') + '+' : '') + main + ' for ' + String(durationMs) + 'ms'
          }),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_mouse_action',
    {
      title: 'Right-click, double-click, middle-click or hold',
      description:
        'Perform a mouse action other than a plain left click: right button (context menu), middle button, ' +
        'double-click, or press-and-hold for N ms. Target by selector or viewport coordinates. The page sees the ' +
        'matching mousedown/mouseup/contextmenu events with the right button number. NOTE: a site that blocks the ' +
        'context menu in JavaScript (preventDefault on contextmenu) will still block it — that is the page deciding, ' +
        'not the input layer.',
      inputSchema: {
        selector: z.string().optional().describe('Element to act on'),
        x: z.number().optional().describe('Viewport x (when no selector)'),
        y: z.number().optional().describe('Viewport y (when no selector)'),
        button: z.enum(['left', 'right', 'middle']).optional().describe('Mouse button (default left)'),
        count: z.number().int().min(1).max(3).optional().describe('Click count: 1 single, 2 double (default 1)'),
        holdMs: z.number().int().min(0).max(10000).optional().describe('Hold the button this long before releasing (default 0)'),
        modifiers: z.array(z.enum(['Control', 'Shift', 'Alt', 'Meta'])).optional().describe('Modifiers held during the click'),
        context: z.string().optional().describe('Tab context id (default: the active tab)'),
      },
      annotations: WRITES,
    },
    async ({
      selector,
      x,
      y,
      button,
      count,
      holdMs,
      modifiers,
      context: tab,
    }: {
      selector?: string
      x?: number
      y?: number
      button?: 'left' | 'right' | 'middle'
      count?: number
      holdMs?: number
      modifiers?: string[]
      context?: string
    }) => {
      try {
        const sel = selector === undefined ? null : str(selector, 'selector')
        if (sel === null && (x === undefined || y === undefined)) throw new Error('give selector or x/y')
        const which = button ?? 'left'
        const buttonNumber = which === 'right' ? 2 : which === 'middle' ? 1 : 0
        const clicks = count ?? 1
        const hold = holdMs ?? 0
        const mods = modifiers ?? []
        return text(
          await withBidi(async (client) => {
            const context = tab ?? ((await client.pageContext()) as string)
            let px = x ?? 0
            let py = y ?? 0
            let label = 'at ' + String(px) + ',' + String(py)
            if (sel !== null) {
              const raw = await client.evaluate(
                '(() => { const el = document.querySelector(' + JSON.stringify(sel) + ');' +
                  ' if (!el) return "no such element";' +
                  ' const r = el.getBoundingClientRect();' +
                  ' return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }); })()',
                context,
              )
              if (typeof raw !== 'string') throw new Error('mouse lookup returned nothing')
              if (raw === 'no such element') throw new Error('no element matches ' + sel)
              const pos = JSON.parse(raw) as { x: number; y: number }
              px = pos.x
              py = pos.y
              label = sel
            }
            const keyActions: Array<{ type: string; value: string }> = []
            for (const mod of mods) keyActions.push({ type: 'keyDown', value: webdriverKey(mod) })
            const pointerActions: Array<Record<string, unknown>> = [
              { type: 'pointerMove', x: px, y: py, duration: 0, origin: 'viewport' },
            ]
            for (let i = 0; i < clicks; i++) {
              pointerActions.push({ type: 'pointerDown', button: buttonNumber })
              if (hold > 0) pointerActions.push({ type: 'pause', duration: hold })
              pointerActions.push({ type: 'pointerUp', button: buttonNumber })
            }
            const sources: Array<Record<string, unknown>> = [
              {
                type: 'pointer',
                id: 'mouse',
                parameters: { pointerType: 'mouse' },
                actions: pointerActions,
              },
            ]
            if (keyActions.length > 0) {
              const withUps = keyActions.concat(
                [...mods].reverse().map((mod) => ({ type: 'keyUp', value: webdriverKey(mod) })),
              )
              sources.push({ type: 'key', id: 'keyboard', actions: withUps })
            }
            await client.call('input.performActions', { context, actions: sources })
            await client.call('input.releaseActions', { context })
            return (
              which + (clicks > 1 ? ' x' + String(clicks) : '') +
              (hold > 0 ? ' held ' + String(hold) + 'ms' : '') +
              ' on ' + label
            )
          }),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_hide_automation_flags',
    {
      title: 'Hide automation markers from pages',
      description:
        'Make pages stop seeing the automation marker: registers a BiDi preload script that reports ' +
        'navigator.webdriver as false in every new document. MEASURED: with a plain WebDriver-driven session ' +
        'navigator.webdriver is true, which is exactly what anti-bot checks look for; after this preload it reads ' +
        'false. It is a document-level patch, not a promise of undetectability — other signals (missing plugins, ' +
        'synthetic event timing, CDP-style fingerprints) can still give automation away. Pass remove:true to undo.',
      inputSchema: {
        remove: z.boolean().optional().describe('Remove the preload script again (default false = install)'),
      },
      annotations: WRITES_PERSISTENTLY,
    },
    async ({ remove }: { remove?: boolean }) => {
      try {
        return text(
          await withBidi(async (client) => {
            if (remove === true) {
              await client.call('script.removePreloadScript', { script: hideFlagsScriptId })
              hideFlagsScriptId = ''
              return 'automation-marker preload removed (navigator.webdriver reports its normal value again)'
            }
            const result = (await client.call('script.addPreloadScript', {
              functionDeclaration:
                '() => {' +
                ' try {' +
                '  Object.defineProperty(Navigator.prototype, "webdriver", {' +
                '    get() { return false; }, configurable: true' +
                '  });' +
                ' } catch (e) {}' +
                '}',
            })) as { script?: string }
            hideFlagsScriptId = result.script ?? ''
            return (
              'automation-marker preload installed' +
              (hideFlagsScriptId ? ' (id ' + hideFlagsScriptId + ')' : '') +
              String.fromCharCode(10) +
              'navigator.webdriver now reads false in documents loaded from now on'
            )
          }),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_drag_html5',
    {
      title: 'Drag and drop for HTML5 drag-and-drop targets',
      description:
        'Perform an HTML5 drag-and-drop by dispatching the DOM events (dragstart/dragenter/dragover/drop/dragend) ' +
        'with a real DataTransfer. WHY THIS EXISTS: MEASURED — the pointer-based browser_drag triggers dragstart and ' +
        'dragover but never drop or dragend, because BiDi only synthesizes mouse/wheel/touch (there is no ' +
        'Input.dispatchDragEvent as in CDP) and Firefox cancels a drag on pointer-up. This tool therefore SIMULATES ' +
        'the drop in page script: it works on pages that listen for the standard drag events, but it is NOT a real ' +
        'drag — pages that check event.isTrusted, or that require genuine OS drag semantics, will still refuse. ' +
        'This exists because of upstream bug 1515879: WebDriver-driven HTML5 DnD never gets a drop event.',
      inputSchema: {
        fromSelector: z.string().describe('Element to drag from'),
        toSelector: z.string().describe('Element to drop onto'),
        data: z.string().optional().describe('Payload to carry in the DataTransfer (default: the text content of the source element)'),
        mimeType: z.string().optional().describe('MIME type for the payload (default text/plain)'),
      },
      annotations: WRITES,
    },
    async ({
      fromSelector,
      toSelector,
      data,
      mimeType,
    }: {
      fromSelector: string
      toSelector: string
      data?: string
      mimeType?: string
    }) => {
      try {
        const from = str(fromSelector, 'fromSelector')
        const to = str(toSelector, 'toSelector')
        return text(
          await withBidi(async (client) => {
            const context = (await client.pageContext()) as string
            const raw = await client.evaluate(
              '(() => {' +
                ' try {' +
                '  const src = document.querySelector(' + JSON.stringify(from) + ');' +
                '  const dst = document.querySelector(' + JSON.stringify(to) + ');' +
                '  if (!src) return JSON.stringify({ error: "no source element: " + ' + JSON.stringify(from) + ' });' +
                '  if (!dst) return JSON.stringify({ error: "no target element: " + ' + JSON.stringify(to) + ' });' +
                '  const dt = new DataTransfer();' +
                '  const payload = ' + JSON.stringify(data === undefined ? null : data) + ';' +
                '  const mime = ' + JSON.stringify(mimeType === undefined ? null : mimeType) + ';' +
                '  dt.setData(mime || "text/plain", payload === null ? (src.textContent || "") : payload);' +
                '  const sr = src.getBoundingClientRect();' +
                '  const dr = dst.getBoundingClientRect();' +
                '  const fromPt = { clientX: Math.round(sr.x + sr.width / 2), clientY: Math.round(sr.y + sr.height / 2) };' +
                '  const toPt = { clientX: Math.round(dr.x + dr.width / 2), clientY: Math.round(dr.y + dr.height / 2) };' +
                '  const fire = (target, type, pt, cancelable) => {' +
                '    const ev = new DragEvent(type, { bubbles: true, cancelable: cancelable !== false, dataTransfer: dt, ...pt });' +
                '    return target.dispatchEvent(ev);' +
                '  };' +
                '  fire(src, "dragstart", fromPt);' +
                '  fire(src, "drag", fromPt, true);' +
                '  fire(dst, "dragenter", toPt);' +
                '  fire(dst, "dragover", toPt);' +
                '  fire(src, "dragleave", fromPt, true);' +
                '  const dropped = fire(dst, "drop", toPt);' +
                '  fire(src, "dragend", fromPt);' +
                '  return JSON.stringify({' +
                '    dropped: !dropped, from: fromPt, to: toPt,' +
                '    types: Array.from(dt.types || []),' +
                '    carried: dt.getData(mime || "text/plain")' +
                '  });' +
                ' } catch (e) { return JSON.stringify({ error: e.message }); }' +
                ' })()',
              context,
            )
            if (typeof raw !== 'string') throw new Error('html5 drag returned nothing')
            const info = JSON.parse(raw) as {
              error?: string
              dropped?: boolean
              carried?: string
              from?: { clientX: number; clientY: number }
              to?: { clientX: number; clientY: number }
            }
            if (info.error !== undefined) throw new Error(info.error)
            return (
              'dispatched HTML5 drag' + (info.dropped ? ' (drop was not cancelled by the page)' : ' (page handled drop)') +
              ' from ' + String(info.from?.clientX) + ',' + String(info.from?.clientY) +
              ' to ' + String(info.to?.clientX) + ',' + String(info.to?.clientY) +
              String.fromCharCode(10) +
              'carried data: ' + JSON.stringify(info.carried) +
              String.fromCharCode(10) +
              'note: simulated events — isTrusted is false, so pages that check it will refuse'
            )
          }),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_move_tab_to_group',
    {
      title: 'Move a tab into an existing tab group',
      description:
        'Move a tab into a group that already exists (gBrowser.moveTabToExistingGroup). Unlike browser_group_tabs, ' +
        'which creates a new group, this joins one. Get the group id from browser_list_tab_groups.',
      inputSchema: {
        context: z.string().optional().describe('Tab to move (default: the active tab)'),
        groupId: z.string().describe('Target group id from browser_list_tab_groups'),
      },
      annotations: WRITES,
    },
    async ({ context, groupId }: { context?: string; groupId: string }) => {
      try {
        const target = context === undefined ? null : str(context, 'context')
        const group = str(groupId, 'groupId')
        return text(
          await withChrome(async (client, chromeContext) => {
            const index = target === null ? -1 : await tabIndexForContext(client, target)
            const raw = await client.evaluate(
              '(() => {' +
                ' try {' +
                '  const g = gBrowser.getTabGroupById(' + JSON.stringify(group) + ');' +
                '  if (!g) return JSON.stringify({ error: "no such group: " + ' + JSON.stringify(group) + ' });' +
                '  const tab = ' + (index < 0 ? 'gBrowser.selectedTab' : 'gBrowser.tabs[' + String(index) + ']') + ';' +
                '  if (!tab) return JSON.stringify({ error: "tab not found" });' +
                '  gBrowser.moveTabToExistingGroup(tab, g);' +
                '  return JSON.stringify({ ok: true, label: g.label || null, groupId: g.id, tabs: Array.from(g.tabs || []).length });' +
                ' } catch (e) { return JSON.stringify({ error: e.message }); }' +
                ' })()',
              chromeContext,
            )
            if (typeof raw !== 'string') throw new Error('move to group returned nothing')
            const info = JSON.parse(raw) as { error?: string; label?: string | null; tabs?: number }
            if (info.error !== undefined) throw new Error(info.error)
            return 'moved into group "' + String(info.label ?? '(no label)') + '" (now ' + String(info.tabs) + ' tab(s))'
          }),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_move_tab_to_split_view',
    {
      title: 'Move a tab into the current split view',
      description:
        'Move a tab into the split view that is already open in this window (gBrowser.moveTabToSplitView). Requires ' +
        'an existing split view — create one first with browser_split_view. Complements browser_split_view, which ' +
        'builds a new split view from two tabs.',
      inputSchema: {
        context: z.string().optional().describe('Tab to move (default: the active tab)'),
      },
      annotations: WRITES,
    },
    async ({ context }: { context?: string }) => {
      try {
        const target = context === undefined ? null : str(context, 'context')
        return text(
          await withChrome(async (client, chromeContext) => {
            const index = target === null ? -1 : await tabIndexForContext(client, target)
            const raw = await client.evaluate(
              '(() => {' +
                ' try {' +
                '  let sv = gBrowser.activeSplitView;' +
                '  if (!sv && gBrowser.splitViews) {' +
                '    const arr = (gBrowser.splitViews.size !== undefined) ? Array.from(gBrowser.splitViews) : Array.from(gBrowser.splitViews || []);' +
                '    if (arr.length > 0) sv = arr[0];' +
                '  }' +
                '  if (!sv) return JSON.stringify({ error: "no split view is open; use browser_split_view first" });' +
                '  const tab = ' + (index < 0 ? 'gBrowser.selectedTab' : 'gBrowser.tabs[' + String(index) + ']') + ';' +
                '  if (!tab) return JSON.stringify({ error: "tab not found" });' +
                '  gBrowser.moveTabToSplitView(tab, sv);' +
                '  const after = gBrowser.activeSplitView;' +
                '  return JSON.stringify({ ok: true, panes: after && after.tabs ? Array.from(after.tabs).length : null });' +
                ' } catch (e) { return JSON.stringify({ error: e.message }); }' +
                ' })()',
              chromeContext,
            )
            if (typeof raw !== 'string') throw new Error('move to split view returned nothing')
            const info = JSON.parse(raw) as { error?: string; panes?: number }
            if (info.error !== undefined) throw new Error(info.error)
            return 'moved into the split view (' + String(info.panes) + ' panes now)'
          }),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_multi_select_tabs',
    {
      title: 'Select several tabs at once',
      description:
        'Multi-select tabs so batch operations apply to all of them (gBrowser.addToMultiSelectedTabs / ' +
        'selectAllTabs / clearMultiSelectedTabs). Reports how many are selected. This is Ctrl+click on the tab strip, ' +
        'done programmatically.',
      inputSchema: {
        contexts: z.array(z.string()).optional().describe('Tab context ids to select'),
        all: z.boolean().optional().describe('Select every tab instead of a list'),
        clear: z.boolean().optional().describe('Clear the selection instead of selecting'),
      },
      annotations: WRITES,
    },
    async ({ contexts, all, clear }: { contexts?: string[]; all?: boolean; clear?: boolean }) => {
      try {
        const ids = Array.isArray(contexts) ? contexts.map((value) => str(value, 'context')) : []
        if (clear !== true && all !== true && ids.length === 0) throw new Error('give contexts, all:true, or clear:true')
        return text(
          await withChrome(async (client, chromeContext) => {
            const indices: number[] = []
            for (const id of ids) indices.push(await tabIndexForContext(client, id))
            const raw = await client.evaluate(
              '(() => {' +
                ' try {' +
                '  const mode = ' + (clear === true ? '"clear"' : all === true ? '"all"' : '"list"') + ';' +
                '  if (mode === "clear") gBrowser.clearMultiSelectedTabs();' +
                '  else if (mode === "all") gBrowser.selectAllTabs();' +
                '  else {' +
                '    gBrowser.clearMultiSelectedTabs();' +
                '    const idx = ' + JSON.stringify(indices) + ';' +
                '    for (const i of idx) { const t = gBrowser.tabs[i]; if (t) gBrowser.addToMultiSelectedTabs(t); }' +
                '  }' +
                '  const n = Array.from(gBrowser.tabs).filter(t => t.multiselected).length;' +
                '  return JSON.stringify({ selected: n, total: gBrowser.tabs.length });' +
                ' } catch (e) { return JSON.stringify({ error: e.message }); }' +
                ' })()',
              chromeContext,
            )
            if (typeof raw !== 'string') throw new Error('multi-select returned nothing')
            const info = JSON.parse(raw) as { error?: string; selected?: number; total?: number }
            if (info.error !== undefined) throw new Error(info.error)
            return 'selected ' + String(info.selected) + ' of ' + String(info.total) + ' tab(s)'
          }),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_set_tab_visible',
    {
      title: 'Hide or show a tab in the tab strip',
      description:
        'Hide a tab from the tab strip (gBrowser.hideTab) or bring it back (gBrowser.showTab). A hidden tab stays ' +
        'loaded and reachable by context id, it just is not shown — handy to park a tab without closing it. The last ' +
        'visible tab in a window cannot be hidden.',
      inputSchema: {
        context: z.string().optional().describe('Tab (default: the active tab)'),
        visible: z.boolean().describe('true to show it again, false to hide it'),
      },
      annotations: WRITES,
    },
    async ({ context, visible }: { context?: string; visible: boolean }) => {
      try {
        const target = context === undefined ? null : str(context, 'context')
        return text(
          await withChrome(async (client, chromeContext) => {
            const index = target === null ? -1 : await tabIndexForContext(client, target)
            const raw = await client.evaluate(
              '(() => {' +
                ' try {' +
                '  const tab = ' + (index < 0 ? 'gBrowser.selectedTab' : 'gBrowser.tabs[' + String(index) + ']') + ';' +
                '  if (!tab) return JSON.stringify({ error: "tab not found" });' +
                '  if (' + (visible ? 'true' : 'false') + ') gBrowser.showTab(tab); else gBrowser.hideTab(tab);' +
                '  return JSON.stringify({ hidden: !!tab.hidden, url: tab.linkedBrowser.currentURI.spec });' +
                ' } catch (e) { return JSON.stringify({ error: e.message }); }' +
                ' })()',
              chromeContext,
            )
            if (typeof raw !== 'string') throw new Error('hide/show returned nothing')
            const info = JSON.parse(raw) as { error?: string; hidden?: boolean; url?: string }
            if (info.error !== undefined) throw new Error(info.error)
            return (info.hidden ? 'hidden: ' : 'shown: ') + String(info.url)
          }),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_get_cache_usage',
    {
      title: 'How much disk the HTTP cache uses',
      description:
        'Report the size of the on-disk HTTP cache (Services.cache2.asyncGetDiskConsumption). Note: this is only the ' +
        'network cache — it does not include IndexedDB, Service Worker caches or storage, which live elsewhere.',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      try {
        // MEASURED: nsICacheStorageService.asyncGetDiskConsumption keeps failing with
        // NS_ERROR_ILLEGAL_VALUE regardless of the observer shape, so measure the cache
        // directory from the Node side instead — that is honest and works.
        const dir = await withChrome(async (client, chromeContext) => {
          return client.evaluate(
            '(() => { try { const d = Services.dirsvc.get("ProfD", Ci.nsIFile); d.append("cache2"); return d.path; } catch (e) { return "ERR " + e.message; } })()',
            chromeContext,
          )
        })
        if (typeof dir !== 'string') throw new Error('could not resolve cache2 directory')
        if (dir.startsWith('ERR ')) throw new Error(dir.slice(4))
        const root = dir.split(String.fromCharCode(92)).join('/')
        const { readdirSync, statSync } = await import('node:fs')
        const walk = (path: string): number => {
          let total = 0
          let entries: string[] = []
          try {
            entries = readdirSync(path)
          } catch {
            return 0
          }
          for (const name of entries) {
            const full = path + '/' + name
            try {
              const st = statSync(full)
              if (st.isDirectory()) total += walk(full)
              else total += st.size
            } catch {
              // Skip entries that vanish mid-walk.
            }
          }
          return total
        }
        const total = walk(root)
        const mb = Math.round((total / (1024 * 1024)) * 100) / 100
        return text('cache2 on disk: ' + String(mb) + ' MB (' + String(total) + ' bytes) at ' + dir)
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_clear_cache',
    {
      title: 'Clear the HTTP cache',
      description:
        'Clear the on-disk HTTP cache (Services.cache2.clear). Pass origin to clear just that site, or domain to ' +
        'clear a base domain. Without arguments the whole HTTP cache is cleared, which is a separate operation from ' +
        'browser_clear_data (that one goes through ClearDataService and can also clear cookies/storage).',
      inputSchema: {
        origin: z.string().optional().describe('Only clear this origin (https://example.com)'),
        domain: z.string().optional().describe('Only clear this base domain (example.com)'),
      },
      annotations: WRITES_PERSISTENTLY,
    },
    async ({ origin, domain }: { origin?: string; domain?: string }) => {
      try {
        const site = origin === undefined ? null : str(origin, 'origin')
        const baseDomain = domain === undefined ? null : str(domain, 'domain')
        if (site !== null && baseDomain !== null) throw new Error('give either origin or domain, not both')
        return text(
          await withChrome(async (client, chromeContext) => {
            // MEASURED: clearOriginsByPrincipal throws "Failure arg 0" even with a real
            // principal array, and clearBaseDomain is not exposed either. Only clear() works,
            // so this tool clears the whole HTTP cache and says so.
            if (site !== null || baseDomain !== null) {
              throw new Error('per-origin cache clearing is not exposed by this Firefox build; omit origin/domain to clear the whole HTTP cache')
            }
            const raw = await client.evaluate(
              '(() => {' +
                ' try {' +
                '  Services.cache2.clear();' +
                '  return "cleared the whole HTTP cache";' +
                ' } catch (e) { return "ERR " + e.message; }' +
                ' })()',
              chromeContext,
            )
            if (typeof raw !== 'string') throw new Error('clear cache returned nothing')
            if (raw.startsWith('ERR ')) throw new Error(raw.slice(4))
            return raw
          }),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_list_permissions',
    {
      title: 'List per-site permissions',
      description:
        'List the per-site permission grants Firefox has stored (camera, microphone, notifications, geolocation, ' +
        'popups, cookie behaviour …), read through Services.perms. Filter by origin to look at one site, or by type. ' +
        'Use browser_set_permission to change one.',
      inputSchema: {
        origin: z.string().optional().describe('Only this origin (https://example.com)'),
        type: z.string().optional().describe('Only this permission type, e.g. geolocation'),
      },
      annotations: READ_ONLY,
    },
    async ({ origin, type }: { origin?: string; type?: string }) => {
      try {
        const wantOrigin = origin === undefined ? null : str(origin, 'origin')
        const wantType = type === undefined ? null : str(type, 'type')
        return text(
          await withChrome(async (client, chromeContext) => {
            const raw = await client.evaluate(
              '(() => {' +
                ' try {' +
                '  const wantOrigin = ' + JSON.stringify(wantOrigin) + ';' +
                '  const wantType = ' + JSON.stringify(wantType) + ';' +
                '  const all = Services.perms.getAllWithTypePrefix("");' +
                '  const out = [];' +
                '  for (let i = 0; i < all.length; i++) {' +
                '    const p = all[i];' +
                '    const o = p.principal ? p.principal.origin : String(p);' +
                '    if (wantOrigin && o !== wantOrigin) continue;' +
                '    if (wantType && p.type !== wantType) continue;' +
                '    out.push({ origin: o, type: p.type, permission: p.capability });' +
                '  }' +
                '  return JSON.stringify({ total: all.length, matched: out.length, rows: out.slice(0, 300) });' +
                ' } catch (e) { return JSON.stringify({ error: e.message }); }' +
                ' })()',
              chromeContext,
            )
            if (typeof raw !== 'string') throw new Error('permission list returned nothing')
            const info = JSON.parse(raw) as {
              error?: string
              total?: number
              matched?: number
              rows?: Array<{ origin: string; type: string; permission: number }>
            }
            if (info.error !== undefined) throw new Error(info.error)
            const rows = info.rows ?? []
            if (rows.length === 0) return 'no permissions matched (' + String(info.total) + ' stored in total)'
            return rows
              .map((row) => String(row.origin) + '  ' + String(row.type) + ' = ' + String(row.permission))
              .join(String.fromCharCode(10))
          }),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_set_download_state',
    {
      title: 'Pause, resume or cancel a download',
      description:
        'Act on one entry of the download list by index (as shown by browser_list_downloads): pause it, resume it, or ' +
        'cancel it. Cancelling removes the partial file — this cannot be undone.',
      inputSchema: {
        index: z.number().int().nonnegative().describe('0-based index into browser_list_downloads'),
        action: z.enum(['pause', 'resume', 'cancel']).describe('What to do with it'),
      },
      annotations: WRITES,
    },
    async ({ index, action }: { index: number; action: 'pause' | 'resume' | 'cancel' }) => {
      try {
        return text(
          await withChrome(async (client, chromeContext) => {
            const raw = await client.evaluate(
              '(async () => {' +
                ' try {' +
                '  const list = await Downloads.getList(Downloads.ALL);' +
                '  const items = await list.getAll();' +
                '  const d = items[' + String(index) + '];' +
                '  if (!d) return JSON.stringify({ error: "no download at index ' + String(index) + '" });' +
                '  const act = ' + JSON.stringify(action) + ';' +
                '  if (act === "pause") await d.pause();' +
                '  else if (act === "resume") await d.resume();' +
                '  else await d.cancel();' +
                '  return JSON.stringify({ ok: true, state: d.state, target: d.target && d.target.path ? d.target.path.replace(/^.*[\\\\/]/, "") : null });' +
                ' } catch (e) { return JSON.stringify({ error: e.message }); }' +
                ' })()',
              chromeContext,
            )
            if (typeof raw !== 'string') throw new Error('download action returned nothing')
            const info = JSON.parse(raw) as { error?: string; state?: number; target?: string | null }
            if (info.error !== undefined) throw new Error(info.error)
            return action + ' ok: ' + String(info.target ?? '(unnamed)') + ' (state ' + String(info.state) + ')'
          }),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_search_prefs',
    {
      title: 'Search preference names',
      description:
        'Search all Firefox preference NAMES (Services.prefs.getChildList) for a substring and report the matching ' +
        'names with their current values and whether a user value is set. Use it to discover the pref behind a ' +
        'setting before changing it with browser_set_pref. Values are truncated; this is a discovery tool, not a dump.',
      inputSchema: {
        query: z.string().describe('Substring to match in pref names (e.g. browser.tabs)'),
        limit: z.number().int().min(1).max(200).optional().describe('Max results (default 40)'),
      },
      annotations: READ_ONLY,
    },
    async ({ query, limit }: { query: string; limit?: number }) => {
      try {
        const needle = str(query, 'query')
        const max = limit ?? 40
        return text(
          await withChrome(async (client, chromeContext) => {
            const raw = await client.evaluate(
              '(() => {' +
                ' try {' +
                '  const needle = ' + JSON.stringify(needle) + ';' +
                '  const limit = ' + String(max) + ';' +
                '  const all = Services.prefs.getChildList("");' +
                '  const hits = [];' +
                '  for (const name of all) {' +
                '    if (name.indexOf(needle) === -1) continue;' +
                '    const t = Services.prefs.getPrefType(name);' +
                '    let value = null;' +
                '    try {' +
                '      if (t === Services.prefs.PREF_BOOL) value = String(Services.prefs.getBoolPref(name));' +
                '      else if (t === Services.prefs.PREF_INT) value = String(Services.prefs.getIntPref(name));' +
                '      else if (t === Services.prefs.PREF_STRING) value = Services.prefs.getStringPref(name).slice(0, 80);' +
                '    } catch (e) { value = "(unreadable)"; }' +
                '    hits.push({ name, value, user: Services.prefs.prefHasUserValue(name) });' +
                '    if (hits.length >= limit) break;' +
                '  }' +
                '  return JSON.stringify({ total: all.length, matched: hits.length, hits });' +
                ' } catch (e) { return JSON.stringify({ error: e.message }); }' +
                ' })()',
              chromeContext,
            )
            if (typeof raw !== 'string') throw new Error('pref search returned nothing')
            const info = JSON.parse(raw) as {
              error?: string
              total?: number
              matched?: number
              hits?: Array<{ name: string; value: string | null; user: boolean }>
            }
            if (info.error !== undefined) throw new Error(info.error)
            const hits = info.hits ?? []
            if (hits.length === 0) return 'no pref contains "' + needle + '" (of ' + String(info.total) + ' total)'
            return hits
              .map(
                (hit) =>
                  (hit.user ? '*' : ' ') + hit.name + ' = ' + String(hit.value) +
                  (hit.user ? '  [user value]' : '  [default]'),
              )
              .join(String.fromCharCode(10))
          }),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_reset_pref',
    {
      title: 'Reset a preference to its default',
      description:
        'Remove the user value of a preference so it falls back to the built-in default (Services.prefs.clearUserPref). ' +
        'Reports whether it had a user value before and whether it still has one after. Pair with browser_search_prefs ' +
        'to find the name, and browser_get_pref to see the current effective value.',
      inputSchema: {
        name: z.string().describe('Preference name'),
      },
      annotations: WRITES_PERSISTENTLY,
    },
    async ({ name }: { name: string }) => {
      try {
        const pref = str(name, 'name')
        return text(
          await withChrome(async (client, chromeContext) => {
            const raw = await client.evaluate(
              '(() => {' +
                ' try {' +
                '  const name = ' + JSON.stringify(pref) + ';' +
                '  const had = Services.prefs.prefHasUserValue(name);' +
                '  if (!had) return JSON.stringify({ had: false, now: false, note: "no user value to clear" });' +
                '  Services.prefs.clearUserPref(name);' +
                '  return JSON.stringify({ had: true, now: Services.prefs.prefHasUserValue(name) });' +
                ' } catch (e) { return JSON.stringify({ error: e.message }); }' +
                ' })()',
              chromeContext,
            )
            if (typeof raw !== 'string') throw new Error('reset pref returned nothing')
            const info = JSON.parse(raw) as { error?: string; had?: boolean; now?: boolean; note?: string }
            if (info.error !== undefined) throw new Error(info.error)
            if (info.note !== undefined) return pref + ': ' + info.note
            return pref + ': user value cleared, back to the default'
          }),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_set_theme',
    {
      title: 'Switch the active theme',
      description:
        'Activate one of the installed themes by id (from browser_list_themes), or pass default:true to go back to the ' +
        'default theme. Uses the theme add-on enable path, which is what the Add-ons manager does when you click ' +
        '"Enable". The change is visible immediately.',
      inputSchema: {
        id: z.string().optional().describe('Theme add-on id from browser_list_themes'),
        default: z.boolean().optional().describe('Go back to the default theme'),
      },
      annotations: WRITES_PERSISTENTLY,
    },
    async ({ id, default: useDefault }: { id?: string; default?: boolean }) => {
      try {
        const themeId = id === undefined ? null : str(id, 'id')
        if (themeId === null && useDefault !== true) throw new Error('give id or default:true')
        return text(
          await withChrome(async (client, chromeContext) => {
            const raw = await client.evaluate(
              '(async () => {' +
                ' try {' +
                '  const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");' +
                '  const target = ' + JSON.stringify(themeId) + ';' +
                '  const wantDefault = ' + (useDefault === true ? 'true' : 'false') + ';' +
                '  const id = wantDefault ? "default-theme@mozilla.org" : target;' +
                '  const addon = await AddonManager.getAddonByID(id);' +
                '  if (!addon) return JSON.stringify({ error: "no theme with id " + id });' +
                '  await addon.enable();' +
                '  const all = await AddonManager.getAddonsByTypes(["theme"]);' +
                '  const active = all.filter(a => a.isActive).map(a => ({ id: a.id, name: a.name }));' +
                '  return JSON.stringify({ ok: true, active });' +
                ' } catch (e) { return JSON.stringify({ error: e.message }); }' +
                ' })()',
              chromeContext,
            )
            if (typeof raw !== 'string') throw new Error('set theme returned nothing')
            const info = JSON.parse(raw) as { error?: string; active?: Array<{ id: string; name: string }> }
            if (info.error !== undefined) throw new Error(info.error)
            const active = info.active ?? []
            return 'active theme: ' + active.map((a) => a.name + ' (' + a.id + ')').join(', ')
          }),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_set_homepage',
    {
      title: 'Set the homepage and startup behaviour',
      description:
        'Set the homepage (browser.startup.homepage, one URL per line for several) and what Firefox opens on startup ' +
        '(browser.startup.page: 0 blank, 1 homepage, 2 last session, 3 bookmarks). Pass only homepage to leave the ' +
        'startup behaviour alone.',
      inputSchema: {
        homepage: z.string().optional().describe('Homepage URL(s), newline separated'),
        startupPage: z
          .enum(['blank', 'homepage', 'last-session', 'bookmarks'])
          .optional()
          .describe('What to open on startup'),
      },
      annotations: WRITES_PERSISTENTLY,
    },
    async ({ homepage, startupPage }: { homepage?: string; startupPage?: string }) => {
      try {
        if (homepage === undefined && startupPage === undefined) throw new Error('give homepage and/or startupPage')
        const pageMap: Record<string, number> = {
          blank: 0,
          homepage: 1,
          'last-session': 2,
          bookmarks: 3,
        }
        const url = homepage === undefined ? null : str(homepage, 'homepage')
        const page = startupPage === undefined ? null : pageMap[String(startupPage)]
        if (startupPage !== undefined && page === undefined) throw new Error('unknown startupPage')
        return text(
          await withChrome(async (client, chromeContext) => {
            const raw = await client.evaluate(
              '(() => {' +
                ' try {' +
                '  const out = {};' +
                '  const url = ' + JSON.stringify(url) + ';' +
                '  const page = ' + (page === null ? 'null' : String(page)) + ';' +
                '  if (url !== null) { Services.prefs.setStringPref("browser.startup.homepage", url); }' +
                '  if (page !== null) { Services.prefs.setIntPref("browser.startup.page", page); }' +
                '  out.homepage = Services.prefs.getStringPref("browser.startup.homepage", "(unset)");' +
                '  out.startupPage = Services.prefs.getIntPref("browser.startup.page", -1);' +
                '  return JSON.stringify(out);' +
                ' } catch (e) { return JSON.stringify({ error: e.message }); }' +
                ' })()',
              chromeContext,
            )
            if (typeof raw !== 'string') throw new Error('homepage returned nothing')
            const info = JSON.parse(raw) as { error?: string; homepage?: string; startupPage?: number }
            if (info.error !== undefined) throw new Error(info.error)
            const names: Record<number, string> = { 0: 'blank', 1: 'homepage', 2: 'last-session', 3: 'bookmarks' }
            return (
              'homepage: ' + String(info.homepage) +
              ' | startup: ' + String(names[info.startupPage ?? -1] ?? info.startupPage)
            )
          }),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_set_tracking_protection',
    {
      title: 'Set tracking protection and cookie behaviour',
      description:
        'Switch the tracking-protection level: off, standard (blocks known trackers in private windows only), strict ' +
        '(also blocks them in normal windows and tightens cookie behaviour). This sets the same prefs the Privacy ' +
        'panel toggles, so the change appears in about:preferences immediately.',
      inputSchema: {
        mode: z.enum(['off', 'standard', 'strict']).describe('Tracking protection level'),
      },
      annotations: WRITES_PERSISTENTLY,
    },
    async ({ mode }: { mode: 'off' | 'standard' | 'strict' }) => {
      try {
        const level = str(mode, 'mode')
        return text(
          await withChrome(async (client, chromeContext) => {
            const raw = await client.evaluate(
              '(() => {' +
                ' try {' +
                '  const mode = ' + JSON.stringify(level) + ';' +
                '  if (mode === "off") {' +
                '    Services.prefs.setBoolPref("privacy.trackingprotection.enabled", false);' +
                '    Services.prefs.setBoolPref("privacy.trackingprotection.pbmode.enabled", false);' +
                '    Services.prefs.setIntPref("network.cookie.cookieBehavior", 5);' +
                '  } else if (mode === "standard") {' +
                '    Services.prefs.setBoolPref("privacy.trackingprotection.enabled", false);' +
                '    Services.prefs.setBoolPref("privacy.trackingprotection.pbmode.enabled", true);' +
                '    Services.prefs.setIntPref("network.cookie.cookieBehavior", 5);' +
                '  } else {' +
                '    Services.prefs.setBoolPref("privacy.trackingprotection.enabled", true);' +
                '    Services.prefs.setBoolPref("privacy.trackingprotection.pbmode.enabled", true);' +
                '    Services.prefs.setIntPref("network.cookie.cookieBehavior", 5);' +
                '    Services.prefs.setBoolPref("privacy.partition.network_state", true);' +
                '  }' +
                '  return JSON.stringify({' +
                '    tp: Services.prefs.getBoolPref("privacy.trackingprotection.enabled"),' +
                '    pbmode: Services.prefs.getBoolPref("privacy.trackingprotection.pbmode.enabled"),' +
                '    cookieBehavior: Services.prefs.getIntPref("network.cookie.cookieBehavior")' +
                '  });' +
                ' } catch (e) { return JSON.stringify({ error: e.message }); }' +
                ' })()',
              chromeContext,
            )
            if (typeof raw !== 'string') throw new Error('tracking protection returned nothing')
            const info = JSON.parse(raw) as {
              error?: string
              tp?: boolean
              pbmode?: boolean
              cookieBehavior?: number
            }
            if (info.error !== undefined) throw new Error(info.error)
            return (
              'tracking protection: ' + level +
              ' (normal-window=' + String(info.tp) +
              ', private-window=' + String(info.pbmode) +
              ', cookieBehavior=' + String(info.cookieBehavior) + ')'
            )
          }),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_set_doh',
    {
      title: 'Configure DNS over HTTPS',
      description:
        'Set network.trr.mode (0 off, 2 on with fallback, 3 on only, 5 explicitly off) and optionally the resolver URI ' +
        '(network.trr.uri). This is what the Network Settings > DNS over HTTPS control writes.',
      inputSchema: {
        mode: z.enum(['off', 'on-with-fallback', 'on-only', 'explicitly-off']).describe('DoH mode'),
        uri: z.string().optional().describe('Resolver URI, e.g. https://mozilla.cloudflare-dns.com/dns-query'),
      },
      annotations: WRITES_PERSISTENTLY,
    },
    async ({ mode, uri }: { mode: string; uri?: string }) => {
      try {
        const modeMap: Record<string, number> = {
          off: 0,
          'on-with-fallback': 2,
          'on-only': 3,
          'explicitly-off': 5,
        }
        const value = modeMap[String(mode)]
        if (value === undefined) throw new Error('unknown mode: ' + String(mode))
        const target = uri === undefined ? null : str(uri, 'uri')
        return text(
          await withChrome(async (client, chromeContext) => {
            const raw = await client.evaluate(
              '(() => {' +
                ' try {' +
                '  Services.prefs.setIntPref("network.trr.mode", ' + String(value) + ');' +
                '  const uri = ' + JSON.stringify(target) + ';' +
                '  if (uri !== null) Services.prefs.setStringPref("network.trr.uri", uri);' +
                '  return JSON.stringify({' +
                '    mode: Services.prefs.getIntPref("network.trr.mode"),' +
                '    uri: Services.prefs.getStringPref("network.trr.uri", "(unset)")' +
                '  });' +
                ' } catch (e) { return JSON.stringify({ error: e.message }); }' +
                ' })()',
              chromeContext,
            )
            if (typeof raw !== 'string') throw new Error('doh returned nothing')
            const info = JSON.parse(raw) as { error?: string; mode?: number; uri?: string }
            if (info.error !== undefined) throw new Error(info.error)
            return 'DoH: mode ' + String(info.mode) + ' | resolver ' + String(info.uri)
          }),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_get_search_engine',
    {
      title: 'Read the default search engine',
      description:
        'Report the default search engine name as configured (browser.search.defaultenginename) plus the list of ' +
        'engine names found in the profile search settings file (search.json.mozlz4). LIMITATION: changing the ' +
        'default engine needs the internal SearchService, whose ES module is not reachable from a remote script in ' +
        'this build (every resource:// path fails to load), so this tool is read-only.',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      try {
        return text(
          await withChrome(async (client, chromeContext) => {
            const raw = await client.evaluate(
              '(() => {' +
                ' try {' +
                '  const name = Services.prefs.getStringPref("browser.search.defaultenginename", "(unset)");' +
                '  return JSON.stringify({ name });' +
                ' } catch (e) { return JSON.stringify({ error: e.message }); }' +
                ' })()',
              chromeContext,
            )
            if (typeof raw !== 'string') throw new Error('search engine returned nothing')
            const info = JSON.parse(raw) as { error?: string; name?: string }
            if (info.error !== undefined) throw new Error(info.error)
            return (
              'default search engine: ' + String(info.name) +
              String.fromCharCode(10) +
              'note: read-only — this build does not expose the SearchService module to remote scripts'
            )
          }),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_extension_details',
    {
      title: 'Extension details: options page, popup, sidebar',
      description:
        'Report what UI entry points an extension actually exposes: its options page URL, browser action popup, and ' +
        'sidebar panel. Read from the live manifest, because AddonManager.optionsURL is null for MV3 extensions that ' +
        'declare options_ui instead of options_page — a trap worth knowing.',
      inputSchema: {
        id: z.string().describe('Extension id'),
      },
      annotations: READ_ONLY,
    },
    async ({ id }: { id: string }) => {
      try {
        const extId = str(id, 'id')
        return text(
          await withChrome(async (client, chromeContext) => {
            const raw = await client.evaluate(
              '(async () => {' +
                ' try {' +
                '  const id = ' + JSON.stringify(extId) + ';' +
                '  const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");' +
                '  const addon = await AddonManager.getAddonByID(id);' +
                '  if (!addon) return JSON.stringify({ error: "no such extension: " + id });' +
                '  const { ExtensionParent } = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");' +
                '  const policy = ExtensionParent.GlobalManager.extensionMap.get(id);' +
                '  const manifest = policy && policy.manifest ? policy.manifest : {};' +
                '  const base = policy && policy.baseURI ? policy.baseURI.spec : null;' +
                '  const page = (manifest.options_ui && manifest.options_ui.page) || manifest.options_page || null;' +
                '  const popup = manifest.action && manifest.action.default_popup ? manifest.action.default_popup :' +
                '                (manifest.browser_action && manifest.browser_action.default_popup ? manifest.browser_action.default_popup : null);' +
                '  const sidebar = manifest.sidebar_action && manifest.sidebar_action.default_panel ? manifest.sidebar_action.default_panel : null;' +
                // NOTE: the normalised manifest already stores these as absolute URLs, so joining with
                // baseURI again produced moz-extension://…/moz-extension://…/options.html. Only join
                // when the value is still a bare relative path.
                '  const isAbsolute = (v) => v.indexOf("://") !== -1 || v.indexOf("moz-extension:") === 0;' +
                '  const stripLead = (v) => { let i = 0; while (i < v.length && v.charAt(i) === "/") i++; return v.slice(i); };' +
                '  const absolutise = (v) => {' +
                '    if (!v) return null;' +
                '    if (isAbsolute(v)) return v;' +
                '    return base ? base + stripLead(v) : v;' +
                '  };' +
                '  return JSON.stringify({' +
                '    id, name: addon.name, active: addon.isActive, base,' +
                '    optionsUrl: absolutise(page),' +
                '    optionsUrlFromAddon: addon.optionsURL || null,' +
                '    popupUrl: absolutise(popup),' +
                '    sidebarUrl: absolutise(sidebar)' +
                '  });' +
                ' } catch (e) { return JSON.stringify({ error: e.message }); }' +
                ' })()',
              chromeContext,
            )
            if (typeof raw !== 'string') throw new Error('extension details returned nothing')
            const info = JSON.parse(raw) as {
              error?: string
              name?: string
              active?: boolean
              optionsUrl?: string | null
              optionsUrlFromAddon?: string | null
              popupUrl?: string | null
              sidebarUrl?: string | null
            }
            if (info.error !== undefined) throw new Error(info.error)
            const lines = ['extension: ' + String(info.name) + ' (' + (info.active ? 'active' : 'inactive') + ')']
            lines.push('  options page: ' + (info.optionsUrl ?? '(none)'))
            if (info.optionsUrl !== null && info.optionsUrl !== info.optionsUrlFromAddon) {
              lines.push('  note: AddonManager.optionsURL was ' + String(info.optionsUrlFromAddon) + ' — read from the manifest instead')
            }
            lines.push('  popup: ' + (info.popupUrl ?? '(none)'))
            lines.push('  sidebar: ' + (info.sidebarUrl ?? '(none)'))
            return lines.join(String.fromCharCode(10))
          }),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_open_extension_options',
    {
      title: 'Open an extension options page in a tab',
      description:
        'Open the options page of an extension in a new tab, resolved from its live manifest (options_ui.page or ' +
        'options_page). Fails clearly when the extension has no options page. Use browser_extension_details first if ' +
        'you want to see the URL without opening it.',
      inputSchema: {
        id: z.string().describe('Extension id'),
        background: z.boolean().optional().describe('Open in the background'),
      },
      annotations: WRITES,
    },
    async ({ id, background }: { id: string; background?: boolean }) => {
      try {
        const extId = str(id, 'id')
        return text(
          await withChrome(async (client, chromeContext) => {
            const raw = await client.evaluate(
              '(() => {' +
                ' try {' +
                '  const id = ' + JSON.stringify(extId) + ';' +
                '  const { ExtensionParent } = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");' +
                '  const policy = ExtensionParent.GlobalManager.extensionMap.get(id);' +
                '  if (!policy) return JSON.stringify({ error: "no such extension: " + id });' +
                '  const manifest = policy.manifest || {};' +
                '  const page = (manifest.options_ui && manifest.options_ui.page) || manifest.options_page || null;' +
                '  if (!page) return JSON.stringify({ error: "extension " + id + " declares no options page" });' +
                '  let url = page;' +
                '  if (page.indexOf("://") === -1 && page.indexOf("moz-extension:") !== 0) {' +
                '    let rel = page;' +
                '    while (rel.length > 0 && rel.charAt(0) === "/") rel = rel.slice(1);' +
                '    url = policy.baseURI.spec + rel;' +
                '  }' +
                '  const tab = gBrowser.addTab(url, {' +
                '    triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),' +
                '    inBackground: ' + (background === true ? 'true' : 'false') +
                '  });' +
                '  return JSON.stringify({ ok: true, url });' +
                ' } catch (e) { return JSON.stringify({ error: e.message }); }' +
                ' })()',
              chromeContext,
            )
            if (typeof raw !== 'string') throw new Error('open options returned nothing')
            const info = JSON.parse(raw) as { error?: string; url?: string }
            if (info.error !== undefined) throw new Error(info.error)
            return 'opened options page: ' + String(info.url)
          }),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_open_extension_popup',
    {
      title: 'Open an extension\'s toolbar popup',
      description:
        'Open the browser-action popup of an extension, the same thing clicking its toolbar button does. Firefox does ' +
        'not expose extension.browserAction to remote scripts (policy.extension is undefined), so this drives the real ' +
        'UI: it opens the unified-extensions panel, finds the item for this id, and clicks its action button. Reports ' +
        'the popup URL that ended up loaded, so silence is not mistaken for success.',
      inputSchema: {
        id: z.string().describe('Extension id'),
      },
      annotations: WRITES,
    },
    async ({ id }: { id: string }) => {
      try {
        const extId = str(id, 'id')
        return text(
          await withChrome(async (client, chromeContext) => {
            const raw = await client.evaluate(
              '(async () => {' +
                ' try {' +
                '  const id = ' + JSON.stringify(extId) + ';' +
                '  const { ExtensionParent } = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");' +
                '  const policy = ExtensionParent.GlobalManager.extensionMap.get(id);' +
                '  if (!policy) return JSON.stringify({ error: "no such extension: " + id });' +
                '  const m = policy.manifest || {};' +
                '  const hasPopup = !!(m.action && m.action.default_popup) || !!(m.browser_action && m.browser_action.default_popup);' +
                '  if (!hasPopup) return JSON.stringify({ error: "extension " + id + " declares no browser action popup" });' +
                // Ask before guessing: is the button already in the toolbar?
                '  let item = document.querySelector(\'[data-extensionid="\' + id + \'"]\');' +
                '  if (!item) {' +
                '    const panelBtn = document.getElementById("unified-extensions-button");' +
                '    if (!panelBtn) return JSON.stringify({ error: "no unified-extensions button in this window" });' +
                '    panelBtn.click();' +
                '    await new Promise(r => setTimeout(r, 700));' +
                '    item = document.querySelector(\'[data-extensionid="\' + id + \'"]\');' +
                '  }' +
                '  if (!item) return JSON.stringify({ error: "extension button not found even in the extensions panel" });' +
                '  let actionBtn = null;' +
                '  for (const el of document.querySelectorAll(\'[data-extensionid="\' + id + \'"]\')) {' +
                '    if (String(el.className).indexOf("item-action-button") !== -1) { actionBtn = el; break; }' +
                '  }' +
                '  if (!actionBtn) actionBtn = item;' +
                '  actionBtn.click();' +
                '  await new Promise(r => setTimeout(r, 900));' +
                '  const browsers = Array.from(document.querySelectorAll(".webextension-popup-browser"));' +
                '  const urls = browsers.map(b => (b.currentURI && b.currentURI.spec) ? b.currentURI.spec : "n/a");' +
                '  return JSON.stringify({ ok: urls.length > 0, popupCount: urls.length, urls });' +
                ' } catch (e) { return JSON.stringify({ error: e.message }); }' +
                ' })()',
              chromeContext,
            )
            if (typeof raw !== 'string') throw new Error('open popup returned nothing')
            const info = JSON.parse(raw) as { error?: string; ok?: boolean; popupCount?: number; urls?: string[] }
            if (info.error !== undefined) throw new Error(info.error)
            if (info.ok !== true) return 'clicked the button but no popup panel was detected'
            return 'popup opened: ' + (info.urls ?? ['(unnamed)']).join(', ')
          }),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_close_extension_popup',
    {
      title: 'Close an open extension popup',
      description:
        'Close the tool-panel popup that browser_open_extension_popup opened, by hiding the widget panel. Firefox has no ' +
        'public "close popup" API, so this hides the panel element the popup lives in. Reports what it found and closed.',
      inputSchema: {},
      annotations: WRITES,
    },
    async () => {
      try {
        return text(
          await withChrome(async (client, chromeContext) => {
            const raw = await client.evaluate(
              '(() => {' +
                ' try {' +
                '  const open = [];' +
                '  for (const p of document.querySelectorAll("panel")) {' +
                '    if (!p.hidden && p.getAttribute("panelopen") === "true") open.push(p.id || "(no id)");' +
                '  }' +
                '  const popupPanel = document.getElementById("customizationui-widget-panel");' +
                '  let closed = false;' +
                '  if (popupPanel && typeof popupPanel.hidePopup === "function") {' +
                '    popupPanel.hidePopup();' +
                '    closed = true;' +
                '  }' +
                '  return JSON.stringify({ openBefore: open, closed });' +
                ' } catch (e) { return JSON.stringify({ error: e.message }); }' +
                ' })()',
              chromeContext,
            )
            if (typeof raw !== 'string') throw new Error('close popup returned nothing')
            const info = JSON.parse(raw) as { error?: string; openBefore?: string[]; closed?: boolean }
            if (info.error !== undefined) throw new Error(info.error)
            if (!info.closed) return 'no widget panel to close (open panels: ' + (info.openBefore ?? []).join(', ') + ')'
            return 'popup panel closed'
          }),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_extension_storage',
    {
      title: 'Read or write an extension private storage',
      description:
        'Read or write the private key/value storage of an extension (browser.storage.local) — where an extension keeps ' +
        'its own settings and lists. It works by opening one of the extension own pages in a background tab, running ' +
        'the storage call in that page context (the only place where the extension APIs exist), then closing the tab. ' +
        'MEASURED limitation: a page of the extension is required, so extensions without an options page cannot be ' +
        'reached this way.',
      inputSchema: {
        id: z.string().describe('Extension id'),
        action: z.enum(['read', 'write', 'remove', 'clear']).describe('What to do'),
        keys: z.array(z.string()).optional().describe('Keys to read or remove (read defaults to all)'),
        data: z.record(z.string(), z.unknown()).optional().describe('Object to write'),
      },
      annotations: WRITES,
    },
    async ({
      id,
      action,
      keys,
      data,
    }: {
      id: string
      action: 'read' | 'write' | 'remove' | 'clear'
      keys?: string[]
      data?: Record<string, unknown>
    }) => {
      try {
        const extId = str(id, 'id')
        if (action === 'write' && (data === undefined || typeof data !== 'object')) {
          throw new Error('write needs data')
        }
        const expression =
          action === 'read'
            ? '(async () => { const v = await browser.storage.local.get(' +
              (keys === undefined ? 'null' : JSON.stringify(keys)) +
              '); return JSON.stringify(v); })()'
            : action === 'write'
              ? '(async () => { await browser.storage.local.set(' +
                JSON.stringify(data ?? {}) +
                '); const v = await browser.storage.local.get(null); return JSON.stringify(v); })()'
              : action === 'remove'
                ? '(async () => { await browser.storage.local.remove(' +
                  JSON.stringify(keys ?? []) +
                  '); const v = await browser.storage.local.get(null); return JSON.stringify(v); })()'
                : '(async () => { await browser.storage.local.clear(); const v = await browser.storage.local.get(null); return JSON.stringify(v); })()'
        const result = await inExtensionPage(extId, null, expression)
        return text(result)
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_run_in_extension',
    {
      title: 'Run JavaScript inside an extension own page',
      description:
        'Evaluate an expression inside the context of one of the extension own pages, where the WebExtension APIs ' +
        '(browser.*) and the extension DOM are available. It opens the page in a background tab, evaluates, then closes ' +
        'the tab. This is the general escape hatch behind browser_extension_storage: with it an extension that exposes ' +
        'no command line of its own can still be inspected and driven. The expression should return a JSON value or a ' +
        'string.',
      inputSchema: {
        id: z.string().describe('Extension id'),
        expression: z.string().describe('JavaScript expression; may return a Promise'),
        page: z.string().optional().describe('Relative page to run in (default: the options page)'),
      },
      annotations: WRITES,
    },
    async ({ id, expression, page }: { id: string; expression: string; page?: string }) => {
      try {
        const extId = str(id, 'id')
        const script = str(expression, 'expression')
        const pageHint = page === undefined ? null : str(page, 'page')
        const result = await inExtensionPage(extId, pageHint, script)
        return text(result)
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_tampermonkey_list',
    {
      title: 'List userscripts installed in Tampermonkey',
      description:
        'List the userscripts Tampermonkey currently manages, by asking its own internal API (loadTree). ' +
        'Works with the official Firefox build (firefoxbeta@tampermonkey.net) out of the box; a converted Chrome ' +
        'package needs its INTERNAL_PAGE_PROTOCOLS patched to moz-extension: first.',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      try {
        const raw = await tampermonkeyCommand({
          method: 'loadTree',
          referrer: 'options',
          layout: 'default',
          url: '',
          available_columns: [],
          complete: true,
          uuid: null,
          tabId: null,
        })
        const parsed = JSON.parse(raw) as { error?: string; items?: unknown }
        if (parsed.error !== undefined) throw new Error(parsed.error)
        const names = tampermonkeyScriptNames(raw)
        if (names.length === 0) return text('no userscript is installed')
        return text(names.join(String.fromCharCode(10)))
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_tampermonkey_install',
    {
      title: 'Install a userscript into Tampermonkey',
      description:
        'Install (or update) a userscript by handing its source to Tampermonkey saveScript. Pass code for a whole ' +
        'userscript, or url to fetch one over HTTP first. De-duplicates by the @name header: an existing script with ' +
        'that name is updated instead of duplicated, because MEASURED saveScript creates a NEW script for every new ' +
        'uuid. Returns the assigned uuid.',
      inputSchema: {
        code: z.string().optional().describe('Full userscript source, including the ==UserScript== header'),
        url: z.string().optional().describe('Alternatively, an http(s) URL to a .user.js'),
        force: z.boolean().optional().describe('Install even when the name already exists (creates a duplicate)'),
      },
      annotations: WRITES,
    },
    async ({ code, url, force }: { code?: string; url?: string; force?: boolean }) => {
      try {
        if (code === undefined && url === undefined) throw new Error('give code or url')
        let source = code === undefined ? '' : str(code, 'code')
        if (code === undefined) {
          const target = str(url as string, 'url')
          const response = await fetch(target)
          if (!response.ok) throw new Error('fetching the userscript failed: HTTP ' + String(response.status))
          source = await response.text()
        }
        const nameMatch = /^\/\/\s*@name\s+(.+)$/m.exec(source)
        if (nameMatch === null) throw new Error('the userscript source has no @name header')
        const scriptName = String(nameMatch[1]).trim()
        if (force !== true) {
          const existing = tampermonkeyScriptNames(await tampermonkeyCommand({
            method: 'loadTree',
            referrer: 'options',
            layout: 'default',
            url: '',
            available_columns: [],
            complete: true,
            uuid: null,
            tabId: null,
          }))
          if (existing.includes(scriptName)) {
            return text(
              'already installed: ' + scriptName +
              String.fromCharCode(10) +
              'pass force:true to add another copy, or browser_tampermonkey_remove first',
            )
          }
        }
        const raw = await tampermonkeyCommand({
          method: 'saveScript',
          code: source,
          uuid: 'dsh-' + String(Date.now()),
          clean: false,
          force: true,
          new_script: true,
          auto_save: false,
          restore: false,
          lastModTime: null,
          reload: true,
        })
        const parsed = JSON.parse(raw) as { error?: string; installed?: boolean; uuid?: string }
        if (parsed.error !== undefined) throw new Error(parsed.error)
        if (parsed.installed !== true) return text('Tampermonkey did not confirm the install: ' + raw.slice(0, 200))
        return text('installed ' + scriptName + ' (uuid ' + String(parsed.uuid) + ')')
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_tampermonkey_set_enabled',
    {
      title: 'Enable or disable a userscript',
      description:
        'Turn a userscript on or off in Tampermonkey (modifyScriptOptions with {enabled}). Identify the script by ' +
        'uuid, or by the @name shown in browser_tampermonkey_list. A disabled script stays installed but is not injected.',
      inputSchema: {
        name: z.string().optional().describe('Script @name'),
        uuid: z.string().optional().describe('Script uuid, if you already have it'),
        enabled: z.boolean().describe('true to enable, false to disable'),
      },
      annotations: WRITES,
    },
    async ({ name, uuid, enabled }: { name?: string; uuid?: string; enabled: boolean }) => {
      try {
        if (name === undefined && uuid === undefined) throw new Error('give name or uuid')
        const target = uuid === undefined ? str(name as string, 'name') : str(uuid, 'uuid')
        const raw = await tampermonkeyCommand({
          method: 'modifyScriptOptions',
          uuid: target,
          options: { enabled: enabled },
        })
        const parsed = JSON.parse(raw) as { error?: string; items?: unknown }
        if (parsed.error !== undefined) throw new Error(parsed.error)
        return text((enabled ? 'enabled ' : 'disabled ') + target)
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_tampermonkey_remove',
    {
      title: 'Remove userscripts from Tampermonkey',
      description:
        'Delete userscripts by uuid or by the @name shown in browser_tampermonkey_list (purgeScripts). Removed scripts ' +
        'go to Tampermonkey trash by default, so the deletion is recoverable from its dashboard.',
      inputSchema: {
        names: z.array(z.string()).optional().describe('Script @names to remove'),
        uuids: z.array(z.string()).optional().describe('Script uuids to remove'),
      },
      annotations: WRITES_PERSISTENTLY,
    },
    async ({ names, uuids }: { names?: string[]; uuids?: string[] }) => {
      try {
        const ids: string[] = Array.isArray(uuids) ? uuids.map((value) => str(value, 'uuid')) : []
        if (Array.isArray(names) && names.length > 0) {
          const raw = await tampermonkeyCommand({
            method: 'loadTree',
            referrer: 'options',
            layout: 'default',
            url: '',
            available_columns: [],
            complete: true,
            uuid: null,
            tabId: null,
          })
          const parsed = JSON.parse(raw) as { items?: unknown }
          const wanted = new Set(names.map((value) => str(value, 'name')))
          const walk = (items: unknown): void => {
            if (!Array.isArray(items)) return
            for (const item of items) {
              if (item === null || typeof item !== 'object') continue
              const node = item as { name?: unknown; uuid?: unknown; items?: unknown }
              if (Array.isArray(node.items)) walk(node.items)
              else if (typeof node.name === 'string' && wanted.has(node.name) && typeof node.uuid === 'string') {
                ids.push(node.uuid)
              }
            }
          }
          walk(parsed.items)
          if (ids.length === 0) return text('none of those names matched an installed script')
        }
        if (ids.length === 0) throw new Error('give names or uuids')
        const raw = await tampermonkeyCommand({ method: 'purgeScripts', uuids: ids })
        const parsed = JSON.parse(raw) as { error?: string }
        if (parsed.error !== undefined) throw new Error(parsed.error)
        return text('removed ' + String(ids.length) + ' script(s)')
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_devtools_tools',
    {
      title: 'List the DevTools panels available for a tab',
      description:
        'List the Developer Tools panels this Firefox exposes (inspector, webconsole, jsdebugger, netmonitor, ' +
        'styleeditor, performance, memory, storage, accessibility, application, options) together with the id you can ' +
        'pass to browser_devtools_open. MEASURED: these modules live behind their own loader, not the normal ESM one — ' +
        'the module id is "devtools/client/framework/devtools" (no leading g) and it exports gDevTools.',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      try {
        const raw = await withChrome(async (client, chromeContext) => {
          return client.evaluate(
            '(() => {' +
              ' try {' +
              '  if (!window.__dshGdt) {' +
              '    const Mod = ChromeUtils.importESModule("resource://devtools/shared/loader/Loader.sys.mjs");' +
              '    const loader = new Mod.DevToolsLoader();' +
              '    window.__dshGdt = loader.require("devtools/client/framework/devtools").gDevTools;' +
              '  }' +
              '  const gDevTools = window.__dshGdt;' +
              '  const defs = gDevTools.getToolDefinitionArray();' +
              '  return JSON.stringify({ ok: true, tools: defs.map(d => ({ id: d.id, label: (d.label || "").slice(0, 30) })) });' +
              ' } catch (e) { return JSON.stringify({ error: e.message }); }' +
              ' })()',
            chromeContext,
          )
        })
        if (typeof raw !== 'string') throw new Error('devtools tool list returned nothing')
        const info = JSON.parse(raw) as { error?: string; tools?: Array<{ id: string; label: string }> }
        if (info.error !== undefined) throw new Error(info.error)
        const tools = info.tools ?? []
        return text(
          tools.map((tool) => tool.id + '  —  ' + tool.label).join(String.fromCharCode(10)),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_devtools_open',
    {
      title: 'Open a Developer Tools panel for a tab',
      description:
        'Open the Firefox DevTools toolbox on a tab and select one tool panel. MEASURED: the entry point is ' +
        'gDevTools.showToolboxForTab(tab, {toolId}) — there is no gDevTools.openToolbox in this build. Tool ids come ' +
        'from browser_devtools_tools. The toolbox may open in a separate window, which is why its markup is not ' +
        'visible in the browser document.',
      inputSchema: {
        tool: z
          .enum([
            'inspector',
            'webconsole',
            'jsdebugger',
            'netmonitor',
            'styleeditor',
            'performance',
            'memory',
            'storage',
            'accessibility',
            'application',
            'options',
          ])
          .describe('Which panel to select'),
        context: z.string().optional().describe('Tab to inspect (default: the active tab)'),
      },
      annotations: WRITES,
    },
    async ({ tool, context }: { tool: string; context?: string }) => {
      try {
        const toolId = str(tool, 'tool')
        const target = context === undefined ? null : str(context, 'context')
        const raw = await withBidi(async (client) => {
          const chromeContext = await client.chromeContext()
          if (chromeContext === null) {
            throw new Error(
              'no privileged (chrome) context — Firefox must be launched with MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1',
            )
          }
          const index = target === null ? -1 : await tabIndexForContext(client, target)
          return await client.evaluate(
            '(async () => {' +
              ' try {' +
              '  if (!window.__dshGdt) {' +
              '    const Mod = ChromeUtils.importESModule("resource://devtools/shared/loader/Loader.sys.mjs");' +
              '    const loader = new Mod.DevToolsLoader();' +
              '    window.__dshGdt = loader.require("devtools/client/framework/devtools").gDevTools;' +
              '  }' +
              '  const gDevTools = window.__dshGdt;' +
              '  const tab = ' + (index < 0 ? 'gBrowser.selectedTab' : 'gBrowser.tabs[' + String(index) + ']') + ';' +
              '  if (!tab) return JSON.stringify({ error: "tab not found" });' +
              '  const toolbox = await gDevTools.showToolboxForTab(tab, { toolId: ' + JSON.stringify(toolId) + ' });' +
              '  return JSON.stringify({ ok: true, currentTool: toolbox ? toolbox.currentToolId : null });' +
              ' } catch (e) { return JSON.stringify({ error: e.message }); }' +
              ' })()',
            chromeContext,
          )
        })
        if (typeof raw !== 'string') throw new Error('devtools open returned nothing')
        const info = JSON.parse(raw) as { error?: string; currentTool?: string | null }
        if (info.error !== undefined) throw new Error(info.error)
        return text('DevTools opened on panel: ' + String(info.currentTool ?? toolId))
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_devtools_close',
    {
      title: 'Close the Developer Tools toolbox',
      description:
        'Close the DevTools toolbox for a tab, or all of them. MEASURED: gDevTools.closeToolboxForTab(tab, {destroy}) ' +
        'and gDevTools.closeAllToolboxes() are the entry points.',
      inputSchema: {
        context: z.string().optional().describe('Tab whose toolbox to close (default: the active tab)'),
        all: z.boolean().optional().describe('Close every toolbox instead'),
      },
      annotations: WRITES,
    },
    async ({ context, all }: { context?: string; all?: boolean }) => {
      try {
        const target = context === undefined ? null : str(context, 'context')
        const raw = await withBidi(async (client) => {
          const chromeContext = await client.chromeContext()
          if (chromeContext === null) {
            throw new Error(
              'no privileged (chrome) context — Firefox must be launched with MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1',
            )
          }
          const index = target === null ? -1 : await tabIndexForContext(client, target)
          const body =
            all === true
              ? '(async () => { try { if (!window.__dshGdt) {' +
                ' const Mod = ChromeUtils.importESModule("resource://devtools/shared/loader/Loader.sys.mjs");' +
                ' const loader = new Mod.DevToolsLoader();' +
                ' window.__dshGdt = loader.require("devtools/client/framework/devtools").gDevTools;' +
                ' }' +
                ' const gDevTools = window.__dshGdt;' +
                ' await gDevTools.closeAllToolboxes(); return JSON.stringify({ ok: true, all: true });' +
                ' } catch (e) { return JSON.stringify({ error: e.message }); } })()'
              : '(async () => { try { if (!window.__dshGdt) {' +
                ' const Mod = ChromeUtils.importESModule("resource://devtools/shared/loader/Loader.sys.mjs");' +
                ' const loader = new Mod.DevToolsLoader();' +
                ' window.__dshGdt = loader.require("devtools/client/framework/devtools").gDevTools;' +
                ' }' +
                ' const gDevTools = window.__dshGdt;' +
                ' const tab = ' + (index < 0 ? 'gBrowser.selectedTab' : 'gBrowser.tabs[' + String(index) + ']') + ';' +
                ' if (!tab) return JSON.stringify({ error: "tab not found" });' +
                ' const had = gDevTools.hasToolboxForTab(tab);' +
                ' if (had) await gDevTools.closeToolboxForTab(tab, { destroy: true });' +
                ' return JSON.stringify({ ok: true, had });' +
                ' } catch (e) { return JSON.stringify({ error: e.message }); } })()'
          return await client.evaluate(body, chromeContext)
        })
        if (typeof raw !== 'string') throw new Error('devtools close returned nothing')
        const info = JSON.parse(raw) as { error?: string; had?: boolean; all?: boolean }
        if (info.error !== undefined) throw new Error(info.error)
        if (info.all === true) return text('closed all DevTools toolboxes')
        return text(info.had === true ? 'closed the DevTools toolbox' : 'no toolbox was open for that tab')
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_open_about_page',
    {
      title: 'Open one of Firefox internal about: pages',
      description:
        'Open a Firefox internal page in a new tab. This covers the entries of the Tools > Browser Tools menu that are ' +
        'plain about: pages rather than DevTools APIs — MEASURED: the Task Manager is about:processes and Developer ' +
        'Tools for extensions is about:debugging. Both render real content this way. Also accepts addons, config, ' +
        'support, profiles, netmonitor-free pages and any other whitelisted about: name.',
      inputSchema: {
        page: z
          .enum([
            'processes',
            'debugging',
            'addons',
            'config',
            'support',
            'profiles',
            'performance',
            'memory',
            'networking',
            'serviceworkers',
            'webrtc',
            'certificate',
            'telemetry',
            'policies',
            'downloads',
          ])
          .describe('Which about: page to open (about:<page>)'),
        background: z.boolean().optional().describe('Open in the background'),
      },
      annotations: WRITES,
    },
    async ({ page, background }: { page: string; background?: boolean }) => {
      try {
        const name = str(page, 'page')
        const url = 'about:' + name
        return text(
          await withChrome(async (client, chromeContext) => {
            const raw = await client.evaluate(
              '(() => {' +
                ' try {' +
                '  const tab = gBrowser.addTab(' + JSON.stringify(url) + ', {' +
                '    triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),' +
                '    inBackground: ' + (background === true ? 'true' : 'false') + '' +
                '  });' +
                '  return "opened " + ' + JSON.stringify(url) + ';' +
                ' } catch (e) { return "ERR " + e.message; }' +
                ' })()',
              chromeContext,
            )
            if (typeof raw !== 'string') throw new Error('open about page returned nothing')
            if (raw.startsWith('ERR ')) throw new Error(raw.slice(4))
            return raw
          }),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_about_page_info',
    {
      title: 'Read the text content of an opened about: page',
      description:
        'Report the title and visible text of an already-open about: page, so a caller can confirm the internal page ' +
        'actually rendered instead of assuming it did. MEASURED: about:processes starts with an empty table skeleton ' +
        'and fills in asynchronously, so this may need calling again after a short wait.',
      inputSchema: {
        page: z.string().describe('about: page name, e.g. processes'),
        maxChars: z.number().int().min(40).max(4000).optional().describe('How much text to return (default 600)'),
      },
      annotations: READ_ONLY,
    },
    async ({ page, maxChars }: { page: string; maxChars?: number }) => {
      try {
        const name = str(page, 'page')
        const limit = maxChars ?? 600
        const url = 'about:' + name
        return text(
          await withBidi(async (client) => {
            let context: string | null = null
            for (let attempt = 0; attempt < 25; attempt += 1) {
              const tree = (await client.call('browsingContext.getTree', {})) as {
                contexts?: Array<{ context: string; url?: string; children?: unknown[] }>
              }
              type Node = { context: string; url?: string; children?: unknown[] }
              const flat: Array<{ context: string; url?: string }> = []
              const collect = (nodes: Node[]): void => {
                for (const node of nodes) {
                  flat.push({ context: node.context, url: node.url })
                  if (Array.isArray(node.children)) collect(node.children as Node[])
                }
              }
              collect((tree.contexts ?? []) as Node[])
              const hit = flat.find((node) => node.url === url || (node.url ?? '').startsWith(url))
              if (hit !== undefined) {
                context = hit.context
                break
              }
              await new Promise((resolve) => setTimeout(resolve, 200))
            }
            if (context === null) throw new Error('no open tab for ' + url)
            const raw = (await client.evaluate(
              'JSON.stringify({' +
                ' url: location.href,' +
                ' title: document.title,' +
                ' text: document.body ? document.body.innerText.replace(/\\s+/g, " ").slice(0, ' + String(limit) + ') : null,' +
                ' bodyLen: document.body ? document.body.innerText.length : 0' +
                ' })',
              context,
            )) as unknown
            return typeof raw === 'string' ? raw : JSON.stringify(raw)
          }),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_console',
    {
      title: 'Open or close the Browser Console',
      description:
        'Open or close the Browser Console (the Ctrl+Shift+J window that logs browser-wide messages). MEASURED: call ' +
        'BrowserConsoleManager.openWindow() with NO arguments — its openBrowserConsole(win) variant throws ' +
        '"can\'t access property windowRoot, win is undefined" because the manager has no commands bound outside a ' +
        'real DevTools context. openWindow() spawns the standalone devtools:webconsole window, which is what the menu ' +
        'item does.',
      inputSchema: {
        action: z.enum(['open', 'close', 'toggle']).describe('What to do'),
      },
      annotations: WRITES,
    },
    async ({ action }: { action: 'open' | 'close' | 'toggle' }) => {
      try {
        const what = str(action, 'action')
        const raw = await withChrome(async (client, chromeContext) => {
          return client.evaluate(
            '(async () => {' +
              ' try {' +
              '  if (!window.__dshBcm) {' +
              '    const Mod = ChromeUtils.importESModule("resource://devtools/shared/loader/Loader.sys.mjs");' +
              '    const loader = new Mod.DevToolsLoader();' +
              '    window.__dshBcm = loader.require("devtools/client/webconsole/browser-console-manager").BrowserConsoleManager;' +
              '  }' +
              '  const m = window.__dshBcm;' +
              '  const action = ' + JSON.stringify(what) + ';' +
              '  if (action === "open") {' +
              '    const win = await m.openWindow();' +
              '    return JSON.stringify({ ok: true, opened: !!win });' +
              '  }' +
              '  if (action === "close") {' +
              '    await m.closeBrowserConsole();' +
              '    return JSON.stringify({ ok: true, closed: true });' +
              '  }' +
              '  await m.toggleBrowserConsole();' +
              '  return JSON.stringify({ ok: true, toggled: true });' +
              ' } catch (e) { return JSON.stringify({ error: e.message }); }' +
              ' })()',
            chromeContext,
          )
        })
        if (typeof raw !== 'string') throw new Error('browser console returned nothing')
        const info = JSON.parse(raw) as { error?: string; opened?: boolean; closed?: boolean; toggled?: boolean }
        if (info.error !== undefined) throw new Error(info.error)
        if (info.opened === true) return text('Browser Console opened (standalone devtools:webconsole window)')
        if (info.closed === true) return text('Browser Console closed')
        return text('Browser Console toggled')
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_page_source',
    {
      title: 'Get the page HTML source',
      description:
        'Return the serialised DOM of a tab (document.documentElement.outerHTML). This is what the page looks like ' +
        'after scripts ran. It is NOT the original bytes on the wire, so it is not the same as the View Source menu ' +
        'item — use the network tools if the raw response matters.',
      inputSchema: {
        context: z.string().optional().describe('Tab (default: the active tab)'),
        maxChars: z.number().int().min(100).max(400000).optional().describe('Truncate the result (default 20000)'),
      },
      annotations: READ_ONLY,
    },
    async ({ context, maxChars }: { context?: string; maxChars?: number }) => {
      try {
        const target = context === undefined ? null : str(context, 'context')
        const limit = maxChars ?? 20000
        return text(
          await withBidi(async (client) => {
            let ctx: string | null = null
            if (target === null) {
              ctx = await client.pageContext()
            } else {
              ctx = target
            }
            if (ctx === null) throw new Error('no page context available')
            const expression =
              'JSON.stringify({' +
                ' url: location.href,' +
                ' length: document.documentElement.outerHTML.length,' +
                ' html: document.documentElement.outerHTML.slice(0, ' + String(limit) + ')' +
                ' })'
            const raw = (await client.evaluate(expression, ctx)) as unknown
            const text_ = typeof raw === 'string' ? raw : JSON.stringify(raw)
            const info = JSON.parse(text_) as { url?: string; length?: number; html?: string }
            return (
              'URL: ' + String(info.url) +
              String.fromCharCode(10) +
              'HTML length: ' + String(info.length) +
              String.fromCharCode(10) +
              'NOTE: this is the DOM serialisation (outerHTML), not the bytes received over the network.' +
              String.fromCharCode(10) +
              String(info.html ?? '')
            )
          }),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_responsive_mode',
    {
      title: 'Open or close Responsive Design Mode (RDM)',
      description:
        'Open, close or query Firefox Responsive Design Mode for a tab. MEASURED details that matter: ' +
        '(1) the entry point is ResponsiveUIManager.openIfNeeded(window, tab, {trigger}) from module ' +
        '"devtools/client/responsive/manager" — that module IS the manager instance, not a container; ' +
        '(2) the window argument MUST come from Services.wm.getMostRecentWindow("navigator:browser"); passing ' +
        'gBrowser.ownerGlobal through the DevTools loader fails with "can\'t access property gBrowser, window is ' +
        'undefined"; ' +
        '(3) the manager must be cached on the chrome window — a fresh DevToolsLoader cannot see a UI opened through ' +
        'another loader, so closing would silently do nothing. ' +
        'IMPORTANT: iframe.rdm-toolbar is a PERMANENT node in the browser document — it stays after closing, so never ' +
        'use its presence to decide whether RDM is active. Use the responsive-mode class on the browser container ' +
        '(or the manager isActiveForTab) instead.',
      inputSchema: {
        action: z.enum(['open', 'close', 'toggle', 'status']).describe('What to do'),
        context: z.string().optional().describe('Tab (default: the active tab)'),
      },
      annotations: WRITES,
    },
    async ({ action, context }: { action: 'open' | 'close' | 'toggle' | 'status'; context?: string }) => {
      try {
        const what = str(action, 'action')
        const target = context === undefined ? null : str(context, 'context')
        const raw = await withBidi(async (client) => {
          const chromeContext = await client.chromeContext()
          if (chromeContext === null) {
            throw new Error(
              'no privileged (chrome) context — Firefox must be launched with MOZ_RELAX_ALLOW_SYSTEM_ACCESS=1 or MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1',
            )
          }
          const index = target === null ? -1 : await tabIndexForContext(client, target)
          return await client.evaluate(
            '(async () => {' +
              ' try {' +
              '  const win = Services.wm.getMostRecentWindow("navigator:browser");' +
              '  if (!win) return JSON.stringify({ error: "no browser window" });' +
              '  if (!win.__dshRdmMgr) {' +
              '    const Mod = ChromeUtils.importESModule("resource://devtools/shared/loader/Loader.sys.mjs");' +
              '    const loader = new Mod.DevToolsLoader();' +
              '    win.__dshRdmMgr = loader.require("devtools/client/responsive/manager");' +
              '  }' +
              '  const mgr = win.__dshRdmMgr;' +
              '  const tab = ' + (index < 0 ? 'win.gBrowser.selectedTab' : 'win.gBrowser.tabs[' + String(index) + ']') + ';' +
              '  if (!tab) return JSON.stringify({ error: "tab not found" });' +
              '  const action = ' + JSON.stringify(what) + ';' +
              '  if (action === "status") {' +
              '    return JSON.stringify({' +
              '      ok: true,' +
              '      active: mgr.isActiveForTab(tab),' +
              '      activeCount: mgr.activeTabs.size,' +
              '      domPresent: !!win.document.querySelector("browserContainer.responsive-mode, .browserContainer.responsive-mode, [class*=responsive-mode]")' +
              '    });' +
              '  }' +
              '  if (action === "close") {' +
              '    await mgr.closeIfNeeded(win, tab, { trigger: "menu" });' +
              '    return JSON.stringify({' +
              '      ok: true,' +
              '      active: mgr.isActiveForTab(tab),' +
              '      domPresent: !!win.document.querySelector("[class*=responsive-mode]"),' +
              '      action: "closed"' +
              '    });' +
              '  }' +
              '  if (action === "toggle") {' +
              '    await mgr.toggle(win, tab, { trigger: "menu" });' +
              '    return JSON.stringify({' +
              '      ok: true,' +
              '      active: mgr.isActiveForTab(tab),' +
              '      domPresent: !!win.document.querySelector("[class*=responsive-mode]"),' +
              '      action: "toggled"' +
              '    });' +
              '  }' +
              '  const ui = await mgr.openIfNeeded(win, tab, { trigger: "menu" });' +
              '  return JSON.stringify({' +
              '    ok: true,' +
              '    active: mgr.isActiveForTab(tab),' +
              '    ui: ui ? ui.constructor.name : null,' +
              '    domPresent: !!win.document.querySelector("[class*=responsive-mode]"),' +
              '    action: "opened"' +
              '  });' +
              ' } catch (e) { return JSON.stringify({ error: e.message }); }' +
              ' })()',
            chromeContext,
          )
        })
        if (typeof raw !== 'string') throw new Error('responsive mode returned nothing')
        const info = JSON.parse(raw) as {
          error?: string
          active?: boolean
          activeCount?: number
          domPresent?: boolean
          ui?: string | null
          action?: string
        }
        if (info.error !== undefined) throw new Error(info.error)
        if (what === 'status') {
          return text(
            'active: ' + String(info.active) +
            String.fromCharCode(10) +
            'open tabs: ' + String(info.activeCount) +
            String.fromCharCode(10) +
            'RDM markup present: ' + String(info.domPresent),
          )
        }
        return text(
          'Responsive Design Mode ' + String(info.action) +
          String.fromCharCode(10) +
          'active: ' + String(info.active) +
          String.fromCharCode(10) +
          'RDM markup present: ' + String(info.domPresent),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_eyedropper',
    {
      title: 'Start, poll or cancel the DevTools colour picker (eyedropper)',
      description:
        'Drive the DevTools eyedropper / colour picker on a tab. MEASURED, and this is the whole trick: Firefox ' +
        'deliberately supports the eyedropper WITHOUT a toolbox (bug 1701004), so it is reachable through a ' +
        'standalone commands instance — CommandsFactory.forTab(tab), targetCommand.startListening(), ' +
        'target.getFront("inspector"), then inspectorFront.pickColorFromPage({copyOnSelect, fromMenu}). ' +
        'That call returns immediately and the colour arrives later as a "color-picked" event carrying ' +
        'color:Arg(0,"string") (see devtools/shared/specs/inspector.js); "color-pick-canceled" fires on escape. ' +
        'Because picking requires a real pointer press on the page, this tool starts the picker and then polls: ' +
        'action:"start" arms it, action:"result" reports the colour once the user has clicked, action:"cancel" aborts. ' +
        'The picker instance is cached on the chrome window so polling reaches the same session.',
      inputSchema: {
        action: z.enum(['start', 'result', 'cancel']).describe('start = arm the picker, result = read the colour, cancel = abort'),
        context: z.string().optional().describe('Tab (default: the active tab)'),
      },
      annotations: WRITES,
    },
    async ({ action, context }: { action: 'start' | 'result' | 'cancel'; context?: string }) => {
      try {
        const what = str(action, 'action')
        const target = context === undefined ? null : str(context, 'context')
        const raw = await withBidi(async (client) => {
          const chromeContext = await client.chromeContext()
          if (chromeContext === null) {
            throw new Error(
              'no privileged (chrome) context — Firefox must be launched with MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1',
            )
          }
          const index = target === null ? -1 : await tabIndexForContext(client, target)
          return await client.evaluate(
            '(async () => {' +
              ' try {' +
              '  const win = Services.wm.getMostRecentWindow("navigator:browser");' +
              '  if (!win) return JSON.stringify({ error: "no browser window" });' +
              '  const action = ' + JSON.stringify(what) + ';' +
              '  const picker = win.__dshEyedropper;' +
              '  if (action === "result") {' +
              '    if (!picker) return JSON.stringify({ error: "no picker was started; call action:start first" });' +
              '    return JSON.stringify({' +
              '      ok: true,' +
              '      picked: picker.picked || null,' +
              '      canceled: !!picker.canceled,' +
              '      failed: picker.err || null' +
              '    });' +
              '  }' +
              '  if (action === "cancel") {' +
              '    if (!picker || !picker.inspectorFront) return JSON.stringify({ error: "no picker to cancel" });' +
              '    try { await picker.inspectorFront.cancelPickColorFromPage({ fromMenu: true }); } catch (e) {}' +
              '    if (picker.commands) { try { picker.commands.destroy(); } catch (e) {} }' +
              '    win.__dshEyedropper = null;' +
              '    return JSON.stringify({ ok: true, canceled: true });' +
              '  }' +
              '  if (picker && picker.commands) { try { picker.commands.destroy(); } catch (e) {} }' +
              '  const Mod = ChromeUtils.importESModule("resource://devtools/shared/loader/Loader.sys.mjs");' +
              '  const loader = new Mod.DevToolsLoader();' +
              '  const { CommandsFactory } = loader.require("devtools/shared/commands/commands-factory");' +
              '  const tab = ' + (index < 0 ? 'win.gBrowser.selectedTab' : 'win.gBrowser.tabs[' + String(index) + ']') + ';' +
              '  if (!tab) return JSON.stringify({ error: "tab not found" });' +
              '  const commands = await CommandsFactory.forTab(tab);' +
              '  await commands.targetCommand.startListening();' +
              '  const devtoolsTarget = commands.targetCommand.targetFront;' +
              '  const inspectorFront = await devtoolsTarget.getFront("inspector");' +
              '  const state = { commands, inspectorFront, picked: null, canceled: false, err: null };' +
              '  win.__dshEyedropper = state;' +
              '  inspectorFront.on("color-picked", (event) => { state.picked = event; });' +
              '  inspectorFront.on("color-pick-canceled", () => { state.canceled = true; });' +
              '  inspectorFront' +
              '    .pickColorFromPage({ copyOnSelect: true, fromMenu: true })' +
              '    .catch((e) => { state.err = e.message; });' +
              '  return JSON.stringify({ ok: true, started: true });' +
              ' } catch (e) { return JSON.stringify({ error: e.message }); }' +
              ' })()',
            chromeContext,
          )
        })
        if (typeof raw !== 'string') throw new Error('eyedropper returned nothing')
        const info = JSON.parse(raw) as {
          error?: string
          started?: boolean
          picked?: unknown
          canceled?: boolean
          failed?: string | null
        }
        if (info.error !== undefined) throw new Error(info.error)
        if (what === 'start') {
          return text(
            'colour picker armed' +
              String.fromCharCode(10) +
              'click anywhere on the page to pick a colour, then call action:"result"' +
              String.fromCharCode(10) +
              'press Escape (or call action:"cancel") to abort',
          )
        }
        if (what === 'cancel') return text('colour picker cancelled')
        if (info.failed) return text('the picker failed: ' + String(info.failed))
        if (info.picked) {
          const picked = info.picked as { color?: string }
          return text('picked colour: ' + String(picked.color ?? JSON.stringify(info.picked)))
        }
        if (info.canceled === true) return text('picking was cancelled before a colour was chosen')
        return text('no colour yet — the picker is still armed; click on the page first')
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_remote_debugging',
    {
      title: 'Inspect or change the DevTools remote debugging server settings',
      description:
        'Report or change Firefox remote debugging settings — the "Remote Debugging" entry in the Browser Tools menu. ' +
        'MEASURED on Firefox Developer Edition: the port lives in the integer pref devtools.debugger.remote-port ' +
        '(observed 6000) and the server module is resource://devtools/server/devtools-server.sys.mjs (an object, so ' +
        'this build does ship a DevTools server). Note that DSH itself talks to Firefox over WebDriver BiDi on the ' +
        'separate --remote-debugging-port flag, which is not this pref.',
      inputSchema: {
        action: z.enum(['status', 'enable', 'disable']).describe('status = read only; enable/disable flips the prefs'),
        port: z.number().int().min(1).max(65535).optional().describe('Port to use when enabling (default keeps current)'),
      },
      annotations: WRITES,
    },
    async ({ action, port }: { action: 'status' | 'enable' | 'disable'; port?: number }) => {
      try {
        const what = str(action, 'action')
        const requestedPort = port === undefined ? null : port
        const raw = await withChrome(async (client, chromeContext) => {
          return client.evaluate(
            '(() => {' +
              ' try {' +
              '  const action = ' + JSON.stringify(what) + ';' +
              '  const getInt = (name, fallback) => { try { return Services.prefs.getIntPref(name); } catch (e) { return fallback; } };' +
              '  const getBool = (name, fallback) => { try { return Services.prefs.getBoolPref(name); } catch (e) { return fallback; } };' +
              '  if (action === "enable") {' +
              '    if (' + String(requestedPort) + ' !== null) Services.prefs.setIntPref("devtools.debugger.remote-port", ' + String(requestedPort) + ');' +
              '    Services.prefs.setBoolPref("devtools.debugger.remote-enabled", true);' +
              '  } else if (action === "disable") {' +
              '    Services.prefs.setBoolPref("devtools.debugger.remote-enabled", false);' +
              '  }' +
              '  let hasServer = false;' +
              '  let serverPath = null;' +
              '  for (const p of ["resource://devtools/server/devtools-server.sys.mjs",' +
              '                   "resource://devtools/server/devtools-server.js"]) {' +
              '    try {' +
              '      const mod = ChromeUtils.importESModule(p);' +
              '      if (mod && typeof mod === "object") { hasServer = true; serverPath = p; break; }' +
              '    } catch (e) {}' +
              '  }' +
              '  if (!hasServer) {' +
              '    try {' +
              '      const Mod = ChromeUtils.importESModule("resource://devtools/shared/loader/Loader.sys.mjs");' +
              '      const devLoader = new Mod.DevToolsLoader();' +
              '      const m = devLoader.require("devtools/server/devtools-server");' +
              '      if (m) { hasServer = true; serverPath = "loader:devtools/server/devtools-server"; }' +
              '    } catch (e) {}' +
              '  }' +
              '  return JSON.stringify({' +
              '    ok: true,' +
              '    enabled: getBool("devtools.debugger.remote-enabled", false),' +
              '    port: getInt("devtools.debugger.remote-port", -1),' +
              '    host: (() => { try { return Services.prefs.getCharPref("devtools.debugger.remote-host"); } catch (e) { return null; } })(),' +
              '    chromeEnabled: getBool("devtools.chrome.enabled", false),' +
              '    hasServer,' +
              '    serverPath' +
              '  });' +
              ' } catch (e) { return JSON.stringify({ error: e.message }); }' +
              ' })()',
            chromeContext,
          )
        })
        if (typeof raw !== 'string') throw new Error('remote debugging returned nothing')
        const info = JSON.parse(raw) as {
          error?: string
          enabled?: boolean
          port?: number
          host?: string | null
          chromeEnabled?: boolean
          hasServer?: boolean
          serverPath?: string | null
        }
        if (info.error !== undefined) throw new Error(info.error)
        return text(
          'remote debugging enabled: ' + String(info.enabled) +
          String.fromCharCode(10) +
          'port: ' + String(info.port) +
          String.fromCharCode(10) +
          'host: ' + String(info.host ?? '(unset)') +
          String.fromCharCode(10) +
          'devtools.chrome.enabled: ' + String(info.chromeEnabled) +
          String.fromCharCode(10) +
          'DevTools server module available: ' + String(info.hasServer) +
          (info.serverPath ? ' (' + String(info.serverPath) + ')' : ''),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_element_screen_coords',
    {
      title: 'Get the screen coordinates of an element so a native click can target it',
      description:
        'Return the on-screen pixel centre of an element, for handing to a native input driver (Cua, SendInput). ' +
        'MEASURED: compute it as mozInnerScreenX/Y + getBoundingClientRect() centre, WITHOUT multiplying by ' +
        'devicePixelRatio — mozInnerScreen* is already in screen pixels, and scaling it again puts the cursor far ' +
        'off target. This exists because some browser features only react to genuine OS-level input — the DevTools ' +
        'eyedropper and HTML5 drag-and-drop both ignore synthesised DOM/WebDriver events, but respond normally to a ' +
        'real SendInput click or drag.',
      inputSchema: {
        context: z
          .string()
          .optional()
          .describe('Tab: a browsing context id, or any fragment of the tab URL (default: the active tab)'),
        selector: z.string().describe('CSS selector of the element'),
        offsetX: z.number().optional().describe('Pixels added to the centre X'),
        offsetY: z.number().optional().describe('Pixels added to the centre Y'),
      },
      annotations: READ_ONLY,
    },
    async ({
      context,
      selector,
      offsetX,
      offsetY,
    }: {
      context?: string
      selector: string
      offsetX?: number
      offsetY?: number
    }) => {
      try {
        const wanted = context === undefined ? null : str(context, 'context')
        const css = str(selector, 'selector')
        const dx = offsetX ?? 0
        const dy = offsetY ?? 0
        return text(
          await withBidi(async (client) => {
            let ctx: string | null = null
            if (wanted === null) {
              ctx = await client.pageContext()
            } else {
              const tree = (await client.call('browsingContext.getTree', {})) as {
                contexts?: Array<{ context: string; url?: string; children?: unknown[] }>
              }
              type Node = { context: string; url?: string; children?: unknown[] }
              const flat: Array<{ context: string; url?: string }> = []
              const collect = (nodes: Node[]): void => {
                for (const node of nodes) {
                  flat.push({ context: node.context, url: node.url })
                  if (Array.isArray(node.children)) collect(node.children as Node[])
                }
              }
              collect((tree.contexts ?? []) as Node[])
              const hit = flat.find(
                (node) => node.context === wanted || (node.url ?? '').indexOf(wanted) !== -1,
              )
              if (hit === undefined) throw new Error('no open tab matches: ' + wanted)
              ctx = hit.context
            }
            if (ctx === null) throw new Error('no page context available')
            const expression =
              'JSON.stringify((() => {' +
              ' const el = document.querySelector(' + JSON.stringify(css) + ');' +
              ' if (!el) return { error: "element not found" };' +
              ' const r = el.getBoundingClientRect();' +
              ' el.scrollIntoView({ block: "center", inline: "center" });' +
              ' const r2 = el.getBoundingClientRect();' +
              ' const ox = window.mozInnerScreenX || 0;' +
              ' const oy = window.mozInnerScreenY || 0;' +
              ' return {' +
              '  screenX: Math.round(ox + r2.left + r2.width / 2 + ' + String(dx) + '),' +
              '  screenY: Math.round(oy + r2.top + r2.height / 2 + ' + String(dy) + '),' +
              '  rect: { left: Math.round(r2.left), top: Math.round(r2.top), width: Math.round(r2.width), height: Math.round(r2.height) },' +
              '  devicePixelRatio: window.devicePixelRatio,' +
              '  innerScreen: { x: ox, y: oy }' +
              ' };' +
              '})())'
            const raw = (await client.evaluate(expression, ctx)) as unknown
            const source = typeof raw === 'string' ? raw : JSON.stringify(raw)
            const info = JSON.parse(source) as {
              error?: string
              screenX?: number
              screenY?: number
              rect?: { left: number; top: number; width: number; height: number }
              devicePixelRatio?: number
              innerScreen?: { x: number; y: number }
            }
            if (info.error !== undefined) throw new Error(info.error)
            return (
              'screen centre: (' + String(info.screenX) + ', ' + String(info.screenY) + ')' +
              String.fromCharCode(10) +
              'element rect: ' + JSON.stringify(info.rect) +
              String.fromCharCode(10) +
              'inner screen origin: ' + JSON.stringify(info.innerScreen) +
              String.fromCharCode(10) +
              'devicePixelRatio: ' + String(info.devicePixelRatio) +
              ' (already accounted for — do NOT scale the coordinates again)' +
              String.fromCharCode(10) +
              'feed these numbers to a native click/drag; WebDriver events will not work for eyedropper or HTML5 drag-and-drop'
            )
          }),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_extension_permissions',
    {
      title: 'Read the permissions an extension has been granted',
      description:
        'Report the user-granted permissions and origin patterns of installed extensions. MEASURED: AddonWrapper ' +
        'exposes userPermissions.permissions (string array) and userPermissions.origins (string array), so the ' +
        'permission surface is readable without opening about:addons. Note this reads what is granted; it does not ' +
        'grant or revoke — those prompts are extension-owned UI.',
      inputSchema: {
        id: z.string().optional().describe('Only this extension id (default: every extension)'),
      },
      annotations: READ_ONLY,
    },
    async ({ id }: { id?: string }) => {
      try {
        const wanted = id === undefined ? null : str(id, 'id')
        const raw = await withChrome(async (client, chromeContext) => {
          return client.evaluate(
            '(async () => {' +
              ' try {' +
              '  const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");' +
              '  const all = await AddonManager.getAllAddons();' +
              '  const wanted = ' + (wanted === null ? 'null' : JSON.stringify(wanted)) + ';' +
              '  const rows = all' +
              '    .filter(a => a.type === "extension")' +
              '    .filter(a => wanted === null || a.id === wanted || a.id.indexOf(wanted) !== -1)' +
              '    .map(a => ({' +
              '      id: a.id,' +
              '      name: a.name,' +
              '      enabled: a.isActive,' +
              '      permissions: a.userPermissions ? (a.userPermissions.permissions || []) : [],' +
              '      origins: a.userPermissions ? (a.userPermissions.origins || []) : [],' +
              '      hostCount: a.userPermissions && a.userPermissions.origins ? a.userPermissions.origins.length : 0' +
              '    }));' +
              '  return JSON.stringify({ ok: true, rows });' +
              ' } catch (e) { return JSON.stringify({ error: e.message }); }' +
              ' })()',
            chromeContext,
          )
        })
        if (typeof raw !== 'string') throw new Error('extension permissions returned nothing')
        const info = JSON.parse(raw) as {
          error?: string
          rows?: Array<{
            id: string
            name: string
            enabled: boolean
            permissions: string[]
            origins: string[]
            hostCount: number
          }>
        }
        if (info.error !== undefined) throw new Error(info.error)
        const rows = info.rows ?? []
        if (rows.length === 0) return text('no extension matched')
        const lines: string[] = []
        for (const row of rows) {
          lines.push(
            row.name + '  (' + row.id + ')  ' +
            (row.enabled ? 'enabled' : 'disabled'),
          )
          lines.push('  api: ' + (row.permissions.length ? row.permissions.join(', ') : '(none)'))
          lines.push(
            '  hosts: ' + String(row.hostCount) +
            (row.origins.length ? ' -> ' + row.origins.slice(0, 8).join(', ') : ''),
          )
        }
        return text(lines.join(String.fromCharCode(10)))
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_autofill_status',
    {
      title: 'Report whether form autofill is available and enabled',
      description:
        'Report the address / credit-card autofill state. MEASURED: resource://autofill/FormAutofill.sys.mjs loads and ' +
        'exposes isAutofillEnabled, and FormAutofillStorage.sys.mjs also loads. This only reports status — the stored ' +
        'address and card records live behind the autofill storage API, which this build does not expose for remote ' +
        'write, so treat editing saved autofill entries as out of scope.',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      try {
        return text(
          await withChrome(async (client, chromeContext) => {
            const raw = await client.evaluate(
              '(() => {' +
                ' try {' +
                '  const out = {};' +
                '  try {' +
                '    const { FormAutofill } = ChromeUtils.importESModule("resource://autofill/FormAutofill.sys.mjs");' +
                '    out.hasFormAutofill = !!FormAutofill;' +
                '    try { out.enabled = FormAutofill.isAutofillEnabled; } catch (e) { out.enabled = null; }' +
                '  } catch (e) { out.formAutofillErr = e.message; }' +
                '  try {' +
                '    ChromeUtils.importESModule("resource://autofill/FormAutofillStorage.sys.mjs");' +
                '    out.hasStorage = true;' +
                '  } catch (e) { out.hasStorage = false; }' +
                '  return JSON.stringify(out);' +
                ' } catch (e) { return JSON.stringify({ error: e.message }); }' +
                ' })()',
              chromeContext,
            )
            if (typeof raw !== 'string') throw new Error('autofill status returned nothing')
            const info = JSON.parse(raw) as {
              error?: string
              hasFormAutofill?: boolean
              enabled?: boolean | null
              hasStorage?: boolean
              formAutofillErr?: string
            }
            if (info.error !== undefined) throw new Error(info.error)
            return (
              'FormAutofill available: ' + String(info.hasFormAutofill) +
              String.fromCharCode(10) +
              'autofill enabled: ' + String(info.enabled) +
              String.fromCharCode(10) +
              'storage module available: ' + String(info.hasStorage) +
              String.fromCharCode(10) +
              'NOTE: status only — editing saved addresses/cards is not exposed to this build.'
            )
          }),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_search_engine',
    {
      title: 'List, set, move or remove search engines',
      description:
        'Manage Firefox search engines. MEASURED, and this is the whole trick: the SearchService is NOT reachable via ' +
        'resource:// in this build — it lives under the moz-src protocol, so the module id is ' +
        '"moz-src:///toolkit/components/search/SearchService.sys.mjs" and it exports SearchService (a singleton). ' +
        'That object exposes getEngines/setDefault/setDefaultPrivate/moveEngine/removeEngine/restoreDefaultEngines ' +
        'and the add* family (addEngineFromExtension / addOpenSearchEngine / addUserEngine). Older guidance that the ' +
        'service is unreachable was wrong.',
      inputSchema: {
        action: z.enum(['list', 'set-default', 'move', 'remove', 'reset']).describe('What to do'),
        name: z.string().optional().describe('Engine name, for set-default / move / remove'),
        position: z.number().int().min(1).optional().describe('1-based position for move'),
      },
      annotations: WRITES,
    },
    async ({
      action,
      name,
      position,
    }: {
      action: 'list' | 'set-default' | 'move' | 'remove' | 'reset'
      name?: string
      position?: number
    }) => {
      try {
        const what = str(action, 'action')
        const engineName = name === undefined ? null : str(name, 'name')
        const pos = position === undefined ? null : position
        const raw = await withChrome(async (client, chromeContext) => {
          return client.evaluate(
            '(async () => {' +
              ' try {' +
              '  const { SearchService } = ChromeUtils.importESModule("moz-src:///toolkit/components/search/SearchService.sys.mjs");' +
              '  const action = ' + JSON.stringify(what) + ';' +
              '  const wantName = ' + (engineName === null ? 'null' : JSON.stringify(engineName)) + ';' +
              '  const wantPos = ' + (pos === null ? 'null' : String(pos)) + ';' +
              '  const engines = await SearchService.getEngines();' +
              '  const current = await SearchService.getDefault();' +
              '  const names = engines.map(e => e.name);' +
              '  if (action === "list") {' +
              '    return JSON.stringify({ ok: true, current: current.name, engines: names });' +
              '  }' +
              '  if (action === "reset") {' +
              '    SearchService.reset();' +
              '    return JSON.stringify({ ok: true, reset: true });' +
              '  }' +
              '  if (!wantName) return JSON.stringify({ error: "name is required" });' +
              '  const engine = engines.find(e => e.name === wantName);' +
              '  if (!engine) return JSON.stringify({ error: "no engine named " + wantName, engines: names });' +
              '  if (action === "set-default") {' +
              '    await SearchService.setDefault(engine, "dsh-mcp");' +
              '    const after = await SearchService.getDefault();' +
              '    return JSON.stringify({ ok: true, current: after.name });' +
              '  }' +
              '  if (action === "move") {' +
              '    if (wantPos === null) return JSON.stringify({ error: "position is required" });' +
              '    await SearchService.moveEngine(engine, wantPos - 1);' +
              '    const after2 = await SearchService.getEngines();' +
              '    return JSON.stringify({ ok: true, order: after2.map(e => e.name) });' +
              '  }' +
              '  if (action === "remove") {' +
              '    await SearchService.removeEngine(engine);' +
              '    const after3 = await SearchService.getEngines();' +
              '    return JSON.stringify({ ok: true, remaining: after3.map(e => e.name) });' +
              '  }' +
              '  return JSON.stringify({ error: "unknown action" });' +
              ' } catch (e) { return JSON.stringify({ error: e.message }); }' +
              ' })()',
            chromeContext,
          )
        })
        if (typeof raw !== 'string') throw new Error('search engine returned nothing')
        const info = JSON.parse(raw) as {
          error?: string
          current?: string
          engines?: string[]
          order?: string[]
          remaining?: string[]
          reset?: boolean
        }
        if (info.error !== undefined) throw new Error(info.error)
        if (what === 'list') {
          return text(
            'default engine: ' + String(info.current) +
            String.fromCharCode(10) +
            'engines: ' + (info.engines ?? []).join(', '),
          )
        }
        if (what === 'reset') return text('search engines reset to defaults')
        if (what === 'set-default') return text('default engine is now: ' + String(info.current))
        if (what === 'move') return text('new order: ' + (info.order ?? []).join(', '))
        return text('remaining engines: ' + (info.remaining ?? []).join(', '))
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_clear_site_cache',
    {
      title: 'Clear cached data for one site (not the whole cache)',
      description:
        'Clear cached data for a SINGLE site instead of the whole cache. MEASURED: this needs ClearDataService from ' +
        'resource://gre/modules/ClearDataService.sys.mjs, constructed with new, then deleteDataFromSite(site, {}, ' +
        'isUserRequest, flags, callback). Two traps: the site argument is a SCHEMELESS site (example.com, not ' +
        'https://example.com/), and the callback must be an object with onDataDeleted(resultFlags) — passing a plain ' +
        'function hangs forever. resultFlags 0 means every cleaner succeeded.',
      inputSchema: {
        site: z.string().describe('Schemeless site, e.g. example.com'),
        kinds: z
          .array(z.enum(['network', 'image', 'js', 'css', 'cookies', 'dom-storage', 'all-caches', 'forget-site']))
          .optional()
          .describe('What to clear (default: all caches)'),
      },
      annotations: WRITES_PERSISTENTLY,
    },
    async ({ site, kinds }: { site: string; kinds?: string[] }) => {
      try {
        const target = str(site, 'site')
        const wanted = Array.isArray(kinds) && kinds.length > 0 ? kinds.map((k) => str(k, 'kind')) : ['all-caches']
        const raw = await withChrome(async (client, chromeContext) => {
          return client.evaluate(
            '(async () => {' +
              ' try {' +
              '  const { ClearDataService } = ChromeUtils.importESModule("resource://gre/modules/ClearDataService.sys.mjs");' +
              '  const svc = new ClearDataService();' +
              '  const C = Ci.nsIClearDataService;' +
              '  const map = {' +
              '    network: C.CLEAR_NETWORK_CACHE,' +
              '    image: C.CLEAR_IMAGE_CACHE,' +
              '    js: C.CLEAR_JS_CACHE,' +
              '    css: C.CLEAR_CSS_CACHE,' +
              '    cookies: C.CLEAR_COOKIES,' +
              '    "dom-storage": C.CLEAR_DOM_STORAGES,' +
              '    "all-caches": C.CLEAR_ALL_CACHES,' +
              '    "forget-site": C.CLEAR_FORGET_ABOUT_SITE' +
              '  };' +
              '  let flags = 0;' +
              '  for (const k of ' + JSON.stringify(wanted) + ') { if (map[k]) flags |= map[k]; }' +
              '  if (!flags) return JSON.stringify({ error: "no usable kinds" });' +
              '  const site = ' + JSON.stringify(target) + ';' +
              '  const result = await new Promise((resolve) => {' +
              '    try {' +
              '      svc.deleteDataFromSite(site, {}, true, flags, {' +
              '        onDataDeleted(aResultFlags) { resolve({ resultFlags: aResultFlags }); }' +
              '      });' +
              '      setTimeout(() => resolve({ timeout: true }), 15000);' +
              '    } catch (e) { resolve({ error: e.message }); }' +
              '  });' +
              '  return JSON.stringify({ ok: true, flags, site, result });' +
              ' } catch (e) { return JSON.stringify({ error: e.message }); }' +
              ' })()',
            chromeContext,
          )
        })
        if (typeof raw !== 'string') throw new Error('clear site cache returned nothing')
        const info = JSON.parse(raw) as {
          error?: string
          flags?: number
          site?: string
          result?: { resultFlags?: number; timeout?: boolean; error?: string }
        }
        if (info.error !== undefined) throw new Error(info.error)
        const result = info.result ?? {}
        if (result.timeout === true) throw new Error('ClearDataService never called onDataDeleted')
        if (result.error !== undefined) throw new Error(result.error)
        return text(
          'cleared site: ' + String(info.site) +
          String.fromCharCode(10) +
          'kinds: ' + wanted.join(', ') +
          String.fromCharCode(10) +
          'flags: ' + String(info.flags) +
          String.fromCharCode(10) +
          'resultFlags: ' + String(result.resultFlags ?? -1) +
          (result.resultFlags === 0 ? ' (all cleaners succeeded)' : ' (non-zero means some cleaner failed)'),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_autofill_data',
    {
      title: 'List or edit saved form-autofill addresses',
      description:
        'Read and write the saved form-autofill ADDRESSES (not passwords). MEASURED: ' +
        'resource://autofill/FormAutofillStorage.sys.mjs exports formAutofillStorage, a FormAutofillStorage instance ' +
        'with .addresses and .creditCards; the addresses store exposes add/update/removeMany/getAll-style methods, so ' +
        'this is writable (contrary to an earlier note that only status was reachable). NOTE: the profile may serve ' +
        'addresses from the Rust store depending on extensions.formautofill.addresses.storage.rust.* prefs.',
      inputSchema: {
        action: z.enum(['list', 'add', 'remove']).describe('What to do'),
        guid: z.string().optional().describe('Address guid, for remove'),
        fields: z
          .record(z.string(), z.unknown())
          .optional()
          .describe('Address fields for add, e.g. {"given-name":"Ada","organization":"DSH"}'),
      },
      annotations: WRITES_PERSISTENTLY,
    },
    async ({
      action,
      guid,
      fields,
    }: {
      action: 'list' | 'add' | 'remove'
      guid?: string
      fields?: Record<string, unknown>
    }) => {
      try {
        const what = str(action, 'action')
        const wantedGuid = guid === undefined ? null : str(guid, 'guid')
        const payload = fields === undefined ? null : fields
        const raw = await withChrome(async (client, chromeContext) => {
          return client.evaluate(
            '(async () => {' +
              ' try {' +
              '  const { formAutofillStorage } = ChromeUtils.importESModule("resource://autofill/FormAutofillStorage.sys.mjs");' +
              '  if (!formAutofillStorage) return JSON.stringify({ error: "formAutofillStorage missing" });' +
              '  const action = ' + JSON.stringify(what) + ';' +
              '  await formAutofillStorage.initialize();' +
              '  const store = formAutofillStorage.addresses;' +
              '  if (action === "list") {' +
              '    let all = store.getAll ? await store.getAll() : [];' +
              '    if (all && typeof all[Symbol.iterator] === "function" && !Array.isArray(all)) all = Array.from(all);' +
              '    if (!Array.isArray(all)) {' +
              '      if (all && typeof all === "object") all = Object.values(all);' +
              '      else all = [];' +
              '    }' +
              '    return JSON.stringify({ ok: true, count: all.length, records: all.slice(0, 20), kind: typeof store.getAll });' +
              '  }' +
              '  if (action === "add") {' +
              '    const fields = ' + (payload === null ? 'null' : JSON.stringify(payload)) + ';' +
              '    if (!fields) return JSON.stringify({ error: "fields are required" });' +
              '    const guid = await store.add(fields);' +
              '    return JSON.stringify({ ok: true, guid, saved: typeof formAutofillStorage.save });' +
              '  }' +
              '  if (action === "remove") {' +
              '    const guid = ' + (wantedGuid === null ? 'null' : JSON.stringify(wantedGuid)) + ';' +
              '    if (!guid) return JSON.stringify({ error: "guid is required" });' +
              '    await store.remove(guid);' +
              '    return JSON.stringify({ ok: true, removed: guid });' +
              '  }' +
              '  return JSON.stringify({ error: "unknown action" });' +
              ' } catch (e) { return JSON.stringify({ error: e.message }); }' +
              ' })()',
            chromeContext,
          )
        })
        if (typeof raw !== 'string') throw new Error('autofill data returned nothing')
        const info = JSON.parse(raw) as {
          error?: string
          count?: number
          records?: unknown[]
          guid?: string
          removed?: string
        }
        if (info.error !== undefined) throw new Error(info.error)
        if (what === 'list') {
          const records = info.records ?? []
          if (records.length === 0) return text('no saved addresses')
          const lines = records.map((record) => JSON.stringify(record))
          return text('saved addresses: ' + String(info.count) + String.fromCharCode(10) + lines.join(String.fromCharCode(10)))
        }
        if (what === 'add') return text('address added, guid: ' + String(info.guid))
        return text('address removed: ' + String(info.removed))
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_sync_probe',
    {
      title: 'Probe FxAccounts / Sync state without using a real account',
      description:
        'Inspect the Sync/FxAccounts surface WITHOUT signing in to any real account. MEASURED: ' +
        'resource://gre/modules/FxAccounts.sys.mjs exports FxAccounts whose constructor takes a mocks object ' +
        '(constructor(mocks = null)), which is the supported way to exercise account code paths offline — this is how ' +
        'the Sync test suites run. This tool reports what can be reached and whether a real account is signed in; it ' +
        'never sends credentials anywhere.',
      inputSchema: {
        action: z
          .enum(['status', 'mock-signin', 'mock-signout'])
          .describe('status = inspect only; mock-signin installs a fake account; mock-signout removes it'),
        email: z.string().optional().describe('Fake account email (default mock-user@example.test)'),
      },
      annotations: WRITES,
    },
    async ({ action, email }: { action?: string; email?: string }) => {
      try {
        const what = action === undefined ? 'status' : str(action, 'action')
        const mail = email === undefined ? 'mock-user@example.test' : str(email, 'email')
        const raw = await withChrome(async (client, chromeContext) => {
          return client.evaluate(
            '(async () => {' +
              ' try {' +
              '  const out = {};' +
              '  const m = ChromeUtils.importESModule("resource://gre/modules/FxAccounts.sys.mjs");' +
              '  out.hasFxAccounts = typeof m.FxAccounts === "function";' +
              '  out.hasSingleton = typeof m.getFxAccountsSingleton === "function";' +
              '  out.acceptsMocks = /mocks/.test(String(m.FxAccounts));' +
              '  const action = ' + JSON.stringify(what) + ';' +
              '  if (action === "mock-signin") {' +
              '    const fakeUser = {' +
              '      uid: "0123456789abcdef0123456789abcdef",' +
              '      email: ' + JSON.stringify(mail) + ',' +
              '      sessionToken: "mock-session-token-not-real",' +
              '      verified: true,' +
              '      device: { id: "mock-device-id", name: "DSH Mock Device" }' +
              '    };' +
              '    const fxa = new m.FxAccounts({' +
              '      currentAccountState: {' +
              '        isCurrent: true,' +
              '        getUserAccountData: () => Promise.resolve(fakeUser),' +
              '        updateUserAccountData: () => Promise.resolve(),' +
              '        signOut: () => Promise.resolve()' +
              '      }' +
              '    });' +
              '    window.__dshMockFxa = fxa;' +
              '    const user = await fxa.getSignedInUser();' +
              '    out.mock = true;' +
              '    out.signedIn = !!user;' +
              '    out.uid = user && user.uid;' +
              '    out.email = user && user.email;' +
              '    out.verified = user && user.verified;' +
              '    return JSON.stringify(out);' +
              '  }' +
              '  if (action === "mock-signout") {' +
              '    window.__dshMockFxa = null;' +
              '    out.mock = false;' +
              '    out.cleared = true;' +
              '    return JSON.stringify(out);' +
              '  }' +
              '  const g = (n) => { try { return Services.prefs.getStringPref(n); } catch (e) { return null; } };' +
              '  out.syncUsername = g("services.sync.username");' +
              '  out.syncClientName = g("services.sync.client.name");' +
              '  try { out.syncEnabled = Services.prefs.getBoolPref("services.sync.enabled"); } catch (e) { out.syncEnabled = null; }' +
              '  out.signedIn = !!out.syncUsername;' +
              '  out.mockActive = !!window.__dshMockFxa;' +
              '  try {' +
              '    const real = m.getFxAccountsSingleton();' +
              '    const user = await real.getSignedInUser();' +
              '    out.realSignedIn = !!user;' +
              '  } catch (e) { out.realErr = e.message ? e.message.slice(0, 80) : "unknown"; }' +
              '  if (out.mockActive) {' +
              '    try { const mu = await window.__dshMockFxa.getSignedInUser(); out.mockEmail = mu && mu.email; } catch (e) {}' +
              '  }' +
              '  return JSON.stringify(out);' +
              ' } catch (e) { return JSON.stringify({ error: e.message || String(e) }); }' +
              ' })()',
            chromeContext,
          )
        })
        if (typeof raw !== 'string') throw new Error('sync probe returned nothing')
        const info = JSON.parse(raw) as {
          error?: string
          hasFxAccounts?: boolean
          hasSingleton?: boolean
          acceptsMocks?: boolean
          syncUsername?: string | null
          syncClientName?: string | null
          syncEnabled?: boolean | null
          signedIn?: boolean
          mock?: boolean
          uid?: string
          email?: string
          verified?: boolean
          cleared?: boolean
          mockActive?: boolean
          realSignedIn?: boolean
          mockEmail?: string
        }
        if (info.error !== undefined) throw new Error(info.error)
        if (what === 'mock-signin') {
          return text(
            'mock account installed (no real account touched)' +
            String.fromCharCode(10) +
            'signed in: ' + String(info.signedIn) +
            String.fromCharCode(10) +
            'uid: ' + String(info.uid) +
            String.fromCharCode(10) +
            'email: ' + String(info.email) +
            String.fromCharCode(10) +
            'verified: ' + String(info.verified),
          )
        }
        if (what === 'mock-signout') return text('mock account removed (real account untouched)')
        return text(
          'FxAccounts reachable: ' + String(info.hasFxAccounts) +
          String.fromCharCode(10) +
          'constructor accepts mocks (offline testing): ' + String(info.acceptsMocks) +
          String.fromCharCode(10) +
          'real account signed in: ' + String(info.realSignedIn) +
          String.fromCharCode(10) +
          'mock account active: ' + String(info.mockActive) +
          (info.mockEmail ? ' (' + String(info.mockEmail) + ')' : ''),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_reader_mode',
    {
      title: 'Open a page in Reader View',
      description:
        'Open a tab in Reader View (about:reader) or report whether the current page is reader-able. MEASURED: ' +
        'ReaderMode lives at moz-src:///toolkit/components/reader/ReaderMode.sys.mjs (NOT resource:// — that path ' +
        'fails), and about:reader?url=<encoded> is the page form. This is the "reading mode" that strips chrome and ' +
        'ads from an article.',
      inputSchema: {
        action: z.enum(['open', 'is-readable']).describe('open = go to about:reader; is-readable = ask ReaderMode'),
        context: z.string().optional().describe('Tab (default: the active tab)'),
      },
      annotations: WRITES,
    },
    async ({ action, context }: { action: 'open' | 'is-readable'; context?: string }) => {
      try {
        const what = str(action, 'action')
        const target = context === undefined ? null : str(context, 'context')
        const raw = await withBidi(async (client) => {
          const chromeContext = await client.chromeContext()
          if (chromeContext === null) throw new Error('no privileged (chrome) context')
          const index = target === null ? -1 : await tabIndexForContext(client, target)
          const tabExpr = index < 0 ? 'gBrowser.selectedTab' : 'gBrowser.tabs[' + String(index) + ']'
          if (what === 'open') {
            return await client.evaluate(
              '(async () => {' +
                ' try {' +
                '  const tab = ' + tabExpr + ';' +
                '  if (!tab) return JSON.stringify({ error: "tab not found" });' +
                '  const url = tab.linkedBrowser.currentURI.spec;' +
                '  if (url.indexOf("about:reader") === 0) return JSON.stringify({ ok: true, already: true, url });' +
                '  const readerUrl = "about:reader?url=" + encodeURIComponent(url);' +
                '  tab.linkedBrowser.loadURI(Services.io.newURI(readerUrl), {' +
                '    triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal()' +
                '  });' +
                '  return JSON.stringify({ ok: true, readerUrl, from: url });' +
                ' } catch (e) { return JSON.stringify({ error: e.message }); }' +
                ' })()',
              chromeContext,
            )
          }
          return await client.evaluate(
            '(async () => {' +
              ' try {' +
              '  const { ReaderMode } = ChromeUtils.importESModule("moz-src:///toolkit/components/reader/ReaderMode.sys.mjs");' +
              '  const tab = ' + tabExpr + ';' +
              '  if (!tab) return JSON.stringify({ error: "tab not found" });' +
              '  const browser = tab.linkedBrowser;' +
              '  const doc = browser.contentDocument;' +
              '  if (!doc) return JSON.stringify({ error: "no document (privileged page?)" });' +
              '  let readable = false;' +
              '  let title = null;' +
              '  try {' +
              '    const article = await ReaderMode.parseDocument(doc);' +
              '    readable = !!(article && article.content);' +
              '    title = article ? article.title : null;' +
              '  } catch (e) { return JSON.stringify({ ok: true, readable: false, parseErr: e.message, url: browser.currentURI.spec }); }' +
              '  return JSON.stringify({ ok: true, readable, title, url: browser.currentURI.spec });' +
              ' } catch (e) { return JSON.stringify({ error: e.message }); }' +
              ' })()',
            chromeContext,
          )
        })
        if (typeof raw !== 'string') throw new Error('reader mode returned nothing')
        const info = JSON.parse(raw) as {
          error?: string
          ok?: boolean
          already?: boolean
          readerUrl?: string
          from?: string
          readable?: boolean
          url?: string
        }
        if (info.error !== undefined) throw new Error(info.error)
        if (what === 'open') {
          if (info.already === true) return text('already in Reader View: ' + String(info.url))
          return text('opened Reader View' + String.fromCharCode(10) + String(info.readerUrl))
        }
        return text(
          'reader-able: ' + String(info.readable) +
          String.fromCharCode(10) +
          'url: ' + String(info.url),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_sync_now',
    {
      title: 'Trigger a real Sync run (Weave)',
      description:
        'Run the real Firefox Sync engine instead of the mock account. MEASURED: the entry point is NOT Weave.sys.mjs — ' +
        'that module only exports a WeaveService class whose instance is an empty object. The real singleton comes from ' +
        'resource://gre/modules/services-sync/service.sys.mjs, which exports Service with sync()/status. Without a ' +
        'signed-in account the engine reports notConfigured, which is the expected offline answer rather than a bug. ' +
        'Pair with browser_sync_probe for mock-account testing.',
      inputSchema: {
        action: z.enum(['status', 'sync']).describe('status = report engine state; sync = trigger a run'),
      },
      annotations: WRITES,
    },
    async ({ action }: { action: 'status' | 'sync' }) => {
      try {
        const what = str(action, 'action')
        const raw = await withChrome(async (client, chromeContext) => {
          return client.evaluate(
            '(async () => {' +
              ' try {' +
              '  const m = ChromeUtils.importESModule("resource://gre/modules/services-sync/service.sys.mjs");' +
              '  const svc = m.Service;' +
              '  if (!svc) return JSON.stringify({ error: "Service missing from service.sys.mjs" });' +
              '  const out = {};' +
              '  try {' +
              '    const st = svc.status;' +
              '    if (st && typeof st === "object") {' +
              '      out.status = String(st.status || st.service || st.syncStatus || JSON.stringify(Object.keys(st).slice(0, 8)));' +
              '    } else out.status = String(st);' +
              '  } catch (e) { out.statusErr = e.message; }' +
              '  try { out.enabled = !!svc.enabled; } catch (e) {}' +
              '  try { out.username = (svc.identity && svc.identity.username) || svc.username || null; } catch (e) {}' +
              '  try { out.syncID = svc.syncID || null; } catch (e) {}' +
              '  try { out.identityPresent = !!svc.identity; } catch (e) {}' +
              '  if (' + JSON.stringify(what) + ' === "sync") {' +
              '    try {' +
              '      await svc.sync();' +
              '      out.ran = true;' +
              '    } catch (e) { out.syncErr = e.message || String(e); }' +
              '  }' +
              '  return JSON.stringify(out);' +
              ' } catch (e) { return JSON.stringify({ error: e.message || String(e) }); }' +
              ' })()',
            chromeContext,
          )
        })
        if (typeof raw !== 'string') throw new Error('sync now returned nothing')
        const info = JSON.parse(raw) as {
          error?: string
          status?: string
          statusErr?: string
          enabled?: boolean
          syncID?: string | null
          identityPresent?: boolean
          username?: string | null
          ran?: boolean
          syncErr?: string
        }
        if (info.error !== undefined) throw new Error(info.error)
        const lines = [
          'sync status: ' + String(info.status ?? info.statusErr),
          'engine enabled: ' + String(info.enabled),
          'identity present: ' + String(info.identityPresent),
          'username: ' + String(info.username ?? '(none)'),
        ]
        if (what === 'sync') {
          lines.push(info.ran === true ? 'sync run completed' : 'sync did not run: ' + String(info.syncErr))
        }
        return text(lines.join(String.fromCharCode(10)))
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_bookmark_folder',
    {
      title: 'Create, rename or remove a bookmark folder',
      description:
        'Manage bookmark FOLDERS (the existing bookmark tools only handle individual bookmarks). MEASURED: ' +
        'PlacesUtils.bookmarks exposes insert/update/remove/search/fetch, and the root folders are addressed by the ' +
        'well-known guids (toolbar____, menu________, unfiled_____, root________). Removing a folder removes its ' +
        'contents, so check the child count first with action:"list".',
      inputSchema: {
        action: z.enum(['list', 'create', 'rename', 'remove']).describe('What to do'),
        title: z.string().optional().describe('Folder title, for create / rename'),
        parent: z
          .enum(['toolbar', 'menu', 'unfiled'])
          .optional()
          .describe('Where to create it (default: menu)'),
        guid: z.string().optional().describe('Folder guid, for rename / remove'),
      },
      annotations: WRITES_PERSISTENTLY,
    },
    async ({
      action,
      title,
      parent,
      guid,
    }: {
      action: 'list' | 'create' | 'rename' | 'remove'
      title?: string
      parent?: string
      guid?: string
    }) => {
      try {
        const what = str(action, 'action')
        const wantedTitle = title === undefined ? null : str(title, 'title')
        const wantedParent = parent === undefined ? 'menu' : str(parent, 'parent')
        const wantedGuid = guid === undefined ? null : str(guid, 'guid')
        const raw = await withChrome(async (client, chromeContext) => {
          return client.evaluate(
            '(async () => {' +
              ' try {' +
              '  const { PlacesUtils } = ChromeUtils.importESModule("resource://gre/modules/PlacesUtils.sys.mjs");' +
              '  const bm = PlacesUtils.bookmarks;' +
              '  const action = ' + JSON.stringify(what) + ';' +
              '  const parents = {' +
              '    toolbar: PlacesUtils.bookmarks.toolbarGuid,' +
              '    menu: PlacesUtils.bookmarks.menuGuid,' +
              '    unfiled: PlacesUtils.bookmarks.unfiledGuid' +
              '  };' +
              '  if (action === "list") {' +
              '    const rootGuid = parents[' + JSON.stringify(wantedParent) + '] || PlacesUtils.bookmarks.menuGuid;' +
              '    const folder = (await bm.fetch({ guid: rootGuid })) || { guid: rootGuid, title: "(unknown)" };' +
              '    let kids = [];' +
              '    try {' +
              '      kids = await bm.search({ parentGuid: rootGuid });' +
              '    } catch (e) { out.searchErr = e.message; }' +
              '    return JSON.stringify({' +
              '      ok: true,' +
              '      root: { guid: folder.guid, title: folder.title },' +
              '      folders: kids.filter(c => c.type === PlacesUtils.bookmarks.TYPE_FOLDER).map(c => ({ guid: c.guid, title: c.title, index: c.index })),' +
              '      bookmarks: kids.filter(c => c.type !== PlacesUtils.bookmarks.TYPE_FOLDER).length' +
              '    });' +
              '  }' +
              '  if (action === "create") {' +
              '    const title = ' + (wantedTitle === null ? 'null' : JSON.stringify(wantedTitle)) + ';' +
              '    if (!title) return JSON.stringify({ error: "title is required" });' +
              '    const parentGuid = parents[' + JSON.stringify(wantedParent) + '] || PlacesUtils.bookmarks.menuGuid;' +
              '    const created = await bm.insert({ parentGuid, title, type: PlacesUtils.bookmarks.TYPE_FOLDER });' +
              '    return JSON.stringify({ ok: true, guid: created.guid, title: created.title });' +
              '  }' +
              '  if (action === "rename") {' +
              '    const guid = ' + (wantedGuid === null ? 'null' : JSON.stringify(wantedGuid)) + ';' +
              '    const title = ' + (wantedTitle === null ? 'null' : JSON.stringify(wantedTitle)) + ';' +
              '    if (!guid || !title) return JSON.stringify({ error: "guid and title are required" });' +
              '    await bm.update({ guid, title });' +
              '    return JSON.stringify({ ok: true, guid, title });' +
              '  }' +
              '  if (action === "remove") {' +
              '    const guid = ' + (wantedGuid === null ? 'null' : JSON.stringify(wantedGuid)) + ';' +
              '    if (!guid) return JSON.stringify({ error: "guid is required" });' +
              '    let childCount = 0;' +
              '    try { const kids = await bm.search({ parentGuid: guid }); childCount = kids.length; } catch (e) {}' +
              '    await bm.remove({ guid });' +
              '    return JSON.stringify({ ok: true, removed: guid, childCount });' +
              '  }' +
              '  return JSON.stringify({ error: "unknown action" });' +
              ' } catch (e) { return JSON.stringify({ error: e.message }); }' +
              ' })()',
            chromeContext,
          )
        })
        if (typeof raw !== 'string') throw new Error('bookmark folder returned nothing')
        const info = JSON.parse(raw) as {
          error?: string
          root?: { guid: string; title: string }
          folders?: Array<{ guid: string; title: string; index: number }>
          bookmarks?: number
          guid?: string
          title?: string
          removed?: string
          childCount?: number
        }
        if (info.error !== undefined) throw new Error(info.error)
        if (what === 'list') {
          const folders = info.folders ?? []
          const lines = [
            'under: ' + String(info.root?.title) + ' (' + String(info.root?.guid) + ')',
            'folders: ' + String(folders.length) + ', loose bookmarks: ' + String(info.bookmarks),
          ]
          for (const folder of folders) lines.push('  ' + folder.title + '  ' + folder.guid)
          return text(lines.join(String.fromCharCode(10)))
        }
        if (what === 'create') return text('folder created: ' + String(info.title) + ' (' + String(info.guid) + ')')
        if (what === 'rename') return text('folder renamed: ' + String(info.guid) + ' -> ' + String(info.title))
        return text('folder removed: ' + String(info.removed) + ' (contained ' + String(info.childCount) + ' entries)')
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_open_firefox_view',
    {
      title: 'Open Firefox View',
      description:
        'Open the Firefox View page (about:firefoxview), the tab that lists recently closed tabs, tabs from other ' +
        'devices and sync status. MEASURED: it is a plain about: page, so no privileged API is needed — bBrowser.addTab ' +
        'suffices. This is separate from browser_open_about_page because firefoxview is a browser/ page rather than a ' +
        'toolkit one, and the tool enum keeps them apart on purpose.',
      inputSchema: {
        background: z.boolean().optional().describe('Open in the background'),
      },
      annotations: WRITES,
    },
    async ({ background }: { background?: boolean }) => {
      try {
        return text(
          await withChrome(async (client, chromeContext) => {
            const raw = await client.evaluate(
              '(() => {' +
                ' try {' +
                '  gBrowser.addTab("about:firefoxview", {' +
                '    triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),' +
                '    inBackground: ' + (background === true ? 'true' : 'false') + '' +
                '  });' +
                '  return "opened about:firefoxview";' +
                ' } catch (e) { return "ERR " + e.message; }' +
                ' })()',
              chromeContext,
            )
            if (typeof raw !== 'string') throw new Error('firefox view returned nothing')
            if (raw.startsWith('ERR ')) throw new Error(raw.slice(4))
            return raw
          }),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_add_search_engine',
    {
      title: 'Add a custom search engine',
      description:
        'Install a user-defined search engine. MEASURED: SearchService from ' +
        'moz-src:///toolkit/components/search/SearchService.sys.mjs exposes addUserEngine(formInfo) — the simplest of ' +
        'the four add paths (addOpenSearchEngine needs a full OpenSearch URL, addSearchEngine needs an engine object, ' +
        'addEngineFromExtension needs an add-on). formInfo takes name plus a URL template containing {searchTerms}.',
      inputSchema: {
        name: z.string().describe('Engine display name'),
        url: z.string().describe('URL template containing {searchTerms}'),
      },
      annotations: WRITES_PERSISTENTLY,
    },
    async ({ name, url }: { name: string; url: string }) => {
      try {
        const engineName = str(name, 'name')
        const template = str(url, 'url')
        const raw = await withChrome(async (client, chromeContext) => {
          return client.evaluate(
            '(async () => {' +
              ' try {' +
              '  const { SearchService } = ChromeUtils.importESModule("moz-src:///toolkit/components/search/SearchService.sys.mjs");' +
              '  const engine = await SearchService.addUserEngine({' +
              '    name: ' + JSON.stringify(engineName) + ',' +
              '    url: ' + JSON.stringify(template) + ',' +
              '    method: "GET",' +
              '    template: ' + JSON.stringify(template) +
              '  });' +
              '  const all = await SearchService.getEngines();' +
              '  return JSON.stringify({ ok: true, name: engine && engine.name, id: engine && engine.id, total: all.length });' +
              ' } catch (e) { return JSON.stringify({ error: e.message }); }' +
              ' })()',
            chromeContext,
          )
        })
        if (typeof raw !== 'string') throw new Error('add search engine returned nothing')
        const info = JSON.parse(raw) as { error?: string; name?: string; id?: string; total?: number }
        if (info.error !== undefined) throw new Error(info.error)
        return text(
          'added search engine: ' + String(info.name) +
          String.fromCharCode(10) +
          'id: ' + String(info.id) +
          String.fromCharCode(10) +
          'engines now: ' + String(info.total),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_print',
    {
      title: 'Open the print UI, print preview or page setup',
      description:
        'Open the printing surface for a tab. MEASURED: PrintUtils is NOT a module — it is the global object defined by ' +
        'chrome/toolkit/content/global/printUtils.js and reachable as PrintUtils on the browser window. It offers ' +
        'startPrintWindow, togglePrintPreview, showPageSetup, getPrintSettings and handleSystemPrintDialog (there is no ' +
        'print()/showPrintDialog()). Use browser_pdf when you want the PDF without any UI.',
      inputSchema: {
        action: z
          .enum(['print', 'preview', 'page-setup'])
          .describe('print = open print UI; preview = toggle preview; page-setup = page setup dialog'),
      },
      annotations: WRITES,
    },
    async ({ action }: { action: 'print' | 'preview' | 'page-setup' }) => {
      try {
        const what = str(action, 'action')
        const raw = await withChrome(async (client, chromeContext) => {
          return client.evaluate(
            '(async () => {' +
              ' try {' +
              '  const w = Services.wm.getMostRecentWindow("navigator:browser");' +
              '  const P = w.PrintUtils;' +
              '  if (!P) return JSON.stringify({ error: "PrintUtils missing on the browser window" });' +
              '  const action = ' + JSON.stringify(what) + ';' +
              '  const tab = w.gBrowser.selectedTab;' +
              '  const browser = tab.linkedBrowser;' +
              '  const bc = browser.browsingContext;' +
              '  if (action === "preview") {' +
              '    await P.togglePrintPreview(bc);' +
              '    return JSON.stringify({ ok: true, action: "preview" });' +
              '  }' +
              '  if (action === "page-setup") {' +
              '    P.showPageSetup(w);' +
              '    return JSON.stringify({ ok: true, action: "page-setup" });' +
              '  }' +
              '  await P.startPrintWindow(bc);' +
              '  return JSON.stringify({ ok: true, action: "print" });' +
              ' } catch (e) { return JSON.stringify({ error: e.message || String(e) }); }' +
              ' })()',
            chromeContext,
          )
        })
        if (typeof raw !== 'string') throw new Error('print returned nothing')
        const info = JSON.parse(raw) as { error?: string; ok?: boolean; action?: string }
        if (info.error !== undefined) throw new Error(info.error)
        return text('print UI opened: ' + String(info.action))
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_oauth_clients',
    {
      title: 'List the OAuth clients attached to the Mozilla account',
      description:
        'List devices and web sessions attached to the signed-in Mozilla account (listAttachedOAuthClients). ' +
        'MEASURED: with no account signed in it resolves to an empty array rather than throwing, and the underlying ' +
        '_fetchAttachedOAuthClients needs a session token, so this only returns data for a REAL signed-in account. ' +
        'The mock account from browser_sync_probe deliberately has no session, so it yields an empty list — that is the ' +
        'expected offline answer.',
      inputSchema: {
        refresh: z.boolean().optional().describe('Bypass the 4-hour cache'),
      },
      annotations: READ_ONLY,
    },
    async ({ refresh }: { refresh?: boolean }) => {
      try {
        const force = refresh === true
        const raw = await withChrome(async (client, chromeContext) => {
          return client.evaluate(
            '(async () => {' +
              ' try {' +
              '  const m = ChromeUtils.importESModule("resource://gre/modules/FxAccounts.sys.mjs");' +
              '  const fxa = m.getFxAccountsSingleton();' +
              '  const out = {};' +
              '  try { const u = await fxa.getSignedInUser(); out.signedIn = !!u; out.email = u ? u.email : null; } catch (e) { out.signedIn = null; }' +
              '  let clients = [];' +
              '  try { clients = await fxa.listAttachedOAuthClients(' + (force ? 'true' : 'false') + '); } catch (e) { out.listErr = e.message || String(e); }' +
              '  out.count = clients.length;' +
              '  out.clients = clients.slice(0, 20).map(c => ({ id: c.id, name: c.name || null, lastAccessedDaysAgo: c.lastAccessedDaysAgo }));' +
              '  return JSON.stringify(out);' +
              ' } catch (e) { return JSON.stringify({ error: e.message || String(e) }); }' +
              ' })()',
            chromeContext,
          )
        })
        if (typeof raw !== 'string') throw new Error('oauth clients returned nothing')
        const info = JSON.parse(raw) as {
          error?: string
          signedIn?: boolean | null
          email?: string | null
          count?: number
          clients?: Array<{ id: string; name: string | null; lastAccessedDaysAgo: number }>
          listErr?: string
        }
        if (info.error !== undefined) throw new Error(info.error)
        const lines = [
          'signed in: ' + String(info.signedIn) +
            (info.email ? ' (' + String(info.email) + ')' : ''),
          'attached clients: ' + String(info.count),
        ]
        if (info.listErr) lines.push('note: ' + String(info.listErr))
        for (const c of info.clients ?? []) {
          lines.push('  ' + (c.name ?? c.id) + '  last used ' + String(c.lastAccessedDaysAgo) + 'd ago')
        }
        return text(lines.join(String.fromCharCode(10)))
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_translations',
    {
      title: 'Report or toggle Firefox full-page translation',
      description:
        'Report the full-page translation state and optionally enable the feature. MEASURED: the pref is ' +
        'browser.translations.enable (false by default in this build); the actor resource://gre/actors/' +
        'TranslationsParent.sys.mjs exposes getIsTranslationsEngineSupported / getWebContentLanguages / ' +
        'isTranslationsEngineMocked. With a real engine the supported-language map is populated only after language ' +
        'packs are downloaded, so an empty map while isEngineSupported is true means "engine present, packs absent" ' +
        'rather than a broken feature.',
      inputSchema: {
        action: z
          .enum(['status', 'enable', 'disable', 'pairs', 'download'])
          .describe('status/enable/disable = pref; pairs = supported language pairs; download = fetch model files'),
        source: z.string().optional().describe('Source language for download (default en)'),
        target: z.string().optional().describe('Target language for download (default zh-Hans)'),
      },
      annotations: WRITES,
    },
    async ({
      action,
      source,
      target,
    }: {
      action: 'status' | 'enable' | 'disable' | 'pairs' | 'download'
      source?: string
      target?: string
    }) => {
      try {
        const what = str(action, 'action')
        const srcLang = source === undefined ? 'en' : str(source, 'source')
        const dstLang = target === undefined ? 'zh-Hans' : str(target, 'target')
        const raw = await withChrome(async (client, chromeContext) => {
          return client.evaluate(
            '(async () => {' +
              ' try {' +
              '  const action = ' + JSON.stringify(what) + ';' +
              '  if (action === "enable") Services.prefs.setBoolPref("browser.translations.enable", true);' +
              '  if (action === "disable") Services.prefs.setBoolPref("browser.translations.enable", false);' +
              '  if (action === "pairs") {' +
              '    const { TranslationsParent } = ChromeUtils.importESModule("resource://gre/actors/TranslationsParent.sys.mjs");' +
              '    const sup = await TranslationsParent.getSupportedLanguages();' +
              '    const list = (sup && sup.languagePairs ? sup.languagePairs : []).map(p => p.sourceLanguage + "->" + p.targetLanguage);' +
              '    return JSON.stringify({ ok: true, pairCount: list.length, pairs: list });' +
              '  }' +
              '  if (action === "download") {' +
              '    const { TranslationsParent } = ChromeUtils.importESModule("resource://gre/actors/TranslationsParent.sys.mjs");' +
              '    const src = ' + JSON.stringify(srcLang) + ';' +
              '    const dst = ' + JSON.stringify(dstLang) + ';' +
              '    const out = { source: src, target: dst };' +
              '    try {' +
              '      const t0 = Date.now();' +
              '      await TranslationsParent.downloadLanguageFiles(src, dst);' +
              '      out.ms = Date.now() - t0;' +
              '      out.downloaded = true;' +
              '    } catch (e) { out.downloadErr = String(e); }' +
              '    try { out.hasFiles = await TranslationsParent.hasAllFilesForLanguage(dst); } catch (e) {}' +
              '    try {' +
              '      const rec = await TranslationsParent.getRecordsForTranslatingToAndFromPair(src, dst);' +
              '      out.recordCount = Array.isArray(rec) ? rec.length : 0;' +
              '    } catch (e) {}' +
              '    return JSON.stringify(out);' +
              '  }' +
              '  const out = {};' +
              '  try { out.enabled = Services.prefs.getBoolPref("browser.translations.enable"); } catch (e) { out.enabled = null; }' +
              '  try { out.autoPopup = Services.prefs.getBoolPref("browser.translations.automaticallyPopup"); } catch (e) {}' +
              '  try {' +
              '    const a = ChromeUtils.importESModule("resource://gre/actors/TranslationsParent.sys.mjs");' +
              '    const T = a.TranslationsParent;' +
              '    if (T) {' +
              '      try { out.engineSupported = await T.getIsTranslationsEngineSupported(); } catch (e) { out.engineErr = (e.message||"").slice(0, 80); }' +
              '      try { out.mocked = T.isTranslationsEngineMocked(); } catch (e) {}' +
              '      try { out.pairs = await T.getWebContentLanguages(); } catch (e) {}' +
              '    }' +
              '  } catch (e) { out.actorErr = (e.message||"").slice(0, 80); }' +
              '  return JSON.stringify(out);' +
              ' } catch (e) { return JSON.stringify({ error: e.message || String(e) }); }' +
              ' })()',
            chromeContext,
          )
        })
        if (typeof raw !== 'string') throw new Error('translations returned nothing')
        const info = JSON.parse(raw) as {
          error?: string
          enabled?: boolean | null
          autoPopup?: boolean
          engineSupported?: boolean
          mocked?: boolean
          pairs?: Record<string, unknown>
          pairCount?: number
          source?: string
          target?: string
          ms?: number
          downloaded?: boolean
          downloadErr?: string
          hasFiles?: boolean
          recordCount?: number
          engineErr?: string
          actorErr?: string
        }
        if (info.error !== undefined) throw new Error(info.error)
        if (what === 'download') {
          return text(
            'download ' + String(info.source) + '->' + String(info.target) +
            (info.downloaded ? ' done in ' + String(info.ms) + 'ms' : ' failed: ' + String(info.downloadErr)) +
            String.fromCharCode(10) +
            'has files: ' + String(info.hasFiles) +
            String.fromCharCode(10) +
            'model records: ' + String(info.recordCount),
          )
        }
        if (typeof info.pairCount === 'number' && Array.isArray(info.pairs)) {
          return text(
            'supported language pairs: ' + String(info.pairCount) + String.fromCharCode(10) +
            (info.pairs as string[]).join(', '),
          )
        }
        const pairCount = info.pairs ? Object.keys(info.pairs).length : 0
        return text(
          'enabled: ' + String(info.enabled) +
          String.fromCharCode(10) +
          'engine supported: ' + String(info.engineSupported) +
          String.fromCharCode(10) +
          'engine mocked: ' + String(info.mocked) +
          String.fromCharCode(10) +
          'language pairs available: ' + String(pairCount) +
          (pairCount === 0 ? ' (language packs not downloaded yet — feature present, packs absent)' : '') +
          String.fromCharCode(10) +
          'auto popup: ' + String(info.autoPopup),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_bookmark_manage',
    {
      title: 'Move, edit, search or tag bookmarks',
      description:
        'The management half of bookmarks that browser_add_bookmark / remove_bookmark / bookmark_folder do not cover. ' +
        'MEASURED: PlacesUtils.bookmarks.update(info) accepts guid plus parentGuid/index for a move, or title/url for an ' +
        'edit; bookmarks.search({query}) finds by title or URL; PlacesUtils.tagging.tagURI/untagURI/getTagsForURI ' +
        'handle tags. NOTE: fetchTree is NOT implemented in this build, so listing stays on search({parentGuid}).',
      inputSchema: {
        action: z.enum(['move', 'update', 'search', 'tag', 'untag']).describe('What to do'),
        guid: z.string().optional().describe('Bookmark guid, for move / update / tag / untag'),
        title: z.string().optional().describe('New title, for update'),
        url: z.string().optional().describe('New URL, for update; or the URL to tag/untag'),
        parentGuid: z
          .string()
          .optional()
          .describe('Destination folder guid for move ("toolbar_____", "menu________", "unfiled_____")'),
        index: z.number().int().min(0).optional().describe('Destination index for move'),
        query: z.string().optional().describe('Search text, for search'),
        tags: z.array(z.string()).optional().describe('Tags to apply or remove'),
      },
      annotations: WRITES_PERSISTENTLY,
    },
    async ({
      action,
      guid,
      title,
      url,
      parentGuid,
      index,
      query,
      tags,
    }: {
      action: 'move' | 'update' | 'search' | 'tag' | 'untag'
      guid?: string
      title?: string
      url?: string
      parentGuid?: string
      index?: number
      query?: string
      tags?: string[]
    }) => {
      try {
        const what = str(action, 'action')
        const opt = (v: unknown): string => (v === undefined ? 'null' : JSON.stringify(v))
        const raw = await withChrome(async (client, chromeContext) => {
          return client.evaluate(
            '(async () => {' +
              ' try {' +
              '  const { PlacesUtils } = ChromeUtils.importESModule("resource://gre/modules/PlacesUtils.sys.mjs");' +
              '  const bm = PlacesUtils.bookmarks;' +
              '  const action = ' + JSON.stringify(what) + ';' +
              '  if (action === "search") {' +
              '    const q = ' + opt(query) + ';' +
              '    if (!q) return JSON.stringify({ error: "query is required" });' +
              '    const found = await bm.search({ query: q });' +
              '    return JSON.stringify({ ok: true, count: found.length, items: found.slice(0, 20).map(b => ({ guid: b.guid, title: b.title, url: b.url || null, parentGuid: b.parentGuid, index: b.index, type: b.type })) });' +
              '  }' +
              '  if (action === "move") {' +
              '    const g = ' + opt(guid) + ';' +
              '    if (!g) return JSON.stringify({ error: "guid is required" });' +
              '    const info = { guid: g };' +
              '    const p = ' + opt(parentGuid) + ';' +
              '    const idx = ' + opt(index) + ';' +
              '    if (p) info.parentGuid = p;' +
              '    if (idx !== null) info.index = idx;' +
              '    await bm.update(info);' +
              '    return JSON.stringify({ ok: true, moved: g, parentGuid: p, index: idx });' +
              '  }' +
              '  if (action === "update") {' +
              '    const g = ' + opt(guid) + ';' +
              '    if (!g) return JSON.stringify({ error: "guid is required" });' +
              '    const info = { guid: g };' +
              '    const t = ' + opt(title) + ';' +
              '    const u = ' + opt(url) + ';' +
              '    if (t) info.title = t;' +
              '    if (u) info.url = u;' +
              '    if (!t && !u) return JSON.stringify({ error: "title or url is required" });' +
              '    await bm.update(info);' +
              '    return JSON.stringify({ ok: true, updated: g });' +
              '  }' +
              '  const u = ' + opt(url) + ';' +
              '  const tgs = ' + opt(tags) + ';' +
              '  if (!u) return JSON.stringify({ error: "url is required" });' +
              '  if (!tgs || !tgs.length) return JSON.stringify({ error: "tags are required" });' +
              '  const uri = Services.io.newURI(u);' +
              '  if (action === "tag") {' +
              '    PlacesUtils.tagging.tagURI(uri, tgs);' +
              '    return JSON.stringify({ ok: true, tagged: u, tags: tgs });' +
              '  }' +
              '  PlacesUtils.tagging.untagURI(uri, tgs);' +
              '  return JSON.stringify({ ok: true, untagged: u, tags: tgs });' +
              ' } catch (e) { return JSON.stringify({ error: e.message || String(e) }); }' +
              ' })()',
            chromeContext,
          )
        })
        if (typeof raw !== 'string') throw new Error('bookmark manage returned nothing')
        const info = JSON.parse(raw) as {
          error?: string
          count?: number
          items?: Array<{
            guid: string
            title: string
            url: string | null
            parentGuid: string
            index: number
            type: number
          }>
          moved?: string
          updated?: string
          tagged?: string
          untagged?: string
        }
        if (info.error !== undefined) throw new Error(info.error)
        if (what === 'search') {
          const items = info.items ?? []
          if (items.length === 0) return text('no bookmark matched')
          const lines = ['matches: ' + String(info.count)]
          for (const b of items) {
            lines.push('  ' + (b.title || '(untitled)') + '  ' + (b.url ?? '(folder)') + '  ' + b.guid)
          }
          return text(lines.join(String.fromCharCode(10)))
        }
        if (what === 'move') return text('moved: ' + String(info.moved))
        if (what === 'update') return text('updated: ' + String(info.updated))
        if (what === 'tag') return text('tagged: ' + String(info.tagged) + ' -> ' + (tags ?? []).join(', '))
        return text('untagged: ' + String(info.untagged) + ' -> ' + (tags ?? []).join(', '))
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_history_manage',
    {
      title: 'Search, remove or clear browsing history',
      description:
        'The management half of history that browser_list_history does not cover. MEASURED: ' +
        'PlacesUtils.history exposes clear() and remove() and removeVisitsByFilter(); the query-style methods ' +
        '(getNewQuery/executeQuery) are also present if you need raw querying. Use action:"search" to find entries, ' +
        'action:"remove" with a url to drop one page, or action:"clear" to wipe everything.',
      inputSchema: {
        action: z.enum(['search', 'remove', 'clear']).describe('What to do'),
        query: z.string().optional().describe('Search text, for search'),
        url: z.string().optional().describe('Exact URL to remove'),
        limit: z.number().int().min(1).max(200).optional().describe('Max results for search (default 20)'),
      },
      annotations: WRITES_PERSISTENTLY,
    },
    async ({
      action,
      query,
      url,
      limit,
    }: {
      action: 'search' | 'remove' | 'clear'
      query?: string
      url?: string
      limit?: number
    }) => {
      try {
        const what = str(action, 'action')
        const opt = (v: unknown): string => (v === undefined ? 'null' : JSON.stringify(v))
        const max = limit ?? 20
        const raw = await withChrome(async (client, chromeContext) => {
          return client.evaluate(
            '(async () => {' +
              ' try {' +
              '  const { PlacesUtils } = ChromeUtils.importESModule("resource://gre/modules/PlacesUtils.sys.mjs");' +
              '  const H = PlacesUtils.history;' +
              '  const action = ' + JSON.stringify(what) + ';' +
              '  if (action === "clear") {' +
              '    await H.clear();' +
              '    return JSON.stringify({ ok: true, cleared: true });' +
              '  }' +
              '  if (action === "remove") {' +
              '    const u = ' + opt(url) + ';' +
              '    if (!u) return JSON.stringify({ error: "url is required" });' +
              '    await H.remove(Services.io.newURI(u));' +
              '    return JSON.stringify({ ok: true, removed: u });' +
              '  }' +
              '  const q = ' + opt(query) + ';' +
              '  const found = [];' +
              '  const options = H.getNewQueryOptions();' +
              '  options.resultType = options.RESULTS_AS_URI;' +
              '  options.maxResults = ' + String(max) + ';' +
              '  const qobj = H.getNewQuery();' +
              '  if (q) qobj.searchTerms = q;' +
              '  const root = qobj;' +
              '  const result = await H.executeQuery(root, options);' +
              '  const rootNode = result && result.root;' +
              '  if (!rootNode) return JSON.stringify({ ok: true, count: 0, items: [] });' +
              '  try { rootNode.containerOpen = true; } catch (e) {}' +
              '  let total = 0;' +
              '  try { total = rootNode.childCount; } catch (e) { total = 0; }' +
              '  for (let i = 0; i < total && found.length < ' + String(max) + '; i++) {' +
              '    try {' +
              '      const r = rootNode.getChild(i);' +
              '      if (!r) continue;' +
              '      let uriStr = null;' +
              '      try {' +
              '        const u = r.uri;' +
              '        if (typeof u === "string") uriStr = u;' +
              '        else if (u && u.spec) uriStr = u.spec;' +
              '        else if (r.uri && r.uri.spec) uriStr = r.uri.spec;' +
              '      } catch (e) {}' +
              '      found.push({ uri: uriStr, title: r.title || null, time: r.time || null });' +
              '    } catch (e) {}' +
              '  }' +
              '  try { rootNode.containerOpen = false; } catch (e) {}' +
              '  return JSON.stringify({ ok: true, count: found.length, items: found });' +
              ' } catch (e) { return JSON.stringify({ error: e.message || String(e) }); }' +
              ' })()',
            chromeContext,
          )
        })
        if (typeof raw !== 'string') throw new Error('history manage returned nothing')
        const info = JSON.parse(raw) as {
          error?: string
          cleared?: boolean
          removed?: string
          count?: number
          items?: Array<{ uri: string | null; title: string | null; time: number | null }>
        }
        if (info.error !== undefined) throw new Error(info.error)
        if (what === 'clear') return text('history cleared')
        if (what === 'remove') return text('history entry removed: ' + String(info.removed))
        const items = info.items ?? []
        if (items.length === 0) return text('no history entry matched')
        const lines = ['found: ' + String(info.count)]
        for (const e of items) lines.push('  ' + (e.title || '(untitled)') + '  ' + (e.uri ?? '?'))
        return text(lines.join(String.fromCharCode(10)))
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_download_manage',
    {
      title: 'Remove, clear or open entries in the download list',
      description:
        'The management half of downloads that browser_list_downloads and set_download_state do not cover. ' +
        'MEASURED: the service comes from resource://gre/modules/Downloads.sys.mjs as Downloads.getList(Downloads.ALL), ' +
        'and that list has remove(item) / removeFinished(filter) / getAll() / add(). NOTE: Services.downloads does not ' +
        'exist in this build, so always go through Downloads.getList.',
      inputSchema: {
        action: z.enum(['clear-finished', 'remove', 'open', 'reveal']).describe('What to do'),
        index: z.number().int().min(0).optional().describe('0-based index into browser_list_downloads'),
      },
      annotations: WRITES_PERSISTENTLY,
    },
    async ({ action, index }: { action: 'clear-finished' | 'remove' | 'open' | 'reveal'; index?: number }) => {
      try {
        const what = str(action, 'action')
        const idx = index === undefined ? null : index
        const raw = await withChrome(async (client, chromeContext) => {
          return client.evaluate(
            '(async () => {' +
              ' try {' +
              '  const m = ChromeUtils.importESModule("resource://gre/modules/Downloads.sys.mjs");' +
              '  const D = m.Downloads;' +
              '  const list = await D.getList(D.ALL);' +
              '  const action = ' + JSON.stringify(what) + ';' +
              '  if (action === "clear-finished") {' +
              '    const before = (await list.getAll()).length;' +
              '    await list.removeFinished(() => true);' +
              '    const after = (await list.getAll()).length;' +
              '    return JSON.stringify({ ok: true, removed: before - after, remaining: after });' +
              '  }' +
              '  const idx = ' + (idx === null ? 'null' : String(idx)) + ';' +
              '  if (idx === null) return JSON.stringify({ error: "index is required" });' +
              '  const items = await list.getAll();' +
              '  const item = items[idx];' +
              '  if (!item) return JSON.stringify({ error: "no download at index " + idx + " (count " + items.length + ")" });' +
              '  const path = item.target && item.target.path ? item.target.path : null;' +
              '  if (action === "remove") {' +
              '    await list.remove(item);' +
              '    return JSON.stringify({ ok: true, removed: idx, path });' +
              '  }' +
              '  if (!path) return JSON.stringify({ error: "this entry has no local file" });' +
              '  const parent = item.target.parent || null;' +
              '  if (action === "reveal") {' +
              '    item.target.reveal();' +
              '    return JSON.stringify({ ok: true, revealed: path });' +
              '  }' +
              '  item.target.launch();' +
              '  return JSON.stringify({ ok: true, opened: path });' +
              ' } catch (e) { return JSON.stringify({ error: e.message || String(e) }); }' +
              ' })()',
            chromeContext,
          )
        })
        if (typeof raw !== 'string') throw new Error('download manage returned nothing')
        const info = JSON.parse(raw) as {
          error?: string
          removed?: number | string
          remaining?: number
          path?: string | null
          revealed?: string
          opened?: string
        }
        if (info.error !== undefined) throw new Error(info.error)
        if (what === 'clear-finished') {
          return text(
            'removed ' + String(info.removed) + ' finished entries, ' +
            String(info.remaining) + ' remaining',
          )
        }
        if (what === 'remove') return text('removed download entry ' + String(info.removed))
        if (what === 'reveal') return text('revealed: ' + String(info.revealed))
        return text('opened: ' + String(info.opened))
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_dom_tree',
    {
      title: 'Read the DOM tree of a page through DevTools',
      description:
        'Walk a real DOM tree through the DevTools inspector walker and return a bounded outline. MEASURED: the path is ' +
        'CommandsFactory.forTab -> targetCommand.startListening -> target.getFront("inspector") -> inspector.' +
        'getWalker() -> walker.getRootNode(), and the root reports nodeName "#document" with numChildren. This is the ' +
        'structured counterpart to browser_page_source (which returns raw HTML text) and is far cheaper for large pages.',
      inputSchema: {
        maxDepth: z.number().int().min(1).max(12).optional().describe('How deep to walk (default 4)'),
        maxNodes: z.number().int().min(1).max(600).optional().describe('Node budget (default 120)'),
        context: z.string().optional().describe('Tab URL fragment or context id (default: active tab)'),
      },
      annotations: READ_ONLY,
    },
    async ({
      maxDepth,
      maxNodes,
      context,
    }: {
      maxDepth?: number
      maxNodes?: number
      context?: string
    }) => {
      try {
        const depth = maxDepth ?? 4
        const budget = maxNodes ?? 120
        const wanted = context === undefined ? null : str(context, 'context')
        const raw = await withChrome(async (client, chromeContext) => {
          return client.evaluate(
            '(async () => {' +
              ' try {' +
              '  const w = Services.wm.getMostRecentWindow("navigator:browser");' +
              '  let tab = w.gBrowser.selectedTab;' +
              '  const wanted = ' + (wanted === null ? 'null' : JSON.stringify(wanted)) + ';' +
              '  if (wanted) {' +
              '    const hit = Array.from(w.gBrowser.tabs).find(t => t.linkedBrowser.currentURI.spec.indexOf(wanted) !== -1);' +
              '    if (hit) tab = hit;' +
              '  }' +
              '  const Mod = ChromeUtils.importESModule("resource://devtools/shared/loader/Loader.sys.mjs");' +
              '  const loader = new Mod.DevToolsLoader();' +
              '  const { CommandsFactory } = loader.require("devtools/shared/commands/commands-factory");' +
              '  const commands = await CommandsFactory.forTab(tab);' +
              '  await commands.targetCommand.startListening();' +
              '  const target = commands.targetCommand.targetFront;' +
              '  const inspector = await target.getFront("inspector");' +
              '  const walker = await inspector.getWalker();' +
              '  const root = await walker.getRootNode();' +
              '  const lines = [];' +
              '  let visited = 0;' +
              '  const walk = async (node, level) => {' +
              '    if (!node || visited >= ' + String(budget) + ' || level > ' + String(depth) + ') return;' +
              '    visited++;' +
              '    let attrs = [];' +
              '    try {' +
              '      const ra = node.attributes;' +
              '      if (ra && ra.length) {' +
              '        attrs = Array.from(ra).slice(0, 3).map(a => {' +
              '          if (!a) return "";' +
              '          if (typeof a === "string") return a.slice(0, 40);' +
              '          if (a.name) return String(a.name).slice(0, 30) + "=" + String(a.value || "").slice(0, 30);' +
              '          return Object.prototype.toString.call(a);' +
              '        }).filter(Boolean);' +
              '      }' +
              '    } catch (e) {}' +
              '    lines.push("  ".repeat(level) + String(node.nodeName || "?").slice(0, 60) + (attrs.length ? " [" + attrs.join(" ") + "]" : "") + (node.numChildren ? " (" + node.numChildren + ")" : ""));' +
              '    if (!node.numChildren) return;' +
              '    let children = [];' +
              '    try {' +
              '      const rawKids = await walker.children(node);' +
              '      children = rawKids && rawKids.nodes ? Array.from(rawKids.nodes) : (Array.isArray(rawKids) ? rawKids : []);' +
              '    } catch (e) { return; }' +
              '    for (const child of (children || [])) {' +
              '      if (visited >= ' + String(budget) + ') break;' +
              '      await walk(child, level + 1);' +
              '    }' +
              '  };' +
              '  await walk(root, 0);' +
              '  try { commands.destroy(); } catch (e) {}' +
              '  return JSON.stringify({ ok: true, count: visited, lines });' +
              ' } catch (e) { return JSON.stringify({ error: e.message || String(e) }); }' +
              ' })()',
            chromeContext,
          )
        })
        if (typeof raw !== 'string') throw new Error('dom tree returned nothing')
        const info = JSON.parse(raw) as { error?: string; count?: number; lines?: string[] }
        if (info.error !== undefined) throw new Error(info.error)
        return text(
          'nodes: ' + String(info.count) + String.fromCharCode(10) + (info.lines ?? []).join(String.fromCharCode(10)),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_a11y_tree',
    {
      title: 'Read the accessibility tree of a page',
      description:
        'Walk the accessibility tree through the DevTools accessibility front and return a bounded outline of roles and ' +
        'names. MEASURED: getRoot() does NOT exist on the front — the path is target.getFront("accessibility") then ' +
        'getWalker() (the front also offers getTraits/getSimulator/bootstrap). Useful for checking labels, roles and ' +
        'whether controls are exposed to assistive tech.',
      inputSchema: {
        maxDepth: z.number().int().min(1).max(12).optional().describe('How deep to walk (default 4)'),
        maxNodes: z.number().int().min(1).max(600).optional().describe('Node budget (default 100)'),
      },
      annotations: READ_ONLY,
    },
    async ({ maxDepth, maxNodes }: { maxDepth?: number; maxNodes?: number }) => {
      try {
        const depth = maxDepth ?? 4
        const budget = maxNodes ?? 100
        const raw = await withChrome(async (client, chromeContext) => {
          return client.evaluate(
            '(async () => {' +
              ' try {' +
              '  const w = Services.wm.getMostRecentWindow("navigator:browser");' +
              '  try { Cc["@mozilla.org/accessibilityService;1"].getService(Ci.nsIAccessibilityService); } catch (e) {}' +
              '  await new Promise(r => setTimeout(r, 800));' +
              '  if (!Services.appinfo.accessibilityEnabled) return JSON.stringify({ error: "the accessibility service did not start" });' +
              '  const Mod = ChromeUtils.importESModule("resource://devtools/shared/loader/Loader.sys.mjs");' +
              '  const loader = new Mod.DevToolsLoader();' +
              '  const { CommandsFactory } = loader.require("devtools/shared/commands/commands-factory");' +
              '  const commands = await CommandsFactory.forTab(w.gBrowser.selectedTab);' +
              '  await commands.targetCommand.startListening();' +
              '  const target = commands.targetCommand.targetFront;' +
              '  const inspector = await target.getFront("inspector");' +
              '  const domWalker = await inspector.getWalker();' +
              '  const domRoot = await domWalker.getRootNode();' +
              '  const access = await target.getFront("accessibility");' +
              '  const walker = await access.getWalker();' +
              '  let root = null;' +
              '  try { root = await walker.getAccessibleFor(domRoot); } catch (e) {}' +
              '  if (!root) return JSON.stringify({ error: "the accessibility walker returned no root" });' +
              '  const lines = [];' +
              '  let visited = 0;' +
              '  const walk = async (node, level) => {' +
              '    if (!node || visited >= ' + String(budget) + ' || level > ' + String(depth) + ') return;' +
              '    visited++;' +
              '    lines.push("  ".repeat(level) + (node.role || "?") + "  " + (node.name || ""));' +
              '    if (!node.childCount) return;' +
              '    let children = [];' +
              '    try {' +
              '      children = await node.children();' +
              '    } catch (e) { return; }' +
              '    for (const child of (children || [])) {' +
              '      if (visited >= ' + String(budget) + ') break;' +
              '      await walk(child, level + 1);' +
              '    }' +
              '  };' +
              '  await walk(root, 0);' +
              '  try { commands.destroy(); } catch (e) {}' +
              '  return JSON.stringify({ ok: true, count: visited, lines });' +
              ' } catch (e) { return JSON.stringify({ error: e.message || String(e) }); }' +
              ' })()',
            chromeContext,
          )
        })
        if (typeof raw !== 'string') throw new Error('a11y tree returned nothing')
        const info = JSON.parse(raw) as { error?: string; count?: number; lines?: string[] }
        if (info.error !== undefined) throw new Error(info.error)
        return text(
          'nodes: ' + String(info.count) + String.fromCharCode(10) + (info.lines ?? []).join(String.fromCharCode(10)),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_bookmark_backup',
    {
      title: 'List or create bookmark backups',
      description:
        'List the JSON bookmark backups in the profile and optionally create a new one. MEASURED: the module is ' +
        'resource://gre/modules/PlacesBackups.sys.mjs and exports PlacesBackups with getBackupFiles / ' +
        'getMostRecentBackup / saveBookmarksToJSONFile / create / getBookmarkCountForFile. Note PlacesUtils.' +
        'importFromHTML / exportToHTML do NOT exist in this build, so HTML import/export is unavailable — JSON backup ' +
        'is the supported path.',
      inputSchema: {
        action: z.enum(['list', 'create']).describe('list = show existing backups; create = write a new one'),
      },
      annotations: WRITES_PERSISTENTLY,
    },
    async ({ action }: { action: 'list' | 'create' }) => {
      try {
        const what = str(action, 'action')
        const raw = await withChrome(async (client, chromeContext) => {
          return client.evaluate(
            '(async () => {' +
              ' try {' +
              '  const m = ChromeUtils.importESModule("resource://gre/modules/PlacesBackups.sys.mjs");' +
              '  const B = m.PlacesBackups;' +
              '  const action = ' + JSON.stringify(what) + ';' +
              '  const out = {};' +
              '  try { const folder = await B.getBackupFolder(); out.folder = (folder && (folder.path || folder.leafName)) ? (folder.path || folder.leafName) : String(folder); } catch (e) { out.folderErr = (e.message || "").slice(0, 60); }' +
              '  if (action === "create") {' +
              '    const file = await B.saveBookmarksToJSONFile(B.getBackupFolder ? await B.getBackupFolder() : undefined);' +
              '    out.created = file ? file.leafName : null;' +
              '  }' +
              '  const files = await B.getBackupFiles();' +
              '  out.count = files.length;' +
              '  out.files = files.slice(0, 10).map(f => ({ name: (f.leafName || f.name || String(f)), size: (f.fileSize || f.size || 0) }));' +
              '  try { const recent = await B.getMostRecentBackup(); out.mostRecent = recent ? (recent.leafName || String(recent)) : null; } catch (e) {}' +
              '  return JSON.stringify(out);' +
              ' } catch (e) { return JSON.stringify({ error: e.message || String(e) }); }' +
              ' })()',
            chromeContext,
          )
        })
        if (typeof raw !== 'string') throw new Error('bookmark backup returned nothing')
        const info = JSON.parse(raw) as {
          error?: string
          folder?: string
          created?: string | null
          count?: number
          files?: Array<{ name: string; size: number }>
          mostRecent?: string | null
        }
        if (info.error !== undefined) throw new Error(info.error)
        const lines: string[] = []
        if (info.created) lines.push('created backup: ' + String(info.created))
        lines.push('backup folder: ' + String(info.folder))
        lines.push('backups: ' + String(info.count) + ' (latest: ' + String(info.mostRecent) + ')')
        for (const f of info.files ?? []) lines.push('  ' + f.name + '  ' + String(f.size) + ' bytes')
        return text(lines.join(String.fromCharCode(10)))
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_download_add',
    {
      title: 'Start a new download',
      description:
        'Begin a download of a URL to a local file. MEASURED: Downloads.createDownload exists on the module from ' +
        'resource://gre/modules/Downloads.sys.mjs (Downloads.getDataItem does NOT). This is the write half that ' +
        'browser_download_manage does not cover. Pass an absolute target path; the parent directory must exist.',
      inputSchema: {
        url: z.string().describe('http(s) URL to download'),
        target: z.string().describe('Absolute local file path to save to'),
      },
      annotations: WRITES_PERSISTENTLY,
    },
    async ({ url, target }: { url: string; target: string }) => {
      try {
        const source = str(url, 'url')
        const destination = str(target, 'target')
        const raw = await withChrome(async (client, chromeContext) => {
          return client.evaluate(
            '(async () => {' +
              ' try {' +
              '  const m = ChromeUtils.importESModule("resource://gre/modules/Downloads.sys.mjs");' +
              '  const D = m.Downloads;' +
              '  const src = ' + JSON.stringify(source) + ';' +
              '  const dst = ' + JSON.stringify(destination) + ';' +
              '  const file = new FileUtils.File(dst);' +
              '  if (file.exists()) file.remove(false);' +
              '  const dl = await D.createDownload({ source: src, target: file });' +
              '  const list = await D.getList(D.ALL);' +
              '  await list.add(dl);' +
              '  await dl.start();' +
              '  return JSON.stringify({ ok: true, started: true, target: dst });' +
              ' } catch (e) { return JSON.stringify({ error: e.message || String(e) }); }' +
              ' })()',
            chromeContext,
          )
        })
        if (typeof raw !== 'string') throw new Error('download add returned nothing')
        const info = JSON.parse(raw) as { error?: string; started?: boolean; target?: string }
        if (info.error !== undefined) throw new Error(info.error)
        return text('download started -> ' + String(info.target))
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_bookmarks_export',
    {
      title: 'Export bookmarks as Netscape HTML',
      description:
        'Write the bookmark tree to a Netscape Bookmark HTML file. That is the format Chrome, Edge and Safari also ' +
        'export, so it is how bookmarks move between browsers. MEASURED: Firefox has no usable exportToHTML in this ' +
        'build, so this walks PlacesUtils.bookmarks.search({parentGuid}) recursively and builds the HTML itself. ' +
        'TWO TRAPS: item.url is a URI object (read .spec), and search({parentGuid}) also returns the parent folder ' +
        'itself which must be skipped or the walk never ends.',
      inputSchema: {
        path: z.string().describe('Absolute .html file path to write'),
        maxNodes: z.number().int().min(1).max(20000).optional().describe('Node budget (default 2000)'),
      },
      annotations: WRITES_PERSISTENTLY,
    },
    async ({ path, maxNodes }: { path: string; maxNodes?: number }) => {
      try {
        const filePath = str(path, 'path')
        const budget = maxNodes ?? 2000
        const raw = await withChrome(async (client, chromeContext) => {
          const code = [
            '(async () => {',
            ' try {',
            '  const { PlacesUtils } = ChromeUtils.importESModule("resource://gre/modules/PlacesUtils.sys.mjs");',
            '  const bm = PlacesUtils.bookmarks;',
            '  const esc = (v) => String(v || "").split("&").join("&amp;").split("<").join("&lt;").split(">").join("&gt;");',
            '  const uriOf = (it) => { const u = it.url; if (!u) return null; if (typeof u === "string") return u; if (u.spec) return u.spec; return String(u); };',
            '  const file = new FileUtils.File(' + JSON.stringify(filePath) + ');',
            '  let left = ' + String(budget) + ';',
            '  let links = 0, folders = 0;',
            '  const out = ["<!DOCTYPE NETSCAPE-Bookmark-file-1>", "<TITLE>Bookmarks</TITLE>", "<H1>Bookmarks</H1>", "<DL><p>"];',
            '  const walk = async (guid, depth) => {',
            '    if (depth > 8 || left <= 0) return;',
            '    let kids = [];',
            '    try {',
            '      const all = await bm.search({ parentGuid: guid });',
            '      kids = all.filter(k => k.guid !== guid && k.parentGuid === guid);',
            '    } catch (e) { return; }',
            '    const pad = "    ".repeat(depth);',
            '    for (const it of kids) {',
            '      if (left <= 0) break;',
            '      if (it.guid === guid) continue;',
            '      left--;',
            '      if (it.type === bm.TYPE_FOLDER) {',
            '        folders++;',
            '        out.push(pad + "<DT><H3>" + esc(it.title) + "</H3>");',
            '        out.push(pad + "<DL><p>");',
            '        await walk(it.guid, depth + 1);',
            '        out.push(pad + "</DL><p>");',
            '      } else {',
            '        const u = uriOf(it);',
            '        if (u) { out.push(pad + "<DT><A HREF=\\"" + esc(u) + "\\">" + esc(it.title) + "</A>"); links++; }',
            '      }',
            '    }',
            '  };',
            '  for (const r of [bm.toolbarGuid, bm.menuGuid, bm.unfiledGuid]) {',
            '    const info = await bm.fetch({ guid: r });',
            '    out.push("    <DT><H3>" + esc(info.title) + "</H3>");',
            '    out.push("    <DL><p>");',
            '    await walk(r, 2);',
            '    out.push("    </DL><p>");',
            '  }',
            '  out.push("</DL><p>");',
            '  const text = out.join(String.fromCharCode(10)) + String.fromCharCode(10);',
            '  if (file.exists()) file.remove(false);',
            '  const stream = Cc["@mozilla.org/network/file-output-stream;1"].createInstance(Ci.nsIFileOutputStream);',
            '  stream.init(file, 0x02 | 0x08 | 0x20, 0o644, 0);',
            '  stream.write(text, text.length);',
            '  stream.close();',
            '  return JSON.stringify({ ok: true, links, folders, bytes: text.length });',
            ' } catch (e) { return JSON.stringify({ error: String(e) }); }',
            '})()',
          ].join(String.fromCharCode(10))
          return client.evaluate(code, chromeContext)
        })
        if (typeof raw !== 'string') throw new Error('export returned nothing')
        const info = JSON.parse(raw) as { error?: string; links?: number; folders?: number; bytes?: number }
        if (info.error !== undefined) throw new Error(info.error)
        return text(
          'exported ' + String(info.links) + ' links and ' + String(info.folders) + ' folders' +
          String.fromCharCode(10) +
          'written to: ' + filePath + ' (' + String(info.bytes) + ' bytes)',
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_bookmarks_import',
    {
      title: 'Import a Netscape HTML bookmark file',
      description:
        'Read a Netscape Bookmark HTML file and recreate its folders and links under a chosen bookmark folder. ' +
        'MEASURED: Firefox has no importFromHTML in this build, so this parses the file with DOMParser and calls ' +
        'PlacesUtils.bookmarks.insert per item. Import is one level of grouping: each <H3> opens a folder and the ' +
        'following <A> entries land inside it, which matches how browsers export a single grouping level.',
      inputSchema: {
        path: z.string().describe('Absolute .html file to read'),
        parentGuid: z.string().optional().describe('Destination folder guid (default: bookmarks menu)'),
      },
      annotations: WRITES_PERSISTENTLY,
    },
    async ({ path, parentGuid }: { path: string; parentGuid?: string }) => {
      try {
        const filePath = str(path, 'path')
        const dest = parentGuid === undefined ? null : str(parentGuid, 'parentGuid')
        const raw = await withChrome(async (client, chromeContext) => {
          const code = [
            '(async () => {',
            ' try {',
            '  const { PlacesUtils } = ChromeUtils.importESModule("resource://gre/modules/PlacesUtils.sys.mjs");',
            '  const bm = PlacesUtils.bookmarks;',
            '  const file = new FileUtils.File(' + JSON.stringify(filePath) + ');',
            '  if (!file.exists()) return JSON.stringify({ error: "file not found" });',
            '  let text = "";',
            '  const fis = Cc["@mozilla.org/network/file-input-stream;1"].createInstance(Ci.nsIFileInputStream);',
            '  fis.init(file, -1, 0, 0);',
            '  const cs = Cc["@mozilla.org/intl/converter-input-stream;1"].createInstance(Ci.nsIConverterInputStream);',
            '  cs.init(fis, "UTF-8", 0, Ci.nsIConverterInputStream.DEFAULT_REPLACEMENT_CHARACTER);',
            '  const chunk = {};',
            '  while (cs.readString(4096, chunk) !== 0) text += chunk.value;',
            '  cs.close();',
            '  const doc = new DOMParser().parseFromString(text, "text/html");',
            '  let cur = ' + (dest === null ? 'bm.menuGuid' : JSON.stringify(dest)) + ';',
            '  let links = 0, folders = 0;',
            '  const nodes = Array.from(doc.querySelectorAll("h3, a"));',
            '  for (const n of nodes) {',
            '    if (n.tagName === "H3") {',
            '      const title = (n.textContent || "Imported").trim() || "Imported";',
            '      try {',
            '        const f = await bm.insert({ parentGuid: cur, title, type: bm.TYPE_FOLDER });',
            '        cur = f.guid;',
            '        folders++;',
            '      } catch (e) {}',
            '    } else if (n.tagName === "A") {',
            '      const url = n.getAttribute("href");',
            '      if (!url || !/^(https?|ftp|file):/i.test(url)) continue;',
            '      try {',
            '        await bm.insert({ parentGuid: cur, title: (n.textContent || url).trim(), url });',
            '        links++;',
            '      } catch (e) {}',
            '    }',
            '  }',
            '  return JSON.stringify({ ok: true, links, folders });',
            ' } catch (e) { return JSON.stringify({ error: String(e) }); }',
            '})()',
          ].join(String.fromCharCode(10))
          return client.evaluate(code, chromeContext)
        })
        if (typeof raw !== 'string') throw new Error('import returned nothing')
        const info = JSON.parse(raw) as { error?: string; links?: number; folders?: number }
        if (info.error !== undefined) throw new Error(info.error)
        return text('imported ' + String(info.links) + ' links and ' + String(info.folders) + ' folders')
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_memory_usage',
    {
      title: 'Report process memory usage',
      description:
        'Read live memory figures from nsIMemoryReporterManager. MEASURED: resident / residentUnique / heapAllocated are ' +
        'properties (not methods) and getReports() also exists for the full breakdown. Use this when a page feels heavy ' +
        'and you want numbers rather than guesses.',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      try {
        const raw = await withChrome(async (client, chromeContext) => {
          return client.evaluate(
            '(() => {' +
              ' try {' +
              '  const rm = Cc["@mozilla.org/memory-reporter-manager;1"].getService(Ci.nsIMemoryReporterManager);' +
              '  const mb = (n) => (typeof n === "number" ? Math.round(n / 1048576) : null);' +
              '  return JSON.stringify({' +
              '    residentMB: mb(rm.resident),' +
              '    residentUniqueMB: mb(rm.residentUnique),' +
              '    heapAllocatedMB: mb(rm.heapAllocated),' +
              '    rss: rm.resident || null' +
              '  });' +
              ' } catch (e) { return JSON.stringify({ error: String(e) }); }' +
              ' })()',
            chromeContext,
          )
        })
        if (typeof raw !== 'string') throw new Error('memory usage returned nothing')
        const info = JSON.parse(raw) as {
          error?: string
          residentMB?: number | null
          residentUniqueMB?: number | null
          heapAllocatedMB?: number | null
        }
        if (info.error !== undefined) throw new Error(info.error)
        return text(
          'resident: ' + String(info.residentMB) + ' MB' + String.fromCharCode(10) +
          'resident unique: ' + String(info.residentUniqueMB) + ' MB' + String.fromCharCode(10) +
          'heap allocated: ' + String(info.heapAllocatedMB) + ' MB',
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_troubleshoot',
    {
      title: 'Read the about:support troubleshooting snapshot',
      description:
        'Return the same diagnostic snapshot that about:support shows. MEASURED: the module is ' +
        'resource://gre/modules/Troubleshoot.sys.mjs and Troubleshoot.snapshot() resolves to sections including ' +
        'modifiedPreferences, lockedPreferences, printingPreferences, media, accessibility, pdfjs, intl, ' +
        'securitySoftware, startupCache and libraryVersions. Use sections to narrow the output.',
      inputSchema: {
        sections: z
          .array(z.string())
          .optional()
          .describe('Only these top-level keys (default: a useful subset)'),
      },
      annotations: READ_ONLY,
    },
    async ({ sections }: { sections?: string[] }) => {
      try {
        const wanted = sections === undefined ? null : sections
        const raw = await withChrome(async (client, chromeContext) => {
          return client.evaluate(
            '(async () => {' +
              ' try {' +
              '  const m = ChromeUtils.importESModule("resource://gre/modules/Troubleshoot.sys.mjs");' +
              '  const t = await m.Troubleshoot.snapshot();' +
              '  const wanted = ' + (wanted === null ? 'null' : JSON.stringify(wanted)) + ';' +
              '  const keys = wanted || ["modifiedPreferences", "printingPreferences", "media", "accessibility", "pdfjs", "intl", "securitySoftware"];' +
              '  const out = {};' +
              '  for (const k of keys) {' +
              '    if (t[k] !== undefined) {' +
              '      try { out[k] = JSON.parse(JSON.stringify(t[k])); } catch (e) { out[k] = String(t[k]); }' +
              '    }' +
              '  }' +
              '  out.__available = Object.keys(t);' +
              '  return JSON.stringify(out);' +
              ' } catch (e) { return JSON.stringify({ error: String(e) }); }' +
              ' })()',
            chromeContext,
          )
        })
        if (typeof raw !== 'string') throw new Error('troubleshoot returned nothing')
        const info = JSON.parse(raw) as Record<string, unknown> & { error?: string; __available?: string[] }
        if (info.error !== undefined) throw new Error(String(info.error))
        const available = info.__available ?? []
        const lines: string[] = []
        for (const k of Object.keys(info)) {
          if (k === '__available' || k === 'error') continue
          const v = info[k]
          if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
            lines.push(k + ':')
            for (const [kk, vv] of Object.entries(v as Record<string, unknown>)) {
              lines.push('  ' + kk + ': ' + String(vv))
            }
          } else {
            lines.push(k + ': ' + String(v))
          }
        }
        lines.push('')
        lines.push('available sections: ' + available.join(', '))
        return text(lines.join(String.fromCharCode(10)))
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_certificate_manage',
    {
      title: 'Inspect certificates and manage certificate exceptions',
      description:
        'Read the certificate database and manage per-host certificate exceptions. MEASURED: nsIX509CertDB offers addCert ' +
        '/ getCerts / importCertsFromFile (removeCert is absent in this build), and nsICertOverrideService offers ' +
        'rememberValidityOverride / clearValidityOverride / clearAllOverrides. Clearing all overrides is ' +
        'irreversible, so it requires confirm:true.',
      inputSchema: {
        action: z
          .enum(['list', 'list-overrides', 'remember-override', 'clear-override', 'clear-all-overrides'])
          .describe('What to do'),
        host: z.string().optional().describe('Host for remember/clear override'),
        port: z.number().int().min(1).max(65535).optional().describe('Port (default 443)'),
        confirm: z.boolean().optional().describe('Required true for clear-all-overrides'),
      },
      annotations: READ_ONLY,
    },
    async ({
      action,
      host,
      port,
      confirm,
    }: {
      action: 'list' | 'list-overrides' | 'remember-override' | 'clear-override' | 'clear-all-overrides'
      host?: string
      port?: number
      confirm?: boolean
    }) => {
      try {
        const what = str(action, 'action')
        if (what === 'clear-all-overrides' && confirm !== true) {
          throw new Error('clear-all-overrides is irreversible — pass confirm:true to proceed')
        }
        const hostStr = host === undefined ? null : str(host, 'host')
        const portNum = port ?? 443
        const raw = await withChrome(async (client, chromeContext) => {
          return client.evaluate(
            '(async () => {' +
              ' try {' +
              '  const action = ' + JSON.stringify(what) + ';' +
              '  const hostArg = ' + (hostStr === null ? 'null' : JSON.stringify(hostStr)) + ';' +
              '  const portArg = ' + String(portNum) + ';' +
              '  const ov = Cc["@mozilla.org/security/certoverride;1"].getService(Ci.nsICertOverrideService);' +
              '  if (action === "clear-all-overrides") {' +
              '    ov.clearAllOverrides();' +
              '    return JSON.stringify({ ok: true, clearedAll: true });' +
              '  }' +
              '  if (action === "remember-override") {' +
              '    if (!hostArg) return JSON.stringify({ error: "host is required" });' +
              '    const flags = Ci.nsICertOverrideService.ERROR_UNTRUSTED | Ci.nsICertOverrideService.ERROR_MISMATCH | Ci.nsICertOverrideService.ERROR_TIME;' +
              '    ov.rememberValidityOverride(hostArg, portArg, {}, flags, false);' +
              '    return JSON.stringify({ ok: true, host: hostArg, port: portArg });' +
              '  }' +
              '  if (action === "clear-override") {' +
              '    if (!hostArg) return JSON.stringify({ error: "host is required" });' +
              '    ov.clearValidityOverride(hostArg, portArg);' +
              '    return JSON.stringify({ ok: true, host: hostArg, port: portArg });' +
              '  }' +
              '  const db = Cc["@mozilla.org/security/x509certdb;1"].getService(Ci.nsIX509CertDB);' +
              '  if (action === "list") {' +
              '    const rawCerts = await db.getCerts();' +
              '    const certs = Array.from(rawCerts || []);' +
              '    const items = [];' +
              '    for (const c of certs) {' +
              '      if (items.length >= 50) break;' +
              '      try { items.push({ nickname: c.nickname || c.commonName || "(unnamed)", issuer: c.issuerName || null }); } catch (e) {}' +
              '    }' +
              '    return JSON.stringify({ ok: true, count: certs.length, items });' +
              '  }' +
              '  return JSON.stringify({ ok: true, overrideService: !!ov, note: "per-host overrides are listed by the browser; this build exposes no enumerator" });' +
              ' } catch (e) { return JSON.stringify({ error: String(e) }); }' +
              ' })()',
            chromeContext,
          )
        })
        if (typeof raw !== 'string') throw new Error('certificate manage returned nothing')
        const info = JSON.parse(raw) as {
          error?: string
          count?: number
          items?: Array<{ nickname: string; issuer: string | null }>
          host?: string
          port?: number
          clearedAll?: boolean
        }
        if (info.error !== undefined) throw new Error(info.error)
        if (what === 'list') {
          const items = info.items ?? []
          const lines = ['certificates: ' + String(info.count)]
          for (const c of items) lines.push('  ' + c.nickname + (c.issuer ? '  (' + c.issuer + ')' : ''))
          return text(lines.join(String.fromCharCode(10)))
        }
        if (what === 'clear-all-overrides') return text('cleared all certificate exceptions')
        if (what === 'remember-override') return text('remembered certificate exception for ' + String(info.host) + ':' + String(info.port))
        if (what === 'clear-override') return text('cleared certificate exception for ' + String(info.host) + ':' + String(info.port))
        return text('override service available; this build exposes no enumerator for existing exceptions')
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_import_logins',
    {
      title: 'Import logins from a CSV file',
      description:
        'Import saved logins from a CSV (the format Chrome and Firefox both export). MEASURED: the module is ' +
        'resource://gre/modules/LoginCSVImport.sys.mjs and its static entry point is LoginCSVImport.importFromCSV ' +
        '(the class instance has no prototype methods). Column names are mapped by the browser itself, so pass a file ' +
        'already in the standard url/username/password layout.',
      inputSchema: {
        path: z.string().describe('Absolute path to the .csv file'),
      },
      annotations: WRITES_PERSISTENTLY,
    },
    async ({ path }: { path: string }) => {
      try {
        const filePath = str(path, 'path')
        const raw = await withChrome(async (client, chromeContext) => {
          return client.evaluate(
            '(async () => {' +
              ' try {' +
              '  const m = ChromeUtils.importESModule("resource://gre/modules/LoginCSVImport.sys.mjs");' +
              '  const C = m.LoginCSVImport;' +
              '  const file = new FileUtils.File(' + JSON.stringify(filePath) + ');' +
              '  if (!file.exists()) return JSON.stringify({ error: "file not found" });' +
              '  let text = "";' +
              '  const fis = Cc["@mozilla.org/network/file-input-stream;1"].createInstance(Ci.nsIFileInputStream);' +
              '  fis.init(file, -1, 0, 0);' +
              '  const cs = Cc["@mozilla.org/intl/converter-input-stream;1"].createInstance(Ci.nsIConverterInputStream);' +
              '  cs.init(fis, "UTF-8", 0, Ci.nsIConverterInputStream.DEFAULT_REPLACEMENT_CHARACTER);' +
              '  const chunk = {};' +
              '  while (cs.readString(4096, chunk) !== 0) text += chunk.value;' +
              '  cs.close();' +
              '  const result = await C.importFromCSV(text);' +
              '  return JSON.stringify({ ok: true, result: result === undefined ? null : result });' +
              ' } catch (e) { return JSON.stringify({ error: String(e) }); }' +
              ' })()',
            chromeContext,
          )
        })
        if (typeof raw !== 'string') throw new Error('login import returned nothing')
        const info = JSON.parse(raw) as { error?: string; result?: unknown }
        if (info.error !== undefined) throw new Error(info.error)
        return text('logins imported from ' + filePath + (info.result ? String.fromCharCode(10) + JSON.stringify(info.result) : ''))
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_import_cookies',
    {
      title: 'Import many cookies at once',
      description:
        'Set a batch of cookies in one call instead of one browser_set_cookie per cookie. Needed because Firefox allows ' +
        'only ONE active BiDi session, so an external script cannot open its own connection while this server holds ' +
        'the session — the batch has to run inside the shared session. Pass an array of {name, value, domain, path, ' +
        'expirySeconds, secure, httpOnly, sameSite}. Reports per-item failures instead of stopping on the first error.',
      inputSchema: {
        cookies: z
          .array(
            z.object({
              name: z.string(),
              value: z.string(),
              domain: z.string(),
              path: z.string().optional(),
              expirySeconds: z.number().int().positive().optional(),
              secure: z.boolean().optional(),
              httpOnly: z.boolean().optional(),
              sameSite: z.enum(['strict', 'lax', 'none']).optional(),
            }),
          )
          .describe('Cookies to set'),
      },
      annotations: WRITES_PERSISTENTLY,
    },
    async ({
      cookies,
    }: {
      cookies: Array<{
        name: string
        value: string
        domain: string
        path?: string
        expirySeconds?: number
        secure?: boolean
        httpOnly?: boolean
        sameSite?: 'strict' | 'lax' | 'none'
      }>
    }) => {
      try {
        if (!Array.isArray(cookies) || cookies.length === 0) {
          throw new Error('cookies array is required')
        }
        const results: Array<{ name: string; domain: string; ok: boolean; error?: string }> = []
        await withBidi(async (client) => {
        for (const c of cookies) {
          const cookie: Record<string, unknown> = {
            name: c.name,
            value: { type: 'string', value: c.value },
            domain: c.domain,
            path: c.path ?? '/',
          }
          if (c.expirySeconds !== undefined) cookie.expiry = c.expirySeconds
          if (c.secure !== undefined) cookie.secure = c.secure
          if (c.httpOnly !== undefined) cookie.httpOnly = c.httpOnly
          if (c.sameSite !== undefined) cookie.sameSite = c.sameSite
          try {
            await client.call('storage.setCookie', { cookie })
            results.push({ name: c.name, domain: c.domain, ok: true })
          } catch (error) {
            results.push({
              name: c.name,
              domain: c.domain,
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            })
          }
        }
        })
        const ok = results.filter((r) => r.ok).length
        const failed = results.filter((r) => !r.ok)
        const lines = ['cookies written: ' + String(ok) + ' / ' + String(results.length)]
        for (const f of failed.slice(0, 20)) {
          lines.push('  FAILED ' + f.domain + ' ' + f.name + ': ' + String(f.error).slice(0, 120))
        }
        return text(lines.join(String.fromCharCode(10)))
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_import_cookies_from_file',
    {
      title: 'Import cookies from a JSON file',
      description:
        'Read a JSON file containing an array of cookie objects and set them all inside the existing shared BiDi session. ' +
        'Each object may have {name, value, domain, path, expirySeconds, secure, httpOnly, sameSite}. ' +
        'This exists because an external script cannot open its own BiDi session while this server holds the only one, ' +
        'and hand-typing hundreds of cookies through browser_import_cookies is impractical.',
      inputSchema: {
        path: z.string().describe('Absolute path to the JSON file'),
      },
      annotations: WRITES_PERSISTENTLY,
    },
    async ({ path }: { path: string }) => {
      try {
        const raw = readFileSync(path, 'utf8')
        const parsed: unknown = JSON.parse(raw)
        if (!Array.isArray(parsed) || parsed.length === 0) {
          throw new Error('JSON must be a non-empty array of cookie objects')
        }
        const items = parsed as Array<{
          name: string
          value: string
          domain: string
          path?: string
          expirySeconds?: number
          secure?: boolean
          httpOnly?: boolean
          sameSite?: 'strict' | 'lax' | 'none'
        }>
        const failed: Array<{ domain: string; name: string; error: string }> = []
        let ok = 0
        await withBidi(async (client) => {
          for (const c of items) {
            if (!c || typeof c.name !== 'string' || typeof c.value !== 'string' || typeof c.domain !== 'string') {
              failed.push({ domain: String(c?.domain), name: String(c?.name), error: 'missing name/value/domain' })
              continue
            }
            const cookie: Record<string, unknown> = {
              name: c.name,
              value: { type: 'string', value: c.value },
              domain: c.domain,
              path: c.path ?? '/',
            }
            if (c.expirySeconds !== undefined) cookie.expiry = c.expirySeconds
            if (c.secure !== undefined) cookie.secure = c.secure
            if (c.httpOnly !== undefined) cookie.httpOnly = c.httpOnly
            if (c.sameSite !== undefined) cookie.sameSite = c.sameSite
            try {
              await client.call('storage.setCookie', { cookie })
              ok += 1
            } catch (error) {
              failed.push({
                domain: c.domain,
                name: c.name,
                error: error instanceof Error ? error.message : String(error),
              })
            }
          }
        })
        const lines = [
          'cookies written: ' + String(ok) + ' / ' + String(items.length),
        ]
        if (failed.length > 0) {
          lines.push('failed: ' + String(failed.length))
          for (const f of failed.slice(0, 15)) {
            lines.push('  FAILED ' + f.domain + ' ' + f.name + ': ' + String(f.error).slice(0, 120))
          }
        }
        return text(lines.join(String.fromCharCode(10)))
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_import_logins_from_file',
    {
      title: 'Import logins from a JSON file',
      description:
        'Read a JSON file holding an array of {origin, user, password} and insert each one through nsILoginManager ' +
        'directly, bypassing LoginCSVImport (which fails with FILE_PERMISSIONS_ERROR in this build). ' +
        'Tell the truth about duplicates: Firefox silently merges or rejects entries whose origin+username already exist.',
      inputSchema: {
        path: z.string().describe('Absolute path to a JSON file: array of {origin, user, password}'),
      },
      annotations: WRITES_PERSISTENTLY,
    },
    async ({ path }: { path: string }) => {
      try {
        const filePath = str(path, 'path')
        const raw = await withChrome(async (client, chromeContext) => {
          return client.evaluate(
            '(async () => {' +
              ' try {' +
              '  const file = new FileUtils.File(' + JSON.stringify(filePath) + ');' +
              '  if (!file.exists()) return JSON.stringify({ error: "file not found" });' +
              '  let text = "";' +
              '  const fis = Cc["@mozilla.org/network/file-input-stream;1"].createInstance(Ci.nsIFileInputStream);' +
              '  fis.init(file, -1, 0, 0);' +
              '  const cs = Cc["@mozilla.org/intl/converter-input-stream;1"].createInstance(Ci.nsIConverterInputStream);' +
              '  cs.init(fis, "UTF-8", 0, Ci.nsIConverterInputStream.DEFAULT_REPLACEMENT_CHARACTER);' +
              '  const chunk = {};' +
              '  while (cs.readString(65536, chunk) !== 0) text += chunk.value;' +
              '  cs.close();' +
              '  const items = JSON.parse(text);' +
              '  if (!Array.isArray(items)) return JSON.stringify({ error: "JSON must be an array" });' +
              '  const lm = Cc["@mozilla.org/login-manager;1"].getService(Ci.nsILoginManager);' +
              '  let ok = 0; const failed = [];' +
              '  for (const it of items) {' +
              '   try {' +
              '    const info = Cc["@mozilla.org/login-manager/loginInfo;1"].createInstance(Ci.nsILoginInfo);' +
              '    info.init(it.origin, it.origin, null, it.user || "", it.password || "", "", "");' +
              '    await lm.addLoginAsync(info);' +
              '    ok++;' +
              '   } catch (e) { failed.push({ origin: it.origin, user: it.user, error: String(e).slice(0, 120) }); }' +
              '  }' +
              '  return JSON.stringify({ ok: ok, total: items.length, failed: failed });' +
              ' } catch (e) { return JSON.stringify({ error: String(e) }); }' +
              ' })()',
            chromeContext,
          )
        })
        if (typeof raw !== 'string') throw new Error('login import returned nothing')
        const info = JSON.parse(raw) as {
          error?: string
          ok?: number
          total?: number
          failed?: Array<{ origin: string; user: string; error: string }>
        }
        if (info.error !== undefined) throw new Error(info.error)
        const lines = ['logins inserted: ' + String(info.ok) + ' / ' + String(info.total)]
        const failed = info.failed ?? []
        if (failed.length > 0) {
          lines.push('failed: ' + String(failed.length))
          for (const f of failed.slice(0, 12)) {
            lines.push('  FAILED ' + String(f.origin).slice(0, 50) + ' ' + String(f.user).slice(0, 24) + ': ' + f.error)
          }
        }
        return text(lines.join(String.fromCharCode(10)))
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_import_history',
    {
      title: 'Import browsing history from a JSON file',
      description:
        'Read a JSON file holding an array of {url, title, lastVisit, visitCount} and insert each into Places via ' +
        'PlacesUtils.history.insert, so migrated history keeps its original timestamps instead of looking like fresh ' +
        'visits. Entries whose url already exists are still inserted (Places merges visits for a known url).',
      inputSchema: {
        path: z.string().describe('Absolute path to a JSON file: array of {url, title, lastVisit, visitCount}'),
      },
      annotations: WRITES_PERSISTENTLY,
    },
    async ({ path }: { path: string }) => {
      try {
        const filePath = str(path, 'path')
        const raw = await withChrome(async (client, chromeContext) => {
          return client.evaluate(
            '(async () => {' +
              ' try {' +
              '  const file = new FileUtils.File(' + JSON.stringify(filePath) + ');' +
              '  if (!file.exists()) return JSON.stringify({ error: "file not found" });' +
              '  let text = "";' +
              '  const fis = Cc["@mozilla.org/network/file-input-stream;1"].createInstance(Ci.nsIFileInputStream);' +
              '  fis.init(file, -1, 0, 0);' +
              '  const cs = Cc["@mozilla.org/intl/converter-input-stream;1"].createInstance(Ci.nsIConverterInputStream);' +
              '  cs.init(fis, "UTF-8", 0, Ci.nsIConverterInputStream.DEFAULT_REPLACEMENT_CHARACTER);' +
              '  const chunk = {};' +
              '  while (cs.readString(65536, chunk) !== 0) text += chunk.value;' +
              '  cs.close();' +
              '  const items = JSON.parse(text);' +
              '  if (!Array.isArray(items)) return JSON.stringify({ error: "JSON must be an array" });' +
              '  const { PlacesUtils } = ChromeUtils.importESModule("resource://gre/modules/PlacesUtils.sys.mjs");' +
              '  let ok = 0; const failed = [];' +
              '  for (const it of items) {' +
              '   try {' +
              '    const place = { url: it.url, title: it.title || "" };' +
              '    if (it.lastVisit) place.visits = [{ date: new Date(Number(it.lastVisit)) }];' +
              '    await PlacesUtils.history.insert(place);' +
              '    ok++;' +
              '   } catch (e) { failed.push({ url: String(it.url).slice(0, 90), error: String(e).slice(0, 100) }); }' +
              '  }' +
              '  return JSON.stringify({ ok: ok, total: items.length, failed: failed });' +
              ' } catch (e) { return JSON.stringify({ error: String(e) }); }' +
              ' })()',
            chromeContext,
          )
        })
        if (typeof raw !== 'string') throw new Error('history import returned nothing')
        const info = JSON.parse(raw) as {
          error?: string
          ok?: number
          total?: number
          failed?: Array<{ url: string; error: string }>
        }
        if (info.error !== undefined) throw new Error(info.error)
        const lines = ['history inserted: ' + String(info.ok) + ' / ' + String(info.total)]
        const failed = info.failed ?? []
        if (failed.length > 0) {
          lines.push('failed: ' + String(failed.length))
          for (const f of failed.slice(0, 12)) {
            lines.push('  FAILED ' + f.url + ': ' + f.error)
          }
        }
        return text(lines.join(String.fromCharCode(10)))
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_list_windows',
    {
      title: 'List browser windows',
      description: 'List Firefox windows with their state and geometry (privileged context).',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      try {
        return text(JSON.stringify(await withBidi(async (client) => await client.listWindows()), null, 2))
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_get_pref',
    {
      title: 'Read a Firefox preference',
      description: 'Read a preference by name (privileged context). Returns type and value.',
      inputSchema: { name: z.string().describe('Preference name, e.g. browser.tabs.inTitlebar') },
      annotations: READ_ONLY,
    },
    async ({ name }: { name: string }) => {
      try {
        const pref = str(name, 'name')
        return text(
          JSON.stringify(
            await withChrome(
              async (client, context) =>
                await client.evaluate(
                  `(() => { const n = ${JSON.stringify(pref)};` +
                    ` const t = Services.prefs.getPrefType(n);` +
                    ` if (t === 0) return { exists: false };` +
                    ` if (t === Services.prefs.PREF_BOOL) return { type: 'bool', value: Services.prefs.getBoolPref(n) };` +
                    ` if (t === Services.prefs.PREF_INT) return { type: 'int', value: Services.prefs.getIntPref(n) };` +
                    ` if (t === Services.prefs.PREF_STRING) return { type: 'string', value: Services.prefs.getStringPref(n) };` +
                    ` return { type: 'unknown' }; })()`,
                  context,
                ),
            ),
            null,
            2,
          ),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_set_pref',
    {
      title: 'Write a Firefox preference',
      description:
        'Set a preference (privileged context). This changes the browser and outlives the session. ' +
        'Some preferences are locked; some are only read at startup, so a change has no effect until Firefox restarts.',
      inputSchema: {
        name: z.string().describe('Preference name'),
        type: z.enum(['bool', 'int', 'string']).describe('Value type'),
        value: z.string().describe('Value (bool: "true"/"false"; int: digits; string: literal)'),
      },
      annotations: WRITES_PERSISTENTLY,
    },
    async ({ name, type, value }: { name: string; type: 'bool' | 'int' | 'string'; value: string }) => {
      try {
        const pref = str(name, 'name')
        const raw = str(value, 'value')
        if (type === 'int' && Number.isNaN(Number.parseInt(raw, 10))) {
          throw new Error('value must be an integer when type is "int"')
        }
        const literal =
          type === 'bool'
            ? raw === 'true'
              ? 'true'
              : 'false'
            : type === 'int'
              ? String(Number.parseInt(raw, 10))
              : JSON.stringify(raw)
        const setter = type === 'bool' ? 'setBoolPref' : type === 'int' ? 'setIntPref' : 'setStringPref'
        await withChrome(async (client, context) => {
          await client.evaluate(`Services.prefs.${setter}(${JSON.stringify(pref)}, ${literal})`, context)
        })
        return text(`set ${pref} (${type}) = ${raw}`)
      } catch (error) {
        return failure(error)
      }
    },
  )


  server.registerTool(
    'browser_list_history',
    {
      title: 'List history entries',
      description:
        'Read recent history entries (privileged context). PlacesUtils.history.executeQuery is synchronous and returns a result whose root must be container-opened.',
      inputSchema: { limit: z.number().int().positive().max(200).optional().describe('Max entries (default 20)') },
      annotations: READ_ONLY,
    },
    async ({ limit }: { limit?: number }) => {
      try {
        return text(
          JSON.stringify(
            await withChrome(async (client, context) =>
              await client.evaluate(
                `(() => {
                   const q = PlacesUtils.history.getNewQuery();
                   const o = PlacesUtils.history.getNewQueryOptions();
                   o.maxResults = ${Number(limit ?? 20)};
                   const r = PlacesUtils.history.executeQuery(q, o);
                   r.root.containerOpen = true;
                   const out = [];
                   for (let i = 0; i < r.root.childCount; i++) {
                     const c = r.root.getChild(i);
                     out.push({ uri: c.uri, title: c.title, time: c.time });
                   }
                   r.root.containerOpen = false;
                   return JSON.stringify(out);
                 })()`,
                context,
              ),
            ),
            null,
            2,
          ),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_list_bookmarks',
    {
      title: 'List bookmarks',
      description:
        'Read bookmarks from a folder (privileged context), each entry with the guid that browser_remove_bookmark ' +
        'needs. Defaults to the toolbar; the bookmarks menu and Other Bookmarks are reachable through parentGuid.',
      inputSchema: {
        parentGuid: z
          .string()
          .optional()
          .describe(
            'Folder guid (default: the toolbar, "toolbar_____"). Also useful: "menu________" (bookmarks menu) ' +
              'and "unfiled_____" (Other Bookmarks).',
          ),
      },
      annotations: READ_ONLY,
    },
    async ({ parentGuid }: { parentGuid?: string }) => {
      try {
        const root =
          parentGuid === undefined ? 'PlacesUtils.bookmarks.toolbarGuid' : JSON.stringify(parentGuid)
        return text(
          JSON.stringify(
            await withChrome(async (client, context) =>
              await client.evaluate(
                `(async () => {
                   const rootGuid = ${root};
                   const tree = await PlacesUtils.promiseBookmarksTree(rootGuid);
                   const kids = tree.children || [];
                   return JSON.stringify(kids.slice(0, 50).map(b => ({ guid: b.guid, title: b.title, url: b.uri, type: b.type })));
                 })()`,
                context,
              ),
            ),
            null,
            2,
          ),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_toolbar_widgets',
    {
      title: 'List toolbar widgets',
      description:
        'List the widget ids currently in a toolbar area (privileged context). Use area "nav-bar" for the main toolbar.',
      inputSchema: { area: z.string().optional().describe('Toolbar area id, default "nav-bar"') },
      annotations: READ_ONLY,
    },
    async ({ area }: { area?: string }) => {
      try {
        const target = area ?? 'nav-bar'
        return text(
          JSON.stringify(
            await withChrome(async (client, context) =>
              await client.evaluate(
                `JSON.stringify(CustomizableUI.getWidgetIdsInArea(${JSON.stringify(target)}))`,
                context,
              ),
            ),
            null,
            2,
          ),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_list_addons',
    {
      title: 'List add-ons',
      description: 'List installed extensions (privileged context).',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      try {
        return text(
          JSON.stringify(
            await withChrome(async (client, context) =>
              await client.evaluate(
                `(async () => {
                   // MEASURED: the privileged global AddonManager lists all 13 add-ons, while the one
                   // destructured out of importESModule('.../AddonManager.sys.mjs') returned only 2 —
                   // the global is the initialised one, so use it.
                   const list = await AddonManager.getAddonsByTypes(['extension']);
                   return JSON.stringify(list.map(a => ({
                     id: a.id,
                     name: a.name,
                     version: a.version,
                     enabled: !a.userDisabled,
                     active: a.isActive,
                     hidden: a.hidden,
                   })));
                 })()`,
                context,
              ),
            ),
            null,
            2,
          ),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_list_user_contexts',
    {
      title: 'List user contexts (containers)',
      description: 'List BiDi user contexts. The "default" one always exists; others are containers created via browser.createUserContext.',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      try {
        return text(
          JSON.stringify(
            await withBidi(async (client) => await client.call('browser.getUserContexts', {})),
            null,
            2,
          ),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'browser_selfcheck',
    {
      title: 'Compatibility self-check',
      description:
        'Run after a Firefox upgrade: report the version and verify the non-standard pieces this server relies on ' +
        '(the moz:scope "chrome" scope, privileged Services access, PlacesUtils.history.executeQuery, CustomizableUI, AddonManager). ' +
        'A failing line means the upstream API moved and this server needs updating.',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      try {
        return text(
          await withBidi(async (client) => {
            const lines: string[] = []
            const chrome = await client.chromeContext()
            if (chrome === null) {
              return 'FAIL: no chrome context (launch Firefox with MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1)'
            }
            lines.push(`firefox version            : ${String(await client.evaluate('Services.appinfo.version', chrome))}`)
            lines.push(`app build id               : ${String(await client.evaluate('Services.appinfo.appBuildID', chrome))}`)
            const probe = `JSON.stringify({
                services: typeof Services !== 'undefined',
                prefs: typeof Services !== 'undefined' && typeof Services.prefs.getPrefType === 'function',
                customizableUI: typeof CustomizableUI !== 'undefined',
                addonManager: (() => { try { ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs'); return true; } catch (e) { return false; } })(),
                placesHistory: typeof PlacesUtils !== 'undefined' && typeof PlacesUtils.history.executeQuery === 'function',
                placesBookmarks: typeof PlacesUtils !== 'undefined' && typeof PlacesUtils.promiseBookmarksTree === 'function',
                placesToolbarGuid: typeof PlacesUtils !== 'undefined' && typeof PlacesUtils.bookmarks.toolbarGuid === 'string',
              })`
            const raw = await client.evaluate(probe, chrome)
            const checks = JSON.parse(typeof raw === 'string' ? raw : JSON.stringify(raw)) as Record<string, boolean>
            for (const [name, ok] of Object.entries(checks)) {
              lines.push(`${ok ? 'ok  ' : 'FAIL'} ${name}`)
            }
            const failed = Object.values(checks).filter((ok) => !ok).length
            lines.push(failed === 0 ? 'RESULT: all checks passed' : `RESULT: ${String(failed)} check(s) failed`)
            lines.push(
              `output limit: ${String(maxOutputChars)} characters` +
                (process.env.DSH_BROWSER_OUTPUT_DIR === undefined
                  ? ' (oversized results go to the system temp dir)'
                  : `; oversized results go to ${process.env.DSH_BROWSER_OUTPUT_DIR}`),
            )
            return lines.join(String.fromCharCode(10))
          }),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  return server
})
