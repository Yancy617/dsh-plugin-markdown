/**
 * 表格列对齐在编辑面上的呈现：把每列的对齐写到那一列每个格子的 DOM 属性上。
 *
 * 内容
 * - TableAlignPlugin：一个不渲染任何东西的插件。
 *
 * 行为
 * - 每次编辑器更新后（以及挂载时）读一遍文档里的表格：每一格按**列序**取
 *   tableAlignmentsState，写到该格元素的 data-md-align 上；'none' 摘掉属性。
 *   表头与表体都要写 —— 文本对齐不跨 th / td 继承。
 * - 属性名只有一处声明（config.ts 的 TABLE_ALIGN_ATTRIBUTE），样式表按它选边。
 * - 只改属性、不改 DOM 结构，也不碰编辑器状态：Lexical 从不把它当成树的一部分。
 * - 按"节点键 + 元素 + 对齐"缓存，值没变就不写；节点被替换（元素换了）时重写。
 *
 * 边界
 * - 不拥有对齐数据（tableModel.ts 的 tableAlignmentsState），不负责菜单与写入（tableEdit.ts / tableChrome.tsx）。
 * - 不画框线、不做其余表格样式（config.ts 的 EDITOR_CSS）。
 *
 * 相关文件
 * - 依赖：tableModel.ts 的 tableAlignmentsState / Alignment、config.ts 的 TABLE_ALIGN_ATTRIBUTE。
 * - 被依赖：MarkdownEditor.tsx。
 *
 * 改哪里
 * - 属性的落点与写法：apply。
 * - 遍历哪些格子：$collectAlignments。
 */
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import {
  $getRoot,
  $getState,
  $isElementNode,
  type LexicalNode,
  type NodeKey,
} from 'lexical'
import {
  $isTableCellNode,
  $isTableNode,
  $isTableRowNode,
} from '@lexical/table'
import { useEffect } from 'react'
import { TABLE_ALIGN_ATTRIBUTE } from './config'
import { tableAlignmentsState, type Alignment } from './tableModel'

/** One cell that carries a column's alignment. */
interface CellAlignment {
  /** The cell node's key. */
  readonly key: NodeKey
  /** The alignment its column is set to. */
  readonly alignment: Alignment
}

/**
 * Every cell in the document, with its column's alignment.
 *
 * The alignment belongs to a **column**, and `tableAlignmentsState` is indexed by column, so each
 * cell takes the value at its own index — header and body alike. Painting only the header row
 * would leave the body cells left-aligned: `text-align` does not cross from `th` to `td`. A table
 * can sit at any depth (a quote, a list item), so the walk is recursive and stops descending at a
 * table — a table cannot hold another one.
 * @returns the cells, in document order.
 */
function $collectAlignments(): CellAlignment[] {
  const out: CellAlignment[] = []
  const visit = (node: LexicalNode): void => {
    if ($isTableNode(node)) {
      const alignments = $getState(node, tableAlignmentsState)
      for (const row of node.getChildren()) {
        if (!$isTableRowNode(row)) continue
        row.getChildren().forEach((cell, column) => {
          if ($isTableCellNode(cell)) {
            out.push({ key: cell.getKey(), alignment: alignments[column] ?? 'none' })
          }
        })
      }
      return
    }
    if (!$isElementNode(node)) return
    for (const child of node.getChildren()) visit(child)
  }
  for (const child of $getRoot().getChildren()) visit(child)
  return out
}

/**
 * Paint each column's alignment onto its cells.
 *
 * Deliberately **not** a wrapper node or a decorator: the alignment is a property of the column,
 * the cell nodes already exist, and a DOM attribute is the one thing Lexical leaves alone. The
 * editor's own Markdown export never reads the DOM, so this is presentation only.
 * @returns nothing rendered.
 */
export function TableAlignPlugin(): null {
  const [editor] = useLexicalComposerContext()

  useEffect(() => {
    /** What was written last, so an unchanged cell is not touched on every keystroke. */
    const applied = new Map<NodeKey, { readonly element: Element; readonly alignment: Alignment }>()
    let frame = 0

    const apply = (): void => {
      frame = 0
      const entries = editor.getEditorState().read($collectAlignments)
      const live = new Set<NodeKey>()
      for (const entry of entries) {
        live.add(entry.key)
        const element = editor.getElementByKey(entry.key)
        if (element === null) continue
        const previous = applied.get(entry.key)
        if (
          previous !== undefined &&
          previous.element === element &&
          previous.alignment === entry.alignment
        ) {
          continue
        }
        if (entry.alignment === 'none') element.removeAttribute(TABLE_ALIGN_ATTRIBUTE)
        else element.setAttribute(TABLE_ALIGN_ATTRIBUTE, entry.alignment)
        applied.set(entry.key, { element, alignment: entry.alignment })
      }
      // Deleted rows / tables must not keep this map growing for the life of the document.
      for (const key of applied.keys()) if (!live.has(key)) applied.delete(key)
    }

    const schedule = (): void => {
      if (frame !== 0) return
      frame = window.requestAnimationFrame(apply)
    }

    // The first paint is not an update: the composer's initial state is committed before this
    // effect runs, so neither the update listener nor the root listener is guaranteed to fire.
    schedule()
    const unregisterUpdates = editor.registerUpdateListener(schedule)
    const unregisterRoot = editor.registerRootListener(schedule)
    return () => {
      unregisterUpdates()
      unregisterRoot()
      if (frame !== 0) window.cancelAnimationFrame(frame)
    }
  }, [editor])

  return null
}
