/**
 * 表格的语义模型：每列对齐、以及“从命令插入一张空表”。
 *
 * 内容
 * - Alignment / tableAlignmentsState。
 * - $createFreshTable(bodyRows, columns)。
 *
 * 行为
 * - 对齐是每列的语义（GFM 分隔行）；存在 TableNode 的节点状态上。
 * - 新表没有任何源块；保存时按 mdast 标准写整张表（块级规则）。
 *
 * 边界
 * - 不解析 GFM 表格、不生成 Markdown、不补丁分隔行（这些已由 mdast 接管）。
 * - 不负责表格编辑命令（tableEdit.ts）与绘制（tableChrome.tsx / tableAlign.ts）。
 *
 * 相关文件
 * - 被依赖：mdastLower.ts、mdastLift.ts、tableAlign.ts、tableEdit.ts、SlashMenu.tsx。
 *
 * 改哪里
 * - 改对齐状态：tableAlignmentsState。
 * - 改新表：$createFreshTable。
 */
import { $createParagraphNode, $createTextNode, $setState, createState } from 'lexical'
import {
  $createTableCellNode,
  $createTableNode,
  $createTableRowNode,
  TableCellHeaderStates,
  type TableNode,
} from '@lexical/table'

/** 每列的 GFM 对齐；`none` 写成 `---`。 */
export type Alignment = 'none' | 'left' | 'center' | 'right'

/**
 * 每列对齐。
 *
 * 数组在默认 `Object.is` 下按引用比较；不自定义 `isEqual` 的话改对齐不会把节点标脏。
 */
export const tableAlignmentsState = createState('mdTableAlignments', {
  parse: (value: unknown): Alignment[] =>
    Array.isArray(value) ? value.filter(isAlignment) : [],
  isEqual: (left, right) =>
    left.length === right.length && left.every((value, index) => value === right[index]),
})

/**
 * @param value - 候选值。
 * @returns 是不是一种对齐。
 */
function isAlignment(value: unknown): value is Alignment {
  return value === 'none' || value === 'left' || value === 'center' || value === 'right'
}

/**
 * 造一张从来没有过源文件的空表。
 * @param bodyRows - 表头以下的行数。
 * @param columns - 列数。
 * @returns TableNode。
 */
export function $createFreshTable(bodyRows: number, columns: number): TableNode {
  const table = $createTableNode()
  const header = Array.from({ length: columns }, (_, index) => `列 ${index + 1}`)
  const rows = [header, ...Array.from({ length: bodyRows }, () => header.map(() => ''))]
  rows.forEach((cells, rowIndex) => {
    const row = $createTableRowNode()
    for (let column = 0; column < columns; column += 1) {
      const cell = $createTableCellNode(
        rowIndex === 0 ? TableCellHeaderStates.ROW : TableCellHeaderStates.NO_STATUS,
      )
      const paragraph = $createParagraphNode()
      paragraph.append($createTextNode(cells[column] ?? ''))
      cell.append(paragraph)
      row.append(cell)
    }
    table.append(row)
  })
  $setState(table, tableAlignmentsState, header.map(() => 'none'))
  return table
}
