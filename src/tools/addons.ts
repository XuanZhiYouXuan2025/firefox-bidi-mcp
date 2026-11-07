import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/server'
import { READ_ONLY, WRITES_PERSISTENTLY } from '../support/annotations.js'
import { defineTool } from '../support/define-tool.js'
import { withChrome } from '../support/connection.js'

import { str } from '../support/strings.js'

/**
 * Extension and theme management through AddonManager.
 */
export function registerAddons(server: McpServer): void {
  defineTool(
    server,
    'browser_set_addon_state',
    {
      title: 'Enable or disable an add-on',
      description:
        'Turn an installed extension on or off by id (AddonManager, privileged context). MEASURED: BiDi itself has ' +
        'no webExtension.* commands, so the privileged route is the only one available. Disabling is reversible; ' +
        'get ids from browser_list_addons.',
      inputSchema: {
        id: z.string().describe('Add-on id, as reported by browser_list_addons'),
        enabled: z.boolean().describe('true to enable, false to disable'),
      },
      annotations: WRITES_PERSISTENTLY,
    },
    async ({ id, enabled }: { id: string; enabled: boolean }) => {
      const addonId = str(id, 'id')
      return await withChrome(async (client, context) => {
        const raw = await client.evaluate(
          '(async () => {' +
            ' const addon = await AddonManager.getAddonByID(' +
            JSON.stringify(addonId) +
            ');' +
            ' if (!addon) return JSON.stringify({ error: "no such add-on" });' +
            // MEASURED: userDisabled has a getter but NO setter, so assigning it is silently
            // ignored. The supported way is addon.disable() / addon.enable().
            ' if (' +
            (enabled ? 'true' : 'false') +
            ') { await addon.enable(); } else { await addon.disable(); }' +
            ' return JSON.stringify({ id: addon.id, name: addon.name, userDisabled: addon.userDisabled, isActive: addon.isActive });' +
            ' })()',
          context,
        )
        if (typeof raw !== 'string') throw new Error('add-on operation returned nothing')
        const result = JSON.parse(raw) as { error?: string }
        if (result.error !== undefined) throw new Error(result.error + ': ' + addonId)
        return Object.entries(result)
          .map(([key, value]) => key + ': ' + String(value))
          .join(String.fromCharCode(10))
      })
    },
  )

  defineTool(
    server,
    'browser_uninstall_addon',
    {
      title: 'Uninstall an add-on',
      description:
        'Uninstall an installed extension by id (AddonManager, privileged context). This is destructive and, unlike ' +
        'browser_set_addon_state, not simply reversible — the add-on would have to be installed again. Some add-ons ' +
        'cannot be uninstalled (permissions are reported as PERM_CAN_UNINSTALL false).',
      inputSchema: { id: z.string().describe('Add-on id, as reported by browser_list_addons') },
      annotations: WRITES_PERSISTENTLY,
    },
    async ({ id }: { id: string }) => {
      const addonId = str(id, 'id')
      return await withChrome(async (client, context) => {
        const raw = await client.evaluate(
          '(async () => {' +
            ' const addon = await AddonManager.getAddonByID(' +
            JSON.stringify(addonId) +
            ');' +
            ' if (!addon) return JSON.stringify({ error: "no such add-on" });' +
            ' const permissions = addon.permissions;' +
            ' const canUninstall = (permissions & AddonManager.PERM_CAN_UNINSTALL) !== 0;' +
            ' if (!canUninstall) return JSON.stringify({ error: "this add-on cannot be uninstalled", name: addon.name });' +
            ' const name = addon.name;' +
            ' addon.uninstall();' +
            ' return JSON.stringify({ uninstalled: name, id: addon.id });' +
            ' })()',
          context,
        )
        if (typeof raw !== 'string') throw new Error('uninstall returned nothing')
        const result = JSON.parse(raw) as { error?: string; uninstalled?: string; id?: string }
        if (result.error !== undefined) throw new Error(result.error)
        return 'uninstalled ' + String(result.uninstalled) + ' (' + String(result.id) + ')'
      })
    },
  )

  defineTool(
    server,
    'browser_list_themes',
    {
      title: 'Installed themes',
      description:
        'List installed themes and which one is active (AddonManager, type "theme"). Switch with browser_set_addon_state ' +
        'on a theme id — enabling a theme disables the previously active one, so the change is reversible.',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () =>
      await withChrome(async (client, context) => {
        const raw = await client.evaluate(
          '(async () => {' +
            ' const list = await AddonManager.getAddonsByTypes(["theme"]);' +
            ' return JSON.stringify(list.map(a => ({ id: a.id, name: a.name, active: a.isActive, disabled: a.userDisabled })));' +
            ' })()',
          context,
        )
        if (typeof raw !== 'string') throw new Error('could not list themes')
        return raw
      }),
  )

  defineTool(
    server,
    'browser_install_addon',
    {
      title: 'Install an add-on from a file',
      description:
        'Install an extension from a local .xpi file or an unpacked extension directory ' +
        '(AddonManager.getInstallForFile). The path must exist and be readable by Firefox. Most add-ons work ' +
        'immediately; some need a restart. Confirm with browser_list_addons, then use browser_set_addon_state to ' +
        'enable or disable it, or browser_uninstall_addon to remove it.',
      inputSchema: {
        path: z.string().describe('Absolute path of the .xpi, or of an unpacked extension directory'),
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
            ' const install = await AddonManager.getInstallForFile(file);' +
            ' if (!install) return JSON.stringify({ error: "could not prepare an install for that file" });' +
            ' const outcome = await new Promise((resolve) => {' +
            '   install.addListener({' +
            '     onInstallEnded: () => resolve("ended"),' +
            '     onInstallFailed: () => resolve("failed"),' +
            '     onInstallCancelled: () => resolve("cancelled"),' +
            '   });' +
            '   install.install();' +
            ' });' +
            ' return JSON.stringify({ outcome, id: install.addon ? install.addon.id : null });' +
            ' })()',
          context,
        )
        if (typeof raw !== 'string') throw new Error('install returned nothing')
        const info = JSON.parse(raw) as { error?: string; outcome?: string; id?: string | null }
        if (info.error !== undefined) throw new Error(info.error)
        if (info.outcome !== 'ended') throw new Error('install did not finish: ' + String(info.outcome))
        return 'installed ' + String(info.id) + ' from ' + native
      })
    },
  )

  defineTool(
    server,
    'browser_set_theme',
    {
      title: 'Switch the active theme',
      description:
        'Activate one of the installed themes by id (from browser_list_themes), or pass default:true to go back to the ' +
        'default theme. Uses the theme add-on enable path, which is what the Add-ons manager does when you click ' +
        '"Enable". The change is visible immediately.',
      inputSchema: {
        id: z.string().optional().describe('Theme add-on id from browser_list_themes'),
        default: z.boolean().optional().describe('Go back to the default theme'),
      },
      annotations: WRITES_PERSISTENTLY,
    },
    async ({ id, default: useDefault }: { id?: string; default?: boolean }) => {
      const themeId = id === undefined ? null : str(id, 'id')
      if (themeId === null && useDefault !== true) throw new Error('give id or default:true')
      return await withChrome(async (client, chromeContext) => {
        const raw = await client.evaluate(
          '(async () => {' +
            ' try {' +
            '  const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");' +
            '  const target = ' +
            JSON.stringify(themeId) +
            ';' +
            '  const wantDefault = ' +
            (useDefault === true ? 'true' : 'false') +
            ';' +
            '  const id = wantDefault ? "default-theme@mozilla.org" : target;' +
            '  const addon = await AddonManager.getAddonByID(id);' +
            '  if (!addon) return JSON.stringify({ error: "no theme with id " + id });' +
            '  await addon.enable();' +
            '  const all = await AddonManager.getAddonsByTypes(["theme"]);' +
            '  const active = all.filter(a => a.isActive).map(a => ({ id: a.id, name: a.name }));' +
            '  return JSON.stringify({ ok: true, active });' +
            ' } catch (e) { return JSON.stringify({ error: e.message }); }' +
            ' })()',
          chromeContext,
        )
        if (typeof raw !== 'string') throw new Error('set theme returned nothing')
        const info = JSON.parse(raw) as { error?: string; active?: Array<{ id: string; name: string }> }
        if (info.error !== undefined) throw new Error(info.error)
        const active = info.active ?? []
        return 'active theme: ' + active.map((a) => a.name + ' (' + a.id + ')').join(', ')
      })
    },
  )

  defineTool(
    server,
    'browser_list_addons',
    {
      title: 'List add-ons',
      description: 'List installed extensions (privileged context).',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () =>
      JSON.stringify(
        await withChrome(
          async (client, context) =>
            await client.evaluate(
              `(async () => {
                     // MEASURED: the privileged global AddonManager lists all 13 add-ons, while the one
                     // destructured out of importESModule('.../AddonManager.sys.mjs') returned only 2 —
                     // the global is the initialised one, so use it.
                     const list = await AddonManager.getAddonsByTypes(['extension']);
                     return JSON.stringify(list.map(a => ({
                       id: a.id,
                       name: a.name,
                       version: a.version,
                       enabled: !a.userDisabled,
                       active: a.isActive,
                       hidden: a.hidden,
                     })));
                   })()`,
              context,
            ),
        ),
        null,
        2,
      ),
  )
}
