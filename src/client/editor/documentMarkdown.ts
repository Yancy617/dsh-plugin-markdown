/**
 * 文档 Markdown 的三扇门：打开、复制、粘贴。
 *
 * 内容
 * - importDocumentMarkdown(body)：正文 ⇒ 根节点，并返回块级保存基线。
 * - serializeDocumentMarkdown(root?)：根节点 ⇒ 标准 GFM（整篇；用于复制 / HTML 对照，不用于保存）。
 * - $pastedMarkdownNodes(text)：粘贴文本 ⇒ 节点数组。
 *
 * 行为
 * - 打开：parseBody（mdast，原始正文，不做编码）→ lowerDocument → 落根 →
 *   $ensureTrailingParagraph；基线交给 blockSave.ts 的 $captureBase（与兜底捕获同一份实现）。
 * - 保存：由 blockSave.ts 的 $saveBody 负责（未改块切片、改过块标准写），本文件不参与。
 * - 粘贴：parseBody + lowerDocument，节点交给选区，不落根。
 * - 三个入口只管正文；frontmatter 由调用方切分 / 拼回。
 *
 * 边界
 * - 不负责块级保存策略（blockSave.ts）、不负责语法解析（mdastParse.ts）。
 * - 不保留源拼写；未改的块由保存基线从原文切片。
 *
 * 相关文件
 * - 依赖：mdastParse.ts、mdastLower.ts、mdastLift.ts、blockSave.ts（基线捕获）、
 *   emptyParagraph.ts、trailingParagraph.ts。
 * - 被依赖：MarkdownEditor.tsx、PasteMarkdownPlugin.tsx、htmlMarkdown.ts、scripts/probe-block.ts。
 *
 * 改哪里
 * - 改打开：importDocumentMarkdown。
 * - 改整篇标准写：serializeDocumentMarkdown。
 * - 改粘贴：$pastedMarkdownNodes。
 */
import { $getRoot, type ElementNode, type LexicalNode } from 'lexical'
import { $isListNode } from '@lexical/list'
import { $ensureTrailingParagraph } from './trailingParagraph'
import { $isEmptyParagraph } from './emptyParagraph'
import { lowerDocument } from './mdastLower'
import { projectDocumentNodes } from './projection'
import { listWriteOptions, serializeLexicalBlock } from './mdastLift'
import { parseBody } from './mdastParse'
import { $captureBase } from './blockSave'
import { $createBlockBreakNode, $isBlockBreakNode } from './blockBreak'
import type { BaseBlock } from './saveBase'

/**
 * 在会被 Lexical 合并的相邻块之间插入内部的分隔节点。
 *
 * 只处理相邻的两张列表：`@lexical/list` 的 `$transform` 会把它们并成一张。分隔节点
 * 不写文件、不进剪贴板、不参与基线；它只是让编辑器树保留“两张列表”这个事实。
 * @param nodes - 一行顶层节点。
 * @returns 带分隔节点的节点序列。
 */
function stabilizeBlockSequence(nodes: readonly LexicalNode[]): LexicalNode[] {
  const out: LexicalNode[] = []
  for (const node of nodes) {
    const previous = out[out.length - 1]
    if (previous !== undefined && $isListNode(previous) && $isListNode(node)) {
      out.push($createBlockBreakNode())
    }
    out.push(node)
  }
  return out
}

/**
 * 把一份正文读进编辑器的根节点，并返回块级保存基线。
 *
 * 必须在 Lexical 的编辑器上下文里调用。
 * @param body - 文档正文，frontmatter 已经切掉。
 * @returns 每个顶层内容块的原文 span 与标准写法。
 */
export function importDocumentMarkdown(body: string): BaseBlock[] {
  const root = $getRoot()
  root.clear()
  const parsed = parseBody(body)
  const projected = projectDocumentNodes(parsed, lowerDocument(parsed, body), body)
  const nodes = stabilizeBlockSequence(projected)
  for (const node of nodes) root.append(node)
  const base = $captureBase(body, parsed)
  // 文末可写位置不属于文件内容，基线里不收它。
  $ensureTrailingParagraph(root)
  return base
}

/**
 * 一段粘贴进来的 Markdown 文本读成节点。
 *
 * 与打开共用同一条 mdast → Lexical 映射；节点交给选区，不落根。
 * @param text - 剪贴板里的 Markdown（换行已归一）。
 * @returns 可以交给 $insertGeneratedNodes 的顶层节点。
 */
export function $pastedMarkdownNodes(text: string): LexicalNode[] {
  const parsed = parseBody(text)
  const projected = projectDocumentNodes(parsed, lowerDocument(parsed, text), text)
  return stabilizeBlockSequence(projected)
}

/**
 * 把编辑器的树写成标准 GFM。
 *
 * 这是“整篇标准写”，只用于复制 / HTML 对照 / 仪器；保存走 blockSave.ts 的块级规则。
 * @param root - 要导出的节点；省略就是整篇文档。
 * @returns 标准 Markdown，不含 frontmatter。
 */
export function serializeDocumentMarkdown(root?: ElementNode): string {
  const container = root ?? $getRoot()
  const blocks: string[] = []
  let previousListType: string | null = null
  for (const child of container.getChildren()) {
    if ($isEmptyParagraph(child) || $isBlockBreakNode(child)) continue
    blocks.push(serializeLexicalBlock(child, listWriteOptions(previousListType, child)))
    previousListType = $isListNode(child) ? child.getListType() : null
  }
  return blocks.join('\n\n')
}
