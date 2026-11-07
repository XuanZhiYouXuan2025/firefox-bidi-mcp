#!/usr/bin/env node
/**
 * Regenerate skills/firefox-bidi-mcp/references/tools.md from src/tools/*.ts.
 *
 * History: this used to parse src/index.ts, because every tool was registered
 * there. After the 2026-11-07 refactor the tools live in 20 domain modules and
 * are registered through defineTool(), so the source of truth is now the tools
 * directory and the group order comes from that directory too (no hand-kept
 * grouping table to drift).
 *
 *   node scripts/gen-tools-doc.mjs           # rewrite in place
 *   node scripts/gen-tools-doc.mjs --check   # exit 1 if the file is stale
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const TOOLS_DIR = join(root, 'src/tools')
const INDEX = join(root, 'src/index.ts')
const DOC = join(root, 'skills/firefox-bidi-mcp/references/tools.md')

/** Domain module -> human title. Order here is the order in the document. */
const DOMAINS = [
  ['page.ts', '页面操作'],
  ['tabs.ts', '标签页'],
  ['tab-ops.ts', '标签页进阶'],
  ['windows.ts', '窗口与视口'],
  ['ui.ts', '工具栏与侧栏'],
  ['bookmarks.ts', '书签'],
  ['history.ts', '历史'],
  ['network.ts', '网络与下载'],
  ['storage.ts', 'Cookie / 缓存 / 站点数据'],
  ['logins.ts', '密码与自动填充'],
  ['prefs.ts', '设置'],
  ['addons.ts', '扩展与主题'],
  ['extensions.ts', '扩展与篡改猴'],
  ['info.ts', '档案与诊断'],
  ['devtools.ts', '开发者工具'],
  ['automation.ts', '自动化标记与 GPC'],
  ['certificates.ts', '证书'],
  ['prompts.ts', '弹窗与导航历史'],
  ['input-ext.ts', '输入扩展（拖拽/长按/上传）'],
  ['misc.ts', '同步与杂项'],
  ['profiler.ts', '性能分析'],
]

/** Collapse a multi-line description into one short sentence. */
function brief(text) {
  const one = text.replace(/\s+/g, ' ').trim()
  const cut = one.search(/[.。](?:\s|$)/)
  const first = cut > 0 ? one.slice(0, cut) : one
  if (first.length <= 96) return first
  return first.slice(0, 93).replace(/[,;:\s]+\S*$/, '') + '…'
}

/** Pull name + description out of one source file. */
function parseFile(src) {
  const out = []
  const re = /defineTool\(\s*server\s*,\s*'([a-z0-9_]+)'\s*,\s*\{/g
  let m
  while ((m = re.exec(src)) !== null) {
    const name = m[1]
    const tail = src.slice(m.index, m.index + 6000)
    // description: '...' + '...' (possibly multi-line, possibly several parts)
    const d = tail.match(/description:\s*\n?((?:\s*'[^']*'\s*\+?\s*\n?)+)/)
    let desc = ''
    if (d) desc = [...d[1].matchAll(/'([^']*)'/g)].map((x) => x[1]).join('')
    out.push({ name, desc })
  }
  return out
}

/** Tools still registered the old way (should be zero; reported if not). */
function parseLegacy(src) {
  const out = []
  const re = /server\.registerTool\(\s*\n\s*'([a-z0-9_]+)'/g
  let m
  while ((m = re.exec(src)) !== null) out.push(m[1])
  return out
}

const sections = []
const seen = new Set()
for (const [file, title] of DOMAINS) {
  const full = join(TOOLS_DIR, file)
  if (!existsSync(full)) continue
  const tools = parseFile(readFileSync(full, 'utf8'))
  const fresh = tools.filter((t) => !seen.has(t.name))
  for (const t of fresh) seen.add(t.name)
  if (fresh.length > 0) sections.push({ title, tools: fresh })
}

// Anything left in index.ts or in a module not listed above must not vanish.
const leftovers = []
if (existsSync(INDEX)) leftovers.push(...parseLegacy(readFileSync(INDEX, 'utf8')))
for (const f of readdirSync(TOOLS_DIR)) {
  if (!f.endsWith('.ts')) continue
  if (DOMAINS.some(([d]) => d === f)) continue
  for (const t of parseFile(readFileSync(join(TOOLS_DIR, f), 'utf8'))) {
    if (!seen.has(t.name)) { seen.add(t.name); leftovers.push(t.name) }
  }
}
if (leftovers.length > 0) {
  sections.push({ title: '新增待归类', tools: leftovers.map((n) => ({ name: n, desc: '' })) })
}

const total = seen.size
if (total === 0) {
  console.error('✗ parsed 0 tools from src/tools/*.ts — the defineTool regex no longer matches')
  process.exit(1)
}

const lines = []
lines.push(`# ${total} 个 browser_* 工具速查`)
lines.push('')
lines.push('> 按域分组。下表名字省略 `browser_` 前缀，实际调用要带。')
lines.push('> ⚠️ 本文件由 `scripts/gen-tools-doc.mjs` 从 `src/tools/*.ts` 生成 —— 改工具请改源码后重跑，⛔ 别手改这里。')
lines.push('')

for (const s of sections) {
  lines.push(`## ${s.title}（${s.tools.length}）`)
  lines.push('')
  for (const t of s.tools) {
    const short = t.name.replace(/^browser_/, '')
    const desc = brief(t.desc || '')
    lines.push(desc ? `- \`${short}\` — ${desc}` : `- \`${short}\``)
  }
  lines.push('')
}

lines.push('---')
lines.push('')
lines.push(`**合计 ${total} 个 · 分 ${sections.length} 组**`)
lines.push('')
const out = lines.join('\n')

if (process.argv.includes('--check')) {
  const current = existsSync(DOC) ? readFileSync(DOC, 'utf8') : ''
  if (current !== out) {
    console.error('✗ tools.md is stale — run: node scripts/gen-tools-doc.mjs')
    process.exit(1)
  }
  console.log(`✓ tools.md is up to date (${total} tools)`)
  process.exit(0)
}

writeFileSync(DOC, out, 'utf8')
console.log(`✓ wrote ${DOC}`)
console.log(`  ${total} tools · ${sections.length} groups`)
if (leftovers.length > 0) console.log(`  ⚠️ ${leftovers.length} unclassified: ${leftovers.join(', ')}`)
