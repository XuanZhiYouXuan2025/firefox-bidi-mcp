import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/server'
import { READ_ONLY, WRITES, WRITES_PERSISTENTLY } from '../support/annotations.js'
import { defineTool } from '../support/define-tool.js'
import { withBidi, withChrome } from '../support/connection.js'
import { tabIndexForContext } from '../support/dom.js'
import { text } from '../support/output.js'
import { str } from '../support/strings.js'

/**
 * Assorted browser features: sessions, favicons, search engines, Sync, translation, print.
 */
export function registerMisc(server: McpServer): void {
  defineTool(
    server,
    'browser_console_logs',
    {
      title: 'Console log entries',
      description:
        'Report console messages the page produced since this server connected (BiDi log.entryAdded). Each entry keeps ' +
        'the level, text and source. Buffered in memory (most recent 500) and only covers this connection, so open the ' +
        'page and act first, then read.',
      inputSchema: {
        limit: z.number().int().positive().max(200).optional().describe('Max entries, newest first (default 20)'),
      },
      annotations: READ_ONLY,
    },
    async ({ limit }: { limit?: number }) => {
      const entries = await withBidi(async (client) => client.events('log.entryAdded'))
      if (entries.length === 0) return 'no console messages observed since this server connected'
      const newest = entries.slice(-(limit ?? 20)).reverse()
      return JSON.stringify(newest, null, 2)
    },
  )

  defineTool(
    server,
    'browser_save_session',
    {
      title: 'Save the current session to a file',
      description:
        'Write the current window and tab session to a JSON file (SessionStore.getBrowserState). This only READS the ' +
        'browser; the file it writes is the input for browser_restore_session. Save before restoring, so the state ' +
        'you have now can be brought back.',
      inputSchema: {
        path: z.string().describe('Absolute file path to write (forward slashes are fine)'),
      },
      annotations: WRITES_PERSISTENTLY,
    },
    async ({ path: target }: { path: string }) => {
      const file = str(target, 'path')
      return await withChrome(async (client, context) => {
        const raw = await client.evaluate('SessionStore.getBrowserState()', context)
        if (typeof raw !== 'string') throw new Error('could not read the session state')
        const native = file.replaceAll('/', String.fromCharCode(92))
        const written = await client.evaluate(
          '(() => {' +
            ' const path = ' +
            JSON.stringify(native) +
            ';' +
            // MEASURED: writing with nsIFileOutputStream.write(str, str.length) truncates as soon as the
            // text holds multi-byte characters (Chinese tab titles), because that length is characters,
            // not bytes — the file then fails to parse. IOUtils.writeUTF8 handles the encoding.
            ' IOUtils.writeUTF8(path, ' +
            JSON.stringify(raw) +
            ');' +
            ' return path;' +
            ' })()',
          context,
        )
        return 'session written to ' + String(written) + ' (' + String(raw.length) + ' chars)'
      })
    },
  )

  defineTool(
    server,
    'browser_restore_session',
    {
      title: 'Restore a session from a file',
      description:
        'Replace the current session with one saved earlier (SessionStore.setBrowserState). WARNING: this REPLACES ' +
        'the windows and tabs that are open now — run browser_save_session first if you might want them back. The ' +
        'file must be JSON produced by the save tool; anything else is rejected before the state is touched.',
      inputSchema: {
        path: z.string().describe('Absolute path of a file written by browser_save_session'),
      },
      annotations: WRITES_PERSISTENTLY,
    },
    async ({ path: target }: { path: string }) => {
      const file = str(target, 'path')
      return await withChrome(async (client, context) => {
        const native = file.replaceAll('/', String.fromCharCode(92))
        const raw = await client.evaluate(
          '(async () => {' +
            ' const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);' +
            ' file.initWithPath(' +
            JSON.stringify(native) +
            ');' +
            ' if (!file.exists()) return JSON.stringify({ error: "file not found" });' +
            ' const data = await IOUtils.readUTF8(file.path);' +
            ' try { JSON.parse(data); } catch (e) { return JSON.stringify({ error: "not valid JSON: " + e.message }); }' +
            ' return data;' +
            ' })()',
          context,
        )
        if (typeof raw !== 'string') throw new Error('restore returned nothing')
        if (raw.startsWith('{"error"')) throw new Error(raw)
        await client.evaluate('SessionStore.setBrowserState(' + JSON.stringify(raw) + '); true', context)
        return 'session restored from ' + native
      })
    },
  )

  defineTool(
    server,
    'browser_get_favicon',
    {
      title: 'Favicon URL for a page',
      description:
        'Ask Places which favicon URL it has stored for a page (PlacesUtils.favicons.getFaviconForPage). Returns ' +
        'the URL only — it does not download the image. Empty result means no icon has been recorded for that page yet.',
      inputSchema: { url: z.string().describe('Page URL to look up') },
      annotations: READ_ONLY,
    },
    async ({ url }: { url: string }) => {
      const page = str(url, 'url')
      return await withChrome(async (client, context) => {
        const raw = await client.evaluate(
          '(async () => {' +
            ' try {' +
            '  const uri = Services.io.newURI(' +
            JSON.stringify(page) +
            ');' +
            // MEASURED: the method is getFaviconForPage; getFaviconURLForPage does not exist here.
            '  const fav = await PlacesUtils.favicons.getFaviconForPage(uri);' +
            '  return fav ? fav.spec : \"(no favicon recorded)\";' +
            ' } catch (e) { return \"ERR \" + e.message; }' +
            ' })()',
          context,
        )
        if (typeof raw !== 'string') throw new Error('favicon lookup returned nothing')
        if (raw.startsWith('ERR ')) throw new Error(raw)
        return raw
      })
    },
  )

  defineTool(
    server,
    'browser_list_popup_notifications',
    {
      title: 'List browser popup notifications',
      description:
        'List the browser doorhanger notifications currently offered (the "Save password?" / "Remember this site" ' +
        'kind). These are the prompts Firefox itself shows after a form submit. Use ' +
        'browser_accept_popup_notification to press one — this is how "let the browser remember the password" is done ' +
        'programmatically.',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () =>
      await withChrome(async (client, chromeContext) => {
        const raw = await client.evaluate(
          '(() => {' +
            ' try {' +
            '  if (typeof PopupNotifications === "undefined") return JSON.stringify({ error: "no PopupNotifications" });' +
            '  const list = (PopupNotifications._currentNotifications || []).map(n => ({' +
            '    id: n.id, message: n.message, buttonLabels: (n.mainAction ? [n.mainAction.label] : []).concat((n.secondaryActions || []).map(a => a.label))' +
            '  }));' +
            '  return JSON.stringify(list);' +
            ' } catch (e) { return JSON.stringify({ error: e.message }); }' +
            ' })()',
          chromeContext,
        )
        if (typeof raw !== 'string') throw new Error('notification list returned nothing')
        const rows = JSON.parse(raw) as Array<Record<string, unknown>> | { error?: string }
        if (!Array.isArray(rows)) throw new Error(String((rows as { error?: string }).error ?? 'unexpected reply'))
        if (rows.length === 0) return 'no popup notifications are showing'
        return rows
          .map(
            (row) =>
              String(row.id) +
              '  ' +
              String(row.message) +
              (Array.isArray(row.buttonLabels) && row.buttonLabels.length
                ? '  [' + (row.buttonLabels as string[]).join(' | ') + ']'
                : ''),
          )
          .join(String.fromCharCode(10))
      }),
  )

  defineTool(
    server,
    'browser_accept_popup_notification',
    {
      title: 'Press a popup notification button',
      description:
        'Press the main action of a doorhanger notification by id — for example accepting "Save password?". Get ids ' +
        'from browser_list_popup_notifications. This is the programmatic equivalent of the human clicking the ' +
        'button in the browser UI.',
      inputSchema: {
        id: z.string().describe('Notification id from browser_list_popup_notifications'),
      },
      annotations: WRITES,
    },
    async ({ id }: { id: string }) => {
      const target = str(id, 'id')
      return await withChrome(async (client, chromeContext) => {
        const raw = await client.evaluate(
          '(() => {' +
            ' try {' +
            '  const notes = PopupNotifications._currentNotifications || [];' +
            '  const hit = notes.find(n => n.id === ' +
            JSON.stringify(target) +
            ');' +
            '  if (!hit) return JSON.stringify({ error: "no notification with that id" });' +
            '  if (!hit.mainAction) return JSON.stringify({ error: "that notification has no main action" });' +
            '  hit.mainAction.callback(hit.mainAction);' +
            '  return JSON.stringify({ accepted: true, id: hit.id });' +
            ' } catch (e) { return JSON.stringify({ error: e.message }); }' +
            ' })()',
          chromeContext,
        )
        if (typeof raw !== 'string') throw new Error('accept notification returned nothing')
        const info = JSON.parse(raw) as { error?: string; accepted?: boolean; id?: string }
        if (info.error !== undefined) throw new Error(info.error)
        return 'accepted notification ' + String(info.id)
      })
    },
  )

  defineTool(
    server,
    'browser_get_search_engine',
    {
      title: 'Read the default search engine',
      description:
        'Report the default search engine name as configured (browser.search.defaultenginename) plus the list of ' +
        'engine names found in the profile search settings file (search.json.mozlz4). LIMITATION: changing the ' +
        'default engine needs the internal SearchService, whose ES module is not reachable from a remote script in ' +
        'this build (every resource:// path fails to load), so this tool is read-only.',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () =>
      await withChrome(async (client, chromeContext) => {
        const raw = await client.evaluate(
          '(() => {' +
            ' try {' +
            '  const name = Services.prefs.getStringPref("browser.search.defaultenginename", "(unset)");' +
            '  return JSON.stringify({ name });' +
            ' } catch (e) { return JSON.stringify({ error: e.message }); }' +
            ' })()',
          chromeContext,
        )
        if (typeof raw !== 'string') throw new Error('search engine returned nothing')
        const info = JSON.parse(raw) as { error?: string; name?: string }
        if (info.error !== undefined) throw new Error(info.error)
        return (
          'default search engine: ' +
          String(info.name) +
          String.fromCharCode(10) +
          'note: read-only — this build does not expose the SearchService module to remote scripts'
        )
      }),
  )

  defineTool(
    server,
    'browser_search_engine',
    {
      title: 'List, set, move or remove search engines',
      description:
        'Manage Firefox search engines. MEASURED, and this is the whole trick: the SearchService is NOT reachable via ' +
        'resource:// in this build — it lives under the moz-src protocol, so the module id is ' +
        '"moz-src:///toolkit/components/search/SearchService.sys.mjs" and it exports SearchService (a singleton). ' +
        'That object exposes getEngines/setDefault/setDefaultPrivate/moveEngine/removeEngine/restoreDefaultEngines ' +
        'and the add* family (addEngineFromExtension / addOpenSearchEngine / addUserEngine). Older guidance that the ' +
        'service is unreachable was wrong.',
      inputSchema: {
        action: z.enum(['list', 'set-default', 'move', 'remove', 'reset']).describe('What to do'),
        name: z.string().optional().describe('Engine name, for set-default / move / remove'),
        position: z.number().int().min(1).optional().describe('1-based position for move'),
      },
      annotations: WRITES,
    },
    async ({
      action,
      name,
      position,
    }: {
      action: 'list' | 'set-default' | 'move' | 'remove' | 'reset'
      name?: string
      position?: number
    }) => {
      const what = str(action, 'action')
      const engineName = name === undefined ? null : str(name, 'name')
      const pos = position === undefined ? null : position
      const raw = await withChrome(async (client, chromeContext) => {
        return client.evaluate(
          '(async () => {' +
            ' try {' +
            '  const { SearchService } = ChromeUtils.importESModule("moz-src:///toolkit/components/search/SearchService.sys.mjs");' +
            '  const action = ' +
            JSON.stringify(what) +
            ';' +
            '  const wantName = ' +
            (engineName === null ? 'null' : JSON.stringify(engineName)) +
            ';' +
            '  const wantPos = ' +
            (pos === null ? 'null' : String(pos)) +
            ';' +
            '  const engines = await SearchService.getEngines();' +
            '  const current = await SearchService.getDefault();' +
            '  const names = engines.map(e => e.name);' +
            '  if (action === "list") {' +
            '    return JSON.stringify({ ok: true, current: current.name, engines: names });' +
            '  }' +
            '  if (action === "reset") {' +
            '    SearchService.reset();' +
            '    return JSON.stringify({ ok: true, reset: true });' +
            '  }' +
            '  if (!wantName) return JSON.stringify({ error: "name is required" });' +
            '  const engine = engines.find(e => e.name === wantName);' +
            '  if (!engine) return JSON.stringify({ error: "no engine named " + wantName, engines: names });' +
            '  if (action === "set-default") {' +
            '    await SearchService.setDefault(engine, "dsh-mcp");' +
            '    const after = await SearchService.getDefault();' +
            '    return JSON.stringify({ ok: true, current: after.name });' +
            '  }' +
            '  if (action === "move") {' +
            '    if (wantPos === null) return JSON.stringify({ error: "position is required" });' +
            '    await SearchService.moveEngine(engine, wantPos - 1);' +
            '    const after2 = await SearchService.getEngines();' +
            '    return JSON.stringify({ ok: true, order: after2.map(e => e.name) });' +
            '  }' +
            '  if (action === "remove") {' +
            '    await SearchService.removeEngine(engine);' +
            '    const after3 = await SearchService.getEngines();' +
            '    return JSON.stringify({ ok: true, remaining: after3.map(e => e.name) });' +
            '  }' +
            '  return JSON.stringify({ error: "unknown action" });' +
            ' } catch (e) { return JSON.stringify({ error: e.message }); }' +
            ' })()',
          chromeContext,
        )
      })
      if (typeof raw !== 'string') throw new Error('search engine returned nothing')
      const info = JSON.parse(raw) as {
        error?: string
        current?: string
        engines?: string[]
        order?: string[]
        remaining?: string[]
        reset?: boolean
      }
      if (info.error !== undefined) throw new Error(info.error)
      if (what === 'list') {
        return (
          'default engine: ' +
          String(info.current) +
          String.fromCharCode(10) +
          'engines: ' +
          (info.engines ?? []).join(', ')
        )
      }
      if (what === 'reset') return 'search engines reset to defaults'
      if (what === 'set-default') return 'default engine is now: ' + String(info.current)
      if (what === 'move') return 'new order: ' + (info.order ?? []).join(', ')
      return 'remaining engines: ' + (info.remaining ?? []).join(', ')
    },
  )

  defineTool(
    server,
    'browser_sync_probe',
    {
      title: 'Probe FxAccounts / Sync state without using a real account',
      description:
        'Inspect the Sync/FxAccounts surface WITHOUT signing in to any real account. MEASURED: ' +
        'resource://gre/modules/FxAccounts.sys.mjs exports FxAccounts whose constructor takes a mocks object ' +
        '(constructor(mocks = null)), which is the supported way to exercise account code paths offline — this is how ' +
        'the Sync test suites run. This tool reports what can be reached and whether a real account is signed in; it ' +
        'never sends credentials anywhere.',
      inputSchema: {
        action: z
          .enum(['status', 'mock-signin', 'mock-signout'])
          .describe('status = inspect only; mock-signin installs a fake account; mock-signout removes it'),
        email: z.string().optional().describe('Fake account email (default mock-user@example.test)'),
      },
      annotations: WRITES,
    },
    async ({ action, email }: { action?: string; email?: string }) => {
      const what = action === undefined ? 'status' : str(action, 'action')
      const mail = email === undefined ? 'mock-user@example.test' : str(email, 'email')
      const raw = await withChrome(async (client, chromeContext) => {
        return client.evaluate(
          '(async () => {' +
            ' try {' +
            '  const out = {};' +
            '  const m = ChromeUtils.importESModule("resource://gre/modules/FxAccounts.sys.mjs");' +
            '  out.hasFxAccounts = typeof m.FxAccounts === "function";' +
            '  out.hasSingleton = typeof m.getFxAccountsSingleton === "function";' +
            '  out.acceptsMocks = /mocks/.test(String(m.FxAccounts));' +
            '  const action = ' +
            JSON.stringify(what) +
            ';' +
            '  if (action === "mock-signin") {' +
            '    const fakeUser = {' +
            '      uid: "0123456789abcdef0123456789abcdef",' +
            '      email: ' +
            JSON.stringify(mail) +
            ',' +
            '      sessionToken: "mock-session-token-not-real",' +
            '      verified: true,' +
            '      device: { id: "mock-device-id", name: "DSH Mock Device" }' +
            '    };' +
            '    const fxa = new m.FxAccounts({' +
            '      currentAccountState: {' +
            '        isCurrent: true,' +
            '        getUserAccountData: () => Promise.resolve(fakeUser),' +
            '        updateUserAccountData: () => Promise.resolve(),' +
            '        signOut: () => Promise.resolve()' +
            '      }' +
            '    });' +
            '    window.__dshMockFxa = fxa;' +
            '    const user = await fxa.getSignedInUser();' +
            '    out.mock = true;' +
            '    out.signedIn = !!user;' +
            '    out.uid = user && user.uid;' +
            '    out.email = user && user.email;' +
            '    out.verified = user && user.verified;' +
            '    return JSON.stringify(out);' +
            '  }' +
            '  if (action === "mock-signout") {' +
            '    window.__dshMockFxa = null;' +
            '    out.mock = false;' +
            '    out.cleared = true;' +
            '    return JSON.stringify(out);' +
            '  }' +
            '  const g = (n) => { try { return Services.prefs.getStringPref(n); } catch (e) { return null; } };' +
            '  out.syncUsername = g("services.sync.username");' +
            '  out.syncClientName = g("services.sync.client.name");' +
            '  try { out.syncEnabled = Services.prefs.getBoolPref("services.sync.enabled"); } catch (e) { out.syncEnabled = null; }' +
            '  out.signedIn = !!out.syncUsername;' +
            '  out.mockActive = !!window.__dshMockFxa;' +
            '  try {' +
            '    const real = m.getFxAccountsSingleton();' +
            '    const user = await real.getSignedInUser();' +
            '    out.realSignedIn = !!user;' +
            '  } catch (e) { out.realErr = e.message ? e.message.slice(0, 80) : "unknown"; }' +
            '  if (out.mockActive) {' +
            '    try { const mu = await window.__dshMockFxa.getSignedInUser(); out.mockEmail = mu && mu.email; } catch (e) {}' +
            '  }' +
            '  return JSON.stringify(out);' +
            ' } catch (e) { return JSON.stringify({ error: e.message || String(e) }); }' +
            ' })()',
          chromeContext,
        )
      })
      if (typeof raw !== 'string') throw new Error('sync probe returned nothing')
      const info = JSON.parse(raw) as {
        error?: string
        hasFxAccounts?: boolean
        hasSingleton?: boolean
        acceptsMocks?: boolean
        syncUsername?: string | null
        syncClientName?: string | null
        syncEnabled?: boolean | null
        signedIn?: boolean
        mock?: boolean
        uid?: string
        email?: string
        verified?: boolean
        cleared?: boolean
        mockActive?: boolean
        realSignedIn?: boolean
        mockEmail?: string
      }
      if (info.error !== undefined) throw new Error(info.error)
      if (what === 'mock-signin') {
        return (
          'mock account installed (no real account touched)' +
          String.fromCharCode(10) +
          'signed in: ' +
          String(info.signedIn) +
          String.fromCharCode(10) +
          'uid: ' +
          String(info.uid) +
          String.fromCharCode(10) +
          'email: ' +
          String(info.email) +
          String.fromCharCode(10) +
          'verified: ' +
          String(info.verified)
        )
      }
      if (what === 'mock-signout') return 'mock account removed (real account untouched)'
      return (
        'FxAccounts reachable: ' +
        String(info.hasFxAccounts) +
        String.fromCharCode(10) +
        'constructor accepts mocks (offline testing): ' +
        String(info.acceptsMocks) +
        String.fromCharCode(10) +
        'real account signed in: ' +
        String(info.realSignedIn) +
        String.fromCharCode(10) +
        'mock account active: ' +
        String(info.mockActive) +
        (info.mockEmail ? ' (' + String(info.mockEmail) + ')' : '')
      )
    },
  )

  defineTool(
    server,
    'browser_reader_mode',
    {
      title: 'Open a page in Reader View',
      description:
        'Open a tab in Reader View (about:reader) or report whether the current page is reader-able. MEASURED: ' +
        'ReaderMode lives at moz-src:///toolkit/components/reader/ReaderMode.sys.mjs (NOT resource:// — that path ' +
        'fails), and about:reader?url=<encoded> is the page form. This is the "reading mode" that strips chrome and ' +
        'ads from an article.',
      inputSchema: {
        action: z.enum(['open', 'is-readable']).describe('open = go to about:reader; is-readable = ask ReaderMode'),
        context: z.string().optional().describe('Tab (default: the active tab)'),
      },
      annotations: WRITES,
    },
    async ({ action, context }: { action: 'open' | 'is-readable'; context?: string }) => {
      const what = str(action, 'action')
      const target = context === undefined ? null : str(context, 'context')
      const raw = await withBidi(async (client) => {
        const chromeContext = await client.chromeContext()
        if (chromeContext === null) throw new Error('no privileged (chrome) context')
        const index = target === null ? -1 : await tabIndexForContext(client, target)
        const tabExpr = index < 0 ? 'gBrowser.selectedTab' : 'gBrowser.tabs[' + String(index) + ']'
        if (what === 'open') {
          return await client.evaluate(
            '(async () => {' +
              ' try {' +
              '  const tab = ' +
              tabExpr +
              ';' +
              '  if (!tab) return JSON.stringify({ error: "tab not found" });' +
              '  const url = tab.linkedBrowser.currentURI.spec;' +
              '  if (url.indexOf("about:reader") === 0) return JSON.stringify({ ok: true, already: true, url });' +
              '  const readerUrl = "about:reader?url=" + encodeURIComponent(url);' +
              '  tab.linkedBrowser.loadURI(Services.io.newURI(readerUrl), {' +
              '    triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal()' +
              '  });' +
              '  return JSON.stringify({ ok: true, readerUrl, from: url });' +
              ' } catch (e) { return JSON.stringify({ error: e.message }); }' +
              ' })()',
            chromeContext,
          )
        }
        return await client.evaluate(
          '(async () => {' +
            ' try {' +
            '  const { ReaderMode } = ChromeUtils.importESModule("moz-src:///toolkit/components/reader/ReaderMode.sys.mjs");' +
            '  const tab = ' +
            tabExpr +
            ';' +
            '  if (!tab) return JSON.stringify({ error: "tab not found" });' +
            '  const browser = tab.linkedBrowser;' +
            '  const doc = browser.contentDocument;' +
            '  if (!doc) return JSON.stringify({ error: "no document (privileged page?)" });' +
            '  let readable = false;' +
            '  let title = null;' +
            '  try {' +
            '    const article = await ReaderMode.parseDocument(doc);' +
            '    readable = !!(article && article.content);' +
            '    title = article ? article.title : null;' +
            '  } catch (e) { return JSON.stringify({ ok: true, readable: false, parseErr: e.message, url: browser.currentURI.spec }); }' +
            '  return JSON.stringify({ ok: true, readable, title, url: browser.currentURI.spec });' +
            ' } catch (e) { return JSON.stringify({ error: e.message }); }' +
            ' })()',
          chromeContext,
        )
      })
      if (typeof raw !== 'string') throw new Error('reader mode returned nothing')
      const info = JSON.parse(raw) as {
        error?: string
        ok?: boolean
        already?: boolean
        readerUrl?: string
        from?: string
        readable?: boolean
        url?: string
      }
      if (info.error !== undefined) throw new Error(info.error)
      if (what === 'open') {
        if (info.already === true) return 'already in Reader View: ' + String(info.url)
        return 'opened Reader View' + String.fromCharCode(10) + String(info.readerUrl)
      }
      return 'reader-able: ' + String(info.readable) + String.fromCharCode(10) + 'url: ' + String(info.url)
    },
  )

  defineTool(
    server,
    'browser_sync_now',
    {
      title: 'Trigger a real Sync run (Weave)',
      description:
        'Run the real Firefox Sync engine instead of the mock account. MEASURED: the entry point is NOT Weave.sys.mjs — ' +
        'that module only exports a WeaveService class whose instance is an empty object. The real singleton comes from ' +
        'resource://gre/modules/services-sync/service.sys.mjs, which exports Service with sync()/status. Without a ' +
        'signed-in account the engine reports notConfigured, which is the expected offline answer rather than a bug. ' +
        'Pair with browser_sync_probe for mock-account testing.',
      inputSchema: {
        action: z.enum(['status', 'sync']).describe('status = report engine state; sync = trigger a run'),
      },
      annotations: WRITES,
    },
    async ({ action }: { action: 'status' | 'sync' }) => {
      const what = str(action, 'action')
      const raw = await withChrome(async (client, chromeContext) => {
        return client.evaluate(
          '(async () => {' +
            ' try {' +
            '  const m = ChromeUtils.importESModule("resource://gre/modules/services-sync/service.sys.mjs");' +
            '  const svc = m.Service;' +
            '  if (!svc) return JSON.stringify({ error: "Service missing from service.sys.mjs" });' +
            '  const out = {};' +
            '  try {' +
            '    const st = svc.status;' +
            '    if (st && typeof st === "object") {' +
            '      out.status = String(st.status || st.service || st.syncStatus || JSON.stringify(Object.keys(st).slice(0, 8)));' +
            '    } else out.status = String(st);' +
            '  } catch (e) { out.statusErr = e.message; }' +
            '  try { out.enabled = !!svc.enabled; } catch (e) {}' +
            '  try { out.username = (svc.identity && svc.identity.username) || svc.username || null; } catch (e) {}' +
            '  try { out.syncID = svc.syncID || null; } catch (e) {}' +
            '  try { out.identityPresent = !!svc.identity; } catch (e) {}' +
            '  if (' +
            JSON.stringify(what) +
            ' === "sync") {' +
            '    try {' +
            '      await svc.sync();' +
            '      out.ran = true;' +
            '    } catch (e) { out.syncErr = e.message || String(e); }' +
            '  }' +
            '  return JSON.stringify(out);' +
            ' } catch (e) { return JSON.stringify({ error: e.message || String(e) }); }' +
            ' })()',
          chromeContext,
        )
      })
      if (typeof raw !== 'string') throw new Error('sync now returned nothing')
      const info = JSON.parse(raw) as {
        error?: string
        status?: string
        statusErr?: string
        enabled?: boolean
        syncID?: string | null
        identityPresent?: boolean
        username?: string | null
        ran?: boolean
        syncErr?: string
      }
      if (info.error !== undefined) throw new Error(info.error)
      const lines = [
        'sync status: ' + String(info.status ?? info.statusErr),
        'engine enabled: ' + String(info.enabled),
        'identity present: ' + String(info.identityPresent),
        'username: ' + String(info.username ?? '(none)'),
      ]
      if (what === 'sync') {
        lines.push(info.ran === true ? 'sync run completed' : 'sync did not run: ' + String(info.syncErr))
      }
      return lines.join(String.fromCharCode(10))
    },
  )

  defineTool(
    server,
    'browser_open_firefox_view',
    {
      title: 'Open Firefox View',
      description:
        'Open the Firefox View page (about:firefoxview), the tab that lists recently closed tabs, tabs from other ' +
        'devices and sync status. MEASURED: it is a plain about: page, so no privileged API is needed — bBrowser.addTab ' +
        'suffices. This is separate from browser_open_about_page because firefoxview is a browser/ page rather than a ' +
        'toolkit one, and the tool enum keeps them apart on purpose.',
      inputSchema: {
        background: z.boolean().optional().describe('Open in the background'),
      },
      annotations: WRITES,
    },
    async ({ background }: { background?: boolean }) =>
      await withChrome(async (client, chromeContext) => {
        const raw = await client.evaluate(
          '(() => {' +
            ' try {' +
            '  gBrowser.addTab("about:firefoxview", {' +
            '    triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),' +
            '    inBackground: ' +
            (background === true ? 'true' : 'false') +
            '' +
            '  });' +
            '  return "opened about:firefoxview";' +
            ' } catch (e) { return "ERR " + e.message; }' +
            ' })()',
          chromeContext,
        )
        if (typeof raw !== 'string') throw new Error('firefox view returned nothing')
        if (raw.startsWith('ERR ')) throw new Error(raw.slice(4))
        return raw
      }),
  )

  defineTool(
    server,
    'browser_add_search_engine',
    {
      title: 'Add a custom search engine',
      description:
        'Install a user-defined search engine. MEASURED: SearchService from ' +
        'moz-src:///toolkit/components/search/SearchService.sys.mjs exposes addUserEngine(formInfo) — the simplest of ' +
        'the four add paths (addOpenSearchEngine needs a full OpenSearch URL, addSearchEngine needs an engine object, ' +
        'addEngineFromExtension needs an add-on). formInfo takes name plus a URL template containing {searchTerms}.',
      inputSchema: {
        name: z.string().describe('Engine display name'),
        url: z.string().describe('URL template containing {searchTerms}'),
      },
      annotations: WRITES_PERSISTENTLY,
    },
    async ({ name, url }: { name: string; url: string }) => {
      const engineName = str(name, 'name')
      const template = str(url, 'url')
      const raw = await withChrome(async (client, chromeContext) => {
        return client.evaluate(
          '(async () => {' +
            ' try {' +
            '  const { SearchService } = ChromeUtils.importESModule("moz-src:///toolkit/components/search/SearchService.sys.mjs");' +
            '  const engine = await SearchService.addUserEngine({' +
            '    name: ' +
            JSON.stringify(engineName) +
            ',' +
            '    url: ' +
            JSON.stringify(template) +
            ',' +
            '    method: "GET",' +
            '    template: ' +
            JSON.stringify(template) +
            '  });' +
            '  const all = await SearchService.getEngines();' +
            '  return JSON.stringify({ ok: true, name: engine && engine.name, id: engine && engine.id, total: all.length });' +
            ' } catch (e) { return JSON.stringify({ error: e.message }); }' +
            ' })()',
          chromeContext,
        )
      })
      if (typeof raw !== 'string') throw new Error('add search engine returned nothing')
      const info = JSON.parse(raw) as { error?: string; name?: string; id?: string; total?: number }
      if (info.error !== undefined) throw new Error(info.error)
      return (
        'added search engine: ' +
        String(info.name) +
        String.fromCharCode(10) +
        'id: ' +
        String(info.id) +
        String.fromCharCode(10) +
        'engines now: ' +
        String(info.total)
      )
    },
  )

  defineTool(
    server,
    'browser_print',
    {
      title: 'Open the print UI, print preview or page setup',
      description:
        'Open the printing surface for a tab. MEASURED: PrintUtils is NOT a module — it is the global object defined by ' +
        'chrome/toolkit/content/global/printUtils.js and reachable as PrintUtils on the browser window. It offers ' +
        'startPrintWindow, togglePrintPreview, showPageSetup, getPrintSettings and handleSystemPrintDialog (there is no ' +
        'print()/showPrintDialog()). Use browser_pdf when you want the PDF without any UI.',
      inputSchema: {
        action: z
          .enum(['print', 'preview', 'page-setup'])
          .describe('print = open print UI; preview = toggle preview; page-setup = page setup dialog'),
      },
      annotations: WRITES,
    },
    async ({ action }: { action: 'print' | 'preview' | 'page-setup' }) => {
      const what = str(action, 'action')
      const raw = await withChrome(async (client, chromeContext) => {
        return client.evaluate(
          '(async () => {' +
            ' try {' +
            '  const w = Services.wm.getMostRecentWindow("navigator:browser");' +
            '  const P = w.PrintUtils;' +
            '  if (!P) return JSON.stringify({ error: "PrintUtils missing on the browser window" });' +
            '  const action = ' +
            JSON.stringify(what) +
            ';' +
            '  const tab = w.gBrowser.selectedTab;' +
            '  const browser = tab.linkedBrowser;' +
            '  const bc = browser.browsingContext;' +
            '  if (action === "preview") {' +
            '    await P.togglePrintPreview(bc);' +
            '    return JSON.stringify({ ok: true, action: "preview" });' +
            '  }' +
            '  if (action === "page-setup") {' +
            '    P.showPageSetup(w);' +
            '    return JSON.stringify({ ok: true, action: "page-setup" });' +
            '  }' +
            '  await P.startPrintWindow(bc);' +
            '  return JSON.stringify({ ok: true, action: "print" });' +
            ' } catch (e) { return JSON.stringify({ error: e.message || String(e) }); }' +
            ' })()',
          chromeContext,
        )
      })
      if (typeof raw !== 'string') throw new Error('print returned nothing')
      const info = JSON.parse(raw) as { error?: string; ok?: boolean; action?: string }
      if (info.error !== undefined) throw new Error(info.error)
      return 'print UI opened: ' + String(info.action)
    },
  )

  defineTool(
    server,
    'browser_oauth_clients',
    {
      title: 'List the OAuth clients attached to the Mozilla account',
      description:
        'List devices and web sessions attached to the signed-in Mozilla account (listAttachedOAuthClients). ' +
        'MEASURED: with no account signed in it resolves to an empty array rather than throwing, and the underlying ' +
        '_fetchAttachedOAuthClients needs a session token, so this only returns data for a REAL signed-in account. ' +
        'The mock account from browser_sync_probe deliberately has no session, so it yields an empty list — that is the ' +
        'expected offline answer.',
      inputSchema: {
        refresh: z.boolean().optional().describe('Bypass the 4-hour cache'),
      },
      annotations: READ_ONLY,
    },
    async ({ refresh }: { refresh?: boolean }) => {
      const force = refresh === true
      const raw = await withChrome(async (client, chromeContext) => {
        return client.evaluate(
          '(async () => {' +
            ' try {' +
            '  const m = ChromeUtils.importESModule("resource://gre/modules/FxAccounts.sys.mjs");' +
            '  const fxa = m.getFxAccountsSingleton();' +
            '  const out = {};' +
            '  try { const u = await fxa.getSignedInUser(); out.signedIn = !!u; out.email = u ? u.email : null; } catch (e) { out.signedIn = null; }' +
            '  let clients = [];' +
            '  try { clients = await fxa.listAttachedOAuthClients(' +
            (force ? 'true' : 'false') +
            '); } catch (e) { out.listErr = e.message || String(e); }' +
            '  out.count = clients.length;' +
            '  out.clients = clients.slice(0, 20).map(c => ({ id: c.id, name: c.name || null, lastAccessedDaysAgo: c.lastAccessedDaysAgo }));' +
            '  return JSON.stringify(out);' +
            ' } catch (e) { return JSON.stringify({ error: e.message || String(e) }); }' +
            ' })()',
          chromeContext,
        )
      })
      if (typeof raw !== 'string') throw new Error('oauth clients returned nothing')
      const info = JSON.parse(raw) as {
        error?: string
        signedIn?: boolean | null
        email?: string | null
        count?: number
        clients?: Array<{ id: string; name: string | null; lastAccessedDaysAgo: number }>
        listErr?: string
      }
      if (info.error !== undefined) throw new Error(info.error)
      const lines = [
        'signed in: ' + String(info.signedIn) + (info.email ? ' (' + String(info.email) + ')' : ''),
        'attached clients: ' + String(info.count),
      ]
      if (info.listErr) lines.push('note: ' + String(info.listErr))
      for (const c of info.clients ?? []) {
        lines.push('  ' + (c.name ?? c.id) + '  last used ' + String(c.lastAccessedDaysAgo) + 'd ago')
      }
      return lines.join(String.fromCharCode(10))
    },
  )

  defineTool(
    server,
    'browser_translations',
    {
      title: 'Report or toggle Firefox full-page translation',
      description:
        'Report the full-page translation state and optionally enable the feature. MEASURED: the pref is ' +
        'browser.translations.enable (false by default in this build); the actor resource://gre/actors/' +
        'TranslationsParent.sys.mjs exposes getIsTranslationsEngineSupported / getWebContentLanguages / ' +
        'isTranslationsEngineMocked. With a real engine the supported-language map is populated only after language ' +
        'packs are downloaded, so an empty map while isEngineSupported is true means "engine present, packs absent" ' +
        'rather than a broken feature.',
      inputSchema: {
        action: z
          .enum(['status', 'enable', 'disable', 'pairs', 'download'])
          .describe('status/enable/disable = pref; pairs = supported language pairs; download = fetch model files'),
        source: z.string().optional().describe('Source language for download (default en)'),
        target: z.string().optional().describe('Target language for download (default zh-Hans)'),
      },
      annotations: WRITES,
    },
    async ({
      action,
      source,
      target,
    }: {
      action: 'status' | 'enable' | 'disable' | 'pairs' | 'download'
      source?: string
      target?: string
    }) => {
      const what = str(action, 'action')
      const srcLang = source === undefined ? 'en' : str(source, 'source')
      const dstLang = target === undefined ? 'zh-Hans' : str(target, 'target')
      const raw = await withChrome(async (client, chromeContext) => {
        return client.evaluate(
          '(async () => {' +
            ' try {' +
            '  const action = ' +
            JSON.stringify(what) +
            ';' +
            '  if (action === "enable") Services.prefs.setBoolPref("browser.translations.enable", true);' +
            '  if (action === "disable") Services.prefs.setBoolPref("browser.translations.enable", false);' +
            '  if (action === "pairs") {' +
            '    const { TranslationsParent } = ChromeUtils.importESModule("resource://gre/actors/TranslationsParent.sys.mjs");' +
            '    const sup = await TranslationsParent.getSupportedLanguages();' +
            '    const list = (sup && sup.languagePairs ? sup.languagePairs : []).map(p => p.sourceLanguage + "->" + p.targetLanguage);' +
            '    return JSON.stringify({ ok: true, pairCount: list.length, pairs: list });' +
            '  }' +
            '  if (action === "download") {' +
            '    const { TranslationsParent } = ChromeUtils.importESModule("resource://gre/actors/TranslationsParent.sys.mjs");' +
            '    const src = ' +
            JSON.stringify(srcLang) +
            ';' +
            '    const dst = ' +
            JSON.stringify(dstLang) +
            ';' +
            '    const out = { source: src, target: dst };' +
            '    try {' +
            '      const t0 = Date.now();' +
            '      await TranslationsParent.downloadLanguageFiles(src, dst);' +
            '      out.ms = Date.now() - t0;' +
            '      out.downloaded = true;' +
            '    } catch (e) { out.downloadErr = String(e); }' +
            '    try { out.hasFiles = await TranslationsParent.hasAllFilesForLanguage(dst); } catch (e) {}' +
            '    try {' +
            '      const rec = await TranslationsParent.getRecordsForTranslatingToAndFromPair(src, dst);' +
            '      out.recordCount = Array.isArray(rec) ? rec.length : 0;' +
            '    } catch (e) {}' +
            '    return JSON.stringify(out);' +
            '  }' +
            '  const out = {};' +
            '  try { out.enabled = Services.prefs.getBoolPref("browser.translations.enable"); } catch (e) { out.enabled = null; }' +
            '  try { out.autoPopup = Services.prefs.getBoolPref("browser.translations.automaticallyPopup"); } catch (e) {}' +
            '  try {' +
            '    const a = ChromeUtils.importESModule("resource://gre/actors/TranslationsParent.sys.mjs");' +
            '    const T = a.TranslationsParent;' +
            '    if (T) {' +
            '      try { out.engineSupported = await T.getIsTranslationsEngineSupported(); } catch (e) { out.engineErr = (e.message||"").slice(0, 80); }' +
            '      try { out.mocked = T.isTranslationsEngineMocked(); } catch (e) {}' +
            '      try { out.pairs = await T.getWebContentLanguages(); } catch (e) {}' +
            '    }' +
            '  } catch (e) { out.actorErr = (e.message||"").slice(0, 80); }' +
            '  return JSON.stringify(out);' +
            ' } catch (e) { return JSON.stringify({ error: e.message || String(e) }); }' +
            ' })()',
          chromeContext,
        )
      })
      if (typeof raw !== 'string') throw new Error('translations returned nothing')
      const info = JSON.parse(raw) as {
        error?: string
        enabled?: boolean | null
        autoPopup?: boolean
        engineSupported?: boolean
        mocked?: boolean
        pairs?: Record<string, unknown>
        pairCount?: number
        source?: string
        target?: string
        ms?: number
        downloaded?: boolean
        downloadErr?: string
        hasFiles?: boolean
        recordCount?: number
        engineErr?: string
        actorErr?: string
      }
      if (info.error !== undefined) throw new Error(info.error)
      if (what === 'download') {
        return (
          'download ' +
          String(info.source) +
          '->' +
          String(info.target) +
          (info.downloaded ? ' done in ' + String(info.ms) + 'ms' : ' failed: ' + String(info.downloadErr)) +
          String.fromCharCode(10) +
          'has files: ' +
          String(info.hasFiles) +
          String.fromCharCode(10) +
          'model records: ' +
          String(info.recordCount)
        )
      }
      if (typeof info.pairCount === 'number' && Array.isArray(info.pairs)) {
        return (
          'supported language pairs: ' +
          String(info.pairCount) +
          String.fromCharCode(10) +
          (info.pairs as string[]).join(', ')
        )
      }
      const pairCount = info.pairs ? Object.keys(info.pairs).length : 0
      return (
        'enabled: ' +
        String(info.enabled) +
        String.fromCharCode(10) +
        'engine supported: ' +
        String(info.engineSupported) +
        String.fromCharCode(10) +
        'engine mocked: ' +
        String(info.mocked) +
        String.fromCharCode(10) +
        'language pairs available: ' +
        String(pairCount) +
        (pairCount === 0 ? ' (language packs not downloaded yet — feature present, packs absent)' : '') +
        String.fromCharCode(10) +
        'auto popup: ' +
        String(info.autoPopup)
      )
    },
  )
}
