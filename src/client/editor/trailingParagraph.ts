/**
 * 文末那个可写的空段落。
 *
 * 内容
 * - $ensureTrailingParagraph(root)：保证根的最后一个孩子是空段落。
 *
 * 行为
 * - 空根补一个空段落；末尾已是空段落就不动；否则在末尾补一个。
 * - 空段落是编辑器的写位置，不是文件内容；保存由 blockSave.ts 排除它。
 *
 * 边界
 * - 不判断“空文档写多少字节”（保存侧的事）。
 * - 不负责空行（那是块间间隔）。
 *
 * 相关文件
 * - 被依赖：MarkdownEditor.tsx、documentMarkdown.ts。
 * - 依赖：emptyParagraph.ts（“空段落”的唯一定义）。
 *
 * 改哪里
 * - 改不变量：$ensureTrailingParagraph。
 */
import { $createParagraphNode, type ElementNode } from 'lexical'
import { $isEmptyParagraph } from './emptyParagraph'

/**
 * 保证根节点的最后一个孩子是空段落。
 * @param root - 编辑器根。
 */
export function $ensureTrailingParagraph(root: ElementNode): void {
  if (root.getChildrenSize() === 0) {
    root.append($createParagraphNode())
    return
  }
  if ($isEmptyParagraph(root.getLastChild())) return
  root.append($createParagraphNode())
}
