import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/server'
import { READ_ONLY, WRITES_PERSISTENTLY } from '../support/annotations.js'
import { defineTool } from '../support/define-tool.js'
import { withChrome } from '../support/connection.js'

import { str } from '../support/strings.js'

/**
 * TLS certificate overrides and the relax/restore switch.
 */
let certPrefsBefore: Record<string, { hadUserValue: boolean; type: string; value: unknown }> | null = null

export function registerCertificates(server: McpServer): void {
  defineTool(
    server,
    'browser_list_cert_overrides',
    {
      title: 'Certificate exceptions',
      description:
        'List the TLS certificate exceptions the user has accepted (nsICertOverrideService.getOverrides), with host, ' +
        'port, flags and whether each is temporary. Useful to confirm a test site was trusted, or to check nothing ' +
        'unexpected was accepted. Temporary exceptions disappear when Firefox exits.',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () =>
      await withChrome(async (client, context) => {
        const raw = await client.evaluate(
          '(() => {' +
            ' const svc = Cc["@mozilla.org/security/certoverride;1"].getService(Ci.nsICertOverrideService);' +
            ' const list = svc.getOverrides({});' +
            ' return JSON.stringify(list.map(o => ({' +
            '   host: o.hostName, port: o.port, flags: o.flags, temporary: o.isTemporary' +
            ' }))); })()',
          context,
        )
        if (typeof raw !== 'string') throw new Error('could not list certificate exceptions')
        const list = JSON.parse(raw) as unknown[]
        if (list.length === 0) return 'no certificate exceptions are stored'
        return JSON.stringify(list, null, 2)
      }),
  )

  defineTool(
    server,
    'browser_relax_certificate_checks',
    {
      title: 'Relax or restore TLS certificate checking',
      description:
        'SECURITY SENSITIVE. Switches the certificate-checking preferences that make a self-signed or internally ' +
        'issued test certificate usable: cert pinning, OCSP and OCSP stapling/must-staple. relax:true turns those ' +
        'checks off; relax:false puts them back. Restoring is precise: a preference that had no user value before is ' +
        'cleared so it falls back to the Firefox default again, instead of being overwritten with a guess. ' +
        'The pre-relax values are remembered by THIS SERVER PROCESS, so restore only works while it is alive; ' +
        'if the server restarted, restore reports that instead of guessing. Some TLS changes only affect new connections.',
      inputSchema: {
        relax: z.boolean().describe('true to relax the checks (unsafe), false to restore what was there before'),
      },
      annotations: WRITES_PERSISTENTLY,
    },
    async ({ relax }: { relax: boolean }) =>
      await withChrome(async (client, context) => {
        const raw = await client.evaluate(
          '(async () => {' +
            ' const names = [' +
            '   "security.cert_pinning.enforcement_level",' +
            '   "security.OCSP.enabled",' +
            '   "security.ssl.enable_ocsp_stapling",' +
            '   "security.ssl.enable_ocsp_must_staple"' +
            ' ];' +
            ' const relaxed = {' +
            '   "security.cert_pinning.enforcement_level": { type: "int", value: 0 },' +
            '   "security.OCSP.enabled": { type: "int", value: 0 },' +
            '   "security.ssl.enable_ocsp_stapling": { type: "bool", value: false },' +
            '   "security.ssl.enable_ocsp_must_staple": { type: "bool", value: false }' +
            ' };' +
            ' const read = (name) => {' +
            '   const t = Services.prefs.getPrefType(name);' +
            '   if (!t) return { type: "unset", value: null };' +
            '   if (t === Services.prefs.PREF_BOOL) return { type: "bool", value: Services.prefs.getBoolPref(name) };' +
            '   if (t === Services.prefs.PREF_INT) return { type: "int", value: Services.prefs.getIntPref(name) };' +
            '   return { type: "string", value: Services.prefs.getStringPref(name) };' +
            ' };' +
            ' const write = (name, kind, value) => {' +
            '   if (kind === "bool") Services.prefs.setBoolPref(name, value);' +
            '   else if (kind === "int") Services.prefs.setIntPref(name, value);' +
            '   else Services.prefs.setStringPref(name, value);' +
            ' };' +
            ' const snapshot = {};' +
            ' for (const n of names) snapshot[n] = { hadUserValue: Services.prefs.prefHasUserValue(n), type: read(n).type, value: read(n).value };' +
            ' const saved = ' +
            JSON.stringify(certPrefsBefore) +
            ';' +
            ' if (' +
            (relax ? 'true' : 'false') +
            ') {' +
            '   for (const n of names) { const spec = relaxed[n]; write(n, spec.type, spec.value); }' +
            ' } else {' +
            '   if (!saved) return JSON.stringify({ error: "no snapshot of the previous state: relax was not called by this server process" });' +
            '   for (const n of names) {' +
            '     const entry = saved[n];' +
            '     if (!entry) continue;' +
            '     if (!entry.hadUserValue) { if (Services.prefs.prefHasUserValue(n)) Services.prefs.clearUserPref(n); }' +
            '     else if (entry.type !== "unset") write(n, entry.type, entry.value);' +
            '   }' +
            ' }' +
            ' const after = {};' +
            ' for (const n of names) after[n] = { type: read(n).type, value: read(n).value };' +
            ' return JSON.stringify({ mode: ' +
            (relax ? '"relaxed"' : '"restored"') +
            ', snapshot, after });' +
            ' })()',
          context,
        )
        if (typeof raw !== 'string') throw new Error('certificate preference update returned nothing')
        const info = JSON.parse(raw) as {
          mode?: string
          error?: string
          snapshot?: Record<string, { hadUserValue: boolean; type: string; value: unknown }>
          after: Record<string, { type: string; value: unknown }>
        }
        if (info.error !== undefined) throw new Error(info.error)
        if (relax && info.snapshot !== undefined) certPrefsBefore = info.snapshot
        if (!relax) certPrefsBefore = null
        const lines = ['certificate checks: ' + (info.mode === 'relaxed' ? 'RELAXED (unsafe)' : 'restored')]
        for (const [name, state] of Object.entries(info.after)) {
          lines.push('  ' + name + ' = ' + String(state.value))
        }
        lines.push('note: TLS changes may only affect connections opened from now on')
        return lines.join(String.fromCharCode(10))
      }),
  )

  defineTool(
    server,
    'browser_certificate_manage',
    {
      title: 'Inspect certificates and manage certificate exceptions',
      description:
        'Read the certificate database and manage per-host certificate exceptions. MEASURED: nsIX509CertDB offers addCert ' +
        '/ getCerts / importCertsFromFile (removeCert is absent in this build), and nsICertOverrideService offers ' +
        'rememberValidityOverride / clearValidityOverride / clearAllOverrides. Clearing all overrides is ' +
        'irreversible, so it requires confirm:true.',
      inputSchema: {
        action: z
          .enum(['list', 'list-overrides', 'remember-override', 'clear-override', 'clear-all-overrides'])
          .describe('What to do'),
        host: z.string().optional().describe('Host for remember/clear override'),
        port: z.number().int().min(1).max(65535).optional().describe('Port (default 443)'),
        confirm: z.boolean().optional().describe('Required true for clear-all-overrides'),
      },
      annotations: WRITES_PERSISTENTLY,
    },
    async ({
      action,
      host,
      port,
      confirm,
    }: {
      action: 'list' | 'list-overrides' | 'remember-override' | 'clear-override' | 'clear-all-overrides'
      host?: string
      port?: number
      confirm?: boolean
    }) => {
      const what = str(action, 'action')
      if (what === 'clear-all-overrides' && confirm !== true) {
        throw new Error('clear-all-overrides is irreversible — pass confirm:true to proceed')
      }
      const hostStr = host === undefined ? null : str(host, 'host')
      const portNum = port ?? 443
      const raw = await withChrome(async (client, chromeContext) => {
        return client.evaluate(
          '(async () => {' +
            ' try {' +
            '  const action = ' +
            JSON.stringify(what) +
            ';' +
            '  const hostArg = ' +
            (hostStr === null ? 'null' : JSON.stringify(hostStr)) +
            ';' +
            '  const portArg = ' +
            String(portNum) +
            ';' +
            '  const ov = Cc["@mozilla.org/security/certoverride;1"].getService(Ci.nsICertOverrideService);' +
            '  if (action === "clear-all-overrides") {' +
            '    ov.clearAllOverrides();' +
            '    return JSON.stringify({ ok: true, clearedAll: true });' +
            '  }' +
            '  if (action === "remember-override") {' +
            '    if (!hostArg) return JSON.stringify({ error: "host is required" });' +
            '    const flags = Ci.nsICertOverrideService.ERROR_UNTRUSTED | Ci.nsICertOverrideService.ERROR_MISMATCH | Ci.nsICertOverrideService.ERROR_TIME;' +
            '    ov.rememberValidityOverride(hostArg, portArg, {}, flags, false);' +
            '    return JSON.stringify({ ok: true, host: hostArg, port: portArg });' +
            '  }' +
            '  if (action === "clear-override") {' +
            '    if (!hostArg) return JSON.stringify({ error: "host is required" });' +
            '    ov.clearValidityOverride(hostArg, portArg);' +
            '    return JSON.stringify({ ok: true, host: hostArg, port: portArg });' +
            '  }' +
            '  const db = Cc["@mozilla.org/security/x509certdb;1"].getService(Ci.nsIX509CertDB);' +
            '  if (action === "list") {' +
            '    const rawCerts = await db.getCerts();' +
            '    const certs = Array.from(rawCerts || []);' +
            '    const items = [];' +
            '    for (const c of certs) {' +
            '      if (items.length >= 50) break;' +
            '      try { items.push({ nickname: c.nickname || c.commonName || "(unnamed)", issuer: c.issuerName || null }); } catch (e) {}' +
            '    }' +
            '    return JSON.stringify({ ok: true, count: certs.length, items });' +
            '  }' +
            '  return JSON.stringify({ ok: true, overrideService: !!ov, note: "per-host overrides are listed by the browser; this build exposes no enumerator" });' +
            ' } catch (e) { return JSON.stringify({ error: String(e) }); }' +
            ' })()',
          chromeContext,
        )
      })
      if (typeof raw !== 'string') throw new Error('certificate manage returned nothing')
      const info = JSON.parse(raw) as {
        error?: string
        count?: number
        items?: Array<{ nickname: string; issuer: string | null }>
        host?: string
        port?: number
        clearedAll?: boolean
      }
      if (info.error !== undefined) throw new Error(info.error)
      if (what === 'list') {
        const items = info.items ?? []
        const lines = ['certificates: ' + String(info.count)]
        for (const c of items) lines.push('  ' + c.nickname + (c.issuer ? '  (' + c.issuer + ')' : ''))
        return lines.join(String.fromCharCode(10))
      }
      if (what === 'clear-all-overrides') return 'cleared all certificate exceptions'
      if (what === 'remember-override')
        return 'remembered certificate exception for ' + String(info.host) + ':' + String(info.port)
      if (what === 'clear-override')
        return 'cleared certificate exception for ' + String(info.host) + ':' + String(info.port)
      return 'override service available; this build exposes no enumerator for existing exceptions'
    },
  )
}
