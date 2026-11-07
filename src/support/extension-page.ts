import { withBidi } from './connection.js'
import { failure } from './output.js'

/**
 * Run an expression inside one of an extension's own pages.
 *
 * Why it works this way (every step MEASURED against a throwaway extension):
 *  - `policy.extension` is undefined in this Firefox build, so there is no
 *    direct handle on the extension's background page or its browserAction;
 *  - a tab pointing at `moz-extension://…/options.html` DOES get a BiDi
 *    browsing context, and inside it the `browser.*` APIs are live — reading
 *    and writing `storage.local` both succeeded there;
 *  - a toolbar popup lives inside a widget panel and never gets its own
 *    context, and the background page is not exposed either, so the options
 *    page is the only usable entry point. Extensions without one cannot be
 *    reached.
 * The helper tab is closed on every exit path, including failure.
 */
export async function inExtensionPage(extId: string, pageHint: string | null, expression: string): Promise<string> {
  return await withBidi(async (client) => {
    const chromeContext = await client.chromeContext()
    if (chromeContext === null) {
      throw new Error('no privileged (chrome) context — Firefox must be launched with MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1')
    }
    const opened = await client.evaluate(
      '(async () => {' +
        ' try {' +
        '  const id = ' +
        JSON.stringify(extId) +
        ';' +
        '  const pageHint = ' +
        JSON.stringify(pageHint) +
        ';' +
        '  const { ExtensionParent } = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");' +
        '  const policy = ExtensionParent.GlobalManager.extensionMap.get(id);' +
        '  if (!policy) return JSON.stringify({ error: "no such extension: " + id });' +
        '  const manifest = policy.manifest || {};' +
        '  const declared = (manifest.options_ui && manifest.options_ui.page) || manifest.options_page || null;' +
        '  const page = pageHint || declared;' +
        '  if (!page) return JSON.stringify({ error: "extension " + id + " declares no options page; pass page explicitly" });' +
        '  let url = page;' +
        '  if (page.indexOf("://") === -1) {' +
        '    let rel = page;' +
        '    while (rel.length > 0 && rel.charAt(0) === "/") rel = rel.slice(1);' +
        '    url = policy.baseURI.spec + rel;' +
        '  }' +
        '  gBrowser.addTab(url, {' +
        '    triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),' +
        '    inBackground: true' +
        '  });' +
        '  return JSON.stringify({ ok: true, url });' +
        ' } catch (e) { return JSON.stringify({ error: e.message }); }' +
        ' })()',
      chromeContext,
    )
    if (typeof opened !== 'string') throw new Error('could not open an extension page')
    const openedInfo = JSON.parse(opened) as { error?: string; url?: string }
    if (openedInfo.error !== undefined) throw new Error(openedInfo.error)
    const pageUrl = String(openedInfo.url)

    const closeHelperTab = async (): Promise<void> => {
      try {
        await client.evaluate(
          '(() => {' +
            ' try {' +
            '  for (const t of Array.from(gBrowser.tabs)) {' +
            '    if (t.linkedBrowser.currentURI.spec === ' +
            JSON.stringify(pageUrl) +
            ') gBrowser.removeTab(t);' +
            '  }' +
            '  return "closed";' +
            ' } catch (e) { return "ERR " + e.message; }' +
            ' })()',
          chromeContext,
        )
      } catch {
        // Closing is best effort; never mask the real result.
      }
    }

    try {
      let context: string | null = null
      for (let attempt = 0; attempt < 25; attempt += 1) {
        const tree = (await client.call('browsingContext.getTree', {})) as {
          contexts?: Array<{ context: string; url?: string; children?: unknown[] }>
        }
        type Node = { context: string; url?: string; children?: unknown[] }
        const flat: Array<{ context: string; url?: string }> = []
        const collect = (nodes: Node[]): void => {
          for (const node of nodes) {
            flat.push({ context: node.context, url: node.url })
            if (Array.isArray(node.children)) collect(node.children as Node[])
          }
        }
        collect((tree.contexts ?? []) as Node[])
        const hit = flat.find((node) => node.url === pageUrl)
        if (hit !== undefined) {
          context = hit.context
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 200))
      }
      if (context === null) throw new Error('extension page never got a browsing context: ' + pageUrl)
      const result = (await client.evaluate(expression, context)) as unknown
      return typeof result === 'string' ? result : JSON.stringify(result)
    } finally {
      await closeHelperTab()
    }
  })
}

/**
 * Find a Tampermonkey-family extension and run an internal command in its options page.
 *
 * Why this exists: Tampermonkey keeps its script management behind an internal API that is
 * only callable from its own pages (`window.sendMessage` is defined only under /options and
 * /ask). MEASURED against the official Firefox Beta xpi (firefoxbeta@tampermonkey.net, 5.6.6239):
 *   window.sendMessage({method:"saveScript", code, uuid:"<non-empty>", ...}) -> installed:true
 *   window.sendMessage({method:"modifyScriptOptions", uuid, options:{enabled:false}})
 *   window.sendMessage({method:"purgeScripts", uuids:[...]})
 * Note the uuid rule: empty/null gives "uuid missing"; a NEW uuid creates a new script, so the
 * caller must de-duplicate first (which the install tool does by @name).
 */
export async function tampermonkeyCommand(command: Record<string, unknown>): Promise<string> {
  return await withBidi(async (client) => {
    const chromeContext = await client.chromeContext()
    if (chromeContext === null) {
      throw new Error('no privileged (chrome) context — Firefox must be launched with MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1')
    }
    const opened = await client.evaluate(
      '(() => {' +
        ' try {' +
        '  const { ExtensionParent } = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");' +
        '  let found = null;' +
        '  for (const [id, policy] of ExtensionParent.GlobalManager.extensionMap) {' +
        '    if (id.toLowerCase().indexOf("tampermonkey") !== -1) { found = [id, policy]; break; }' +
        '  }' +
        '  if (!found) return JSON.stringify({ error: "no Tampermonkey extension is installed" });' +
        '  const [id, policy] = found;' +
        '  const m = policy.manifest || {};' +
        '  const page = (m.options_ui && m.options_ui.page) || m.options_page || null;' +
        '  if (!page) return JSON.stringify({ error: "Tampermonkey declares no options page" });' +
        '  let url = page;' +
        '  if (page.indexOf("://") === -1) {' +
        '    let rel = page; while (rel.length > 0 && rel.charAt(0) === "/") rel = rel.slice(1);' +
        '    url = policy.baseURI.spec + rel;' +
        '  }' +
        '  gBrowser.addTab(url, {' +
        '    triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),' +
        '    inBackground: true' +
        '  });' +
        '  return JSON.stringify({ ok: true, id, url });' +
        ' } catch (e) { return JSON.stringify({ error: e.message }); }' +
        ' })()',
      chromeContext,
    )
    if (typeof opened !== 'string') throw new Error('could not locate Tampermonkey')
    const openedInfo = JSON.parse(opened) as { error?: string; url?: string }
    if (openedInfo.error !== undefined) throw new Error(openedInfo.error)
    const pageUrl = String(openedInfo.url)

    const closeTab = async (): Promise<void> => {
      try {
        await client.evaluate(
          '(() => {' +
            ' try {' +
            '  for (const t of Array.from(gBrowser.tabs)) {' +
            '    if (t.linkedBrowser.currentURI.spec === ' +
            JSON.stringify(pageUrl) +
            ') gBrowser.removeTab(t);' +
            '  }' +
            '  return "closed";' +
            ' } catch (e) { return "ERR " + e.message; }' +
            ' })()',
          chromeContext,
        )
      } catch {
        // Best effort only.
      }
    }

    try {
      let context: string | null = null
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const tree = (await client.call('browsingContext.getTree', {})) as {
          contexts?: Array<{ context: string; url?: string; children?: unknown[] }>
        }
        type Node = { context: string; url?: string; children?: unknown[] }
        const flat: Array<{ context: string; url?: string }> = []
        const collect = (nodes: Node[]): void => {
          for (const node of nodes) {
            flat.push({ context: node.context, url: node.url })
            if (Array.isArray(node.children)) collect(node.children as Node[])
          }
        }
        collect((tree.contexts ?? []) as Node[])
        const hit = flat.find((node) => node.url === pageUrl)
        if (hit !== undefined) {
          context = hit.context
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 200))
      }
      if (context === null) throw new Error('Tampermonkey options page never opened: ' + pageUrl)
      const expression =
        '(async () => {' +
        ' try {' +
        '  const payload = ' +
        JSON.stringify(command) +
        ';' +
        '  const r = await new Promise((resolve) => {' +
        '    window.sendMessage(payload, (resp) => resolve(resp));' +
        '    setTimeout(() => resolve({ __timeout: true }), 12000);' +
        '  });' +
        '  if (r && r.__timeout) return JSON.stringify({ error: "Tampermonkey did not answer" });' +
        '  return JSON.stringify(r);' +
        ' } catch (e) { return JSON.stringify({ error: e.message }); }' +
        ' })()'
      const result = (await client.evaluate(expression, context)) as unknown
      return typeof result === 'string' ? result : JSON.stringify(result)
    } finally {
      await closeTab()
    }
  })
}

/**
 * Pull the userscript entries out of a Tampermonkey loadTree payload.
 *
 * MEASURED: loadTree(with referrer:"options") mixes real scripts together with Tampermonkey's
 * own settings nodes (layout / language / auto-reload …). Only entries that carry a uuid are
 * actual scripts, so everything else is dropped here — otherwise the list tool spams settings
 * names and the install de-duplication sees phantom entries.
 */
export const tampermonkeyScripts = (raw: unknown): Array<{ name: string; uuid: string }> => {
  const found: Array<{ name: string; uuid: string }> = []
  const walk = (items: unknown): void => {
    if (!Array.isArray(items)) return
    for (const item of items) {
      if (item === null || typeof item !== 'object') continue
      const node = item as { name?: unknown; uuid?: unknown; items?: unknown }
      if (Array.isArray(node.items)) walk(node.items)
      else if (typeof node.name === 'string' && typeof node.uuid === 'string' && node.uuid.length > 0) {
        found.push({ name: node.name, uuid: node.uuid })
      }
    }
  }
  try {
    const parsed = JSON.parse(String(raw)) as { items?: unknown }
    walk(parsed.items)
  } catch {
    // Leave the result empty; the caller reports the raw payload.
  }
  return found
}

export const tampermonkeyScriptNames = (raw: unknown): string[] => tampermonkeyScripts(raw).map((script) => script.name)
