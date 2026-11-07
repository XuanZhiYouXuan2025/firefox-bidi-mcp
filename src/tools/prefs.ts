import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/server'
import { READ_ONLY, WRITES_PERSISTENTLY } from '../support/annotations.js'
import { defineTool } from '../support/define-tool.js'
import { withChrome } from '../support/connection.js'

import { str } from '../support/strings.js'

/**
 * Preferences, proxy and privacy settings (all through the chrome context).
 */
export function registerPrefs(server: McpServer): void {
  defineTool(
    server,
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
    async () =>
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

  defineTool(
    server,
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
    }) =>
      await withChrome(async (client, context) => {
        const raw = await client.evaluate(
          '(() => {' +
            ' const before = Services.prefs.getIntPref("network.proxy.type", 5);' +
            ' Services.prefs.setIntPref("network.proxy.type", ' +
            String(mode) +
            ');' +
            (host === undefined
              ? ''
              : ' Services.prefs.setStringPref("network.proxy.http", ' +
                JSON.stringify(host) +
                ');' +
                ' Services.prefs.setStringPref("network.proxy.ssl", ' +
                JSON.stringify(host) +
                ');') +
            (port === undefined
              ? ''
              : ' Services.prefs.setIntPref("network.proxy.http_port", ' +
                String(port) +
                ');' +
                ' Services.prefs.setIntPref("network.proxy.ssl_port", ' +
                String(port) +
                ');') +
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
          'proxy type: ' +
          String(info.before) +
          ' -> ' +
          String(info.after) +
          (info.before === info.after && info.before !== mode
            ? String.fromCharCode(10) + 'note: the value did not change as requested'
            : '') +
          String.fromCharCode(10) +
          'note: existing connections may keep the old proxy until reopened'
        )
      }),
  )

  defineTool(
    server,
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
      const needle = str(query, 'query')
      const max = limit ?? 40
      return await withChrome(async (client, chromeContext) => {
        const raw = await client.evaluate(
          '(() => {' +
            ' try {' +
            '  const needle = ' +
            JSON.stringify(needle) +
            ';' +
            '  const limit = ' +
            String(max) +
            ';' +
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
              (hit.user ? '*' : ' ') +
              hit.name +
              ' = ' +
              String(hit.value) +
              (hit.user ? '  [user value]' : '  [default]'),
          )
          .join(String.fromCharCode(10))
      })
    },
  )

  defineTool(
    server,
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
      const pref = str(name, 'name')
      return await withChrome(async (client, chromeContext) => {
        const raw = await client.evaluate(
          '(() => {' +
            ' try {' +
            '  const name = ' +
            JSON.stringify(pref) +
            ';' +
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
      })
    },
  )

  defineTool(
    server,
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
      return await withChrome(async (client, chromeContext) => {
        const raw = await client.evaluate(
          '(() => {' +
            ' try {' +
            '  const out = {};' +
            '  const url = ' +
            JSON.stringify(url) +
            ';' +
            '  const page = ' +
            (page === null ? 'null' : String(page)) +
            ';' +
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
          'homepage: ' +
          String(info.homepage) +
          ' | startup: ' +
          String(names[info.startupPage ?? -1] ?? info.startupPage)
        )
      })
    },
  )

  defineTool(
    server,
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
      const level = str(mode, 'mode')
      return await withChrome(async (client, chromeContext) => {
        const raw = await client.evaluate(
          '(() => {' +
            ' try {' +
            '  const mode = ' +
            JSON.stringify(level) +
            ';' +
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
          'tracking protection: ' +
          level +
          ' (normal-window=' +
          String(info.tp) +
          ', private-window=' +
          String(info.pbmode) +
          ', cookieBehavior=' +
          String(info.cookieBehavior) +
          ')'
        )
      })
    },
  )

  defineTool(
    server,
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
      const modeMap: Record<string, number> = {
        off: 0,
        'on-with-fallback': 2,
        'on-only': 3,
        'explicitly-off': 5,
      }
      const value = modeMap[String(mode)]
      if (value === undefined) throw new Error('unknown mode: ' + String(mode))
      const target = uri === undefined ? null : str(uri, 'uri')
      return await withChrome(async (client, chromeContext) => {
        const raw = await client.evaluate(
          '(() => {' +
            ' try {' +
            '  Services.prefs.setIntPref("network.trr.mode", ' +
            String(value) +
            ');' +
            '  const uri = ' +
            JSON.stringify(target) +
            ';' +
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
      })
    },
  )

  defineTool(
    server,
    'browser_get_pref',
    {
      title: 'Read a Firefox preference',
      description: 'Read a preference by name (privileged context). Returns type and value.',
      inputSchema: { name: z.string().describe('Preference name, e.g. browser.tabs.inTitlebar') },
      annotations: READ_ONLY,
    },
    async ({ name }: { name: string }) => {
      const pref = str(name, 'name')
      return JSON.stringify(
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
      )
    },
  )

  defineTool(
    server,
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
      return `set ${pref} (${type}) = ${raw}`
    },
  )
}
