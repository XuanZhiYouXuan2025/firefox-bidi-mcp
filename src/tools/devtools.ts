import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { join } from 'node:path'
import { READ_ONLY, WRITES } from '../support/annotations.js'
import { defineTool } from '../support/define-tool.js'
import { withBidi, withChrome } from '../support/connection.js'
import { tabIndexForContext } from '../support/dom.js'
import { text } from '../support/output.js'
import { port } from '../support/port.js'
import { str } from '../support/strings.js'

/**
 * DevTools toolbox, about: pages, DOM/a11y trees and RDM/eyedropper.
 */
export function registerDevtools(server: McpServer): void {
  defineTool(
    server,
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
      return tools.map((tool) => tool.id + '  —  ' + tool.label).join(String.fromCharCode(10))
    },
  )

  defineTool(
    server,
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
            '  const tab = ' +
            (index < 0 ? 'gBrowser.selectedTab' : 'gBrowser.tabs[' + String(index) + ']') +
            ';' +
            '  if (!tab) return JSON.stringify({ error: "tab not found" });' +
            '  const toolbox = await gDevTools.showToolboxForTab(tab, { toolId: ' +
            JSON.stringify(toolId) +
            ' });' +
            '  return JSON.stringify({ ok: true, currentTool: toolbox ? toolbox.currentToolId : null });' +
            ' } catch (e) { return JSON.stringify({ error: e.message }); }' +
            ' })()',
          chromeContext,
        )
      })
      if (typeof raw !== 'string') throw new Error('devtools open returned nothing')
      const info = JSON.parse(raw) as { error?: string; currentTool?: string | null }
      if (info.error !== undefined) throw new Error(info.error)
      return 'DevTools opened on panel: ' + String(info.currentTool ?? toolId)
    },
  )

  defineTool(
    server,
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
              ' const tab = ' +
              (index < 0 ? 'gBrowser.selectedTab' : 'gBrowser.tabs[' + String(index) + ']') +
              ';' +
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
      if (info.all === true) return 'closed all DevTools toolboxes'
      return info.had === true ? 'closed the DevTools toolbox' : 'no toolbox was open for that tab'
    },
  )

  defineTool(
    server,
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
      const name = str(page, 'page')
      const url = 'about:' + name
      return await withChrome(async (client, chromeContext) => {
        const raw = await client.evaluate(
          '(() => {' +
            ' try {' +
            '  const tab = gBrowser.addTab(' +
            JSON.stringify(url) +
            ', {' +
            '    triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),' +
            '    inBackground: ' +
            (background === true ? 'true' : 'false') +
            '' +
            '  });' +
            '  return "opened " + ' +
            JSON.stringify(url) +
            ';' +
            ' } catch (e) { return "ERR " + e.message; }' +
            ' })()',
          chromeContext,
        )
        if (typeof raw !== 'string') throw new Error('open about page returned nothing')
        if (raw.startsWith('ERR ')) throw new Error(raw.slice(4))
        return raw
      })
    },
  )

  defineTool(
    server,
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
      const name = str(page, 'page')
      const limit = maxChars ?? 600
      const url = 'about:' + name
      return await withBidi(async (client) => {
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
            ' text: document.body ? document.body.innerText.replace(/\\s+/g, " ").slice(0, ' +
            String(limit) +
            ') : null,' +
            ' bodyLen: document.body ? document.body.innerText.length : 0' +
            ' })',
          context,
        )) as unknown
        return typeof raw === 'string' ? raw : JSON.stringify(raw)
      })
    },
  )

  defineTool(
    server,
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
            '  const action = ' +
            JSON.stringify(what) +
            ';' +
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
      if (info.opened === true) return 'Browser Console opened (standalone devtools:webconsole window)'
      if (info.closed === true) return 'Browser Console closed'
      return 'Browser Console toggled'
    },
  )

  defineTool(
    server,
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
            '  const tab = ' +
            (index < 0 ? 'win.gBrowser.selectedTab' : 'win.gBrowser.tabs[' + String(index) + ']') +
            ';' +
            '  if (!tab) return JSON.stringify({ error: "tab not found" });' +
            '  const action = ' +
            JSON.stringify(what) +
            ';' +
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
        return (
          'active: ' +
          String(info.active) +
          String.fromCharCode(10) +
          'open tabs: ' +
          String(info.activeCount) +
          String.fromCharCode(10) +
          'RDM markup present: ' +
          String(info.domPresent)
        )
      }
      return (
        'Responsive Design Mode ' +
        String(info.action) +
        String.fromCharCode(10) +
        'active: ' +
        String(info.active) +
        String.fromCharCode(10) +
        'RDM markup present: ' +
        String(info.domPresent)
      )
    },
  )

  defineTool(
    server,
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
        action: z
          .enum(['start', 'result', 'cancel'])
          .describe('start = arm the picker, result = read the colour, cancel = abort'),
        context: z.string().optional().describe('Tab (default: the active tab)'),
      },
      annotations: WRITES,
    },
    async ({ action, context }: { action: 'start' | 'result' | 'cancel'; context?: string }) => {
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
            '  const action = ' +
            JSON.stringify(what) +
            ';' +
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
            '  const tab = ' +
            (index < 0 ? 'win.gBrowser.selectedTab' : 'win.gBrowser.tabs[' + String(index) + ']') +
            ';' +
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
        return (
          'colour picker armed' +
          String.fromCharCode(10) +
          'click anywhere on the page to pick a colour, then call action:"result"' +
          String.fromCharCode(10) +
          'press Escape (or call action:"cancel") to abort'
        )
      }
      if (what === 'cancel') return 'colour picker cancelled'
      if (info.failed) return 'the picker failed: ' + String(info.failed)
      if (info.picked) {
        const picked = info.picked as { color?: string }
        return 'picked colour: ' + String(picked.color ?? JSON.stringify(info.picked))
      }
      if (info.canceled === true) return 'picking was cancelled before a colour was chosen'
      return 'no colour yet — the picker is still armed; click on the page first'
    },
  )

  defineTool(
    server,
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
        port: z
          .number()
          .int()
          .min(1)
          .max(65535)
          .optional()
          .describe('Port to use when enabling (default keeps current)'),
      },
      annotations: WRITES,
    },
    async ({ action, port }: { action: 'status' | 'enable' | 'disable'; port?: number }) => {
      const what = str(action, 'action')
      const requestedPort = port === undefined ? null : port
      const raw = await withChrome(async (client, chromeContext) => {
        return client.evaluate(
          '(() => {' +
            ' try {' +
            '  const action = ' +
            JSON.stringify(what) +
            ';' +
            '  const getInt = (name, fallback) => { try { return Services.prefs.getIntPref(name); } catch (e) { return fallback; } };' +
            '  const getBool = (name, fallback) => { try { return Services.prefs.getBoolPref(name); } catch (e) { return fallback; } };' +
            '  if (action === "enable") {' +
            '    if (' +
            String(requestedPort) +
            ' !== null) Services.prefs.setIntPref("devtools.debugger.remote-port", ' +
            String(requestedPort) +
            ');' +
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
      return (
        'remote debugging enabled: ' +
        String(info.enabled) +
        String.fromCharCode(10) +
        'port: ' +
        String(info.port) +
        String.fromCharCode(10) +
        'host: ' +
        String(info.host ?? '(unset)') +
        String.fromCharCode(10) +
        'devtools.chrome.enabled: ' +
        String(info.chromeEnabled) +
        String.fromCharCode(10) +
        'DevTools server module available: ' +
        String(info.hasServer) +
        (info.serverPath ? ' (' + String(info.serverPath) + ')' : '')
      )
    },
  )

  defineTool(
    server,
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
      const wanted = context === undefined ? null : str(context, 'context')
      const css = str(selector, 'selector')
      const dx = offsetX ?? 0
      const dy = offsetY ?? 0
      return await withBidi(async (client) => {
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
          const hit = flat.find((node) => node.context === wanted || (node.url ?? '').indexOf(wanted) !== -1)
          if (hit === undefined) throw new Error('no open tab matches: ' + wanted)
          ctx = hit.context
        }
        if (ctx === null) throw new Error('no page context available')
        const expression =
          'JSON.stringify((() => {' +
          ' const el = document.querySelector(' +
          JSON.stringify(css) +
          ');' +
          ' if (!el) return { error: "element not found" };' +
          ' const r = el.getBoundingClientRect();' +
          ' el.scrollIntoView({ block: "center", inline: "center" });' +
          ' const r2 = el.getBoundingClientRect();' +
          ' const ox = window.mozInnerScreenX || 0;' +
          ' const oy = window.mozInnerScreenY || 0;' +
          ' return {' +
          '  screenX: Math.round(ox + r2.left + r2.width / 2 + ' +
          String(dx) +
          '),' +
          '  screenY: Math.round(oy + r2.top + r2.height / 2 + ' +
          String(dy) +
          '),' +
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
          'screen centre: (' +
          String(info.screenX) +
          ', ' +
          String(info.screenY) +
          ')' +
          String.fromCharCode(10) +
          'element rect: ' +
          JSON.stringify(info.rect) +
          String.fromCharCode(10) +
          'inner screen origin: ' +
          JSON.stringify(info.innerScreen) +
          String.fromCharCode(10) +
          'devicePixelRatio: ' +
          String(info.devicePixelRatio) +
          ' (already accounted for — do NOT scale the coordinates again)' +
          String.fromCharCode(10) +
          'feed these numbers to a native click/drag; WebDriver events will not work for eyedropper or HTML5 drag-and-drop'
        )
      })
    },
  )

  defineTool(
    server,
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
    async ({ maxDepth, maxNodes, context }: { maxDepth?: number; maxNodes?: number; context?: string }) => {
      const depth = maxDepth ?? 4
      const budget = maxNodes ?? 120
      const wanted = context === undefined ? null : str(context, 'context')
      const raw = await withChrome(async (client, chromeContext) => {
        return client.evaluate(
          '(async () => {' +
            ' try {' +
            '  const w = Services.wm.getMostRecentWindow("navigator:browser");' +
            '  let tab = w.gBrowser.selectedTab;' +
            '  const wanted = ' +
            (wanted === null ? 'null' : JSON.stringify(wanted)) +
            ';' +
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
            '    if (!node || visited >= ' +
            String(budget) +
            ' || level > ' +
            String(depth) +
            ') return;' +
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
            '      if (visited >= ' +
            String(budget) +
            ') break;' +
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
      return 'nodes: ' + String(info.count) + String.fromCharCode(10) + (info.lines ?? []).join(String.fromCharCode(10))
    },
  )

  defineTool(
    server,
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
            '    if (!node || visited >= ' +
            String(budget) +
            ' || level > ' +
            String(depth) +
            ') return;' +
            '    visited++;' +
            '    lines.push("  ".repeat(level) + (node.role || "?") + "  " + (node.name || ""));' +
            '    if (!node.childCount) return;' +
            '    let children = [];' +
            '    try {' +
            '      children = await node.children();' +
            '    } catch (e) { return; }' +
            '    for (const child of (children || [])) {' +
            '      if (visited >= ' +
            String(budget) +
            ') break;' +
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
      return 'nodes: ' + String(info.count) + String.fromCharCode(10) + (info.lines ?? []).join(String.fromCharCode(10))
    },
  )
}
