import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { READ_ONLY, WRITES_PERSISTENTLY } from '../support/annotations.js'
import { defineTool } from '../support/define-tool.js'
import { withChrome } from '../support/connection.js'
import { text } from '../support/output.js'
import { str } from '../support/strings.js'

/**
 * Browsing history: list, search, remove.
 */
export function registerHistory(server: McpServer): void {
  defineTool(
    server,
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
      const what = str(action, 'action')
      const opt = (v: unknown): string => (v === undefined ? 'null' : JSON.stringify(v))
      const max = limit ?? 20
      const raw = await withChrome(async (client, chromeContext) => {
        return client.evaluate(
          '(async () => {' +
            ' try {' +
            '  const { PlacesUtils } = ChromeUtils.importESModule("resource://gre/modules/PlacesUtils.sys.mjs");' +
            '  const H = PlacesUtils.history;' +
            '  const action = ' +
            JSON.stringify(what) +
            ';' +
            '  if (action === "clear") {' +
            '    await H.clear();' +
            '    return JSON.stringify({ ok: true, cleared: true });' +
            '  }' +
            '  if (action === "remove") {' +
            '    const u = ' +
            opt(url) +
            ';' +
            '    if (!u) return JSON.stringify({ error: "url is required" });' +
            '    await H.remove(Services.io.newURI(u));' +
            '    return JSON.stringify({ ok: true, removed: u });' +
            '  }' +
            '  const q = ' +
            opt(query) +
            ';' +
            '  const found = [];' +
            '  const options = H.getNewQueryOptions();' +
            '  options.resultType = options.RESULTS_AS_URI;' +
            '  options.maxResults = ' +
            String(max) +
            ';' +
            '  const qobj = H.getNewQuery();' +
            '  if (q) qobj.searchTerms = q;' +
            '  const root = qobj;' +
            '  const result = await H.executeQuery(root, options);' +
            '  const rootNode = result && result.root;' +
            '  if (!rootNode) return JSON.stringify({ ok: true, count: 0, items: [] });' +
            '  try { rootNode.containerOpen = true; } catch (e) {}' +
            '  let total = 0;' +
            '  try { total = rootNode.childCount; } catch (e) { total = 0; }' +
            '  for (let i = 0; i < total && found.length < ' +
            String(max) +
            '; i++) {' +
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
      if (what === 'clear') return 'history cleared'
      if (what === 'remove') return 'history entry removed: ' + String(info.removed)
      const items = info.items ?? []
      if (items.length === 0) return 'no history entry matched'
      const lines = ['found: ' + String(info.count)]
      for (const e of items) lines.push('  ' + (e.title || '(untitled)') + '  ' + (e.uri ?? '?'))
      return lines.join(String.fromCharCode(10))
    },
  )

  defineTool(
    server,
    'browser_list_history',
    {
      title: 'List history entries',
      description:
        'Read recent history entries (privileged context). PlacesUtils.history.executeQuery is synchronous and returns a result whose root must be container-opened.',
      inputSchema: { limit: z.number().int().positive().max(200).optional().describe('Max entries (default 20)') },
      annotations: READ_ONLY,
    },
    async ({ limit }: { limit?: number }) =>
      JSON.stringify(
        await withChrome(
          async (client, context) =>
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
}
