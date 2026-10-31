#!/usr/bin/env node
/**
 * Regenerate skills/browser-mcp/references/tools.md from src/index.ts.
 *
 * Why this exists: the tool list was hand-maintained and drifted — the README
 * said "23 tools" while the server registered 177. Generating the list from the
 * source means adding a tool can never leave the docs stale again.
 *
 * Grouping still comes from the existing tools.md (domain order is a human
 * choice), but every name/description is read from the source. Run with:
 *
 *   node scripts/gen-tools-doc.mjs           # rewrite in place
 *   node scripts/gen-tools-doc.mjs --check   # exit 1 if the file is stale
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const SRC = join(root, 'src/index.ts')
const DOC = join(root, 'skills/browser-mcp/references/tools.md')

/** Collapse a multi-line description into one short sentence. */
function brief(text) {
  const one = text.replace(/\s+/g, ' ').trim()
  const cut = one.search(/[.。](?:\s|$)/)
  const first = cut > 0 ? one.slice(0, cut) : one
  if (first.length <= 96) return first
  return first.slice(0, 93).replace(/[,;:\s]+\S*$/, '') + '…'
}

function parseTools(src) {
  const tools = new Map()
  // Each tool starts at server.registerTool( and the name is the first
  // single-quoted string on the following line.
  const re = /server\.registerTool\(\s*\n\s*'([a-z0-9_]+)'\s*,\s*\n\s*\{/g
  let m
  while ((m = re.exec(src)) !== null) {
    const name = m[1]
    const start = m.index
    // Description lives in the `description:` field of the metadata object.
    const tail = src.slice(start, start + 4000)
    const d = tail.match(/description:\s*\n?((?:\s*'[^']*'\s*\+?\s*\n?)+)/)
    let desc = ''
    if (d) {
      desc = [...d[1].matchAll(/'([^']*)'/g)].map((x) => x[1]).join('')
    }
    tools.set(name, desc)
  }
  return tools
}

function parseExistingGroups() {
  if (!existsSync(DOC)) return []
  const text = readFileSync(DOC, 'utf8')
  const groups = []
  const re = /^## (.+?)（(\d+)）\s*$/gm
  let m
  while ((m = re.exec(text)) !== null) {
    const title = m[1]
    const after = text.slice(m.index + m[0].length)
    const listEnd = after.indexOf('\n## ')
    const block = listEnd === -1 ? after : after.slice(0, listEnd)
    const head = block.split(/\n\s*\n/)[0]
    // Two shapes are accepted so the generator can read both the old
    // hand-written list (names separated by ·) and its own output
    // ("- `name` — description").
    let names
    if (head.includes('`')) {
      names = [...head.matchAll(/^- `([a-z0-9_]+)`/gm)].map((x) => x[1])
    } else {
      names = head
        .split('·')
        .map((s) => s.trim().replace(/^browser_/, ''))
        .filter(Boolean)
    }
    groups.push({ title, names })
  }
  return groups
}

const src = readFileSync(SRC, 'utf8')
const tools = parseTools(src)
if (tools.size === 0) {
  console.error('✗ parsed 0 tools from src/index.ts — the regex no longer matches')
  process.exit(1)
}

// Tools that exist in source but were never listed in the hand-written doc.
// Filed here explicitly so the generator does not need a catch-all bucket.
const EXTRA = [
  { title: '开发者工具', names: ['browser_console'] },
  {
    title: '批量导入（从外部数据迁移）',
    names: ['import_cookies', 'import_cookies_from_file', 'import_logins_from_file', 'import_history'],
  },
]

const groups = parseExistingGroups()
for (const extra of EXTRA) {
  const g = groups.find((x) => x.title === extra.title)
  if (g) {
    for (const n of extra.names) if (!g.names.includes(n)) g.names.push(n)
  } else {
    groups.push({ title: extra.title, names: [...extra.names] })
  }
}
const grouped = new Set()
for (const g of groups) for (const n of g.names) grouped.add(n)

// Anything registered in source but absent from the doc goes to a catch-all so
// a newly added tool shows up immediately instead of silently vanishing.
const missing = [...tools.keys()]
  .map((n) => n.replace(/^browser_/, ''))
  .filter((n) => !grouped.has(n))
if (missing.length > 0) {
  groups.push({ title: '新增待归类', names: missing })
}

const lines = []
lines.push(`# ${tools.size} 个 browser_* 工具速查`)
lines.push('')
lines.push('> 按域分组。下表名字省略 `browser_` 前缀，实际调用要带。')
lines.push('> ⚠️ 本文件由 `scripts/gen-tools-doc.mjs` 从 `src/index.ts` 生成 —— 改工具请改源码后重跑，⛔ 别手改这里。')
lines.push('')

let counted = 0
for (const g of groups) {
  const present = g.names.filter((n) => tools.has('browser_' + n))
  if (present.length === 0) continue
  counted += present.length
  lines.push(`## ${g.title}（${present.length}）`)
  lines.push('')
  for (const n of present) {
    const desc = brief(tools.get('browser_' + n) || '')
    lines.push(desc ? `- \`${n}\` — ${desc}` : `- \`${n}\``)
  }
  lines.push('')
}

lines.push('---')
lines.push('')
lines.push(
  `**合计 ${tools.size} 个 · 已归类 ${counted} · 未归类 ${tools.size - counted}**`,
)
lines.push('')
const out = lines.join('\n')

if (process.argv.includes('--check')) {
  const current = existsSync(DOC) ? readFileSync(DOC, 'utf8') : ''
  if (current !== out) {
    console.error('✗ tools.md is stale — run: node scripts/gen-tools-doc.mjs')
    process.exit(1)
  }
  console.log(`✓ tools.md is up to date (${tools.size} tools)`)
  process.exit(0)
}

writeFileSync(DOC, out, 'utf8')
console.log(`✓ wrote ${DOC}`)
console.log(`  ${tools.size} tools · ${groups.length} groups · ${counted} classified`)
if (missing.length > 0) {
  console.log(`  ⚠️ ${missing.length} new tool(s) filed under 新增待归类: ${missing.join(', ')}`)
}
