import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/server'
import { READ_ONLY, WRITES, WRITES_PERSISTENTLY } from '../support/annotations.js'
import { defineTool } from '../support/define-tool.js'
import { withBidi, withPage } from '../support/connection.js'
import { decodePng } from '../support/png.js'
import { failure, text } from '../support/output.js'
import { str } from '../support/strings.js'
import { webdriverKey } from '../support/keys.js'

/**
 * Page-level tools: evaluate, pointer/keyboard input, navigation, capture.
 *
 * Every one of them works inside a single page context, so they depend only on
 * withPage/withBidi and the output wrapper.
 */
export function registerPage(server: McpServer): void {
  defineTool(
    server,
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
    async ({ expression, context }: { expression: string; context?: string }) =>
      JSON.stringify(
        await withPage(async (client, ctx) => await client.evaluate(str(expression, 'expression'), ctx), context),
        null,
        2,
      ),
  )

  defineTool(
    server,
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
      const css = str(selector, 'selector')
      await withPage(async (client, ctx) => {
        await client.clickSelector(css, ctx)
      }, context)
      return `clicked: ${css}`
    },
  )

  defineTool(
    server,
    'browser_type',
    {
      title: 'Type into an element',
      description: 'Focus the element matching a CSS selector and type text with real per-character key events.',
      inputSchema: {
        selector: z.string().describe('CSS selector of the field'),
        text: z.string().describe('Text to type'),
        context: z.string().optional().describe('Tab context id (default: the active tab)'),
      },
      annotations: WRITES,
    },
    async ({ selector, text: value, context }: { selector: string; text: string; context?: string }) => {
      const css = str(selector, 'selector')
      await withPage(async (client, ctx) => {
        await client.typeInto(css, value ?? '', ctx)
      }, context)
      return `typed ${String(value ?? '').length} character(s) into ${css}`
    },
  )

  defineTool(
    server,
    'browser_navigate',
    {
      title: 'Navigate the page',
      description: 'Navigate the active tab to a URL and wait for the page to load.',
      inputSchema: {
        url: z.string().describe('Absolute URL'),
        context: z.string().optional().describe('Tab context id (default: the active tab)'),
        wait: z
          .enum(['none', 'interactive', 'complete'])
          .optional()
          .describe(
            "Load state to wait for (default: complete). Use 'none' for URLs that trigger a download or a cross-origin redirect: those never reach complete and the call would fail with NS_BINDING_ABORTED.",
          ),
      },
      annotations: WRITES_PERSISTENTLY,
    },
    async ({ url, context, wait }: { url: string; context?: string; wait?: 'none' | 'interactive' | 'complete' }) => {
      const target = str(url, 'url')
      let navAborted = false
      const landed = await withPage(async (client, ctx) => {
        // MEASURED: these must use the RESOLVED context from withPage, not the
        // optional tool argument. When the caller omits `context` the argument
        // is undefined and BiDi rejects the command with
        // `Expected "context" to be a string, got [object Undefined]`.
        const nav = await client.navigate(target, ctx, wait)
        navAborted = nav.aborted
        // A navigation can "succeed" while the page itself failed to load
        // (Firefox shows its own error page). Report where we actually ended
        // up so the caller is not misled.
        const title = await client.evaluate('document.title', ctx)
        const href = await client.evaluate('location.href', ctx)
        // Firefox renders its own error page (about:neterror) for a failed
        // load, and the URL/title alone do not reveal that.
        const netError = await client.evaluate("document.documentURI.startsWith('about:neterror')", ctx)
        return { title: String(title), href: String(href), netError: netError === true }
      })
      return (
        `navigated: ${target}` +
        String.fromCharCode(10) +
        `landed on: ${landed.href}` +
        String.fromCharCode(10) +
        `title: ${landed.title}` +
        (navAborted
          ? String.fromCharCode(10) +
            'note: the navigation was cancelled (NS_BINDING_ABORTED) — typically because the URL started a download or a cross-origin redirect. Check the download list to see whether a file arrived.'
          : '') +
        (landed.netError
          ? String.fromCharCode(10) + 'note: the page failed to load — Firefox is showing its own network-error page'
          : '')
      )
    },
  )

  defineTool(
    server,
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
    async ({
      fullPage,
      selector,
      lazyLoad,
      context,
    }: {
      fullPage?: boolean
      selector?: string
      lazyLoad?: boolean
      context?: string
    }) => ({
      body: await withPage(async (client, ctx) => {
        if (fullPage === true || selector !== undefined) {
          return await client.fullPageScreenshot(ctx, selector, lazyLoad ?? true)
        }
        return await client.screenshot(ctx)
      }, context),
      kind: 'png',
    }),
  )

  defineTool(
    server,
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
    async ({
      landscape,
      printBackground,
      context: tab,
    }: {
      landscape?: boolean
      printBackground?: boolean
      context?: string
    }) => ({
      body: await withPage(async (client, context) => {
        const result = (await client.call('browsingContext.print', {
          context,
          background: printBackground ?? true,
          ...(landscape === undefined ? {} : { orientation: landscape ? 'landscape' : 'portrait' }),
        })) as { data?: string }
        if (typeof result?.data !== 'string') throw new Error('print returned no data')
        return 'data:application/pdf;base64,' + result.data
      }, tab),
      kind: 'pdf',
    }),
  )

  defineTool(
    server,
    'browser_pick_color_at',
    {
      title: 'Read the colour of one viewport pixel',
      description:
        'Capture the viewport and return the colour at a CSS-pixel coordinate (x from the left, y from the top). ' +
        'Fully deterministic: it decodes the screenshot in-process, so no eyedropper and no human click is needed. ' +
        'Coordinates are CSS pixels; the screenshot is physical pixels, so devicePixelRatio is applied internally.',
      inputSchema: {
        x: z.number().describe('X in CSS pixels from the left edge of the viewport'),
        y: z.number().describe('Y in CSS pixels from the top edge of the viewport'),
        context: z.string().optional().describe('Tab context id (default: the active tab)'),
      },
      annotations: READ_ONLY,
    },
    async ({ x, y, context }: { x: number; y: number; context?: string }) => {
      const cx = Math.round(x)
      const cy = Math.round(y)
      if (!Number.isFinite(cx) || !Number.isFinite(cy)) throw new Error('x and y must be finite numbers')
      return await withPage(async (client, ctx) => {
        const ratio = Number(await client.evaluate('window.devicePixelRatio', ctx))
        const dpr = Number.isFinite(ratio) && ratio > 0 ? ratio : 1
        const img = decodePng(await client.screenshot(ctx))
        const sx = Math.round(cx * dpr)
        const sy = Math.round(cy * dpr)
        if (sx < 0 || sy < 0 || sx >= img.width || sy >= img.height) {
          throw new Error(
            '(' +
              String(cx) +
              ',' +
              String(cy) +
              ') is outside the captured area: viewport is ' +
              String(Math.floor(img.width / dpr)) +
              'x' +
              String(Math.floor(img.height / dpr)) +
              ' CSS px',
          )
        }
        const i = (sy * img.width + sx) * 4
        const rr = img.rgba[i]
        const gg = img.rgba[i + 1]
        const bb = img.rgba[i + 2]
        const aa = img.rgba[i + 3]
        const hex = '#' + [rr, gg, bb].map((v) => v.toString(16).padStart(2, '0')).join('')
        return (
          '(' +
          String(cx) +
          ',' +
          String(cy) +
          ') -> ' +
          hex +
          '  rgb(' +
          String(rr) +
          ',' +
          String(gg) +
          ',' +
          String(bb) +
          ')' +
          '  alpha ' +
          String(aa) +
          '/255' +
          '  [physical ' +
          String(sx) +
          ',' +
          String(sy) +
          ' of ' +
          String(img.width) +
          'x' +
          String(img.height) +
          ' @dpr ' +
          String(dpr) +
          ']'
        )
      }, context)
    },
  )

  defineTool(
    server,
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
        settleMs: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe('Wait this long after moving, so hover UI can appear (default 150)'),
        context: z.string().optional().describe('Tab context id (default: the active tab)'),
      },
      annotations: WRITES,
    },
    async ({
      selector,
      x,
      y,
      settleMs,
      context: tabContext,
    }: {
      selector?: string
      x?: number
      y?: number
      settleMs?: number
      context?: string
    }) => {
      const sel = selector === undefined ? null : str(selector, 'selector')
      if (sel === null && (x === undefined || y === undefined)) throw new Error('give selector or x/y')
      return await withBidi(async (client) => {
        const context = tabContext ?? ((await client.pageContext()) as string)
        if (!context) throw new Error('no page context available')
        let px = x ?? 0
        let py = y ?? 0
        let label = String(px) + ',' + String(py)
        if (sel !== null) {
          const raw = await client.evaluate(
            '(() => { const el = document.querySelector(' +
              JSON.stringify(sel) +
              ');' +
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
      })
    },
  )

  defineTool(
    server,
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
    async ({
      selector,
      deltaX,
      deltaY,
      context: tabContext,
    }: {
      selector?: string
      deltaX?: number
      deltaY?: number
      context?: string
    }) => {
      const sel = selector === undefined ? null : str(selector, 'selector')
      const dx = deltaX ?? 0
      const dy = deltaY ?? 600
      return await withBidi(async (client) => {
        const context = tabContext ?? ((await client.pageContext()) as string)
        if (!context) throw new Error('no page context available')
        let origin: { x: number; y: number } = { x: 200, y: 200 }
        let label = 'page'
        if (sel !== null) {
          const raw = await client.evaluate(
            '(() => { const el = document.querySelector(' +
              JSON.stringify(sel) +
              ');' +
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
          '(() => { const el = ' +
            (sel === null ? 'null' : 'document.querySelector(' + JSON.stringify(sel) + ')') +
            ';' +
            ' const t = el || document.scrollingElement || document.body;' +
            ' return JSON.stringify({ scrollTop: t.scrollTop, scrollLeft: t.scrollLeft }); })()',
          context,
        )
        return 'scrolled ' + label + ' by (' + String(dx) + ',' + String(dy) + '); now ' + String(after)
      })
    },
  )

  defineTool(
    server,
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
    async ({
      key,
      modifiers,
      repeat,
      context: tabContext,
    }: {
      key: string
      modifiers?: string[]
      repeat?: number
      context?: string
    }) => {
      const main = str(key, 'key')
      const mods = modifiers ?? []
      const times = repeat ?? 1
      return await withBidi(async (client) => {
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
        return 'pressed ' + (mods.length ? mods.join('+') + '+' : '') + main + (times > 1 ? ' x' + String(times) : '')
      })
    },
  )

  defineTool(
    server,
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
      const target = context === undefined ? null : str(context, 'context')
      const limit = maxChars ?? 20000
      return await withBidi(async (client) => {
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
          ' html: document.documentElement.outerHTML.slice(0, ' +
          String(limit) +
          ')' +
          ' })'
        const raw = (await client.evaluate(expression, ctx)) as unknown
        const text_ = typeof raw === 'string' ? raw : JSON.stringify(raw)
        const info = JSON.parse(text_) as { url?: string; length?: number; html?: string }
        return (
          'URL: ' +
          String(info.url) +
          String.fromCharCode(10) +
          'HTML length: ' +
          String(info.length) +
          String.fromCharCode(10) +
          'NOTE: this is the DOM serialisation (outerHTML), not the bytes received over the network.' +
          String.fromCharCode(10) +
          String(info.html ?? '')
        )
      })
    },
  )

  defineTool(
    server,
    'browser_get_page_text',
    {
      title: 'Read the visible text of the page',
      description:
        'Return document.body.innerText (what a human would read, not HTML). Caps at maxLength characters ' +
        '(default 20000); oversized results are written to disk by the output layer. Use browser_page_source ' +
        'when you need the markup instead.',
      inputSchema: {
        maxLength: z.number().int().positive().optional().describe('Max characters to return (default 20000)'),
        context: z.string().optional().describe('Tab context id (default: the active tab)'),
      },
      annotations: READ_ONLY,
    },
    async ({ maxLength, context }: { maxLength?: number; context?: string }) =>
      await withPage(async (client, ctx) => {
        const raw = await client.evaluate('document.body.innerText', ctx)
        const text = typeof raw === 'string' ? raw : ''
        const cap = maxLength ?? 20000
        if (text.length <= cap) return text
        return (
          text.slice(0, cap) +
          String.fromCharCode(10) +
          '[truncated: ' + String(text.length) + ' characters total, ' + String(text.length - cap) + ' omitted; raise maxLength to see more]'
        )
      }, context),
  )

  defineTool(
    server,
    'browser_wait_for',
    {
      title: 'Wait for an element to exist or become visible',
      description:
        'Poll until a CSS selector matches (state "attached") or matches AND is visible (state "visible"), ' +
        'or until timeoutMs elapses. Returns "found: <selector>" or "timeout after Nms". This is the explicit ' +
        'alternative to guessing with setTimeout: prefer waiting for a RESULT marker over waiting for a loading ' +
        'indicator to disappear (the indicator can vanish before loading starts).',
      inputSchema: {
        selector: z.string().describe('CSS selector to wait for'),
        state: z.enum(['attached', 'visible']).optional().describe('attached (default) or visible'),
        timeoutMs: z.number().int().positive().max(120000).optional().describe('Timeout in ms (default 10000)'),
        context: z.string().optional().describe('Tab context id (default: the active tab)'),
      },
      annotations: READ_ONLY,
    },
    async ({ selector, state, timeoutMs, context }: { selector?: string; state?: 'attached' | 'visible'; timeoutMs?: number; context?: string }) =>
      await withPage(async (client, ctx) => {
        const sel = str(selector, 'selector')
        const wantVisible = state === 'visible'
        const timeout = timeoutMs ?? 10000
        const expr =
          'new Promise((resolve) => {' +
          ' const sel = ' + JSON.stringify(sel) + ';' +
          ' const wantVisible = ' + String(wantVisible) + ';' +
          ' const deadline = Date.now() + ' + String(timeout) + ';' +
          ' const check = () => {' +
          '  const el = document.querySelector(sel);' +
          '  if (!el) return false;' +
          '  if (!wantVisible) return true;' +
          '  return !!(el.offsetParent || el.getClientRects().length);' +
          ' };' +
          ' if (check()) return resolve("found");' +
          ' const timer = setInterval(() => {' +
          '  if (check()) { clearInterval(timer); resolve("found"); }' +
          '  else if (Date.now() > deadline) { clearInterval(timer); resolve("timeout"); }' +
          ' }, 100);' +
          '})'
        const result = await client.evaluate(expr, ctx)
        if (result === 'found') return 'found: ' + sel + (wantVisible ? ' (visible)' : '')
        return 'timeout after ' + String(timeout) + 'ms: ' + sel + (wantVisible ? ' (never became visible)' : '')
      }, context),
  )

  defineTool(
    server,
    'browser_fill_form',
    {
      title: 'Fill several form fields at once',
      description:
        'Set values for multiple fields in ONE round trip and fire input/change events so ordinary forms ' +
        'notice the change. MEASURED LIMIT: setting .value directly does not always satisfy framework-controlled ' +
        'inputs (React/Vue) — when the field ignores it, fall back to browser_type for that field, which uses ' +
        'real per-character key events.',
      inputSchema: {
        fields: z
          .array(
            z.object({
              selector: z.string().describe('CSS selector of the field'),
              value: z.string().describe('Value to set'),
            }),
          )
          .min(1)
          .describe('Fields to fill, in order'),
        context: z.string().optional().describe('Tab context id (default: the active tab)'),
      },
      annotations: WRITES,
    },
    async ({ fields, context }: { fields?: Array<{ selector: string; value: string }>; context?: string }) =>
      await withPage(async (client, ctx) => {
        const list = Array.isArray(fields) ? fields : []
        if (list.length === 0) throw new Error('fields must be a non-empty array')
        const expr =
          '(async () => {' +
          ' const items = ' + JSON.stringify(list) + ';' +
          ' const out = [];' +
          ' for (const item of items) {' +
          '  const el = document.querySelector(item.selector);' +
          '  if (!el) { out.push({ selector: item.selector, ok: false, reason: "not found" }); continue; }' +
          '  el.focus();' +
          '  el.value = item.value;' +
          '  el.dispatchEvent(new Event("input", { bubbles: true }));' +
          '  el.dispatchEvent(new Event("change", { bubbles: true }));' +
          '  out.push({ selector: item.selector, ok: true });' +
          ' }' +
          ' return JSON.stringify(out);' +
          '})()'
        const raw = await client.evaluate(expr, ctx)
        return typeof raw === 'string' ? raw : JSON.stringify(raw)
      }, context),
  )


  defineTool(
    server,
    'browser_screencast',
    {
      title: 'Record the tab to individual PNG frames',
      description:
        'Start / capture / stop a BiDi screencast (browsingContext.startScreencast). Firefox pushes one ' +
        'browsingContext.screencastFrame event per frame; "capture" returns the newest frame so far as a PNG. ' +
        'Unlike browser_screenshot (a one-shot capture) this keeps producing frames while the page changes. ' +
        'MEASURED (2026-11-07, Firefox 160.0): startScreencast returns OK but NO screencastFrame events arrive — ' +
        'not on a static page, and not after forcing a navigation/repaint. Treat capture as best-effort until that ' +
        'is diagnosed; browser_screenshot remains the reliable one-shot path. Remember to stop it when finished.',
      inputSchema: {
        action: z.enum(['start', 'capture', 'stop']).describe('start / capture / stop'),
        context: z.string().optional().describe('Tab context id (default: the active tab)'),
      },
      annotations: WRITES,
    },
    async ({ action, context }: { action?: 'start' | 'capture' | 'stop'; context?: string }) => {
      const what = action ?? 'capture'
      if (what === 'capture') {
        // No round trip needed when nothing was recorded yet: read the buffer first.
        const frames = await withBidi(async (client) =>
          client.events('browsingContext.screencastFrame').filter((event) => {
            const params = event.params as { data?: string } | undefined
            return typeof params?.data === 'string' && params.data.length > 0
          }),
        )
        if (frames.length === 0) {
          return 'no screencast frames observed — call { action: "start" } first, then capture'
        }
        const latest = frames[frames.length - 1].params as { data?: string }
        return { body: String(latest.data), kind: 'png' as const }
      }
      return await withPage(async (client, ctx) => {
        if (what === 'start') {
          await client.call('browsingContext.startScreencast', { context: ctx })
          return 'screencast started; frames arrive as browsingContext.screencastFrame events (use action: "capture" to read the newest one)'
        }
        await client.call('browsingContext.stopScreencast', { context: ctx })
        return 'screencast stopped'
      }, context)
    },
  )


  defineTool(
    server,
    'browser_take_snapshot',
    {
      title: 'Snapshot the page with stable element UIDs',
      description:
        'Walk the DOM and return a text outline in which every interactive element carries a UID (@e1, @e2, …). ' +
        'The UID is written to the element as data-dsh-uid, so it stays valid across later snapshots and tool calls ' +
        'until that element is removed or the page navigates. Use the returned UIDs with browser_click_by_uid / ' +
        'browser_fill_by_uid instead of guessing CSS selectors. Read-only.',
      inputSchema: {
        context: z.string().optional().describe('Tab context id (default: the active tab)'),
      },
      annotations: READ_ONLY,
    },
    async ({ context }: { context?: string }) =>
      await withPage(async (client, ctx) => {
        const text = await client.evaluate("(() => {\n  const INTERACTIVE = new Set(['a','button','input','select','textarea','summary','label','option'])\n  const tags = new Set()\n  const lines = []\n  let n = 0\n  const visible = (el) => { try { return !!(el.offsetParent || el.getClientRects().length) } catch { return false } }\n  const nameOf = (el) => {\n    const aria = el.getAttribute('aria-label')\n    if (aria) return aria\n    const ref = el.getAttribute('aria-labelledby')\n    if (ref) { const t = document.getElementById(ref); if (t) return (t.textContent || '').trim() }\n    const tag = el.tagName.toLowerCase()\n    if (tag === 'input' || tag === 'textarea' || tag === 'select') {\n      const id = el.id\n      if (id) { const l = document.querySelector('label[for=\"' + id + '\"]'); if (l) return (l.textContent || '').trim() }\n      const ph = el.getAttribute('placeholder')\n      if (ph) return ph\n      const nm = el.getAttribute('name')\n      if (nm) return nm\n    }\n    const t = (el.textContent || '').trim().replace(/\\s+/g, ' ')\n    return t.length > 60 ? t.slice(0, 57) + '...' : t\n  }\n  const walk = (el, depth) => {\n    if (!el || el.nodeType !== 1) return\n    const tag = el.tagName.toLowerCase()\n    if (tag === 'script' || tag === 'style' || tag === 'noscript') return\n    let st = null\n    try { st = getComputedStyle(el) } catch { st = null }\n    if (st && (st.display === 'none' || st.visibility === 'hidden')) return\n    const role = el.getAttribute('role')\n    const interactive = INTERACTIVE.has(tag) || role === 'button' || role === 'link' || el.getAttribute('onclick') !== null || (el.hasAttribute('tabindex') && el.getAttribute('tabindex') !== '-1')\n    let uid = ''\n    if (interactive && visible(el)) { n += 1; uid = 'e' + n; el.setAttribute('data-dsh-uid', uid); tags.add(uid) }\n    if (uid || depth <= 2) {\n      const parts = ['  '.repeat(depth) + '- ' + tag]\n      const name = nameOf(el)\n      if (name) parts.push('\"' + name + '\"')\n      if (el.id) parts.push('#' + el.id)\n      if (uid) parts.push('@' + uid)\n      lines.push(parts.join(' '))\n    }\n    for (const child of el.children) walk(child, depth + 1)\n  }\n  if (document.body) walk(document.body, 0)\n  window.__dshUidMap = tags\n  return lines.slice(0, 500).join('\\n')\n})()", ctx)
        const body = typeof text === 'string' ? text : String(text ?? '')
        return body === '' ? '(empty page — no body)' : body
      }, context),
  )

  defineTool(
    server,
    'browser_click_by_uid',
    {
      title: 'Click an element by snapshot UID',
      description:
        'Click the element that browser_take_snapshot labelled with this UID, using the same real mouse path as ' +
        'browser_click. The UID resolves through data-dsh-uid, so a stale UID (element removed or page navigated) ' +
        'fails with a clear error instead of clicking the wrong thing.',
      inputSchema: {
        uid: z.string().describe('UID from browser_take_snapshot, e.g. "e3" or "@e3"'),
        context: z.string().optional().describe('Tab context id (default: the active tab)'),
      },
      annotations: WRITES,
    },
    async ({ uid, context }: { uid?: string; context?: string }) => {
      const raw = str(uid, 'uid').replace(/^@/, '')
      const selector = '[data-dsh-uid="' + raw.replace(/"/g, '') + '"]'
      await withPage(async (client, ctx) => {
        const found = await client.evaluate('!!document.querySelector(' + JSON.stringify(selector) + ')', ctx)
        if (found !== true) {
          throw new Error(
            'no element with UID "' + raw + '" — take a fresh snapshot (the element was removed or the page navigated)',
          )
        }
        await client.clickSelector(selector, ctx)
      }, context)
      return 'clicked: @' + raw
    },
  )

  defineTool(
    server,
    'browser_fill_by_uid',
    {
      title: 'Fill an element by snapshot UID',
      description:
        'Focus the field that browser_take_snapshot labelled with this UID and type into it with real per-character ' +
        'key events (same path as browser_type, so framework-controlled inputs react). Use append: true to keep ' +
        'existing content instead of replacing it.',
      inputSchema: {
        uid: z.string().describe('UID from browser_take_snapshot, e.g. "e3" or "@e3"'),
        value: z.string().describe('Text to type'),
        append: z.boolean().optional().describe('Append instead of replacing the current value (default false)'),
        context: z.string().optional().describe('Tab context id (default: the active tab)'),
      },
      annotations: WRITES,
    },
    async ({ uid, value, append, context }: { uid?: string; value?: string; append?: boolean; context?: string }) => {
      const raw = str(uid, 'uid').replace(/^@/, '')
      const selector = '[data-dsh-uid="' + raw.replace(/"/g, '') + '"]'
      const text = value ?? ''
      await withPage(async (client, ctx) => {
        const found = await client.evaluate('!!document.querySelector(' + JSON.stringify(selector) + ')', ctx)
        if (found !== true) {
          throw new Error(
            'no element with UID "' + raw + '" — take a fresh snapshot (the element was removed or the page navigated)',
          )
        }
        if (append !== true) {
          // Select the whole value first so the keystrokes replace it.
          await client.evaluate(
            '(function(){var el=document.querySelector(' + JSON.stringify(selector) + ');if(el){el.focus();if(el.select)el.select();else if(el.value!==undefined){el.value=""}}})()',
            ctx,
          )
        }
        await client.typeInto(selector, text, ctx)
      }, context)
      return (append === true ? 'appended ' : 'typed ') + String(text.length) + ' character(s) into @' + raw
    },
  )

}
