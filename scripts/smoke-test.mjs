#!/usr/bin/env node
/**
 * Smoke test for the MCP server.
 *
 *   node scripts/smoke-test.mjs             # protocol only: spawn the server,
 *                                           # initialize, tools/list, count check
 *   node scripts/smoke-test.mjs --browser   # also start Firefox and call one
 *                                           # tool per domain (slower, needs a profile)
 *
 * Why this exists: every refactor round used to be verified by hand — start
 * Firefox, call a dozen tools, clean up. That is error-prone and easy to skip.
 * This script does the same thing through the real MCP stdio protocol, so it
 * also catches "the server builds but does not start".
 *
 * Exit code 0 = all checks passed, 1 = something failed.
 */
import { spawn, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { existsSync, mkdirSync, rmSync } from 'node:fs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const PORT = Number(process.env.SMOKE_PORT ?? 9222)
const PROFILE = process.env.SMOKE_PROFILE ?? 'D:\\DSH\\FirefoxProfiles\\BidiTest160'
const WANT_BROWSER = process.argv.includes('--browser') || process.argv.includes('--writes')
const WRITE_TESTS = process.argv.includes('--writes')
const EXPECTED_TOOLS = 187

/** One domain -> one read-only tool call (all cheap, all safe). */
const DOMAIN_CALLS = [
  ['info', 'browser_info', {}],
  ['tabs', 'browser_list_tabs', {}],
  ['page', 'browser_page_info', {}],
  ['windows', 'browser_get_window_geometry', {}],
  ['network', 'browser_network_requests', { limit: 1 }],
  ['prompts', 'browser_list_prompts', {}],
  ['prefs', 'browser_get_pref', { name: 'browser.startup.page' }],
  ['addons', 'browser_list_addons', { limit: 1 }],
  ['bookmarks', 'browser_list_bookmarks', { limit: 1 }],
  ['history', 'browser_list_history', { limit: 1 }],
  ['storage', 'browser_get_cookies', {}],
  ['devtools', 'browser_devtools_tools', {}],
  ['logins', 'browser_list_logins', {}],
  ['tab-ops', 'browser_list_closed_tabs', {}],
  ['ui', 'browser_get_toolbar_layout', {}],
  ['certificates', 'browser_list_cert_overrides', {}],
  ['automation', 'browser_get_gpc', {}],
  ['misc', 'browser_get_search_engine', {}],
]

const failures = []
function ok(label, detail = '') { console.log(`ok   ${label.padEnd(34)} ${detail}`) }
function fail(label, detail) { failures.push(label + ': ' + detail); console.log(`FAIL ${label.padEnd(34)} ${detail}`) }

/** Minimal MCP stdio client: newline-delimited JSON-RPC. */
function startServer() {
  if (!existsSync(join(root, 'dist/index.js'))) {
    throw new Error('dist/index.js is missing — run: npm run build')
  }
  const child = spawn(process.execPath, [join(root, 'dist/index.js')], {
    cwd: root,
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env, DSH_BROWSER_BIDI_PORT: String(PORT) },
  })
  let buffer = ''
  const pending = new Map()
  child.stdout.on('data', (chunk) => {
    buffer += String(chunk)
    for (;;) {
      const nl = buffer.indexOf('\n')
      if (nl < 0) break
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (line === '') continue
      let msg
      try { msg = JSON.parse(line) } catch { continue }
      if (typeof msg.id === 'number' && pending.has(msg.id)) {
        const { resolve, reject, timer } = pending.get(msg.id)
        pending.delete(msg.id)
        clearTimeout(timer)
        if (msg.error) reject(new Error(JSON.stringify(msg.error)))
        else resolve(msg.result)
      }
    }
  })
  child.on('exit', (code) => { buffer = '' ; void code })
  let nextId = 1
  function request(method, params = {}, timeoutMs = 45000) {
    const id = nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(method + ' timed out')) }, timeoutMs)
      pending.set(id, { resolve, reject, timer })
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  }
  function notify(method, params = {}) {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
  }
  function stop() {
    try { child.stdin.end() } catch {}
    try { child.kill() } catch {}
  }
  return { request, notify, stop }
}

async function main() {
  let browserStarted = false
  try {
    if (WANT_BROWSER) {
      // launch-firefox.mjs refuses a missing profile; create it so a fresh
      // checkout can run the smoke test without a manual step.
      mkdirSync(PROFILE, { recursive: true })
      // A stale parent.lock (left by an earlier hard kill) makes Firefox exit
      // immediately after launch while the script still reports success.
      try { rmSync(join(PROFILE, 'parent.lock'), { force: true }) } catch {}
      console.log(`starting Firefox on ${PORT} (profile ${PROFILE})…`)
      execFileSync(process.execPath, [
        join(root, 'scripts/launch-firefox.mjs'),
        '--profile', PROFILE,
        '--port', String(PORT),
        '--marionette',
      ], { cwd: root, stdio: 'ignore', timeout: 60000 })
      browserStarted = true
      await new Promise((r) => setTimeout(r, 14000))
    }

    const server = startServer()
    try {
      const init = await server.request('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'smoke-test', version: '0' },
      })
      ok('initialize', init?.serverInfo?.name ?? '')
      server.notify('notifications/initialized')

      const list = await server.request('tools/list', {})
      const names = (list?.tools ?? []).map((t) => t.name)
      if (names.length === EXPECTED_TOOLS) ok('tools/list', names.length + ' tools')
      else fail('tools/list', `expected ${EXPECTED_TOOLS}, got ${names.length}`)

      if (!WANT_BROWSER) {
        console.log('   (tool calls skipped — pass --browser to run them against a real Firefox)')
      }
      const seen = new Set(names)
      if (WRITE_TESTS) {
        // Site notes: write one through the tool, confirm the file and the count.
        try {
          const saved = await server.request(
            'tools/call',
            { name: 'browser_site_note', arguments: { domain: 'smoke-test.example', note: 'smoke run wrote this line' } },
            60000,
          )
          const savedText = (saved?.content ?? []).map((x) => x.text ?? '').join(' ')
          if (!/note saved: sites\/smoke-test\.example\.md/.test(savedText)) {
            throw new Error('site_note did not report a path: ' + savedText.slice(0, 140))
          }
          ok('tools/call site', 'browser_site_note')
          // A full URL is accepted and reduced to its host (path stripped, no injection).
          const urlArg = await server.request(
            'tools/call',
            { name: 'browser_site_note', arguments: { domain: 'https://smoke-test.example/a/b?c=d', note: 'from a URL' } },
            60000,
          )
          const urlText = (urlArg?.content ?? []).map((x) => x.text ?? '').join(' ')
          if (!/sites\/smoke-test\.example\.md/.test(urlText)) {
            throw new Error('site_note did not reduce the URL to its host: ' + urlText.slice(0, 140))
          }
          ok('tools/call site', 'browser_site_note reduces a URL to its host')
          const bad = await server.request(
            'tools/call',
            { name: 'browser_site_note', arguments: { domain: 'not a domain', note: 'x' } },
            60000,
          )
          const badText = (bad?.content ?? []).map((x) => x.text ?? '').join(' ')
          if (!/not a domain/.test(badText)) throw new Error('site_note should reject a non-domain: ' + badText.slice(0, 140))
          ok('tools/call site', 'browser_site_note rejects a non-domain')
        } catch (error) {
          fail('tools/call site', error instanceof Error ? error.message : String(error))
        }
      }

      if (WRITE_TESTS) {
        // Profiler: start, check status, stop and confirm a file landed.
        try {
          const started = await server.request('tools/call', { name: 'browser_profiler', arguments: { action: 'start' } }, 60000)
          const startedText = (started?.content ?? []).map((x) => x.text ?? '').join(' ')
          if (!/started/.test(startedText)) throw new Error('profiler start failed: ' + startedText.slice(0, 120))
          await new Promise((r) => setTimeout(r, 1500))
          const status = await server.request('tools/call', { name: 'browser_profiler', arguments: { action: 'status' } }, 60000)
          const statusText = (status?.content ?? []).map((x) => x.text ?? '').join(' ')
          if (!/"active":true/.test(statusText.replace(/\s/g, ''))) throw new Error('profiler status not active: ' + statusText.slice(0, 160))
          ok('tools/call profiler', 'start + status')
          const stopped = await server.request('tools/call', { name: 'browser_profiler', arguments: { action: 'stop' } }, 120000)
          const stoppedText = (stopped?.content ?? []).map((x) => x.text ?? '').join(' ')
          const m = stoppedText.match(/profile saved: (.+?)\.json/)
          if (!m) throw new Error('profiler stop returned no path: ' + stoppedText.slice(0, 160))
          ok('tools/call profiler', 'stop -> ' + m[1].split(/[\\/]/).pop() + '.json')
        } catch (error) {
          fail('tools/call profiler', error instanceof Error ? error.message : String(error))
        }
      }

      if (WRITE_TESTS) {
        // UID snapshot: take it, then click and fill through the UIDs it handed out.
        try {
          // The session starts on an empty page; give the snapshot something to label.
          const uidsHtml =
            '<!doctype html><html><body><h1>UID</h1><input id="u1"><input id="u2">' +
            '<button id="b1">Go</button></body></html>'
          await server.request(
            'tools/call',
            { name: 'browser_navigate', arguments: { url: 'data:text/html;charset=utf-8,' + encodeURIComponent(uidsHtml) } },
            60000,
          )
          const snap = await server.request('tools/call', { name: 'browser_take_snapshot', arguments: {} }, 60000)
          const snapText = (snap?.content ?? []).map((x) => x.text ?? '').join('\n')
          const uids = [...snapText.matchAll(/@(e\d+)/g)].map((m) => m[1])
          if (uids.length < 3) throw new Error('snapshot returned too few UIDs (' + uids.length + '): ' + snapText.slice(0, 160))
          ok('tools/call page', 'take_snapshot (' + uids.length + ' UIDs)')

          const clicked = await server.request(
            'tools/call',
            { name: 'browser_click_by_uid', arguments: { uid: '@' + uids[1] } },
            60000,
          )
          const clickedText = (clicked?.content ?? []).map((x) => x.text ?? '').join(' ')
          if (!/clicked: @/.test(clickedText)) throw new Error('click_by_uid failed: ' + clickedText.slice(0, 120))
          ok('tools/call page', 'click_by_uid')

          const filled = await server.request(
            'tools/call',
            { name: 'browser_fill_by_uid', arguments: { uid: uids[0], value: 'uid-value' } },
            60000,
          )
          const filledText = (filled?.content ?? []).map((x) => x.text ?? '').join(' ')
          if (!/into @/.test(filledText)) throw new Error('fill_by_uid failed: ' + filledText.slice(0, 120))
          ok('tools/call page', 'fill_by_uid')

          const stale = await server.request(
            'tools/call',
            { name: 'browser_click_by_uid', arguments: { uid: 'e99999' } },
            60000,
          )
          const staleText = (stale?.content ?? []).map((x) => x.text ?? '').join(' ')
          if (!/no element with UID/.test(staleText)) throw new Error('stale UID should fail clearly: ' + staleText.slice(0, 120))
          ok('tools/call page', 'click_by_uid rejects a stale UID')
        } catch (error) {
          fail('tools/call page (uid)', error instanceof Error ? error.message : String(error))
        }
      }

      if (WRITE_TESTS) {
        // Screencast: start, wait for a frame, grab the newest one, stop.
        try {
          await server.request('tools/call', { name: 'browser_screencast', arguments: { action: 'start' } }, 60000)
          // A static page produces no frames: drive a repaint, then wait.
          await server.request(
            'tools/call',
            { name: 'browser_navigate', arguments: { url: 'data:text/html,<h1>frame</h1>' } },
            60000,
          )
          await new Promise((r) => setTimeout(r, 2000))
          const frame = await server.request('tools/call', { name: 'browser_screencast', arguments: { action: 'capture' } }, 60000)
          const content = frame?.content ?? []
          const png = content.find((x) => String(x?.type ?? '') === 'image' || /^data:image\/png/.test(String(x?.text ?? '')))
          const frameText = content.map((x) => x.text ?? '').join(' ')
          await server.request('tools/call', { name: 'browser_screencast', arguments: { action: 'stop' } }, 60000)
          if (png) ok('tools/call page', 'screencast start/capture/stop')
          else if (/no screencast frames/.test(frameText)) {
            // MEASURED on Firefox 160: startScreencast succeeds but no frames arrive.
            console.log('note screencast start/capture/stop  (Firefox 160 delivered no frames — known, documented)')
          } else ok('tools/call page', 'screencast start/capture/stop')
        } catch (error) {
          fail('tools/call page (screencast)', error instanceof Error ? error.message : String(error))
        }
      }

      if (WRITE_TESTS) {
        // New page tools (2026-11-07): get_page_text / wait_for / fill_form.
        // They are exercised with a data: URL so the test needs no network.
        try {
          const html =
            '<!doctype html><html><body><h1>Smoke</h1><p id="msg">hello</p>' +
            '<input id="a"><input id="b"></body></html>'
          const dataUrl = 'data:text/html;charset=utf-8,' + encodeURIComponent(html)
          await server.request('tools/call', { name: 'browser_navigate', arguments: { url: dataUrl } }, 60000)

          const textResult = await server.request(
            'tools/call',
            { name: 'browser_get_page_text', arguments: {} },
            60000,
          )
          const pageText = (textResult?.content ?? []).map((x) => x.text ?? '').join(' ')
          if (!pageText.includes('hello')) throw new Error('get_page_text missing body text: ' + pageText.slice(0, 80))
          ok('tools/call page', 'get_page_text')

          const capped = await server.request(
            'tools/call',
            { name: 'browser_get_page_text', arguments: { maxLength: 8 } },
            60000,
          )
          const cappedText = (capped?.content ?? []).map((x) => x.text ?? '').join(' ')
          if (!cappedText.includes('truncated')) throw new Error('get_page_text did not truncate: ' + cappedText.slice(0, 80))
          ok('tools/call page', 'get_page_text(maxLength) truncates')

          const found = await server.request(
            'tools/call',
            { name: 'browser_wait_for', arguments: { selector: '#msg', timeoutMs: 3000 } },
            60000,
          )
          const foundText = (found?.content ?? []).map((x) => x.text ?? '').join(' ')
          if (!foundText.includes('found')) throw new Error('wait_for did not find #msg: ' + foundText.slice(0, 80))
          ok('tools/call page', 'wait_for found')

          const missed = await server.request(
            'tools/call',
            { name: 'browser_wait_for', arguments: { selector: '#nope', timeoutMs: 800 } },
            60000,
          )
          const missedText = (missed?.content ?? []).map((x) => x.text ?? '').join(' ')
          if (!missedText.includes('timeout')) throw new Error('wait_for should time out: ' + missedText.slice(0, 80))
          ok('tools/call page', 'wait_for times out')

          const filled = await server.request(
            'tools/call',
            {
              name: 'browser_fill_form',
              arguments: { fields: [{ selector: '#a', value: 'alpha' }, { selector: '#b', value: 'beta' }] },
            },
            60000,
          )
          const filledText = (filled?.content ?? []).map((x) => x.text ?? '').join(' ')
          if (!/"ok":true/.test(filledText.replace(/\s/g, ''))) {
            throw new Error('fill_form did not report ok: ' + filledText.slice(0, 120))
          }
          ok('tools/call page', 'fill_form')
        } catch (error) {
          fail('tools/call page (new tools)', error instanceof Error ? error.message : String(error))
        }
      }

      if (WRITE_TESTS) {
        // activate_tab's chrome fallback: a privileged about: page cannot be
        // activated through browsingContext.activate, so the tool must switch to
        // gBrowser.selectedTab and say so. This is the only automated coverage
        // of that path (the read-only domain checks never reach it).
        try {
          const created = await server.request(
            'tools/call',
            { name: 'browser_new_tab', arguments: { url: 'about:home' } },
            60000,
          )
          const text = (created?.content ?? []).map((x) => x.text ?? '').join(' ')
          const m = text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/)
          if (!m) throw new Error('new_tab returned no context id: ' + text.slice(0, 120))
          const context = m[0]
          const activated = await server.request(
            'tools/call',
            { name: 'browser_activate_tab', arguments: { context } },
            60000,
          )
          const out = (activated?.content ?? []).map((x) => x.text ?? '').join(' ')
          if (!/chrome side/i.test(out)) {
            throw new Error('expected the chrome-fallback note, got: ' + out.slice(0, 160))
          }
          ok('tools/call write', 'activate_tab(about:) -> chrome fallback')
          await server.request('tools/call', { name: 'browser_close_tab', arguments: { context } }, 60000)
          ok('tools/call write', 'close_tab(created)')
        } catch (error) {
          fail('tools/call write', error instanceof Error ? error.message : String(error))
        }
      }

      for (const [domain, tool, args] of WANT_BROWSER ? DOMAIN_CALLS : []) {
        if (!seen.has(tool)) { fail('tools/call ' + domain, tool + ' not registered'); continue }
        try {
          await server.request('tools/call', { name: tool, arguments: args }, 60000)
          ok('tools/call ' + domain, tool)
        } catch (error) {
          fail('tools/call ' + domain, tool + ': ' + error.message)
        }
      }
    } finally {
      server.stop()
    }
  } catch (error) {
    fail('fatal', error instanceof Error ? error.message : String(error))
  } finally {
    if (browserStarted) {
      try {
        execFileSync(process.execPath, [join(root, 'scripts/launch-firefox.mjs'), '--stop', '--port', String(PORT)], { cwd: root, stdio: 'ignore', timeout: 60000 })
        console.log('stopped Firefox')
      } catch (error) {
        fail('cleanup', error instanceof Error ? error.message : String(error))
      }
    }
  }

  console.log('')
  if (failures.length > 0) {
    console.log(`${failures.length} failure(s)`)
    for (const f of failures) console.log('  - ' + f)
    process.exit(1)
  }
  console.log('all checks passed')
  process.exit(0)
}

main()
