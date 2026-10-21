/**
 * 把一段 `text/html` 按**本编辑器**的读法转成 Markdown。
 *
 * 内容
 * - $htmlFlavorAsMarkdown(html)：HTML 字符串 ⇒ 标准 GFM；建不出节点时是空串。
 *
 * 行为
 * - 先按编辑器注册的节点把 DOM 读成节点，再把它们收成“块”（裸着的行内节点包进段落），
 *   最后走 `documentMarkdown.ts` 的整篇标准写。
 * - 必须在 Lexical 的编辑器上下文里调用（`$generateNodesFromDOM` 要问编辑器注册了哪些节点）。
 *   环境里没有 `DOMParser` 时会抛，调用方按“让给内置处理”处理。
 *
 * 边界
 * - 不判断“这次粘贴该用 HTML 还是纯文本”（那是 pasteFlavor.ts 的判据）。
 * - 不读剪贴板、不插入节点。
 *
 * 相关文件
 * - 被依赖：clipboardMarkdown.ts（部分选择的读法）、PasteMarkdownPlugin.tsx（两种形态比较）。
 * - 依赖：documentMarkdown.ts（整篇标准写）、@lexical/html。
 *
 * 改哪里
 * - 改 HTML 读法：$htmlFlavorAsMarkdown / $asBlocks。
 */
import {
  $createParagraphNode,
  $getEditor,
  $isElementNode,
  ArtificialNode__DO_NOT_USE,
  type ElementNode,
  type LexicalNode,
  type ParagraphNode,
} from 'lexical'
import { $generateNodesFromDOM } from '@lexical/html'
import { serializeDocumentMarkdown } from './documentMarkdown'

/**
 * `text/html` 这一形态按本编辑器的读法是什么样。
 * @param html - 剪贴板的 `text/html`。
 * @returns 它读成的 Markdown；读成空（没有可建的节点）时是空串。
 */
export function $htmlFlavorAsMarkdown(html: string): string {
  const dom = new DOMParser().parseFromString(html, 'text/html')
  return serializeDocumentMarkdown($asBlocks($generateNodesFromDOM($getEditor(), dom)))
}

/**
 * 把 HTML 读出来的节点收成“块”：裸着的行内节点包进段落。
 *
 * **不这么做判据就反了。** `<span>- a</span>` 读出来是一个裸的 text 节点，而内置那条路把它插进
 * 当前段落、意思就是“这些字符”；导出器只认块，一个裸的文本节点导出是空串 —— 判据于是认为两边
 * “不一样”，把票投给 HTML，用户报的现象原样留下。
 * @param nodes - `$generateNodesFromDOM` 给出的节点。
 * @returns 装着这些节点的块容器；导出只读它的子节点。
 */
function $asBlocks(nodes: readonly LexicalNode[]): ElementNode {
  // `ArtificialNode__DO_NOT_USE` 是 `lexical` 公开导出的那个“只为装子节点而存在”的元素节点，
  // 这里要的正是它：一个不往导出里加任何字面量的临时容器。
  const container = new ArtificialNode__DO_NOT_USE()
  let paragraph: ParagraphNode | null = null
  for (const node of nodes) {
    if ($isElementNode(node)) {
      paragraph = null
      container.append(node)
      continue
    }
    if (paragraph === null) {
      paragraph = $createParagraphNode()
      container.append(paragraph)
    }
    paragraph.append(node)
  }
  return container
}
