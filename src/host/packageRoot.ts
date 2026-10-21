/**
 * 本包的安装根目录。
 *
 * 内容
 * - packageRoot。
 *
 * 行为
 * - 由 import.meta.url 上溯一级；首次计算后缓存。
 * - 成立前提：Host 从包内加载（dsh.bundle.patch 保证）。
 *
 * 边界
 * - 不判断目录是否存在。
 *
 * 相关文件
 * - 被依赖：host/templates.ts、host/updateCheck.ts。
 *
 * 改哪里
 * - 改推导：packageRoot。
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The answer, once computed. */
let cached: string | undefined

/**
 * @returns absolute path of the installed package root.
 */
export function packageRoot(): string {
  cached ??= join(dirname(fileURLToPath(import.meta.url)), '..')
  return cached
}
