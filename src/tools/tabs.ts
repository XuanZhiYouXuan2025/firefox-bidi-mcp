import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/server'
import { READ_ONLY, WRITES } from '../support/annotations.js'
import { withBidi, withChrome, withPage } from '../support/connection.js'
import { defineTool } from '../support/define-tool.js'

import { tabIndexForContext } from '../support/dom.js'
import { str } from '../support/strings.js'

/**
 * Tab lifecycle and active-page tools.
 *
 * Extracted from index.ts as the first domain module: they only need the
 * connection helpers and the output wrapper, so they move without touching
 * any shared state.
 */
export function registerTabs(server: McpServer): void {
  defineTool(
    server,
    'browser_page_info',
    {
      title: 'Current page info',
      description: 'Read the active tab title and URL.',
      inputSchema: {
        context: z.string().optional().describe('Tab context id (default: the active tab)'),
      },
      annotations: READ_ONLY,
    },
    async ({ context }: { context?: string }) =>
      await withPage(async (client, ctx) => {
        // One round trip instead of two: both values are cheap to read.
        const raw = await client.evaluate('JSON.stringify({ title: document.title, url: location.href })', ctx)
        let title = ''
        let url = ''
        if (typeof raw === 'string' && raw.length > 0) {
          try {
            const parsed = JSON.parse(raw) as { title?: string; url?: string }
            title = parsed.title ?? ''
            url = parsed.url ?? ''
          } catch {
            // Unexpected payload: fall back to empty strings rather than throwing.
          }
        }
        return `title: ${title}\nurl: ${url}`
      }, context),
  )

  defineTool(
    server,
    'browser_list_tabs',
    {
      title: 'List tabs',
      description: 'List open tabs with their context id, URL and title.',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => JSON.stringify(await withBidi(async (client) => await client.listTabs()), null, 2),
  )

  defineTool(
    server,
    'browser_new_tab',
    {
      title: 'Open a new tab',
      description: 'Open a new tab, optionally navigating it to a URL. Returns the new context id.',
      inputSchema: { url: z.string().optional().describe('Optional URL to open') },
      annotations: WRITES,
    },
    async ({ url }: { url?: string }) => `new tab: ${await withBidi(async (client) => await client.newTab(url))}`,
  )

  defineTool(
    server,
    'browser_close_tab',
    {
      title: 'Close a tab',
      description:
        'Close one tab (browsingContext.close). MEASURED: this closes only that tab; the browser keeps running. ' +
        'Pick the tab by context id (from browser_list_tabs), by 0-based index among the tabs of the active window, ' +
        'or default to the active tab. The reply states how many tabs remain, and warns when none are left — at that ' +
        'point Firefox itself may exit.',
      inputSchema: {
        context: z.string().optional().describe('BiDi context id of the tab to close (preferred)'),
        index: z.number().int().min(0).optional().describe('0-based index among the active tabs of the active window'),
        active: z
          .boolean()
          .optional()
          .describe('Close the active tab (default when neither context nor index is given)'),
      },
      annotations: WRITES,
    },
    async ({ context, index }: { context?: string; index?: number; active?: boolean }) =>
      await withBidi(async (client) => {
        const tree = (await client.call('browsingContext.getTree', {})) as {
          contexts?: Array<{ context: string; url?: string; children?: unknown[] }>
        }
        const tabs = tree.contexts ?? []
        let target: string | undefined
        if (context !== undefined) {
          target = str(context, 'context')
          if (!tabs.some((tab) => tab.context === target)) {
            throw new Error('no such tab context: ' + target)
          }
        } else if (index !== undefined) {
          const chosen = tabs[index]
          if (chosen === undefined) throw new Error('tab index out of range: ' + String(index))
          target = chosen.context
        } else {
          const active = await client.pageContext()
          if (active === null) throw new Error('no active tab to close')
          target = active
        }
        const closing = tabs.find((tab) => tab.context === target)
        await client.call('browsingContext.close', { context: target })
        const after = (await client.call('browsingContext.getTree', {})) as { contexts?: unknown[] }
        const remaining = (after.contexts ?? []).length
        return (
          'closed ' +
          target +
          (closing?.url === undefined ? '' : ' (' + closing.url + ')') +
          String.fromCharCode(10) +
          'tabs remaining: ' +
          String(remaining) +
          (remaining === 0 ? String.fromCharCode(10) + 'note: that was the last tab — Firefox may now exit' : '')
        )
      }),
  )

  defineTool(
    server,
    'browser_activate_tab',
    {
      title: 'Switch to a tab',
      description:
        'Make a tab the active one (browsingContext.activate). Pass its context id from browser_list_tabs, or an ' +
        'index among the tabs. Useful before typing or clicking, since input goes to the active tab.',
      inputSchema: {
        context: z.string().optional().describe('Context id of the tab to activate'),
        index: z.number().int().min(0).optional().describe('0-based tab index instead of a context id'),
      },
      annotations: WRITES,
    },
    async ({ context, index }: { context?: string; index?: number }) =>
      await withBidi(async (client) => {
        const tree = (await client.call('browsingContext.getTree', {})) as {
          contexts?: Array<{ context: string; url?: string }>
        }
        const tabs = tree.contexts ?? []
        let target: string | undefined
        if (context !== undefined) {
          target = str(context, 'context')
          if (!tabs.some((tab) => tab.context === target)) throw new Error('no such tab: ' + target)
        } else if (index !== undefined) {
          const chosen = tabs[index]
          if (chosen === undefined) throw new Error('tab index out of range: ' + String(index))
          target = chosen.context
        } else {
          throw new Error('give either context or index')
        }
        // MEASURED on Firefox 160: browsingContext.activate rejects privileged pages
        // (about:home and friends) with "does not support browsing contexts in
        // privileged scope", while a normal http(s) page activates fine. Fall back
        // to the chrome side, which can select any tab.
        let viaChrome = false
        try {
          await client.call('browsingContext.activate', { context: target })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          if (!/privileged scope/i.test(message)) throw error
          await withChrome(async (chromeClient, chromeContext) => {
            const tabIndex = await tabIndexForContext(chromeClient, target as string)
            const selected = await chromeClient.evaluate(
              '(() => { const t = gBrowser.tabs[' +
                String(tabIndex) +
                ']; if (!t) return false; gBrowser.selectedTab = t; return true; })()',
              chromeContext,
            )
            if (selected !== true) throw new Error('chrome fallback could not select the tab')
          })
          viaChrome = true
        }
        const now = tabs.find((tab) => tab.context === target)
        return (
          'activated ' +
          target +
          (now?.url === undefined ? '' : ' (' + now.url + ')') +
          (viaChrome
            ? String.fromCharCode(10) +
              'note: privileged about: page — selected through the chrome side (browsingContext.activate refuses it)'
            : '')
        )
      }),
  )
}
