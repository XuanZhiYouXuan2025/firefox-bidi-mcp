import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { join } from 'node:path'
import { READ_ONLY, WRITES, WRITES_PERSISTENTLY } from '../support/annotations.js'
import { defineTool } from '../support/define-tool.js'
import { withChrome } from '../support/connection.js'
import { inExtensionPage, tampermonkeyCommand, tampermonkeyScriptNames } from '../support/extension-page.js'
import { text } from '../support/output.js'
import { str } from '../support/strings.js'

/**
 * Extension inspection and Tampermonkey userscript control.
 */
export function registerExtensions(server: McpServer): void {
  defineTool(
    server,
    'browser_extension_details',
    {
      title: 'Extension details: options page, popup, sidebar',
      description:
        'Report what UI entry points an extension actually exposes: its options page URL, browser action popup, and ' +
        'sidebar panel. Read from the live manifest, because AddonManager.optionsURL is null for MV3 extensions that ' +
        'declare options_ui instead of options_page — a trap worth knowing.',
      inputSchema: {
        id: z.string().describe('Extension id'),
      },
      annotations: READ_ONLY,
    },
    async ({ id }: { id: string }) => {
      const extId = str(id, 'id')
      return await withChrome(async (client, chromeContext) => {
        const raw = await client.evaluate(
          '(async () => {' +
            ' try {' +
            '  const id = ' +
            JSON.stringify(extId) +
            ';' +
            '  const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");' +
            '  const addon = await AddonManager.getAddonByID(id);' +
            '  if (!addon) return JSON.stringify({ error: "no such extension: " + id });' +
            '  const { ExtensionParent } = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");' +
            '  const policy = ExtensionParent.GlobalManager.extensionMap.get(id);' +
            '  const manifest = policy && policy.manifest ? policy.manifest : {};' +
            '  const base = policy && policy.baseURI ? policy.baseURI.spec : null;' +
            '  const page = (manifest.options_ui && manifest.options_ui.page) || manifest.options_page || null;' +
            '  const popup = manifest.action && manifest.action.default_popup ? manifest.action.default_popup :' +
            '                (manifest.browser_action && manifest.browser_action.default_popup ? manifest.browser_action.default_popup : null);' +
            '  const sidebar = manifest.sidebar_action && manifest.sidebar_action.default_panel ? manifest.sidebar_action.default_panel : null;' +
            // NOTE: the normalised manifest already stores these as absolute URLs, so joining with
            // baseURI again produced moz-extension://…/moz-extension://…/options.html. Only join
            // when the value is still a bare relative path.
            '  const isAbsolute = (v) => v.indexOf("://") !== -1 || v.indexOf("moz-extension:") === 0;' +
            '  const stripLead = (v) => { let i = 0; while (i < v.length && v.charAt(i) === "/") i++; return v.slice(i); };' +
            '  const absolutise = (v) => {' +
            '    if (!v) return null;' +
            '    if (isAbsolute(v)) return v;' +
            '    return base ? base + stripLead(v) : v;' +
            '  };' +
            '  return JSON.stringify({' +
            '    id, name: addon.name, active: addon.isActive, base,' +
            '    optionsUrl: absolutise(page),' +
            '    optionsUrlFromAddon: addon.optionsURL || null,' +
            '    popupUrl: absolutise(popup),' +
            '    sidebarUrl: absolutise(sidebar)' +
            '  });' +
            ' } catch (e) { return JSON.stringify({ error: e.message }); }' +
            ' })()',
          chromeContext,
        )
        if (typeof raw !== 'string') throw new Error('extension details returned nothing')
        const info = JSON.parse(raw) as {
          error?: string
          name?: string
          active?: boolean
          optionsUrl?: string | null
          optionsUrlFromAddon?: string | null
          popupUrl?: string | null
          sidebarUrl?: string | null
        }
        if (info.error !== undefined) throw new Error(info.error)
        const lines = ['extension: ' + String(info.name) + ' (' + (info.active ? 'active' : 'inactive') + ')']
        lines.push('  options page: ' + (info.optionsUrl ?? '(none)'))
        if (info.optionsUrl !== null && info.optionsUrl !== info.optionsUrlFromAddon) {
          lines.push(
            '  note: AddonManager.optionsURL was ' +
              String(info.optionsUrlFromAddon) +
              ' — read from the manifest instead',
          )
        }
        lines.push('  popup: ' + (info.popupUrl ?? '(none)'))
        lines.push('  sidebar: ' + (info.sidebarUrl ?? '(none)'))
        return lines.join(String.fromCharCode(10))
      })
    },
  )

  defineTool(
    server,
    'browser_open_extension_options',
    {
      title: 'Open an extension options page in a tab',
      description:
        'Open the options page of an extension in a new tab, resolved from its live manifest (options_ui.page or ' +
        'options_page). Fails clearly when the extension has no options page. Use browser_extension_details first if ' +
        'you want to see the URL without opening it.',
      inputSchema: {
        id: z.string().describe('Extension id'),
        background: z.boolean().optional().describe('Open in the background'),
      },
      annotations: WRITES,
    },
    async ({ id, background }: { id: string; background?: boolean }) => {
      const extId = str(id, 'id')
      return await withChrome(async (client, chromeContext) => {
        const raw = await client.evaluate(
          '(() => {' +
            ' try {' +
            '  const id = ' +
            JSON.stringify(extId) +
            ';' +
            '  const { ExtensionParent } = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");' +
            '  const policy = ExtensionParent.GlobalManager.extensionMap.get(id);' +
            '  if (!policy) return JSON.stringify({ error: "no such extension: " + id });' +
            '  const manifest = policy.manifest || {};' +
            '  const page = (manifest.options_ui && manifest.options_ui.page) || manifest.options_page || null;' +
            '  if (!page) return JSON.stringify({ error: "extension " + id + " declares no options page" });' +
            '  let url = page;' +
            '  if (page.indexOf("://") === -1 && page.indexOf("moz-extension:") !== 0) {' +
            '    let rel = page;' +
            '    while (rel.length > 0 && rel.charAt(0) === "/") rel = rel.slice(1);' +
            '    url = policy.baseURI.spec + rel;' +
            '  }' +
            '  const tab = gBrowser.addTab(url, {' +
            '    triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),' +
            '    inBackground: ' +
            (background === true ? 'true' : 'false') +
            '  });' +
            '  return JSON.stringify({ ok: true, url });' +
            ' } catch (e) { return JSON.stringify({ error: e.message }); }' +
            ' })()',
          chromeContext,
        )
        if (typeof raw !== 'string') throw new Error('open options returned nothing')
        const info = JSON.parse(raw) as { error?: string; url?: string }
        if (info.error !== undefined) throw new Error(info.error)
        return 'opened options page: ' + String(info.url)
      })
    },
  )

  defineTool(
    server,
    'browser_open_extension_popup',
    {
      title: "Open an extension's toolbar popup",
      description:
        'Open the browser-action popup of an extension, the same thing clicking its toolbar button does. Firefox does ' +
        'not expose extension.browserAction to remote scripts (policy.extension is undefined), so this drives the real ' +
        'UI: it opens the unified-extensions panel, finds the item for this id, and clicks its action button. Reports ' +
        'the popup URL that ended up loaded, so silence is not mistaken for success.',
      inputSchema: {
        id: z.string().describe('Extension id'),
      },
      annotations: WRITES,
    },
    async ({ id }: { id: string }) => {
      const extId = str(id, 'id')
      return await withChrome(async (client, chromeContext) => {
        const raw = await client.evaluate(
          '(async () => {' +
            ' try {' +
            '  const id = ' +
            JSON.stringify(extId) +
            ';' +
            '  const { ExtensionParent } = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");' +
            '  const policy = ExtensionParent.GlobalManager.extensionMap.get(id);' +
            '  if (!policy) return JSON.stringify({ error: "no such extension: " + id });' +
            '  const m = policy.manifest || {};' +
            '  const hasPopup = !!(m.action && m.action.default_popup) || !!(m.browser_action && m.browser_action.default_popup);' +
            '  if (!hasPopup) return JSON.stringify({ error: "extension " + id + " declares no browser action popup" });' +
            // Ask before guessing: is the button already in the toolbar?
            "  let item = document.querySelector('[data-extensionid=\"' + id + '\"]');" +
            '  if (!item) {' +
            '    const panelBtn = document.getElementById("unified-extensions-button");' +
            '    if (!panelBtn) return JSON.stringify({ error: "no unified-extensions button in this window" });' +
            '    panelBtn.click();' +
            '    await new Promise(r => setTimeout(r, 700));' +
            "    item = document.querySelector('[data-extensionid=\"' + id + '\"]');" +
            '  }' +
            '  if (!item) return JSON.stringify({ error: "extension button not found even in the extensions panel" });' +
            '  let actionBtn = null;' +
            "  for (const el of document.querySelectorAll('[data-extensionid=\"' + id + '\"]')) {" +
            '    if (String(el.className).indexOf("item-action-button") !== -1) { actionBtn = el; break; }' +
            '  }' +
            '  if (!actionBtn) actionBtn = item;' +
            '  actionBtn.click();' +
            '  await new Promise(r => setTimeout(r, 900));' +
            '  const browsers = Array.from(document.querySelectorAll(".webextension-popup-browser"));' +
            '  const urls = browsers.map(b => (b.currentURI && b.currentURI.spec) ? b.currentURI.spec : "n/a");' +
            '  return JSON.stringify({ ok: urls.length > 0, popupCount: urls.length, urls });' +
            ' } catch (e) { return JSON.stringify({ error: e.message }); }' +
            ' })()',
          chromeContext,
        )
        if (typeof raw !== 'string') throw new Error('open popup returned nothing')
        const info = JSON.parse(raw) as { error?: string; ok?: boolean; popupCount?: number; urls?: string[] }
        if (info.error !== undefined) throw new Error(info.error)
        if (info.ok !== true) return 'clicked the button but no popup panel was detected'
        return 'popup opened: ' + (info.urls ?? ['(unnamed)']).join(', ')
      })
    },
  )

  defineTool(
    server,
    'browser_close_extension_popup',
    {
      title: 'Close an open extension popup',
      description:
        'Close the tool-panel popup that browser_open_extension_popup opened, by hiding the widget panel. Firefox has no ' +
        'public "close popup" API, so this hides the panel element the popup lives in. Reports what it found and closed.',
      inputSchema: {},
      annotations: WRITES,
    },
    async () =>
      await withChrome(async (client, chromeContext) => {
        const raw = await client.evaluate(
          '(() => {' +
            ' try {' +
            '  const open = [];' +
            '  for (const p of document.querySelectorAll("panel")) {' +
            '    if (!p.hidden && p.getAttribute("panelopen") === "true") open.push(p.id || "(no id)");' +
            '  }' +
            '  const popupPanel = document.getElementById("customizationui-widget-panel");' +
            '  let closed = false;' +
            '  if (popupPanel && typeof popupPanel.hidePopup === "function") {' +
            '    popupPanel.hidePopup();' +
            '    closed = true;' +
            '  }' +
            '  return JSON.stringify({ openBefore: open, closed });' +
            ' } catch (e) { return JSON.stringify({ error: e.message }); }' +
            ' })()',
          chromeContext,
        )
        if (typeof raw !== 'string') throw new Error('close popup returned nothing')
        const info = JSON.parse(raw) as { error?: string; openBefore?: string[]; closed?: boolean }
        if (info.error !== undefined) throw new Error(info.error)
        if (!info.closed) return 'no widget panel to close (open panels: ' + (info.openBefore ?? []).join(', ') + ')'
        return 'popup panel closed'
      }),
  )

  defineTool(
    server,
    'browser_extension_storage',
    {
      title: 'Read or write an extension private storage',
      description:
        'Read or write the private key/value storage of an extension (browser.storage.local) — where an extension keeps ' +
        'its own settings and lists. It works by opening one of the extension own pages in a background tab, running ' +
        'the storage call in that page context (the only place where the extension APIs exist), then closing the tab. ' +
        'MEASURED limitation: a page of the extension is required, so extensions without an options page cannot be ' +
        'reached this way.',
      inputSchema: {
        id: z.string().describe('Extension id'),
        action: z.enum(['read', 'write', 'remove', 'clear']).describe('What to do'),
        keys: z.array(z.string()).optional().describe('Keys to read or remove (read defaults to all)'),
        data: z.record(z.string(), z.unknown()).optional().describe('Object to write'),
      },
      annotations: WRITES,
    },
    async ({
      id,
      action,
      keys,
      data,
    }: {
      id: string
      action: 'read' | 'write' | 'remove' | 'clear'
      keys?: string[]
      data?: Record<string, unknown>
    }) => {
      const extId = str(id, 'id')
      if (action === 'write' && (data === undefined || typeof data !== 'object')) {
        throw new Error('write needs data')
      }
      const expression =
        action === 'read'
          ? '(async () => { const v = await browser.storage.local.get(' +
            (keys === undefined ? 'null' : JSON.stringify(keys)) +
            '); return JSON.stringify(v); })()'
          : action === 'write'
            ? '(async () => { await browser.storage.local.set(' +
              JSON.stringify(data ?? {}) +
              '); const v = await browser.storage.local.get(null); return JSON.stringify(v); })()'
            : action === 'remove'
              ? '(async () => { await browser.storage.local.remove(' +
                JSON.stringify(keys ?? []) +
                '); const v = await browser.storage.local.get(null); return JSON.stringify(v); })()'
              : '(async () => { await browser.storage.local.clear(); const v = await browser.storage.local.get(null); return JSON.stringify(v); })()'
      const result = await inExtensionPage(extId, null, expression)
      return result
    },
  )

  defineTool(
    server,
    'browser_run_in_extension',
    {
      title: 'Run JavaScript inside an extension own page',
      description:
        'Evaluate an expression inside the context of one of the extension own pages, where the WebExtension APIs ' +
        '(browser.*) and the extension DOM are available. It opens the page in a background tab, evaluates, then closes ' +
        'the tab. This is the general escape hatch behind browser_extension_storage: with it an extension that exposes ' +
        'no command line of its own can still be inspected and driven. The expression should return a JSON value or a ' +
        'string.',
      inputSchema: {
        id: z.string().describe('Extension id'),
        expression: z.string().describe('JavaScript expression; may return a Promise'),
        page: z.string().optional().describe('Relative page to run in (default: the options page)'),
      },
      annotations: WRITES,
    },
    async ({ id, expression, page }: { id: string; expression: string; page?: string }) => {
      const extId = str(id, 'id')
      const script = str(expression, 'expression')
      const pageHint = page === undefined ? null : str(page, 'page')
      const result = await inExtensionPage(extId, pageHint, script)
      return result
    },
  )

  defineTool(
    server,
    'browser_tampermonkey_list',
    {
      title: 'List userscripts installed in Tampermonkey',
      description:
        'List the userscripts Tampermonkey currently manages, by asking its own internal API (loadTree). ' +
        'Works with the official Firefox build (firefoxbeta@tampermonkey.net) out of the box; a converted Chrome ' +
        'package needs its INTERNAL_PAGE_PROTOCOLS patched to moz-extension: first.',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      const raw = await tampermonkeyCommand({
        method: 'loadTree',
        referrer: 'options',
        layout: 'default',
        url: '',
        available_columns: [],
        complete: true,
        uuid: null,
        tabId: null,
      })
      const parsed = JSON.parse(raw) as { error?: string; items?: unknown }
      if (parsed.error !== undefined) throw new Error(parsed.error)
      const names = tampermonkeyScriptNames(raw)
      if (names.length === 0) return 'no userscript is installed'
      return names.join(String.fromCharCode(10))
    },
  )

  defineTool(
    server,
    'browser_tampermonkey_install',
    {
      title: 'Install a userscript into Tampermonkey',
      description:
        'Install (or update) a userscript by handing its source to Tampermonkey saveScript. Pass code for a whole ' +
        'userscript, or url to fetch one over HTTP first. De-duplicates by the @name header: an existing script with ' +
        'that name is updated instead of duplicated, because MEASURED saveScript creates a NEW script for every new ' +
        'uuid. Returns the assigned uuid.',
      inputSchema: {
        code: z.string().optional().describe('Full userscript source, including the ==UserScript== header'),
        url: z.string().optional().describe('Alternatively, an http(s) URL to a .user.js'),
        force: z.boolean().optional().describe('Install even when the name already exists (creates a duplicate)'),
      },
      annotations: WRITES,
    },
    async ({ code, url, force }: { code?: string; url?: string; force?: boolean }) => {
      if (code === undefined && url === undefined) throw new Error('give code or url')
      let source = code === undefined ? '' : str(code, 'code')
      if (code === undefined) {
        const target = str(url as string, 'url')
        const response = await fetch(target)
        if (!response.ok) throw new Error('fetching the userscript failed: HTTP ' + String(response.status))
        source = await response.text()
      }
      const nameMatch = /^\/\/\s*@name\s+(.+)$/m.exec(source)
      if (nameMatch === null) throw new Error('the userscript source has no @name header')
      const scriptName = String(nameMatch[1]).trim()
      if (force !== true) {
        const existing = tampermonkeyScriptNames(
          await tampermonkeyCommand({
            method: 'loadTree',
            referrer: 'options',
            layout: 'default',
            url: '',
            available_columns: [],
            complete: true,
            uuid: null,
            tabId: null,
          }),
        )
        if (existing.includes(scriptName)) {
          return (
            'already installed: ' +
            scriptName +
            String.fromCharCode(10) +
            'pass force:true to add another copy, or browser_tampermonkey_remove first'
          )
        }
      }
      const raw = await tampermonkeyCommand({
        method: 'saveScript',
        code: source,
        uuid: 'dsh-' + String(Date.now()),
        clean: false,
        force: true,
        new_script: true,
        auto_save: false,
        restore: false,
        lastModTime: null,
        reload: true,
      })
      const parsed = JSON.parse(raw) as { error?: string; installed?: boolean; uuid?: string }
      if (parsed.error !== undefined) throw new Error(parsed.error)
      if (parsed.installed !== true) return 'Tampermonkey did not confirm the install: ' + raw.slice(0, 200)
      return 'installed ' + scriptName + ' (uuid ' + String(parsed.uuid) + ')'
    },
  )

  defineTool(
    server,
    'browser_tampermonkey_set_enabled',
    {
      title: 'Enable or disable a userscript',
      description:
        'Turn a userscript on or off in Tampermonkey (modifyScriptOptions with {enabled}). Identify the script by ' +
        'uuid, or by the @name shown in browser_tampermonkey_list. A disabled script stays installed but is not injected.',
      inputSchema: {
        name: z.string().optional().describe('Script @name'),
        uuid: z.string().optional().describe('Script uuid, if you already have it'),
        enabled: z.boolean().describe('true to enable, false to disable'),
      },
      annotations: WRITES,
    },
    async ({ name, uuid, enabled }: { name?: string; uuid?: string; enabled: boolean }) => {
      if (name === undefined && uuid === undefined) throw new Error('give name or uuid')
      const target = uuid === undefined ? str(name as string, 'name') : str(uuid, 'uuid')
      const raw = await tampermonkeyCommand({
        method: 'modifyScriptOptions',
        uuid: target,
        options: { enabled: enabled },
      })
      const parsed = JSON.parse(raw) as { error?: string; items?: unknown }
      if (parsed.error !== undefined) throw new Error(parsed.error)
      return (enabled ? 'enabled ' : 'disabled ') + target
    },
  )

  defineTool(
    server,
    'browser_tampermonkey_remove',
    {
      title: 'Remove userscripts from Tampermonkey',
      description:
        'Delete userscripts by uuid or by the @name shown in browser_tampermonkey_list (purgeScripts). Removed scripts ' +
        'go to Tampermonkey trash by default, so the deletion is recoverable from its dashboard.',
      inputSchema: {
        names: z.array(z.string()).optional().describe('Script @names to remove'),
        uuids: z.array(z.string()).optional().describe('Script uuids to remove'),
      },
      annotations: WRITES_PERSISTENTLY,
    },
    async ({ names, uuids }: { names?: string[]; uuids?: string[] }) => {
      const ids: string[] = Array.isArray(uuids) ? uuids.map((value) => str(value, 'uuid')) : []
      if (Array.isArray(names) && names.length > 0) {
        const raw = await tampermonkeyCommand({
          method: 'loadTree',
          referrer: 'options',
          layout: 'default',
          url: '',
          available_columns: [],
          complete: true,
          uuid: null,
          tabId: null,
        })
        const parsed = JSON.parse(raw) as { items?: unknown }
        const wanted = new Set(names.map((value) => str(value, 'name')))
        const walk = (items: unknown): void => {
          if (!Array.isArray(items)) return
          for (const item of items) {
            if (item === null || typeof item !== 'object') continue
            const node = item as { name?: unknown; uuid?: unknown; items?: unknown }
            if (Array.isArray(node.items)) walk(node.items)
            else if (typeof node.name === 'string' && wanted.has(node.name) && typeof node.uuid === 'string') {
              ids.push(node.uuid)
            }
          }
        }
        walk(parsed.items)
        if (ids.length === 0) return 'none of those names matched an installed script'
      }
      if (ids.length === 0) throw new Error('give names or uuids')
      const raw = await tampermonkeyCommand({ method: 'purgeScripts', uuids: ids })
      const parsed = JSON.parse(raw) as { error?: string }
      if (parsed.error !== undefined) throw new Error(parsed.error)
      return 'removed ' + String(ids.length) + ' script(s)'
    },
  )

  defineTool(
    server,
    'browser_extension_permissions',
    {
      title: 'Read the permissions an extension has been granted',
      description:
        'Report the user-granted permissions and origin patterns of installed extensions. MEASURED: AddonWrapper ' +
        'exposes userPermissions.permissions (string array) and userPermissions.origins (string array), so the ' +
        'permission surface is readable without opening about:addons. Note this reads what is granted; it does not ' +
        'grant or revoke — those prompts are extension-owned UI.',
      inputSchema: {
        id: z.string().optional().describe('Only this extension id (default: every extension)'),
      },
      annotations: READ_ONLY,
    },
    async ({ id }: { id?: string }) => {
      const wanted = id === undefined ? null : str(id, 'id')
      const raw = await withChrome(async (client, chromeContext) => {
        return client.evaluate(
          '(async () => {' +
            ' try {' +
            '  const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");' +
            '  const all = await AddonManager.getAllAddons();' +
            '  const wanted = ' +
            (wanted === null ? 'null' : JSON.stringify(wanted)) +
            ';' +
            '  const rows = all' +
            '    .filter(a => a.type === "extension")' +
            '    .filter(a => wanted === null || a.id === wanted || a.id.indexOf(wanted) !== -1)' +
            '    .map(a => ({' +
            '      id: a.id,' +
            '      name: a.name,' +
            '      enabled: a.isActive,' +
            '      permissions: a.userPermissions ? (a.userPermissions.permissions || []) : [],' +
            '      origins: a.userPermissions ? (a.userPermissions.origins || []) : [],' +
            '      hostCount: a.userPermissions && a.userPermissions.origins ? a.userPermissions.origins.length : 0' +
            '    }));' +
            '  return JSON.stringify({ ok: true, rows });' +
            ' } catch (e) { return JSON.stringify({ error: e.message }); }' +
            ' })()',
          chromeContext,
        )
      })
      if (typeof raw !== 'string') throw new Error('extension permissions returned nothing')
      const info = JSON.parse(raw) as {
        error?: string
        rows?: Array<{
          id: string
          name: string
          enabled: boolean
          permissions: string[]
          origins: string[]
          hostCount: number
        }>
      }
      if (info.error !== undefined) throw new Error(info.error)
      const rows = info.rows ?? []
      if (rows.length === 0) return 'no extension matched'
      const lines: string[] = []
      for (const row of rows) {
        lines.push(row.name + '  (' + row.id + ')  ' + (row.enabled ? 'enabled' : 'disabled'))
        lines.push('  api: ' + (row.permissions.length ? row.permissions.join(', ') : '(none)'))
        lines.push(
          '  hosts: ' + String(row.hostCount) + (row.origins.length ? ' -> ' + row.origins.slice(0, 8).join(', ') : ''),
        )
      }
      return lines.join(String.fromCharCode(10))
    },
  )
}
