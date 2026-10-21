#!/usr/bin/env node
/**
 * 文档一致性检查：docs/文件职责.md 与仓库里的文件是否对得上。
 *
 * 内容
 * - MAP / WALK_DIRS / WALK_EXTENSIONS / HISTORY_WORDS；walk 与下面各项检查。
 * - 源码里引用的 scripts/* 与 ./x.ts 是否真实存在；私有哨兵是否回流。
 *
 * 行为
 * - src/** 与 scripts/** 的每个代码文件在文件职责里都有一行。
 * - 文件职责里列出的每个路径真实存在。
 * - 代码行里没有历史叙述。
 * - 源码注释里不引用不存在的脚本 / 同目录模块，也不出现 md-blank-carrier / dshref: / %%dsh-。
 *
 * 边界
 * - 只检查覆盖、路径与引用，不判断描述对不对。
 *
 * 相关文件
 * - docs/文件职责.md；package.json 的 verify:map。
 *
 * 改哪里
 * - 改历史词：HISTORY_WORDS。
 * - 改扫描范围：WALK_DIRS / WALK_EXTENSIONS。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, extname, join, normalize } from 'node:path'

const MAP = 'docs/文件职责.md'
// `docs/` 不进 git：内部文档不再要求登记，公开产物 `public-docs/` 反过来要登记。
const WALK_DIRS = ['src', 'scripts', 'reference', 'public-docs']
const WALK_EXTENSIONS = new Set(['.ts', '.tsx', '.mjs', '.cjs', '.css', '.md', '.txt'])
const HISTORY_WORDS = /\b2026\b|R-\d+|实测|决策|从前|曾经|已删|已修|待拆/
const SCRIPT_REF = /scripts\/[A-Za-z0-9._-]+/g
const LOCAL_MODULE_REF = /(?<!\.)\.\/[A-Za-z0-9._-]+\.tsx?/g
const BANNED = /%%dsh-|dshref:|md-blank-carrier/g

/**
 * @param {string} text - file contents.
 * @param {number} index - offset of a match.
 * @returns {number} 1-based line number.
 */
function lineAt(text, index) {
  return text.slice(0, index).split('\n').length
}

/**
 * @param {string} dir - repo-relative directory.
 * @returns {string[]} every code file below it, repo-relative with `/`.
 */
function walk(dir) {
  const out = []
  for (const entry of readdirSync(join(process.cwd(), dir), { withFileTypes: true })) {
    const child = `${dir}/${entry.name}`
    if (entry.isDirectory()) out.push(...walk(child))
    else if (WALK_EXTENSIONS.has(extname(entry.name))) out.push(child)
  }
  return out
}

const lines = readFileSync(MAP, 'utf8')
  // 内部小节（`<!-- internal:start -->` … `<!-- internal:end -->`）只活在本地，
  // 它们列的是不公开的 `docs/` 文件；公开产物与仓库文件才是这里要对的账。
  .replace(/<!-- internal:start -->[\s\S]*?<!-- internal:end -->\n*/g, '')
  .split(/\r?\n/)
/** @type {Map<string, number>} */
const listed = new Map()
const writtenIn = []
let base = ''

for (let index = 0; index < lines.length; index += 1) {
  const line = lines[index]
  const heading = /^##\s+(.+)$/.exec(line)
  if (heading) {
    const quoted = /`([^`]+)`/.exec(heading[1])
    base = quoted !== null && quoted[1].endsWith('/') ? quoted[1] : ''
    continue
  }
  if (!line.trim().startsWith('|')) continue
  const cells = line.split('|')
  if (cells.length < 3) continue
  const first = cells[1] ?? ''
  const paths = [...first.matchAll(/`([^`]+)`/g)]
    .map(match => match[1])
    .filter(path => /\.(ts|tsx|mjs|cjs|css|json|ya?ml|md|txt)$/.test(path))
  for (const path of paths) {
    const resolved = path.includes('/') || base === '' ? path : `${base}${path}`
    if (!listed.has(resolved)) listed.set(resolved, index + 1)
    if (
      resolved.startsWith('src/') ||
      resolved.startsWith('scripts/') ||
      base.startsWith('src/') ||
      base.startsWith('scripts/')
    ) {
      writtenIn.push({ line: index + 1, path: resolved, text: line })
    }
  }
}

const actual = WALK_DIRS.flatMap(walk)
const codeFiles = actual.filter(path => path.startsWith('src/') || path.startsWith('scripts/'))
const docFiles = actual.filter(path => path.startsWith('docs/') || path.startsWith('reference/'))
const missingRows = actual.filter(path => !listed.has(path))
const missingFiles = [...listed.keys()].filter(path => !existsSync(join(process.cwd(), path)))
const history = writtenIn.filter(row => HISTORY_WORDS.test(row.text))

/** @type {{ file: string, line: number, ref: string }[]} */
const missingScripts = []
/** @type {{ file: string, line: number, ref: string }[]} */
const missingModules = []
/** @type {{ file: string, line: number, token: string }[]} */
const banned = []
for (const file of actual.filter(path => path.startsWith('src/'))) {
  const text = readFileSync(join(process.cwd(), file), 'utf8')
  for (const match of text.matchAll(SCRIPT_REF)) {
    if (!existsSync(join(process.cwd(), match[0]))) {
      missingScripts.push({ file, line: lineAt(text, match.index), ref: match[0] })
    }
  }
  for (const match of text.matchAll(LOCAL_MODULE_REF)) {
    // Prose names a module relative to the layer that owns it (`./readOnly.ts` written from
    // `workbench/model.ts` means `src/client/readOnly.ts`), so every ancestor is a candidate.
    const candidates = []
    let directory = dirname(file)
    for (;;) {
      candidates.push(normalize(join(directory, match[0])))
      const parent = dirname(directory)
      if (parent === directory) break
      directory = parent
    }
    if (!candidates.some(candidate => existsSync(join(process.cwd(), candidate)))) {
      missingModules.push({ file, line: lineAt(text, match.index), ref: match[0] })
    }
  }
  for (const match of text.matchAll(BANNED)) {
    banned.push({ file, line: lineAt(text, match.index), token: match[0] })
  }
}

console.log('verify-map: 文件职责 vs 仓库')
console.log(`  code files:   ${codeFiles.length}`)
console.log(`  docs files:   ${docFiles.length}`)
console.log(`  listed paths: ${listed.size}`)

if (missingRows.length > 0) {
  console.log('\nmissing row (code file not in 文件职责):')
  for (const path of missingRows) console.log(`  ${path}`)
}
if (missingFiles.length > 0) {
  console.log('\nmissing file (listed path does not exist):')
  for (const path of missingFiles) console.log(`  ${path}`)
}
if (history.length > 0) {
  console.log('\nhistory word (code row must describe the current code only):')
  for (const row of history) console.log(`  ${MAP}:${row.line}  ${row.path}`)
}
if (missingScripts.length > 0) {
  console.log('\nmissing script (source references a script that does not exist):')
  for (const hit of missingScripts) console.log(`  ${hit.file}:${hit.line}  ${hit.ref}`)
}
if (missingModules.length > 0) {
  console.log('\nmissing module (source references a local module that does not exist):')
  for (const hit of missingModules) console.log(`  ${hit.file}:${hit.line}  ${hit.ref}`)
}
if (banned.length > 0) {
  console.log('\nbanned token (private sentinel / retired carrier):')
  for (const hit of banned) console.log(`  ${hit.file}:${hit.line}  ${hit.token}`)
}

const failures =
  missingRows.length +
  missingFiles.length +
  history.length +
  missingScripts.length +
  missingModules.length +
  banned.length
if (failures > 0) {
  console.log(`\nCHECK FAILED: ${failures} item(s)`)
  process.exitCode = 1
} else {
  console.log('\nOK')
}
