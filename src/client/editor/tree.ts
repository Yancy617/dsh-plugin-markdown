/**
 * 编辑器树上的通用定位：一个节点属于哪个**顶层块**。
 *
 * 内容
 * - $topLevelBlockOf(start)：包住某个节点的顶层块（根节点的孩子）。
 *
 * 行为
 * - 一路往上走，走到“父亲是根节点”的那个节点就是它。
 * - 走到根上还没找到（节点已经脱离文档）答 `null`，调用方什么也不做——不许凭空造段落。
 * - 必须在 Lexical 的编辑器上下文里调用。
 *
 * 边界
 * - 不负责插入、选中、保存；只是树上的一个位置问题。
 *
 * 相关文件
 * - 被依赖：paragraphAfter.ts、clipboardMarkdown.ts。
 *
 * 改哪里
 * - 改定位：$topLevelBlockOf。
 */
import { $isRootNode, type ElementNode, type LexicalNode } from 'lexical'

/**
 * 包住某个节点的**顶层块**（根节点的孩子）。
 * @param start - 从哪个节点往上走。
 * @returns 顶层块，或 `null`。
 */
export function $topLevelBlockOf(start: LexicalNode): ElementNode | null {
  let current: LexicalNode | null = start
  while (current !== null) {
    const parent: LexicalNode | null = current.getParent()
    if (parent === null) return null
    if ($isRootNode(parent)) return current as ElementNode
    current = parent
  }
  return null
}
