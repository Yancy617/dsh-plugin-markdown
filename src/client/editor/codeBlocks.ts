/**
 * 文档里的代码块：节点键、围栏语言、源文本，以及横幅上那个名字。
 *
 * 内容
 * - CodeBlockInfo / collectCodeBlocks / codeBlockLabel。
 *
 * 行为
 * - 在 editor state 的读作用域里走整棵树（任意深度），只认 CodeNode。
 * - 语言取 `getLanguage() || undefined`：没写围栏信息就是 undefined。
 * - 名字：写了语言就写语言；没写就是「代码块」——官方 zh 字典里 `codeBlock.title` 的值，
 *   也是官方 `CodeToolbar` 在没有语法时的回退。
 *
 * 边界
 * - 不读也不写 DOM，不画任何东西。
 *
 * 相关文件
 * - 被依赖：codeHighlight.tsx（高亮）、codeChrome.tsx（横幅与复制按钮）。
 *
 * 改哪里
 * - 清单的形状：CodeBlockInfo。
 * - 名字的规则：codeBlockLabel。
 */
import { $isCodeNode } from '@lexical/code-core'
import { $isElementNode, type LexicalNode } from 'lexical'

/** One code block found in the editor state. */
export interface CodeBlockInfo {
  /** The node's key, which is also how its DOM element is looked up. */
  readonly key: string
  /** The fence info string, or `undefined` for a block that has none. */
  readonly language: string | undefined
  /** The block's source text. */
  readonly code: string
}

/**
 * Every code block in the document, at any depth.
 * @param node - the subtree to walk.
 * @param found - accumulator.
 */
export function collectCodeBlocks(node: LexicalNode, found: CodeBlockInfo[]): void {
  if ($isCodeNode(node)) {
    found.push({
      code: node.getTextContent(),
      key: node.getKey(),
      language: node.getLanguage() || undefined,
    })
    return
  }
  if ($isElementNode(node)) {
    for (const child of node.getChildren()) collectCodeBlocks(child, found)
  }
}

/**
 * The name a code block's banner carries.
 * @param language - the fence info string, when the block has one.
 * @returns the language, or the official dictionary's fallback label.
 */
export function codeBlockLabel(language: string | undefined): string {
  return language ?? '代码块'
}
