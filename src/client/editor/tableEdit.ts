/**
 * 表格结构编辑：行 / 列的增删。
 *
 * 内容
 * - TableTarget / TableEditId / TableEditOperation / TABLE_EDITS。
 * - ColumnAlignmentOption / COLUMN_ALIGNMENTS：列对齐的四个选项。
 * - tableTargetAtSelection / tableTargetAtCell / tableEdit / refusalOf / applyTableEdit。
 * - columnAlignmentAt / applyColumnAlignment：读一列的对齐、写一列的对齐。
 *
 * 行为
 * - 目标按"表 + 行下标 + 列下标"表达，不读选区：手柄用悬停那一格，命令面板用光标那一格。
 * - 守卫：第 0 行是表头（不可删、不可在它上方插）；至少一列；表头外至少一行；非矩形表与合并格一律拒绝。
 * - 插 / 删列同步维护 tableAlignmentsState（按列序），否则对齐会串到隔壁列。
 * - 一次操作一笔 discrete 的 editor.update：撤销一步回到操作前。
 * - 操作后光标落在新格或接替位置上，不选中内容（选中会让下一次打字替换掉相邻格）。
 * - 列对齐只同步 tableAlignmentsState；写回时整张表按标准 GFM 重写（块级规则）。
 *
 * 边界
 * - 不负责 GFM 的解析与序列化（mdastLower / mdastLift），也不负责界面（tableChrome.tsx / MarkdownWorkbench.tsx）。
 *
 * 相关文件
 * - 依赖：tableModel.ts 的 tableAlignmentsState / Alignment；@lexical/table 的节点与守卫。
 * - 被依赖：tableChrome.tsx（手柄菜单）、MarkdownWorkbench.tsx（命令面板）。
 *
 * 改哪里
 * - 加 / 删动作：TABLE_EDITS。
 * - 改守卫：refusalOf。
 * - 改光标落点：$focusCell。
 */
import {
  $createParagraphNode,
  $getNodeByKey,
  $getSelection,
  $getState,
  $isElementNode,
  $isRangeSelection,
  $setState,
  type LexicalEditor,
  type LexicalNode,
  type NodeKey,
} from 'lexical'
import {
  $createTableCellNode,
  $createTableRowNode,
  $isSimpleTable,
  $isTableCellNode,
  $isTableNode,
  $isTableRowNode,
  $isTableSelection,
  TableCellHeaderStates,
  type TableCellNode,
  type TableNode,
  type TableRowNode,
} from '@lexical/table'
import { tableAlignmentsState, type Alignment } from './tableModel'

/** Where a structural edit points: a table, a row and a column. */
export interface TableTarget {
  /** The table node's key. */
  readonly tableKey: NodeKey
  /** 0-based row index; row 0 is the header. */
  readonly row: number
  /** 0-based column index. */
  readonly column: number
  /** How many rows the table has. */
  readonly rows: number
  /** How many cells the header row has. */
  readonly columns: number
  /**
   * Why this table refuses structural edits, or `null` when it takes them.
   *
   * Two shapes are refused rather than repaired: a table with merged cells (Markdown cannot
   * express them, and the merge-aware helpers behave differently), and a **ragged** table whose
   * rows do not all have the header's cell count. The second is not hypothetical — the mdast
   * lowering keeps a source row that is wider than the header, and Lexical's table map is a
   * sparse array there, so the stock helpers read `undefined` and throw.
   */
  readonly blocked: string | null
}

/** The six structural edits. */
export type TableEditId =
  | 'rowAbove'
  | 'rowBelow'
  | 'rowDelete'
  | 'columnLeft'
  | 'columnRight'
  | 'columnDelete'

/** One structural edit: its label, its guard, and which axis it acts on. */
export interface TableEditOperation {
  /** Stable id. */
  readonly id: TableEditId
  /** Which handle lists it. */
  readonly kind: 'row' | 'column'
  /** Row label and palette label. */
  readonly label: string
  /** Extra text a palette search should match. */
  readonly keywords: string
  /** Drawn as dangerous (delete). */
  readonly danger?: boolean
  /**
   * Why this operation cannot run here, or `null` when it can.
   * @param target - the table position being acted on.
   * @returns the reason shown in the menu, or `null`.
   */
  readonly refusal: (target: TableTarget) => string | null
}

/** The table's 0-based header row, which GFM always has and this editor never removes. */
const HEADER_ROW = 0

/** The minimum body rows kept below the header. */
const MIN_BODY_ROWS = 1

/**
 * The structural edits, in the order a menu offers them: the two inserts, then the delete.
 * Delete rows come last inside each handle's menu (the owner inserts the separator).
 */
export const TABLE_EDITS: readonly TableEditOperation[] = [
  {
    id: 'rowAbove',
    kind: 'row',
    label: '在上方插入行',
    keywords: 'row 行 插入 上方 above',
    refusal: target =>
      target.blocked ?? (target.row === HEADER_ROW ? '表头必须在最上面' : null),
  },
  {
    id: 'rowBelow',
    kind: 'row',
    label: '在下方插入行',
    keywords: 'row 行 插入 下方 below',
    refusal: target => target.blocked,
  },
  {
    id: 'rowDelete',
    kind: 'row',
    label: '删除这一行',
    keywords: 'row 行 删除 移除 delete remove',
    danger: true,
    refusal: target =>
      target.blocked ??
      (target.row === HEADER_ROW
        ? '表头不能删除'
        : target.rows <= MIN_BODY_ROWS + 1
          ? '至少要留一行'
          : null),
  },
  {
    id: 'columnLeft',
    kind: 'column',
    label: '在左侧插入列',
    keywords: 'column 列 插入 左侧 left',
    refusal: target => target.blocked,
  },
  {
    id: 'columnRight',
    kind: 'column',
    label: '在右侧插入列',
    keywords: 'column 列 插入 右侧 right',
    refusal: target => target.blocked,
  },
  {
    id: 'columnDelete',
    kind: 'column',
    label: '删除这一列',
    keywords: 'column 列 删除 移除 delete remove',
    danger: true,
    refusal: target => target.blocked ?? (target.columns <= 1 ? '至少要留一列' : null),
  },
]

/**
 * Look up one structural edit.
 * @param id - the edit id.
 * @returns the operation, or `undefined` when the id is unknown.
 */
export function tableEdit(id: TableEditId): TableEditOperation | undefined {
  return TABLE_EDITS.find(operation => operation.id === id)
}

/**
 * Why an operation cannot run on a target.
 * @param operation - the edit to check.
 * @param target - where it would apply.
 * @returns the reason, or `null` when it can run.
 */
export function refusalOf(operation: TableEditOperation, target: TableTarget): string | null {
  return operation.refusal(target)
}

/** One alignment the column menu offers, with the row id the menu reports. */
export interface ColumnAlignmentOption {
  /** Stable menu id. */
  readonly id: string
  /** The GFM alignment it writes. */
  readonly alignment: Alignment
  /** The row's label. */
  readonly label: string
}

/**
 * The four column alignments, in the order the column menu lists them.
 *
 * `none` stays a choice of its own. It is GFM's plain `---`, which renders like left but is a
 * different spelling: an author whose table was aligned by an earlier edit must be able to take the
 * colons back out without going to the source view.
 */
export const COLUMN_ALIGNMENTS: readonly ColumnAlignmentOption[] = [
  { id: 'alignLeft', alignment: 'left', label: '左对齐' },
  { id: 'alignCenter', alignment: 'center', label: '居中' },
  { id: 'alignRight', alignment: 'right', label: '右对齐' },
  { id: 'alignNone', alignment: 'none', label: '默认' },
]

/**
 * The alignment one column currently has.
 * @param editor - the live editor.
 * @param target - the column to read.
 * @returns the stored alignment, or `none` when the table is gone.
 */
export function columnAlignmentAt(editor: LexicalEditor, target: TableTarget): Alignment {
  return editor.getEditorState().read(() => {
    const node = $getNodeByKey(target.tableKey)
    if (node === null || !$isTableNode(node)) return 'none'
    return $getState(node, tableAlignmentsState)[target.column] ?? 'none'
  })
}

/**
 * Write one column's alignment.
 *
 * Two things change together, and both are needed: the node state (which decides the delimiter row
 * when the table is re-serialized) and the recorded source block (which decides whether the export
 * *can* replay the source). Patching only the state turned the whole table back into canonical
 * Markdown — spacing, optional pipes and every delimiter cell rewritten — for a change that is at
 * most two characters, so the block's delimiter row is patched in place by
 * {@link withColumnAlignment} and the rest of the bytes stay exactly as the author wrote them.
 *
 * A table with no source block (`$createFreshTable`, i.e. inserted from `/`) has nothing to patch;
 * the state alone is enough, and the export writes the canonical delimiter row.
 * @param editor - the live editor.
 * @param alignment - the alignment to write.
 * @param target - the column to write it to.
 * @returns whether the edit ran.
 */
export function applyColumnAlignment(
  editor: LexicalEditor,
  alignment: Alignment,
  target: TableTarget,
): boolean {
  let applied = false
  editor.update(
    () => {
      const node = $getNodeByKey(target.tableKey)
      if (node === null || !$isTableNode(node)) return
      const fresh = targetOf(node, target.row, target.column)
      if (fresh.column >= fresh.columns) return

      const stored = $getState(node, tableAlignmentsState)
      const next: Alignment[] = Array.from(
        { length: fresh.columns },
        (_, index) => stored[index] ?? 'none',
      )
      next[fresh.column] = alignment
      $setState(node, tableAlignmentsState, next)
      applied = true
    },
    { discrete: true },
  )
  return applied
}

/**
 * The cells of one row, in order.
 * @param table - the table node.
 * @returns rows with their cell children filtered to cells.
 */
function rowsOf(
  table: TableNode,
): readonly { readonly row: TableRowNode; readonly cells: readonly TableCellNode[] }[] {
  const out: { row: TableRowNode; cells: TableCellNode[] }[] = []
  for (const child of table.getChildren()) {
    if (!$isTableRowNode(child)) continue
    out.push({ row: child, cells: child.getChildren().filter($isTableCellNode) })
  }
  return out
}

/**
 * The header's column count — the width every row must have.
 * @param table - the table node.
 * @returns the column count, or 0 for a table with no header row.
 */
function columnCountOf(table: TableNode): number {
  const first = rowsOf(table)[0]
  return first?.cells.length ?? 0
}

/**
 * Why a table cannot take structural edits, read from its shape alone.
 * @param table - the table node.
 * @returns the reason, or `null` when it is a plain rectangular table.
 */
function blockedReasonOf(table: TableNode): string | null {
  if (!$isSimpleTable(table)) return '表格里有合并的单元格'
  const rows = rowsOf(table)
  const columns = rows[0]?.cells.length ?? 0
  if (columns === 0) return '表格没有列'
  for (const row of rows) {
    if (row.cells.length !== columns) return '这一行的格子数与表头不一致'
  }
  return null
}

/**
 * A target read from an attached table node.
 * @param table - the table node.
 * @param row - row index.
 * @param column - column index.
 * @returns the target with the table's current shape.
 */
function targetOf(table: TableNode, row: number, column: number): TableTarget {
  return {
    tableKey: table.getKey(),
    row,
    column,
    rows: rowsOf(table).length,
    columns: columnCountOf(table),
    blocked: blockedReasonOf(table),
  }
}

/**
 * The target under the caret, for the command palette.
 * @param editor - the live editor.
 * @returns the target, or `null` when the caret is not inside a table cell.
 */
export function tableTargetAtSelection(editor: LexicalEditor): TableTarget | null {
  return editor.getEditorState().read(() => {
    const selection = $getSelection()
    if (!$isRangeSelection(selection) && !$isTableSelection(selection)) return null
    let node: LexicalNode | null = selection.anchor.getNode()
    while (node !== null && !$isTableCellNode(node)) node = node.getParent()
    if (node === null) return null
    const rowNode = node.getParent()
    if (rowNode === null || !$isTableRowNode(rowNode)) return null
    const table = rowNode.getParent()
    if (table === null || !$isTableNode(table)) return null
    const row = table.getChildren().indexOf(rowNode)
    const column = rowNode.getChildren().filter($isTableCellNode).indexOf(node)
    if (row < 0 || column < 0) return null
    return targetOf(table, row, column)
  })
}

/**
 * The target of one cell, for a pointer that is hovering it.
 * @param editor - the live editor.
 * @param tableKey - the table node's key.
 * @param row - row index.
 * @param column - column index.
 * @returns the target, or `null` when the node or the position is gone.
 */
export function tableTargetAtCell(
  editor: LexicalEditor,
  tableKey: NodeKey,
  row: number,
  column: number,
): TableTarget | null {
  return editor.getEditorState().read(() => {
    const node = $getNodeByKey(tableKey)
    if (node === null || !$isTableNode(node)) return null
    const target = targetOf(node, row, column)
    if (row >= target.rows || column >= target.columns) return null
    return target
  })
}

/**
 * Alignments with one column inserted — computed from the **old** width, before the column lands.
 * @param table - the table before the insertion.
 * @param columns - the column count before the insertion.
 * @param position - where the new column lands.
 * @returns the new alignment list, one entry per column.
 */
function $alignmentsWithColumnInserted(
  table: TableNode,
  columns: number,
  position: number,
): Alignment[] {
  const stored = $getState(table, tableAlignmentsState)
  const next: Alignment[] = Array.from({ length: columns }, (_, index) => stored[index] ?? 'none')
  next.splice(position, 0, 'none')
  return next
}

/**
 * Alignments with one column removed — computed from the **old** width, before the column goes.
 * @param table - the table before the removal.
 * @param columns - the column count before the removal.
 * @param column - the column being removed.
 * @returns the new alignment list, one entry per remaining column.
 */
function $alignmentsWithColumnRemoved(
  table: TableNode,
  columns: number,
  column: number,
): Alignment[] {
  const stored = $getState(table, tableAlignmentsState)
  const next: Alignment[] = Array.from({ length: columns }, (_, index) => stored[index] ?? 'none')
  next.splice(column, 1)
  return next
}

/**
 * Put the caret at the start of one cell.
 *
 * Deliberately **collapsed**: selecting the cell's content would mean the next keystroke replaces
 * it, and one of the paths here (deleting a column) lands in a cell that still holds the author's
 * words.
 * @param table - the table node.
 * @param row - row index, clamped.
 * @param column - column index, clamped.
 */
function $focusCell(table: TableNode, row: number, column: number): void {
  const rows = rowsOf(table)
  const targetRow = rows[Math.max(0, Math.min(row, rows.length - 1))]
  if (targetRow === undefined) return
  const cell = targetRow.cells[Math.max(0, Math.min(column, targetRow.cells.length - 1))]
  if (cell === undefined) return
  const paragraph = cell.getFirstChild()
  if (paragraph !== null && $isElementNode(paragraph)) paragraph.select(0, 0)
  else cell.selectStart()
}

/**
 * Insert one body row above or below a row.
 * @param table - the table node.
 * @param row - the reference row.
 * @param after - whether the new row goes below it.
 */
function $insertRow(table: TableNode, row: number, after: boolean): void {
  const rows = rowsOf(table)
  const anchor = rows[row]?.row
  if (anchor === undefined) return
  const columns = columnCountOf(table)
  const created = $createTableRowNode()
  for (let column = 0; column < columns; column += 1) {
    created.append($createTableCellNode(TableCellHeaderStates.NO_STATUS).append($createParagraphNode()))
  }
  if (after) anchor.insertAfter(created)
  else anchor.insertBefore(created)
}

/**
 * Remove one row.
 * @param table - the table node.
 * @param row - the row to remove.
 */
function $deleteRow(table: TableNode, row: number): void {
  rowsOf(table)[row]?.row.remove()
}

/**
 * Insert one column to the left or right of a column.
 *
 * The header row's new cell carries the header state, so the table keeps exactly one header row —
 * the one GFM reads as the header.
 * @param table - the table node.
 * @param column - the reference column.
 * @param before - whether the new column goes to its left.
 */
function $insertColumn(table: TableNode, column: number, before: boolean): void {
  const position = before ? column : column + 1
  const rows = rowsOf(table)
  rows.forEach((entry, rowIndex) => {
    const cell = $createTableCellNode(
      rowIndex === 0 ? TableCellHeaderStates.ROW : TableCellHeaderStates.NO_STATUS,
    ).append($createParagraphNode())
    const reference = entry.row.getChildAtIndex(position)
    if (reference === null) entry.row.append(cell)
    else reference.insertBefore(cell)
  })
}

/**
 * Remove one column from every row.
 * @param table - the table node.
 * @param column - the column to remove.
 */
function $deleteColumn(table: TableNode, column: number): void {
  for (const entry of rowsOf(table)) entry.row.getChildAtIndex(column)?.remove()
}

/**
 * Run one structural edit.
 *
 * Re-validates against the live table before touching it: the target was captured from a hover or
 * from the caret, and a selection or a node could have moved since.
 * @param editor - the live editor.
 * @param id - which edit.
 * @param target - where it applies.
 * @returns whether the edit ran.
 */
export function applyTableEdit(
  editor: LexicalEditor,
  id: TableEditId,
  target: TableTarget,
): boolean {
  const operation = tableEdit(id)
  if (operation === undefined) return false
  let applied = false
  editor.update(
    () => {
      const node = $getNodeByKey(target.tableKey)
      if (node === null || !$isTableNode(node)) return
      const fresh = targetOf(node, target.row, target.column)
      if (
        fresh.rows !== target.rows ||
        fresh.columns !== target.columns ||
        fresh.row >= fresh.rows ||
        fresh.column >= fresh.columns
      ) {
        return
      }
      if (refusalOf(operation, fresh) !== null) return

      switch (operation.id) {
        case 'rowAbove':
          $insertRow(node, fresh.row, false)
          $focusCell(node, fresh.row, fresh.column)
          break
        case 'rowBelow':
          $insertRow(node, fresh.row, true)
          $focusCell(node, fresh.row + 1, fresh.column)
          break
        case 'rowDelete':
          $deleteRow(node, fresh.row)
          $focusCell(node, fresh.row, fresh.column)
          break
        case 'columnLeft': {
          const alignments = $alignmentsWithColumnInserted(node, fresh.columns, fresh.column)
          $insertColumn(node, fresh.column, true)
          $setState(node, tableAlignmentsState, alignments)
          $focusCell(node, fresh.row, fresh.column)
          break
        }
        case 'columnRight': {
          const alignments = $alignmentsWithColumnInserted(node, fresh.columns, fresh.column + 1)
          $insertColumn(node, fresh.column, false)
          $setState(node, tableAlignmentsState, alignments)
          $focusCell(node, fresh.row, fresh.column + 1)
          break
        }
        case 'columnDelete': {
          const alignments = $alignmentsWithColumnRemoved(node, fresh.columns, fresh.column)
          $deleteColumn(node, fresh.column)
          $setState(node, tableAlignmentsState, alignments)
          $focusCell(node, fresh.row, fresh.column)
          break
        }
      }
      applied = true
    },
    { discrete: true },
  )
  return applied
}
