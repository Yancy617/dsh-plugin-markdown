/**
 * 内部文档的本地备份（`docs/` 不进 git，所以它是本项目唯一没有版本历史的东西）。
 *
 * 内容
 * - DOCS_DIR / BACKUP_ROOT / KEEP / treeHash / main。
 *
 * 行为
 * - 把 `docs/` 整棵复制到 `<备份根>/docs-YYYYMMDD-HHmmss/`；`--if-changed` 时内容没变就跳过。
 * - 内容指纹取「相对路径 + 大小 + 修改时间」，不读文件内容：备份只需要判断"要不要再存一份"。
 * - 只保留最近 `KEEP` 份，多出来的按目录名（时间戳）从旧到新删。
 *
 * 边界
 * - 只复制，不改动 `docs/`；不碰 git，不碰 `public-docs/`。
 * - 备份根默认在仓库外（`D:\01DSH\_backups\markdown-docs`），可用 `DOCS_BACKUP_DIR` 覆盖。
 *
 * 相关文件
 * - 被依赖：.git-hooks/pre-commit（`--if-changed`）。
 * - 公开文档由 scripts/docs-public.mjs 生成，与备份无关。
 *
 * 改哪里
 * - 改保留份数：KEEP。
 * - 改备份位置：BACKUP_ROOT 或环境变量 DOCS_BACKUP_DIR。
 */
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const DOCS_DIR = fileURLToPath(new URL('../docs', import.meta.url))
const BACKUP_ROOT = process.env.DOCS_BACKUP_DIR ?? 'D:\\01DSH\\_backups\\markdown-docs'
const KEEP = 10
const STAMP = join(BACKUP_ROOT, '.last-hash')

/**
 * @param {string} dir - 目录。
 * @returns {Promise<string[]>} 目录下所有文件的仓库相对路径，已排序。
 */
async function listFiles(dir) {
  const out = []
  const walk = async current => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const child = join(current, entry.name)
      if (entry.isDirectory()) await walk(child)
      else if (entry.isFile()) out.push(child)
    }
  }
  await walk(dir)
  return out.sort()
}

/**
 * @returns {Promise<string>} `docs/` 的内容指纹。
 */
async function treeHash() {
  const files = await listFiles(DOCS_DIR)
  const parts = []
  for (const file of files) {
    const info = await stat(file)
    parts.push(`${relative(DOCS_DIR, file)}:${String(info.size)}:${String(info.mtimeMs)}`)
  }
  return parts.join('\n')
}

/**
 * @returns {Promise<number>} `docs/` 里的 `.md` 份数（完整性检查用）。
 */
async function markdownCount() {
  return (await listFiles(DOCS_DIR)).filter(file => file.endsWith('.md')).length
}

/**
 * @param {string} stamp - 时间戳片段。
 * @returns {string} `YYYYMMDD-HHmmss`。
 */
function stampOf(date) {
  const pad = value => String(value).padStart(2, '0')
  return `${String(date.getFullYear())}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

async function main() {
  const ifChanged = process.argv.includes('--if-changed')
  if (!existsSync(DOCS_DIR)) {
    console.error('docs-backup: docs/ 不存在，没什么可备份的。')
    process.exitCode = 1
    return
  }
  const count = await markdownCount()
  if (count < 20) {
    console.error(`docs-backup: docs/ 里只有 ${String(count)} 份 .md，像是被删过，先停下。`)
    process.exitCode = 1
    return
  }
  const hash = await treeHash()
  if (ifChanged && existsSync(STAMP)) {
    const previous = (await readFile(STAMP, 'utf8')).trim()
    if (previous === hash) return
  }
  await mkdir(BACKUP_ROOT, { recursive: true })
  const dest = join(BACKUP_ROOT, `docs-${stampOf(new Date())}`)
  await cp(DOCS_DIR, dest, { recursive: true })
  await writeFile(STAMP, hash, 'utf8')
  console.log(`docs-backup: ${String(count)} 份文档 → ${dest}`)

  const entries = (await readdir(BACKUP_ROOT, { withFileTypes: true }))
    .filter(entry => entry.isDirectory() && entry.name.startsWith('docs-'))
    .map(entry => entry.name)
    .sort()
  for (const name of entries.slice(0, Math.max(0, entries.length - KEEP))) {
    await rm(join(BACKUP_ROOT, name), { recursive: true, force: true })
  }
}

await main()
