/**
 * 公开文档的守门：产物是否齐全、是否被手改、有没有夹带不该公开的东西。
 *
 * 内容
 * - check 与 main。
 *
 * 行为
 * - `public-docs/` 里的每个 `.md` 都必须是白名单成员，白名单成员也一个不能少。
 * - 每个产物第一行必须是"自动生成"头注——手改过的产物在这里就会露馅。
 * - 逐个文件扫 SANITIZE 对应的敏感样式（盘符路径、邮箱、凭据、Bearer 令牌），命中就报行号。
 * - 不允许留下指向 `docs/`（内部、不公开）的相对链接。
 *
 * 边界
 * - 只读 `public-docs/`；不需要 `docs/` 在场，所以 CI 上也能跑。
 *
 * 相关文件
 * - 依赖：scripts/docs-config.mjs。
 * - 被依赖：package.json 的 `docs:check`（`pnpm test` 末尾）、GitHub Actions。
 *
 * 改哪里
 * - 敏感样式：scripts/docs-config.mjs 的 FORBIDDEN。
 */
import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { FORBIDDEN, OUT_DIR, PUBLIC_FILES } from './docs-config.mjs'

const HEADER = '<!-- 自动生成'

/**
 * @returns {Promise<number>} 失败项数。
 */
async function check() {
  if (!existsSync(OUT_DIR)) {
    console.error('docs-check: public-docs/ 不存在。跑 pnpm docs:public 生成。')
    return 1
  }
  const files = (await readdir(OUT_DIR)).filter(name => name.endsWith('.md')).sort()
  let failures = 0
  const expected = new Set(PUBLIC_FILES)
  for (const name of files) {
    if (!expected.has(name)) {
      console.error(`docs-check: public-docs/${name} 不在白名单里。`)
      failures += 1
    }
  }
  for (const name of PUBLIC_FILES) {
    if (!files.includes(name)) {
      console.error(`docs-check: public-docs/${name} 缺失。`)
      failures += 1
    }
  }

  for (const name of files) {
    const text = await readFile(join(OUT_DIR, name), 'utf8')
    const lines = text.split('\n')
    if (!text.startsWith(HEADER)) {
      console.error(`docs-check: public-docs/${name} 没有"自动生成"头注——被手改过？`)
      failures += 1
    }
    lines.forEach((line, index) => {
      for (const { label, pattern } of FORBIDDEN) {
        if (pattern.test(line)) {
          console.error(`docs-check: public-docs/${name}:${String(index + 1)} 出现${label}：${line.trim().slice(0, 80)}`)
          failures += 1
        }
      }
      if (/\]\((?:\.\.\/)?docs\//.test(line)) {
        console.error(`docs-check: public-docs/${name}:${String(index + 1)} 链接指向不公开的 docs/`)
        failures += 1
      }
    })
  }

  if (failures === 0) console.log(`docs-check: ${String(files.length)} 份公开文档，没问题。`)
  return failures
}

process.exitCode = (await check()) === 0 ? 0 : 1
