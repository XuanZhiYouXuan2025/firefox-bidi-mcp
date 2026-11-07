import { readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Resolve the BiDi port.
 *
 * Order: explicit env var, then the port file written by Firefox's
 * `remote.experimental.dynamicstart.enabled` feature
 * (~/.firefox-devtools-mcp/instances/<pid>.port, newest wins), then 9222.
 *
 * Dynamic start is the default for the primary profile, so the port can change
 * between Firefox restarts — reading the file is what keeps this server usable
 * without hardcoding a number.
 */
export function discoverBidiPort(): number {
  const explicit = process.env.DSH_BROWSER_BIDI_PORT
  if (explicit !== undefined && explicit !== '') return Number(explicit)
  try {
    const dir = join(homedir(), '.firefox-devtools-mcp', 'instances')
    const files = readdirSync(dir).filter((f) => f.endsWith('.port'))
    let best: { port: number; mtime: number } | null = null
    for (const f of files) {
      try {
        const txt = readFileSync(join(dir, f), 'utf8').trim()
        const n = Number(txt)
        if (!Number.isFinite(n) || n <= 0) continue
        const pid = Number(f.replace(/\.port$/, ''))
        const mtime = Number.isFinite(pid) ? pid : 0
        if (best === null || mtime > best.mtime) best = { port: n, mtime }
      } catch {
        // A stale file from a dead browser is expected; skip it.
      }
    }
    if (best !== null) return best.port
  } catch {
    // No dynamic-start sidecar directory: fall through to the default port.
  }
  return 9222
}

export const port = discoverBidiPort()
