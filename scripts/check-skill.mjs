#!/usr/bin/env node
/**
 * Offline checks for the firefox-bidi-mcp skill.
 *
 * Modelled on Mozilla's plugins/gecko/tests (which validate frontmatter, links
 * and tables for their skills): a skill that ships broken links or a missing
 * frontmatter silently degrades every task that loads it.
 *
 *   node scripts/check-skill.mjs
 *
 * Exit 0 = clean, 1 = problems listed.
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve, relative } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const skillDir = join(root, 'skills/firefox-bidi-mcp')
const main = join(skillDir, 'SKILL.md')
const problems = []
const notes = []

function fail(msg) { problems.push(msg); console.log('FAIL ' + msg) }
function ok(msg) { console.log('ok   ' + msg) }

// 1) frontmatter
if (!existsSync(main)) {
  fail('SKILL.md 不存在')
  process.exit(1)
}
const text = readFileSync(main, 'utf8')
const fm = text.match(/^---\n([\s\S]*?)\n---\n/)
if (!fm) fail('SKILL.md 缺少 YAML frontmatter')
else {
  const body = fm[1]
  const name = body.match(/^name:\s*(.+)$/m)
  const desc = body.match(/^description:\s*(.+)$/m)
  if (!name) fail('frontmatter 缺少 name')
  else if (name[1].trim() !== 'firefox-bidi-mcp') fail('frontmatter name 不是 firefox-bidi-mcp: ' + name[1].trim())
  else ok('frontmatter name = firefox-bidi-mcp')
  if (!desc) fail('frontmatter 缺少 description')
  else {
    const d = desc[1].trim()
    if (d.length > 200) fail('description 过长（' + d.length + ' > 200 字符）—— 它会进入每次会话的上下文')
    else ok('description ' + d.length + ' 字符')
  }
}

// 2) 所有 markdown 链接
const files = [main, ...readdirSync(join(skillDir, 'references')).map((f) => join(skillDir, 'references', f))]
let linkCount = 0
for (const file of files) {
  const content = readFileSync(file, 'utf8')
  for (const m of content.matchAll(/\]\(([^)]+)\)/g)) {
    const link = m[1]
    if (!link.endsWith('.md') || link.startsWith('http')) continue
    linkCount++
    const target = file === main ? join(skillDir, link) : join(skillDir, 'references', link)
    if (!existsSync(target)) fail(relative(root, file) + ' 的链接指向不存在的文件: ' + link)
  }
}
ok(linkCount + ' 个 markdown 链接全部可达')

// 3) references 是否都被 SKILL.md 引用（没人引用的会变成死文件）
const mainText = readFileSync(main, 'utf8')
const refs = readdirSync(join(skillDir, 'references')).filter((f) => f.endsWith('.md'))
const unreferenced = refs.filter((f) => f !== 'tools.md' && !mainText.includes(f))
if (unreferenced.length > 0) notes.push('未被 SKILL.md 引用的 reference: ' + unreferenced.join(', '))
else ok(refs.length + ' 份 references 都在 SKILL.md 的导航表里（tools.md 由导航表引用）')

// 4) references 不应为空
for (const f of refs) {
  const s = statSync(join(skillDir, 'references', f)).size
  if (s < 200) fail('references/' + f + ' 太小 (' + s + 'B)，可能是空壳')
}
ok('references 体积正常')

// 5) 工具清单是否与源码一致（调用 gen-tools-doc --check）
try {
  const { execFileSync } = await import('node:child_process')
  execFileSync(process.execPath, [join(root, 'scripts/gen-tools-doc.mjs'), '--check'], { cwd: root, stdio: 'pipe' })
  ok('references/tools.md 与 src/tools/*.ts 同步')
} catch {
  fail('references/tools.md 已过时 —— 跑 npm run gen-docs')
}

for (const n of notes) console.log('note ' + n)
console.log('')
if (problems.length > 0) {
  console.log(problems.length + ' problem(s)')
  process.exit(1)
}
console.log('skill checks passed')
