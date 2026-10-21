/**
 * 从内部文档生成公开文档（`docs/` → `public-docs/`）。
 *
 * 内容
 * - main。
 *
 * 行为
 * - 只复制 docs-config.mjs 里 PUBLIC_FILES 列出的文件。
 * - 脱敏、链接改写、"自动生成"头注都在 docs-config 的 render 里。
 * - 每次整目录重建：删掉白名单之外的残留文件。
 *
 * 边界
 * - 只读 `docs/`、只写 `public-docs/`；不碰 git。
 *
 * 相关文件
 * - 依赖：scripts/docs-config.mjs。
 * - 校验：scripts/docs-check.mjs。
 *
 * 改哪里
 * - 公开哪几份、怎么脱敏：scripts/docs-config.mjs。
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DOCS_DIR, OUT_DIR, PUBLIC_FILES, render } from './docs-config.mjs'

async function main() {
  if (!existsSync(DOCS_DIR)) {
    console.error('docs-public: docs/ 不存在，生成不了。')
    process.exitCode = 1
    return
  }
  const present = new Set((await readdir(DOCS_DIR)).filter(name => name.endsWith('.md')))
  const missing = PUBLIC_FILES.filter(name => !present.has(name))
  if (missing.length > 0) {
    console.error(`docs-public: 白名单里的文件不存在：${missing.join('、')}`)
    process.exitCode = 1
    return
  }
  await rm(OUT_DIR, { recursive: true, force: true })
  await mkdir(OUT_DIR, { recursive: true })
  for (const name of PUBLIC_FILES) {
    const source = await readFile(join(DOCS_DIR, name), 'utf8')
    await writeFile(join(OUT_DIR, name), render(name, source), 'utf8')
    console.log(`docs-public: ${name}`)
  }
}

await main()
