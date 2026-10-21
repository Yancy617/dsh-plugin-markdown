/**
 * “空段落”的唯一定义：没有子节点的段落。
 *
 * 内容
 * - $isEmptyParagraph(node)：这个节点是不是一个空段落。
 *
 * 行为
 * - 结构判据，不看文字：段落里放着一张 alt 为空的图片时，文字也是空的，但它有子节点，
 *   所以不是空段落。
 * - 编辑器用它当“这里的写位置”（文末空段落）；保存用它当“块间空白”，两者是同一条规则。
 *
 * 边界
 * - 不判断块与块之间的空行（那由 blockSave.ts 按原文间隔处理）。
 *
 * 相关文件
 * - 被依赖：blockSave.ts（拼装与剪裁）、documentMarkdown.ts（整篇标准写）、
 *   clipboardMarkdown.ts（复制时过滤空行）、trailingParagraph.ts（文末不变量）。
 *
 * 改哪里
 * - 改判据：$isEmptyParagraph。
 */
import { $isParagraphNode, type LexicalNode, type ParagraphNode } from 'lexical'

/**
 * @param node - 任意节点。
 * @returns 它是不是一个没有子节点的段落。
 */
export function $isEmptyParagraph(node: LexicalNode | null | undefined): node is ParagraphNode {
  return $isParagraphNode(node) && node.getChildrenSize() === 0
}
