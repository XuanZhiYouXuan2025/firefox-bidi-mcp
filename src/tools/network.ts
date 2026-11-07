import { z } from 'zod'
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib'
import type { McpServer } from '@modelcontextprotocol/server'
import { READ_ONLY, WRITES, WRITES_PERSISTENTLY } from '../support/annotations.js'
import { defineTool } from '../support/define-tool.js'
import { withBidi, withChrome } from '../support/connection.js'
import { responseHeader } from '../support/dom.js'
import { text } from '../support/output.js'
import { str } from '../support/strings.js'

/**
 * Network observation, interception and download tools.
 */
export function registerNetwork(server: McpServer): void {
  defineTool(
    server,
    'browser_set_download_dir',
    {
      title: 'Set the download directory',
      // RESOLVED (2026-10-17): earlier attempts appeared to 'hang' purely because the caller sent
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
            ' file.initWithPath(' +
            JSON.stringify(dir.replaceAll('/', String.fromCharCode(92))) +
            ');' +
            ' Services.prefs.setComplexValue("browser.download.dir", Ci.nsIFile, file);' +
            ' Services.prefs.setIntPref("browser.download.folderList", 2);' +
            ' Services.prefs.setBoolPref("browser.download.useDownloadDir", true);' +
            ' return file.path; })()',
          context,
        )
      })
      return 'downloads will go to: ' + dir
    },
  )

  defineTool(
    server,
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
      const events = await withBidi(async (client) => client.events())
      const network = events.filter((event) => event.method.startsWith('network.'))
      const narrowed = method === undefined ? network : network.filter((event) => event.method.includes(method))
      if (narrowed.length === 0) return 'no matching network events observed since this server connected'
      const newest = narrowed.slice(-(limit ?? 20)).reverse()
      return JSON.stringify(newest, null, 2)
    },
  )

  defineTool(
    server,
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
    async ({ action, urlPattern }: { action: 'start' | 'stop'; urlPattern?: string }) =>
      await withBidi(async (client) => {
        if (action === 'start') {
          const params: Record<string, unknown> = { phases: ['beforeRequestSent'] }
          if (urlPattern !== undefined) {
            params.urlPatterns = [{ type: 'string', pattern: urlPattern }]
          }
          const added = (await client.call('network.addIntercept', params)) as { intercept?: string }
          if (typeof added?.intercept === 'string') client.trackIntercept(added.intercept)
          return (
            'interception ON (phase beforeRequestSent' +
            (urlPattern === undefined ? '' : ', pattern ' + urlPattern) +
            ')'
          )
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

  defineTool(
    server,
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
      const released = await withBidi(async (client) => client.continueAllRequestIds())
      return 'released ' + String(released) + ' held request(s)'
    },
  )

  defineTool(
    server,
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
      return 'responded to ' + id + ' with ' + String(statusCode)
    },
  )

  defineTool(
    server,
    'browser_list_download_events',
    {
      title: 'List observed download events',
      description:
        'Report the download events the browser pushed since this server connected (browsingContext.downloadWillBegin / ' +
        'downloadEnd). Complements browser_list_downloads: the directory shows the RESULT, these events show WHEN a ' +
        'download started, finished, or failed. Events are buffered in memory (most recent 500) and only cover the ' +
        'lifetime of this connection.',
      inputSchema: {
        limit: z.number().int().positive().max(200).optional().describe('Max entries, newest first (default 20)'),
      },
      annotations: READ_ONLY,
    },
    async ({ limit }: { limit?: number }) => {
      const events = await withBidi(async (client) =>
        client
          .events()
          .filter(
            (event) =>
              event.method === 'browsingContext.downloadWillBegin' || event.method === 'browsingContext.downloadEnd',
          ),
      )
      if (events.length === 0) {
        return 'no download events observed since this server connected'
      }
      const newest = events.slice(-(limit ?? 20)).reverse()
      return JSON.stringify(newest, null, 2)
    },
  )

  defineTool(
    server,
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
      const dir = await withChrome(async (client, context) => {
        const value = await client.evaluate('Services.prefs.getStringPref("browser.download.dir", "")', context)
        return typeof value === 'string' ? value : ''
      })
      if (dir.length === 0) return 'no download directory configured (browser.download.dir is unset)'
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
      if (entries.length === 0) return 'download directory is empty: ' + dir
      return 'download directory: ' + dir + String.fromCharCode(10) + JSON.stringify(entries, null, 2)
    },
  )

  defineTool(
    server,
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
    async ({ maxSize }: { maxSize?: number }) =>
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

  defineTool(
    server,
    'browser_get_response_body',
    {
      title: 'Read a captured response body',
      description:
        'Read the stored body of one request (network.getData, dataType response). The request must have happened ' +
        'AFTER browser_collect_response_body ran. Returns the base64 the protocol gives plus a decoded preview. ' +
        '"no such network data" means nothing was stored for that request id — check that collection was started ' +
        'first and that the id comes from browser_network_requests.',
      inputSchema: {
        requestId: z
          .string()
          .describe('Request id from browser_network_requests (beforeRequestSent / responseStarted)'),
      },
      annotations: READ_ONLY,
    },
    async ({ requestId }: { requestId: string }) => {
      const id = str(requestId, 'requestId')
      return await withBidi(async (client) => {
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
        // Same 10s ceiling, but polled more often: the event normally lands
        // within a few tens of milliseconds, so 100ms granularity mostly
        // added latency to every successful read.
        for (let attempt = 0; attempt < 200 && !completed(); attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 50))
        }
        const result = (await client.call('network.getData', {
          request: id,
          dataType: 'response',
        })) as { bytes?: { type?: string; value?: string } }
        const bytesNode = result?.bytes
        const encoded = bytesNode?.value
        if (typeof encoded !== 'string') throw new Error('no response body stored for that request')
        // MEASURED: `bytes` is a WebDriver value node. When its type is
        // "base64" the value is base64; when it is "string" the value already
        // IS the raw byte string (latin1), and decoding that as base64 yields
        // a handful of garbage bytes — which is exactly how a 146 KB body
        // turned into "4 bytes".
        const rawBytes = bytesNode?.type === 'string' ? Buffer.from(encoded, 'latin1') : Buffer.from(encoded, 'base64')
        // The bytes are still compressed; unwrap them using the encoding the
        // responseCompleted event reported, otherwise the "preview" is mojibake.
        const encoding = (responseHeader(client, id, 'content-encoding') ?? '').toLowerCase().trim()
        let preview = ''
        try {
          let bytes = rawBytes
          // Try the declared encoding first, but DO NOT treat a failed
          // decompress as fatal: measured, some responses arrive already
          // decoded even though the header still says br/gzip, and failing
          // there would hide perfectly readable content behind an error line.
          try {
            if (encoding === 'gzip' || encoding === 'x-gzip') bytes = gunzipSync(bytes)
            else if (encoding === 'br') bytes = brotliDecompressSync(bytes)
            else if (encoding === 'deflate') bytes = inflateSync(bytes)
          } catch {
            // Keep the raw bytes; they may be plain text already.
          }
          // A body that is still compressed after every attempt would be
          // rendered as mojibake; report what it actually is instead.
          const head = bytes.subarray(0, 64)
          const looksBinary = head.some((byte) => byte < 9 || (byte > 13 && byte < 32) || byte > 126)
          preview = looksBinary
            ? '(binary body, ' +
              String(bytes.length) +
              ' bytes, head=' +
              bytes.subarray(0, 12).toString('hex') +
              (encoding === '' ? '' : ', declared encoding ' + encoding) +
              ')'
            : bytes.toString('utf8')
        } catch (error) {
          preview = '(could not read body: ' + (error instanceof Error ? error.message : String(error)) + ')'
        }
        const head =
          preview.length > 600
            ? preview.slice(0, 600) +
              String.fromCharCode(10) +
              '[truncated, total ' +
              String(preview.length) +
              ' chars]'
            : preview
        return (
          'base64 length: ' +
          String(encoded.length) +
          String.fromCharCode(10) +
          'decoded preview:' +
          String.fromCharCode(10) +
          head
        )
      })
    },
  )

  defineTool(
    server,
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
    async ({ index, action }: { index: number; action: 'pause' | 'resume' | 'cancel' }) =>
      await withChrome(async (client, chromeContext) => {
        const raw = await client.evaluate(
          '(async () => {' +
            ' try {' +
            '  const list = await Downloads.getList(Downloads.ALL);' +
            '  const items = await list.getAll();' +
            '  const d = items[' +
            String(index) +
            '];' +
            '  if (!d) return JSON.stringify({ error: "no download at index ' +
            String(index) +
            '" });' +
            '  const act = ' +
            JSON.stringify(action) +
            ';' +
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

  defineTool(
    server,
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
      const what = str(action, 'action')
      const idx = index === undefined ? null : index
      const raw = await withChrome(async (client, chromeContext) => {
        return client.evaluate(
          '(async () => {' +
            ' try {' +
            '  const m = ChromeUtils.importESModule("resource://gre/modules/Downloads.sys.mjs");' +
            '  const D = m.Downloads;' +
            '  const list = await D.getList(D.ALL);' +
            '  const action = ' +
            JSON.stringify(what) +
            ';' +
            '  if (action === "clear-finished") {' +
            '    const before = (await list.getAll()).length;' +
            '    await list.removeFinished(() => true);' +
            '    const after = (await list.getAll()).length;' +
            '    return JSON.stringify({ ok: true, removed: before - after, remaining: after });' +
            '  }' +
            '  const idx = ' +
            (idx === null ? 'null' : String(idx)) +
            ';' +
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
        return 'removed ' + String(info.removed) + ' finished entries, ' + String(info.remaining) + ' remaining'
      }
      if (what === 'remove') return 'removed download entry ' + String(info.removed)
      if (what === 'reveal') return 'revealed: ' + String(info.revealed)
      return 'opened: ' + String(info.opened)
    },
  )

  defineTool(
    server,
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
      const source = str(url, 'url')
      const destination = str(target, 'target')
      const raw = await withChrome(async (client, chromeContext) => {
        return client.evaluate(
          '(async () => {' +
            ' try {' +
            '  const m = ChromeUtils.importESModule("resource://gre/modules/Downloads.sys.mjs");' +
            '  const D = m.Downloads;' +
            '  const src = ' +
            JSON.stringify(source) +
            ';' +
            '  const dst = ' +
            JSON.stringify(destination) +
            ';' +
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
      return 'download started -> ' + String(info.target)
    },
  )
}
