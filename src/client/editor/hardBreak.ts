/**
 * 软换行与硬换行：同一个 LineBreakNode，用一条节点状态区分语义。
 *
 * 内容
 * - hardBreakState：`true` = 源里是硬换行（`\\` 或两个尾空格），`false` / 缺省 = 软换行。
 *
 * 行为
 * - 显示完全一样（都是一次换行）；区别只在写出：硬换行写 `break`，软换行写 `text["\n"]`。
 * - 状态是语义（换行的种类），不是源里的拼写：两种硬换行拼法都归到 `true`。
 *
 * 边界
 * - 不负责渲染（lexical 的 LineBreakNode 自己渲染）。
 * - 不负责从 Markdown 里认硬换行（mdast 已经给出 `break` 节点）。
 *
 * 相关文件
 * - 被依赖：mdastLower.ts（设置）、mdastLift.ts（读取）。
 *
 * 改哪里
 * - 改判据：hardBreakState。
 */
import { $getState, createState, type LineBreakNode } from 'lexical'

/** `true` = 硬换行；缺省是软换行。 */
export const hardBreakState = createState('mdHardBreak', {
  parse: (value: unknown): boolean => value === true,
})

/**
 * @param node - 一个换行节点。
 * @returns 它是不是硬换行。
 */
export function isHardBreak(node: LineBreakNode): boolean {
  return $getState(node, hardBreakState) === true
}
