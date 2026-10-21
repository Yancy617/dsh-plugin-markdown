/**
 * 文档目录的另一半：从**编辑器树**读标题（富文本）。
 *
 * 内容
 * - $headings、$headingEntryOf、headingEntries、headingKeys。
 *
 * 行为
 * - 深度优先、文档顺序；引用 / 列表项里的标题是它们容器的子节点，一起收。
 * - 层级取 `HeadingNode` 的 tag（h1–h6），文字取节点文字（不含标记），换行压成空格。
 * - 与 `./outline.ts` 的文本派生给同一份文档时，应得同一串标题；两边的对照钉在 `probe:units`。
 *
 * 边界
 * - `$headings` 必须在编辑器的读 / 改上下文里调用（Lexical 的 `$` 约定）。
 * - 不渲染、不测量位置（滚动联动在 `../workbench/useActiveHeading.ts`）。
 *
 * 相关文件
 * - 依赖：lexical、@lexical/rich-text、`./outline.ts` 的 OutlineEntry。
 * - 被依赖：MarkdownWorkbench.tsx（文档目录、点击滚动）、useActiveHeading.ts（高亮）。
 *
 * 改哪里
 * - 改"哪些节点算标题"：$headings。
 * - 改条目形状：$headingEntryOf。
 */
import { $getRoot, $isElementNode, type LexicalEditor, type LexicalNode } from 'lexical'
import { $isHeadingNode } from '@lexical/rich-text'
import type { OutlineEntry } from './outline'

/**
 * 按文档顺序列出标题节点。必须在读 / 改上下文里调用。
 * @returns 标题节点，文档顺序。
 */
export function $headings(): LexicalNode[] {
  const found: LexicalNode[] = []
  const visit = (node: LexicalNode): void => {
    if ($isHeadingNode(node)) {
      found.push(node)
      // 标题的子节点是行内内容，里面不可能再有标题。
      return
    }
    if ($isElementNode(node)) for (const child of node.getChildren()) visit(child)
  }
  for (const child of $getRoot().getChildren()) visit(child)
  return found
}

/**
 * 一个标题节点 ⇒ 文档目录的一条。必须在读上下文里调用。
 * @param node - 标题节点。
 * @returns 层级与文字。
 */
export function $headingEntryOf(node: LexicalNode): OutlineEntry {
  const tag = $isHeadingNode(node) ? node.getTag() : 'h1'
  const text = node.getTextContent().replace(/\s+/g, ' ').trim()
  return { level: Number(tag.slice(1)), text }
}

/**
 * 从编辑器树读文档目录。
 * @param editor - 当前编辑器。
 * @returns 按文档顺序的标题。
 */
export function headingEntries(editor: LexicalEditor): readonly OutlineEntry[] {
  return editor.getEditorState().read(() => $headings().map($headingEntryOf))
}

/**
 * 标题节点的 key，文档顺序——点击滚动与滚动高亮都按这个序号取 DOM。
 * @param editor - 当前编辑器。
 * @returns 每个标题的节点 key。
 */
export function headingKeys(editor: LexicalEditor): readonly string[] {
  return editor.getEditorState().read(() => $headings().map(node => node.getKey()))
}
