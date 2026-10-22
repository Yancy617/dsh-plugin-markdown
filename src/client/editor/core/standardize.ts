/**
 * 标准写出的最后一道块级校验：写手写出的文本必须能读回同一棵树。
 *
 * 内容
 * - sameTree(left, right)：mdast 形状比较（忽略 position / label / 写法差异）。
 * - standardizeContent(lifted, options)：写 → 读 → 同构；不同构返回 null。
 *
 * 行为
 * - 只比较语义：链接 / 图片的 label 不看；引用式写法不算差异；null 字段与缺失等价。
 * - 写手抛错、解析抛错、读回不同构 ⇒ null；调用方退回纯文本，不把语法错误抛给用户。
 * - 不 import Lexical / React；只依赖 mdast 类型、parseBody 与写手。
 *
 * 边界
 * - 只校验一个块；整篇顺序 / 边界由 blockSave 负责。
 * - 不判断块有没有改（调用方的事）。
 *
 * 相关文件
 * - 被依赖：projection.ts（导入时判 rich/source）、blockSave.ts（保存时兜底）。
 * - 依赖：mdastParse.ts、mdastLift.ts。
 *
 * 改哪里
 * - 改比较口径：comparable / sameTree。
 * - 改块级 gate：standardizeContent。
 */
import type { Content, RootContent } from 'mdast'
import { parseBody } from './mdastParse'
import { serializeBlock, type BlockWriteOptions } from './serialize'

/**
 * 去掉位置、label 这类“写法”字段后的形状。
 * @param value - mdast 节点或数组。
 * @returns 可比较的形状。
 */
function comparable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(item => comparable(item))
  if (typeof value !== 'object' || value === null) return value
  const record = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(record)) {
    if (key === 'position' || key === 'label') continue
    if (child === null || child === undefined) continue
    out[key] = comparable(child)
  }
  if (Array.isArray(out.children)) {
    const merged: unknown[] = []
    for (const child of out.children) {
      const previous = merged[merged.length - 1]
      const childRecord = child as Record<string, unknown> | null
      const previousRecord = previous as Record<string, unknown> | null
      if (
        childRecord !== null &&
        previousRecord !== null &&
        childRecord?.type === 'text' &&
        previousRecord?.type === 'text' &&
        typeof childRecord.value === 'string' &&
        typeof previousRecord.value === 'string'
      ) {
        previousRecord.value = `${previousRecord.value}${childRecord.value}`
      } else {
        merged.push(child)
      }
    }
    out.children = merged
  }
  return out
}

/**
 * 键名排序后的形状；JSON.stringify 的顺序因此稳定。
 * @param value - comparable 的结果。
 * @returns 稳定形状。
 */
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(item => stable(item))
  if (typeof value !== 'object' || value === null) return value
  const record = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(record).sort()) out[key] = stable(record[key])
  return out
}

/**
 * 两棵 mdast 子树是否同构。
 * @param left - 左树。
 * @param right - 右树。
 * @returns 是否同构。
 */
export function sameTree(left: Content | RootContent, right: Content | RootContent): boolean {
  return JSON.stringify(stable(comparable(left))) === JSON.stringify(stable(comparable(right)))
}

/**
 * 写一块，并把写出来的文本读回来和 lift 树比较。
 * @param lifted - 由 Lexical lift 出来的 mdast 块。
 * @param options - 相邻列表的标记覆盖。
 * @returns 标准文本；不同构 / 抛错时 null。
 */
export function standardizeContent(lifted: Content, options?: BlockWriteOptions): string | null {
  try {
    const written = serializeBlock(lifted, options)
    const reparsed = parseBody(written).children[0]
    if (reparsed === undefined) return null
    return sameTree(lifted, reparsed) ? written : null
  } catch {
    return null
  }
}
