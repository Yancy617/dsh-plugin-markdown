/**
 * 代码围栏 info 字符串里、语言之后的那一段（```` ```js title="x" ```` 里的 `title="x"`）。
 *
 * 内容
 * - codeMetaState / $codeMetaOf / $setCodeMeta。
 *
 * 行为
 * - 只是把源里的那段字节带到下一次保存；不解释它（不拆 key=value、不认识任何约定）。
 * - 语言本身不在这里：它由 Lexical 的 CodeNode 自带（getLanguage / getLanguages）。
 *
 * 边界
 * - 不解析围栏、不生成 Markdown（读写各自在 mdastLower.ts / mdastLift.ts）。
 * - 不负责高亮与横幅（codeHighlight.tsx / codeChrome.tsx）。
 *
 * 相关文件
 * - 被依赖：mdastLower.ts（设置）、mdastLift.ts（读取）。
 *
 * 改哪里
 * - 改载体：codeMetaState。
 */
import { $getState, $setState, createState, type LexicalNode } from 'lexical'

/** info 字符串里语言之后的那一段；没有就是 `null`。 */
export const codeMetaState = createState('mdCodeMeta', {
  parse: (value: unknown): string | null => (typeof value === 'string' ? value : null),
})

/**
 * @param node - 代码块节点。
 * @returns 它的 info meta，或 `null`。
 */
export function $codeMetaOf(node: LexicalNode): string | null {
  return $getState(node, codeMetaState)
}

/**
 * @param node - 代码块节点。
 * @param meta - info 字符串里语言之后的那一段。
 */
export function $setCodeMeta(node: LexicalNode, meta: string | null): void {
  $setState(node, codeMetaState, meta)
}
