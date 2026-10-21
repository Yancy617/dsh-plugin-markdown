/**
 * 块之后那一个可写的位置：在当前块之后另起一段（Mod+Enter）。
 *
 * 内容
 * - $ensureParagraphAfter / registerParagraphAfter。
 *
 * 行为
 * - 走到光标所在的顶层块，在它后面插一个空段落。
 * - 后面已经有一个空段落就用它，不再造第二个。
 * - Mod+Enter 精确匹配；注册在 KEY_ENTER_COMMAND、HIGH，自己 preventDefault。
 * - SlashMenu 插块之后也调 $ensureParagraphAfter。
 *
 * 边界
 * - 不负责“文末始终有一个空段落”的不变量（trailingParagraph.ts）。
 * - 不抢容器内部的回车（列表 / 引用）。
 * - 不负责“哪个是顶层块”（tree.ts 的 $topLevelBlockOf）。
 *
 * 相关文件
 * - 被依赖：MarkdownEditor.tsx、SlashMenu.tsx。
 * - 依赖：tree.ts（定位）、emptyParagraph.ts（“空段落”的唯一定义）。
 *
 * 改哪里
 * - 改插入：$ensureParagraphAfter。
 * - 改键位：registerParagraphAfter。
 */
import {
  $createParagraphNode,
  $getSelection,
  $isRangeSelection,
  COMMAND_PRIORITY_HIGH,
  KEY_ENTER_COMMAND,
  type LexicalEditor,
  type LexicalNode,
  type ParagraphNode,
} from 'lexical'
import { $isEmptyParagraph } from './emptyParagraph'
import { $topLevelBlockOf } from './tree'

/**
 * 让一个块**后面**有一个可写的空段落，并把光标放进去。
 *
 * **已经有一个空段落跟着它时就用那一个**，不再造第二个：这条命令要的是"在它后面写字"，
 * 而"下一个块就是一个空段落"在文末是常态（`./trailingParagraph.ts` 的 `$ensureTrailingParagraph`
 * 保证末孩子始终是空段落）—— 再插一个只会在用户眼前多出一行他没写过的空行。
 * 判据里的"空"与导出口径同一条：**无子节点**（`BLANK_EXPORT` 认的就是这一种），
 * 不把"只装着空白字符的段落"算进来。
 *
 * 这是"留一个可写的位置"这件事的**唯一一份**：`Mod+Enter` 用它，`./SlashMenu.tsx` 的
 * `replaceBlock`（插入表格 / 分割线 / 图片之后）也用它 —— 那块注释里"neither a thematic break nor
 * a table accepts typing on its own"说的就是这条规则。必须在 Lexical 的编辑器上下文里调用。
 * @param block - 可写的位置在它后面。
 * @returns 光标所在的那个段落（用掉的或新建的）。
 */
export function $ensureParagraphAfter(block: LexicalNode): ParagraphNode {
  const next = block.getNextSibling()
  if ($isEmptyParagraph(next)) {
    next.select()
    return next
  }
  const paragraph = $createParagraphNode()
  block.insertAfter(paragraph)
  paragraph.select()
  return paragraph
}

/**
 * 挂上 `Mod+Enter`：在当前顶层块之后另起一段。
 * @param editor - 编辑器实例。
 * @returns 注销函数（React 那边由 `useEffect` 收）。
 */
export function registerParagraphAfter(editor: LexicalEditor): () => void {
  return editor.registerCommand(
    KEY_ENTER_COMMAND,
    event => {
      // 键位判据：正好 `Mod`，多一个修饰键就不算（`../shortcuts.ts` 的 `matches` 同一条口径）。
      if (event === null || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) {
        return false
      }
      const selection = $getSelection()
      if (!$isRangeSelection(selection)) return false
      const top = $topLevelBlockOf(selection.anchor.getNode())
      if (top === null) return false
      // 事件由处理者自己挡（`ListIndentPlugin` 同一个理由）：挡了浏览器才会把这一下当成我们的。
      event.preventDefault()
      $ensureParagraphAfter(top)
      return true
    },
    COMMAND_PRIORITY_HIGH,
  )
}
