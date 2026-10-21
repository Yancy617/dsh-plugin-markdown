/**
 * 空链接不可存在：链接的内容被删光时，把那个空壳一起删掉。
 *
 * 内容
 * - registerEmptyLinkCleanup(editor)。
 *
 * 行为
 * - `LinkNode` 的孩子数归零就 `remove()`；transform 在每次更新的收尾处跑。
 * - 两种"删空"都要收：删文字（Lexical 自己也会收）与删**里面的装饰节点**（图片徽章这种，
 *   Lexical 不会收 —— 见决策记录 §6.218）。
 *
 * 边界
 * - 不删内容、不改选区：删什么是 Lexical 的事，这条只负责空壳。
 *
 * 相关文件
 * - 依赖：@lexical/link、lexical。
 * - 被依赖：MarkdownEditor.tsx（EmptyLinkPlugin）。
 *
 * 改哪里
 * - 改判据：registerEmptyLinkCleanup。
 */
import { LinkNode } from '@lexical/link'
import type { LexicalEditor } from 'lexical'

/**
 * 让"内容已经删光的链接"连壳一起消失。
 *
 * 空链接在屏幕上只剩 `::before` 画的那个地球（没有文字、没有图片），光标进不去、退格只会
 * 吃掉旁边的字、拖选又选不中它 —— 所以它不能留在树里。
 * @param editor - 要保护的编辑器。
 * @returns 撤销登记的函数。
 */
export function registerEmptyLinkCleanup(editor: LexicalEditor): () => void {
  return editor.registerNodeTransform(LinkNode, node => {
    if (node.getChildrenSize() === 0) node.remove()
  })
}
