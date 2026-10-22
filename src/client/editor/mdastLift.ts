/**
 * 写侧：Lexical 节点 → mdast → 标准 GFM。
 *
 * 内容
 * - liftBlock(node)：一个顶层块 ⇒ mdast 的 BlockContent。
 * - liftInline(node)：一个行内节点 ⇒ mdast 的 PhrasingContent（可能是一层格式包装）。
 * - serializeLexicalBlock(node)：一个顶层节点 ⇒ 标准 Markdown；source 块原样写。
 * - serializeSource(raw)：source 块原文。
 *
 * 行为
 * - 只表达**语义**：不再保留源里的拼写（`-` / `*`、Setext、缩进代码、实体、转义）。
 *   未改的块根本不会走到这里（blockSave 从原文切片）；走到这里的块按标准写。
 * - 文字节点的格式位折成 strong / emphasis / delete / inlineCode；不支持的格式（下划线、颜色）丢弃。
 * - 引用式链接 / 图片若在节点上带着引用式身份（`referenceForm.ts`），写回 `[...][label]` /
 *   `![...][label]`；没有身份才写成普通链接 / 图片。
 * - 定义行 / source 块原样写；定义行由 mdastLower 直接建 SourceBlockNode。
 *
 * 边界
 * - 不判断“这个块有没有变”（那由 blockSave.ts 拿本文件写出的那一串去比）与保存策略（blockSave.ts）。
 * - 不解析 Markdown（mdastParse.ts）。
 *
 * 相关文件
 * - 依赖：各节点类、sourceBlock.ts、serialize.ts。
 * - 被依赖：blockSave.ts、documentMarkdown.ts、clipboardMarkdown.ts、projection.ts。
 *
 * 改哪里
 * - 新增节点类型：liftBlock / liftInline 各加一支。
 * - 改标准写法：serialize.ts 的 SERIALIZE_OPTIONS（本文件只再导出）。
 */
import {
  $getState,
  $isElementNode,
  $isLineBreakNode,
  $isTextNode,
  IS_BOLD,
  IS_CODE,
  IS_ITALIC,
  IS_STRIKETHROUGH,
  type LexicalNode,
} from 'lexical'
import { $isHeadingNode, $isQuoteNode } from '@lexical/rich-text'
import {
  $isListItemNode,
  $isListNode,
  type ListItemNode,
  type ListNode,
} from '@lexical/list'
import { $isLinkNode, type LinkNode } from '@lexical/link'
import {
  $isTableCellNode,
  $isTableNode,
  $isTableRowNode,
  type TableCellNode,
  type TableNode,
} from '@lexical/table'
import { $isCodeNode } from '@lexical/code-core'
import { serializeBlock, serializeRoot } from './serialize'
import type { BlockWriteOptions } from './serialize'
import type {
  BlockContent,
  Code,
  Content,
  Heading,
  Image,
  ImageReference,
  InlineCode,
  Link,
  LinkReference,
  List,
  ListItem,
  Paragraph,
  PhrasingContent,
  Table,
  TableCell,
  TableRow,
  Text,
} from 'mdast'
import { $isRuleNode } from './RuleNode'
import { $isImageNode, type ImageNode } from './image'
import { $isRawBlockNode } from './rawBlocks'
import { $isRawInlineNode } from './rawInline'
import { $isSourceBlockNode } from './sourceBlock'
import { $referenceFormOf } from './referenceForm'
import { $codeMetaOf } from './codeMeta'
import { $taskListFormOf } from './taskListForm'
import { tableAlignmentsState, type Alignment } from './tableModel'
import { parseBody } from './mdastParse'
import { isHardBreak } from './hardBreak'

export { serializeBlock, serializeRoot }
export type { BlockWriteOptions }

/**
 * 相邻两张同类列表要换一个标记，否则逐块写手写 `-` + `-`，重解会并成一张。
 * @param previous - 前一个内容块的列表类型。
 * @param node - 当前节点。
 * @returns 逐块写选项；不需要时 undefined。
 */
export function listWriteOptions(
  previous: string | null,
  node: LexicalNode,
): BlockWriteOptions | undefined {
  if (!$isListNode(node)) return undefined
  const type = node.getListType()
  if (previous !== type) return undefined
  if (type === 'bullet') return { bullet: '*' }
  if (type === 'number') return { bulletOrdered: ')' }
  return undefined
}

/**
 * 一个顶层块 ⇒ mdast。
 * @param node - 顶层块。
 * @returns mdast 块；认不出时给一个只含可见文字的段落。
 */
export function liftBlock(node: LexicalNode): Content {
  if ($isSourceBlockNode(node)) return liftSource(node.getRaw())
  if ($isHeadingNode(node)) {
    const heading: Heading = {
      type: 'heading',
      depth: headingDepth(node.getTag()),
      children: liftInlineChildren(node),
    }
    return heading
  }
  if ($isQuoteNode(node)) {
    return { type: 'blockquote', children: blockChildren(node) as BlockContent[] }
  }
  if ($isListNode(node)) return liftList(node)
  if ($isCodeNode(node)) {
    const lang = node.getLanguage()
    const code: Code = {
      type: 'code',
      lang: lang === undefined || lang === '' ? null : lang,
      meta: $codeMetaOf(node),
      value: node.getTextContent(),
    }
    return code
  }
  if ($isTableNode(node)) return liftTable(node)
  if ($isRuleNode(node)) return { type: 'thematicBreak' }
  if ($isRawBlockNode(node)) return { type: 'html', value: node.getRaw() }
  if ($isImageNode(node)) {
    // 图片在顶层时也包成段落，mdast 的 image 是行内的。
    return { type: 'paragraph', children: [liftImage(node)] }
  }
  // 段落与所有认不出的元素：能读出行内就读行内，否则退回可见文字。
  return { type: 'paragraph', children: liftInlineChildren(node) }
}

/**
 * 行内节点 ⇒ mdast 行内内容（可能带格式包装）。
 * @param node - 行内节点。
 * @returns mdast 行内节点数组。
 */
export function liftInline(node: LexicalNode): PhrasingContent[] {
  // RawInlineNode 是 TextNode 的子类，必须先认它，否则会被当成普通文字。
  if ($isRawInlineNode(node)) {
    const raw = node.getRaw()
    /*
     * 只有“没被编辑过”才回放源字节（`text === raw`）。
     *
     * 用户可以在富文本里改那段行内 HTML —— 一改，`__text` 就与 `__raw` 分家（node 被切开时
     * 也会分家）。那一刻必须按文字写：拿旧字节回放会覆盖用户刚打的字，而在被切开的形状里
     * 还会把标签字节重复一遍。
     */
    if (node.getTextContent() === raw) {
      // 硬换行的两种拼法由导入侧按源切片存成载体；其余原样字节是行内 HTML。
      if (/^(?:\\| {2,})\n$/.test(raw)) return [{ type: 'break' }]
      return [{ type: 'html', value: raw }]
    }
  }
  if ($isTextNode(node)) {
    const text = node.getTextContent()
    if (text === '') return []
    const value: Text = { type: 'text', value: text }
    return wrapFormats(value, node.getFormat())
  }
  // 软换行：mdast 的 text 值里就是 `\n`，不是 `break`（`break` 只表示硬换行）。
  if ($isLineBreakNode(node)) {
    return isHardBreak(node) ? [{ type: 'break' }] : [{ type: 'text', value: '\n' }]
  }
  if ($isImageNode(node)) return [liftImage(node)]
  if ($isLinkNode(node)) return [liftLink(node)]
  // 认不出的行内：保住可见文字。
  const text = node.getTextContent()
  return text === '' ? [] : [{ type: 'text', value: text }]
}

/**
 * 把一个块的所有行内子节点摊平。
 * @param node - 容器节点。
 * @returns mdast 行内节点数组。
 */
function liftInlineChildren(node: LexicalNode): PhrasingContent[] {
  if (!$isElementNode(node)) return liftInline(node)
  return node.getChildren().flatMap(child => liftInline(child))
}

/**
 * 一个容器里的块级子节点。
 * @param node - 容器节点。
 * @returns mdast 块数组。
 */
function blockChildren(node: LexicalNode): Content[] {
  if (!$isElementNode(node)) return [liftBlock(node)]
  const blocks: Content[] = []
  for (const child of node.getChildren()) {
    if ($isSourceBlockNode(child)) blocks.push(...liftSourceBlocks(child.getRaw()))
    else blocks.push(liftBlock(child))
  }
  return blocks
}

/**
 * 标题等级。
 * @param tag - `h1`–`h6`。
 * @returns 1–6。
 */
function headingDepth(tag: string): 1 | 2 | 3 | 4 | 5 | 6 {
  const depth = Number(tag.slice(1))
  return depth >= 1 && depth <= 6 ? (depth as 1 | 2 | 3 | 4 | 5 | 6) : 1
}

/**
 * 把一个文字节点按格式位折成 Markdown 能表达的嵌套。
 * @param text - 文字节点。
 * @param format - Lexical 的格式位。
 * @returns mdast 行内节点。
 */
function wrapFormats(text: PhrasingContent, format: number): PhrasingContent[] {
  if ((format & IS_CODE) !== 0) {
    const code: InlineCode = { type: 'inlineCode', value: (text as Text).value }
    return [code]
  }
  let children: PhrasingContent[] = [text]
  if ((format & IS_STRIKETHROUGH) !== 0) children = [{ type: 'delete', children }]
  if ((format & IS_ITALIC) !== 0) children = [{ type: 'emphasis', children }]
  if ((format & IS_BOLD) !== 0) children = [{ type: 'strong', children }]
  return children
}

/**
 * 链接 ⇒ mdast link，或带引用式身份的 linkReference。
 * @param node - LinkNode。
 * @returns mdast 行内节点。
 */
function liftLink(node: LinkNode): PhrasingContent {
  const children = liftInlineChildren(node)
  const form = $referenceFormOf(node)
  if (form !== null) {
    const reference: LinkReference = {
      type: 'linkReference',
      identifier: form.identifier,
      referenceType: form.referenceType,
      children,
    }
    return reference
  }
  const link: Link = {
    type: 'link',
    url: node.getURL(),
    title: node.getTitle(),
    children,
  }
  return link
}

/**
 * 图片 ⇒ mdast image，或带引用式身份的 imageReference。
 * @param node - ImageNode。
 * @returns mdast 行内节点。
 */
function liftImage(node: ImageNode): Image | ImageReference {
  const form = $referenceFormOf(node)
  if (form !== null) {
    return {
      type: 'imageReference',
      identifier: form.identifier,
      referenceType: form.referenceType,
      alt: node.getAlt(),
    }
  }
  return {
    type: 'image',
    url: node.getSource(),
    alt: node.getAlt(),
    title: node.getTitle(),
  }
}

/**
 * 列表 ⇒ mdast list。
 * @param node - ListNode。
 * @returns mdast list。
 */
function liftList(node: ListNode): List {
  const form = $taskListFormOf(node)
  const ordered = form?.ordered ?? node.getListType() === 'number'
  const items: ListItem[] = []
  for (const child of node.getChildren()) {
    if (!$isListItemNode(child)) continue
    items.push(liftListItem(child))
  }
  return {
    type: 'list',
    ordered,
    start: ordered ? (form?.start ?? node.getStart()) : null,
    spread: false,
    children: items,
  }
}

/**
 * 列表项 ⇒ mdast listItem。
 * @param item - ListItemNode。
 * @returns mdast listItem。
 */
function liftListItem(item: ListItemNode): ListItem {
  const checked = item.getChecked()
  return {
    type: 'listItem',
    spread: false,
    checked: checked ?? null,
    children: liftItemChildren(item) as BlockContent[],
  }
}

/**
 * 列表项的内容：行内片段包成段落，嵌套列表 / 引用 / 代码 / 表格各自成块。
 * @param item - ListItemNode。
 * @returns mdast 块数组。
 */
function liftItemChildren(item: ListItemNode): Content[] {
  const blocks: Content[] = []
  let inline: PhrasingContent[] = []
  const flush = (): void => {
    if (inline.length === 0) return
    blocks.push({ type: 'paragraph', children: inline })
    inline = []
  }
  if (!$isElementNode(item)) return [{ type: 'paragraph', children: [] }]
  for (const child of item.getChildren()) {
    if ($isSourceBlockNode(child)) {
      flush()
      blocks.push(...liftSourceBlocks(child.getRaw()))
      continue
    }
    if (isBlockNode(child)) {
      flush()
      blocks.push(liftBlock(child))
    } else {
      inline.push(...liftInline(child))
    }
  }
  flush()
  if (blocks.length === 0) blocks.push({ type: 'paragraph', children: [] })
  return blocks
}

/**
 * 表格 ⇒ mdast table。
 * @param node - TableNode。
 * @returns mdast table。
 */
function liftTable(node: TableNode): Table {
  const alignments = $getState(node, tableAlignmentsState) ?? []
  const rows: TableRow[] = []
  for (const row of node.getChildren()) {
    if (!$isTableRowNode(row)) continue
    const cells: TableCell[] = []
    for (const cell of row.getChildren()) {
      if (!$isTableCellNode(cell)) continue
      cells.push({ type: 'tableCell', children: liftCell(cell) })
    }
    rows.push({ type: 'tableRow', children: cells })
  }
  const align = alignments.map((value: Alignment) =>
    value === 'none' ? null : value,
  )
  return { type: 'table', align, children: rows }
}

/**
 * 单元格内容：mdast 的单元格只收行内；多段之间用空格连起来。
 * @param cell - TableCellNode。
 * @returns mdast 行内节点。
 */
function liftCell(cell: TableCellNode): PhrasingContent[] {
  if (!$isElementNode(cell)) return []
  const parts: PhrasingContent[][] = []
  for (const child of cell.getChildren()) {
    if (child.getType() === 'paragraph') parts.push(liftInlineChildren(child))
    else if (isBlockNode(child)) {
      const text = child.getTextContent()
      if (text !== '') parts.push([{ type: 'text', value: text }])
    } else parts.push(liftInline(child))
  }
  const out: PhrasingContent[] = []
  for (const part of parts) {
    if (part.length === 0) continue
    if (out.length > 0) out.push({ type: 'text', value: ' ' })
    out.push(...part)
  }
  return out
}

/**
 * source 块的源文本 ⇒ 一组 mdast 块。
 * @param raw - 源文本。
 * @returns 块数组；空文本给一个空段落。
 */
function liftSourceBlocks(raw: string): Content[] {
  const children = parseBody(raw).children
  if (children.length > 0) return children
  return [{ type: 'paragraph', children: raw === '' ? [] : [{ type: 'text', value: raw }] }]
}

/**
 * source 块：取第一块（调用方需要全部块时用 liftSourceBlocks）。
 * @param raw - 源文本。
 * @returns mdast 块。
 */
function liftSource(raw: string): Content {
  return liftSourceBlocks(raw)[0] as Content
}

/**
 * source 块 ⇒ 标准 Markdown（可含多个块）。
 * @param raw - 源文本。
 * @returns 标准 Markdown，块间两个换行。
 */
export function serializeSource(raw: string): string {
  // source 块就是用户自己写的 Markdown：原样写回，不重新拼写。
  // 它已经被标准解析器读过（或就是纯文本），交给写手反而会改掉用户的拼法。
  return raw.replace(/\n$/, '')
}

/**
 * 一个顶层节点 ⇒ 一组 mdast 块（source 块可展开成多块）。
 * @param node - 顶层节点。
 * @returns 块数组。
 */
export function liftNodeBlocks(node: LexicalNode): Content[] {
  if ($isSourceBlockNode(node)) return liftSourceBlocks(node.getRaw())
  return [liftBlock(node)]
}

/**
 * 一个顶层 Lexical 节点 ⇒ 标准 Markdown（source 块按完整片段写）。
 * @param node - 顶层节点。
 * @param options - 逐块写时覆盖的列表标记。
 * @returns 标准 Markdown。
 */
export function serializeLexicalBlock(node: LexicalNode, options?: BlockWriteOptions): string {
  if ($isSourceBlockNode(node)) return serializeSource(node.getRaw())
  return serializeBlock(liftBlock(node), options)
}

/**
 * 哪些节点在列表项里算“块”。
 * @param node - 候选。
 * @returns 是不是块。
 */
function isBlockNode(node: LexicalNode): boolean {
  return (
    $isListNode(node) ||
    $isQuoteNode(node) ||
    $isCodeNode(node) ||
    $isTableNode(node) ||
    $isHeadingNode(node) ||
    $isRuleNode(node) ||
    $isRawBlockNode(node) ||
    $isSourceBlockNode(node)
  )
}
