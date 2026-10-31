#!/usr/bin/env node
/**
 * Launch a Firefox instance that dsh-browser-mcp can attach to.
 *
 * Why this is a separate script and not an MCP tool: the MCP server attaches to
 * an ALREADY RUNNING browser over its BiDi port. Starting that browser is an
 * upstream step — you need the browser before the server can do anything — so
 * putting it inside the server would be the wrong layer (and a tool that spawns
 * processes is a much bigger thing to hand to a model).
 *
 * What it does:
 *   - starts Firefox with --remote-debugging-port=<port>
 *   - and, unless --no-system-access is given, with MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1,
 *     which is what the privileged (chrome) tools need. It must be set AT LAUNCH;
 *     it cannot be added to a running browser.
 *
 * Usage:
 *   node scripts/launch-firefox.mjs --profile <dir> [--port 9222] [--no-system-access]
 *   node scripts/launch-firefox.mjs --stop --port 9222
 *
 * Whatever it starts, it can also stop again: the launch writes a pid file next
 * to this script (scripts/.launched/<port>.json), and --stop reads it, asks that
 * process to quit, waits for the port to be released, and reports what happened.
 * Anything left running is reported honestly rather than quietly abandoned.
 *
 * Notes:
 *   - --profile is REQUIRED and is never guessed: launching the wrong profile is
 *     exactly the kind of thing you do not want a script to decide.
 *   - --no-remote --new-instance are always passed so this never hijacks a
 *     Firefox that is already running.
 *   - Nothing is killed or replaced. If something already listens on the port,
 *     the script says so and exits.
 */

import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createConnection } from 'node:net'
import { platform } from 'node:os'
import { resolve } from 'node:path'

function parseArgs(argv) {
  const out = {
    port: 9222,
    systemAccess: true,
    firefox: null,
    profile: null,
    headless: false,
    stop: false,
    marionette: false,
    marionettePort: 2828,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--profile') out.profile = argv[++i]
    else if (arg === '--port') out.port = Number(argv[++i])
    else if (arg === '--firefox') out.firefox = argv[++i]
    else if (arg === '--no-system-access') out.systemAccess = false
    else if (arg === '--headless') out.headless = true
    else if (arg === '--stop') out.stop = true
    else if (arg === '--marionette') out.marionette = true
    else if (arg === '--marionette-port') out.marionettePort = Number(argv[++i])
    else if (arg === '--help' || arg === '-h') out.help = true
    else {
      console.error('unknown argument: ' + arg)
      out.help = true
    }
  }
  return out
}

function usage() {
  console.log(
    [
      'Launch Firefox for dsh-browser-mcp.',
      '',
      '  node scripts/launch-firefox.mjs --profile <dir> [--port 9222] [--firefox <exe>]',
      '                                  [--no-system-access] [--headless]',
      '',
      '  --profile <dir>       REQUIRED. The profile directory to run.',
      '  --port <n>            BiDi port (default 9222). Point DSH_BROWSER_BIDI_PORT at it.',
      '  --firefox <exe>       Firefox executable (default: platform guess, see below).',
      '  --no-system-access    Do not set MOZ_REMOTE_ALLOW_SYSTEM_ACCESS; the privileged',
      '                        (chrome) tools will then refuse to work.',
      '  --headless            Run without a window.',
      '  --marionette          Also start the Marionette server (needed for the couple of tools that',
      '                        only exist there, such as Global Privacy Control).',
      '  --marionette-port <n> Marionette port (default 2828).',
      '  --stop                Stop the instance this script started on <port> (reads its pid file).',
      '',
      'The script always passes -no-remote --new-instance, so it never joins or',
      'disturbs a Firefox that is already running.',
    ].join('\n'),
  )
}

/** Default Firefox locations, checked in order. */
function guessFirefox() {
  if (platform() === 'win32') {
    return [
      'C:/Program Files/Firefox Developer Edition/firefox.exe',
      'C:/Program Files/Mozilla Firefox/firefox.exe',
      'C:/Program Files (x86)/Mozilla Firefox/firefox.exe',
    ]
  }
  if (platform() === 'darwin') {
    return ['/Applications/Firefox.app/Contents/MacOS/firefox']
  }
  return ['/usr/bin/firefox', '/usr/local/bin/firefox', '/snap/bin/firefox']
}

/** Is something already listening on the port? */
function portInUse(port) {
  return new Promise((done) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    socket.on('connect', () => {
      socket.destroy()
      done(true)
    })
    socket.on('error', () => done(false))
    socket.setTimeout(1000, () => {
      socket.destroy()
      done(false)
    })
  })
}

const STATE_DIR = join(dirname(fileURLToPath(import.meta.url)), '.launched')

function statePath(port) {
  return join(STATE_DIR, String(port) + '.json')
}

function readState(port) {
  const file = statePath(port)
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function writeState(port, info) {
  mkdirSync(STATE_DIR, { recursive: true })
  writeFileSync(statePath(port), JSON.stringify(info, null, 2) + String.fromCharCode(10), 'utf8')
}

/** Wait until nothing listens on the port (or give up). */
async function waitForPortFree(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!(await portInUse(port))) return true
    await new Promise((r) => setTimeout(r, 500))
  }
  return !(await portInUse(port))
}

/** --stop: stop what a previous launch on this port started. */
/**
 * The pids actually serving a BiDi port.
 *
 * MEASURED: the pid spawn() returns is the launcher, and Firefox forks the real
 * browser process from it — that launcher usually exits immediately, so killing
 * its pid does nothing (ESRCH) while the port stays busy. So stop by looking at
 * what is really serving the port: command lines that mention it.
 */
function findPids(port) {
  const needle = '--remote-debugging-port=' + String(port)
  const pids = []
  try {
    if (platform() === 'win32') {
      const script =
        'Get-CimInstance Win32_Process -Filter "Name=' + "'firefox.exe'" + '" | ' +
        'Where-Object { $_.CommandLine -like ' + "'*" + needle + "*'" + " } | " +
        'Select-Object -ExpandProperty ProcessId'
      const out = execFileSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', script],
        { encoding: 'utf8', timeout: 20000 },
      )
      for (const line of out.split(String.fromCharCode(10))) {
        const value = Number(line.trim())
        if (Number.isInteger(value) && value > 0) pids.push(value)
      }
    } else {
      const out = execFileSync('pgrep', ['-f', needle], { encoding: 'utf8', timeout: 20000 })
      for (const line of out.split(String.fromCharCode(10))) {
        const value = Number(line.trim())
        if (Number.isInteger(value) && value > 0) pids.push(value)
      }
    }
  } catch {
    // No match (or no tool): an empty list is the honest answer.
  }
  return pids
}

async function stopInstance(port) {
  const state = readState(port)
  if (!(await portInUse(port))) {
    if (state !== null) rmSync(statePath(port), { force: true })
    console.log(
      'nothing is listening on port ' + String(port) + ' — already stopped' +
        (state === null ? ' (no record of a launch either)' : ' (cleared a stale record)'),
    )
    return 0
  }

  let pids = findPids(port)
  if (pids.length === 0 && state !== null && typeof state.pid === 'number') {
    // Fall back to the recorded launcher pid, which may still be alive on some systems.
    console.log('no process is advertising port ' + String(port) + '; trying the recorded pid ' + String(state.pid))
    pids = [state.pid]
  }
  if (pids.length === 0) {
    console.error(
      'error: port ' + String(port) + ' is in use, but no Firefox process claims it and this script has no ' +
        'record of launching it. Refusing to kill anything — not hiding this.',
    )
    return 4
  }

  console.log('stopping pid(s) ' + pids.join(', ') + ' on port ' + String(port) +
    (state === null ? '' : ' (profile ' + String(state.profile) + ')'))

  for (const pid of pids) {
    try {
      process.kill(pid)
    } catch (error) {
      console.log('  soft signal to ' + String(pid) + ' failed: ' + (error instanceof Error ? error.message : String(error)))
    }
  }
  let freed = await waitForPortFree(port, 8000)
  if (!freed && platform() === 'win32') {
    for (const pid of findPids(port).length > 0 ? findPids(port) : pids) {
      try {
        execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', timeout: 20000 })
      } catch {
        // The verification below reports the truth either way.
      }
    }
    freed = await waitForPortFree(port, 12000)
  }

  if (!freed) {
    const still = findPids(port)
    console.error(
      'error: port ' + String(port) + ' is still in use by pid(s) ' +
        (still.length > 0 ? still.join(', ') : '(unknown)') + ' — the instance did not stop. Not hiding this.',
    )
    return 5
  }
  rmSync(statePath(port), { force: true })
  console.log('stopped; port ' + String(port) + ' is free and the record was cleared')
  return 0
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.stop) {
    if (!Number.isInteger(args.port) || args.port <= 0 || args.port > 65535) {
      console.error('error: --stop needs a valid --port')
      process.exit(2)
    }
    process.exit(await stopInstance(args.port))
  }
  if (args.help) {
    usage()
    process.exit(args.help === true && !args.profile ? 0 : 0)
  }
  if (args.profile === null) {
    console.error('error: --profile is required (the script never guesses a profile)')
    usage()
    process.exit(2)
  }
  const profileDir = resolve(args.profile)
  if (!existsSync(profileDir) || !statSync(profileDir).isDirectory()) {
    console.error('error: profile directory does not exist: ' + profileDir)
    process.exit(2)
  }
  if (!Number.isInteger(args.port) || args.port <= 0 || args.port > 65535) {
    console.error('error: --port must be 1..65535, got: ' + String(args.port))
    process.exit(2)
  }

  const candidates = args.firefox === null ? guessFirefox() : [args.firefox]
  const exe = candidates.find((path) => existsSync(path))
  if (exe === undefined) {
    console.error('error: could not find Firefox. Tried:')
    for (const path of candidates) console.error('  ' + path)
    console.error('Pass --firefox <exe> to point at it.')
    process.exit(2)
  }

  if (await portInUse(args.port)) {
    console.error(
      'error: port ' + String(args.port) + ' is already in use — refusing to start, because a browser may ' +
        'already be running there. Nothing was changed.',
    )
    process.exit(3)
  }

  const argv = [
    '-no-remote',
    '--new-instance',
    '--remote-debugging-port=' + String(args.port),
    '-profile',
    profileDir,
  ]
  if (args.headless) argv.push('--headless')

  // env must be built before anything touches it.
  const env = { ...process.env }
  if (args.systemAccess) env.MOZ_REMOTE_ALLOW_SYSTEM_ACCESS = '1'
  if (args.marionette) {
    argv.push('--marionette')
    env.MOZ_MARIONETTE = '1'
    env.MARIONETTE_PORT = String(args.marionettePort)
  }

  console.log('launching: ' + exe)
  console.log('  profile: ' + profileDir)
  console.log('  bidi   : ws://127.0.0.1:' + String(args.port) + '/session')
  console.log('  system access: ' + (args.systemAccess ? 'yes (privileged tools available)' : 'no'))
  console.log('')
  console.log('Point an MCP entry at it with:')
  console.log('  env: { DSH_BROWSER_BIDI_PORT: "' + String(args.port) + '" }')

  const child = spawn(exe, argv, { env, detached: true, stdio: 'ignore' })
  child.unref()
  writeState(args.port, {
    pid: child.pid,
    port: args.port,
    profile: profileDir,
    startedAt: new Date().toISOString(),
    systemAccess: args.systemAccess,
  })
  console.log('')
  console.log('started pid ' + String(child.pid) + ' (detached; this script exits now)')
  console.log('stop it later with: node scripts/launch-firefox.mjs --stop --port ' + String(args.port))
}

main().catch((error) => {
  console.error('failed: ' + (error instanceof Error ? error.message : String(error)))
  process.exit(1)
})
