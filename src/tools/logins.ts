import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/server'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { READ_ONLY, WRITES, WRITES_PERSISTENTLY } from '../support/annotations.js'
import { defineTool } from '../support/define-tool.js'
import { withBidi, withChrome } from '../support/connection.js'
import { text } from '../support/output.js'
import { str } from '../support/strings.js'

/**
 * Saved logins, form autofill and bulk import helpers.
 */
export function registerLogins(server: McpServer): void {
  defineTool(
    server,
    'browser_list_logins',
    {
      title: 'List saved logins (no passwords)',
      description:
        'List saved logins from the Firefox password manager, with origin, form action origin and username — but ' +
        'NEVER the password itself. Filter with origin to look at one site. Passwords are only readable through ' +
        'browser_get_login_password, which is a separate, explicitly named tool on purpose. ' +
        'Requires signon.rememberSignons=true for new logins to be saved.',
      inputSchema: {
        origin: z.string().optional().describe('Only logins for this origin (e.g. https://example.com)'),
      },
      annotations: READ_ONLY,
    },
    async ({ origin }: { origin?: string }) => {
      const wanted = origin === undefined ? null : str(origin, 'origin')
      return await withChrome(async (client, chromeContext) => {
        const raw = await client.evaluate(
          '(async () => {' +
            ' try {' +
            '  const svc = Cc["@mozilla.org/login-manager;1"].getService(Ci.nsILoginManager);' +
            '  const query = ' +
            (wanted === null ? '{}' : '{ origin: ' + JSON.stringify(wanted) + ' }') +
            ';' +
            '  const logins = await svc.searchLoginsAsync(query);' +
            '  return JSON.stringify(logins.map(l => ({' +
            '    origin: l.origin, formActionOrigin: l.formActionOrigin, username: l.username,' +
            '    hasPassword: typeof l.password === "string" && l.password.length > 0' +
            '  })));' +
            ' } catch (e) { return JSON.stringify({ error: e.message }); }' +
            ' })()',
          chromeContext,
        )
        if (typeof raw !== 'string') throw new Error('login list returned nothing')
        const rows = JSON.parse(raw) as Array<Record<string, unknown>> | { error?: string }
        if (!Array.isArray(rows)) throw new Error(String((rows as { error?: string }).error ?? 'unexpected reply'))
        if (rows.length === 0) return 'no saved logins' + (wanted === null ? '' : ' for ' + wanted)
        return rows
          .map(
            (row) =>
              String(row.origin) +
              '  user=' +
              String(row.username) +
              (row.hasPassword ? '  (password stored)' : '  (no password)'),
          )
          .join(String.fromCharCode(10))
      })
    },
  )

  defineTool(
    server,
    'browser_add_login',
    {
      title: 'Save a login',
      description:
        'Save a username/password pair in the Firefox password manager. MEASURED: nsILoginInfo.init needs a ' +
        'formActionOrigin (or an httpRealm) — adding without one fails with "Can\'t add a login without a httpRealm ' +
        'or formActionOrigin"; this tool defaults formActionOrigin to the origin. The password is written to the ' +
        'browser, never echoed back.',
      inputSchema: {
        origin: z.string().describe('Origin the login belongs to (e.g. https://example.com)'),
        username: z.string().describe('Username'),
        password: z.string().describe('Password (written to the browser, not echoed)'),
        formActionOrigin: z.string().optional().describe('Form action origin (defaults to origin)'),
      },
      annotations: WRITES_PERSISTENTLY,
    },
    async ({
      origin,
      username,
      password,
      formActionOrigin,
    }: {
      origin: string
      username: string
      password: string
      formActionOrigin?: string
    }) => {
      const site = str(origin, 'origin')
      const action = formActionOrigin === undefined ? site : str(formActionOrigin, 'formActionOrigin')
      return await withChrome(async (client, chromeContext) => {
        const raw = await client.evaluate(
          '(async () => {' +
            ' try {' +
            '  const svc = Cc["@mozilla.org/login-manager;1"].getService(Ci.nsILoginManager);' +
            '  const info = Cc["@mozilla.org/login-manager/loginInfo;1"].createInstance(Ci.nsILoginInfo);' +
            '  info.init(' +
            JSON.stringify(site) +
            ', ' +
            JSON.stringify(action) +
            ', null, ' +
            JSON.stringify(username) +
            ', ' +
            JSON.stringify(password) +
            ', "username", "password");' +
            '  await svc.addLoginAsync(info);' +
            '  const all = await svc.searchLoginsAsync({ origin: ' +
            JSON.stringify(site) +
            ' });' +
            '  return JSON.stringify({ saved: true, count: all.length });' +
            ' } catch (e) { return JSON.stringify({ error: e.message }); }' +
            ' })()',
          chromeContext,
        )
        if (typeof raw !== 'string') throw new Error('add login returned nothing')
        const info = JSON.parse(raw) as { error?: string; saved?: boolean; count?: number }
        if (info.error !== undefined) throw new Error(info.error)
        return 'saved login for ' + site + ' (now ' + String(info.count) + ' for that origin)'
      })
    },
  )

  defineTool(
    server,
    'browser_remove_login',
    {
      title: 'Delete a saved login',
      description:
        'Delete saved logins. Give origin and optionally username; with username omitted, every login for that ' +
        'origin is removed. Reports how many were removed so the result can be checked.',
      inputSchema: {
        origin: z.string().describe('Origin whose logins should be removed'),
        username: z.string().optional().describe('Only remove this username (default: all for the origin)'),
      },
      annotations: WRITES_PERSISTENTLY,
    },
    async ({ origin, username }: { origin: string; username?: string }) => {
      const site = str(origin, 'origin')
      const only = username === undefined ? null : str(username, 'username')
      return await withChrome(async (client, chromeContext) => {
        const raw = await client.evaluate(
          '(async () => {' +
            ' try {' +
            '  const svc = Cc["@mozilla.org/login-manager;1"].getService(Ci.nsILoginManager);' +
            '  const only = ' +
            JSON.stringify(only) +
            ';' +
            '  const logins = await svc.searchLoginsAsync({ origin: ' +
            JSON.stringify(site) +
            ' });' +
            '  const doomed = only === null ? logins : logins.filter(l => l.username === only);' +
            '  for (const l of doomed) await svc.removeLoginAsync(l);' +
            '  const after = await svc.searchLoginsAsync({ origin: ' +
            JSON.stringify(site) +
            ' });' +
            '  return JSON.stringify({ removed: doomed.length, remaining: after.length });' +
            ' } catch (e) { return JSON.stringify({ error: e.message }); }' +
            ' })()',
          chromeContext,
        )
        if (typeof raw !== 'string') throw new Error('remove login returned nothing')
        const info = JSON.parse(raw) as { error?: string; removed?: number; remaining?: number }
        if (info.error !== undefined) throw new Error(info.error)
        return 'removed ' + String(info.removed) + ' login(s), ' + String(info.remaining) + ' remain for ' + site
      })
    },
  )

  defineTool(
    server,
    'browser_get_login_password',
    {
      title: 'Read one saved password',
      description:
        'SECURITY SENSITIVE — returns a saved password in clear text. It is a separate, explicitly named tool so that ' +
        'reading a password is always a deliberate act, never a side effect of listing. Never paste the value into ' +
        'chat output, logs or screenshots. Requires both origin and username.',
      inputSchema: {
        origin: z.string().describe('Origin of the login'),
        username: z.string().describe('Username of the login'),
      },
      annotations: READ_ONLY,
    },
    async ({ origin, username }: { origin: string; username: string }) => {
      const site = str(origin, 'origin')
      const user = str(username, 'username')
      return await withChrome(async (client, chromeContext) => {
        const raw = await client.evaluate(
          '(async () => {' +
            ' try {' +
            '  const svc = Cc["@mozilla.org/login-manager;1"].getService(Ci.nsILoginManager);' +
            '  const logins = await svc.searchLoginsAsync({ origin: ' +
            JSON.stringify(site) +
            ' });' +
            '  const hit = logins.find(l => l.username === ' +
            JSON.stringify(user) +
            ');' +
            '  if (!hit) return JSON.stringify({ error: "no login with that origin and username" });' +
            '  return JSON.stringify({ password: hit.password });' +
            ' } catch (e) { return JSON.stringify({ error: e.message }); }' +
            ' })()',
          chromeContext,
        )
        if (typeof raw !== 'string') throw new Error('password read returned nothing')
        const info = JSON.parse(raw) as { error?: string; password?: string }
        if (info.error !== undefined) throw new Error(info.error)
        if (typeof info.password !== 'string') throw new Error('login has no password')
        return info.password
      })
    },
  )

  defineTool(
    server,
    'browser_find_login_form',
    {
      title: 'Find login and registration forms',
      description:
        'Inspect the page for login/registration forms: each form id and action, plus its input fields with name, ' +
        'type and autocomplete hint. Use this before filling a form so the field names are known instead of guessed.',
      inputSchema: {
        context: z.string().optional().describe('Tab context id (default: the active tab)'),
      },
      annotations: READ_ONLY,
    },
    async ({ context: tab }: { context?: string }) =>
      await withBidi(async (client) => {
        const context = tab ?? ((await client.pageContext()) as string)
        const raw = await client.evaluate(
          '(() => {' +
            ' const forms = Array.from(document.forms).map(f => ({' +
            '   id: f.id || null, action: f.action,' +
            '   fields: Array.from(f.elements)' +
            '     .filter(e => e.tagName === "INPUT")' +
            '     .map(e => ({ name: e.name, type: e.type, autocomplete: e.getAttribute("autocomplete") }))' +
            ' }));' +
            ' const loose = Array.from(document.querySelectorAll("input[type=password]"))' +
            '   .filter(e => !e.closest("form")).length;' +
            ' return JSON.stringify({ forms, passwordFieldsOutsideForms: loose });' +
            ' })()',
          context,
        )
        if (typeof raw !== 'string') throw new Error('form scan returned nothing')
        const info = JSON.parse(raw) as {
          forms?: Array<{
            id: string | null
            action: string
            fields: Array<{ name: string; type: string; autocomplete: string | null }>
          }>
          passwordFieldsOutsideForms?: number
        }
        const forms = info.forms ?? []
        if (forms.length === 0) {
          return (
            'no <form> on this page' +
            (info.passwordFieldsOutsideForms
              ? ' (but ' + String(info.passwordFieldsOutsideForms) + ' loose password field(s))'
              : '')
          )
        }
        const lines: string[] = []
        for (const form of forms) {
          lines.push('form ' + String(form.id ?? '(no id)') + ' -> ' + String(form.action))
          for (const field of form.fields) {
            lines.push(
              '  ' +
                String(field.name) +
                '  [' +
                String(field.type) +
                ']' +
                (field.autocomplete ? '  autocomplete=' + String(field.autocomplete) : ''),
            )
          }
        }
        return lines.join(String.fromCharCode(10))
      }),
  )

  defineTool(
    server,
    'browser_fill_login',
    {
      title: 'Type credentials into a login form',
      description:
        'Type a username and password into a form using real keystroke input (not a scripted value assignment), then ' +
        'optionally submit. This is the "you give me credentials, I fill them" path — the agent types what it was ' +
        'given. It does NOT use the browser password manager: MEASURED, Firefox native autofill only fills after a ' +
        'human picks an entry from its own dropdown, which is native UI no automation can click.',
      inputSchema: {
        username: z.string().describe('Username to type'),
        password: z.string().describe('Password to type'),
        usernameSelector: z
          .string()
          .optional()
          .describe(
            'CSS selector for the username field (default: form autocomplete=username, else first text input in the form)',
          ),
        passwordSelector: z
          .string()
          .optional()
          .describe(
            'CSS selector for the password field (default: form autocomplete=current-password, else first password input)',
          ),
        submit: z.boolean().optional().describe('Submit the form afterwards (default false — fill only)'),
        context: z.string().optional().describe('Tab context id (default: the active tab)'),
      },
      annotations: WRITES,
    },
    async ({
      username,
      password,
      usernameSelector,
      passwordSelector,
      submit,
      context: tab,
    }: {
      username: string
      password: string
      usernameSelector?: string
      passwordSelector?: string
      submit?: boolean
      context?: string
    }) => {
      const userSel = usernameSelector === undefined ? null : str(usernameSelector, 'usernameSelector')
      const passSel = passwordSelector === undefined ? null : str(passwordSelector, 'passwordSelector')
      return await withBidi(async (client) => {
        const context = tab ?? ((await client.pageContext()) as string)
        // typeInto() takes a CSS selector, not a JS expression, so tag the two fields
        // with throwaway ids first and then address them as #selector.
        const tag = await client.evaluate(
          '(() => {' +
            ' const userSel = ' +
            JSON.stringify(userSel) +
            ';' +
            ' const passSel = ' +
            JSON.stringify(passSel) +
            ';' +
            ' const u = userSel ? document.querySelector(userSel)' +
            '   : (document.querySelector("input[autocomplete=username]") || document.querySelector("form input[type=text]"));' +
            ' const p = passSel ? document.querySelector(passSel)' +
            '   : (document.querySelector("input[autocomplete=current-password]") || document.querySelector("input[type=password]"));' +
            ' if (!u || !p) return JSON.stringify({ error: "could not find the username or password field" });' +
            ' u.id = u.id || "__dsh_user__";' +
            ' p.id = p.id || "__dsh_pass__";' +
            ' return JSON.stringify({ user: "#" + u.id, pass: "#" + p.id });' +
            ' })()',
          context,
        )
        if (typeof tag !== 'string') throw new Error('field lookup returned nothing')
        const ids = JSON.parse(tag) as { error?: string; user?: string; pass?: string }
        if (ids.error !== undefined) throw new Error(ids.error)
        // typeInto(selector, text, context) — order matters
        await client.typeInto(String(ids.user), username, context)
        await client.typeInto(String(ids.pass), password, context)
        let submitted = false
        if (submit === true) {
          const result = await client.evaluate(
            '(() => {' +
              ' const p = document.querySelector(' +
              JSON.stringify(String(ids.pass)) +
              ');' +
              ' if (!p) return "no password field";' +
              ' const form = p.closest("form");' +
              ' if (form) { form.requestSubmit(); return "submitted"; }' +
              ' const btn = document.querySelector("button[type=submit], input[type=submit]");' +
              ' if (btn) { btn.click(); return "clicked submit"; }' +
              ' return "no form to submit";' +
              ' })()',
            context,
          )
          submitted = true
          return 'filled credentials, submit: ' + String(result)
        }
        return 'filled credentials' + (submitted ? '' : ' (not submitted; pass submit=true to submit)')
      })
    },
  )

  defineTool(
    server,
    'browser_autofill_status',
    {
      title: 'Report whether form autofill is available and enabled',
      description:
        'Report the address / credit-card autofill state. MEASURED: resource://autofill/FormAutofill.sys.mjs loads and ' +
        'exposes isAutofillEnabled, and FormAutofillStorage.sys.mjs also loads. This only reports status — the stored ' +
        'address and card records live behind the autofill storage API, which this build does not expose for remote ' +
        'write, so treat editing saved autofill entries as out of scope.',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () =>
      await withChrome(async (client, chromeContext) => {
        const raw = await client.evaluate(
          '(() => {' +
            ' try {' +
            '  const out = {};' +
            '  try {' +
            '    const { FormAutofill } = ChromeUtils.importESModule("resource://autofill/FormAutofill.sys.mjs");' +
            '    out.hasFormAutofill = !!FormAutofill;' +
            '    try { out.enabled = FormAutofill.isAutofillEnabled; } catch (e) { out.enabled = null; }' +
            '  } catch (e) { out.formAutofillErr = e.message; }' +
            '  try {' +
            '    ChromeUtils.importESModule("resource://autofill/FormAutofillStorage.sys.mjs");' +
            '    out.hasStorage = true;' +
            '  } catch (e) { out.hasStorage = false; }' +
            '  return JSON.stringify(out);' +
            ' } catch (e) { return JSON.stringify({ error: e.message }); }' +
            ' })()',
          chromeContext,
        )
        if (typeof raw !== 'string') throw new Error('autofill status returned nothing')
        const info = JSON.parse(raw) as {
          error?: string
          hasFormAutofill?: boolean
          enabled?: boolean | null
          hasStorage?: boolean
          formAutofillErr?: string
        }
        if (info.error !== undefined) throw new Error(info.error)
        return (
          'FormAutofill available: ' +
          String(info.hasFormAutofill) +
          String.fromCharCode(10) +
          'autofill enabled: ' +
          String(info.enabled) +
          String.fromCharCode(10) +
          'storage module available: ' +
          String(info.hasStorage) +
          String.fromCharCode(10) +
          'NOTE: status only — editing saved addresses/cards is not exposed to this build.'
        )
      }),
  )

  defineTool(
    server,
    'browser_autofill_data',
    {
      title: 'List or edit saved form-autofill addresses',
      description:
        'Read and write the saved form-autofill ADDRESSES (not passwords). MEASURED: ' +
        'resource://autofill/FormAutofillStorage.sys.mjs exports formAutofillStorage, a FormAutofillStorage instance ' +
        'with .addresses and .creditCards; the addresses store exposes add/update/removeMany/getAll-style methods, so ' +
        'this is writable (contrary to an earlier note that only status was reachable). NOTE: the profile may serve ' +
        'addresses from the Rust store depending on extensions.formautofill.addresses.storage.rust.* prefs.',
      inputSchema: {
        action: z.enum(['list', 'add', 'remove']).describe('What to do'),
        guid: z.string().optional().describe('Address guid, for remove'),
        fields: z
          .record(z.string(), z.unknown())
          .optional()
          .describe('Address fields for add, e.g. {"given-name":"Ada","organization":"DSH"}'),
      },
      annotations: WRITES_PERSISTENTLY,
    },
    async ({
      action,
      guid,
      fields,
    }: {
      action: 'list' | 'add' | 'remove'
      guid?: string
      fields?: Record<string, unknown>
    }) => {
      const what = str(action, 'action')
      const wantedGuid = guid === undefined ? null : str(guid, 'guid')
      const payload = fields === undefined ? null : fields
      const raw = await withChrome(async (client, chromeContext) => {
        return client.evaluate(
          '(async () => {' +
            ' try {' +
            '  const { formAutofillStorage } = ChromeUtils.importESModule("resource://autofill/FormAutofillStorage.sys.mjs");' +
            '  if (!formAutofillStorage) return JSON.stringify({ error: "formAutofillStorage missing" });' +
            '  const action = ' +
            JSON.stringify(what) +
            ';' +
            '  await formAutofillStorage.initialize();' +
            '  const store = formAutofillStorage.addresses;' +
            '  if (action === "list") {' +
            '    let all = store.getAll ? await store.getAll() : [];' +
            '    if (all && typeof all[Symbol.iterator] === "function" && !Array.isArray(all)) all = Array.from(all);' +
            '    if (!Array.isArray(all)) {' +
            '      if (all && typeof all === "object") all = Object.values(all);' +
            '      else all = [];' +
            '    }' +
            '    return JSON.stringify({ ok: true, count: all.length, records: all.slice(0, 20), kind: typeof store.getAll });' +
            '  }' +
            '  if (action === "add") {' +
            '    const fields = ' +
            (payload === null ? 'null' : JSON.stringify(payload)) +
            ';' +
            '    if (!fields) return JSON.stringify({ error: "fields are required" });' +
            '    const guid = await store.add(fields);' +
            '    return JSON.stringify({ ok: true, guid, saved: typeof formAutofillStorage.save });' +
            '  }' +
            '  if (action === "remove") {' +
            '    const guid = ' +
            (wantedGuid === null ? 'null' : JSON.stringify(wantedGuid)) +
            ';' +
            '    if (!guid) return JSON.stringify({ error: "guid is required" });' +
            '    await store.remove(guid);' +
            '    return JSON.stringify({ ok: true, removed: guid });' +
            '  }' +
            '  return JSON.stringify({ error: "unknown action" });' +
            ' } catch (e) { return JSON.stringify({ error: e.message }); }' +
            ' })()',
          chromeContext,
        )
      })
      if (typeof raw !== 'string') throw new Error('autofill data returned nothing')
      const info = JSON.parse(raw) as {
        error?: string
        count?: number
        records?: unknown[]
        guid?: string
        removed?: string
      }
      if (info.error !== undefined) throw new Error(info.error)
      if (what === 'list') {
        const records = info.records ?? []
        if (records.length === 0) return 'no saved addresses'
        const lines = records.map((record) => JSON.stringify(record))
        return 'saved addresses: ' + String(info.count) + String.fromCharCode(10) + lines.join(String.fromCharCode(10))
      }
      if (what === 'add') return 'address added, guid: ' + String(info.guid)
      return 'address removed: ' + String(info.removed)
    },
  )

  defineTool(
    server,
    'browser_import_logins',
    {
      title: 'Import logins from a CSV file',
      description:
        'Import saved logins from a CSV (the format Chrome and Firefox both export). MEASURED: the module is ' +
        'resource://gre/modules/LoginCSVImport.sys.mjs and its static entry point is LoginCSVImport.importFromCSV ' +
        '(the class instance has no prototype methods). Column names are mapped by the browser itself, so pass a file ' +
        'already in the standard url/username/password layout.',
      inputSchema: {
        path: z.string().describe('Absolute path to the .csv file'),
      },
      annotations: WRITES_PERSISTENTLY,
    },
    async ({ path }: { path: string }) => {
      const filePath = str(path, 'path')
      const raw = await withChrome(async (client, chromeContext) => {
        return client.evaluate(
          '(async () => {' +
            ' try {' +
            '  const m = ChromeUtils.importESModule("resource://gre/modules/LoginCSVImport.sys.mjs");' +
            '  const C = m.LoginCSVImport;' +
            '  const file = new FileUtils.File(' +
            JSON.stringify(filePath) +
            ');' +
            '  if (!file.exists()) return JSON.stringify({ error: "file not found" });' +
            '  let text = "";' +
            '  const fis = Cc["@mozilla.org/network/file-input-stream;1"].createInstance(Ci.nsIFileInputStream);' +
            '  fis.init(file, -1, 0, 0);' +
            '  const cs = Cc["@mozilla.org/intl/converter-input-stream;1"].createInstance(Ci.nsIConverterInputStream);' +
            '  cs.init(fis, "UTF-8", 0, Ci.nsIConverterInputStream.DEFAULT_REPLACEMENT_CHARACTER);' +
            '  const chunk = {};' +
            '  while (cs.readString(4096, chunk) !== 0) text += chunk.value;' +
            '  cs.close();' +
            '  const result = await C.importFromCSV(text);' +
            '  return JSON.stringify({ ok: true, result: result === undefined ? null : result });' +
            ' } catch (e) { return JSON.stringify({ error: String(e) }); }' +
            ' })()',
          chromeContext,
        )
      })
      if (typeof raw !== 'string') throw new Error('login import returned nothing')
      const info = JSON.parse(raw) as { error?: string; result?: unknown }
      if (info.error !== undefined) throw new Error(info.error)
      return (
        'logins imported from ' + filePath + (info.result ? String.fromCharCode(10) + JSON.stringify(info.result) : '')
      )
    },
  )

  defineTool(
    server,
    'browser_import_cookies',
    {
      title: 'Import many cookies at once',
      description:
        'Set a batch of cookies in one call instead of one browser_set_cookie per cookie. Needed because Firefox allows ' +
        'only ONE active BiDi session, so an external script cannot open its own connection while this server holds ' +
        'the session — the batch has to run inside the shared session. Pass an array of {name, value, domain, path, ' +
        'expirySeconds, secure, httpOnly, sameSite}. Reports per-item failures instead of stopping on the first error.',
      inputSchema: {
        cookies: z
          .array(
            z.object({
              name: z.string(),
              value: z.string(),
              domain: z.string(),
              path: z.string().optional(),
              expirySeconds: z.number().int().positive().optional(),
              secure: z.boolean().optional(),
              httpOnly: z.boolean().optional(),
              sameSite: z.enum(['strict', 'lax', 'none']).optional(),
            }),
          )
          .describe('Cookies to set'),
      },
      annotations: WRITES_PERSISTENTLY,
    },
    async ({
      cookies,
    }: {
      cookies: Array<{
        name: string
        value: string
        domain: string
        path?: string
        expirySeconds?: number
        secure?: boolean
        httpOnly?: boolean
        sameSite?: 'strict' | 'lax' | 'none'
      }>
    }) => {
      if (!Array.isArray(cookies) || cookies.length === 0) {
        throw new Error('cookies array is required')
      }
      const results: Array<{ name: string; domain: string; ok: boolean; error?: string }> = []
      await withBidi(async (client) => {
        for (const c of cookies) {
          const cookie: Record<string, unknown> = {
            name: c.name,
            value: { type: 'string', value: c.value },
            domain: c.domain,
            path: c.path ?? '/',
          }
          if (c.expirySeconds !== undefined) cookie.expiry = c.expirySeconds
          if (c.secure !== undefined) cookie.secure = c.secure
          if (c.httpOnly !== undefined) cookie.httpOnly = c.httpOnly
          if (c.sameSite !== undefined) cookie.sameSite = c.sameSite
          try {
            await client.call('storage.setCookie', { cookie })
            results.push({ name: c.name, domain: c.domain, ok: true })
          } catch (error) {
            results.push({
              name: c.name,
              domain: c.domain,
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            })
          }
        }
      })
      const ok = results.filter((r) => r.ok).length
      const failed = results.filter((r) => !r.ok)
      const lines = ['cookies written: ' + String(ok) + ' / ' + String(results.length)]
      for (const f of failed.slice(0, 20)) {
        lines.push('  FAILED ' + f.domain + ' ' + f.name + ': ' + String(f.error).slice(0, 120))
      }
      return lines.join(String.fromCharCode(10))
    },
  )

  defineTool(
    server,
    'browser_import_cookies_from_file',
    {
      title: 'Import cookies from a JSON file',
      description:
        'Read a JSON file containing an array of cookie objects and set them all inside the existing shared BiDi session. ' +
        'Each object may have {name, value, domain, path, expirySeconds, secure, httpOnly, sameSite}. ' +
        'This exists because an external script cannot open its own BiDi session while this server holds the only one, ' +
        'and hand-typing hundreds of cookies through browser_import_cookies is impractical.',
      inputSchema: {
        path: z.string().describe('Absolute path to the JSON file'),
      },
      annotations: WRITES_PERSISTENTLY,
    },
    async ({ path }: { path: string }) => {
      const raw = readFileSync(path, 'utf8')
      const parsed: unknown = JSON.parse(raw)
      if (!Array.isArray(parsed) || parsed.length === 0) {
        throw new Error('JSON must be a non-empty array of cookie objects')
      }
      const items = parsed as Array<{
        name: string
        value: string
        domain: string
        path?: string
        expirySeconds?: number
        secure?: boolean
        httpOnly?: boolean
        sameSite?: 'strict' | 'lax' | 'none'
      }>
      const failed: Array<{ domain: string; name: string; error: string }> = []
      let ok = 0
      await withBidi(async (client) => {
        for (const c of items) {
          if (!c || typeof c.name !== 'string' || typeof c.value !== 'string' || typeof c.domain !== 'string') {
            failed.push({ domain: String(c?.domain), name: String(c?.name), error: 'missing name/value/domain' })
            continue
          }
          const cookie: Record<string, unknown> = {
            name: c.name,
            value: { type: 'string', value: c.value },
            domain: c.domain,
            path: c.path ?? '/',
          }
          if (c.expirySeconds !== undefined) cookie.expiry = c.expirySeconds
          if (c.secure !== undefined) cookie.secure = c.secure
          if (c.httpOnly !== undefined) cookie.httpOnly = c.httpOnly
          if (c.sameSite !== undefined) cookie.sameSite = c.sameSite
          try {
            await client.call('storage.setCookie', { cookie })
            ok += 1
          } catch (error) {
            failed.push({
              domain: c.domain,
              name: c.name,
              error: error instanceof Error ? error.message : String(error),
            })
          }
        }
      })
      const lines = ['cookies written: ' + String(ok) + ' / ' + String(items.length)]
      if (failed.length > 0) {
        lines.push('failed: ' + String(failed.length))
        for (const f of failed.slice(0, 15)) {
          lines.push('  FAILED ' + f.domain + ' ' + f.name + ': ' + String(f.error).slice(0, 120))
        }
      }
      return lines.join(String.fromCharCode(10))
    },
  )

  defineTool(
    server,
    'browser_import_logins_from_file',
    {
      title: 'Import logins from a JSON file',
      description:
        'Read a JSON file holding an array of {origin, user, password} and insert each one through nsILoginManager ' +
        'directly, bypassing LoginCSVImport (which fails with FILE_PERMISSIONS_ERROR in this build). ' +
        'Tell the truth about duplicates: Firefox silently merges or rejects entries whose origin+username already exist.',
      inputSchema: {
        path: z.string().describe('Absolute path to a JSON file: array of {origin, user, password}'),
      },
      annotations: WRITES_PERSISTENTLY,
    },
    async ({ path }: { path: string }) => {
      const filePath = str(path, 'path')
      const raw = await withChrome(async (client, chromeContext) => {
        return client.evaluate(
          '(async () => {' +
            ' try {' +
            '  const file = new FileUtils.File(' +
            JSON.stringify(filePath) +
            ');' +
            '  if (!file.exists()) return JSON.stringify({ error: "file not found" });' +
            '  let text = "";' +
            '  const fis = Cc["@mozilla.org/network/file-input-stream;1"].createInstance(Ci.nsIFileInputStream);' +
            '  fis.init(file, -1, 0, 0);' +
            '  const cs = Cc["@mozilla.org/intl/converter-input-stream;1"].createInstance(Ci.nsIConverterInputStream);' +
            '  cs.init(fis, "UTF-8", 0, Ci.nsIConverterInputStream.DEFAULT_REPLACEMENT_CHARACTER);' +
            '  const chunk = {};' +
            '  while (cs.readString(65536, chunk) !== 0) text += chunk.value;' +
            '  cs.close();' +
            '  const items = JSON.parse(text);' +
            '  if (!Array.isArray(items)) return JSON.stringify({ error: "JSON must be an array" });' +
            '  const lm = Cc["@mozilla.org/login-manager;1"].getService(Ci.nsILoginManager);' +
            '  let ok = 0; const failed = [];' +
            '  for (const it of items) {' +
            '   try {' +
            '    const info = Cc["@mozilla.org/login-manager/loginInfo;1"].createInstance(Ci.nsILoginInfo);' +
            '    info.init(it.origin, it.origin, null, it.user || "", it.password || "", "", "");' +
            '    await lm.addLoginAsync(info);' +
            '    ok++;' +
            '   } catch (e) { failed.push({ origin: it.origin, user: it.user, error: String(e).slice(0, 120) }); }' +
            '  }' +
            '  return JSON.stringify({ ok: ok, total: items.length, failed: failed });' +
            ' } catch (e) { return JSON.stringify({ error: String(e) }); }' +
            ' })()',
          chromeContext,
        )
      })
      if (typeof raw !== 'string') throw new Error('login import returned nothing')
      const info = JSON.parse(raw) as {
        error?: string
        ok?: number
        total?: number
        failed?: Array<{ origin: string; user: string; error: string }>
      }
      if (info.error !== undefined) throw new Error(info.error)
      const lines = ['logins inserted: ' + String(info.ok) + ' / ' + String(info.total)]
      const failed = info.failed ?? []
      if (failed.length > 0) {
        lines.push('failed: ' + String(failed.length))
        for (const f of failed.slice(0, 12)) {
          lines.push('  FAILED ' + String(f.origin).slice(0, 50) + ' ' + String(f.user).slice(0, 24) + ': ' + f.error)
        }
      }
      return lines.join(String.fromCharCode(10))
    },
  )

  defineTool(
    server,
    'browser_import_history',
    {
      title: 'Import browsing history from a JSON file',
      description:
        'Read a JSON file holding an array of {url, title, lastVisit, visitCount} and insert each into Places via ' +
        'PlacesUtils.history.insert, so migrated history keeps its original timestamps instead of looking like fresh ' +
        'visits. Entries whose url already exists are still inserted (Places merges visits for a known url).',
      inputSchema: {
        path: z.string().describe('Absolute path to a JSON file: array of {url, title, lastVisit, visitCount}'),
      },
      annotations: WRITES_PERSISTENTLY,
    },
    async ({ path }: { path: string }) => {
      const filePath = str(path, 'path')
      const raw = await withChrome(async (client, chromeContext) => {
        return client.evaluate(
          '(async () => {' +
            ' try {' +
            '  const file = new FileUtils.File(' +
            JSON.stringify(filePath) +
            ');' +
            '  if (!file.exists()) return JSON.stringify({ error: "file not found" });' +
            '  let text = "";' +
            '  const fis = Cc["@mozilla.org/network/file-input-stream;1"].createInstance(Ci.nsIFileInputStream);' +
            '  fis.init(file, -1, 0, 0);' +
            '  const cs = Cc["@mozilla.org/intl/converter-input-stream;1"].createInstance(Ci.nsIConverterInputStream);' +
            '  cs.init(fis, "UTF-8", 0, Ci.nsIConverterInputStream.DEFAULT_REPLACEMENT_CHARACTER);' +
            '  const chunk = {};' +
            '  while (cs.readString(65536, chunk) !== 0) text += chunk.value;' +
            '  cs.close();' +
            '  const items = JSON.parse(text);' +
            '  if (!Array.isArray(items)) return JSON.stringify({ error: "JSON must be an array" });' +
            '  const { PlacesUtils } = ChromeUtils.importESModule("resource://gre/modules/PlacesUtils.sys.mjs");' +
            '  let ok = 0; const failed = [];' +
            '  for (const it of items) {' +
            '   try {' +
            '    const place = { url: it.url, title: it.title || "" };' +
            '    if (it.lastVisit) place.visits = [{ date: new Date(Number(it.lastVisit)) }];' +
            '    await PlacesUtils.history.insert(place);' +
            '    ok++;' +
            '   } catch (e) { failed.push({ url: String(it.url).slice(0, 90), error: String(e).slice(0, 100) }); }' +
            '  }' +
            '  return JSON.stringify({ ok: ok, total: items.length, failed: failed });' +
            ' } catch (e) { return JSON.stringify({ error: String(e) }); }' +
            ' })()',
          chromeContext,
        )
      })
      if (typeof raw !== 'string') throw new Error('history import returned nothing')
      const info = JSON.parse(raw) as {
        error?: string
        ok?: number
        total?: number
        failed?: Array<{ url: string; error: string }>
      }
      if (info.error !== undefined) throw new Error(info.error)
      const lines = ['history inserted: ' + String(info.ok) + ' / ' + String(info.total)]
      const failed = info.failed ?? []
      if (failed.length > 0) {
        lines.push('failed: ' + String(failed.length))
        for (const f of failed.slice(0, 12)) {
          lines.push('  FAILED ' + f.url + ': ' + f.error)
        }
      }
      return lines.join(String.fromCharCode(10))
    },
  )
}
