import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'

import { READ_ONLY, WRITES_PERSISTENTLY } from '../support/annotations.js'
import { defineTool } from '../support/define-tool.js'
import { withChrome } from '../support/connection.js'
import { text } from '../support/output.js'
import { str } from '../support/strings.js'

/**
 * Bookmarks: list, add, remove, folders, import/export and backups.
 */
export function registerBookmarks(server: McpServer): void {
  defineTool(
    server,
    'browser_add_bookmark',
    {
      title: 'Add a bookmark',
      description:
        'Insert a bookmark (PlacesUtils.bookmarks.insert) and return its guid, which is what browser_remove_bookmark ' +
        'needs. Defaults to the bookmarks menu; pass the toolbar or unfiled guid to target those instead.',
      inputSchema: {
        url: z.string().describe('URL to bookmark'),
        title: z.string().describe('Bookmark title'),
        parentGuid: z.string().optional().describe('Parent folder guid (default: the bookmarks menu, "menu________")'),
      },
      annotations: WRITES_PERSISTENTLY,
    },
    async ({ url, title, parentGuid }: { url: string; title: string; parentGuid?: string }) => {
      const target = str(url, 'url')
      const label = str(title, 'title')
      return await withChrome(async (client, context) => {
        const raw = await client.evaluate(
          '(async () => {' +
            ' const parentGuid = ' +
            (parentGuid === undefined ? 'PlacesUtils.bookmarks.menuGuid' : JSON.stringify(parentGuid)) +
            ';' +
            ' const info = await PlacesUtils.bookmarks.insert({' +
            '   parentGuid,' +
            '   url: ' +
            JSON.stringify(target) +
            ',' +
            '   title: ' +
            JSON.stringify(label) +
            ' });' +
            ' return JSON.stringify({ guid: info.guid, title: info.title, parentGuid: info.parentGuid });' +
            ' })()',
          context,
        )
        if (typeof raw !== 'string') throw new Error('insert returned nothing')
        const info = JSON.parse(raw) as Record<string, unknown>
        return Object.entries(info)
          .map(([key, value]) => key + ': ' + String(value))
          .join(String.fromCharCode(10))
      })
    },
  )

  defineTool(
    server,
    'browser_remove_bookmark',
    {
      title: 'Remove a bookmark',
      description:
        'Remove a bookmark or folder by guid (PlacesUtils.bookmarks.remove). Get guids from browser_list_bookmarks, ' +
        'or from browser_add_bookmark which returns the guid of what it just created. Passing a folder guid removes ' +
        'the whole subtree, so look the entry up first.',
      inputSchema: { guid: z.string().describe('Bookmark guid from browser_list_bookmarks') },
      annotations: WRITES_PERSISTENTLY,
    },
    async ({ guid }: { guid: string }) => {
      const target = str(guid, 'guid')
      return await withChrome(async (client, context) => {
        const raw = await client.evaluate(
          '(async () => {' +
            ' const guid = ' +
            JSON.stringify(target) +
            ';' +
            ' const info = await PlacesUtils.bookmarks.fetch(guid);' +
            ' if (!info) return JSON.stringify({ error: "no bookmark with that guid" });' +
            ' const label = info.title || (info.url ? info.url.href : "(folder)");' +
            ' await PlacesUtils.bookmarks.remove(guid);' +
            ' return JSON.stringify({ removed: label, guid });' +
            ' })()',
          context,
        )
        if (typeof raw !== 'string') throw new Error('remove returned nothing')
        const info = JSON.parse(raw) as { error?: string; removed?: string; guid?: string }
        if (info.error !== undefined) throw new Error(info.error + ': ' + target)
        return 'removed ' + String(info.removed) + ' (' + String(info.guid) + ')'
      })
    },
  )

  defineTool(
    server,
    'browser_bookmark_folder',
    {
      title: 'Create, rename or remove a bookmark folder',
      description:
        'Manage bookmark FOLDERS (the existing bookmark tools only handle individual bookmarks). MEASURED: ' +
        'PlacesUtils.bookmarks exposes insert/update/remove/search/fetch, and the root folders are addressed by the ' +
        'well-known guids (toolbar____, menu________, unfiled_____, root________). Removing a folder removes its ' +
        'contents, so check the child count first with action:"list".',
      inputSchema: {
        action: z.enum(['list', 'create', 'rename', 'remove']).describe('What to do'),
        title: z.string().optional().describe('Folder title, for create / rename'),
        parent: z.enum(['toolbar', 'menu', 'unfiled']).optional().describe('Where to create it (default: menu)'),
        guid: z.string().optional().describe('Folder guid, for rename / remove'),
      },
      annotations: WRITES_PERSISTENTLY,
    },
    async ({
      action,
      title,
      parent,
      guid,
    }: {
      action: 'list' | 'create' | 'rename' | 'remove'
      title?: string
      parent?: string
      guid?: string
    }) => {
      const what = str(action, 'action')
      const wantedTitle = title === undefined ? null : str(title, 'title')
      const wantedParent = parent === undefined ? 'menu' : str(parent, 'parent')
      const wantedGuid = guid === undefined ? null : str(guid, 'guid')
      const raw = await withChrome(async (client, chromeContext) => {
        return client.evaluate(
          '(async () => {' +
            ' try {' +
            '  const { PlacesUtils } = ChromeUtils.importESModule("resource://gre/modules/PlacesUtils.sys.mjs");' +
            '  const bm = PlacesUtils.bookmarks;' +
            '  const action = ' +
            JSON.stringify(what) +
            ';' +
            '  const parents = {' +
            '    toolbar: PlacesUtils.bookmarks.toolbarGuid,' +
            '    menu: PlacesUtils.bookmarks.menuGuid,' +
            '    unfiled: PlacesUtils.bookmarks.unfiledGuid' +
            '  };' +
            '  if (action === "list") {' +
            '    const rootGuid = parents[' +
            JSON.stringify(wantedParent) +
            '] || PlacesUtils.bookmarks.menuGuid;' +
            '    const folder = (await bm.fetch({ guid: rootGuid })) || { guid: rootGuid, title: "(unknown)" };' +
            '    let kids = [];' +
            '    try {' +
            '      kids = await bm.search({ parentGuid: rootGuid });' +
            '    } catch (e) { out.searchErr = e.message; }' +
            '    return JSON.stringify({' +
            '      ok: true,' +
            '      root: { guid: folder.guid, title: folder.title },' +
            '      folders: kids.filter(c => c.type === PlacesUtils.bookmarks.TYPE_FOLDER).map(c => ({ guid: c.guid, title: c.title, index: c.index })),' +
            '      bookmarks: kids.filter(c => c.type !== PlacesUtils.bookmarks.TYPE_FOLDER).length' +
            '    });' +
            '  }' +
            '  if (action === "create") {' +
            '    const title = ' +
            (wantedTitle === null ? 'null' : JSON.stringify(wantedTitle)) +
            ';' +
            '    if (!title) return JSON.stringify({ error: "title is required" });' +
            '    const parentGuid = parents[' +
            JSON.stringify(wantedParent) +
            '] || PlacesUtils.bookmarks.menuGuid;' +
            '    const created = await bm.insert({ parentGuid, title, type: PlacesUtils.bookmarks.TYPE_FOLDER });' +
            '    return JSON.stringify({ ok: true, guid: created.guid, title: created.title });' +
            '  }' +
            '  if (action === "rename") {' +
            '    const guid = ' +
            (wantedGuid === null ? 'null' : JSON.stringify(wantedGuid)) +
            ';' +
            '    const title = ' +
            (wantedTitle === null ? 'null' : JSON.stringify(wantedTitle)) +
            ';' +
            '    if (!guid || !title) return JSON.stringify({ error: "guid and title are required" });' +
            '    await bm.update({ guid, title });' +
            '    return JSON.stringify({ ok: true, guid, title });' +
            '  }' +
            '  if (action === "remove") {' +
            '    const guid = ' +
            (wantedGuid === null ? 'null' : JSON.stringify(wantedGuid)) +
            ';' +
            '    if (!guid) return JSON.stringify({ error: "guid is required" });' +
            '    let childCount = 0;' +
            '    try { const kids = await bm.search({ parentGuid: guid }); childCount = kids.length; } catch (e) {}' +
            '    await bm.remove({ guid });' +
            '    return JSON.stringify({ ok: true, removed: guid, childCount });' +
            '  }' +
            '  return JSON.stringify({ error: "unknown action" });' +
            ' } catch (e) { return JSON.stringify({ error: e.message }); }' +
            ' })()',
          chromeContext,
        )
      })
      if (typeof raw !== 'string') throw new Error('bookmark folder returned nothing')
      const info = JSON.parse(raw) as {
        error?: string
        root?: { guid: string; title: string }
        folders?: Array<{ guid: string; title: string; index: number }>
        bookmarks?: number
        guid?: string
        title?: string
        removed?: string
        childCount?: number
      }
      if (info.error !== undefined) throw new Error(info.error)
      if (what === 'list') {
        const folders = info.folders ?? []
        const lines = [
          'under: ' + String(info.root?.title) + ' (' + String(info.root?.guid) + ')',
          'folders: ' + String(folders.length) + ', loose bookmarks: ' + String(info.bookmarks),
        ]
        for (const folder of folders) lines.push('  ' + folder.title + '  ' + folder.guid)
        return lines.join(String.fromCharCode(10))
      }
      if (what === 'create') return 'folder created: ' + String(info.title) + ' (' + String(info.guid) + ')'
      if (what === 'rename') return 'folder renamed: ' + String(info.guid) + ' -> ' + String(info.title)
      return 'folder removed: ' + String(info.removed) + ' (contained ' + String(info.childCount) + ' entries)'
    },
  )

  defineTool(
    server,
    'browser_bookmark_manage',
    {
      title: 'Move, edit, search or tag bookmarks',
      description:
        'The management half of bookmarks that browser_add_bookmark / remove_bookmark / bookmark_folder do not cover. ' +
        'MEASURED: PlacesUtils.bookmarks.update(info) accepts guid plus parentGuid/index for a move, or title/url for an ' +
        'edit; bookmarks.search({query}) finds by title or URL; PlacesUtils.tagging.tagURI/untagURI/getTagsForURI ' +
        'handle tags. NOTE: fetchTree is NOT implemented in this build, so listing stays on search({parentGuid}).',
      inputSchema: {
        action: z.enum(['move', 'update', 'search', 'tag', 'untag']).describe('What to do'),
        guid: z.string().optional().describe('Bookmark guid, for move / update / tag / untag'),
        title: z.string().optional().describe('New title, for update'),
        url: z.string().optional().describe('New URL, for update; or the URL to tag/untag'),
        parentGuid: z
          .string()
          .optional()
          .describe('Destination folder guid for move ("toolbar_____", "menu________", "unfiled_____")'),
        index: z.number().int().min(0).optional().describe('Destination index for move'),
        query: z.string().optional().describe('Search text, for search'),
        tags: z.array(z.string()).optional().describe('Tags to apply or remove'),
      },
      annotations: WRITES_PERSISTENTLY,
    },
    async ({
      action,
      guid,
      title,
      url,
      parentGuid,
      index,
      query,
      tags,
    }: {
      action: 'move' | 'update' | 'search' | 'tag' | 'untag'
      guid?: string
      title?: string
      url?: string
      parentGuid?: string
      index?: number
      query?: string
      tags?: string[]
    }) => {
      const what = str(action, 'action')
      const opt = (v: unknown): string => (v === undefined ? 'null' : JSON.stringify(v))
      const raw = await withChrome(async (client, chromeContext) => {
        return client.evaluate(
          '(async () => {' +
            ' try {' +
            '  const { PlacesUtils } = ChromeUtils.importESModule("resource://gre/modules/PlacesUtils.sys.mjs");' +
            '  const bm = PlacesUtils.bookmarks;' +
            '  const action = ' +
            JSON.stringify(what) +
            ';' +
            '  if (action === "search") {' +
            '    const q = ' +
            opt(query) +
            ';' +
            '    if (!q) return JSON.stringify({ error: "query is required" });' +
            '    const found = await bm.search({ query: q });' +
            '    return JSON.stringify({ ok: true, count: found.length, items: found.slice(0, 20).map(b => ({ guid: b.guid, title: b.title, url: b.url || null, parentGuid: b.parentGuid, index: b.index, type: b.type })) });' +
            '  }' +
            '  if (action === "move") {' +
            '    const g = ' +
            opt(guid) +
            ';' +
            '    if (!g) return JSON.stringify({ error: "guid is required" });' +
            '    const info = { guid: g };' +
            '    const p = ' +
            opt(parentGuid) +
            ';' +
            '    const idx = ' +
            opt(index) +
            ';' +
            '    if (p) info.parentGuid = p;' +
            '    if (idx !== null) info.index = idx;' +
            '    await bm.update(info);' +
            '    return JSON.stringify({ ok: true, moved: g, parentGuid: p, index: idx });' +
            '  }' +
            '  if (action === "update") {' +
            '    const g = ' +
            opt(guid) +
            ';' +
            '    if (!g) return JSON.stringify({ error: "guid is required" });' +
            '    const info = { guid: g };' +
            '    const t = ' +
            opt(title) +
            ';' +
            '    const u = ' +
            opt(url) +
            ';' +
            '    if (t) info.title = t;' +
            '    if (u) info.url = u;' +
            '    if (!t && !u) return JSON.stringify({ error: "title or url is required" });' +
            '    await bm.update(info);' +
            '    return JSON.stringify({ ok: true, updated: g });' +
            '  }' +
            '  const u = ' +
            opt(url) +
            ';' +
            '  const tgs = ' +
            opt(tags) +
            ';' +
            '  if (!u) return JSON.stringify({ error: "url is required" });' +
            '  if (!tgs || !tgs.length) return JSON.stringify({ error: "tags are required" });' +
            '  const uri = Services.io.newURI(u);' +
            '  if (action === "tag") {' +
            '    PlacesUtils.tagging.tagURI(uri, tgs);' +
            '    return JSON.stringify({ ok: true, tagged: u, tags: tgs });' +
            '  }' +
            '  PlacesUtils.tagging.untagURI(uri, tgs);' +
            '  return JSON.stringify({ ok: true, untagged: u, tags: tgs });' +
            ' } catch (e) { return JSON.stringify({ error: e.message || String(e) }); }' +
            ' })()',
          chromeContext,
        )
      })
      if (typeof raw !== 'string') throw new Error('bookmark manage returned nothing')
      const info = JSON.parse(raw) as {
        error?: string
        count?: number
        items?: Array<{
          guid: string
          title: string
          url: string | null
          parentGuid: string
          index: number
          type: number
        }>
        moved?: string
        updated?: string
        tagged?: string
        untagged?: string
      }
      if (info.error !== undefined) throw new Error(info.error)
      if (what === 'search') {
        const items = info.items ?? []
        if (items.length === 0) return 'no bookmark matched'
        const lines = ['matches: ' + String(info.count)]
        for (const b of items) {
          lines.push('  ' + (b.title || '(untitled)') + '  ' + (b.url ?? '(folder)') + '  ' + b.guid)
        }
        return lines.join(String.fromCharCode(10))
      }
      if (what === 'move') return 'moved: ' + String(info.moved)
      if (what === 'update') return 'updated: ' + String(info.updated)
      if (what === 'tag') return 'tagged: ' + String(info.tagged) + ' -> ' + (tags ?? []).join(', ')
      return 'untagged: ' + String(info.untagged) + ' -> ' + (tags ?? []).join(', ')
    },
  )

  defineTool(
    server,
    'browser_bookmark_backup',
    {
      title: 'List or create bookmark backups',
      description:
        'List the JSON bookmark backups in the profile and optionally create a new one. MEASURED: the module is ' +
        'resource://gre/modules/PlacesBackups.sys.mjs and exports PlacesBackups with getBackupFiles / ' +
        'getMostRecentBackup / saveBookmarksToJSONFile / create / getBookmarkCountForFile. Note PlacesUtils.' +
        'importFromHTML / exportToHTML do NOT exist in this build, so HTML import/export is unavailable — JSON backup ' +
        'is the supported path.',
      inputSchema: {
        action: z.enum(['list', 'create']).describe('list = show existing backups; create = write a new one'),
      },
      annotations: WRITES_PERSISTENTLY,
    },
    async ({ action }: { action: 'list' | 'create' }) => {
      const what = str(action, 'action')
      const raw = await withChrome(async (client, chromeContext) => {
        return client.evaluate(
          '(async () => {' +
            ' try {' +
            '  const m = ChromeUtils.importESModule("resource://gre/modules/PlacesBackups.sys.mjs");' +
            '  const B = m.PlacesBackups;' +
            '  const action = ' +
            JSON.stringify(what) +
            ';' +
            '  const out = {};' +
            '  try { const folder = await B.getBackupFolder(); out.folder = (folder && (folder.path || folder.leafName)) ? (folder.path || folder.leafName) : String(folder); } catch (e) { out.folderErr = (e.message || "").slice(0, 60); }' +
            '  if (action === "create") {' +
            '    const file = await B.saveBookmarksToJSONFile(B.getBackupFolder ? await B.getBackupFolder() : undefined);' +
            '    out.created = file ? file.leafName : null;' +
            '  }' +
            '  const files = await B.getBackupFiles();' +
            '  out.count = files.length;' +
            '  out.files = files.slice(0, 10).map(f => ({ name: (f.leafName || f.name || String(f)), size: (f.fileSize || f.size || 0) }));' +
            '  try { const recent = await B.getMostRecentBackup(); out.mostRecent = recent ? (recent.leafName || String(recent)) : null; } catch (e) {}' +
            '  return JSON.stringify(out);' +
            ' } catch (e) { return JSON.stringify({ error: e.message || String(e) }); }' +
            ' })()',
          chromeContext,
        )
      })
      if (typeof raw !== 'string') throw new Error('bookmark backup returned nothing')
      const info = JSON.parse(raw) as {
        error?: string
        folder?: string
        created?: string | null
        count?: number
        files?: Array<{ name: string; size: number }>
        mostRecent?: string | null
      }
      if (info.error !== undefined) throw new Error(info.error)
      const lines: string[] = []
      if (info.created) lines.push('created backup: ' + String(info.created))
      lines.push('backup folder: ' + String(info.folder))
      lines.push('backups: ' + String(info.count) + ' (latest: ' + String(info.mostRecent) + ')')
      for (const f of info.files ?? []) lines.push('  ' + f.name + '  ' + String(f.size) + ' bytes')
      return lines.join(String.fromCharCode(10))
    },
  )

  defineTool(
    server,
    'browser_bookmarks_export',
    {
      title: 'Export bookmarks as Netscape HTML',
      description:
        'Write the bookmark tree to a Netscape Bookmark HTML file. That is the format Chrome, Edge and Safari also ' +
        'export, so it is how bookmarks move between browsers. MEASURED: Firefox has no usable exportToHTML in this ' +
        'build, so this walks PlacesUtils.bookmarks.search({parentGuid}) recursively and builds the HTML itself. ' +
        'TWO TRAPS: item.url is a URI object (read .spec), and search({parentGuid}) also returns the parent folder ' +
        'itself which must be skipped or the walk never ends.',
      inputSchema: {
        path: z.string().describe('Absolute .html file path to write'),
        maxNodes: z.number().int().min(1).max(20000).optional().describe('Node budget (default 2000)'),
      },
      annotations: WRITES_PERSISTENTLY,
    },
    async ({ path, maxNodes }: { path: string; maxNodes?: number }) => {
      const filePath = str(path, 'path')
      const budget = maxNodes ?? 2000
      const raw = await withChrome(async (client, chromeContext) => {
        const code = [
          '(async () => {',
          ' try {',
          '  const { PlacesUtils } = ChromeUtils.importESModule("resource://gre/modules/PlacesUtils.sys.mjs");',
          '  const bm = PlacesUtils.bookmarks;',
          '  const esc = (v) => String(v || "").split("&").join("&amp;").split("<").join("&lt;").split(">").join("&gt;");',
          '  const uriOf = (it) => { const u = it.url; if (!u) return null; if (typeof u === "string") return u; if (u.spec) return u.spec; return String(u); };',
          '  const file = new FileUtils.File(' + JSON.stringify(filePath) + ');',
          '  let left = ' + String(budget) + ';',
          '  let links = 0, folders = 0;',
          '  const out = ["<!DOCTYPE NETSCAPE-Bookmark-file-1>", "<TITLE>Bookmarks</TITLE>", "<H1>Bookmarks</H1>", "<DL><p>"];',
          '  const walk = async (guid, depth) => {',
          '    if (depth > 8 || left <= 0) return;',
          '    let kids = [];',
          '    try {',
          '      const all = await bm.search({ parentGuid: guid });',
          '      kids = all.filter(k => k.guid !== guid && k.parentGuid === guid);',
          '    } catch (e) { return; }',
          '    const pad = "    ".repeat(depth);',
          '    for (const it of kids) {',
          '      if (left <= 0) break;',
          '      if (it.guid === guid) continue;',
          '      left--;',
          '      if (it.type === bm.TYPE_FOLDER) {',
          '        folders++;',
          '        out.push(pad + "<DT><H3>" + esc(it.title) + "</H3>");',
          '        out.push(pad + "<DL><p>");',
          '        await walk(it.guid, depth + 1);',
          '        out.push(pad + "</DL><p>");',
          '      } else {',
          '        const u = uriOf(it);',
          '        if (u) { out.push(pad + "<DT><A HREF=\\"" + esc(u) + "\\">" + esc(it.title) + "</A>"); links++; }',
          '      }',
          '    }',
          '  };',
          '  for (const r of [bm.toolbarGuid, bm.menuGuid, bm.unfiledGuid]) {',
          '    const info = await bm.fetch({ guid: r });',
          '    out.push("    <DT><H3>" + esc(info.title) + "</H3>");',
          '    out.push("    <DL><p>");',
          '    await walk(r, 2);',
          '    out.push("    </DL><p>");',
          '  }',
          '  out.push("</DL><p>");',
          '  const text = out.join(String.fromCharCode(10)) + String.fromCharCode(10);',
          '  if (file.exists()) file.remove(false);',
          '  const stream = Cc["@mozilla.org/network/file-output-stream;1"].createInstance(Ci.nsIFileOutputStream);',
          '  stream.init(file, 0x02 | 0x08 | 0x20, 0o644, 0);',
          '  stream.write(text, text.length);',
          '  stream.close();',
          '  return JSON.stringify({ ok: true, links, folders, bytes: text.length });',
          ' } catch (e) { return JSON.stringify({ error: String(e) }); }',
          '})()',
        ].join(String.fromCharCode(10))
        return client.evaluate(code, chromeContext)
      })
      if (typeof raw !== 'string') throw new Error('export returned nothing')
      const info = JSON.parse(raw) as { error?: string; links?: number; folders?: number; bytes?: number }
      if (info.error !== undefined) throw new Error(info.error)
      return (
        'exported ' +
        String(info.links) +
        ' links and ' +
        String(info.folders) +
        ' folders' +
        String.fromCharCode(10) +
        'written to: ' +
        filePath +
        ' (' +
        String(info.bytes) +
        ' bytes)'
      )
    },
  )

  defineTool(
    server,
    'browser_bookmarks_import',
    {
      title: 'Import a Netscape HTML bookmark file',
      description:
        'Read a Netscape Bookmark HTML file and recreate its folders and links under a chosen bookmark folder. ' +
        'MEASURED: Firefox has no importFromHTML in this build, so this parses the file with DOMParser and calls ' +
        'PlacesUtils.bookmarks.insert per item. Import is one level of grouping: each <H3> opens a folder and the ' +
        'following <A> entries land inside it, which matches how browsers export a single grouping level.',
      inputSchema: {
        path: z.string().describe('Absolute .html file to read'),
        parentGuid: z.string().optional().describe('Destination folder guid (default: bookmarks menu)'),
      },
      annotations: WRITES_PERSISTENTLY,
    },
    async ({ path, parentGuid }: { path: string; parentGuid?: string }) => {
      const filePath = str(path, 'path')
      const dest = parentGuid === undefined ? null : str(parentGuid, 'parentGuid')
      const raw = await withChrome(async (client, chromeContext) => {
        const code = [
          '(async () => {',
          ' try {',
          '  const { PlacesUtils } = ChromeUtils.importESModule("resource://gre/modules/PlacesUtils.sys.mjs");',
          '  const bm = PlacesUtils.bookmarks;',
          '  const file = new FileUtils.File(' + JSON.stringify(filePath) + ');',
          '  if (!file.exists()) return JSON.stringify({ error: "file not found" });',
          '  let text = "";',
          '  const fis = Cc["@mozilla.org/network/file-input-stream;1"].createInstance(Ci.nsIFileInputStream);',
          '  fis.init(file, -1, 0, 0);',
          '  const cs = Cc["@mozilla.org/intl/converter-input-stream;1"].createInstance(Ci.nsIConverterInputStream);',
          '  cs.init(fis, "UTF-8", 0, Ci.nsIConverterInputStream.DEFAULT_REPLACEMENT_CHARACTER);',
          '  const chunk = {};',
          '  while (cs.readString(4096, chunk) !== 0) text += chunk.value;',
          '  cs.close();',
          '  const doc = new DOMParser().parseFromString(text, "text/html");',
          '  let cur = ' + (dest === null ? 'bm.menuGuid' : JSON.stringify(dest)) + ';',
          '  let links = 0, folders = 0;',
          '  const nodes = Array.from(doc.querySelectorAll("h3, a"));',
          '  for (const n of nodes) {',
          '    if (n.tagName === "H3") {',
          '      const title = (n.textContent || "Imported").trim() || "Imported";',
          '      try {',
          '        const f = await bm.insert({ parentGuid: cur, title, type: bm.TYPE_FOLDER });',
          '        cur = f.guid;',
          '        folders++;',
          '      } catch (e) {}',
          '    } else if (n.tagName === "A") {',
          '      const url = n.getAttribute("href");',
          '      if (!url || !/^(https?|ftp|file):/i.test(url)) continue;',
          '      try {',
          '        await bm.insert({ parentGuid: cur, title: (n.textContent || url).trim(), url });',
          '        links++;',
          '      } catch (e) {}',
          '    }',
          '  }',
          '  return JSON.stringify({ ok: true, links, folders });',
          ' } catch (e) { return JSON.stringify({ error: String(e) }); }',
          '})()',
        ].join(String.fromCharCode(10))
        return client.evaluate(code, chromeContext)
      })
      if (typeof raw !== 'string') throw new Error('import returned nothing')
      const info = JSON.parse(raw) as { error?: string; links?: number; folders?: number }
      if (info.error !== undefined) throw new Error(info.error)
      return 'imported ' + String(info.links) + ' links and ' + String(info.folders) + ' folders'
    },
  )

  defineTool(
    server,
    'browser_list_bookmarks',
    {
      title: 'List bookmarks',
      description:
        'Read bookmarks from a folder (privileged context), each entry with the guid that browser_remove_bookmark ' +
        'needs. Defaults to the toolbar; the bookmarks menu and Other Bookmarks are reachable through parentGuid.',
      inputSchema: {
        parentGuid: z
          .string()
          .optional()
          .describe(
            'Folder guid (default: the toolbar, "toolbar_____"). Also useful: "menu________" (bookmarks menu) ' +
              'and "unfiled_____" (Other Bookmarks).',
          ),
      },
      annotations: READ_ONLY,
    },
    async ({ parentGuid }: { parentGuid?: string }) => {
      const root = parentGuid === undefined ? 'PlacesUtils.bookmarks.toolbarGuid' : JSON.stringify(parentGuid)
      return JSON.stringify(
        await withChrome(
          async (client, context) =>
            await client.evaluate(
              `(async () => {
                     const rootGuid = ${root};
                     const tree = await PlacesUtils.promiseBookmarksTree(rootGuid);
                     const kids = tree.children || [];
                     return JSON.stringify(kids.slice(0, 50).map(b => ({ guid: b.guid, title: b.title, url: b.uri, type: b.type })));
                   })()`,
              context,
            ),
        ),
        null,
        2,
      )
    },
  )
}
