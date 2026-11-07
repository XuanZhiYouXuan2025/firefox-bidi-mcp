import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Per-site experience notes.
 *
 * Lives inside the repository (dist/support -> ../../), not in the user's home
 * directory: this is a local personal repository, and workspace rules keep
 * generated data off the C drive. Written by the browser_site_note tool,
 * surfaced by browser_info so an agent sees "this domain already has notes"
 * before re-exploring a site it has visited before.
 */
const here = dirname(fileURLToPath(import.meta.url))
export const SITES_DIR = join(here, '..', '..', 'sites')

/** Domains are used as file names, so accept only a conservative shape. */
export function normalizeDomain(input: unknown): string {
  const raw = String(input ?? '').trim().toLowerCase()
  if (raw === '') throw new Error('domain is required')
  const cleaned = raw
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '') // strip scheme
    .replace(/\/.*$/, '')                     // strip path
    .replace(/^www\./, '')
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(cleaned)) {
    throw new Error(
      'not a domain: "' + raw + '" — pass a bare host such as example.com (no scheme, no path)',
    )
  }
  return cleaned
}

export function siteNotePath(domain: string): string {
  return join(SITES_DIR, domain + '.md')
}

/** How many note lines this domain has (0 when there is no file). */
export function siteNoteLines(domain: string): number {
  const file = siteNotePath(domain)
  if (!existsSync(file)) return 0
  try {
    return readFileSync(file, 'utf8')
      .split(String.fromCharCode(10))
      .filter((line) => line.trim().startsWith('- ')).length
  } catch {
    return 0
  }
}

/** Append one dated note, creating the file with a heading on first use. */
export function appendSiteNote(domain: string, note: string): { file: string; lines: number } {
  const text = String(note ?? '').trim()
  if (text === '') throw new Error('note is required')
  const file = siteNotePath(domain)
  mkdirSync(SITES_DIR, { recursive: true })
  const stamp = new Date().toISOString().slice(0, 10)
  const line = '- ' + stamp + ': ' + text.replace(/\s+/g, ' ') + String.fromCharCode(10)
  if (!existsSync(file)) {
    writeFileSync(file, '# ' + domain + String.fromCharCode(10, 10) + line, 'utf8')
  } else {
    writeFileSync(file, readFileSync(file, 'utf8') + line, 'utf8')
  }
  return { file, lines: siteNoteLines(domain), size: statSync(file).size } as { file: string; lines: number }
}

/** The domain of a URL, or null when it is not an http(s) URL. */
export function domainOfUrl(url: unknown): string | null {
  try {
    const parsed = new URL(String(url))
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    return parsed.hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return null
  }
}
