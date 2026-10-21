/**
 * 仓库树的每一层：文件夹与文档行、展开、选中、拖动落点、行菜单按钮。
 *
 * 内容
 * - WorkbenchTreeProps / WorkbenchTree；内部 renderLevel（递归）与 entryMenuButton。
 *
 * 行为
 * - 一层画完画它展开的子层；目录行带展开箭头与文件夹图标，文档行按显示名。
 * - 行的顺序 = `orderEntries(visibleEntries(entries), orders.orders[key])`。
 * - 拖动标记（线上 / 线下 / 进入）由 dragging.zone 决定；被拒绝的落点不画任何标记。
 * - 行菜单的「开着」只由 menuOpenPath 决定；⋯ 按钮自己不做 toggle 判断之外的事。
 *
 * 边界
 * - 不读文件、不写顺序文档、不执行移动（这些在组合根 / 树的 feature 里）。
 * - 不认识搜索与空状态（那是左列的其余部分）。
 *
 * 相关文件
 * - 依赖：treeOrder、treeDrop、shared/documents、shared/paths、sidebar.module.css、primitives。
 * - 被依赖：MarkdownWorkbench.tsx（左列）。
 *
 * 改哪里
 * - 改行外观：本文件与 sidebar.module.css。
 * - 改拖动期间的行状态：dragging / zone 的绘制。
 */
import { Fragment, type CSSProperties, type DragEvent, type ReactElement, type ReactNode } from 'react'
import {
  IconEllipsisOutlineRegular,
  IconFolderCloseRegular,
  IconFolderOpenRegular,
  Tag,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { childPath, relativePath, samePath } from '../../shared/paths'
import { documentLabel, visibleEntries } from '../../shared/documents'
import { orderEntries, type TreeOrders } from '../treeOrder'
import type { DropSource } from '../treeDrop'
import type { DragState, LevelState, TreeTarget } from './model'
import styles from '../sidebar.module.css'

/** What the tree draws and reports. */
export interface WorkbenchTreeProps {
  /** Loaded levels, keyed by absolute directory. */
  readonly levels: Record<string, LevelState>
  /** The authorized root, or `null` when nothing is loaded. */
  readonly root: string | null
  /** The writer's arrangement, keyed by relative directory. */
  readonly orders: TreeOrders
  /** Expanded directory paths. */
  readonly expanded: readonly string[]
  /** The showing document, for the selected row. */
  readonly activePath: string | null
  /** A write / directory operation is in flight; document rows are disabled. */
  readonly busy: boolean
  /** Whether rows may be dragged (user vault, not busy). */
  readonly canDrag: boolean
  /** The drag in flight, if any. */
  readonly dragging: DragState | null
  /** The path whose row menu is open, or `null`. */
  readonly menuOpenPath: string | null
  onToggleDirectory(path: string): void
  onOpenFile(path: string): void
  onRowMenu(target: TreeTarget, anchor: () => DOMRect | null): void
  onCloseRowMenu(): void
  onRowHover(node: Element, target: TreeTarget): void
  onDragStart(event: DragEvent<HTMLElement>, source: DropSource): void
  onDragEnd(): void
  onDragOver(event: DragEvent<HTMLElement>, source: DropSource, parent: string): void
  onDrop(event: DragEvent<HTMLElement>, source: DropSource, parent: string): void
}

/**
 * The whole tree, one level deep at a time.
 * @param props - levels, order, expansion and the row events.
 * @returns the root level, or `null` while nothing is loaded.
 */
export function WorkbenchTree(props: WorkbenchTreeProps): ReactElement | null {
  const entryMenuButton = (target: TreeTarget, open: boolean): ReactElement => (
    <span className={styles.rowActions}>
      <button
        type="button"
        className={styles.rowMore}
        aria-label={`更多操作：${target.name}`}
        aria-expanded={open}
        onClick={event => {
          const button = event.currentTarget
          if (props.menuOpenPath === target.path) {
            props.onCloseRowMenu()
            return
          }
          props.onRowMenu(target, () =>
            button.isConnected ? button.getBoundingClientRect() : null,
          )
        }}
      >
        <IconEllipsisOutlineRegular size={16} />
      </button>
    </span>
  )

  /**
   * Render one directory level and, recursively, its expanded children.
   * @param path - absolute directory.
   * @param depth - indentation depth.
   * @returns the rows, or `null` while the level is unknown.
   */
  const renderLevel = (path: string, depth: number): ReactElement | null => {
    const level = props.levels[path]
    if (level === undefined) return null

    // The shell's list carries its indentation as a custom property that the row reads —
    // `padding-inline-start: calc(8px + var(--dsh-workspace-indent, 0px))` — so the step lives in
    // one place instead of on every row. 18px is the step the shell's own file tree indents by
    // (`.level .level { padding-left: 18px }`).
    const indent = { '--dsh-workspace-indent': `${String(depth * 18)}px` } as CSSProperties

    if (level.status === 'loading') {
      return (
        <div
          key={`${path}:loading`}
          style={{ ...indent, padding: '4px 8px', opacity: 0.5, fontSize: 12 }}
        >
          加载中…
        </div>
      )
    }
    if (level.status === 'failed') {
      return (
        <div key={`${path}:failed`} style={{ ...indent, padding: '4px 8px' }}>
          <Tag tone="danger">{level.message ?? '读取失败'}</Tag>
        </div>
      )
    }

    const key = props.root === null ? null : relativePath(props.root, path)
    /**
     * The rows this level draws, in the order it draws them.
     *
     * Two rules in one expression, and they are the whole of what dragging does to the tree:
     * `visibleEntries` decides what a row is (the same answer the drag's write-back needs), and
     * `orderEntries` puts the writer's arrangement in front of the filesystem's.
     */
    const shown = orderEntries(
      visibleEntries(level.entries),
      key === null ? undefined : props.orders.orders[key],
    )

    const rows: ReactNode[] = []
    for (const entry of shown) {
      const child = childPath(path, entry.name)
      /**
       * This row's entry, built once and handed to all three of its handlers — the pointer (which
       * is F2's target), the context menu, and the ⋯ button — so one row cannot come to describe
       * itself three slightly different ways.
       */
      const target: TreeTarget = {
        path: child,
        name: entry.name,
        isDirectory: entry.type === 'directory',
      }
      /**
       * Whether the entry menu is this row's.
       *
       * Compared as the exact string this row hands to the menu, so there is no spelling question
       * in it — unlike the path lookups that made F2 miss on a root spelled with a trailing
       * separator.
       */
      const menuOpen = props.menuOpenPath === child
      /** This row as the drag sees it: a thing with a name, in a directory. */
      const carried: DropSource = { ...target, parent: path }
      /**
       * Where the carried row would land, when it is over this one.
       *
       * One zone decides all three marks — the line above, the line below, and the folder lit up
       * as "into me" — and a refused zone draws none of them: the cursor says no, and a line that
       * appeared and then did nothing would say less than nothing.
       */
      const zone =
        props.dragging !== null &&
        props.dragging.zone !== null &&
        props.dragging.zone.path === child
          ? props.dragging.zone
          : null
      const mark =
        zone === null || zone.refusal !== null
          ? ''
          : zone.kind === 'before'
            ? ` ${styles.rowDropBefore}`
            : zone.kind === 'after'
              ? ` ${styles.rowDropAfter}`
              : ` ${styles.rowDropInto}`
      /**
       * The drag wiring, the way the shell's own row carries it: `draggable`, a payload for
       * whatever is outside, and the three events that say where it may land. `onDragEnd` clears
       * the state so a cancelled drag leaves nothing behind.
       */
      const dragProps = {
        draggable: props.canDrag,
        onDragStart: (event: DragEvent<HTMLElement>) => props.onDragStart(event, carried),
        onDragEnd: () => props.onDragEnd(),
        onDragOver: (event: DragEvent<HTMLElement>) => props.onDragOver(event, carried, path),
        onDrop: (event: DragEvent<HTMLElement>) => props.onDrop(event, carried, path),
      }

      if (entry.type === 'directory') {
        const isOpen = props.expanded.includes(child)
        // The row and its expanded level must not be siblings carrying the same `key`: a
        // directory's row and the level it opens are two elements, and pushing both with
        // `key={child}` makes React see duplicate keys in one array, whose behaviour is undefined
        // — it renders duplicated rows.
        rows.push(
          <Fragment key={child}>
            {/*
              The row's box, and the element the stylesheet hangs the surface on. The label button
              and the ⋯ are its two children, which is the one structural difference from the
              shell's workspace list: there the whole row is a `div` with `role="treeitem"`, here
              the label stays a real button so it keeps its keyboard activation and its `disabled`
              state.
            */}
            <div
              className={`${styles.rowWrap}${mark}`}
              data-menu-open={menuOpen}
              {...dragProps}
              onPointerEnter={event => {
                props.onRowHover(event.currentTarget, target)
              }}
              onContextMenu={event => {
                event.preventDefault()
                // The pointer's coordinates, captured now: this closure is called on every frame
                // while the card is up, and it must not read a live event.
                const x = event.clientX
                const y = event.clientY
                props.onRowMenu(target, () => new DOMRect(x, y, 0, 0))
              }}
            >
              {/*
                Not a `DisclosureRow`: that primitive owns its own appearance, and what a folder
                row needs here is the workspace list's — a fixed height, the arrow beside the name,
                and a glyph that gives way to the arrow under the pointer, none of which the
                primitive exposes.
              */}
              <button
                type="button"
                className={`${styles.row} ${styles.rowFolder}`}
                title={entry.name}
                aria-expanded={isOpen}
                onClick={() => props.onToggleDirectory(child)}
              >
                <span className={`${styles.rowIcon}${isOpen ? ` ${styles.rowIconOpen}` : ''}`}>
                  {/*
                    Two states, two glyphs — the pair both official file trees draw:

                      expanded ? <IconFolderOpenRegular …/> : <IconFolderCloseRegular …/>

                    Read out of `@deepseek-ai/dsh-client-ui-sidebar-files` (`client.js:507`, the
                    file tree) and the desktop workspace (`dsh-client-ui-workspace`,
                    `client.js:1301`), which agree. No `size`: neither package passes one, and each
                    icon's drawn size decides. No colour either — the glyph is a direct child of
                    `.rowIcon`, so it takes that box's `--dsw-alias-label-tertiary`.

                    A folder is open or closed — two states, and the glyph needs no wrapper.
                  */}
                  {isOpen ? <IconFolderOpenRegular /> : <IconFolderCloseRegular />}
                </span>
                <span className={styles.rowTitle}>{entry.name}</span>
              </button>
              {entryMenuButton(target, menuOpen)}
            </div>
            {isOpen ? renderLevel(child, depth + 1) : null}
          </Fragment>,
        )
        continue
      }

      const active =
        props.activePath !== null && samePath(props.activePath, child)
      rows.push(
        <div
          key={child}
          className={`${styles.rowWrap}${active ? ` ${styles.rowSelected}` : ''}${mark}`}
          data-menu-open={menuOpen}
          {...dragProps}
          onPointerEnter={event => {
            // Hover is the whole condition, documents and folders alike. See the ref's doc:
            // requiring the document to be the open one was the reader's rule, and it read as
            // "F2 does nothing" for every other row.
            props.onRowHover(event.currentTarget, target)
          }}
          onContextMenu={event => {
            event.preventDefault()
            const x = event.clientX
            const y = event.clientY
            props.onRowMenu(target, () => new DOMRect(x, y, 0, 0))
          }}
        >
          {/*
            A plain button rather than a `Button` or a `DisclosureRow`: a file has nothing to
            disclose, and the workspace list draws its rows this way — which is what lets the row
            take that list's shape rather than a text button's, and what leaves the background to
            the stylesheet so the selected row can differ from a hovered one.
          */}
          <button
            type="button"
            className={`${styles.row} ${styles.rowFile}`}
            title={entry.name}
            disabled={props.busy}
            onClick={() => props.onOpenFile(child)}
          >
            {/*
              No icon slot, and none is reserved.

              A 16px empty box would line a document's name up with a folder's, but it also pushes
              every document's name 16px in from the row's left edge while a folder's glyph sits at
              that edge. Read down the tree, that offset says "this row belongs to the one above
              it", which a document is not.

              A folder's name follows its glyph; a document's name starts where that glyph starts.
              That is the file manager's own convention, and it is what makes the two row kinds
              tell the truth about their level.
            */}
            <span className={styles.rowTitle}>{documentLabel(entry.name)}</span>
          </button>
          {entryMenuButton(target, menuOpen)}
        </div>,
      )
    }

    if (rows.length === 0) {
      return (
        <div
          key={`${path}:empty`}
          style={{ ...indent, padding: '4px 8px', opacity: 0.45, fontSize: 12 }}
        >
          （无可显示的文档）
        </div>
      )
    }
    return (
      <div key={path} className={styles.level} style={indent}>
        {rows}
      </div>
    )
  }

  return props.root === null ? null : renderLevel(props.root, 0)
}
