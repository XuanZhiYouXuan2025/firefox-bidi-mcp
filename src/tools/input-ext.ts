import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/server'
import { WRITES } from '../support/annotations.js'
import { defineTool } from '../support/define-tool.js'
import { withBidi, withPage } from '../support/connection.js'
import { text } from '../support/output.js'
import { str } from '../support/strings.js'
import { webdriverKey } from '../support/keys.js'

/**
 * Input actions that need more than a plain click: drag, hold, mouse buttons, HTML5 DnD, file upload.
 */
export function registerInputExt(server: McpServer): void {
  defineTool(
    server,
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
      const css = str(selector, 'selector')
      if (!Array.isArray(files) || files.length === 0) throw new Error('files must be a non-empty array')
      await withPage(async (client, context) => {
        await client.setFiles(css, files, context)
      }, tab)
      return 'attached ' + String(files.length) + ' file(s) to ' + css + ': ' + files.join(', ')
    },
  )

  defineTool(
    server,
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
      const fromSel = fromSelector === undefined ? null : str(fromSelector, 'fromSelector')
      const toSel = toSelector === undefined ? null : str(toSelector, 'toSelector')
      if (fromSel === null && (fromX === undefined || fromY === undefined))
        throw new Error('give fromSelector or fromX/fromY')
      if (toSel === null && (toX === undefined || toY === undefined)) throw new Error('give toSelector or toX/toY')
      return await withBidi(async (client) => {
        const context = tab ?? ((await client.pageContext()) as string)
        const centre = async (sel: string): Promise<{ x: number; y: number }> => {
          const raw = await client.evaluate(
            '(() => { const el = document.querySelector(' +
              JSON.stringify(sel) +
              ');' +
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
          'dragged (' +
          String(start.x) +
          ',' +
          String(start.y) +
          ') -> (' +
          String(end.x) +
          ',' +
          String(end.y) +
          ') in ' +
          String(count) +
          ' steps'
        )
      })
    },
  )

  defineTool(
    server,
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
        modifiers: z
          .array(z.enum(['Control', 'Shift', 'Alt', 'Meta']))
          .optional()
          .describe('Modifiers held at the same time'),
        context: z.string().optional().describe('Tab context id (default: the active tab)'),
      },
      annotations: WRITES,
    },
    async ({
      key,
      durationMs,
      modifiers,
      context: tab,
    }: {
      key: string
      durationMs: number
      modifiers?: string[]
      context?: string
    }) => {
      const main = str(key, 'key')
      const mods = modifiers ?? []
      return await withBidi(async (client) => {
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
      })
    },
  )

  defineTool(
    server,
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
        holdMs: z
          .number()
          .int()
          .min(0)
          .max(10000)
          .optional()
          .describe('Hold the button this long before releasing (default 0)'),
        modifiers: z
          .array(z.enum(['Control', 'Shift', 'Alt', 'Meta']))
          .optional()
          .describe('Modifiers held during the click'),
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
      const sel = selector === undefined ? null : str(selector, 'selector')
      if (sel === null && (x === undefined || y === undefined)) throw new Error('give selector or x/y')
      const which = button ?? 'left'
      const buttonNumber = which === 'right' ? 2 : which === 'middle' ? 1 : 0
      const clicks = count ?? 1
      const hold = holdMs ?? 0
      const mods = modifiers ?? []
      return await withBidi(async (client) => {
        const context = tab ?? ((await client.pageContext()) as string)
        let px = x ?? 0
        let py = y ?? 0
        let label = 'at ' + String(px) + ',' + String(py)
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
          which +
          (clicks > 1 ? ' x' + String(clicks) : '') +
          (hold > 0 ? ' held ' + String(hold) + 'ms' : '') +
          ' on ' +
          label
        )
      })
    },
  )

  defineTool(
    server,
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
        data: z
          .string()
          .optional()
          .describe('Payload to carry in the DataTransfer (default: the text content of the source element)'),
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
      const from = str(fromSelector, 'fromSelector')
      const to = str(toSelector, 'toSelector')
      return await withBidi(async (client) => {
        const context = (await client.pageContext()) as string
        const raw = await client.evaluate(
          '(() => {' +
            ' try {' +
            '  const src = document.querySelector(' +
            JSON.stringify(from) +
            ');' +
            '  const dst = document.querySelector(' +
            JSON.stringify(to) +
            ');' +
            '  if (!src) return JSON.stringify({ error: "no source element: " + ' +
            JSON.stringify(from) +
            ' });' +
            '  if (!dst) return JSON.stringify({ error: "no target element: " + ' +
            JSON.stringify(to) +
            ' });' +
            '  const dt = new DataTransfer();' +
            '  const payload = ' +
            JSON.stringify(data === undefined ? null : data) +
            ';' +
            '  const mime = ' +
            JSON.stringify(mimeType === undefined ? null : mimeType) +
            ';' +
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
          'dispatched HTML5 drag' +
          (info.dropped ? ' (drop was not cancelled by the page)' : ' (page handled drop)') +
          ' from ' +
          String(info.from?.clientX) +
          ',' +
          String(info.from?.clientY) +
          ' to ' +
          String(info.to?.clientX) +
          ',' +
          String(info.to?.clientY) +
          String.fromCharCode(10) +
          'carried data: ' +
          JSON.stringify(info.carried) +
          String.fromCharCode(10) +
          'note: simulated events — isTrusted is false, so pages that check it will refuse'
        )
      })
    },
  )
}
