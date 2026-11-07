import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/server'
import { READ_ONLY, WRITES } from '../support/annotations.js'
import { defineTool } from '../support/define-tool.js'
import { withChrome } from '../support/connection.js'
import { tabIndexForContext } from '../support/dom.js'
import { text } from '../support/output.js'
import { str } from '../support/strings.js'

/**
 * Advanced tab operations: grouping, split view, moving, multi-select,
 * recently-closed tabs.
 */
export function registerTabOps(server: McpServer): void {
  defineTool(
    server,
    'browser_list_closed_tabs',
    {
      title: 'Recently closed tabs',
      description:
        'List tabs that were closed in this session (SessionStore.getClosedTabData), newest first, with the index ' +
        'that browser_reopen_closed_tab takes. The list lives in memory for the session, so it is empty after a ' +
        'restart. This is the counterpart of browser_close_tab.',
      inputSchema: { limit: z.number().int().positive().max(50).optional().describe('Max entries (default 10)') },
      annotations: READ_ONLY,
    },
    async ({ limit }: { limit?: number }) =>
      await withChrome(async (client, context) => {
        const raw = await client.evaluate(
          '(() => {' +
            ' const count = SessionStore.getClosedTabCount();' +
            ' const data = SessionStore.getClosedTabData(null);' +
            ' const items = data.slice(0, ' +
            String(limit ?? 10) +
            ').map((entry, index) => ({' +
            '  index,' +
            '  title: entry.title,' +
            '  url: entry.state && entry.state.entries ? entry.state.entries[0].url : null' +
            ' }));' +
            ' return JSON.stringify({ closedTabCount: count, items }); })()',
          context,
        )
        if (typeof raw !== 'string') throw new Error('could not read closed tabs')
        const parsed = JSON.parse(raw) as { closedTabCount: number; items: unknown[] }
        return (
          'closed tabs available: ' +
          String(parsed.closedTabCount) +
          String.fromCharCode(10) +
          JSON.stringify(parsed.items, null, 2)
        )
      }),
  )

  defineTool(
    server,
    'browser_reopen_closed_tab',
    {
      title: 'Reopen a closed tab',
      description:
        'Reopen a tab that was closed in this session (SessionStore.undoCloseTab). index 0 is the most recently ' +
        'closed tab; get indices from browser_list_closed_tabs. This undoes browser_close_tab, so the pair is ' +
        'reversible.',
      inputSchema: {
        index: z.number().int().min(0).optional().describe('0-based position among closed tabs (default 0)'),
      },
      annotations: WRITES,
    },
    async ({ index }: { index?: number }) => {
      const which = index ?? 0
      return await withChrome(async (client, context) => {
        const raw = await client.evaluate(
          '(() => {' +
            ' const index = ' +
            String(which) +
            ';' +
            ' const count = SessionStore.getClosedTabCount();' +
            ' if (count === 0) return JSON.stringify({ error: "no closed tabs to reopen" });' +
            ' if (index >= count) return JSON.stringify({ error: "index out of range, count is " + count });' +
            ' const data = SessionStore.getClosedTabData(null);' +
            ' const title = data[index] ? data[index].title : null;' +
            // MEASURED: the first argument must be a real window; passing null throws
            // "can't access property sourceWindow, aSource is null".
            ' SessionStore.undoCloseTab(window, index);' +
            ' return JSON.stringify({ reopened: title, index, before: count, after: SessionStore.getClosedTabCount() });' +
            ' })()',
          context,
        )
        if (typeof raw !== 'string') throw new Error('reopen returned nothing')
        const info = JSON.parse(raw) as {
          error?: string
          reopened?: string
          index?: number
          before?: number
          after?: number
        }
        if (info.error !== undefined) throw new Error(info.error)
        return (
          'reopened ' +
          String(info.reopened) +
          ' (index ' +
          String(info.index) +
          ')' +
          String.fromCharCode(10) +
          'closed tabs: ' +
          String(info.before) +
          ' -> ' +
          String(info.after)
        )
      })
    },
  )

  defineTool(
    server,
    'browser_split_view',
    {
      title: 'Split the window between two tabs',
      description:
        'Put two tabs side by side in one window (Firefox split view, gBrowser.addTabSplitView). Give the two tab ' +
        'contexts, or one context plus a url to open in the second pane. Useful when a human wants to watch two pages ' +
        'at once — including watching one page while the agent works on another. Reverse it with ' +
        'browser_unsplit_view, or by closing one of the two tabs.',
      inputSchema: {
        context: z.string().optional().describe('First tab context id (default: the active tab)'),
        otherContext: z.string().optional().describe('Second tab context id to put beside it'),
        url: z.string().optional().describe('Instead of otherContext: URL to open in the second pane'),
      },
      annotations: WRITES,
    },
    async ({ context, otherContext, url }: { context?: string; otherContext?: string; url?: string }) => {
      if (otherContext === undefined && url === undefined) {
        throw new Error('give otherContext or url for the second pane')
      }
      const first = context === undefined ? null : str(context, 'context')
      const second = otherContext === undefined ? null : str(otherContext, 'otherContext')
      const open = url === undefined ? null : str(url, 'url')
      return await withChrome(async (client, chromeContext) => {
        const firstIndex = first === null ? -1 : await tabIndexForContext(client, first)
        const secondIndex = second === null ? -1 : await tabIndexForContext(client, second)
        const raw = await client.evaluate(
          '(async () => {' +
            ' try {' +
            '  let a = ' +
            (firstIndex < 0 ? 'gBrowser.selectedTab' : 'gBrowser.tabs[' + String(firstIndex) + ']') +
            ';' +
            '  if (!a) return JSON.stringify({ error: "first tab not found" });' +
            '  let b = ' +
            (secondIndex < 0 ? 'null' : 'gBrowser.tabs[' + String(secondIndex) + ']') +
            ';' +
            '  if (!b && ' +
            JSON.stringify(open) +
            ') {' +
            '    b = gBrowser.addTab(' +
            JSON.stringify(open === null ? '' : open) +
            ', { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });' +
            '  }' +
            '  if (!b) return JSON.stringify({ error: "second tab not found" });' +
            '  if (a === b) return JSON.stringify({ error: "both panes are the same tab" });' +
            '  gBrowser.addTabSplitView([a, b]);' +
            '  return JSON.stringify({ first: a.label || a.linkedBrowser.currentURI.spec, second: b.label || b.linkedBrowser.currentURI.spec });' +
            ' } catch (e) { return JSON.stringify({ error: e.message }); }' +
            ' })()',
          chromeContext,
        )
        if (typeof raw !== 'string') throw new Error('split view returned nothing')
        const info = JSON.parse(raw) as { error?: string; first?: string; second?: string }
        if (info.error !== undefined) throw new Error(info.error)
        return 'split view: ' + String(info.first) + '  |  ' + String(info.second)
      })
    },
  )

  defineTool(
    server,
    'browser_unsplit_view',
    {
      title: 'Undo the split view',
      description:
        'Close the split view in the current window (gBrowser.unsplitView on the active tab). The two tabs stay open; ' +
        'they just stop sharing the window. Reports whether there was a split view to begin with.',
      inputSchema: {},
      annotations: WRITES,
    },
    async () =>
      await withChrome(async (client, chromeContext) => {
        const raw = await client.evaluate(
          '(() => {' +
            ' try {' +
            '  let sv = gBrowser.activeSplitView;' +
            '  if (!sv && gBrowser.splitViews) {' +
            '    const arr = (gBrowser.splitViews.size !== undefined) ? Array.from(gBrowser.splitViews) : Array.from(gBrowser.splitViews || []);' +
            '    if (arr.length > 0) sv = arr[0];' +
            '  }' +
            '  if (!sv) return "no split view is open";' +
            '  const panes = sv.tabs ? Array.from(sv.tabs).length : null;' +
            '  if (typeof sv.close === "function") sv.close();' +
            '  else return "split view object has no close() method";' +
            '  return "split view closed (" + panes + " panes released, tabs kept open)";' +
            ' } catch (e) { return "ERR " + e.message; }' +
            ' })()',
          chromeContext,
        )
        if (typeof raw !== 'string') throw new Error('unsplit returned nothing')
        if (raw.startsWith('ERR ')) throw new Error(raw)
        return raw
      }),
  )

  defineTool(
    server,
    'browser_group_tabs',
    {
      title: 'Put tabs into a tab group',
      description:
        'Create a tab group from the given tabs (Firefox tab groups, gBrowser.addTabGroup). Give the tab context ids; ' +
        'label and color are optional. This is the same grouping the tab strip offers, so a human can collapse or ' +
        'reopen the group from the UI afterwards.',
      inputSchema: {
        contexts: z.array(z.string()).describe('Tab context ids to group (at least one)'),
        label: z.string().optional().describe('Group label'),
        color: z
          .enum(['blue', 'purple', 'cyan', 'orange', 'yellow', 'pink', 'green', 'gray', 'red'])
          .optional()
          .describe('Group color'),
      },
      annotations: WRITES,
    },
    async ({ contexts, label, color }: { contexts: string[]; label?: string; color?: string }) => {
      if (!Array.isArray(contexts) || contexts.length === 0) throw new Error('contexts must be a non-empty array')
      const ids = contexts.map((value) => str(value, 'context'))
      const options: Record<string, unknown> = {}
      if (label !== undefined) options.label = label
      if (color !== undefined) options.color = color
      return await withChrome(async (client, chromeContext) => {
        const indices: number[] = []
        for (const id of ids) indices.push(await tabIndexForContext(client, id))
        const raw = await client.evaluate(
          '(() => {' +
            ' try {' +
            '  const idx = ' +
            JSON.stringify(indices) +
            ';' +
            '  const tabs = idx.map(i => gBrowser.tabs[i]).filter(Boolean);' +
            '  if (tabs.length === 0) return JSON.stringify({ error: "none of those tabs were found" });' +
            '  const group = gBrowser.addTabGroup(tabs, ' +
            JSON.stringify(options) +
            ');' +
            '  return JSON.stringify({ grouped: tabs.length, label: group && group.label ? group.label : null, id: group ? group.id : null });' +
            ' } catch (e) { return JSON.stringify({ error: e.message }); }' +
            ' })()',
          chromeContext,
        )
        if (typeof raw !== 'string') throw new Error('grouping returned nothing')
        const info = JSON.parse(raw) as { error?: string; grouped?: number; label?: string | null; id?: string | null }
        if (info.error !== undefined) throw new Error(info.error)
        return (
          'grouped ' +
          String(info.grouped) +
          ' tab(s)' +
          (info.label ? ' as "' + info.label + '"' : '') +
          (info.id ? ' (group id ' + info.id + ')' : '')
        )
      })
    },
  )

  defineTool(
    server,
    'browser_duplicate_tab',
    {
      title: 'Clone a tab',
      description:
        'Duplicate a tab, keeping its history and state (Firefox tab cloning, gBrowser.duplicateTab). The clone opens ' +
        'next to the original. Duplicating is the cheapest way to keep "where I was" while the agent continues in the ' +
        'new copy — close the extra tab when you are done.',
      inputSchema: {
        context: z.string().optional().describe('Tab context id to clone (default: the active tab)'),
        background: z.boolean().optional().describe('Open the clone in the background (default false)'),
      },
      annotations: WRITES,
    },
    async ({ context, background }: { context?: string; background?: boolean }) => {
      const target = context === undefined ? null : str(context, 'context')
      return await withChrome(async (client, chromeContext) => {
        const tabIndex = target === null ? -1 : await tabIndexForContext(client, target)
        const raw = await client.evaluate(
          '(() => {' +
            ' try {' +
            '  const byId = (id) => Array.from(gBrowser.tabs).find(t => t.linkedBrowser && t.linkedBrowser.browsingContext && t.linkedBrowser.browsingContext.id === id);' +
            '  const tab = ' +
            (target === null ? 'gBrowser.selectedTab' : 'gBrowser.tabs[' + String(tabIndex) + ']') +
            ';' +
            '  if (!tab) return JSON.stringify({ error: "tab not found" });' +
            '  const copy = gBrowser.duplicateTab(tab, ' +
            (background === true ? 'true' : 'false') +
            ');' +
            '  return JSON.stringify({ cloned: tab.linkedBrowser.currentURI.spec, tabs: gBrowser.tabs.length });' +
            ' } catch (e) { return JSON.stringify({ error: e.message }); }' +
            ' })()',
          chromeContext,
        )
        if (typeof raw !== 'string') throw new Error('duplicate returned nothing')
        const info = JSON.parse(raw) as { error?: string; cloned?: string; tabs?: number }
        if (info.error !== undefined) throw new Error(info.error)
        return 'cloned ' + String(info.cloned) + ' (tabs now: ' + String(info.tabs) + ')'
      })
    },
  )

  defineTool(
    server,
    'browser_pin_tab',
    {
      title: 'Pin or unpin a tab',
      description:
        'Pin a tab (it shrinks to an icon and stops being closed by "close others") or unpin it again. This is the ' +
        'same state the tab context menu toggles.',
      inputSchema: {
        context: z.string().optional().describe('Tab context id (default: the active tab)'),
        pinned: z.boolean().describe('true to pin, false to unpin'),
      },
      annotations: WRITES,
    },
    async ({ context, pinned }: { context?: string; pinned: boolean }) => {
      const target = context === undefined ? null : str(context, 'context')
      return await withChrome(async (client, chromeContext) => {
        const index = target === null ? -1 : await tabIndexForContext(client, target)
        const raw = await client.evaluate(
          '(() => {' +
            ' try {' +
            '  const tab = ' +
            (index < 0 ? 'gBrowser.selectedTab' : 'gBrowser.tabs[' + String(index) + ']') +
            ';' +
            '  if (!tab) return JSON.stringify({ error: "tab not found at index " + ' +
            String(index) +
            ' });' +
            '  if (' +
            (pinned ? 'true' : 'false') +
            ') { gBrowser.pinTab(tab); } else { gBrowser.unpinTab(tab); }' +
            '  return JSON.stringify({ pinned: tab.pinned, url: tab.linkedBrowser.currentURI.spec });' +
            ' } catch (e) { return JSON.stringify({ error: e.message }); }' +
            ' })()',
          chromeContext,
        )
        if (typeof raw !== 'string') throw new Error('pin returned nothing')
        const info = JSON.parse(raw) as { error?: string; pinned?: boolean; url?: string }
        if (info.error !== undefined) throw new Error(info.error)
        return (info.pinned ? 'pinned ' : 'unpinned ') + String(info.url)
      })
    },
  )

  defineTool(
    server,
    'browser_mute_tab',
    {
      title: 'Mute or unmute a tab',
      description:
        'Mute a tab so it stays silent in the background, or unmute it. Mirrors the "mute tab" item in the tab ' +
        'context menu. Reports whether the tab is now muted.',
      inputSchema: {
        context: z.string().optional().describe('Tab context id (default: the active tab)'),
        muted: z.boolean().describe('true to mute, false to unmute'),
      },
      annotations: WRITES,
    },
    async ({ context, muted }: { context?: string; muted: boolean }) => {
      const target = context === undefined ? null : str(context, 'context')
      return await withChrome(async (client, chromeContext) => {
        const tabIndex = target === null ? -1 : await tabIndexForContext(client, target)
        const raw = await client.evaluate(
          '(() => {' +
            ' try {' +
            '  const byId = (id) => Array.from(gBrowser.tabs).find(t => t.linkedBrowser && t.linkedBrowser.browsingContext && t.linkedBrowser.browsingContext.id === id);' +
            '  const tab = ' +
            (target === null ? 'gBrowser.selectedTab' : 'gBrowser.tabs[' + String(tabIndex) + ']') +
            ';' +
            '  if (!tab) return JSON.stringify({ error: "tab not found" });' +
            '  const want = ' +
            (muted ? 'true' : 'false') +
            ';' +
            '  if (!!tab.muted !== want) { tab.toggleMuteAudio(); }' +
            '  return JSON.stringify({ muted: !!tab.muted, url: tab.linkedBrowser.currentURI.spec });' +
            ' } catch (e) { return JSON.stringify({ error: e.message }); }' +
            ' })()',
          chromeContext,
        )
        if (typeof raw !== 'string') throw new Error('mute returned nothing')
        const info = JSON.parse(raw) as { error?: string; muted?: boolean; url?: string }
        if (info.error !== undefined) throw new Error(info.error)
        return (info.muted ? 'muted ' : 'unmuted ') + String(info.url)
      })
    },
  )

  defineTool(
    server,
    'browser_close_other_tabs',
    {
      title: 'Close every tab except one',
      description:
        'Close all tabs in the window except the given one ("close other tabs" in the tab context menu). Pinned tabs ' +
        'are left alone, the same way the menu behaves. Use it to clean up after a series of agent tabs.',
      inputSchema: {
        context: z.string().optional().describe('Tab context id to keep (default: the active tab)'),
      },
      annotations: WRITES,
    },
    async ({ context }: { context?: string }) => {
      const target = context === undefined ? null : str(context, 'context')
      return await withChrome(async (client, chromeContext) => {
        const tabIndex = target === null ? -1 : await tabIndexForContext(client, target)
        const raw = await client.evaluate(
          '(() => {' +
            ' try {' +
            '  const byId = (id) => Array.from(gBrowser.tabs).find(t => t.linkedBrowser && t.linkedBrowser.browsingContext && t.linkedBrowser.browsingContext.id === id);' +
            '  const keep = ' +
            (target === null ? 'gBrowser.selectedTab' : 'gBrowser.tabs[' + String(tabIndex) + ']') +
            ';' +
            '  if (!keep) return JSON.stringify({ error: "tab not found" });' +
            '  const before = gBrowser.tabs.length;' +
            '  const doomed = Array.from(gBrowser.tabs).filter(t => t !== keep && !t.pinned);' +
            '  gBrowser.removeTabs(doomed);' +
            '  return JSON.stringify({ closed: doomed.length, before, after: gBrowser.tabs.length });' +
            ' } catch (e) { return JSON.stringify({ error: e.message }); }' +
            ' })()',
          chromeContext,
        )
        if (typeof raw !== 'string') throw new Error('close others returned nothing')
        const info = JSON.parse(raw) as { error?: string; closed?: number; after?: number }
        if (info.error !== undefined) throw new Error(info.error)
        return 'closed ' + String(info.closed) + ' tab(s), ' + String(info.after) + ' left'
      })
    },
  )

  defineTool(
    server,
    'browser_close_tabs_to_right',
    {
      title: 'Close the tabs to the right',
      description:
        'Close every tab to the right of the given one ("close tabs to the right" in the tab context menu). Pinned ' +
        'tabs at the end are kept, matching the menu behaviour.',
      inputSchema: {
        context: z.string().optional().describe('Tab context id acting as the left boundary (default: the active tab)'),
      },
      annotations: WRITES,
    },
    async ({ context }: { context?: string }) => {
      const target = context === undefined ? null : str(context, 'context')
      return await withChrome(async (client, chromeContext) => {
        const tabIndex = target === null ? -1 : await tabIndexForContext(client, target)
        const raw = await client.evaluate(
          '(() => {' +
            ' try {' +
            '  const byId = (id) => Array.from(gBrowser.tabs).find(t => t.linkedBrowser && t.linkedBrowser.browsingContext && t.linkedBrowser.browsingContext.id === id);' +
            '  const anchor = ' +
            (target === null ? 'gBrowser.selectedTab' : 'gBrowser.tabs[' + String(tabIndex) + ']') +
            ';' +
            '  if (!anchor) return JSON.stringify({ error: "tab not found" });' +
            '  const all = Array.from(gBrowser.tabs);' +
            '  const at = all.indexOf(anchor);' +
            '  const doomed = all.slice(at + 1).filter(t => !t.pinned);' +
            '  gBrowser.removeTabs(doomed);' +
            '  return JSON.stringify({ closed: doomed.length, after: gBrowser.tabs.length });' +
            ' } catch (e) { return JSON.stringify({ error: e.message }); }' +
            ' })()',
          chromeContext,
        )
        if (typeof raw !== 'string') throw new Error('close right returned nothing')
        const info = JSON.parse(raw) as { error?: string; closed?: number; after?: number }
        if (info.error !== undefined) throw new Error(info.error)
        return 'closed ' + String(info.closed) + ' tab(s), ' + String(info.after) + ' left'
      })
    },
  )

  defineTool(
    server,
    'browser_move_tab_to_window',
    {
      title: 'Move a tab into its own window',
      description:
        'Take a tab out of its window and put it in a new window (gBrowser.replaceTabWithWindow). Handy to park a page ' +
        'on a second monitor — or to keep one page visible while the agent works in another window.',
      inputSchema: {
        context: z.string().optional().describe('Tab context id to move (default: the active tab)'),
      },
      annotations: WRITES,
    },
    async ({ context }: { context?: string }) => {
      const target = context === undefined ? null : str(context, 'context')
      return await withChrome(async (client, chromeContext) => {
        const tabIndex = target === null ? -1 : await tabIndexForContext(client, target)
        const raw = await client.evaluate(
          '(() => {' +
            ' try {' +
            '  const byId = (id) => Array.from(gBrowser.tabs).find(t => t.linkedBrowser && t.linkedBrowser.browsingContext && t.linkedBrowser.browsingContext.id === id);' +
            '  const tab = ' +
            (target === null ? 'gBrowser.selectedTab' : 'gBrowser.tabs[' + String(tabIndex) + ']') +
            ';' +
            '  if (!tab) return JSON.stringify({ error: "tab not found" });' +
            '  if (gBrowser.tabs.length <= 1) return JSON.stringify({ error: "that is the last tab in the window" });' +
            '  const url = tab.linkedBrowser.currentURI.spec;' +
            '  const win = gBrowser.replaceTabWithWindow(tab);' +
            '  return JSON.stringify({ moved: url, newWindowId: win && win.docShell ? "opened" : "opened" });' +
            ' } catch (e) { return JSON.stringify({ error: e.message }); }' +
            ' })()',
          chromeContext,
        )
        if (typeof raw !== 'string') throw new Error('move returned nothing')
        const info = JSON.parse(raw) as { error?: string; moved?: string }
        if (info.error !== undefined) throw new Error(info.error)
        return 'moved to a new window: ' + String(info.moved)
      })
    },
  )

  defineTool(
    server,
    'browser_move_tab_to_container',
    {
      title: 'Reopen a tab inside a container',
      description:
        'Reopen the current page in a tab belonging to a container/user context, then close the original ' +
        '(ContextualIdentityService). This is how the tab context menu moves a tab into a container. Get container ids ' +
        'from browser_list_user_contexts; the page reloads, so in-page state is lost.',
      inputSchema: {
        context: z.string().optional().describe('Tab context id to move (default: the active tab)'),
        userContext: z.string().describe('Container id from browser_list_user_contexts'),
      },
      annotations: WRITES,
    },
    async ({ context, userContext }: { context?: string; userContext: string }) => {
      const target = context === undefined ? null : str(context, 'context')
      const container = str(userContext, 'userContext')
      return await withChrome(async (client, chromeContext) => {
        const tabIndex = target === null ? -1 : await tabIndexForContext(client, target)
        const raw = await client.evaluate(
          '(() => {' +
            ' try {' +
            '  const byId = (id) => Array.from(gBrowser.tabs).find(t => t.linkedBrowser && t.linkedBrowser.browsingContext && t.linkedBrowser.browsingContext.id === id);' +
            '  const tab = ' +
            (target === null ? 'gBrowser.selectedTab' : 'gBrowser.tabs[' + String(tabIndex) + ']') +
            ';' +
            '  if (!tab) return JSON.stringify({ error: "tab not found" });' +
            '  const id = Number(' +
            JSON.stringify(container) +
            ');' +
            '  if (!Number.isInteger(id) || id < 1) return JSON.stringify({ error: "userContext must be a container id (a number >= 1)" });' +
            '  const identity = ContextualIdentityService.getPublicIdentityFromId(id);' +
            '  if (!identity) return JSON.stringify({ error: "no such container: " + id });' +
            '  const url = tab.linkedBrowser.currentURI.spec;' +
            '  const newTab = gBrowser.addTab(url, { userContextId: id, triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });' +
            '  gBrowser.removeTab(tab);' +
            '  gBrowser.selectedTab = newTab;' +
            '  return JSON.stringify({ moved: url, container: identity.name });' +
            ' } catch (e) { return JSON.stringify({ error: e.message }); }' +
            ' })()',
          chromeContext,
        )
        if (typeof raw !== 'string') throw new Error('move to container returned nothing')
        const info = JSON.parse(raw) as { error?: string; moved?: string; container?: string }
        if (info.error !== undefined) throw new Error(info.error)
        return 'moved ' + String(info.moved) + ' into container "' + String(info.container) + '"'
      })
    },
  )

  defineTool(
    server,
    'browser_move_tab',
    {
      title: 'Reorder a tab',
      description:
        'Move a tab to a new position in the tab strip. target is one of: start, end, before, after, index. For ' +
        'before/after give the reference tab context; for index give a 0-based position. This is drag-and-drop on the ' +
        'tab strip, done without the mouse (gBrowser.moveTabTo / moveTabToStart / moveTabToEnd).',
      inputSchema: {
        context: z.string().optional().describe('Tab to move (default: the active tab)'),
        target: z.enum(['start', 'end', 'before', 'after', 'index']).describe('Where to move it'),
        reference: z.string().optional().describe('Reference tab context for before/after'),
        index: z.number().int().nonnegative().optional().describe('0-based position for target=index'),
      },
      annotations: WRITES,
    },
    async ({
      context,
      target,
      reference,
      index,
    }: {
      context?: string
      target: 'start' | 'end' | 'before' | 'after' | 'index'
      reference?: string
      index?: number
    }) => {
      const moving = context === undefined ? null : str(context, 'context')
      const ref = reference === undefined ? null : str(reference, 'reference')
      if ((target === 'before' || target === 'after') && ref === null) {
        throw new Error('target=' + target + ' needs reference')
      }
      if (target === 'index' && (index === undefined || index < 0)) throw new Error('target=index needs index')
      return await withChrome(async (client, chromeContext) => {
        const moveIndex = moving === null ? -1 : await tabIndexForContext(client, moving)
        const refIndex = ref === null ? -1 : await tabIndexForContext(client, ref)
        const raw = await client.evaluate(
          '(() => {' +
            ' try {' +
            '  const tab = ' +
            (moveIndex < 0 ? 'gBrowser.selectedTab' : 'gBrowser.tabs[' + String(moveIndex) + ']') +
            ';' +
            '  if (!tab) return JSON.stringify({ error: "tab not found" });' +
            '  const which = ' +
            JSON.stringify(target) +
            ';' +
            '  if (which === "start") gBrowser.moveTabToStart(tab);' +
            '  else if (which === "end") gBrowser.moveTabToEnd(tab);' +
            '  else if (which === "before" || which === "after") {' +
            '    const refTab = ' +
            (refIndex < 0 ? 'null' : 'gBrowser.tabs[' + String(refIndex) + ']') +
            ';' +
            '    if (!refTab) return JSON.stringify({ error: "reference tab not found" });' +
            '    if (which === "before") gBrowser.moveTabBefore(tab, refTab); else gBrowser.moveTabAfter(tab, refTab);' +
            '  } else {' +
            '    gBrowser.moveTabTo(tab, ' +
            String(index ?? 0) +
            ');' +
            '  }' +
            '  return JSON.stringify({ position: Array.from(gBrowser.tabs).indexOf(tab), url: tab.linkedBrowser.currentURI.spec });' +
            ' } catch (e) { return JSON.stringify({ error: e.message }); }' +
            ' })()',
          chromeContext,
        )
        if (typeof raw !== 'string') throw new Error('move returned nothing')
        const info = JSON.parse(raw) as { error?: string; position?: number; url?: string }
        if (info.error !== undefined) throw new Error(info.error)
        return 'moved ' + String(info.url) + ' to position ' + String(info.position)
      })
    },
  )

  defineTool(
    server,
    'browser_remove_duplicate_tabs',
    {
      title: 'Close duplicate tabs',
      description:
        'Close tabs that load the same page as another tab, keeping one of each (gBrowser.removeDuplicateTabs). This ' +
        'is the same cleanup the tab context menu offers when it notices duplicates. Reports how many were closed.',
      inputSchema: {},
      annotations: WRITES,
    },
    async () =>
      await withChrome(async (client, chromeContext) => {
        const raw = await client.evaluate(
          '(() => {' +
            ' try {' +
            '  const before = gBrowser.tabs.length;' +
            '  gBrowser.removeDuplicateTabs(gBrowser.selectedTab);' +
            '  return JSON.stringify({ before, after: gBrowser.tabs.length });' +
            ' } catch (e) { return JSON.stringify({ error: e.message }); }' +
            ' })()',
          chromeContext,
        )
        if (typeof raw !== 'string') throw new Error('dedupe returned nothing')
        const info = JSON.parse(raw) as { error?: string; before?: number; after?: number }
        if (info.error !== undefined) throw new Error(info.error)
        return (
          'closed ' +
          String(Number(info.before) - Number(info.after)) +
          ' duplicate tab(s), ' +
          String(info.after) +
          ' left'
        )
      }),
  )

  defineTool(
    server,
    'browser_close_tabs_by_url',
    {
      title: 'Close every tab showing a URL',
      description:
        'Close all tabs whose URL contains the given text. MEASURED: gBrowser.closeTabsByURI takes nsIURI objects and ' +
        'matches them EXACTLY, so it cannot do substrings — this walks the tabs and calls removeTab instead. The value ' +
        'is matched as a substring against the tab URL, so "example.com" catches all of that site. Useful to clean up after a ' +
        'batch run without touching unrelated tabs.',
      inputSchema: {
        pattern: z.string().describe('Text or regex matched against tab URLs'),
      },
      annotations: WRITES,
    },
    async ({ pattern }: { pattern: string }) => {
      const needle = str(pattern, 'pattern')
      return await withChrome(async (client, chromeContext) => {
        const raw = await client.evaluate(
          '(() => {' +
            ' try {' +
            '  const before = gBrowser.tabs.length;' +
            '  let matched = 0;' +
            '  for (const t of Array.from(gBrowser.tabs)) {' +
            '    const spec = t.linkedBrowser.currentURI.spec;' +
            '    if (spec.includes(' +
            JSON.stringify(needle) +
            ')) {' +
            '      matched++;' +
            '      gBrowser.removeTab(t);' +
            '    }' +
            '  }' +
            '  return JSON.stringify({ before, after: gBrowser.tabs.length, matched });' +
            ' } catch (e) { return JSON.stringify({ error: e.message }); }' +
            ' })()',
          chromeContext,
        )
        if (typeof raw !== 'string') throw new Error('close by url returned nothing')
        const info = JSON.parse(raw) as { error?: string; before?: number; after?: number }
        if (info.error !== undefined) throw new Error(info.error)
        return 'closed ' + String(Number(info.before) - Number(info.after)) + ' tab(s) matching ' + needle
      })
    },
  )

  defineTool(
    server,
    'browser_list_tab_groups',
    {
      title: 'List tab groups',
      description:
        'List the tab groups (collapsible groups in the tab strip) with their id, label, colour, collapsed state and ' +
        'the tabs inside (gBrowser.getAllTabGroups). Use the id with browser_remove_tab_group or ' +
        'browser_ungroup_tabs.',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () =>
      await withChrome(async (client, chromeContext) => {
        const raw = await client.evaluate(
          '(() => {' +
            ' try {' +
            '  const groups = gBrowser.getAllTabGroups().map(g => ({' +
            '    id: g.id, label: g.label, color: g.color, collapsed: !!g.collapsed,' +
            '    tabs: Array.from(g.tabs || []).map(t => t.linkedBrowser ? t.linkedBrowser.currentURI.spec : null)' +
            '  }));' +
            '  return JSON.stringify(groups);' +
            ' } catch (e) { return JSON.stringify({ error: e.message }); }' +
            ' })()',
          chromeContext,
        )
        if (typeof raw !== 'string') throw new Error('list groups returned nothing')
        const groups = JSON.parse(raw) as Array<Record<string, unknown>> | { error?: string }
        if (!Array.isArray(groups)) throw new Error(String((groups as { error?: string }).error ?? 'unexpected reply'))
        if (groups.length === 0) return 'no tab groups in this window'
        return groups
          .map(
            (group) =>
              String(group.id) +
              ' | ' +
              String(group.label ?? '(no label)') +
              ' | ' +
              String(group.color) +
              (group.collapsed ? ' | collapsed' : '') +
              ' | tabs: ' +
              String(Array.isArray(group.tabs) ? group.tabs.length : 0),
          )
          .join(String.fromCharCode(10))
      }),
  )

  defineTool(
    server,
    'browser_remove_tab_group',
    {
      title: 'Remove a tab group',
      description:
        'Remove a tab group by id (gBrowser.removeTabGroup). ungroup:true keeps the tabs and just dissolves the group; ' +
        'without it the tabs are closed. Get ids from browser_list_tab_groups.',
      inputSchema: {
        groupId: z.string().describe('Group id from browser_list_tab_groups'),
        ungroup: z
          .boolean()
          .optional()
          .describe('Keep the tabs and only dissolve the group (default false = close tabs)'),
      },
      annotations: WRITES,
    },
    async ({ groupId, ungroup }: { groupId: string; ungroup?: boolean }) => {
      const id = str(groupId, 'groupId')
      return await withChrome(async (client, chromeContext) => {
        const raw = await client.evaluate(
          '(() => {' +
            ' try {' +
            '  const g = gBrowser.getTabGroupById(' +
            JSON.stringify(id) +
            ');' +
            '  if (!g) return JSON.stringify({ error: "no such group: " + ' +
            JSON.stringify(id) +
            ' });' +
            '  const count = Array.from(g.tabs || []).length;' +
            '  gBrowser.removeTabGroup(g, { ungroup: ' +
            (ungroup === true ? 'true' : 'false') +
            ' });' +
            '  return JSON.stringify({ tabs: count, ungrouped: ' +
            (ungroup === true ? 'true' : 'false') +
            ' });' +
            ' } catch (e) { return JSON.stringify({ error: e.message }); }' +
            ' })()',
          chromeContext,
        )
        if (typeof raw !== 'string') throw new Error('remove group returned nothing')
        const info = JSON.parse(raw) as { error?: string; tabs?: number; ungrouped?: boolean }
        if (info.error !== undefined) throw new Error(info.error)
        return (info.ungrouped ? 'dissolved group, kept ' : 'closed group and ') + String(info.tabs) + ' tab(s)'
      })
    },
  )

  defineTool(
    server,
    'browser_get_tab_processes',
    {
      title: 'Which process hosts which tab',
      description:
        'Report the OS process id behind each tab (browsingContext.currentWindowGlobal.osPid). MEASURED: there is no ' +
        'gBrowser.getTabPids — that name does not exist in Tabbrowser.sys.mjs. Useful to see how many content ' +
        'processes Firefox spun up, or whether two tabs share one.',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () =>
      await withChrome(async (client, chromeContext) => {
        const raw = await client.evaluate(
          '(() => {' +
            ' try {' +
            '  const out = Array.from(gBrowser.tabs).map(t => {' +
            '    try {' +
            '      const wg = t.linkedBrowser.browsingContext.currentWindowGlobal;' +
            '      return { url: t.linkedBrowser.currentURI.spec, pid: wg ? wg.osPid : null };' +
            '    } catch { return { url: t.linkedBrowser.currentURI.spec, pid: null }; }' +
            '  });' +
            '  return JSON.stringify(out);' +
            ' } catch (e) { return JSON.stringify({ error: e.message }); }' +
            ' })()',
          chromeContext,
        )
        if (typeof raw !== 'string') throw new Error('tab pids returned nothing')
        const rows = JSON.parse(raw) as Array<{ url: string; pid: number | null }> | { error?: string }
        if (!Array.isArray(rows)) throw new Error(String((rows as { error?: string }).error ?? 'unexpected reply'))
        return rows.map((row) => String(row.pid) + '  ' + String(row.url).slice(0, 70)).join(String.fromCharCode(10))
      }),
  )

  defineTool(
    server,
    'browser_move_tab_to_group',
    {
      title: 'Move a tab into an existing tab group',
      description:
        'Move a tab into a group that already exists (gBrowser.moveTabToExistingGroup). Unlike browser_group_tabs, ' +
        'which creates a new group, this joins one. Get the group id from browser_list_tab_groups.',
      inputSchema: {
        context: z.string().optional().describe('Tab to move (default: the active tab)'),
        groupId: z.string().describe('Target group id from browser_list_tab_groups'),
      },
      annotations: WRITES,
    },
    async ({ context, groupId }: { context?: string; groupId: string }) => {
      const target = context === undefined ? null : str(context, 'context')
      const group = str(groupId, 'groupId')
      return await withChrome(async (client, chromeContext) => {
        const index = target === null ? -1 : await tabIndexForContext(client, target)
        const raw = await client.evaluate(
          '(() => {' +
            ' try {' +
            '  const g = gBrowser.getTabGroupById(' +
            JSON.stringify(group) +
            ');' +
            '  if (!g) return JSON.stringify({ error: "no such group: " + ' +
            JSON.stringify(group) +
            ' });' +
            '  const tab = ' +
            (index < 0 ? 'gBrowser.selectedTab' : 'gBrowser.tabs[' + String(index) + ']') +
            ';' +
            '  if (!tab) return JSON.stringify({ error: "tab not found" });' +
            '  gBrowser.moveTabToExistingGroup(tab, g);' +
            '  return JSON.stringify({ ok: true, label: g.label || null, groupId: g.id, tabs: Array.from(g.tabs || []).length });' +
            ' } catch (e) { return JSON.stringify({ error: e.message }); }' +
            ' })()',
          chromeContext,
        )
        if (typeof raw !== 'string') throw new Error('move to group returned nothing')
        const info = JSON.parse(raw) as { error?: string; label?: string | null; tabs?: number }
        if (info.error !== undefined) throw new Error(info.error)
        return 'moved into group "' + String(info.label ?? '(no label)') + '" (now ' + String(info.tabs) + ' tab(s))'
      })
    },
  )

  defineTool(
    server,
    'browser_move_tab_to_split_view',
    {
      title: 'Move a tab into the current split view',
      description:
        'Move a tab into the split view that is already open in this window (gBrowser.moveTabToSplitView). Requires ' +
        'an existing split view — create one first with browser_split_view. Complements browser_split_view, which ' +
        'builds a new split view from two tabs.',
      inputSchema: {
        context: z.string().optional().describe('Tab to move (default: the active tab)'),
      },
      annotations: WRITES,
    },
    async ({ context }: { context?: string }) => {
      const target = context === undefined ? null : str(context, 'context')
      return await withChrome(async (client, chromeContext) => {
        const index = target === null ? -1 : await tabIndexForContext(client, target)
        const raw = await client.evaluate(
          '(() => {' +
            ' try {' +
            '  let sv = gBrowser.activeSplitView;' +
            '  if (!sv && gBrowser.splitViews) {' +
            '    const arr = (gBrowser.splitViews.size !== undefined) ? Array.from(gBrowser.splitViews) : Array.from(gBrowser.splitViews || []);' +
            '    if (arr.length > 0) sv = arr[0];' +
            '  }' +
            '  if (!sv) return JSON.stringify({ error: "no split view is open; use browser_split_view first" });' +
            '  const tab = ' +
            (index < 0 ? 'gBrowser.selectedTab' : 'gBrowser.tabs[' + String(index) + ']') +
            ';' +
            '  if (!tab) return JSON.stringify({ error: "tab not found" });' +
            '  gBrowser.moveTabToSplitView(tab, sv);' +
            '  const after = gBrowser.activeSplitView;' +
            '  return JSON.stringify({ ok: true, panes: after && after.tabs ? Array.from(after.tabs).length : null });' +
            ' } catch (e) { return JSON.stringify({ error: e.message }); }' +
            ' })()',
          chromeContext,
        )
        if (typeof raw !== 'string') throw new Error('move to split view returned nothing')
        const info = JSON.parse(raw) as { error?: string; panes?: number }
        if (info.error !== undefined) throw new Error(info.error)
        return 'moved into the split view (' + String(info.panes) + ' panes now)'
      })
    },
  )

  defineTool(
    server,
    'browser_multi_select_tabs',
    {
      title: 'Select several tabs at once',
      description:
        'Multi-select tabs so batch operations apply to all of them (gBrowser.addToMultiSelectedTabs / ' +
        'selectAllTabs / clearMultiSelectedTabs). Reports how many are selected. This is Ctrl+click on the tab strip, ' +
        'done programmatically.',
      inputSchema: {
        contexts: z.array(z.string()).optional().describe('Tab context ids to select'),
        all: z.boolean().optional().describe('Select every tab instead of a list'),
        clear: z.boolean().optional().describe('Clear the selection instead of selecting'),
      },
      annotations: WRITES,
    },
    async ({ contexts, all, clear }: { contexts?: string[]; all?: boolean; clear?: boolean }) => {
      const ids = Array.isArray(contexts) ? contexts.map((value) => str(value, 'context')) : []
      if (clear !== true && all !== true && ids.length === 0) throw new Error('give contexts, all:true, or clear:true')
      return await withChrome(async (client, chromeContext) => {
        const indices: number[] = []
        for (const id of ids) indices.push(await tabIndexForContext(client, id))
        const raw = await client.evaluate(
          '(() => {' +
            ' try {' +
            '  const mode = ' +
            (clear === true ? '"clear"' : all === true ? '"all"' : '"list"') +
            ';' +
            '  if (mode === "clear") gBrowser.clearMultiSelectedTabs();' +
            '  else if (mode === "all") gBrowser.selectAllTabs();' +
            '  else {' +
            '    gBrowser.clearMultiSelectedTabs();' +
            '    const idx = ' +
            JSON.stringify(indices) +
            ';' +
            '    for (const i of idx) { const t = gBrowser.tabs[i]; if (t) gBrowser.addToMultiSelectedTabs(t); }' +
            '  }' +
            '  const n = Array.from(gBrowser.tabs).filter(t => t.multiselected).length;' +
            '  return JSON.stringify({ selected: n, total: gBrowser.tabs.length });' +
            ' } catch (e) { return JSON.stringify({ error: e.message }); }' +
            ' })()',
          chromeContext,
        )
        if (typeof raw !== 'string') throw new Error('multi-select returned nothing')
        const info = JSON.parse(raw) as { error?: string; selected?: number; total?: number }
        if (info.error !== undefined) throw new Error(info.error)
        return 'selected ' + String(info.selected) + ' of ' + String(info.total) + ' tab(s)'
      })
    },
  )

  defineTool(
    server,
    'browser_set_tab_visible',
    {
      title: 'Hide or show a tab in the tab strip',
      description:
        'Hide a tab from the tab strip (gBrowser.hideTab) or bring it back (gBrowser.showTab). A hidden tab stays ' +
        'loaded and reachable by context id, it just is not shown — handy to park a tab without closing it. The last ' +
        'visible tab in a window cannot be hidden.',
      inputSchema: {
        context: z.string().optional().describe('Tab (default: the active tab)'),
        visible: z.boolean().describe('true to show it again, false to hide it'),
      },
      annotations: WRITES,
    },
    async ({ context, visible }: { context?: string; visible: boolean }) => {
      const target = context === undefined ? null : str(context, 'context')
      return await withChrome(async (client, chromeContext) => {
        const index = target === null ? -1 : await tabIndexForContext(client, target)
        const raw = await client.evaluate(
          '(() => {' +
            ' try {' +
            '  const tab = ' +
            (index < 0 ? 'gBrowser.selectedTab' : 'gBrowser.tabs[' + String(index) + ']') +
            ';' +
            '  if (!tab) return JSON.stringify({ error: "tab not found" });' +
            '  if (' +
            (visible ? 'true' : 'false') +
            ') gBrowser.showTab(tab); else gBrowser.hideTab(tab);' +
            '  return JSON.stringify({ hidden: !!tab.hidden, url: tab.linkedBrowser.currentURI.spec });' +
            ' } catch (e) { return JSON.stringify({ error: e.message }); }' +
            ' })()',
          chromeContext,
        )
        if (typeof raw !== 'string') throw new Error('hide/show returned nothing')
        const info = JSON.parse(raw) as { error?: string; hidden?: boolean; url?: string }
        if (info.error !== undefined) throw new Error(info.error)
        return (info.hidden ? 'hidden: ' : 'shown: ') + String(info.url)
      })
    },
  )
}
