/**
 * 面板左列：仓库路径与目录设置、搜索框与结果、仓库树的滚动容器。
 *
 * 内容
 * - WorkbenchSidebarProps / WorkbenchSidebar。
 * - 本列的布局样式对象（sidebar / sidebarRow / rowActions）。
 *
 * 行为
 * - 未关联仓库：一个「关联文档仓库」按钮，下面是插件自带的示例文档。
 * - 已关联：路径与目录菜单、文档区标题与搜索 / 新建两个控件、可滚动的树。
 * - 搜索打开时结果替换树；树自己滚动并记住位置。
 * - ⋯ / 右键打开的菜单是 `Dialogs` 那一张；这里只提供锚与目标。
 *
 * 边界
 * - 不拥有搜索状态（useVaultSearch）、不打开文档、不执行命令（只把 id 与目标交回）。
 * - 不拥有树的展开 / 拖动状态。
 *
 * 相关文件
 * - 依赖：workbench/Tree.tsx、useVaultSearch、primitives、shared/documents、shared/paths、treeOrder。
 * - 被依赖：MarkdownWorkbench.tsx。
 *
 * 改哪里
 * - 改左列结构：WorkbenchSidebar。
 * - 改行的外观：sidebar.module.css。
 */
import type { DragEvent, ReactElement } from 'react'
import { useEffect, useState, type RefObject } from 'react'
import {
  Button,
  FileTypeIcon,
  IconCloseFillRegular,
  IconPlusOutlineRegular,
  IconSearchOutlineRegular,
  IconSettingsOutlineRegular,
  Menu,
  PathLabel,
  type MenuEntry,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { childPath } from '../../shared/paths'
import { documentLabel, isDocument } from '../../shared/documents'
import { basenameOf } from '../../shared/paths'
import type { DropSource } from '../treeDrop'
import type { TreeOrders } from '../treeOrder'
import type { DragState, LevelState, TreeTarget } from './model'
import type { VaultSearch } from './useVaultSearch'
import { WorkbenchTree } from './Tree'
import styles from '../sidebar.module.css'

/**
 * The left column.
 *
 * Not a `nav` with everything in it: the tree is the only part that scrolls, the headers sit
 * above it, and the search replaces the tree rather than opening over it. Those three facts are
 * the shape of this file.
 */
const sidebar: React.CSSProperties = {
  borderRight: '.5px solid var(--dsw-alias-border-l2)',
  // Vertical only. The horizontal inset lives on the rows, so nothing outside the scrolling region
  // can move the scrollbar off the line — which is why there is no gutter to publish and no
  // negative margin to undo it.
  padding: '10px 0',
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  minWidth: 0,
  // The other half of letting `.treeBody` scroll.
  //
  // A flex or grid item's `min-height: auto` does not apply while its own `overflow` is not
  // `visible` — which is why this box scrolled fine back when it carried `overflowY: auto`.
  // Taking that away re-armed it: the column's minimum became its content height, it grew
  // past the grid row, and the tree was handed all the height it asked for, so nothing
  // overflowed and nothing scrolled.
  minHeight: 0,
} as React.CSSProperties

const rowActions: React.CSSProperties = {
  display: 'flex',
  gap: 6,
  margin: '4px 8px 6px',
  flexWrap: 'wrap',
}

/**
 * A flat, full-width row in the styles.
 *
 * Shared by the two sample rows in the unassociated state, which are the only rows shown outside a
 * tree — a tree row carries its own indent and disclosure affordance, and these have neither.
 */
const sidebarRow: React.CSSProperties = {
  width: '100%',
  justifyContent: 'flex-start',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
}

/** What the left column draws and reports. */
export interface WorkbenchSidebarProps {
  /** The authorized root, or `null`. */
  readonly root: string | null
  /** Which kind of root is showing. */
  readonly vaultKind: 'sample' | 'user' | null
  /** Loaded levels, keyed by absolute directory. */
  readonly levels: Record<string, LevelState>
  /** Expanded directory paths. */
  readonly expanded: readonly string[]
  /** The writer's arrangement. */
  readonly orders: TreeOrders
  /** The order document has been read (the tree waits for it). */
  readonly ordersReady: boolean
  /** The showing document. */
  readonly activePath: string | null
  /** A write / directory operation is in flight. */
  readonly busy: boolean
  /** Whether rows may be dragged. */
  readonly canDrag: boolean
  /** The drag in flight, if any. */
  readonly dragging: DragState | null
  /** The path whose row menu is open. */
  readonly menuOpenPath: string | null
  /** The tree's scrollport; the caller's drag auto-scroll reads it too. */
  readonly treeRef: RefObject<HTMLDivElement>
  /** The search box's state and actions. */
  readonly search: VaultSearch
  /** Rows for the directory settings menu. */
  readonly vaultMenuRows: readonly MenuEntry[]
  /** Rows for the 新建 menu. */
  readonly createMenuRows: readonly MenuEntry[]
  /** The root as a command target. */
  readonly rootEntry: TreeTarget | null
  /** Whether `chooseVault` may run. */
  readonly canChooseVault: boolean
  /** Where the tree's own scroll was left. */
  readonly initialTreeScroll: number
  onTreeScroll(top: number): void
  /** The pointer left the tree: forget the hovered row. */
  onRowLeave(): void
  onCommand(id: string, target: TreeTarget | null): void
  onOpenFile(path: string): void
  onToggleDirectory(path: string): void
  onRowMenu(target: TreeTarget, anchor: () => DOMRect | null): void
  onCloseRowMenu(): void
  onRowHover(node: Element, target: TreeTarget): void
  onDragStart(event: DragEvent<HTMLElement>, source: DropSource): void
  onDragEnd(): void
  onDragOver(event: DragEvent<HTMLElement>, source: DropSource, parent: string): void
  onDrop(event: DragEvent<HTMLElement>, source: DropSource, parent: string): void
}

/**
 * The left column.
 * @param props - the vault, the tree's state, and the search box.
 * @returns the column.
 */
export function WorkbenchSidebar(props: WorkbenchSidebarProps): ReactElement {
  /** Which sidebar menu is showing, if any. Local: it is transient UI state. */
  const [sidebarMenu, setSidebarMenu] = useState<'settings' | 'create' | null>(null)

  // The tree mounts with its rows already in the snapshot, so one frame is enough to place it.
  useEffect(() => {
    const node = props.treeRef.current
    if (node === null) return undefined
    const frame = requestAnimationFrame(() => {
      node.scrollTop = props.initialTreeScroll
    })
    return () => cancelAnimationFrame(frame)
    // The offset is the value the panel was restored with; re-scrolling on every change would
    // fight the pointer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <nav style={sidebar} aria-label="文档来源">
      {props.vaultKind !== 'user' ? (
        <>
          {/*
            Unassociated. The only thing the writer can do here is pick a directory, so there is one
            control — no path (the samples are the plugin's own memory documents and have no
            location on disk), no file operations (the samples are not theirs to reorganise), and no
            tree (there is nothing to expand).

            No section heading either: this state has one group and one verb, and a label above them
            said "VAULT" while showing no vault.
          */}
          <div style={rowActions}>
            <button
              type="button"
              className={styles.primaryAction}
              disabled={!props.canChooseVault}
              onClick={() => props.onCommand('chooseVault', null)}
            >
              关联文档仓库
            </button>
          </div>
          {props.root !== null && (
            <>
              {/*
                A label, because these are the plugin's own documents rather than the writer's.
                Without it, two strange files appearing in the sidebar read as something they are
                supposed to have made.
              */}
              <div className={styles.label} style={{ marginTop: 10 }}>
                示例
              </div>
              {(props.levels[props.root]?.entries ?? [])
                .filter(entry => entry.type === 'file' && isDocument(entry.name))
                .map(entry => (
                  <Button
                    key={entry.name}
                    size="sm"
                    variant="ghost"
                    icon={<FileTypeIcon path={entry.name} size={16} />}
                    title={entry.name}
                    onClick={() => props.onOpenFile(childPath(props.root ?? '', entry.name))}
                    style={sidebarRow}
                  >
                    {documentLabel(entry.name)}
                  </Button>
                ))}
            </>
          )}
        </>
      ) : (
        props.root !== null && (
          <>
            {/*
              The path, and behind one icon everything that acts on the whole directory. The path
              says what the directory is; this menu says what can be done to it; the line below is
              left for its documents.
            */}
            <div className={styles.pathRow}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <PathLabel path={props.root} />
              </div>
              <Menu
                open={sidebarMenu === 'settings'}
                portal
                align="end"
                autoFocus
                anchor={
                  <Button
                    size="sm"
                    variant="ghost"
                    className={styles.iconButton}
                    icon={<IconSettingsOutlineRegular size={16} />}
                    aria-label="目录设置"
                    title="目录设置"
                    aria-expanded={sidebarMenu === 'settings'}
                    // Menu owns no toggle — its props are open/anchor/items/onSelect/onClose and
                    // nothing that opens it. The anchor carries the click, the way the shell's own
                    // icon-button menus do.
                    onClick={() =>
                      setSidebarMenu(current => (current === 'settings' ? null : 'settings'))
                    }
                  />
                }
                items={props.vaultMenuRows}
                onSelect={id => {
                  setSidebarMenu(null)
                  props.onCommand(id, props.rootEntry)
                }}
                onClose={() => setSidebarMenu(null)}
              />
            </div>

            {/*
              The section heading and its two controls.

              The field opens out of its own icon and then owns the whole row: the heading hides and
              the create button is squashed, which is what leaves the field the entire width to
              overhang into. Widening the slot is the whole animation.
            */}
            <div className={styles.sectionHeader}>
              <div className={styles.heading} data-hidden={props.search.open}>
                文档区
              </div>
              <div className={styles.slot} data-open={props.search.open}>
                <div
                  ref={props.search.rootRef}
                  className={styles.field}
                  data-open={props.search.open}
                  // The shell puts the expand on the field itself, so the whole box is the target —
                  // while collapsed that is still just the icon, because the box is one icon wide.
                  onClick={() => props.search.openBox()}
                >
                  <button
                    type="button"
                    className={styles.iconButton}
                    data-open={props.search.open}
                    data-inherit="true"
                    aria-label="搜索文档"
                    title="搜索文档"
                    aria-expanded={props.search.open}
                    // Expanding is the icon's only job here; closing belongs to the close control
                    // the open field carries, the way the shell divides them.
                    onClick={() => props.search.openBox()}
                  >
                    <IconSearchOutlineRegular size={props.search.open ? 11 : 14} />
                  </button>
                  <input
                    ref={props.search.inputRef}
                    className={styles.input}
                    type="text"
                    value={props.search.query}
                    data-open={props.search.open}
                    placeholder="搜索…"
                    aria-label="搜索仓库"
                    // Mounted while collapsed too, so it has somewhere to fade in from; until it is
                    // on screen it must not be a tab stop.
                    tabIndex={props.search.open ? undefined : -1}
                    onChange={event => props.search.setQuery(event.target.value)}
                    onCompositionStart={() => props.search.setComposing(true)}
                    onCompositionEnd={event => {
                      // The field's value, not the event's. Browsers differ on whether the final
                      // input event lands before or after this one, so in some the event carries
                      // the composed text and in others the text from before composing began.
                      props.search.setQuery(
                        props.search.inputRef.current?.value ?? event.currentTarget.value,
                      )
                      props.search.setComposing(false)
                    }}
                    onKeyDown={event => {
                      // Enter is an override, not the trigger: the debounce is a delay, and this
                      // says the writer has finished and wants it now.
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        props.search.submit()
                      }
                      if (event.key === 'Escape') {
                        event.preventDefault()
                        props.search.close()
                      }
                    }}
                  />
                  {props.search.open && (
                    <button
                      type="button"
                      className={`${styles.iconButton} ${styles.clearButton}`}
                      aria-label="关闭搜索"
                      title="关闭搜索"
                      // Stops the click reaching the field, which would take it as a request to
                      // open and focus the box being dismissed.
                      onClick={event => {
                        event.stopPropagation()
                        props.search.close()
                      }}
                    >
                      <IconCloseFillRegular />
                    </button>
                  )}
                </div>
              </div>
              <div className={styles.actions} data-hidden={props.search.open}>
                <Menu
                  open={sidebarMenu === 'create'}
                  portal
                  align="end"
                  autoFocus
                  anchor={
                    <Button
                      size="sm"
                      variant="ghost"
                      className={styles.iconButton}
                      icon={<IconPlusOutlineRegular size={16} />}
                      aria-label="新建"
                      title="新建"
                      aria-expanded={sidebarMenu === 'create'}
                      onClick={() =>
                        setSidebarMenu(current => (current === 'create' ? null : 'create'))
                      }
                    />
                  }
                  items={props.createMenuRows}
                  onSelect={id => {
                    setSidebarMenu(null)
                    props.onCommand(id, props.rootEntry)
                  }}
                  onClose={() => setSidebarMenu(null)}
                />
              </div>
            </div>

            {/*
              The tree, and the only part of this panel that scrolls.

              `treeRef` and the scroll memory move here with it: both mean "the tree's scrollport",
              and the element that now scrolls is this one, not the panel.
            */}
            <div
              ref={props.treeRef}
              className={styles.treeBody}
              // Leaving the tree forgets the row, so a pointer that has moved on to the editor
              // cannot leave F2 aimed at the last row it crossed. This is the only half that needs
              // the container: entering a row is the row's own business.
              onPointerLeave={() => props.onRowLeave()}
              onScroll={event => props.onTreeScroll(event.currentTarget.scrollTop)}
            >
              {props.search.open && props.search.result !== null ? (
                <div style={{ padding: '0 4px' }}>
                  {props.search.result.truncated ? (
                    <div className={styles.status}>
                      {/* No count: the Host does not say how many were left out, and a number
                          invented here would be the one thing on screen that could be wrong. */}
                      结果过多，只显示了一部分
                    </div>
                  ) : null}
                  {props.search.result.unavailable !== undefined ? (
                    <div className={styles.status}>{props.search.result.unavailable}</div>
                  ) : props.search.result.files.length === 0 ? (
                    <div className={styles.status}>
                      {props.search.searching ? '搜索中…' : '（无匹配）'}
                    </div>
                  ) : (
                    props.search.result.files.map(file => (
                      <div key={file.path}>
                        <div className={styles.resultFile} title={file.path}>
                          {basenameOf(file.path)}
                        </div>
                        {file.matches.map((match, index) => (
                          <Button
                            key={`${file.path}:${String(match.line)}:${String(index)}`}
                            size="sm"
                            variant="ghost"
                            title={`${file.path}:${String(match.line)}`}
                            style={sidebarRow}
                            onClick={() => {
                              // The hit travels with the request: the path to open, and what to
                              // mark.
                              props.search.setPendingHit({
                                path: file.path,
                                term: props.search.query.trim(),
                                ordinal: index,
                                total: file.matches.length,
                              })
                              props.onOpenFile(file.path)
                            }}
                          >
                            <span className={styles.lineNumber}>{match.line}</span>
                            {match.text.trim()}
                          </Button>
                        ))}
                      </div>
                    ))
                  )}
                </div>
              ) : !props.ordersReady ? (
                /*
                  The order document is still being read.

                  Nothing rather than the filesystem's own order: the rows are about to be
                  rearranged, and drawing them once in the wrong order and then moving them under
                  the writer's eyes is the one moment where the wrong order is certain rather than
                  possible. It is one file read, on mount.
                */
                null
              ) : (
                <WorkbenchTree
                  levels={props.levels}
                  root={props.root}
                  orders={props.orders}
                  expanded={props.expanded}
                  activePath={props.activePath}
                  busy={props.busy}
                  canDrag={props.canDrag}
                  dragging={props.dragging}
                  menuOpenPath={props.menuOpenPath}
                  onToggleDirectory={path => props.onToggleDirectory(path)}
                  onOpenFile={path => props.onOpenFile(path)}
                  onRowMenu={(target, anchor) => props.onRowMenu(target, anchor)}
                  onCloseRowMenu={() => props.onCloseRowMenu()}
                  onRowHover={(node, target) => props.onRowHover(node, target)}
                  onDragStart={(event, source) => props.onDragStart(event, source)}
                  onDragEnd={() => props.onDragEnd()}
                  onDragOver={(event, source, parent) => props.onDragOver(event, source, parent)}
                  onDrop={(event, source, parent) => props.onDrop(event, source, parent)}
                />
              )}
            </div>
          </>
        )
      )}
    </nav>
  )
}
