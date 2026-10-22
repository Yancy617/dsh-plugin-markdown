/**
 * 读侧：mdast 树 → Lexical 节点（语义映射，不再保留源拼写）。
 *
 * 内容
 * - lowerDocument(root, source)：mdast 根 ⇒ 顶层 Lexical 节点。
 * - lowerPasted(text)：一段粘贴文本 ⇒ 顶层节点（解析 + 映射）。
 *
 * 行为
 * - 只映射语义：标题级别、列表类型 / 起始号 / 勾选、代码语言 / info meta、表格对齐、链接地址 / 标题、
 *   图片 alt / 地址 / 标题、原始 HTML、定义行。
 * - 格式位：strong / emphasis / delete / inlineCode 摊到文字节点上。
 * - 引用式链接 / 图片在读取时解析成普通链接 / 图片，并把引用式身份记在节点上
 *   （`referenceForm.ts`），写回时保住作者写的形式；定义块仍留在树里。
 * - 定义收集走整棵 mdast 树：CommonMark §4.7 规定定义影响整篇，不只是它所在的容器。
 * - 软换行是 LineBreakNode（默认），硬换行是 LineBreakNode + hardBreakState。
 * - 认不出的块 / 行内建原样载体（只读），不解释、不改字节。
 *
 * 边界
 * - 不解析 Markdown（mdastParse.ts），不做保存（blockSave.ts / mdastLift.ts）。
 * - 不保留 `-` / `*`、Setext、缩进代码、实体、转义等拼写；块级保真由原文切片负责。
 *
 * 相关文件
 * - 依赖：mdastParse.ts、各节点模块、hardBreak.ts。
 * - 被依赖：documentMarkdown.ts。
 *
 * 改哪里
 * - 新增 mdast 类型：lowerBlock / lowerInline 各加一支。
 * - 改引用解析：definitionsOf。
 */
import {
  $createLineBreakNode,
  $createParagraphNode,
  $createTextNode,
  $isElementNode,
  $isTextNode,
  $setState,
  IS_BOLD,
  IS_CODE,
  IS_ITALIC,
  IS_STRIKETHROUGH,
  type LexicalNode,
} from 'lexical'
import { $createHeadingNode, $createQuoteNode } from '@lexical/rich-text'
import { $createListItemNode, $createListNode } from '@lexical/list'
import { $createCodeNode } from '@lexical/code-core'
import { $createLinkNode } from '@lexical/link'
import {
  $createTableCellNode,
  $createTableNode,
  $createTableRowNode,
  TableCellHeaderStates,
} from '@lexical/table'
import type {
  Definition,
  Image,
  LinkReference,
  List,
  ListItem,
  Nodes,
  Parents,
  PhrasingContent,
  Root,
  RootContent,
  Table,
} from 'mdast'
import { $createRuleNode } from './RuleNode'
import { $createImageNode } from './image'
import { $createRawBlockNode } from './rawBlocks'
import { $createRawInlineNode } from './rawInline'
import { $createDefinitionNode } from './definitions'
import { $setReferenceForm } from './referenceForm'
import { $setCodeMeta } from './codeMeta'
import { $setTaskListForm } from './taskListForm'
import { hardBreakState } from './hardBreak'
import { tableAlignmentsState, type Alignment } from './tableModel'
import { parseBody } from './mdastParse'

/** 一次映射需要的外部事实。 */
interface Context {
  /** 本次解析所用的正文；原样载体按它切片。 */
  readonly source: string
  /** 整篇的链接定义，按 mdast 的 identifier 索引。 */
  readonly definitions: ReadonlyMap<string, Definition>
}

/**
 * 一整个 mdast 根 ⇒ 顶层 Lexical 节点。
 * @param root - mdast 根。
 * @param source - 本次解析所用的正文。
 * @returns 顶层节点，按文档顺序。
 */
export function lowerDocument(root: Root, source: string): LexicalNode[] {
  const definitions = definitionsOf(root)
  const context: Context = { source, definitions }
  return root.children.flatMap(child => {
    const block = lowerBlock(child, context)
    return block === null ? [] : [block]
  })
}

/**
 * 一段 Markdown 文本 ⇒ 顶层 Lexical 节点（粘贴用）。
 * @param text - Markdown 文本。
 * @returns 顶层节点；不落根、不碰选区。
 */
export function lowerPasted(text: string): LexicalNode[] {
  return lowerDocument(parseBody(text), text)
}

/**
 * 收集整篇的链接定义。
 *
 * **走整棵树**：CommonMark §4.7 规定定义对整篇有效，不只是它所在的那个容器
 * （引用块 / 列表项里的定义同样能被外面的链接引用到）。
 * @param root - mdast 根。
 * @returns identifier ⇒ 定义。
 */
function definitionsOf(root: Root): ReadonlyMap<string, Definition> {
  const definitions = new Map<string, Definition>()
  const walk = (node: Nodes): void => {
    if (node.type === 'definition') {
      definitions.set(node.identifier, node)
      return
    }
    if (!('children' in node)) return
    for (const child of (node as Parents).children) walk(child)
  }
  walk(root)
  return definitions
}

/**
 * 一个块 ⇒ 一个 Lexical 顶层节点。
 * @param node - mdast 块。
 * @param ctx - 映射上下文。
 * @returns 节点；认不出的块退回原样载体。
 */
function lowerBlock(node: RootContent, ctx: Context): LexicalNode | null {
  switch (node.type) {
    case 'paragraph': {
      const paragraph = $createParagraphNode()
      paragraph.append(...lowerInline(node.children, ctx))
      return paragraph
    }
    case 'heading': {
      const heading = $createHeadingNode(`h${node.depth}` as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6')
      heading.append(...lowerInline(node.children, ctx))
      return heading
    }
    case 'thematicBreak':
      return $createRuleNode()
    case 'code': {
      const code = $createCodeNode(node.lang ?? undefined)
      code.append($createTextNode(node.value))
      $setCodeMeta(code, node.meta ?? null)
      return code
    }
    case 'blockquote': {
      const quote = $createQuoteNode()
      for (const child of node.children) {
        const block = lowerBlock(child, ctx)
        if (block !== null) quote.append(block)
      }
      return quote
    }
    case 'list':
      return lowerList(node, ctx)
    case 'table':
      return lowerTable(node, ctx)
    case 'html':
      return $createRawBlockNode(node.value, 'html')
    case 'definition':
      return $createDefinitionNode(slice(node, ctx))
    default:
      // 脚注、YAML / TOML、认不出的扩展：按原文保留，只读。
      return $createRawBlockNode(slice(node, ctx), node.type)
  }
}

/**
 * 列表 ⇒ ListNode。
 * @param node - mdast list。
 * @param ctx - 映射上下文。
 * @returns ListNode。
 */
function lowerList(node: List, ctx: Context): LexicalNode {
  const task = node.children.some(item => item.checked !== null && item.checked !== undefined)
  const list = $createListNode(task ? 'check' : node.ordered === true ? 'number' : 'bullet', node.start ?? undefined)
  // 有序的任务列表（`1. [x] …`）在 Lexical 里只能建成 `check`，序号记在这条状态上，写回时取回来。
  if (task && node.ordered === true) {
    $setTaskListForm(list, { ordered: true, start: node.start ?? null })
  }
  for (const item of node.children) list.append(lowerItem(item, task, ctx))
  return list
}

/**
 * 这一段行内内容是不是自己就以换行开头。
 *
 * 列表项把多段压成“一段＋换行”；如果下一段本身以 `\n` 开头（`&#xA;` 的解析结果），
 * 再补一个分隔换行就会叠成两个，写手每轮再把它们写成 `&#xA;`，文件会无界增长。
 * 只在“段首已经是换行”时省掉那一个分隔换行；真正的多段模型仍由后续批次补。
 * @param node - mdast 行内节点。
 * @returns 是否以换行开头。
 */
function startsWithLineBreak(node: PhrasingContent): boolean {
  if (node.type === 'break') return true
  if (node.type === 'text') return node.value.startsWith('\n')
  if ('children' in node && node.children.length > 0) {
    return startsWithLineBreak(node.children[0] as PhrasingContent)
  }
  return false
}

/**
 * 列表项 ⇒ ListItemNode。
 * @param item - mdast listItem。
 * @param task - 父列表是不是任务列表。
 * @param ctx - 映射上下文。
 * @returns ListItemNode。
 */
function lowerItem(item: ListItem, task: boolean, ctx: Context): LexicalNode {
  const itemNode = $createListItemNode(task ? item.checked === true : undefined)
  let inlineParagraph = true
  for (const child of item.children) {
    if (child.type === 'paragraph') {
      const first = child.children[0]
      const leadingBreak = first !== undefined && startsWithLineBreak(first)
      if (!inlineParagraph && !leadingBreak) itemNode.append($createLineBreakNode())
      itemNode.append(...lowerInline(child.children, ctx))
      inlineParagraph = false
      continue
    }
    if (child.type === 'list') {
      itemNode.append(lowerList(child, ctx))
      inlineParagraph = false
      continue
    }
    const block = lowerBlock(child, ctx)
    if (block !== null) {
      itemNode.append(block)
      inlineParagraph = false
    }
  }
  return itemNode
}

/**
 * 表格 ⇒ TableNode。
 * @param node - mdast table。
 * @param ctx - 映射上下文。
 * @returns TableNode。
 */
function lowerTable(node: Table, ctx: Context): LexicalNode {
  const table = $createTableNode()
  node.children.forEach((row, rowIndex) => {
    const rowNode = $createTableRowNode()
    row.children.forEach(cell => {
      const status = rowIndex === 0 ? TableCellHeaderStates.ROW : TableCellHeaderStates.NO_STATUS
      const cellNode = $createTableCellNode(status)
      const paragraph = $createParagraphNode()
      paragraph.append(...lowerInline(cell.children, ctx))
      cellNode.append(paragraph)
      rowNode.append(cellNode)
    })
    table.append(rowNode)
  })
  const align = (node.align ?? []).map((value): Alignment =>
    value === 'left' || value === 'right' || value === 'center' ? value : 'none',
  )
  $setState(table, tableAlignmentsState, align)
  return table
}

/**
 * 一组行内 mdast 节点 ⇒ Lexical 行内节点。
 * @param nodes - mdast 行内节点。
 * @param ctx - 映射上下文。
 * @returns 行内节点。
 */
function lowerInline(nodes: readonly PhrasingContent[], ctx: Context): LexicalNode[] {
  const out: LexicalNode[] = []
  for (const node of nodes) {
    switch (node.type) {
      case 'text': {
        const parts = node.value.split('\n')
        parts.forEach((part, index) => {
          if (index > 0) out.push($createLineBreakNode())
          if (part !== '') out.push($createTextNode(part))
        })
        break
      }
      case 'emphasis': {
        const children = lowerInline(node.children, ctx)
        applyFormat(children, IS_ITALIC)
        out.push(...children)
        break
      }
      case 'strong': {
        const children = lowerInline(node.children, ctx)
        applyFormat(children, IS_BOLD)
        out.push(...children)
        break
      }
      case 'delete': {
        const children = lowerInline(node.children, ctx)
        applyFormat(children, IS_STRIKETHROUGH)
        out.push(...children)
        break
      }
      case 'inlineCode': {
        const text = $createTextNode(node.value)
        text.setFormat(IS_CODE)
        out.push(text)
        break
      }
      case 'link': {
        const link = $createLinkNode(node.url, {
          title: node.title ?? undefined,
        })
        link.append(...lowerInline(node.children, ctx))
        out.push(link)
        break
      }
      case 'linkReference': {
        const resolved = lowerReferenceLink(node, ctx)
        if (resolved !== null) out.push(resolved)
        else out.push(...lowerInline(node.children, ctx))
        break
      }
      case 'image': {
        out.push(lowerImage(node))
        break
      }
      case 'imageReference': {
        const definition = ctx.definitions.get(node.identifier)
        if (definition === undefined) {
          out.push($createTextNode(node.alt ?? ''))
        } else {
          const image = $createImageNode(
            node.alt ?? '',
            definition.url,
            definition.title ?? null,
          )
          $setReferenceForm(image, {
            identifier: node.identifier,
            referenceType: node.referenceType,
          })
          out.push(image)
        }
        break
      }
      case 'break': {
        const lineBreak = $createLineBreakNode()
        $setState(lineBreak, hardBreakState, true)
        out.push(lineBreak)
        break
      }
      case 'html': {
        out.push($createRawInlineNode(node.value))
        break
      }
      default:
        out.push($createTextNode(valueOf(node)))
    }
  }
  return out
}

/**
 * 引用式链接 ⇒ 普通链接 + 引用式身份（能解析到定义时）。
 * @param node - mdast linkReference。
 * @param ctx - 映射上下文。
 * @returns LinkNode，或 `null`（没有定义）。
 */
function lowerReferenceLink(node: LinkReference, ctx: Context): LexicalNode | null {
  const definition = ctx.definitions.get(node.identifier)
  if (definition === undefined) return null
  const link = $createLinkNode(definition.url, {
    title: definition.title ?? undefined,
  })
  link.append(...lowerInline(node.children, ctx))
  $setReferenceForm(link, {
    identifier: node.identifier,
    referenceType: node.referenceType,
  })
  return link
}

/**
 * 图片 ⇒ ImageNode。
 * @param node - mdast image。
 * @returns ImageNode。
 */
function lowerImage(node: Image): LexicalNode {
  return $createImageNode(node.alt ?? '', node.url, node.title ?? null)
}

/**
 * 给一组节点里的所有文字加一个格式位。
 * @param nodes - 节点。
 * @param bit - Lexical 的格式位。
 */
function applyFormat(nodes: readonly LexicalNode[], bit: number): void {
  for (const node of nodes) {
    if ($isTextNode(node)) {
      node.setFormat(node.getFormat() | bit)
    } else if ($isElementNode(node)) {
      applyFormat(node.getChildren(), bit)
    }
  }
}

/**
 * 节点在源里的原文。
 * @param node - mdast 节点。
 * @param ctx - 映射上下文。
 * @returns 原文；没有位置时退回值的文本。
 */
function slice(node: { position?: { start: { offset?: number }; end: { offset?: number } }; value?: unknown }, ctx: Context): string {
  const start = node.position?.start.offset
  const end = node.position?.end.offset
  if (start !== undefined && end !== undefined) return ctx.source.slice(start, end)
  return typeof node.value === 'string' ? node.value : ''
}

/**
 * 一个认不出的行内节点的可见文字。
 * @param node - mdast 节点。
 * @returns 文字。
 */
function valueOf(node: unknown): string {
  if (typeof node !== 'object' || node === null) return ''
  const record = node as { value?: unknown; alt?: unknown }
  if (typeof record.value === 'string') return record.value
  if (typeof record.alt === 'string') return record.alt
  return ''
}
