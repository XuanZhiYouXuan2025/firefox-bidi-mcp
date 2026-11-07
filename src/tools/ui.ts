import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/server'
import { READ_ONLY, WRITES, WRITES_PERSISTENTLY } from '../support/annotations.js'
import { defineTool } from '../support/define-tool.js'
import { withChrome } from '../support/connection.js'

import { str } from '../support/strings.js'

/**
 * Toolbars, sidebars, menus and panels.
 */
export function registerUi(server: McpServer): void {
  defineTool(
    server,
    'browser_get_toolbar_layout',
    {
      title: 'Current toolbar layout',
      description:
        'List which widgets sit in each toolbar area (nav-bar, TabsToolbar, PersonalToolbar, ...), read from ' +
        'browser.uiCustomization.state. Widget ids are exactly what browser_set_toolbar_widget expects. Read this ' +
        'before changing the layout, and use it to put things back afterwards.',
      inputSchema: {
        area: z.string().optional().describe('Only this area, e.g. "nav-bar" (default: every area)'),
      },
      annotations: READ_ONLY,
    },
    async ({ area }: { area?: string }) =>
      await withChrome(async (client, context) => {
        const raw = await client.evaluate(
          '(() => { const st = Services.prefs.getStringPref("browser.uiCustomization.state", "{}");' +
            ' const d = JSON.parse(st); return JSON.stringify(d.placements || {}); })()',
          context,
        )
        if (typeof raw !== 'string') throw new Error('could not read the toolbar layout')
        const placements = JSON.parse(raw) as Record<string, string[]>
        const wanted = area === undefined ? Object.keys(placements) : [area]
        const lines: string[] = []
        for (const key of wanted) {
          const widgets = placements[key]
          if (widgets === undefined) {
            lines.push(key + ': (no such area)')
            continue
          }
          lines.push(key + ': ' + (Array.isArray(widgets) ? JSON.stringify(widgets) : '(none)'))
        }
        return lines.join(String.fromCharCode(10))
      }),
  )

  defineTool(
    server,
    'browser_set_toolbar_widget',
    {
      title: 'Add or remove a toolbar widget',
      description:
        'Move a widget into a toolbar area, or remove it from wherever it is (CustomizableUI.addWidgetToArea / ' +
        'removeWidgetFromArea). MEASURED: the CustomizableUI route applies immediately to the running browser, unlike ' +
        'editing browser.uiCustomization.state directly, which needs a restart. Get ids from browser_get_toolbar_layout ' +
        'or browser_toolbar_widgets, and note the layout so you can undo it.',
      inputSchema: {
        widget: z.string().describe('Widget id, e.g. "downloads-button"'),
        area: z
          .string()
          .optional()
          .describe('Target area, e.g. "nav-bar" or "TabsToolbar" (required unless remove is true)'),
        remove: z.boolean().optional().describe('Remove the widget from its current area instead of adding it'),
      },
      annotations: WRITES_PERSISTENTLY,
    },
    async ({ widget, area, remove }: { widget: string; area?: string; remove?: boolean }) => {
      const widgetId = str(widget, 'widget')
      return await withChrome(async (client, context) => {
        const raw = await client.evaluate(
          '(() => {' +
            ' const id = ' +
            JSON.stringify(widgetId) +
            ';' +
            (remove === true
              ? ' CustomizableUI.removeWidgetFromArea(id); return "removed " + id;'
              : ' const area = ' +
                JSON.stringify(area ?? '') +
                ';' +
                ' CustomizableUI.addWidgetToArea(id, area);' +
                ' return "added " + id + " to " + area;') +
            ' })()',
          context,
        )
        return typeof raw === 'string' ? raw : 'done'
      })
    },
  )

  defineTool(
    server,
    'browser_set_toolbar_visibility',
    {
      title: 'Show or hide a toolbar',
      description:
        'Show or hide a whole toolbar such as the bookmarks toolbar or the menu bar (CustomizableUI.setToolbarVisibility, ' +
        'which applies immediately). This is coarser than browser_set_toolbar_widget, which moves individual widgets.',
      inputSchema: {
        toolbar: z.string().describe('Toolbar id, e.g. "PersonalToolbar" (bookmarks) or "toolbar-menubar"'),
        visible: z.boolean().describe('true to show, false to hide'),
      },
      annotations: WRITES_PERSISTENTLY,
    },
    async ({ toolbar, visible }: { toolbar: string; visible: boolean }) => {
      const id = str(toolbar, 'toolbar')
      return await withChrome(async (client, context) => {
        const raw = await client.evaluate(
          '(() => {' +
            ' try {' +
            '  CustomizableUI.setToolbarVisibility(' +
            JSON.stringify(id) +
            ', ' +
            (visible ? 'true' : 'false') +
            ');' +
            '  return \"ok\";' +
            ' } catch (e) { return \"ERR \" + e.message; }' +
            ' })()',
          context,
        )
        if (typeof raw !== 'string') throw new Error('setToolbarVisibility returned nothing')
        if (raw.startsWith('ERR ')) throw new Error(raw)
        return 'toolbar ' + id + ' is now ' + (visible ? 'shown' : 'hidden')
      })
    },
  )

  defineTool(
    server,
    'browser_list_sidebars',
    {
      title: 'List sidebars and their state',
      description:
        'List every sidebar this Firefox can show (history, bookmarks, passwords, tabs, AI chat, resource monitor, ' +
        'extension panels …) with its id and title, plus which one is currently open. Use the id with ' +
        'browser_set_sidebar.',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () =>
      await withChrome(async (client, chromeContext) => {
        const raw = await client.evaluate(
          '(() => {' +
            ' try {' +
            '  const sc = window.SidebarController;' +
            '  if (!sc) return JSON.stringify({ error: "no SidebarController in this window" });' +
            '  const list = Array.from(sc.sidebars.entries()).map(e => ({' +
            '    id: e[0], title: e[1] && e[1].title ? e[1].title : null' +
            '  }));' +
            '  return JSON.stringify({ current: sc.currentID || null, open: !!sc.isOpen, list });' +
            ' } catch (e) { return JSON.stringify({ error: e.message }); }' +
            ' })()',
          chromeContext,
        )
        if (typeof raw !== 'string') throw new Error('sidebar list returned nothing')
        const info = JSON.parse(raw) as {
          error?: string
          current?: string | null
          open?: boolean
          list?: Array<{ id: string; title: string | null }>
        }
        if (info.error !== undefined) throw new Error(info.error)
        const rows = (info.list ?? []).map((item) => item.id + '  ' + String(item.title ?? '(no title)'))
        return (
          'sidebar open: ' +
          String(info.open) +
          (info.current ? ' (' + String(info.current) + ')' : '') +
          String.fromCharCode(10) +
          rows.join(String.fromCharCode(10))
        )
      }),
  )

  defineTool(
    server,
    'browser_set_sidebar',
    {
      title: 'Open or close a sidebar',
      description:
        'Open a sidebar by id, close the current one, or toggle it. Get ids from browser_list_sidebars. ' +
        'MEASURED entry point: window.SidebarController.show(id) / hide() / toggle(id). Action: open (needs id), ' +
        'close, toggle (needs id).',
      inputSchema: {
        action: z.enum(['open', 'close', 'toggle']).describe('What to do'),
        id: z.string().optional().describe('Sidebar id (required for open/toggle)'),
      },
      annotations: WRITES,
    },
    async ({ action, id }: { action: 'open' | 'close' | 'toggle'; id?: string }) => {
      if ((action === 'open' || action === 'toggle') && (id === undefined || id === '')) {
        throw new Error('action=' + action + ' needs id')
      }
      const sidebarId = id === undefined ? null : str(id, 'id')
      return await withChrome(async (client, chromeContext) => {
        const raw = await client.evaluate(
          '(() => {' +
            ' try {' +
            '  const sc = window.SidebarController;' +
            '  if (!sc) return JSON.stringify({ error: "no SidebarController in this window" });' +
            '  const act = ' +
            JSON.stringify(action) +
            ';' +
            '  const target = ' +
            JSON.stringify(sidebarId) +
            ';' +
            '  if (act === "close") sc.hide();' +
            '  else if (act === "open") sc.show(target);' +
            '  else sc.toggle(target);' +
            '  return JSON.stringify({ open: !!sc.isOpen, current: sc.currentID || null });' +
            ' } catch (e) { return JSON.stringify({ error: e.message }); }' +
            ' })()',
          chromeContext,
        )
        if (typeof raw !== 'string') throw new Error('sidebar command returned nothing')
        const info = JSON.parse(raw) as { error?: string; open?: boolean; current?: string | null }
        if (info.error !== undefined) throw new Error(info.error)
        return (
          'sidebar is now ' + (info.open ? 'open' : 'closed') + (info.current ? ' (' + String(info.current) + ')' : '')
        )
      })
    },
  )

  defineTool(
    server,
    'browser_set_menubar_visibility',
    {
      title: 'Show or hide the menu bar',
      description:
        'Show or hide the classic menu bar (File/Edit/View…). MEASURED: the element is #toolbar-menubar and it ' +
        'normally carries autohide="true" (Firefox hides it by default and shows it on Alt). Setting visible=true ' +
        'clears autohide; visible=false restores the auto-hiding behaviour.',
      inputSchema: {
        visible: z.boolean().describe('true to pin the menu bar open, false to let it auto-hide again'),
      },
      annotations: WRITES,
    },
    async ({ visible }: { visible: boolean }) =>
      await withChrome(async (client, chromeContext) => {
        const raw = await client.evaluate(
          '(() => {' +
            ' try {' +
            '  const bar = document.getElementById("toolbar-menubar");' +
            '  if (!bar) return JSON.stringify({ error: "no #toolbar-menubar in this window" });' +
            '  const want = ' +
            (visible ? 'true' : 'false') +
            ';' +
            '  if (want) { bar.removeAttribute("autohide"); bar.setAttribute("inactive", "false"); }' +
            '  else { bar.setAttribute("autohide", "true"); bar.setAttribute("inactive", "true"); }' +
            '  return JSON.stringify({' +
            '    autohide: bar.getAttribute("autohide"),' +
            '    hidden: !!bar.hidden' +
            '  });' +
            ' } catch (e) { return JSON.stringify({ error: e.message }); }' +
            ' })()',
          chromeContext,
        )
        if (typeof raw !== 'string') throw new Error('menubar command returned nothing')
        const info = JSON.parse(raw) as { error?: string; autohide?: string | null; hidden?: boolean }
        if (info.error !== undefined) throw new Error(info.error)
        return 'menu bar autohide=' + String(info.autohide) + (info.autohide === null ? ' (pinned open)' : '')
      }),
  )

  defineTool(
    server,
    'browser_set_downloads_panel',
    {
      title: 'Open or close the downloads panel',
      description:
        'Open or close the downloads panel (the toolbar arrow that lists recent downloads). MEASURED: the entry ' +
        'points are DownloadsPanel.showPanel() / hidePanel() — NOT .show(), which does not exist. Also reports ' +
        'whether the panel is currently showing.',
      inputSchema: {
        open: z.boolean().describe('true to open, false to close'),
      },
      annotations: WRITES,
    },
    async ({ open }: { open: boolean }) =>
      await withChrome(async (client, chromeContext) => {
        const raw = await client.evaluate(
          '(() => {' +
            ' try {' +
            '  if (typeof DownloadsPanel === "undefined") return JSON.stringify({ error: "no DownloadsPanel" });' +
            '  if (' +
            (open ? 'true' : 'false') +
            ') DownloadsPanel.showPanel(); else DownloadsPanel.hidePanel();' +
            '  const showing = typeof DownloadsPanel.isPanelShowing === "function" ? DownloadsPanel.isPanelShowing() : DownloadsPanel.isPanelShowing;' +
            '  return JSON.stringify({ showing: !!showing });' +
            ' } catch (e) { return JSON.stringify({ error: e.message }); }' +
            ' })()',
          chromeContext,
        )
        if (typeof raw !== 'string') throw new Error('downloads panel returned nothing')
        const info = JSON.parse(raw) as { error?: string; showing?: boolean }
        if (info.error !== undefined) throw new Error(info.error)
        return 'downloads panel is ' + (info.showing ? 'open' : 'closed')
      }),
  )

  defineTool(
    server,
    'browser_set_main_menu',
    {
      title: 'Open or close the main application menu',
      description:
        'Open or close the application (hamburger) menu, the same one the ☰ button opens. Uses PanelUI.show() / ' +
        'PanelUI.hide(). Opening it is a visible change on screen — close it again if you only needed to inspect it.',
      inputSchema: {
        open: z.boolean().describe('true to open, false to close'),
      },
      annotations: WRITES,
    },
    async ({ open }: { open: boolean }) =>
      await withChrome(async (client, chromeContext) => {
        const raw = await client.evaluate(
          '(() => {' +
            ' try {' +
            '  if (typeof PanelUI === "undefined") return JSON.stringify({ error: "no PanelUI" });' +
            '  if (' +
            (open ? 'true' : 'false') +
            ') PanelUI.show(); else PanelUI.hide();' +
            '  return "ok";' +
            ' } catch (e) { return JSON.stringify({ error: e.message }); }' +
            ' })()',
          chromeContext,
        )
        if (typeof raw !== 'string') throw new Error('main menu returned nothing')
        if (raw.startsWith('{')) {
          const info = JSON.parse(raw) as { error?: string }
          if (info.error !== undefined) throw new Error(info.error)
        }
        return 'application menu ' + (open ? 'opened' : 'closed')
      }),
  )

  defineTool(
    server,
    'browser_toolbar_widgets',
    {
      title: 'List toolbar widgets',
      description:
        'List the widget ids currently in a toolbar area (privileged context). Use area "nav-bar" for the main toolbar.',
      inputSchema: { area: z.string().optional().describe('Toolbar area id, default "nav-bar"') },
      annotations: READ_ONLY,
    },
    async ({ area }: { area?: string }) => {
      const target = area ?? 'nav-bar'
      return JSON.stringify(
        await withChrome(
          async (client, context) =>
            await client.evaluate(
              `JSON.stringify(CustomizableUI.getWidgetIdsInArea(${JSON.stringify(target)}))`,
              context,
            ),
        ),
        null,
        2,
      )
    },
  )
}
