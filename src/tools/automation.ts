import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/server'
import { READ_ONLY, WRITES_PERSISTENTLY } from '../support/annotations.js'
import { defineTool } from '../support/define-tool.js'
import { withBidi, withMarionette } from '../support/connection.js'

/**
 * Automation markers (navigator.webdriver) and Global Privacy Control.
 */
let hideFlagsScriptId = ''

export function registerAutomation(server: McpServer): void {
  defineTool(
    server,
    'browser_get_gpc',
    {
      title: 'Global Privacy Control state',
      description:
        'Read whether the browser sends the Global Privacy Control signal (Sec-GPC header). NOTE: this command only ' +
        'exists in Marionette, not BiDi — so the browser must have been started with --marionette ' +
        '(scripts/launch-firefox.mjs takes care of it; port from DSH_BROWSER_MARIONETTE_PORT, default 2828).',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () =>
      await withMarionette(async (client) => {
        const payload = await client.command('GPC:GetGlobalPrivacyControl')
        // MEASURED: the reply nests the flag under `value` ({"value":{"gpc":false}}),
        // even though Set takes a flat { gpc } parameter.
        const nested = payload.value as { gpc?: unknown } | undefined
        const flag = payload.gpc ?? nested?.gpc
        return 'global privacy control: ' + String(flag)
      }),
  )

  defineTool(
    server,
    'browser_set_gpc',
    {
      title: 'Turn Global Privacy Control on or off',
      description:
        'Enable or disable the Global Privacy Control signal (requests then carry Sec-GPC: 1). MEASURED: the ' +
        'parameter is { gpc: boolean }, not { value: boolean } — the latter is rejected with ' +
        '"Value of `gpc` should be of type boolean". Marionette-only, so Firefox must run with --marionette.',
      inputSchema: { gpc: z.boolean().describe('true to send Sec-GPC, false to stop sending it') },
      annotations: WRITES_PERSISTENTLY,
    },
    async ({ gpc }: { gpc: boolean }) =>
      await withMarionette(async (client) => {
        await client.command('GPC:SetGlobalPrivacyControl', { gpc })
        const payload = await client.command('GPC:GetGlobalPrivacyControl')
        // MEASURED: the reply nests the flag under `value` ({"value":{"gpc":false}}),
        // even though Set takes a flat { gpc } parameter.
        const nested = payload.value as { gpc?: unknown } | undefined
        const flag = payload.gpc ?? nested?.gpc
        return 'global privacy control: ' + String(flag)
      }),
  )

  defineTool(
    server,
    'browser_hide_automation_flags',
    {
      title: 'Hide automation markers from pages',
      description:
        'Make pages stop seeing the automation marker: registers a BiDi preload script that reports ' +
        'navigator.webdriver as false in every new document. MEASURED: with a plain WebDriver-driven session ' +
        'navigator.webdriver is true, which is exactly what anti-bot checks look for; after this preload it reads ' +
        'false. It is a document-level patch, not a promise of undetectability — other signals (missing plugins, ' +
        'synthetic event timing, CDP-style fingerprints) can still give automation away. Pass remove:true to undo.',
      inputSchema: {
        remove: z.boolean().optional().describe('Remove the preload script again (default false = install)'),
      },
      annotations: WRITES_PERSISTENTLY,
    },
    async ({ remove }: { remove?: boolean }) =>
      await withBidi(async (client) => {
        if (remove === true) {
          // The id lives in this server process only. After a restart (or a
          // session reconnect, which also drops the preload script) there is
          // nothing to remove — saying so beats sending an empty id and
          // surfacing an obscure protocol error.
          if (hideFlagsScriptId === '') {
            return 'no automation-marker preload is installed by this server (nothing to remove)'
          }
          await client.call('script.removePreloadScript', { script: hideFlagsScriptId })
          hideFlagsScriptId = ''
          return 'automation-marker preload removed (navigator.webdriver reports its normal value again)'
        }
        const result = (await client.call('script.addPreloadScript', {
          functionDeclaration:
            '() => {' +
            ' try {' +
            '  Object.defineProperty(Navigator.prototype, "webdriver", {' +
            '    get() { return false; }, configurable: true' +
            '  });' +
            ' } catch (e) {}' +
            '}',
        })) as { script?: string }
        hideFlagsScriptId = result.script ?? ''
        return (
          'automation-marker preload installed' +
          (hideFlagsScriptId ? ' (id ' + hideFlagsScriptId + ')' : '') +
          String.fromCharCode(10) +
          'navigator.webdriver now reads false in documents loaded from now on'
        )
      }),
  )
}
