/**
 * 开发期检查：确认构建后的 client bundle 带着当前源码的标记。
 *
 * 内容
 * - 读 lib/client.js；打印大小、mtime 与每个 marker 是否出现。
 *
 * 行为
 * - 无 marker 参数时打印用法并 exit 2。
 * - 只读，不重建。
 *
 * 边界
 * - 不判断源码语义，只做字符串包含。
 *
 * 相关文件
 * - 读 lib/client.js（pnpm build 的产物）。
 *
 * 改哪里
 * - 改检查：命令行与 source.includes。
 */
import { readFileSync, statSync } from 'node:fs'

const markers = process.argv.slice(2)
if (markers.length === 0) {
  console.error('usage: node scripts/check-bundle.mjs <marker> [<marker>...]')
  process.exit(2)
}

const path = 'lib/client.js'
const source = readFileSync(path, 'utf8')
const stats = statSync(path)

console.log(`artifact: ${path}`)
console.log(`bytes:    ${stats.size}`)
console.log(`mtime:    ${stats.mtime.toISOString()}`)
for (const marker of markers) {
  console.log(`contains ${JSON.stringify(marker)}: ${source.includes(marker)}`)
}
