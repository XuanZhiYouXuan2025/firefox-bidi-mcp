/**
 * Minimal WebDriver BiDi client for Firefox.
 *
 * Firefox exposes BiDi at `ws://127.0.0.1:<port>/session` once it is started
 * with `--remote-debugging-port`. Two facts learned the hard way (see the
 * task records) and encoded here:
 *
 *  - Privileged ("chrome") contexts need `MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1`
 *    at launch AND an explicit `moz:scope: "chrome"` on the request; without
 *    that parameter you only ever see window realms, which is easy to
 *    misread as "BiDi cannot reach the browser chrome".
 *  - A BiDi session is NOT released when the socket closes. It must be ended
 *    with `session.end`, otherwise the next `session.new` fails with
 *    "session not created". Hence `close()` always tries to end it.
 */

import WebSocket from 'ws'

/** Bytes of a segment data URL appended to the page per evaluate call. */
const CHUNK = 8000

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

interface BidiMessage {
  id?: number
  method?: string
  params?: unknown
  error?: string
  message?: string
  result?: Record<string, unknown>
}

/** One server-pushed event (BiDi messages without an id). */
export interface BidiEvent {
  method: string
  params: unknown
  at: number
}

/**
 * Convert a WebDriver BiDi value tree into a plain JavaScript value.
 *
 * BiDi serialises remote values by type: objects arrive as `[key, value]`
 * pair lists and arrays as typed records, so a script returning `{a: 1}`
 * would otherwise surface as `[["a", {type: "number", value: 1}]]`.
 */
function unwrapValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  const record = value as { type?: string; value?: unknown }
  switch (record.type) {
    case 'undefined':
      return undefined
    case 'null':
      return null
    case 'string':
    case 'boolean':
    case 'number':
    case 'bigint':
      return record.value
    case 'array':
      return (record.value as unknown[]).map(unwrapValue)
    case 'object':
      return Object.fromEntries(
        (record.value as Array<[string, unknown]>).map(([key, item]) => [key, unwrapValue(item)]),
      )
    case 'node': {
      // Remote element reference. The bulky `value` snapshot is dropped, but
      // the sharedId must survive: it is the handle other commands need.
      const node = value as { sharedId?: string }
      return { type: 'node', sharedId: node.sharedId }
    }
    default:
      return record.value ?? value
  }
}

export class BidiClient {
  #ws: WebSocket | null = null
  #nextId = 1
  readonly #pending = new Map<number, Pending>()
  readonly #events: BidiEvent[] = []
  #sessionId: string | null = null

  async connect(port = 9222, timeoutMs = 20000): Promise<void> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/session`)
    // Note: `ws` deliberately sends no Origin header, which is what Firefox
    // wants here — an Origin of the endpoint itself is rejected with 400.
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('BiDi connect timed out')), timeoutMs)
      ws.once('open', () => {
        clearTimeout(timer)
        resolve()
      })
      ws.once('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
    })

    ws.on('message', (raw: WebSocket.RawData) => {
      let message: BidiMessage
      try {
        message = JSON.parse(String(raw)) as BidiMessage
      } catch {
        return
      }
      if (typeof message.id !== 'number') {
        // Server-pushed event: keep the most recent ones so tools can report
        // what the browser did between calls (downloads, for example).
        if (typeof message.method === 'string') {
          this.#events.push({ method: message.method, params: message.params, at: Date.now() })
          if (this.#events.length > 500) this.#events.splice(0, this.#events.length - 500)
        }
        return
      }
      const pending = this.#pending.get(message.id)
      if (pending === undefined) return
      this.#pending.delete(message.id)
      if (message.error !== undefined) {
        pending.reject(new Error(`${message.error}: ${message.message ?? ''}`))
      } else {
        pending.resolve(message.result)
      }
    })

    this.#ws = ws
    const result = (await this.call('session.new', { capabilities: {} })) as { sessionId?: string }
    this.#sessionId = result?.sessionId ?? null
  }

  call(method: string, params: Record<string, unknown> = {}, timeoutMs = 30000): Promise<unknown> {
    const ws = this.#ws
    if (ws === null) return Promise.reject(new Error('BiDi is not connected'))
    const id = this.#nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new Error(`${method} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.#pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
      ws.send(JSON.stringify({ id, method, params }))
    })
  }

  /**
   * The tab the user is actually looking at (no chrome scope).
   *
   * Two things make the obvious choice wrong:
   *  - `browsingContext.getTree` returns top-level contexts in tab-strip order
   *    (and one per window), so `contexts[0]` is just the leftmost tab;
   *  - with several windows open EVERY window reports `document.visibilityState
   *    === 'visible'`, so visibility alone cannot pick the window either.
   *
   * So the active window is resolved through `browser.getClientWindows` first,
   * then the visible tab inside it. Falls back progressively if either step is
   * unavailable.
   */
  async pageContext(): Promise<string | null> {
    const result = (await this.call('browsingContext.getTree', { maxDepth: 1 })) as {
      contexts?: Array<{ context?: string; clientWindow?: string }>
    }
    const all = result?.contexts ?? []

    let activeWindow: string | null = null
    try {
      const windows = (await this.call('browser.getClientWindows', {})) as {
        clientWindows?: Array<{ clientWindow?: string; active?: boolean }>
      }
      activeWindow = windows?.clientWindows?.find((item) => item.active === true)?.clientWindow ?? null
    } catch {
      // Older Firefox may not expose client windows; fall back to tab order.
    }

    const inActiveWindow =
      activeWindow === null ? [] : all.filter((item) => item.clientWindow === activeWindow)
    const candidates = inActiveWindow.length > 0 ? inActiveWindow : all

    for (const item of candidates) {
      if (item.context === undefined) continue
      try {
        const visible = await this.evaluate("document.visibilityState === 'visible'", item.context)
        if (visible === true) return item.context
      } catch {
        // A tab can be closing or unresponsive; try the next one.
      }
    }
    return candidates[0]?.context ?? all[0]?.context ?? null
  }

  /**
   * A privileged ("chrome") context.
   *
   * Returns null when Firefox was not launched with
   * `MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1` — that is a missing launch flag, not a
   * missing capability.
   */
  async chromeContext(): Promise<string | null> {
    const result = (await this.call('browsingContext.getTree', {
      'moz:scope': 'chrome',
      maxDepth: 1,
    })) as { contexts?: Array<{ context?: string }> }
    return result?.contexts?.[0]?.context ?? null
  }

  /**
   * Evaluate a script in a context (page or chrome) and return its value.
   *
   * Two BiDi behaviours are handled here so callers never mistake failure for
   * success:
   *  - a script that throws comes back as a *successful* response of type
   *    `exception`; this raises instead of returning undefined;
   *  - a returned object/array arrives as a WebDriver value tree; this unwraps
   *    it into a plain value.
   */
  async evaluate(expression: string, context: string): Promise<unknown> {
    const result = (await this.call('script.evaluate', {
      expression,
      target: { context },
      awaitPromise: true,
    })) as {
      type?: string
      result?: unknown
      exceptionDetails?: { text?: string; exception?: { description?: string } }
    }
    if (result?.type === 'exception') {
      const details = result.exceptionDetails
      throw new Error(
        `script exception: ${details?.exception?.description ?? details?.text ?? 'unknown'}`,
      )
    }
    return unwrapValue(result?.result)
  }

  /**
   * Click an element by CSS selector with a REAL mouse action.
   *
   * `element.click()` from script would work too, but real input goes through
   * the same path a user takes (hover/pointer events, focus), so pages that
   * check `isTrusted` behave the same. Coordinates come from the element box.
   */
  async clickSelector(selector: string, context: string): Promise<void> {
    // NOTE: BiDi serialises object results as a WebDriver value tree, so a
    // plain object comes back as a list rather than `{x, y}`. Returning a JSON
    // *string* keeps this simple and unambiguous.
    const raw = await this.evaluate(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)});` +
        ` if (!el) return ''; const r = el.getBoundingClientRect();` +
        ` return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 }); })()`,
      context,
    )
    const box = typeof raw === 'string' && raw.length > 0 ? (JSON.parse(raw) as { x: number; y: number }) : null
    if (box === null || typeof box.x !== 'number' || typeof box.y !== 'number') {
      throw new Error(`selector did not match a visible element: ${selector}`)
    }
    await this.call('input.performActions', {
      context,
      actions: [
        {
          type: 'pointer',
          id: 'mouse',
          parameters: { pointerType: 'mouse' },
          actions: [
            { type: 'pointerMove', x: Math.round(box.x), y: Math.round(box.y) },
            { type: 'pointerDown', button: 0 },
            { type: 'pointerUp', button: 0 },
          ],
        },
      ],
    })
  }

  /**
   * PNG of the given context as a data URL.
   *
   * `captureScreenshot` returns bare base64 while `canvas.toDataURL` (used for
   * stitched full-page shots) returns a `data:` URL; the prefix is added here so
   * every image-returning method answers in the same, directly usable form.
   */
  async screenshot(context: string): Promise<string> {
    const result = (await this.call('browsingContext.captureScreenshot', { context })) as {
      data?: string
    }
    if (typeof result?.data !== 'string') throw new Error('screenshot returned no data')
    return 'data:image/png;base64,' + result.data
  }

  /** Client windows with their state and geometry. */
  async listWindows(): Promise<Array<Record<string, unknown>>> {
    const result = (await this.call('browser.getClientWindows', {})) as {
      clientWindows?: Array<Record<string, unknown>>
    }
    return result?.clientWindows ?? []
  }

  /** Navigate the given context and wait for load. */
  async navigate(url: string, context: string): Promise<void> {
    await this.call('browsingContext.navigate', { context, url, wait: 'complete' }, 60000)
  }

  /** Top-level contexts (tabs), in browser order. */
  async listTabs(): Promise<Array<{ context: string; url?: string; title?: string }>> {
    const result = (await this.call('browsingContext.getTree', { maxDepth: 1 })) as {
      contexts?: Array<{ context: string; url?: string; children?: unknown[] }>
    }
    const tabs: Array<{ context: string; url?: string; title?: string }> = []
    for (const item of result?.contexts ?? []) {
      let title: string | undefined
      try {
        const value = await this.evaluate('document.title', item.context)
        if (typeof value === 'string') title = value
      } catch {
        // A tab can be closed or still loading between calls; leave the title out.
      }
      tabs.push({ context: item.context, url: item.url, title })
    }
    return tabs
  }

  /**
   * Open a new tab.
   *
   * `background` defaults to false: a tab opened because someone asked for it
   * should be the one they end up looking at. (Verified: `background: true`
   * leaves `document.visibilityState` at "hidden".)
   */
  async newTab(url?: string, background = false): Promise<string> {
    const result = (await this.call('browsingContext.create', {
      type: 'tab',
      background,
    })) as { context?: string }
    const context = result?.context
    if (context === undefined) throw new Error('browsingContext.create returned no context')
    if (url !== undefined) await this.navigate(url, context)
    return context
  }

  /**
   * Focus an element and type text into it with real key events.
   *
   * Real per-character key events are slower than setting `value`, but pages
   * that listen for `keydown`/`input` (and frameworks with controlled inputs)
   * only react to the real thing.
   */
  async typeInto(selector: string, textToType: string, context: string): Promise<void> {
    await this.clickSelector(selector, context)
    const actions = [...textToType].map((character) => [
      { type: 'keyDown' as const, value: character },
      { type: 'keyUp' as const, value: character },
    ]).flat()
    await this.call('input.performActions', {
      context,
      actions: [{ type: 'key', id: 'keyboard', actions }],
    })
  }

  /**
   * Capture a whole scrollable area, in segments, and stitch them in the page.
   *
   * Two modes share one path:
   *  - `document` when `selector` is omitted (the scrolling element);
   *  - an element when `selector` is given — an `overflow: scroll` container
   *    does NOT change `document.scrollTop`, so document-only scrolling misses
   *    everything inside one.
   *
   * Segmentation is unavoidable: Firefox's `captureScreenshot` only ever grabs
   * the visible viewport (it ignores `clip`), which is also how the Capture X
   * extension works — it scrolls and stitches on a canvas.
   *
   * Each segment's data URL is pushed into the page with its own small
   * expression, then one final call stitches them; sending every segment in a
   * single expression would mean a multi-megabyte script.
   */
  async fullPageScreenshot(context: string, selector?: string, lazyLoad = true): Promise<string> {
    const target =
      selector === undefined
        ? 'document.scrollingElement'
        : 'document.querySelector(' + JSON.stringify(selector) + ')'
    const measure = await this.evaluate(
      '(() => { const el = ' + target + ';' +
        ' if (!el) return null;' +
        ' const isDoc = el === document.scrollingElement;' +
        ' const r = isDoc ? { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight } : el.getBoundingClientRect();' +
        ' return JSON.stringify({ scrollHeight: el.scrollHeight, clientHeight: el.clientHeight,' +
        ' scrollTop: el.scrollTop, dpr: window.devicePixelRatio || 1,' +
        ' rect: { x: r.left, y: r.top, width: r.width, height: r.height }, isDoc }); })()',
      context,
    )
    if (typeof measure !== 'string' || measure.length === 0) {
      throw new Error(selector === undefined ? 'no scrolling element' : 'selector matched nothing: ' + selector)
    }
    const info = JSON.parse(measure) as {
      scrollHeight: number
      clientHeight: number
      scrollTop: number
      dpr: number
      rect: { x: number; y: number; width: number; height: number }
      isDoc: boolean
    }
    // Many long pages grow as you scroll (infinite lists, lazy images). Walking
    // the area once first, and waiting until its height settles, is what makes
    // the capture below complete rather than "whatever was loaded at the time".
    // Capture X does the same thing; here the original offset is restored after.
    if (lazyLoad) {
      const probe = info.isDoc
        ? '(() => { window.scrollTo(0, document.scrollingElement.scrollHeight); return document.scrollingElement.scrollHeight; })()'
        : '(() => { const el = ' + target + '; el.scrollTop = el.scrollHeight; return el.scrollHeight; })()'
      let previous = -1
      for (let round = 0; round < 6; round++) {
        const height = (await this.evaluate(probe, context)) as number
        await this.evaluate(
          'new Promise(r => setTimeout(r, 400))',
          context,
        )
        if (typeof height === 'number' && height === previous) break
        previous = typeof height === 'number' ? height : previous
      }
      // Measurements taken before the growth are stale.
      const again = await this.evaluate(
        '(() => { const el = ' + target + ';' +
          ' return JSON.stringify({ scrollHeight: el.scrollHeight, clientHeight: el.clientHeight }); })()',
        context,
      )
      if (typeof again === 'string' && again.length > 0) {
        const fresh = JSON.parse(again) as { scrollHeight: number; clientHeight: number }
        info.scrollHeight = fresh.scrollHeight
        info.clientHeight = fresh.clientHeight
      }
    }

    const total = info.scrollHeight
    const step = Math.max(1, info.clientHeight - 2) // small overlap so no row is lost at a seam
    const offsets: number[] = []
    for (let y = 0; y < total; y += step) offsets.push(y)
    if (offsets.length === 0) offsets.push(0)

    await this.evaluate('window.__dshShot = { segs: [] }; true', context)
    const scrollExpr = (y: number) =>
      info.isDoc
        ? 'window.scrollTo(0, ' + String(y) + '); true'
        : '(() => { const el = ' + target + '; el.scrollTop = ' + String(y) + '; return true; })()'

    try {
      for (const offset of offsets) {
        await this.evaluate(scrollExpr(offset), context)
        await this.evaluate('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))', context)
        const data = await this.screenshot(context)
        // In element mode the screenshot is the whole viewport, so the element's
        // on-screen box is what gets copied out of it.
        const sx = info.isDoc ? 0 : info.rect.x * info.dpr
        const sy = info.isDoc ? 0 : info.rect.y * info.dpr
        const sw = info.isDoc ? info.rect.width * info.dpr : info.rect.width * info.dpr
        const sh = info.isDoc
          ? Math.min(step, Math.max(0, total - offset)) * info.dpr
          : Math.min(step, Math.max(0, total - offset)) * info.dpr
        const dy = offset * info.dpr
        // A whole segment data URL can exceed what one evaluate expression
        // tolerates (measured: a 131k-character expression made the image fail
        // to decode), so the string is appended in bounded chunks first.
        await this.evaluate('window.__dshShot.pending = ""; true', context)
        for (let at = 0; at < data.length; at += CHUNK) {
          await this.evaluate(
            'window.__dshShot.pending += ' + JSON.stringify(data.slice(at, at + CHUNK)) + '; true',
            context,
          )
        }
        await this.evaluate(
          'window.__dshShot.segs.push(Object.assign({ dataUrl: window.__dshShot.pending }, ' +
            JSON.stringify({ sx, sy, sw, sh, dy }) +
            ')); window.__dshShot.pending = ""; window.__dshShot.segs.length',
          context,
        )
      }
      const stitched = await this.evaluate(
        '(async () => { const shot = window.__dshShot; const dpr = ' + String(info.dpr) + ';' +
          ' const w = Math.round(' + String(info.rect.width) + ' * dpr);' +
          ' const h = Math.round(' + String(total) + ' * dpr);' +
          ' const canvas = document.createElement("canvas"); canvas.width = w; canvas.height = h;' +
          ' const ctx = canvas.getContext("2d");' +
          ' for (const seg of shot.segs) {' +
          '   const img = await new Promise((res, rej) => { const i = new Image();' +
          ' i.onload = () => res(i);' +
          ' i.onerror = () => rej(new Error("segment decode failed: len=" + seg.dataUrl.length + " head=" + seg.dataUrl.slice(0, 24) + " expected=" + (seg.sw|0) + "x" + (seg.sh|0) + " at dy=" + (seg.dy|0)));' +
          ' i.src = seg.dataUrl; });' +
          '   ctx.drawImage(img, seg.sx, seg.sy, seg.sw, seg.sh, 0, seg.dy, seg.sw, seg.sh);' +
          ' }' +
          ' const out = canvas.toDataURL("image/png");' +
          ' window.__dshShot = null; const ta = document.querySelector("#__dsh_out"); if (ta) ta.remove();' +
          ' return out; })()',
        context,
      )
      if (typeof stitched !== 'string' || stitched.length === 0) throw new Error('stitching produced no image')
      return stitched
    } finally {
      // Put the page back the way we found it.
      if (!info.isDoc) {
        await this.evaluate(scrollExpr(info.scrollTop), context).catch(() => undefined)
      } else {
        await this.evaluate('window.scrollTo(0, ' + String(info.scrollTop) + '); true', context).catch(
          () => undefined,
        )
      }
    }
  }

  /**
   * The `sharedId` of the first element matching a CSS selector.
   *
   * Element references are per-session handles; `script.evaluate` returns them
   * as a node value, and this is the handle `input.setFiles` (and `getElement`
   * style commands) expect.
   */
  async elementRef(selector: string, context: string): Promise<string> {
    const result = (await this.call('script.evaluate', {
      expression: 'document.querySelector(' + JSON.stringify(selector) + ')',
      target: { context },
      awaitPromise: false,
    })) as { result?: { type?: string; sharedId?: string } }
    const sharedId = result?.result?.sharedId
    if (typeof sharedId !== 'string') {
      throw new Error('selector matched no element: ' + selector)
    }
    return sharedId
  }

  /**
   * Attach a file to a file input.
   *
   * NOTE (measured on Windows): the path must be a NATIVE path
   * (`D:\dir\file.txt`). A `file:///D:/...` URL is rejected with
   * "File error: Unrecognized path".
   */
  async setFiles(selector: string, files: string[], context: string): Promise<void> {
    const sharedId = await this.elementRef(selector, context)
    await this.call('input.setFiles', { context, element: { sharedId }, files })
  }

  readonly #intercepts = new Set<string>()
  readonly #continued = new Set<string>()

  /** Remember an intercept id so a later stop can remove it. */
  trackIntercept(id: string): void {
    this.#intercepts.add(id)
  }

  trackedIntercepts(): string[] {
    return [...this.#intercepts]
  }

  clearIntercepts(): void {
    this.#intercepts.clear()
  }

  /**
   * Continue every request currently held by interception.
   *
   * A held request is one whose `network.beforeRequestSent` event carries a
   * non-empty `intercepts` list. Requests already continued are remembered so a
   * second call cannot continue the same request twice (which would error).
   */
  async continueAllRequestIds(): Promise<number> {
    let released = 0
    for (const event of this.#events) {
      if (event.method !== 'network.beforeRequestSent') continue
      const params = event.params as { request?: { request?: string }; intercepts?: unknown[] } | undefined
      const id = params?.request?.request
      const held = Array.isArray(params?.intercepts) && params.intercepts.length > 0
      if (typeof id !== 'string' || !held || this.#continued.has(id)) continue
      this.#continued.add(id)
      try {
        await this.call('network.continueRequest', { request: id })
        released++
      } catch {
        // The request may already have failed or been replaced; ignore.
      }
    }
    return released
  }

  /** Subscribe to server-pushed events (idempotent per event name). */
  async subscribe(events: string[]): Promise<void> {
    await this.call('session.subscribe', { events })
  }

  /** Buffered events, newest last. `method` filters by exact name when given. */
  events(method?: string): BidiEvent[] {
    return method === undefined ? [...this.#events] : this.#events.filter((e) => e.method === method)
  }

  async close(): Promise<void> {
    try {
      if (this.#sessionId !== null) await this.call('session.end', {}, 5000)
    } catch {
      // Ending the session is best-effort; the socket still gets closed.
    }
    this.#sessionId = null
    this.#ws?.close()
    this.#ws = null
  }
}
