import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/server'
import { READ_ONLY, WRITES_PERSISTENTLY } from '../support/annotations.js'
import { defineTool } from '../support/define-tool.js'
import { appendSiteNote, domainOfUrl, normalizeDomain, siteNoteLines } from '../support/site-notes.js'
import { shutdown, withBidi, withChrome } from '../support/connection.js'
import { failure, maxOutputChars, text } from '../support/output.js'
import { port } from '../support/port.js'

/**
 * Server/browser introspection and orderly shutdown.
 */
export function registerInfo(server: McpServer): void {
  defineTool(
    server,
    'browser_info',
    {
      title: 'Browser info',
      description:
        'Report the connected Firefox: version, window count and whether the privileged (chrome) context is reachable.',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () =>
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
        const viewport =
          page === null
            ? '(no page context)'
            : await client.evaluate('window.innerWidth + "x" + window.innerHeight', page)
        lines.push(`viewport: ${String(viewport)}`)
        if (page !== null) {
          try {
            const currentUrl = await client.evaluate('location.href', page)
            const siteDomain = domainOfUrl(currentUrl)
            if (siteDomain !== null) {
              const known = siteNoteLines(siteDomain)
              if (known > 0) {
                lines.push(
                  `site notes: sites/${siteDomain}.md (${known} note(s)) — read this before re-exploring the site`,
                )
              }
            }
          } catch {
            // A page mid-navigation can reject evaluation; the rest of the report still matters.
          }
        }
        lines.push(
          `output limit: ${String(maxOutputChars)} characters` +
            (process.env.DSH_BROWSER_OUTPUT_DIR === undefined
              ? ' (oversized results go to the system temp dir)'
              : `; oversized results go to ${process.env.DSH_BROWSER_OUTPUT_DIR}`),
        )
        return lines.join('\n')
      }),
  )

  defineTool(
    server,
    'browser_site_note',
    {
      title: 'Record a per-site experience note',
      description:
        'Append one dated line to sites/<domain>.md in this repository — the place to keep hard-won per-site ' +
        'knowledge (selectors that work, timing quirks, login markers, what the入口 URL is). Later, ' +
        'browser_info reports how many notes exist for the current domain so an agent reads them before ' +
        're-exploring. SECURITY: never write credentials, tokens or cookies into a note.',
      inputSchema: {
        domain: z.string().describe('Host (bare host preferred, e.g. example.com). A full URL is accepted and reduced to its host.'),
        note: z
          .string()
          .describe('One line of reusable knowledge: a selector, a timing quirk, a login marker, an entry URL'),
      },
      annotations: WRITES_PERSISTENTLY,
    },
    async ({ domain, note }: { domain?: string; note?: string }) => {
      const d = normalizeDomain(domain)
      const result = appendSiteNote(d, note ?? '')
      return 'note saved: sites/' + d + '.md (' + String(result.lines) + ' note(s))'
    },
  )

  defineTool(
    server,
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
    async () =>
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

  defineTool(
    server,
    'browser_quit',
    {
      title: 'Quit Firefox',
      description:
        'Ask the connected Firefox to exit (browser.close). This tears down the browser and this server loses its ' +
        'connection until Firefox is started again, so use it deliberately. ' +
        'LIMIT (measured 2026-10-17): it CANNOT rescue an already-leaked session. Firefox allows ONE active BiDi ' +
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
        return 'asked Firefox to close; start it again to reconnect'
      } catch (error) {
        // The connection often drops before a reply arrives, which still means success.
        const message = error instanceof Error ? error.message : String(error)
        if (/closed|disconnect|socket|ECONNRESET/i.test(message)) {
          return 'Firefox closed (the connection dropped before it could answer): ' + message
        }
        throw error
      }
    },
  )

  defineTool(
    server,
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
      return (
        'resident: ' +
        String(info.residentMB) +
        ' MB' +
        String.fromCharCode(10) +
        'resident unique: ' +
        String(info.residentUniqueMB) +
        ' MB' +
        String.fromCharCode(10) +
        'heap allocated: ' +
        String(info.heapAllocatedMB) +
        ' MB'
      )
    },
  )

  defineTool(
    server,
    'browser_troubleshoot',
    {
      title: 'Read the about:support troubleshooting snapshot',
      description:
        'Return the same diagnostic snapshot that about:support shows. MEASURED: the module is ' +
        'resource://gre/modules/Troubleshoot.sys.mjs and Troubleshoot.snapshot() resolves to sections including ' +
        'modifiedPreferences, lockedPreferences, printingPreferences, media, accessibility, pdfjs, intl, ' +
        'securitySoftware, startupCache and libraryVersions. Use sections to narrow the output.',
      inputSchema: {
        sections: z.array(z.string()).optional().describe('Only these top-level keys (default: a useful subset)'),
      },
      annotations: READ_ONLY,
    },
    async ({ sections }: { sections?: string[] }) => {
      const wanted = sections === undefined ? null : sections
      const raw = await withChrome(async (client, chromeContext) => {
        return client.evaluate(
          '(async () => {' +
            ' try {' +
            '  const m = ChromeUtils.importESModule("resource://gre/modules/Troubleshoot.sys.mjs");' +
            '  const t = await m.Troubleshoot.snapshot();' +
            '  const wanted = ' +
            (wanted === null ? 'null' : JSON.stringify(wanted)) +
            ';' +
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
      return lines.join(String.fromCharCode(10))
    },
  )

  defineTool(
    server,
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
    async () =>
      await withBidi(async (client) => {
        const lines: string[] = []
        const chrome = await client.chromeContext()
        if (chrome === null) {
          return 'FAIL: no chrome context (launch Firefox with MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1)'
        }
        lines.push(`firefox version            : ${String(await client.evaluate('Services.appinfo.version', chrome))}`)
        lines.push(
          `app build id               : ${String(await client.evaluate('Services.appinfo.appBuildID', chrome))}`,
        )
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
}
