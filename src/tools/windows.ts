import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/server'
import { READ_ONLY, WRITES, WRITES_PERSISTENTLY } from '../support/annotations.js'
import { defineTool } from '../support/define-tool.js'
import { withBidi, withChrome, withPage } from '../support/connection.js'

import { str } from '../support/strings.js'

/**
 * Window geometry, window state and viewport tools.
 */
export function registerWindows(server: McpServer): void {
  defineTool(
    server,
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
        clear: z
          .boolean()
          .optional()
          .describe('Remove the override (sent as viewport=null with devicePixelRatio omitted)'),
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
    }) =>
      await withPage(async (client, context) => {
        const before = await client.evaluate(
          'window.innerWidth + "x" + window.innerHeight + " @dpr" + window.devicePixelRatio',
          context,
        )
        const viewport = clear === true || width === undefined || height === undefined ? null : { width, height }
        // MEASURED (2026-10-17): sending viewport:null AND devicePixelRatio:null together
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

  defineTool(
    server,
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
      const requested = clientWindow === undefined ? null : str(clientWindow, 'clientWindow')
      const state: Record<string, unknown> = {}
      if (x !== undefined) state.x = x
      if (y !== undefined) state.y = y
      if (width !== undefined) state.width = width
      if (height !== undefined) state.height = height
      if (Object.keys(state).length === 0) {
        throw new Error('give at least one of x, y, width, height')
      }
      return await withBidi(async (client) => {
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
          'x: ' +
          String(found.x) +
          '  y: ' +
          String(found.y) +
          String.fromCharCode(10) +
          'width: ' +
          String(found.width) +
          '  height: ' +
          String(found.height)
        )
      })
    },
  )

  defineTool(
    server,
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
    async ({ url, background }: { url?: string; background?: boolean }) =>
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
          'new window: ' +
          context +
          String.fromCharCode(10) +
          'windows now: ' +
          String((before.clientWindows ?? []).length)
        )
      }),
  )

  defineTool(
    server,
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
          .describe(
            'A tab or window context id; the top-level window it belongs to is closed (default: active tab window)',
          ),
      },
      annotations: WRITES,
    },
    async ({ context }: { context?: string }) =>
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
          'closed window ' +
          toClose +
          String.fromCharCode(10) +
          'windows: ' +
          String(before) +
          ' -> ' +
          String(remaining) +
          (remaining === 0 ? String.fromCharCode(10) + 'note: that was the last window — Firefox may now exit' : '')
        )
      }),
  )

  defineTool(
    server,
    'browser_set_window_state',
    {
      title: 'Maximize, minimize, restore or go fullscreen',
      description:
        'Change the window state: normal, maximized, minimized or fullscreen. This is the title-bar buttons and F11, ' +
        'done programmatically. MEASURED: fullscreen is a PROPERTY (window.fullScreen = true), while the others are ' +
        'methods (maximize/minimize/restore). Minimizing hides the window — restore it before interacting again.',
      inputSchema: {
        state: z.enum(['normal', 'maximized', 'minimized', 'fullscreen']).describe('Target window state'),
      },
      annotations: WRITES,
    },
    async ({ state }: { state: 'normal' | 'maximized' | 'minimized' | 'fullscreen' }) => {
      const wanted = str(state, 'state')
      return await withChrome(async (client, chromeContext) => {
        const raw = await client.evaluate(
          '(() => {' +
            ' try {' +
            '  const want = ' +
            JSON.stringify(wanted) +
            ';' +
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
          'window is now ' +
          named +
          ' (' +
          String(info.w) +
          'x' +
          String(info.h) +
          ' at ' +
          String(info.x) +
          ',' +
          String(info.y) +
          ')'
        )
      })
    },
  )

  defineTool(
    server,
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
    async ({ x, y, width, height }: { x: number; y: number; width?: number; height?: number }) =>
      await withChrome(async (client, chromeContext) => {
        const raw = await client.evaluate(
          '(() => {' +
            ' try {' +
            '  window.moveTo(' +
            String(x) +
            ', ' +
            String(y) +
            ');' +
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
        return 'window at ' + String(info.x) + ',' + String(info.y) + ' (' + String(info.w) + 'x' + String(info.h) + ')'
      }),
  )

  defineTool(
    server,
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
    async () =>
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
          'state: ' +
          named +
          String.fromCharCode(10) +
          'position: ' +
          String(info.x) +
          ',' +
          String(info.y) +
          String.fromCharCode(10) +
          'size: ' +
          String(info.w) +
          'x' +
          String(info.h) +
          String.fromCharCode(10) +
          'screen: ' +
          String(info.screen?.w) +
          'x' +
          String(info.screen?.h)
        )
      }),
  )

  defineTool(
    server,
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
    async ({ url, width, height, context: tab }: { url?: string; width?: number; height?: number; context?: string }) =>
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
            '  const target = ' +
            JSON.stringify(url === undefined ? null : url) +
            ';' +
            '  const w = await documentPictureInPicture.requestWindow({' +
            '    width: ' +
            String(width ?? 320) +
            ', height: ' +
            String(height ?? 240) +
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

  defineTool(
    server,
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
    async () =>
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
          'screen: ' +
          String(info.width) +
          'x' +
          String(info.height) +
          ' (usable ' +
          String(info.availWidth) +
          'x' +
          String(info.availHeight) +
          ' at ' +
          String(info.availLeft) +
          ',' +
          String(info.availTop) +
          ')' +
          String.fromCharCode(10) +
          'window: at ' +
          String(info.windowX) +
          ',' +
          String(info.windowY) +
          ' | devicePixelRatio ' +
          String(info.devicePixelRatio) +
          String.fromCharCode(10) +
          'note: only the current screen is exposed; other monitors need coordinates'
        )
      }),
  )

  defineTool(
    server,
    'browser_list_windows',
    {
      title: 'List browser windows',
      description: 'List Firefox windows with their state and geometry (privileged context).',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => JSON.stringify(await withBidi(async (client) => await client.listWindows()), null, 2),
  )
}
