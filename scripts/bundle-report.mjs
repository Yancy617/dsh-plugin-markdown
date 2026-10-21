/**
 * 按源码拆分 client bundle 的体积。
 *
 * 内容
 * - 扫描 //#region … //#endregion；聚合每段字节；打印包内模块与内联依赖占比。
 *
 * 行为
 * - 默认读 lib/client.js；第一个参数可换路径。
 * - 只读，不构建。
 *
 * 边界
 * - 依赖构建产物保留 region 注释。
 *
 * 相关文件
 * - 读 tsdown 产物 lib/client.js。
 *
 * 改哪里
 * - 改扫描：region 正则。
 */
import { readFileSync } from 'node:fs'

const path = process.argv[2] ?? 'lib/client.js'
const source = readFileSync(path, 'utf8')
const total = Buffer.byteLength(source, 'utf8')

const own = new Map()
const region = /\/\/#region ([^\n]+)\n([\s\S]*?)\/\/#endregion/g
let covered = 0
for (const match of source.matchAll(region)) {
  const name = (match[1] ?? '').trim()
  const bytes = Buffer.byteLength(match[2] ?? '', 'utf8')
  own.set(name, (own.get(name) ?? 0) + bytes)
  covered += bytes
}

/** @param {number} bytes - byte count. */
const kb = bytes => `${(bytes / 1024).toFixed(1)} KB`

console.log(`bundle: ${path}`)
console.log(`total:  ${kb(total)}`)
console.log('')

console.log('this package:')
for (const [name, bytes] of [...own.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${kb(bytes).padStart(9)}  ${name}`)
}
console.log(`  ${kb(covered).padStart(9)}  (sum)`)
console.log('')

const dependency = total - covered
console.log(`inlined dependencies: ${kb(dependency)}  (${((dependency / total) * 100).toFixed(1)}%)`)
