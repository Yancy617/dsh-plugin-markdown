/**
 * 检查仓库一个目录的列表里有没有重名。
 *
 * 内容
 * - 调 GET /markdown-vault/list；打印条目数、类型计数、唯一名数、重复名与前 12 条样本。
 *
 * 行为
 * - 需要 Host 已在 baseUrl 上运行；默认 http://127.0.0.1:19387。
 * - 非 200 打印状态并 exit 1；缺目录参数 exit 2。
 *
 * 边界
 * - 只读；不判断渲染层是否重复。
 *
 * 相关文件
 * - 调用 src/index.ts 的 list 路由。
 *
 * 改哪里
 * - 改 URL：origin / list。
 */
const directory = process.argv[2]
const origin = process.argv[3] ?? 'http://127.0.0.1:19387'

if (directory === undefined) {
  console.error('usage: node scripts/inspect-listing.mjs <absoluteDir> [baseUrl]')
  process.exit(2)
}

const response = await fetch(
  `${origin}/markdown-vault/list?path=${encodeURIComponent(directory)}`,
  { cache: 'no-store' },
)
const body = await response.json()

if (response.status !== 200) {
  console.log(`status ${response.status}: ${JSON.stringify(body)}`)
  process.exit(1)
}

const entries = body.entries ?? []
const byName = new Map()
for (const entry of entries) {
  byName.set(entry.name, (byName.get(entry.name) ?? 0) + 1)
}
const duplicates = [...byName.entries()].filter(([, count]) => count > 1)

const kinds = entries.reduce((acc, entry) => {
  acc[entry.type] = (acc[entry.type] ?? 0) + 1
  return acc
}, {})

console.log(`listed:   ${body.path}`)
console.log(`entries:  ${entries.length}`)
console.log(`by type:  ${JSON.stringify(kinds)}`)
console.log(`unique:   ${byName.size}`)
console.log(`duplicates: ${duplicates.length === 0 ? 'none' : JSON.stringify(duplicates)}`)
console.log(
  `sample:   ${entries.slice(0, 12).map(e => `${e.type[0]}:${e.name}`).join('  ')}`,
)
