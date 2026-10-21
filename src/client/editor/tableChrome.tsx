/**
 * 表格的行 / 列手柄：悬停时浮在表格外侧，点开菜单做结构编辑。
 *
 * 内容
 * - TableChrome 与常量（GRIP_SIZE / ROW_GAP / COLUMN_GAP）与 GripGlyph。
 *
 * 行为
 * - 指针进到格子里立刻出现两个手柄：行手柄在左外侧、列手柄在上外侧；同一张表内换格立刻跟随。
 * - 指针离开表格立刻消失；两个手柄各自占住拿得到它的那条走道（行 6px、列 1px 贴边，再加手柄自己的 18px），
 *   走不过去就点不到。拖动选区、滚动、窗口缩放时同样立刻消失。没有延时。
 * - 点手柄开菜单（primitives 的 Menu，portal、夹在视口内）；指着手柄或菜单开着时给那一行/列画描边。
 * - 菜单里的动作由 tableEdit 定义；禁用的动作留在菜单里，并在同一行写原因。
 * - 列菜单多一组「对齐」：左 / 居中 / 右 / 默认，当前那一项打勾；它只改分隔行那一格（tableEdit.ts）。
 * - 全部画在 contentEditable 之外的固定层里：不往 Lexical 的 DOM 插节点，也不抢编辑器选区。
 *
 * 边界
 * - 不负责数据与守卫（tableEdit.ts）；不负责表格的解析与序列化（mdastLower.ts / mdastLift.ts）。
 *
 * 相关文件
 * - 依赖：tableEdit.ts、primitives 的 Menu、EDITOR_CSS 里的手柄 / 描边样式。
 * - 被依赖：MarkdownEditor.tsx。
 *
 * 改哪里
 * - 改位置 / 形态：GRIP_SIZE / ROW_GAP / COLUMN_GAP 与 TableChrome 的渲染。
 * - 改菜单：itemsFor。
 */
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { getTableObserverFromTableElement } from '@lexical/table'
import { Menu, type MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
} from 'react'
import { createPortal } from 'react-dom'
import { visibleBand } from './selectionPlacement'
import {
  COLUMN_ALIGNMENTS,
  TABLE_EDITS,
  applyColumnAlignment,
  applyTableEdit,
  columnAlignmentAt,
  refusalOf,
  tableTargetAtCell,
  type TableEditOperation,
  type TableTarget,
} from './tableEdit'

/** Handle diameter, in px. */
const GRIP_SIZE = 18

/** Gap between the row handle and the table's left edge, in px. */
const ROW_GAP = 6

/** Gap between the column handle and the table's top edge, in px — 1px, it sits on the table. */
const COLUMN_GAP = 1

/** Where the pointer rests: a table and one of its cells. */
interface Hover {
  /** The table node's key. */
  readonly tableKey: string
  /** 0-based row. */
  readonly row: number
  /** 0-based column. */
  readonly column: number
}

/** A viewport-space rectangle. */
interface Box {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

/** The two guides, in viewport space. */
interface Geometry {
  readonly row: Box
  readonly column: Box
}

/**
 * Whether two measurements would draw the same guides.
 * @param a - current geometry.
 * @param b - freshly measured geometry.
 * @returns true when nothing moved.
 */
function sameGeometry(a: Geometry | null, b: Geometry): boolean {
  if (a === null) return false
  return (
    a.row.left === b.row.left &&
    a.row.top === b.row.top &&
    a.row.width === b.row.width &&
    a.row.height === b.row.height &&
    a.column.left === b.column.left &&
    a.column.top === b.column.top &&
    a.column.width === b.column.width &&
    a.column.height === b.column.height
  )
}

/**
 * The six-dot grip, drawn in the axis it refers to: two columns for a row, two rows for a column.
 * @param props.axis - which handle this is.
 * @returns the glyph.
 */
function GripGlyph({ axis }: { readonly axis: 'row' | 'column' }): ReactElement {
  const dots = [3, 7].flatMap(x => [3, 7, 11].map(y => ({ x, y })))
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      aria-hidden="true"
      style={axis === 'column' ? { transform: 'rotate(90deg)' } : undefined}
    >
      {dots.map(dot => (
        <circle key={`${String(dot.x)}-${String(dot.y)}`} cx={dot.x} cy={dot.y} r={1.15} fill="currentColor" />
      ))}
    </svg>
  )
}

/**
 * Draw the table handles and their menus.
 * @returns the layer, or nothing while the pointer is away from every table.
 */
export function TableChrome(): ReactElement {
  const [editor] = useLexicalComposerContext()
  const [hover, setHover] = useState<Hover | null>(null)
  const [openMenu, setOpenMenu] = useState<'row' | 'column' | null>(null)
  const [gripHover, setGripHover] = useState<'row' | 'column' | null>(null)
  const [geometry, setGeometry] = useState<Geometry | null>(null)

  const hoverRef = useRef<Hover | null>(null)
  hoverRef.current = hover
  const menuRef = useRef<'row' | 'column' | null>(null)
  menuRef.current = openMenu
  const rowGripRef = useRef<HTMLButtonElement | null>(null)
  const columnGripRef = useRef<HTMLButtonElement | null>(null)

  /** Whether a pointer target is one of the two grips (rather than the document). */
  const overGrip = useCallback((target: Element): boolean => {
    return (
      rowGripRef.current?.contains(target) === true ||
      columnGripRef.current?.contains(target) === true
    )
  }, [])

  useEffect(() => {
    const root = editor.getRootElement()
    if (root === null) return undefined
    let dragging = false

    const drop = (): void => {
      setHover(null)
      setOpenMenu(null)
    }

    /** Read the hover target out of a cell element, or `null` when its table has no observer. */
    const hoverOf = (cell: HTMLElement): Hover | null => {
      const rowElement = cell.closest('tr')
      const tableElement = cell.closest('table')
      if (!(rowElement instanceof HTMLTableRowElement)) return null
      if (!(tableElement instanceof HTMLTableElement)) return null
      const observer = getTableObserverFromTableElement(
        tableElement as unknown as Parameters<typeof getTableObserverFromTableElement>[0],
      )
      if (observer === null) return null
      const row = Array.from(tableElement.rows).indexOf(rowElement)
      const column = Array.from(rowElement.cells).indexOf(cell as HTMLTableCellElement)
      if (row < 0 || column < 0) return null
      return { tableKey: observer.tableNodeKey, row, column }
    }

    /**
     * Whether a pointer position is still on the region the handles belong to.
     *
     * The handles sit just outside the table's left and top edges, so walking from a cell to one of
     * them crosses that strip. It is part of the hover area — without it, the handles would unmount
     * the instant the pointer left the cell, and could never be clicked.
     */
    const onTable = (current: Hover, x: number, y: number): boolean => {
      const tableElement = editor.getElementByKey(current.tableKey)
      if (!(tableElement instanceof HTMLTableElement)) return false
      const rect = tableElement.getBoundingClientRect()
      return (
        x >= rect.left - ROW_GAP - GRIP_SIZE &&
        x <= rect.right &&
        y >= rect.top - COLUMN_GAP - GRIP_SIZE &&
        y <= rect.bottom
      )
    }

    const onPointerMove = (event: PointerEvent): void => {
      if (dragging || menuRef.current !== null) return
      const target = event.target
      if (target instanceof Element && overGrip(target)) return
      const cell = target instanceof Element ? target.closest('td, th') : null
      const current = hoverRef.current
      if (cell instanceof HTMLElement && root.contains(cell)) {
        const next = hoverOf(cell)
        if (next === null) return
        if (
          current === null ||
          current.tableKey !== next.tableKey ||
          current.row !== next.row ||
          current.column !== next.column
        ) {
          setHover(next)
        }
        return
      }
      if (current !== null && onTable(current, event.clientX, event.clientY)) return
      if (current !== null) setHover(null)
    }

    const onPointerDown = (): void => {
      dragging = true
      drop()
    }
    const onPointerUp = (): void => {
      dragging = false
    }
    const onScroll = (): void => {
      drop()
    }

    // Document-level: the handles are portalled to `body`, so a pointer move onto one of them
    // never reaches the editable root. The root only supplies the cell hit test.
    document.addEventListener('pointermove', onPointerMove)
    root.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('pointerup', onPointerUp)
    window.addEventListener('pointercancel', onPointerUp)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onScroll)
    return () => {
      document.removeEventListener('pointermove', onPointerMove)
      root.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('pointercancel', onPointerUp)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onScroll)
    }
  }, [editor, overGrip])

  // Measure the guides whenever the pointer target or the document changes.
  useEffect(() => {
    if (hover === null) {
      setGeometry(null)
      return undefined
    }
    let frame = 0
    const measure = (): void => {
      frame = 0
      const tableElement = editor.getElementByKey(hover.tableKey)
      if (!(tableElement instanceof HTMLTableElement)) {
        setGeometry(null)
        return
      }
      const rowElement = tableElement.rows[hover.row]
      const cellElement = rowElement?.cells[hover.column]
      if (rowElement === undefined || cellElement === undefined) {
        setGeometry(null)
        return
      }
      const tableBox = tableElement.getBoundingClientRect()
      const rowBox = rowElement.getBoundingClientRect()
      const cellBox = cellElement.getBoundingClientRect()
      const next: Geometry = {
        row: { left: rowBox.left, top: rowBox.top, width: rowBox.width, height: rowBox.height },
        column: {
          left: cellBox.left,
          top: tableBox.top,
          width: cellBox.width,
          height: tableBox.height,
        },
      }
      setGeometry(current => (sameGeometry(current, next) ? current : next))
    }
    const schedule = (): void => {
      if (frame !== 0) return
      frame = window.requestAnimationFrame(measure)
    }
    schedule()
    const unregister = editor.registerUpdateListener(schedule)
    const root = editor.getRootElement()
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => schedule())
    if (root !== null) observer?.observe(root)
    window.addEventListener('resize', schedule)
    return () => {
      unregister()
      observer?.disconnect()
      window.removeEventListener('resize', schedule)
      if (frame !== 0) window.cancelAnimationFrame(frame)
    }
  }, [editor, hover])

  const target = useMemo<TableTarget | null>(
    () =>
      hover === null
        ? null
        : tableTargetAtCell(editor, hover.tableKey, hover.row, hover.column),
    [editor, hover],
  )

  const itemsFor = useCallback(
    (axis: 'row' | 'column'): MenuEntry[] => {
      if (target === null) return []
      const rows: MenuEntry[] = []
      const operations = TABLE_EDITS.filter(entry => entry.kind === axis)
      const rowFor = (operation: TableEditOperation): MenuEntry => {
        const reason = refusalOf(operation, target)
        return {
          id: operation.id,
          danger: operation.danger,
          disabled: reason !== null,
          label:
            reason === null ? (
              operation.label
            ) : (
              <span className="md-table-reason-wrap">
                {operation.label}
                <span className="md-table-reason">{reason}</span>
              </span>
            ),
        }
      }
      for (const operation of operations) {
        if (operation.danger !== true) rows.push(rowFor(operation))
      }
      // The four alignments sit between the inserts and the delete, and only a column has them:
      // alignment is a property of a column, not of a row.
      if (axis === 'column') {
        rows.push({ type: 'separator', id: 'sep-align' })
        rows.push({ type: 'label', id: 'label-align', text: '对齐' })
        for (const option of COLUMN_ALIGNMENTS) {
          rows.push({ id: option.id, label: option.label })
        }
      }
      for (const operation of operations) {
        if (operation.danger !== true) continue
        rows.push({ type: 'separator', id: `sep-${operation.id}` })
        rows.push(rowFor(operation))
      }
      return rows
    },
    [target],
  )

  /*
   * The alignment the open column menu should tick. Read during render rather than kept in the
   * target: a target is captured on hover and does not follow an edit, so a cached copy would tick
   * the previous alignment the next time the menu opens.
   */
  const alignment = target !== null && openMenu === 'column' ? columnAlignmentAt(editor, target) : null
  const selectedAlignment =
    alignment === null
      ? undefined
      : COLUMN_ALIGNMENTS.find(option => option.alignment === alignment)?.id

  const choose = useCallback(
    (id: string): void => {
      if (target !== null) {
        const operation = TABLE_EDITS.find(entry => entry.id === id)
        if (operation !== undefined) {
          const applied = applyTableEdit(editor, operation.id, target)
          if (applied) editor.focus()
        } else {
          const option = COLUMN_ALIGNMENTS.find(entry => entry.id === id)
          if (option !== undefined && applyColumnAlignment(editor, option.alignment, target)) {
            editor.focus()
          }
        }
      }
      setOpenMenu(null)
      setHover(null)
    },
    [editor, target],
  )

  if (hover === null || geometry === null || target === null) return <></>

  /*
   * Everything here is portalled to `body`, so it is not clipped by the panel the way the document
   * is. A tall table's column guide would otherwise be drawn over the toolbar, and a handle above
   * the content's top edge would float on top of it. Both are cut to the content's visible band.
   */
  const band = visibleBand(editor.getRootElement())
  const clipToBand = (box: Box): Box | null => {
    const left = Math.max(box.left, band.left)
    const top = Math.max(box.top, band.top)
    const right = Math.min(box.left + box.width, band.right)
    const bottom = Math.min(box.top + box.height, band.bottom)
    if (right - left < 1 || bottom - top < 1) return null
    return { left, top, width: right - left, height: bottom - top }
  }
  const rowGripTop = geometry.row.top + geometry.row.height / 2 - GRIP_SIZE / 2
  const columnGripTop = geometry.column.top - COLUMN_GAP - GRIP_SIZE
  const showRowGrip = rowGripTop >= band.top && rowGripTop + GRIP_SIZE <= band.bottom
  const showColumnGrip = columnGripTop >= band.top && columnGripTop + GRIP_SIZE <= band.bottom

  const rowGripStyle: CSSProperties = {
    position: 'fixed',
    left: geometry.row.left - ROW_GAP - GRIP_SIZE,
    top: rowGripTop,
    zIndex: 50,
    display: showRowGrip ? undefined : 'none',
  }
  const columnGripStyle: CSSProperties = {
    position: 'fixed',
    left: geometry.column.left + geometry.column.width / 2 - GRIP_SIZE / 2,
    top: columnGripTop,
    zIndex: 50,
    display: showColumnGrip ? undefined : 'none',
  }
  const highlightAxis = openMenu ?? gripHover
  const highlight =
    highlightAxis === 'row'
      ? clipToBand(geometry.row)
      : highlightAxis === 'column'
        ? clipToBand(geometry.column)
        : null

  return createPortal(
    <>
      <div style={rowGripStyle}>
        <Menu
          open={openMenu === 'row'}
          anchor={
            <button
              ref={rowGripRef}
              type="button"
              className="md-table-grip"
              aria-label="这一行的操作"
              aria-haspopup="menu"
              aria-expanded={openMenu === 'row'}
              onPointerDown={event => {
                event.preventDefault()
              }}
              onPointerEnter={() => {
                setGripHover('row')
              }}
              onPointerLeave={() => {
                setGripHover(current => (current === 'row' ? null : current))
              }}
              onClick={() => {
                setOpenMenu(current => (current === 'row' ? null : 'row'))
              }}
            >
              <GripGlyph axis="row" />
            </button>
          }
          items={itemsFor('row')}
          onSelect={choose}
          onClose={() => {
            setOpenMenu(null)
          }}
          portal
          side="bottom"
          align="start"
        />
      </div>
      <div style={columnGripStyle}>
        <Menu
          open={openMenu === 'column'}
          anchor={
            <button
              ref={columnGripRef}
              type="button"
              className="md-table-grip"
              aria-label="这一列的操作"
              aria-haspopup="menu"
              aria-expanded={openMenu === 'column'}
              onPointerDown={event => {
                event.preventDefault()
              }}
              onPointerEnter={() => {
                setGripHover('column')
              }}
              onPointerLeave={() => {
                setGripHover(current => (current === 'column' ? null : current))
              }}
              onClick={() => {
                setOpenMenu(current => (current === 'column' ? null : 'column'))
              }}
            >
              <GripGlyph axis="column" />
            </button>
          }
          items={itemsFor('column')}
          selectedId={selectedAlignment}
          onSelect={choose}
          onClose={() => {
            setOpenMenu(null)
          }}
          portal
          side="bottom"
          align="start"
        />
      </div>
      {highlight !== null && (
        <div
          className="md-table-highlight"
          style={{
            left: highlight.left,
            top: highlight.top,
            width: highlight.width,
            height: highlight.height,
          }}
        />
      )}
    </>,
    document.body,
  )
}
