/**
 * 复制成 Markdown：剪贴板只带 Markdown / HTML，不再带 Lexical 的私有 JSON。
 *
 * 内容
 * - MARKDOWN_MIME：本插件自己写的 Markdown 剪贴板类型。
 * - registerMarkdownClipboard(editor)：接管 COPY_COMMAND。
 * - $selectionMarkdown(editor, selection)：选区 ⇒ 标准 Markdown。
 *
 * 行为
 * - 完整块选择：按块 lift + 标准写（定义、表格、硬换行都保住）。
 * - 部分选择：把选区的 HTML 按本编辑器读成标准 Markdown；读不出时退回纯文字。
 * - 同时写 `text/plain`（Markdown）与 `text/html`（给别的应用）。
 * - 不写 `application/x-lexical-editor`：节点 state / 原文位置不再跨文档。
 *
 * 边界
 * - 不负责粘贴（PasteMarkdownPlugin.tsx）。
 * - 不负责“选区是否完整块”以外的语义判断。
 *
 * 相关文件
 * - 依赖：@lexical/html、lexical、mdastLift、pasteFlavor、paragraphAfter。
 * - 被依赖：MarkdownEditor.tsx。
 *
 * 改哪里
 * - 改完整块判据：$selectionMarkdown。
 * - 改剪贴板类型：MARKDOWN_MIME。
 */
import {
  $getRoot,
  $getSelection,
  $isElementNode,
  $isNodeSelection,
  $isRangeSelection,
  $isTextNode,
  COMMAND_PRIORITY_HIGH,
  COPY_COMMAND,
  type LexicalEditor,
  type LexicalNode,
  type BaseSelection,
  type PointType,
} from 'lexical'
import { $generateHtmlFromNodes } from '@lexical/html'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { useEffect } from 'react'
import { serializeLexicalBlock } from './mdastLift'
import { $isEmptyParagraph } from './emptyParagraph'
import { $htmlFlavorAsMarkdown } from './htmlMarkdown'
import { $topLevelBlockOf } from './tree'

/** 本插件自己的 Markdown 剪贴板类型；粘贴时优先于 HTML / 纯文本。 */
export const MARKDOWN_MIME = 'application/x-dsh-markdown'

/**
 * 挂上复制处理；渲染为空。
 * @returns null。
 */
export function MarkdownClipboardPlugin(): null {
  const [editor] = useLexicalComposerContext()
  useEffect(() => registerMarkdownClipboard(editor), [editor])
  return null
}

/**
 * 接管复制：写 Markdown + HTML，不写 Lexical JSON。
 * @param editor - 当前编辑器。
 * @returns 注销函数。
 */
export function registerMarkdownClipboard(editor: LexicalEditor): () => void {
  return editor.registerCommand(
    COPY_COMMAND,
    event => {
      if (event === null || !('clipboardData' in event) || event.clipboardData === null) return false
      const selection = $getSelection()
      if (selection === null || selection.isCollapsed()) return false
      const markdown = $selectionMarkdown(editor, selection)
      if (markdown === '') return false
      const html = $generateHtmlFromNodes(editor, selection)
      event.clipboardData.setData('text/plain', markdown)
      event.clipboardData.setData('text/html', html)
      event.clipboardData.setData(MARKDOWN_MIME, markdown)
      event.preventDefault()
      return true
    },
    COMMAND_PRIORITY_HIGH,
  )
}

/**
 * 一个选区 ⇒ 标准 Markdown。
 *
 * 完整块（含 Ctrl+A、整段、整个表格）走块级序列化，保住定义与表格对齐；部分选择走 HTML 读法，
 * 保住行内格式；HTML 也读不出时退回可见文字。
 *
 * 必须在 Lexical 的编辑器上下文里调用。
 * @param editor - 当前编辑器。
 * @param selection - 当前选区。
 * @returns 标准 Markdown；空选区给空串。
 */
export function $selectionMarkdown(editor: LexicalEditor, selection: BaseSelection): string {
  const blocks = $blocksInSelection(selection)
  if (blocks.length === 0) return ''
  if ($isWholeBlocks(selection, blocks)) {
    return blocks
      .map(block => serializeLexicalBlock(block))
      .filter(text => text !== '')
      .join('\n\n')
  }
  try {
    const html = $generateHtmlFromNodes(editor, selection)
    const markdown = $htmlFlavorAsMarkdown(html)
    return markdown !== '' ? markdown : selection.getTextContent()
  } catch {
    // 富文本节点没法导出成 HTML（或环境里没有 DOM）时，至少把可见文字复制出去。
    return selection.getTextContent()
  }
}

/**
 * 选区碰到的顶层块，按文档顺序。
 * @param selection - 当前选区。
 * @returns 顶层块。
 */
function $blocksInSelection(selection: BaseSelection): LexicalNode[] {
  const touched = new Set<string>()
  for (const node of selection.getNodes()) {
    const block = $topLevelBlockOf(node)
    if (block !== null) touched.add(block.getKey())
  }
  return $getRoot()
    .getChildren()
    .filter(child => touched.has(child.getKey()) && !$isEmptyParagraph(child))
}

/**
 * 选区是否完整覆盖了它碰到的块。
 *
 * 两端各问一次：起点是不是第一块的第一个位置，终点是不是最后一块的最后一个位置（或最后一块
 * 后面那串空段落的开头）。中间的块被跨过，天然是整块。`NodeSelection` 一律按完整块。
 * @param selection - 当前选区。
 * @param blocks - 选区碰到的内容块。
 * @returns 是否完整块。
 */
function $isWholeBlocks(selection: BaseSelection, blocks: readonly LexicalNode[]): boolean {
  if ($isNodeSelection(selection)) return true
  if (!$isRangeSelection(selection) || blocks.length === 0) return false
  const backward = selection.isBackward()
  const start = backward ? selection.focus : selection.anchor
  const end = backward ? selection.anchor : selection.focus
  const first = blocks[0]
  const last = blocks[blocks.length - 1]
  if (first === undefined || last === undefined) return false
  return (
    $isBlockStart(start, first) &&
    ($isBlockEnd(end, last) || $isTrailingBlank(end, last))
  )
}

/**
 * 这个点是不是某个块的第一个位置。
 * @param point - 选区端点。
 * @param block - 顶层块。
 * @returns 是否在块首。
 */
function $isBlockStart(point: PointType, block: LexicalNode): boolean {
  if (point.offset !== 0) return false
  let node: LexicalNode | null = point.getNode()
  while (node !== null && node !== block) {
    if (node.getPreviousSibling() !== null) return false
    node = node.getParent()
  }
  return node === block
}

/**
 * 这个点是不是某个块的最后一个位置。
 * @param point - 选区端点。
 * @param block - 顶层块。
 * @returns 是否在块尾。
 */
function $isBlockEnd(point: PointType, block: LexicalNode): boolean {
  const node = point.getNode()
  if (point.type === 'text') {
    if (!$isTextNode(node) || point.offset !== node.getTextContentSize()) return false
  } else if (!$isElementNode(node) || point.offset !== node.getChildrenSize()) return false
  let current: LexicalNode | null = node
  while (current !== null && current !== block) {
    if (current.getNextSibling() !== null) return false
    current = current.getParent()
  }
  return current === block
}

/**
 * 终点是不是落在最后一块之后的空段落开头（Ctrl+A 的终点就在这里）。
 * @param point - 选区终点。
 * @param last - 选区碰到的最后一个内容块。
 * @returns 是否可以视为块尾。
 */
function $isTrailingBlank(point: PointType, last: LexicalNode): boolean {
  const block = $topLevelBlockOf(point.getNode())
  if (block === null || !$isEmptyParagraph(block) || !$isBlockStart(point, block)) return false
  let previous = block.getPreviousSibling()
  while (previous !== null && $isEmptyParagraph(previous)) previous = previous.getPreviousSibling()
  return previous === last
}
