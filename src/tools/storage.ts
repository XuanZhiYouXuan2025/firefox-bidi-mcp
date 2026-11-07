import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { READ_ONLY, WRITES, WRITES_PERSISTENTLY } from '../support/annotations.js'
import { defineTool } from '../support/define-tool.js'
import { withBidi, withChrome } from '../support/connection.js'

import { str } from '../support/strings.js'

/**
 * Cookies, site data, cache, containers and per-site permissions.
 */
export function registerStorage(server: McpServer): void {
  defineTool(
    server,
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
      const filter: Record<string, unknown> = {}
      if (name !== undefined) filter.name = name
      if (domain !== undefined) filter.domain = domain
      return await withBidi(async (client) => {
        const result = (await client.call(
          'storage.getCookies',
          Object.keys(filter).length === 0 ? {} : { filter },
        )) as { cookies?: unknown[] }
        const cookies = result.cookies ?? []
        if (cookies.length === 0) return 'no cookies matched'
        return JSON.stringify(cookies, null, 2)
      })
    },
  )

  defineTool(
    server,
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
      return await withBidi(async (client) => {
        await client.call('storage.setCookie', { cookie })
        return 'cookie set: ' + String(cookie.name) + ' on ' + String(cookie.domain)
      })
    },
  )

  defineTool(
    server,
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
      const filter: Record<string, unknown> = {}
      if (name !== undefined) filter.name = name
      if (domain !== undefined) filter.domain = domain
      if (Object.keys(filter).length === 0) {
        throw new Error('refusing to delete every cookie: pass name and/or domain')
      }
      return await withBidi(async (client) => {
        await client.call('storage.deleteCookies', { filter })
        return 'deleted cookies matching ' + JSON.stringify(filter)
      })
    },
  )

  defineTool(
    server,
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
    async ({ name, state, origin }: { name: string; state: 'granted' | 'denied' | 'prompt'; origin: string }) =>
      await withBidi(async (client) => {
        await client.call('permissions.setPermission', {
          descriptor: { name: str(name, 'name') },
          state,
          origin: str(origin, 'origin'),
        })
        return 'permission ' + String(name) + ' = ' + String(state) + ' for ' + String(origin)
      }),
  )

  defineTool(
    server,
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
    async () =>
      await withBidi(async (client) => {
        const result = (await client.call('browser.createUserContext', {})) as { userContext?: string }
        const id = result.userContext
        if (typeof id !== 'string') throw new Error('createUserContext returned no id')
        return 'created container: ' + id
      }),
  )

  defineTool(
    server,
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
      const id = str(userContext, 'userContext')
      return await withBidi(async (client) => {
        await client.call('browser.removeUserContext', { userContext: id })
        return 'removed container: ' + id
      })
    },
  )

  defineTool(
    server,
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
      if (host === undefined && origin === undefined) {
        throw new Error('refusing to run without host or origin: pass one so only that site is cleared')
      }
      const hostValue = host === undefined ? null : str(host, 'host')
      const originValue = origin === undefined ? null : str(origin, 'origin')
      const types = dataTypes ?? 'cookies storage cache'
      return await withChrome(async (client, context) => {
        const raw = await client.evaluate(
          '(async () => {' +
            ' try {' +
            '  const { ClearDataService } = ChromeUtils.importESModule(' +
            '    "resource://gre/modules/ClearDataService.sys.mjs");' +
            '  const svc = new ClearDataService();' +
            '  const host = ' +
            JSON.stringify(hostValue) +
            ';' +
            '  const origin = ' +
            JSON.stringify(originValue) +
            ';' +
            '  const types = ' +
            JSON.stringify(types) +
            '.split(/\\s+/).filter(Boolean);' +
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
      })
    },
  )

  defineTool(
    server,
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
      return 'cache2 on disk: ' + String(mb) + ' MB (' + String(total) + ' bytes) at ' + dir
    },
  )

  defineTool(
    server,
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
      const site = origin === undefined ? null : str(origin, 'origin')
      const baseDomain = domain === undefined ? null : str(domain, 'domain')
      if (site !== null && baseDomain !== null) throw new Error('give either origin or domain, not both')
      return await withChrome(async (client, chromeContext) => {
        // MEASURED: clearOriginsByPrincipal throws "Failure arg 0" even with a real
        // principal array, and clearBaseDomain is not exposed either. Only clear() works,
        // so this tool clears the whole HTTP cache and says so.
        if (site !== null || baseDomain !== null) {
          throw new Error(
            'per-origin cache clearing is not exposed by this Firefox build; omit origin/domain to clear the whole HTTP cache',
          )
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
      })
    },
  )

  defineTool(
    server,
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
      const wantOrigin = origin === undefined ? null : str(origin, 'origin')
      const wantType = type === undefined ? null : str(type, 'type')
      return await withChrome(async (client, chromeContext) => {
        const raw = await client.evaluate(
          '(() => {' +
            ' try {' +
            '  const wantOrigin = ' +
            JSON.stringify(wantOrigin) +
            ';' +
            '  const wantType = ' +
            JSON.stringify(wantType) +
            ';' +
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
      })
    },
  )

  defineTool(
    server,
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
            '  for (const k of ' +
            JSON.stringify(wanted) +
            ') { if (map[k]) flags |= map[k]; }' +
            '  if (!flags) return JSON.stringify({ error: "no usable kinds" });' +
            '  const site = ' +
            JSON.stringify(target) +
            ';' +
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
      return (
        'cleared site: ' +
        String(info.site) +
        String.fromCharCode(10) +
        'kinds: ' +
        wanted.join(', ') +
        String.fromCharCode(10) +
        'flags: ' +
        String(info.flags) +
        String.fromCharCode(10) +
        'resultFlags: ' +
        String(result.resultFlags ?? -1) +
        (result.resultFlags === 0 ? ' (all cleaners succeeded)' : ' (non-zero means some cleaner failed)')
      )
    },
  )

  defineTool(
    server,
    'browser_list_user_contexts',
    {
      title: 'List user contexts (containers)',
      description:
        'List BiDi user contexts. The "default" one always exists; others are containers created via browser.createUserContext.',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () =>
      JSON.stringify(await withBidi(async (client) => await client.call('browser.getUserContexts', {})), null, 2),
  )
}
