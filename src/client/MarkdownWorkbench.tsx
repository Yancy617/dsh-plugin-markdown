/**
 * Markdown 工作台：组合根 —— 状态、跨功能用例、面板快照与外壳接线。
 *
 * 内容
 * - 状态与 effect：打开的文档（buffers / tabs / active）、写盘调度、大文档保护、快捷键。
 * - 组合的 hook：仓库会话 / 搜索 / 网页标签 / 树操作 / 文档目录列 / 提示层 / 面板快照 /
 *   自动保存调度 / 关闭三态（workbench/ 下的 use*.ts）。
 * - 跨功能用例：换目录 / 撤销授权 / 路径跟随（改名、移动、删除之后）。
 * - MarkdownWorkbench（面板组件）：组合 workbench/ 的视图、命令表与树操作。
 *
 * 行为
 * - 左侧是仓库树（真实目录或插件自带样例），右侧是编辑器 / 源码 / 网页标签。
 * - 每篇打开的文档在 documentSessions 里有一份撤销历史；切标签 / 切面板保留，关闭 / 重新载入丢弃，
 *   源码视图是只读查看，不进历史。
 * - 关闭标签默认保存并关闭（立即执行，保存期间冻结）；失败才弹窗，可重试 / 放弃更改 / 取消。
 * - 自动保存按 savePlan + autoSave 的节奏；只读文档拒绝写入；版本冲突先重读分类，假冲突自动恢复，
 *   真冲突弹窗二选一（保留我的＝先留磁盘副本再强制写 / 用磁盘的＝按路径重载）。
 * - 回面板时按 stat 比版本（Host 没有该路由时退回 read），不整篇下载。
 * - 打开、保存、自动保存、关闭、重命名、移动、删除都走 vaultClient 的 Host 路由。
 * - 树的顺序存在 <vault>/.config/tree.json；拖动 / 移动会同步。
 * - 通知浮在编辑带上；查找条在工具条里；命令面板列出工作台与编辑器命令。
 *
 * 边界
 * - 不实现 Host 路由（src/host）与 Markdown 解析（editor/documentMarkdown）。
 * - 不改平台右栏布局（webPage.ts）。
 * - 不定义“什么算文档”（shared/documents）与路径拼写（shared/paths）。
 * - 不画面板的盒子（workbench/{Tabs,Toolbar,Band,Dialogs}.tsx）与命令表
 *   （workbench/commands.ts）——这里只给它们数据与回调。
 * - 不做树上的拖动 / 移动事务与三个入口对话框（workbench/useTreeOperations.ts）。
 * - 不管目录列的内容、宽度、当前行与跳转（workbench/useOutlineColumn.ts），只把它的结果交给编辑带。
 * - 不管提示的文案与寿命（workbench/useNotices.ts），也不管快照怎么写（workbench/useWorkbenchSnapshot.ts）。
 *
 * 相关文件
 * - 依赖：editor/*、vaultClient、treeDrop、autoSave、savePlan、readOnly、layout、shortcuts、
 *   NoticeStack、CommandPalette、webPage、documentSessions、shared/{documents,paths,errors,protocol}、
 *   workbench/{model,commands,repath,buffers,Tabs,Toolbar,Band,Dialogs,Sidebar,
 *   useVaultSearch,useWebTabs,useVaultSession,useTreeOperations,useOutlineColumn,useNotices,
 *   useWorkbenchSnapshot,useWriteScheduler,useCloseProtocol}。
 * - 被依赖：index.tsx。
 *
 * 改哪里
 * - 改命令：workbench/commands.ts。
 * - 改保存：本文件的写路径与 workbench 之外的 autoSave / savePlan。
 * - 改拖动 / 移动 / 新建改名删除：workbench/useTreeOperations.ts。
 * - 改目录列：workbench/useOutlineColumn.ts。
 * - 改提示：workbench/useNotices.ts；改快照：workbench/useWorkbenchSnapshot.ts。
 * - 改面板几何：workbench/Band.tsx 等盒子与 sidebar.module.css。
 */
import {
  writeClipboard,
  type MenuEntry,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { type LexicalEditor } from 'lexical'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { describeStats, statsOf } from './editor/document'
import { useDelayedValue } from './workbench/useDelayedValue'
import {
  PACKAGE_NAME,
  ERR_STALE,
  SAMPLE_READ_ONLY_MESSAGE,
  type VaultReadResult,
} from '../shared/protocol'
import { clearMarks } from './editor/highlight'
import type { WorkbenchStore } from './workbenchStore'
import type { DocumentSessions } from './documentSessions'
import { readOnlyDocument } from './readOnly'
import { planSaveSource, hasUnsaved, utf8Length } from './savePlan'
import {
  OUTLINE_AUTO_BYTES,
  SLOW_IMPORT_MS,
  largeBand,
  slowOpenNotice,
} from './largeDocument'
import { classifyStaleWrite } from './staleWrite'
import {
  beginWrite,
  enqueue,
  endWrite,
  forgetWrites,
  invalidate,
  isCurrent,
  noteWrite,
  writeReport,
} from './autoSave'
import type { OpenWebPage } from './webPage'
import type { PaletteEntry } from './CommandPalette'
import { currentDevice, shortcutFor, type Shortcut } from './shortcuts'
import styles from './sidebar.module.css'
import { messageOf } from '../shared/errors'
import { basenameOf, dirnameOf, samePath } from '../shared/paths'
import { documentLabel, nextCopyName } from '../shared/documents'
import { repathList, repathRecord, repathUnder } from './workbench/repath'
import { closeTabs, patchBuffers, withBuffer, withoutBuffers } from './workbench/buffers'
import {
  createWorkbenchCommands,
  menuRowsFor,
  pickCommands,
  type WorkbenchCommand,
} from './workbench/commands'
import { WorkbenchTabs } from './workbench/Tabs'
import { WorkbenchToolbar } from './workbench/Toolbar'
import { WorkbenchDialogs } from './workbench/Dialogs'
import { WorkbenchBand } from './workbench/Band'
import { WorkbenchSidebar } from './workbench/Sidebar'
import { useVaultSearch } from './workbench/useVaultSearch'
import { useWebTabs } from './workbench/useWebTabs'
import { useTreeOperations } from './workbench/useTreeOperations'
import { useVaultSession } from './workbench/useVaultSession'
import { useOutlineColumn } from './workbench/useOutlineColumn'
import { useWorkbenchSnapshot } from './workbench/useWorkbenchSnapshot'
import { useNotices, RECEIPT_MS } from './workbench/useNotices'
import { useWriteScheduler } from './workbench/useWriteScheduler'
import { useCloseProtocol } from './workbench/useCloseProtocol'
import { clearStoredVault, storeVault } from './vaultMemory'
import { reportQuietly } from './reportQuietly'
import type {
  BufferState,
  CloseResult,
  ConflictState,
  LargeDocumentOpen,
  LargeOpenChoice,
  OpenFailure,
  RowMenu,
  TreeTarget,
  WorkbenchSnapshot,
  WriteOutcome,
} from './workbench/model'
import { SIDEBAR_WIDTH } from './layout'
import { applyBlockOperation, BLOCK_OPERATIONS } from './editor/operations'
import {
  applyTableEdit,
  refusalOf,
  tableTargetAtSelection,
  TABLE_EDITS,
  type TableTarget,
} from './editor/tableEdit'
import { fetchUpdateCheck } from './updateClient'
import { VaultRequestError } from './request'
import {
  authorizeVault,
  copyEntry,
  fetchSampleVault,
  listDirectory,
  readFile,
  readSampleDocument,
  revealEntry,
  revokeVault,
  statFile,
  writeAsset as writeAssetRoute,
  writeFile,
} from './vaultClient'


/**
 * 从整篇文本派生的读数（字数、源码视图的目录）停手多久之后才算（毫秒）。
 *
 * 两件都只能从文本读，而一次结构解析（`editor/outline.ts` 的 mdast 那一趟）在 427 行、
 * 7 KB 的真实文档上是 **16 ms** —— 跟着每次击键跑会卡输入。200 ms 只够把"一段连续打字"合成一次：
 * 停手之后才更新，而源码视图的目录本来就只是给人看的（那里的点行不滚动）。
 */
const DERIVED_TEXT_DELAY = 200

/** Props supplied by this package's own registration. */
export interface MarkdownWorkbenchProps {
  /**
   * Open the host's native directory picker.
   * @returns the chosen directory, or `null` when cancelled.
   */
  readonly pickDirectory: () => Promise<string | null>
  /** Remembers workbench state across the panel switches that unmount it. */
  readonly store: WorkbenchStore<WorkbenchSnapshot>
  /** Keeps each open document's undo/redo history, independent of the editor view. */
  readonly sessions: DocumentSessions
  /**
   * How a web page in the editor opens: the platform's own browser tab when it is
   * reachable, the system browser otherwise (`./webPage.ts` owns the decision).
   */
  readonly openWebPage: OpenWebPage
}

/* Layout only. Every control below is a primitive, so no control styling lives
   in this file. */






const panel: React.CSSProperties = {
  display: 'grid',
  // The sidebar's own width, from the one constant that states it — not a literal that happens to
  // agree with another box's number.
  gridTemplateColumns: `${String(SIDEBAR_WIDTH)}px 1fr`,
  // The row is a fraction of this box and cannot be grown past it. Without this, a single `auto`
  // row is sized by its content, so a column whose content is taller than the panel makes the row
  // taller than the panel — and the *other* column is then laid out inside that taller box. The
  // empty state was still centred; it was centred lower, and which column overflowed decided where
  // the text sat. One panel's content must not be able to move another's.
  gridTemplateRows: 'minmax(0, 1fr)',
  height: '100%',
  minHeight: 0,
  fontSize: 14,
}


const main: React.CSSProperties = { display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0 }






/**
 * Render the workbench.
 * @param props - this package's injected picker and store.
 * @returns the two-column workbench.
 */
export function MarkdownWorkbench({ pickDirectory, store, sessions, openWebPage }: MarkdownWorkbenchProps) {
  /**
   * The snapshot this mount was restored from — read once, consumed into the initial state below,
   * and released after the mount checks.
   *
   * Keeping the whole snapshot object alive for the component's lifetime would keep every document
   * that was open at mount alive too, even after its tab closed: the snapshot's `buffers` are the
   * old buffer objects, not the current ones. A ref that is set to `null` after use is what makes
   * "closing the tab clears the document" true for the restored case as well.
   */
  const mountRef = useRef<WorkbenchSnapshot | null>(store.read())

  /** The vault-session fields of the restored snapshot; deliberately no buffers. */
  const initialSession =
    mountRef.current === null
      ? null
      : {
          root: mountRef.current.root,
          vaultKind: mountRef.current.vaultKind,
          levels: mountRef.current.levels,
          expanded: mountRef.current.expanded,
        }
  /**
   * The vault session: which directory is showing, its levels, expansion and order document.
   *
   * The setters are handed back too: 换目录 and 撤销授权 are cross-feature transactions (save the
   * documents, close the samples, reset the tree), and their atomicity is the composition root's.
   */
  const {
    root,
    vaultKind,
    levels,
    expanded,
    hostProtocol,
    orders,
    ordersReady,
    visiblePaths,
    setRoot,
    setVaultKind,
    setLevels,
    setExpanded,
    setOrders,
    loadLevel,
    reloadLevels,
    toggleDirectory,
    writeOrders,
  } = useVaultSession({ initial: initialSession })
  /**
   * Open documents, keyed by path, plus the tab order and which tab is showing.
   *
   * Text lives in the buffer rather than in one shared field so switching tabs preserves unsaved
   * edits, and closing a tab cannot leak its text into the next one. Undo/redo is not here: it
   * belongs to the open-document session (`documentSessions.ts`), because the editor view is
   * recreated on every switch.
   */
  const [buffers, setBuffers] = useState<Record<string, BufferState>>(
    mountRef.current?.buffers ?? {},
  )
  const [tabs, setTabs] = useState<readonly string[]>(mountRef.current?.tabs ?? [])
  const [activePath, setActivePath] = useState<string | null>(
    mountRef.current?.activePath ?? null,
  )
  const [busy, setBusy] = useState(false)

  /**
   * Where the editor's own reports go: the console.
   *
   * The paste handler and the code-block highlighter both speak through this channel.
   * Neither is displayed any more — the paste handler already writes its own
   * measurements there, and a highlighter fault is a fault rather than something to
   * put over the document.
   *
   * A stable identity, because the highlighter's effect lists this in its dependencies:
   * an inline arrow would re-run that effect on every render.
   */
  const reportFromEditor = useCallback((message: string): void => {
    console.info(`[markdown] ${message}`)
  }, [])
  const [sourceMode, setSourceMode] = useState(mountRef.current?.sourceMode ?? false)
  /**
   * Documents whose own view is the source view (large ones opened that way, or ones the rich
   * editor failed to render). Kept apart from the manual switch so opening one big document does
   * not turn every document into source.
   */
  const [sourceOnly, setSourceOnly] = useState<Readonly<Record<string, true>>>(
    mountRef.current?.sourceOnly ?? {},
  )
  /** The session's answer to "this document is large", once the reader chose. */
  const [largeChoice, setLargeChoice] = useState<LargeOpenChoice | null>(
    mountRef.current?.largeOpenChoice ?? null,
  )
  /** A read that failed, waiting to be read and possibly retried. */
  const [openError, setOpenError] = useState<OpenFailure | null>(null)
  /** A read document waiting for that choice. */
  const [largeOpen, setLargeOpen] = useState<LargeDocumentOpen | null>(null)
  /** Whether "本次会话不再问" is ticked in the dialog. */
  const [largeRemember, setLargeRemember] = useState(false)
  /** Documents whose "opened slowly" notice has already been shown (once per session). */
  const slowNoticedRef = useRef(new Set<string>())
  /** Documents opened in rich text through the large-document dialog: it need not warn again. */
  const slowSkippedRef = useRef(new Set<string>())
  const [revision, setRevision] = useState(0)

  /** The showing buffer, or `null` while no tab is open. */
  const open = activePath === null ? null : (buffers[activePath] ?? null)
  /** Whether the source view is what this document shows: the manual switch, or its own entry. */
  const showingSource = sourceMode || (open !== null && sourceOnly[open.path] === true)
  /** The document's size as read (or last reloaded), for the two "large" thresholds. */
  const documentBytes = open?.bytes ?? 0
  const content = open?.content ?? ''
  const saved = open?.saved ?? ''
  const source = open?.source ?? ''
  const dirty = open !== null && source !== saved
  /** The showing document's path, or `''`: what a save and its notice belong to. */
  const openPath = open?.path ?? ''

  /**
   * 提示层：保存状态、操作结果与协议偏斜。它自己的模块（`workbench/useNotices.ts`），
   * 因为这三句是"这个面板说出口的话"，与写盘、操作本身不是一件事。
   */
  const { items: notices, report: reportOperation, setSaveState } = useNotices({
    hostProtocol,
    openPath,
  })

  /**
   * Whether the showing document refuses edits.
   *
   * The rule itself is {@link readOnlyDocument}; this is it asked once per render for the two
   * views and the toolbar, so the tag, the editor's editable state and the source field's
   * `readOnly` cannot disagree about the same document.
   */
  const readOnly = open !== null && readOnlyDocument(open, vaultKind)

  /**
   * The showing document's undo/redo history.
   *
   * It lives in the session table, not in `buffers`: the editor is recreated on every tab switch
   * and panel remount, and a new editor with an old history attached is exactly what makes undo
   * follow the document rather than the widget. Reloading starts a new one.
   */
  const historyState = open === null ? null : sessions.ensure(open.path)

  /**
   * The freshest buffers, for callbacks that must not capture one render's copy.
   *
   * A write has to read the buffer **when it starts**, not when it was requested: that is what
   * makes a queued write send the newest text instead of an intermediate state (see
   * `autoSave.ts`'s `enqueue`), and it is why this is a ref rather than a dependency.
   */
  const buffersRef = useRef(buffers)
  buffersRef.current = buffers

  /**
   * Merge a change into one buffer **by path**.
   *
   * Everything that patches a buffer names the document it is patching: a write result belongs to
   * the document the write was for, and the writer may have switched documents, closed the tab or
   * deleted the file while it was in flight — "whichever document is showing now" would then be
   * the wrong answer, or a document that no longer exists (a missing buffer is a silent no-op,
   * which is exactly what a dropped result should be).
   * @param path - absolute path of the document to patch.
   * @param patch - fields to replace on it.
   */
  const patchBuffer = useCallback((path: string, patch: Partial<BufferState>): void => {
    setBuffers(current => patchBuffers(current, path, patch))
  }, [])

  /** The showing document, readable from a callback that must not be rebuilt when it changes. */
  const activePathRef = useRef(activePath)
  activePathRef.current = activePath

  /**
   * 正文被编辑器之外的东西改写时，**唯一**的入口。
   *
   * 三件事必须一起发生，缺一件就会在下一次保存里切错字节或写回旧正文：
   *
   *   1. 丢掉这篇文档的会话（撤销历史 + 保存基线）—— 基线的 span 属于**改写之前**那份正文；
   *   2. 改写缓冲区里的正文（`content` / `saved` / `source`，三者按调用方给的值，可以不同）；
   *   3. 让视图重挂（`revision + 1`），编辑器用新正文重新导入。
   *
   * 同时丢弃在飞的写入结果（`invalidate`）：那一次写瞄准的是改写之前的文档。
   *
   * 今天有两条路会改写正文：**重新载入**、**移动改址**（目录深度变了，图片地址被重拼）。
   * 任何新的「整篇替换 / 外部同步」也必须走这里；挂载时还有一道基线自检兜底
   * （`MarkdownEditor.tsx` 用 `isStaleBase` 比 `SourceBase.source`）。
   * @param path - 文档。
   * @param next - 新的正文三份值，以及可选的版本 / 字节数。
   * @param reason - 为什么改写（只用于读数）。
   */
  const replaceText = useCallback(
    (
      path: string,
      next: {
        readonly content: string
        readonly saved: string
        readonly source: string
        readonly version?: string
        readonly bytes?: number
      },
      reason: 'reload' | 'move',
    ): void => {
      console.info(`[markdown] 正文改写：${basenameOf(path)}（${reason}）`)
      invalidate(path)
      sessions.forget(path)
      patchBuffer(path, next)
      if (activePathRef.current !== null && samePath(activePathRef.current, path)) {
        setRevision(value => value + 1)
      }
    },
    [invalidate, patchBuffer, sessions],
  )

  /**
   * The tab strip, readable from a callback that must not capture one render's copy.
   *
   * `forgetTabs` closes documents — one at a time (a tab's ×) or all of the plugin's own at once
   * (a vault being authorized) — and it needs the strip that exists **now**: a copy from an earlier
   * render would put back a tab that has since been closed, or pick the wrong neighbour for the
   * showing tab. Being a ref rather than a dependency is also what lets it stay one identity, so a
   * caller that had to be declared above it (`chooseVault`) can call the current one rather than a
   * captured one.
   */
  const tabsRef = useRef(tabs)
  tabsRef.current = tabs

  /**
   * Documents that no longer exist, so a write must not bring one back.
   *
   * A delete is two steps — the file goes, then the tab does — and a scheduled write can be
   * sitting between them. Without this, that write would **recreate the file the writer just
   * deleted**. Cleared when a document is opened at that path again.
   */
  const droppedRef = useRef(new Set<string>())

  /**
   * The remount counter, readable from callbacks that must not be rebuilt for it.
   */
  const revisionRef = useRef(revision)
  revisionRef.current = revision

  /**
   * The write path, reachable from callers defined above it.
   *
   * `closeTab` and `showDocument` are declared before the write machinery (they are used by the
   * tree, the tab strip and the path-change transaction), and they are exactly the two places
   * that have to flush on the way out of a document. The indirection keeps their identity stable
   * — rebuilding either of them would re-render every row that takes it — while the real
   * function is assigned once, below.
   */
  const flushRef = useRef<(path: string) => Promise<WriteOutcome>>(async () => ({
    kind: 'unchanged',
  }))

  /**
   * Auto-save cadence, timers and the leave triggers.
   *
   * The scheduler reads the one write path through `flushRef` (assigned below), so it can be
   * declared here — above the write machinery — and still call the current one.
   */
  const {
    mountedRef,
    flushAll,
    cancelSchedule,
    noteChange,
    noteLanded,
    block: blockWrite,
    forget: forgetWriteState,
    markImmediate,
    bump: bumpWriteEpoch,
  } = useWriteScheduler({ open, source, vaultKind, buffersRef, flushRef })

  /**
   * The live composer. Held in state, not a ref: the find bar and the outline
   * are only usable once it exists, so its arrival has to re-render.
   */
  const [editor, setEditor] = useState<LexicalEditor | null>(null)
  /** The editor handle as it exists now, for ignoring a late unmount of an older one. */
  const editorRef = useRef<LexicalEditor | null>(null)

  /**
   * The document the current editor belongs to.
   *
   * The editor is remounted per document, so between the two there is a render where `open` is the
   * new document and `editor` is still the old one's. Anything reading the editor has to tell those
   * apart, and the path on `open` cannot: it is already the new one.
   *
   * State, not a ref, and that is the whole point. A ref updates the instant it is written while
   * `editor` waits for the next render, so a ref here produces a moment where the two disagree —
   * the guard says the right document and hands over the wrong editor. Set together, in one call,
   * they are applied in one render and cannot be seen apart.
   */
  const [editorPath, setEditorPath] = useState<string | null>(null)
  const [findOpen, setFindOpen] = useState(false)

  /**
   * The query and the replacement, held here rather than in the bar.
   *
   * Closing the find unmounts the bar, so state inside it dies with it — and a reader who closes the find to
   * look at the document and then opens it again would find an empty box and have to type the same word
   * over. They live here so that reopening shows what was last searched for.
   */
  const [findQuery, setFindQuery] = useState('')
  const [findReplacement, setFindReplacement] = useState('')
  /**
   * The lower band's measured width.
   *
   * The ceiling depends on it, and it changes for reasons a pointer event cannot see —
   * the window resizing, the left sidebar, a panel switch — so it is measured rather
   * than derived from any one gesture.
   */
  const [workspaceWidth, setWorkspaceWidth] = useState(0)
  const workspaceRef = useRef<HTMLDivElement | null>(null)

  /**
   * The scrolling wrapper **as it is mounted right now**, in state.
   *
   * The band is not this component's to keep: closing the last tab replaces it with the empty
   * state, and opening a document again mounts a new box. A measurement wired once at mount would
   * go on describing the box that is gone, and the replacement would never be looked at — which is
   * how the outline came to be zero pixels tall until the whole panel was reopened.
   *
   * State rather than only the ref, because the effect below has to re-run when the element
   * changes and not only when the component does.
   */
  const [workspaceNode, setWorkspaceNode] = useState<HTMLDivElement | null>(null)

  /**
   * Hand the band's box to both readers: the ref for the callers that read it synchronously
   * (dragging, scroll restoration), the state for the measurement effect.
   * @param node - the mounted wrapper, or `null` when it leaves.
   */
  const attachWorkspace = useCallback((node: HTMLDivElement | null): void => {
    workspaceRef.current = node
    setWorkspaceNode(node)
  }, [])

  /**
   * The visible height of the scrolling wrapper, published as a custom property.
   *
   * Two readers, one fact. The outline is bounded by it so it does not scroll away; the editor's
   * body is at least it so a short document still fills the pane, which is what keeps the space
   * below the last line clickable. It has to be measured rather than written as a percentage,
   * because the outline's containing block is the scrolled content — whose height is exactly the
   * thing that must not bound it.
   */
  const [workspaceHeight, setWorkspaceHeight] = useState<number | null>(null)

  /**
   * Read the band's box, and keep reading it while that box is the one on screen.
   *
   * **One observer for both numbers**, because they are two readings of one box taken at one
   * layout. Two effects reading them separately were also two places that could disagree about
   * which element they were looking at.
   *
   * **A detached box's reading is thrown away.** Chromium delivers one last 0×0 observation for an
   * observed element that has left the document, and that zero is not the band's height — it is
   * the absence of a band. Believing it bounds the outline at zero height: the column is still in
   * the DOM, 220px wide, headings and all, and invisible (measured on this panel: 723px → 0px
   * without the panel being switched away). A *connected* box that is zero-sized — the panel
   * hidden — is a real reading and is still taken.
   */
  useLayoutEffect(() => {
    if (workspaceNode === null) return undefined
    const measure = (): void => {
      if (!workspaceNode.isConnected) return
      setWorkspaceHeight(workspaceNode.clientHeight)
      setWorkspaceWidth(workspaceNode.clientWidth)
    }
    measure()
    // A window resize changes it, so one reading at layout is not enough.
    const observer = new ResizeObserver(measure)
    observer.observe(workspaceNode)
    return () => observer.disconnect()
  }, [workspaceNode])
  /**
   * The open entry menu.
   *
   * One state for both ways in: a row's own ⋯ button and a right-click on that row
   * both land here, so the panel keeps one `Menu` and one list of entry commands.
   * See {@link RowMenu} for the one thing the two differ in.
   */
  const [rowMenu, setRowMenu] = useState<RowMenu | null>(null)

  /**
   * Word count and the source view's outline both read the whole text, so both wait for the writer
   * to stop: at 8MB one pass is ~165ms, and a reading that freezes every keystroke is worse than
   * one that updates a fifth of a second later.
   */
  const delayedContent = useDelayedValue(content, DERIVED_TEXT_DELAY)
  const stats = useMemo(
    () => statsOf(documentBytes > OUTLINE_AUTO_BYTES ? delayedContent : content),
    [content, delayedContent, documentBytes],
  )

  /**
   * The outline column: the tree / text outline, its width, the active row and the jump. Its own
   * module, because all four are one thing — the column — and none of them touches the document.
   */
  const {
    open: outlineOpen,
    toggle: toggleOutline,
    storedWidth: outlineWidth,
    width: outlineWidthNow,
    resize: setOutlineWidth,
    entries: outline,
    deferred: outlineDeferred,
    parse: parseOutline,
    activeIndex: outlineActiveIndex,
    jumpTo: scrollToHeading,
    startDrag: startOutlineDrag,
    forget: forgetOutline,
  } = useOutlineColumn({
    content,
    documentBytes,
    openPath: open?.path ?? '',
    showingSource,
    editor,
    scrollport: workspaceNode,
    scrollportRef: workspaceRef,
    initialOpen: mountRef.current?.outlineOpen ?? true,
    initialWidth: mountRef.current?.outlineWidth ?? null,
    textDelayMs: DERIVED_TEXT_DELAY,
  })

  /** Open file tabs whose on-disk version moved while the panel was hidden. */
  const [stale, setStale] = useState<readonly string[]>([])

  /**
   * A save refused because the disk holds a different text: the dialog that asks which side wins.
   *
   * Set where the refusal is classified as real (not a metadata-only or line-ending-only change),
   * so the panel never offers a choice that is not actually needed.
   */
  const [conflict, setConflict] = useState<ConflictState | null>(null)

  /**
   * Guards the conflict dialog's two answers against a second click while one is running.
   *
   * A ref rather than state: the guard has to hold within one tick, before React has re-rendered.
   */
  const conflictBusyRef = useRef(false)

  /**
   * Whether this Host answered "no such route" for stat, so the check stops asking.
   *
   * The page hot-reloads and the Host does not, so a newer client can meet an older Host. One
   * refusal is enough to know: from then on the check reads the file, which is the older cost
   * kept as the fallback rather than as the rule.
   */
  const statMissingRef = useRef(false)

  /**
   * 面板快照：把当前状态写穿到 store、记住滚动位置，并在面板卸载后把落地的写结果补进去。
   * 形状与规则在自己的模块里（`workbench/useWorkbenchSnapshot.ts`）。
   */
  const {
    treeScroll,
    documentScroll,
    rememberTreeScroll,
    rememberDocumentScroll,
    forgetScroll,
    patchSnapshot,
  } = useWorkbenchSnapshot({
    store,
    initialScroll: mountRef.current?.scroll ?? { documents: {}, tree: 0 },
    state: {
      root,
      vaultKind,
      levels,
      expanded,
      buffers,
      tabs,
      activePath,
      sourceMode,
      sourceOnly,
      largeOpenChoice: largeChoice,
      outlineOpen,
      outlineWidth,
    },
  })

  const treeRef = useRef<HTMLDivElement | null>(null)
  const sourceRef = useRef<HTMLTextAreaElement | null>(null)

  // Restore the document's offset once the composer has laid its content out.
  // One frame is not always enough for a long document — the browser clamps a
  // scrollTop it cannot reach yet — so the assignment is made twice.
  useEffect(() => {
    if (editor === null || activePath === null) return undefined
    // The wrapper, not the editor's parent. Walking up from the editor's root was right while the
    // editor's own box scrolled; that box no longer does, and a listener left on it would never fire
    // again — the position would simply stop being remembered, silently.
    const scrollport = workspaceRef.current
    if (scrollport === null) return undefined
    const target = documentScroll(activePath)
    let inner = 0
    const outer = requestAnimationFrame(() => {
      scrollport.scrollTop = target
      inner = requestAnimationFrame(() => {
        scrollport.scrollTop = target
      })
    })
    return () => {
      cancelAnimationFrame(outer)
      cancelAnimationFrame(inner)
    }
  }, [documentScroll, editor, activePath])

  // Track the editor's offset as it moves.
  useEffect(() => {
    if (editor === null || activePath === null) return undefined
    // The wrapper, not the editor's parent. Walking up from the editor's root was right while the
    // editor's own box scrolled; that box no longer does, and a listener left on it would never fire
    // again — the position would simply stop being remembered, silently.
    const scrollport = workspaceRef.current
    if (scrollport === null) return undefined
    const path = activePath
    const onScroll = (): void => {
      rememberDocumentScroll(path, scrollport.scrollTop)
    }
    scrollport.addEventListener('scroll', onScroll, { passive: true })
    return () => scrollport.removeEventListener('scroll', onScroll)
  }, [editor, activePath, rememberDocumentScroll])


  // The source view is a plain textarea, so its offset needs the same care.
  useEffect(() => {
    if (!showingSource || open === null) return undefined
    const node = sourceRef.current
    if (node === null) return undefined
    const target = documentScroll(open.path)
    const frame = requestAnimationFrame(() => {
      node.scrollTop = target
    })
    return () => cancelAnimationFrame(frame)
  }, [documentScroll, showingSource, open])

  // Coming back from the conversation, a file may have moved on underneath us —
  // work in that conversation may even have edited it. Comparing versions here
  // means the writer learns before writing, rather than from a refused save.
  //
  // **It compares against the newest truth, not against what the snapshot said when this component
  // first rendered.** Leaving the panel writes once (§4.9), and that write's result is patched
  // into the snapshot rather than into state that no longer exists — so if the writer comes back
  // before it lands, the state in hand is already out of date. Waiting for that write to finish
  // and then reading the snapshot again is what keeps a document the writer *just saved* from
  // being marked ⟳ with 「保存会被拒绝」 (I15).
  //
  // **Asking for a version costs a stat, not a read.** The comparison needs one string per open
  // document; reading the whole text to learn it meant every panel return downloaded everything
  // that was open (and did it one document at a time, so a large one delayed the marks after it).
  // The stat route answers the version alone, and the queries run together.
  useEffect(() => {
    // One-shot: the restored snapshot is needed for the mount checks and then deliberately
    // released. Keeping it would keep the buffers of every document that was open at mount alive
    // for the component's whole life, including after their tabs close.
    const snapshot = mountRef.current
    mountRef.current = null
    if (snapshot?.root == null) return undefined
    // The package's own documents are left out: their text is the plugin's memory, not a file, so
    // nothing can change it under an open tab — and the read route refuses those paths on purpose
    // when the writer's own directory is authorized, which would otherwise mark every return with ⟳.
    const fileBuffers = Object.values(snapshot.buffers).filter(
      buffer => buffer.kind === 'file' && !buffer.sample,
    )
    if (fileBuffers.length === 0) return undefined

    let cancelled = false
    /**
     * The version on disk, through the stat route, falling back to a read on a Host that predates
     * it. A route this Host does not mount answers 404 with an empty body — measured against the
     * running server — which `request` reports as code `http`; this plugin's own 404 carries
     * `not-found`, so only the first kind is remembered as "no such route".
     * @param path - document to ask about.
     * @returns its freshness token.
     */
    const versionOf = async (path: string): Promise<string> => {
      if (statMissingRef.current) return (await readFile(path)).version
      try {
        return (await statFile(path)).version
      } catch (error) {
        if (error instanceof VaultRequestError && error.status === 404) {
          if (error.code === 'http') statMissingRef.current = true
          return (await readFile(path)).version
        }
        throw error
      }
    }

    void (async () => {
      const paths = fileBuffers.map(buffer => buffer.path)
      // Everything in flight or queued for these paths lands first, including a write that
      // outlived the previous mount of this panel. Awaited in order, because one path's write
      // may be what queued the next one.
      for (const path of paths) await enqueue(path, async () => undefined)

      const answers = await Promise.all(
        paths.map(async path => {
          const newest = store.read()?.buffers[path] ?? snapshot.buffers[path]
          if (newest === undefined) return null
          if (newest !== snapshot.buffers[path]) {
            patchBuffer(path, { saved: newest.saved, version: newest.version })
          }
          try {
            return (await versionOf(path)) === newest.version ? null : path
          } catch {
            // An unreadable file needs the same attention as a changed one.
            return path
          }
        }),
      )
      const changed = answers.filter((path): path is string => path !== null)
      if (cancelled || changed.length === 0) return
      setStale(changed)
      // Not displayed: `setStale` already puts ⟳ on each affected tab, and that mark
      // is what the reader acts on. The sentence explaining it goes to the console.
      console.info(
        `[markdown] 磁盘上有更新的版本：${changed.map(basenameOf).join('、')}。保存会被拒绝，请用「重新载入」。`,
      )
    })()

    return () => {
      cancelled = true
    }
  }, [patchBuffer, store])

  /** Open the host directory picker and authorize the result. */
  const chooseVault = useCallback(async (): Promise<void> => {
    setBusy(true)
    try {
      const picked = await pickDirectory()
      if (picked === null) return
      /**
       * **This is a way out of the editing state too**, and the only one that is easy to miss:
       * the writer's own documents stay open when the vault changes (tabs and buffers are not
       * cleared), so their paths would fall outside the new root and any later write would be
       * refused as `outside-vault`. Writing them here — while the *old* root is still the
       * authorized one — is what makes switching directories not cost the writer anything.
       *
       * The plugin's own documents are the exception, and they go in the commit below.
       */
      await flushAll()
      const state = await authorizeVault(picked)
      const next = state.root
      setRoot(next)
      // A directory the writer picked is a `user` root by construction, whatever
      // the host echoes back.
      setVaultKind(next === null ? null : 'user')
      /**
       * **The plugin's own documents leave in the same commit as the root arrives** — and
       * they are dropped, not saved (`closeSamples`). Doing it here rather than in an effect on
       * `vaultKind` is what keeps every render, and therefore every panel snapshot, from ever
       * holding "the writer's own vault" beside "the plugin's documents": those two states are
       * written to the store on each render, so a frame in between is a state a panel switch can
       * restore.
       *
       * `closeSamples` is called and not listed among this callback's dependencies for the reason
       * the declaration order makes unavoidable: it is declared below. It is **stable**, which is
       * what makes that correct rather than merely tolerated — it and `forgetTabs` read the tab
       * strip through `tabsRef` and have no dependencies of their own.
       */
      closeSamples()
      setLevels({})
      setExpanded(next === null ? [] : [next])
      // Any results on screen were found in the previous directory, so they go
      // with it rather than being left standing over a tree they do not describe.
      search.close()
      if (next !== null) {
        storeVault(next)
        await loadLevel(next)
      }
    } catch (error) {
      reportQuietly('换目录失败', error)
    } finally {
      setBusy(false)
    }
  }, [loadLevel, pickDirectory])

  /** Drop the authorization on the host and reset the tree. */
  const forgetVault = useCallback(async (): Promise<void> => {
    setBusy(true)
    try {
      // Same reason as 换目录: revoking takes the root away, and a write afterwards would have
      // nowhere legitimate to go. Save first, then let go.
      await flushAll()
      await revokeVault()
      clearStoredVault()
      setLevels({})
      setExpanded([])
      setRoot(null)
      setVaultKind(null)
      search.close()
      // Revoking lands back in the unassociated state, and that state shows the
      // samples — so they are fetched again rather than leaving the sidebar
      // empty until the next mount.
      const sample = await fetchSampleVault()
      const adopted = await authorizeVault(sample.path)
      if (adopted.root !== null) {
        setRoot(adopted.root)
        setVaultKind('sample')
        setExpanded([adopted.root])
        await loadLevel(adopted.root)
      }
    } catch (error) {
      reportQuietly('撤销授权失败', error)
    } finally {
      setBusy(false)
    }
  }, [loadLevel])


  /**
   * Install a document the Host has just answered with as the showing tab.
   *
   * **The one place that turns bytes into a buffer**, so the two ways in — a file out of the
   * writer's tree and one of the plugin's own documents — start from the same text everywhere
   * (`content`, `saved` and `source` all begin as the bytes just read, and a document that was
   * deleted and reopened stops being remembered as dropped).
   *
   * `sample` is a parameter rather than something worked out here: only the caller knows which
   * route answered with the text, and that fact decides both whether the document may be written
   * and where its pictures come from.
   * @param file - the document as read.
   * @param sample - whether the text came out of this package.
   * @param bytes - its size in UTF-8 bytes, measured once from the text just read.
   */
  const openDocument = useCallback((file: VaultReadResult, sample: boolean, bytes: number): void => {
    droppedRef.current.delete(file.path)
    sessions.ensure(file.path)
    setBuffers(current =>
      withBuffer(current, {
        kind: 'file',
        path: file.path,
        title: basenameOf(file.path),
        bytes,
        content: file.content,
        saved: file.content,
        // The source mirror starts equal to the file: no edit has happened yet, so writing it would
        // be a byte-for-byte copy. It is patched block by block from here on.
        source: file.content,
        version: file.version,
        sample,
      }),
    )
    setTabs(current => (current.includes(file.path) ? current : [...current, file.path]))
    showDocument(file.path)
    // `showDocument` is deliberately absent: it is declared below this callback and listing it
    // would read the binding before its declaration. It is stable (no dependencies), which is
    // what the two callers below rely on.
  }, [sessions])

  /**
   * Open one already-read document, with the large-document choice that got it here.
   *
   * The choice is per document: a large one opened in source gets its own `sourceOnly` entry, so
   * the next small document is untouched. `null` means no choice was needed (the document is
   * small, or the source view was already showing).
   * @param file - the document as read.
   * @param sample - whether it came out of this package.
   * @param bytes - its size in UTF-8 bytes.
   * @param choice - the reader's answer, or `null` when none was asked.
   */
  const openWithChoice = useCallback(
    (file: VaultReadResult, sample: boolean, bytes: number, choice: LargeOpenChoice | null): void => {
      if (choice === 'source') {
        setSourceOnly(current =>
          current[file.path] === true ? current : { ...current, [file.path]: true },
        )
      }
      if (choice === 'rich') {
        // The reader has just been told what rich text costs; do not tell them again after it runs.
        slowSkippedRef.current.add(file.path)
      }
      openDocument(file, sample, bytes)
    },
    [openDocument],
  )

  /** Open one document from the vault. */
  const openFile = useCallback(
    async (path: string): Promise<void> => {
      // An already-open document keeps its unsaved edits: activating a tab must
      // never re-read from disk behind the writer's back. Use reload for that.
      //
      // Matched with `samePath` rather than by key, because the caller may be the
      // sidebar, which derives its path by joining. A miss here is not cosmetic: it
      // re-reads the file and replaces the buffer, discarding what was typed.
      const already = Object.values(buffers).find(
        buffer => buffer.kind === 'file' && samePath(buffer.path, path),
      )
      if (already !== undefined) {
        showDocument(already.path)
        return
      }
      setBusy(true)
      try {
        // Whatever the read route answered is the plugin's own document exactly when the vault
        // it answered from is the plugin's own; the file's own spelling says nothing (the sample
        // root is a spelling, not a directory).
        const file = await readFile(path)
        const bytes = utf8Length(file.content)
        const sample = vaultKind === 'sample'
        /*
         * **The only place size decides anything before opening.** The question is skipped when
         * *this* document would open in the source view anyway: the workbench-wide switch is on,
         * or this path was already marked source-only. Asking would only be noise.
         */
        const opensInSource = sourceMode || sourceOnly[path] === true
        if (!opensInSource && largeBand(bytes) === 'large' && largeChoice === null) {
          setLargeOpen({ file, sample, bytes })
          return
        }
        openWithChoice(file, sample, bytes, largeBand(bytes) === 'large' ? largeChoice : null)
      } catch (error) {
        /*
         * **No longer console-only.** The reader clicked a file and nothing appeared; the reason
         * is the only thing that can tell them why. A dialog rather than a notice because there is
         * no band to put a notice on while nothing is open — and this is the case where nothing
         * opened.
         */
        setOpenError({ path, message: messageOf(error), route: 'file' })
        reportQuietly('打开文件失败', error)
      } finally {
        setBusy(false)
      }
    },
    [buffers, largeChoice, openWithChoice, sourceMode, sourceOnly, vaultKind],
  )

  /**
   * Take the reader's answer to the large-document question.
   *
   * The answer can be remembered for the session; it is stored as one of the two choices, never
   * as "refuse to open". Cancelling the dialog opens nothing (nothing was written either).
   * @param choice - source view or rich text.
   */
  const chooseLargeOpen = useCallback(
    (choice: LargeOpenChoice): void => {
      const pending = largeOpen
      if (pending === null) return
      if (largeRemember) setLargeChoice(choice)
      setLargeOpen(null)
      setLargeRemember(false)
      openWithChoice(pending.file, pending.sample, pending.bytes, choice)
    },
    [largeOpen, largeRemember, openWithChoice],
  )

  /** Dismiss the large-document question without opening the document. */
  const closeLargeOpen = useCallback((): void => {
    setLargeOpen(null)
    setLargeRemember(false)
  }, [])

  /**
   * Show one document in the source view — the way out of a failed rich import.
   *
   * Per document, not the workbench-wide switch: the document that failed is the one that needs
   * the other view, and the next document should open the way it would have anyway.
   * @param path - the document whose rich view failed.
   */
  const showDocumentSource = useCallback((path: string): void => {
    setSourceOnly(current => (current[path] === true ? current : { ...current, [path]: true }))
  }, [])

  /**
   * Report how long this document's rich import took, and warn once when it was slow.
   *
   * **Measured, not predicted.** File size alone cannot tell a dense 854KB document from a plain
   * 1MB one; the import duration is the reading that can. A document opened through the
   * large-document dialog in rich text was already warned, so it is not warned twice.
   * @param path - the document the editor was built for.
   * @param ms - measured import duration.
   */
  const reportImportTime = useCallback(
    (path: string, ms: number): void => {
      if (ms < SLOW_IMPORT_MS) return
      // The session's own answer ("always rich text for large documents") already accepted the cost.
      if (largeChoice === 'rich') return
      if (slowSkippedRef.current.has(path) || slowNoticedRef.current.has(path)) return
      slowNoticedRef.current.add(path)
      reportOperation(
        slowOpenNotice(buffersRef.current[path]?.bytes ?? 0, ms),
        'warning',
        8000,
      )
    },
    [largeChoice, reportOperation],
  )

  /**
   * Drop documents from the panel: their tabs, their buffers, and the bookkeeping that was about
   * them.
   *
   * **The one place buffers are destroyed.** `closeTab` (the writer closing a tab) and
   * {@link closeSamples} (the plugin's own documents leaving with the vault) both come through
   * here, so "which tab shows afterwards" and the per-document cleanup cannot come out two ways.
   *
   * Callers decide **whether** the text may be lost, and do their part first: `closeTab` writes or
   * invalidates, `closeSamples` invalidates. This function assumes the decision is made.
   * @param paths - documents to drop; a path that is not open is ignored.
   */
  const forgetTabs = useCallback(
    (paths: readonly string[]): void => {
      const drop = paths.filter(path => buffersRef.current[path] !== undefined)
      if (drop.length === 0) return
      // The strip and the showing tab as they are **now** — see `tabsRef`.
      const gone = new Set(drop)
      const next = closeTabs(
        { tabs: tabsRef.current, activePath: activePathRef.current },
        drop,
      )
      setTabs(next.tabs)
      setBuffers(current => withoutBuffers(current, drop))
      for (const path of drop) {
        forgetWriteState(path)
        slowNoticedRef.current.delete(path)
        slowSkippedRef.current.delete(path)
        sessions.forget(path)
      }
      // A closed document's own view choice goes with it: the path may be a different document next
      // time it is opened, and a stale "source only" would silently decide that for the reader.
      setSourceOnly(current => {
        if (!drop.some(path => current[path] === true)) return current
        const kept = { ...current }
        for (const path of drop) delete kept[path]
        return kept
      })
      forgetOutline(drop)
      // A closed document's scroll offset and stale mark are that document's state; keeping them
      // would make the next open of the same path start in the old position and show ⟳ for a
      // disk change the new read has already accounted for.
      forgetScroll(drop)
      setStale(current => {
        const next = current.filter(path => !gone.has(path))
        return next.length === current.length ? current : next
      })
      // A closed document has no conflict to resolve: the dialog belongs to its buffer.
      setConflict(current => (current !== null && gone.has(current.path) ? null : current))
      setSaveState(current =>
        current?.kind === 'failed' && current.path !== undefined && gone.has(current.path)
          ? null
          : current,
      )
      if (next.activePath !== activePathRef.current) {
        // The caller already flushed the document being closed; activating the neighbour must not
        // flush it a second time. That second flush was an accidental extra write, and it made a
        // clean close depend on a write the close had already accounted for.
        showDocument(next.activePath, false)
      }
    },
    // `cancelSchedule`, `forgetOutline` and `forgetScroll` are stable; `showDocument` is called and
    // deliberately not listed — it is declared below this callback, and it is stable anyway.
    [cancelSchedule, forgetOutline, forgetScroll, sessions],
  )

  /**
   * Close one tab, activating a neighbour when it was the showing one.
   *
   * ## Write first, then destroy
   *
   * Closing is the one way out of a document that **destroys the buffer**, so it is the one place
   * where a lost write would lose text nobody can get back. What it does instead: cancel the
   * scheduled write, write whatever is not on disk yet, and destroy the buffer only once that
   * write has landed. A refusal therefore leaves the tab exactly where it was, with the notice
   * that says why — the writer's text is still on screen, one Ctrl+S away from another attempt.
   *
   * It is silent on success: the tab going away is the answer to "did that work?".
   * @param path - the document to close.
   * @param disposition - `save` (the writer closed it; write first) or `discard` (the file is
   *   being deleted or replaced — writing would put back what is going away).
   * @returns whether the tab actually closed, and why it stayed when it did not.
   */
  const closeTab = useCallback(
    async (path: string, disposition: 'save' | 'discard' = 'save'): Promise<CloseResult> => {
      if (disposition === 'discard') {
        // The write in flight was aimed at a document that is going away: throw its result away
        // rather than let it be applied to whatever holds that path next.
        cancelSchedule(path)
        invalidate(path)
      } else {
        /**
         * Write until the buffer is clean.
         *
         * The caller freezes the view before this runs, so one pass is the ordinary case. The
         * second pass is the guard for every other caller: a write's `outgoing` is captured when
         * it starts, and text typed while it travels would otherwise be destroyed with the buffer
         * after `forgetTabs`. Two passes are enough for a frozen view; a third would be a document
         * being edited behind the close, which is a refusal rather than a data loss.
         */
        let landed: string | null = null
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const outcome = await flushRef.current(path)
          if (outcome.kind === 'failed') {
            return { kind: 'failed', message: outcome.message, code: outcome.code }
          }
          if (outcome.kind === 'written') landed = outcome.text
          const buffer = buffersRef.current[path]
          if (buffer === undefined) break
          // A write's `saved` in React state lands a render later; the outcome's own text is the
          // synchronous answer to "did the text in the buffer land?".
          if (landed !== null && landed === buffer.source) break
          if (
            planSaveSource({
              saved: buffer.saved,
              source: buffer.source,
            }).kind === 'none'
          ) {
            break
          }
        }
        const remaining = buffersRef.current[path]
        if (
          remaining !== undefined &&
          (landed === null || landed !== remaining.source) &&
          planSaveSource({
            saved: remaining.saved,
            source: remaining.source,
          }).kind !== 'none'
        ) {
          return { kind: 'failed', message: '文档在关闭期间仍有未保存的修改' }
        }
      }
      forgetTabs([path])
      // The session's write count for this document, printed where it is still meaningful: a
      // document that has just left is exactly the unit the cadence is judged in.
      const tally = writeReport().filter(line => line.startsWith(`${path} —`))
      for (const line of tally) console.info(`[markdown] 写次数：${line}`)
      forgetWrites(path)
      return { kind: 'closed' }
    },
    // `showDocument` and the tab strip are read through refs (`forgetTabs`), so this is one
    // identity — which is what lets `applyPathChange`, declared below, close a tab without
    // holding a copy of an older render's state.
    [forgetTabs],
  )

  const {
    closeRequest,
    closeFrozen,
    requestClose,
    retryClose,
    confirmCloseDiscard,
    cancelClose,
  } = useCloseProtocol({ activePath, buffers, buffersRef, vaultKind, closeTab, setSaveState })

  /**
   * Close every open document that came out of this package.
   *
   * **The plugin's own two do not belong to a directory**, so they leave when the writer
   * authorizes one. A tab of plugin material sitting in the writer's own vault is a
   * document from another source — and there is nothing the writer can do there to make it theirs:
   * it stays read-only for as long as it is open. The two are still one menu away
   * (`功能介绍` / `关于`), which is where the reader asked for them.
   *
   * **Discard, never save** — 不论用户是否编辑过. There is nothing to save: the text lives in the
   * package rather than on a disk, so every write aimed at it is refused as read-only. A flush
   * would therefore be a round trip that can only end in a refusal — and that refusal is what the
   * close would then have to handle, for a document that was never writable in the first place.
   *
   * Deliberately **not** the other way round: revoking the authorization leaves the writer's own
   * documents open. Those are the writer's work rather than the plugin's material, and the round
   * trip 撤销授权 → 关联仓库 must put them back exactly as they were — closing them would destroy
   * the tab set for a detour. They are read-only in the meantime, which is what `./readOnly.ts`
   * says about any document while the authorized root is not the writer's.
   */
  const closeSamples = useCallback((): void => {
    const open = Object.values(buffersRef.current)
      .filter(buffer => buffer.sample)
      .map(buffer => buffer.path)
    if (open.length === 0) return
    // A write in flight for one of them was aimed at a document that is going away: throw its
    // result away rather than let it be applied to whatever holds that path next (the same reason
    // `closeTab`'s discard branch invalidates).
    for (const path of open) invalidate(path)
    forgetTabs(open)
  }, [forgetTabs])


  /**
   * Everything the workbench can do, in menu order.
   *
   * `refresh` is registered here like any other command but carries
   * `appliesTo: 'workbench'`, so it reaches no menu and is invoked by code —
   * after a path changes, the tree has to be re-read, and that is a command
   * rather than a special case buried in the rename handler.
   */

  /**
   * Re-derive the tree and the tabs after an entry's path changed on disk.
   *
   * The tree is a cache keyed by directory, and every tab is keyed by path, so a
   * rename invalidates both at once: the old key has to stop existing, the new
   * one has to be loaded, and an open document has to follow its file.
   *
   * Doing it in one place is the point. The previous version refreshed only the
   * parent directory and only closed a tab when it happened to be the *active*
   * one, so:
   *
   *   - any other tab for a renamed file kept showing a name that no longer
   *     existed on disk;
   *   - renaming a directory left `expanded` and `levels` holding keys under the
   *     old path, so its subtree was orphaned;
   *   - deleting a non-active tab's file left the tab behind entirely.
   *
   * @param from - the path that no longer exists, or `null` when an entry was created.
   * @param to - the path that now exists, or `null` when an entry was removed.
   */
  const applyPathChange = useCallback(
    async (from: string | null, to: string | null): Promise<void> => {
      if (from !== null && to !== null) {
        // A rename is the same file under a new key, so an open buffer follows it
        // rather than being closed — losing an open document to a rename would
        // be a worse outcome than the stale name this replaces.
        //
        // **The whole subtree, not just the entry.** Every one of these maps is keyed by
        // absolute path, and a folder's path is the prefix of everything inside it, so
        // moving the folder moves those keys too. Rewriting only the folder's own key left
        // the levels below it — the expanded ones, the open tabs inside — pointing at paths
        // nothing answers to; the tab stayed on screen and its file had "vanished".
        setBuffers(current =>
          repathRecord(current, from, to, (key, buffer) => ({
            ...buffer,
            path: key,
            title: basenameOf(key),
          })),
        )
        setTabs(current => [...repathList(current, from, to)])
        setActivePath(current => (current === null ? current : (repathUnder(current, from, to) ?? current)))
        setStale(current => [...repathList(current, from, to)])
        // The conflict dialog names a path, so a rename / move has to carry it along too — a
        // dialog about a path that no longer exists would resolve nothing.
        setConflict(current =>
          current === null
            ? null
            : {
                ...current,
                path: repathUnder(current.path, from, to) ?? current.path,
                title: basenameOf(repathUnder(current.path, from, to) ?? current.path),
              },
        )
        // A renamed / moved document is the same editing session under a new key; its undo stack
        // follows it rather than being thrown away.
        sessions.repath(from, to)
        // A directory that moved keeps its expansion and its loaded children.
        setExpanded(current => [...repathList(current, from, to)])
        setLevels(current => repathRecord(current, from, to, (_key, level) => level))
      }

      if (from !== null && to === null) {
        setExpanded(current => current.filter(path => path !== from))
        setLevels(current => {
          if (current[from] === undefined) return current
          const next = { ...current }
          delete next[from]
          return next
        })
        // **Discard, not save**: the file is gone (or replaced), and a write here would put back
        // what is being removed — the deleted document would reappear on disk (§4.9).
        void closeTab(from, 'discard')
      }

      // Any level on screen can be affected, so all of them are reloaded rather
      // than just the parent. Bounded by what the writer has expanded.
      const parents = new Set<string>(visiblePaths)
      for (const path of [from, to]) {
        if (path !== null) parents.add(dirnameOf(path))
      }
      if (from !== null && to !== null && expanded.includes(from)) parents.add(to)
      await reloadLevels([...parents])
    },
    [closeTab, expanded, reloadLevels, sessions, visiblePaths],
  )


  /**
   * Ask whether a newer release exists, and say the answer out loud.
   *
   * **Read-only, on purpose**: this never installs anything. When there *is* a newer
   * version the notice prints the command and the writer runs it through DSH — a plugin that
   * installed packages would be able to replace itself, which is a much larger promise than
   * "tell me if I am behind".
   *
   * **Every outcome gets one notice**, including the boring ones: "已是最新" is what tells the
   * writer the button worked. A failure is `danger` and says the reason in the Host's own
   * words, because "check failed" with nothing after it is indistinguishable from a dead button.
   *
   * `stale` is the one notice that does not time out: it carries a command to copy, and a
   * command that vanishes after six seconds is worse than no notice at all.
   */
  const checkUpdate = useCallback(async (): Promise<void> => {
    try {
      const result = await fetchUpdateCheck()
      if (result.outcome === 'stale') {
        reportOperation(
          `有新版本 v${result.latest ?? '?'}（当前 v${result.current ?? '?'}）。在 DSH 里执行：` +
            `dsh plugin --profile desktop up --latest ${PACKAGE_NAME}`,
          'warning',
          null,
        )
        return
      }
      if (result.outcome === 'current') {
        reportOperation(`已是最新版本（v${result.current ?? result.latest ?? '?'}）`, 'success')
        return
      }
      reportOperation(`检查更新失败：${result.reason ?? '未知原因'}`, 'danger')
    } catch (error) {
      // A refusal from *our* route rather than from the registry: the Host half may predate
      // this route (the page hot-reloads and the Host does not), so say it rather than nothing.
      reportOperation(`检查更新失败：${messageOf(error)}`, 'danger')
    }
  }, [reportOperation])

  /**
   * Open one of the plugin's own documents, read-only, beside whatever is already open.
   *
   * **It does not touch the authorized root.** The writer is reading their own directory when the
   * settings menu offers these — that is the only place they are offered — so authorizing the
   * sample root instead would take their tree away to show them a document about the plugin. The
   * text comes from `VaultRoute.sampleDocument`, which answers out of the package's own table
   * whatever root is in use; `openDocument` then installs it as a read-only tab beside the
   * writer's files.
   *
   * The path is the Host's, and that is why the document is read before it is deduplicated:
   * `readSampleDocument` answers with the document's place in the sample vault
   * (`sample:示例/关于.md`), which is the same identity `readFile` gives it in sample mode — so
   * opening 关于 from the tree and then from this menu lands on one tab rather than two.
   *
   * **Its failure is said out loud**, unlike `openFile`'s (console only). The difference is who
   * asked: this is a menu offering one document, and the one way it can fail on a working
   * installation is a Host half that predates this route — the page hot-reloads and the Host does
   * not, so "nothing happened" is exactly the case where the reader needs the sentence.
   * @param name - the file name as the package ships it.
   */
  const openSample = useCallback(
    async (name: string): Promise<void> => {
      setBusy(true)
      try {
        const file = await readSampleDocument(name)
        const already = Object.values(buffersRef.current).find(
          buffer => buffer.sample && samePath(buffer.path, file.path),
        )
        if (already !== undefined) {
          showDocument(already.path)
          return
        }
        openDocument(file, true, utf8Length(file.content))
      } catch (error) {
        // The same dialog as a vault file: the reader asked for one document and got nothing, and
        // with no band to put a notice on, the reason belongs in a layer that is always mounted.
        setOpenError({ path: name, message: messageOf(error), route: 'sample' })
        reportQuietly('打开示例文档失败', error)
      } finally {
        setBusy(false)
      }
    },
    // `showDocument` is called and deliberately not listed: it is declared below this callback, so
    // naming it here would read the binding before its declaration (it is stable regardless).
    [openDocument],
  )


  /**
   * This panel's web tabs. Declared here because `showDocument` gives the document back by
   * selecting `null`, and the editor's link opener is handed to the band.
   */
  const web = useWebTabs(openWebPage)

  /**
   * 切到一篇文档（或切到"没有文档"）：**同时**把网页标签让开。
   *
   * 两种状态互斥：网页标签开着时点文档标签、或在树里点开一篇文档，都必须回到文档状态 ——
   * 只改 `activePath`、那一层还在最上面，点击看起来就是"没反应"。
   *
   * 另外一件事：**离开这一篇就立刻保存一次**（§4.9 那条总规则），不等静置计时器。写由
   * `flushRef` 负责，这里是切文档唯一的收口，所以只需要在这里发一次。切走之后这一篇仍在内存里
   * （缓冲区不销毁），所以它属于"写后留下"那一类：写了不成功也只是报一次，切换照常进行。
   * @param path - 要显示的文档路径，`null` 表示没有文档。
   * @param flushLeaving - whether leaving the previous document should write it first. Closing a
   *   tab passes `false` because `closeTab` has already written it; every ordinary switch leaves
   *   this at `true`.
   */
  const showDocument = useCallback((path: string | null, flushLeaving = true): void => {
    const leaving = activePathRef.current
    if (flushLeaving && leaving !== null && (path === null || !samePath(leaving, path))) {
      void flushRef.current(leaving)
    }
    setActivePath(path)
    web.select(null)
  }, [web.select])


  /**
   * The tree's operations: dragging, the move transaction, and the three entry dialogs.
   *
   * The path-following transaction they hand over to (`applyPathChange`) stays in this file,
   * because it re-keys documents, tags and the order document as well as the tree.
   */
  const {
    prompt,
    setPrompt,
    promptValue,
    setPromptValue,
    promptError,
    setPromptError,
    pendingDelete,
    setPendingDelete,
    dragging,
    moveTarget,
    setMoveTarget,
    moveChoices,
    setMoveChoices,
    moveFilter,
    setMoveFilter,
    canDrag,
    startDrag,
    endDrag,
    trackDrag,
    finishDrag,
    loadMoveChoices,
    submitMove,
    submitPrompt,
    duplicateEntry,
    performDelete,
  } = useTreeOperations({
    root,
    vaultKind,
    busy,
    setBusy,
    levels,
    orders,
    setOrders,
    setExpanded,
    loadLevel,
    reloadLevels,
    writeOrders,
    buffers,
    setBuffers,
    setStale,
    droppedRef,
    cancelSchedule,
    flushRef,
    treeRef,
    openFile,
    applyPathChange,
    replaceText,
    reportOperation,
  })

  /** Read at the moment a write starts, so a cadence change does not rebuild the write path. */
  const vaultKindRef = useRef(vaultKind)
  vaultKindRef.current = vaultKind
  const visiblePathsRef = useRef(visiblePaths)
  visiblePathsRef.current = visiblePaths

  /**
   * Write one document, if what is on disk is not what the editor holds.
   *
   * ## The one place that writes
   *
   * Manual saves, the idle timer, every way out of a document and the session's last flush all
   * come through here, so the rules that keep a save from costing the writer anything live in one
   * function instead of five: the compare-and-set token, the turn guard that drops a superseded
   * result whole, `saved` being the text that was **sent** (never the text at callback time), and
   * the version coming back from the write instead of a second read of the whole file.
   *
   * ## Serialized per document, and always the newest text
   *
   * `enqueue` runs one write per path at a time; the task reads the buffer **when it starts**, so
   * a write that had to wait for another one sends the text as it is by then — never an
   * intermediate state (I3). Nothing here touches `busy`: the caller may carry on typing, drag a
   * row or open another document while this is in flight.
   *
   * ## `force` is the writer's answer to a conflict
   *
   * 保留我的 means "this one write ignores the compare-and-set": the writer has been shown that the
   * disk holds a different text and chose theirs. Everything else stays the same — the turn guard,
   * `saved` being the text that was sent, the version adopted from the answer — because a second
   * write path would be a second set of those rules.
   * @param path - absolute document path.
   * @param force - write without the version guard (the conflict dialog's 保留我的).
   * @returns what came of it.
   */
  const writeActive = useCallback(
    async (path: string, force = false): Promise<WriteOutcome> => {
      if (droppedRef.current.has(path)) return { kind: 'discarded' }
      const first = buffersRef.current[path]
      if (first === undefined) return { kind: 'discarded' }
      // The one question that decides whether this document may reach the disk at all — asked
      // before the buffer's text is even looked at, and asked again below where the queue hands
      // the write its turn (a root can be revoked while a write waits).
      if (readOnlyDocument(first, vaultKindRef.current)) return { kind: 'discarded' }
      if (planSaveSource({ saved: first.saved, source: first.source }).kind === 'none') {
        return { kind: 'unchanged' }
      }

      return await enqueue(path, async (): Promise<WriteOutcome> => {
        const buffer = buffersRef.current[path]
        if (buffer === undefined) return { kind: 'discarded' }
        if (droppedRef.current.has(path)) return { kind: 'discarded' }
        if (readOnlyDocument(buffer, vaultKindRef.current)) return { kind: 'discarded' }
        /**
         * **The one place that asks whether there is anything to save.**
         *
         * Every caller comes through here — Ctrl+S, the idle timer, each way out of a document,
         * the last flush of a session — so the answer is a single call to a single rule rather
         * than the same condition spelled out once per caller (which is how two answers to "has
         * the writer changed anything" start to disagree).
         */
        const plan = planSaveSource({
          saved: buffer.saved,
          source: buffer.source,
        })
        if (plan.kind === 'none') return { kind: 'unchanged' }

        const outgoing = plan.content
        const turn = beginWrite(path)
        /**
         * Record a landed write and take its refusal / stale mark off screen.
         *
         * `already-landed` uses this too: the file is already the text this write wanted, so the
         * version is adopted without a second write. The count is not bumped there — no bytes were
         * written this time.
         * @param version - the file's version after the write / read-back.
         */
        const land = (version: string): void => {
          const recognised: Partial<BufferState> = {
            saved: outgoing,
            // The size fact follows the bytes as they are now: a document that grew past the
            // outline threshold while being edited should not keep the old reading.
            bytes: utf8Length(outgoing),
            version,
          }
          if (mountedRef.current) patchBuffer(path, recognised)
          else patchSnapshot(path, recognised)
          noteLanded(path)
          if (mountedRef.current) {
            setStale(current => current.filter(item => item !== path))
            // A landed write answers this document's conflict too: either the writer chose 保留我的
            // or someone else already landed the same text.
            setConflict(current => (current !== null && current.path === path ? null : current))
            // A landed write takes this document's refusal off screen (I9) — and only this
            // document's: the notice carries the path it was about.
            setSaveState(current =>
              current?.kind === 'failed' && current.path === path ? null : current,
            )
          }
        }
        try {
          const result = await writeFile(path, outgoing, force ? undefined : buffer.version)
          if (!isCurrent(path, turn.token)) return { kind: 'discarded' }
          let version = result.version
          if (version === undefined) {
            // A Host half that predates the field. Reading the file back is exactly the cost this
            // avoids once the Host is restarted, and the token still has to be fresh to keep the
            // *next* compare-and-set honest.
            version = (await readFile(path)).version
          }
          noteWrite(path, utf8Length(outgoing))
          land(version)
          // A first save creates the file, so the directory listing it is stale — and only then:
          // the count earlier re-read the parent on every save, which under auto-save would be a
          // directory listing every couple of seconds (4.6).
          if (result.operation === 'create') {
            const parent = dirnameOf(path)
            if (visiblePathsRef.current.includes(parent)) await loadLevel(parent, true)
          }
          return { kind: 'written', text: outgoing }
        } catch (error) {
          if (!isCurrent(path, turn.token)) return { kind: 'discarded' }
          /**
           * **A stale version is not always a real conflict.**
           *
           * The conflict decision is content-only: BOM and line-ending style are presentation,
           * everything else (including blank paragraphs) is content. Re-read once before standing
           * down:
           *
           * - already the outgoing text ⇒ the write effectively landed, adopt its version;
           * - still the saved text ⇒ only the version / line endings moved, retry once with the
           *   fresh token;
           * - anything else ⇒ someone really changed the file; keep the refusal.
           */
          if (error instanceof VaultRequestError && error.code === ERR_STALE) {
            try {
              const fresh = await readFile(path)
              if (!isCurrent(path, turn.token)) return { kind: 'discarded' }
              const verdict = classifyStaleWrite(fresh.content, buffer.saved, outgoing)
              console.info(`[markdown] 版本冲突：${basenameOf(path)} — ${verdict}`)
              if (verdict === 'same-as-target') {
                land(fresh.version)
                return { kind: 'written', text: outgoing }
              }
              if (verdict === 'same-as-saved') {
                const retried = await writeFile(path, outgoing, fresh.version)
                if (!isCurrent(path, turn.token)) return { kind: 'discarded' }
                let version = retried.version
                if (version === undefined) version = (await readFile(path)).version
                noteWrite(path, utf8Length(outgoing))
                land(version)
                return { kind: 'written', text: outgoing }
              }
              /**
               * **A real conflict**, so the writer picks a side. The ⟳ mark lands here rather than
               * only on the next panel return, and the dialog names the two texts. An unmounted
               * panel has nothing to show a dialog on; its next mount's version check marks the tab.
               */
              if (mountedRef.current) {
                setStale(current => (current.includes(path) ? current : [...current, path]))
                setConflict({ path, title: basenameOf(path), message: messageOf(error) })
              }
            } catch (recoveryError) {
              blockWrite(path)
              return {
                kind: 'failed',
                message: messageOf(recoveryError),
                ...(recoveryError instanceof VaultRequestError
                  ? { code: recoveryError.code }
                  : {}),
              }
            }
          }
          // Standing down until the writer changes something: repeating a refusal every two
          // seconds says the same thing over and over and buries the sentence explaining it.
          blockWrite(path)
          return {
            kind: 'failed',
            message: messageOf(error),
            ...(error instanceof VaultRequestError ? { code: error.code } : {}),
          }
        } finally {
          endWrite(path, turn.token)
          if (mountedRef.current) bumpWriteEpoch()
        }
      })
    },
    [loadLevel, patchBuffer, patchSnapshot],
  )

  /**
   * The way out of a document: write it, and say what came of the write.
   *
   * 4.9's single rule in one function — "leaving the editing state writes once, now" — with the
   * three dispositions living in the callers: keep the buffer (switching documents), destroy it
   * only after a successful `flush` (closing a tab), or never call it at all (delete and reload,
   * whose whole point is to discard what is in memory).
   * @param path - absolute document path.
   * @returns the write's outcome; only `failed` means text is still unwritten.
   */
  const flush = useCallback(
    async (path: string): Promise<WriteOutcome> => {
      // Leaving cancels whatever was scheduled: the write is happening now, and a timer that
      // fired afterwards would only repeat it (I16).
      cancelSchedule(path)
      const outcome = await writeActive(path)
      if (outcome.kind !== 'failed') return outcome
      if (mountedRef.current) setSaveState({ kind: 'failed', message: outcome.message, path })
      return outcome
    },
    [cancelSchedule, writeActive],
  )
  flushRef.current = flush

  // Auto-save cadence, timers and the leave triggers live in `useWriteScheduler` (above).

  /** Persist the open document back to its file. */
  const save = useCallback(async (): Promise<void> => {
    if (open === null || open.kind !== 'file') return
    // A read-only document — one of the plugin's own, or any document while the authorized root is
    // not the writer's — has no write to attempt and no version to compare, so none is sent. The
    // sentence is the one the Host would answer with (shared, so the two cannot drift) and it
    // lands in the notice that already answers "did that save go through?", which is the one that
    // stays, because the reader's text is in the buffer and not on disk.
    if (readOnlyDocument(open, vaultKind)) {
      setSaveState({ kind: 'failed', message: SAMPLE_READ_ONLY_MESSAGE, path: open.path })
      return
    }
    const path = open.path
    /**
     * **The writer asked, so the write is attempted now** — and the receipt follows *that* write,
     * not whatever was in flight when the key was pressed. A save that answered 「保存成功」 while
     * an older write was still travelling would be reporting the wrong text as safe.
     *
     * `writeActive` queues behind anything in flight, re-reads the buffer when its turn comes and
     * asks the one decision rule; a document with nothing to save comes back as `unchanged`, which
     * this hands a receipt for rather than a write (silence is what "did that save?" cannot be
     * told apart from).
     */
    setBusy(true)
    setSaveState({ kind: 'saving' })
    try {
      const outcome = await writeActive(path)
      if (outcome.kind === 'failed') {
        setSaveState({ kind: 'failed', message: outcome.message, path })
        return
      }
      if (outcome.kind === 'discarded') {
        // The result belonged to a document that was closed, deleted or reloaded while the write
        // was travelling. Claiming 「保存成功」 would be claiming it about text that is no longer
        // there, and the action that replaced it is on screen — so the receipt is cleared rather
        // than answered.
        setSaveState(null)
        return
      }
      // A receipt, not silence. What tells the reader it worked is the 未保存 tag clearing and
      // the tab's ⟳ going — but those are the *absence* of two marks, and a save that showed a
      // flash and then nothing left "did that save?" with no answer on screen. The same notice
      // that said 正在保存… now says 保存成功.
      setSaveState({ kind: 'saved' })
    } finally {
      setBusy(false)
    }
  }, [open, vaultKind, writeActive])

  /**
   * Replace one document's contents with what is on disk.
   *
   * Without this, a file edited outside the editor is a dead end: the next save
   * is refused by the compare-and-set (correctly — it must not overwrite the
   * other writer), and the user has no way to pull the newer text in.
   *
   * **This is a way out of the editing state that does not save** (§4.9, disposition *discard*):
   * it means "throw away what is in memory and take the disk's text", so a scheduled write is
   * cancelled rather than allowed to land afterwards and put it back.
   *
   * 改写本身走 {@link replaceText}：它会丢会话、换正文、重挂视图 —— 这三件事在这里不能分开做。
   *
   * **By path, not "the current document".** The conflict dialog can be about a background tab —
   * a save that ran on the way out of it — and the plain 重新载入 command is just the case where
   * the path is the showing one.
   * @param path - the document to replace.
   * @returns whether it happened; a failure also carries the sentence to show.
   */
  const reloadPath = useCallback(
    async (path: string): Promise<{ kind: 'reloaded' } | { kind: 'failed'; message: string }> => {
      const buffer = buffersRef.current[path]
      if (buffer === undefined) return { kind: 'failed', message: '这篇文档已经关闭' }
      const unchanged = !hasUnsaved({ saved: buffer.saved, source: buffer.source })
      setBusy(true)
      try {
        // **Which route answers depends on what this document is.** A bundled sample is not in the
        // authorized root — that is what lets it be open beside the writer's files — so the vault's
        // read route refuses it (correctly: it is not the writer's), and the name is what the
        // package's own route takes. The samples are one flat folder at the sample root, so the name
        // is the last segment of the path the Host gave us.
        const file = buffer.sample
          ? await readSampleDocument(basenameOf(path))
          : await readFile(path)
        replaceText(
          path,
          {
            content: file.content,
            saved: file.content,
            source: file.content,
            bytes: utf8Length(file.content),
            version: file.version,
          },
          'reload',
        )
        setStale(current => current.filter(item => item !== path))
        // Reloading is also an answer to a conflict: both sides now hold the disk's text.
        setConflict(current => (current !== null && current.path === path ? null : current))
        // And the refusal sentence stops being true: the buffer now holds what the disk holds, so
        // there is nothing unwritten for the notice to be about.
        setSaveState(current =>
          current?.kind === 'failed' && current.path === path ? null : current,
        )
        // A receipt for an action that otherwise looks like nothing happened: reloading a document
        // that already matched the disk is a no-op on screen, and the writer asked a question.
        if (unchanged && samePath(activePathRef.current ?? '', path)) {
          reportOperation('已是最新', 'success', RECEIPT_MS)
        }
        return { kind: 'reloaded' }
      } catch (error) {
        reportQuietly('重新载入失败', error)
        return { kind: 'failed', message: messageOf(error) }
      } finally {
        setBusy(false)
      }
    },
    [replaceText, reportOperation],
  )

  /** 重新载入 the showing document. */
  const reload = useCallback(async (): Promise<void> => {
    if (open === null || open.kind !== 'file') return
    await reloadPath(open.path)
  }, [open, reloadPath])

  /**
   * Keep the disk's text before a forced write replaces it.
   *
   * The copy is a byte copy through the same route 创建副本 uses (BOM, line endings, frontmatter
   * untouched), and the name is that command's own rule — one naming rule, and a name the writer
   * can find again in the tree.
   * @param path - the document whose disk version must survive.
   * @returns the copy's basename, or `null` when there was nothing on disk to keep.
   */
  const preserveDiskVersion = useCallback(
    async (path: string): Promise<string | null> => {
      const directory = dirnameOf(path)
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const listing = await listDirectory(directory)
        const name = nextCopyName(
          basenameOf(path),
          new Set(listing.entries.map(entry => entry.name)),
        )
        try {
          await copyEntry(path, name)
          // The tree is a cache and nothing watches the disk; the copy is a new entry in a level
          // the writer may be looking at.
          if (visiblePathsRef.current.includes(directory)) await loadLevel(directory, true)
          return name
        } catch (error) {
          if (!(error instanceof VaultRequestError)) throw error
          if (error.status === 404) return null
          if (error.status === 409) continue
          throw error
        }
      }
      throw new Error('同一目录里找不到可用的副本名字')
    },
    [loadLevel],
  )

  /**
   * The conflict dialog's safe answer: take the disk's text.
   *
   * It is `reloadPath`, so the in-memory text is replaced and the undo session starts over — that
   * is exactly what the button promises.
   */
  const conflictUseDisk = useCallback(async (): Promise<void> => {
    const pending = conflict
    if (pending === null || conflictBusyRef.current) return
    conflictBusyRef.current = true
    try {
      const outcome = await reloadPath(pending.path)
      if (outcome.kind === 'failed') {
        reportOperation(`读不到磁盘上的版本：${outcome.message}`, 'danger', null)
      }
    } finally {
      conflictBusyRef.current = false
    }
  }, [conflict, reloadPath, reportOperation])

  /**
   * The conflict dialog's other answer: overwrite the disk with what is here.
   *
   * The disk's text is copied first, through the same route and naming rule as 创建副本, so the
   * choice costs a file instead of losing the other writer's work. The write itself goes through
   * `writeActive` with `force` — still one write path, still the same turn guard and `saved` rule.
   */
  const conflictKeepMine = useCallback(async (): Promise<void> => {
    const pending = conflict
    if (pending === null || conflictBusyRef.current) return
    conflictBusyRef.current = true
    try {
      const kept = await preserveDiskVersion(pending.path)
      const outcome = await writeActive(pending.path, true)
      if (outcome.kind === 'failed') {
        reportOperation(`保存仍失败：${outcome.message}`, 'danger', null)
        return
      }
      setConflict(current => (current !== null && current.path === pending.path ? null : current))
      if (kept !== null) reportOperation(`磁盘上的版本已保留为 ${kept}`, 'success', RECEIPT_MS)
    } catch (error) {
      reportOperation(`没能保留磁盘上的版本，未覆盖：${messageOf(error)}`, 'danger', null)
    } finally {
      conflictBusyRef.current = false
    }
  }, [conflict, preserveDiskVersion, reportOperation, writeActive])

  /**
   * Hand the rich editor's output to the showing buffer.
   *
   * The editor produces **one** text per update; the buffer keeps it twice because two different
   * questions read it: `content` is what the rich view shows (and what the word count, the outline
   * and a remount re-import read), `source` is what the workbench will write. They are written
   * together here and nowhere else, so they cannot drift apart.
   *
   * @param markdown - the text the editor now holds (full file, frontmatter included).
   */
  const updateContent = useCallback(
    (markdown: string): void => {
      const path = activePathRef.current
      if (path === null) return
      setBuffers(current => {
        const open = current[path]
        if (open === undefined) return current
        if (open.content === markdown && open.source === markdown) return current
        // The writer changed something, so this document's auto-save comes out of standing down:
        // the retry condition is the next change, not a clock (§4.5).
        noteChange(path, open.source !== markdown)
        return { ...current, [path]: { ...open, content: markdown, source: markdown } }
      })
    },
    [],
  )

  /** Switch between the rich and source views, rebuilding the editor either way. */
  const showSource = useCallback(
    (next: boolean): void => {
      if (next === showingSource) return
      /*
       * Leaving the source view remounts the composer, so its tree is built from the current text
       * (the textarea has no tree). Entering it needs no remount.
       */
      if (showingSource) setRevision(value => value + 1)
      /*
       * Returning to the rich view also clears this document's own "source only" entry — that is
       * what makes the toolbar a way **back** after a large-document choice or a failed import.
       * The manual switch above stays what it always was: one switch for the workbench.
       *
       * Keyed by the path (a string), not by the buffer object: depending on `open` would rebuild
       * this callback — and the command table that lists it — on every keystroke.
       */
      const path = open?.path ?? ''
      if (!next && path !== '') {
        setSourceOnly(current => {
          if (current[path] !== true) return current
          const remaining = { ...current }
          delete remaining[path]
          return remaining
        })
      }
      setSourceMode(next)
    },
    [open?.path, showingSource],
  )
  /**
   * Whether the command palette is showing.
   *
   * Declared here rather than beside its own render: `openPalette` is a command in the array
   * below, and a command that reads a `const` declared further down the component is reading it
   * before its declaration.
   */
  const [paletteOpen, setPaletteOpen] = useState(false)
  /**
   * The table the caret was in when the palette opened.
   *
   * Captured at open time rather than read while rendering: the palette is a modal, so nothing can
   * move the caret between opening and choosing a row. `null` means the table section is absent.
   */
  const [paletteTable, setPaletteTable] = useState<TableTarget | null>(null)

  const commands = useMemo<readonly WorkbenchCommand[]>(
    () =>
      createWorkbenchCommands({
        state: { busy, vaultKind, open, dirty, sourceMode: showingSource, outlineOpen, findOpen },
        actions: {
          openCreatePrompt: (kind, directory) => {
            setPromptValue('')
            setPromptError(null)
            setPrompt({ kind, directory })
          },
          openRenamePrompt: target => {
            // The dialog edits the name, not the file name: a document's format is a fact about
            // the file and is put back by `submitPrompt`, so showing `.md` here would ask the
            // writer to retype something they are not changing.
            setPromptValue(target.isDirectory ? target.name : documentLabel(target.name))
            setPromptError(null)
            setPrompt({ kind: 'rename', target })
          },
          copyPath: path => {
            void (async () => {
              try {
                await writeClipboard(path)
              } catch (error) {
                reportQuietly('复制路径失败', error)
              }
            })()
          },
          reveal: path => {
            void (async () => {
              try {
                await revealEntry(path)
              } catch (error) {
                reportQuietly('打开文件位置失败', error)
              }
            })()
          },
          duplicate: target => {
            // The row menu hands the row over; the command palette has no row, so it acts on the
            // document that is open. No open document means there is nothing to copy.
            const source =
              target ??
              (open !== null
                ? { path: open.path, name: basenameOf(open.path), isDirectory: false }
                : null)
            if (source === null) return
            void duplicateEntry(source)
          },
          openMoveDialog: target => {
            if (target === null) return
            setMoveTarget(target)
            setMoveFilter('')
            setMoveChoices(null)
            void loadMoveChoices()
          },
          confirmDelete: target => setPendingDelete(target),
          refreshAll: () => {
            void reloadLevels()
          },
          openPalette: () => {
            // Table edits write to the tree, so a read-only document must not offer them — the same
            // precondition the block operations carry in their palette rows.
            const editable = editor !== null && open !== null && !readOnlyDocument(open, vaultKind)
            setPaletteTable(editable ? tableTargetAtSelection(editor) : null)
            setPaletteOpen(true)
          },
          showSource,
          save: () => {
            void save()
          },
          reload: () => {
            void reload()
          },
          closeDocument: path => {
            requestClose(path)
          },
          closeDocumentDiscard: path => {
            requestClose(path, 'discard')
          },
          chooseVault: () => {
            void chooseVault()
          },
          revokeVault: () => {
            void forgetVault()
          },
          toggleOutline,
          toggleFind: () => setFindOpen(value => !value),
          openSample: name => {
            void openSample(name)
          },
          checkUpdate: () => {
            void checkUpdate()
          },
        },
      }),
    [
      busy,
      checkUpdate,
      chooseVault,
      content,
      dirty,
      duplicateEntry,
      editor,
      findOpen,
      forgetVault,
      loadMoveChoices,
      open,
      openSample,
      outlineOpen,
      reload,
      reloadLevels,
      requestClose,
      save,
      showSource,
      showingSource,
      toggleOutline,
      vaultKind,
    ],
  )
  /**
   * The sidebar search: query, results, and the landing that follows a click.
   *
   * Declared here because the landing needs the composer and `showSource`; the search box itself
   * lives in `workbench/Sidebar.tsx` and takes this object whole.
   */
  const search = useVaultSearch({
    editor,
    editorPath,
    openPath: open?.path ?? null,
    sourceMode: showingSource,
    content,
    onShowSource: showSource,
  })


  /** Menu id to command. */
  const commandsById = useMemo(
    () => new Map(commands.map(command => [command.id, command])),
    [commands],
  )

  /**
   * Run a command by id.
   * @param id - command id.
   * @param entry - tree entry when the command acts on one.
   */
  const runCommand = useCallback(
    (id: string, entry: TreeTarget | null = null): void => {
      void commandsById.get(id)?.run(entry)
    },
    [commandsById],
  )

  /**
   * Whether a command may run right now.
   *
   * Buttons read this rather than restating the condition, so a command's
   * precondition is written once — in the registry — and the button disabling
   * itself can never drift away from what the command actually requires.
   * @param id - command id.
   * @returns true when the command is absent or not explicitly disabled.
   */
  const canRun = useCallback(
    (id: string): boolean => commandsById.get(id)?.enabled !== false,
    [commandsById],
  )

  /** The vault root as a tree entry, for the commands the sidebar offers. */
  const rootEntry: TreeTarget | null =
    root === null ? null : { path: root, name: basenameOf(root), isDirectory: true }

  /**
   * Menu rows for a list of command ids.
   *
   * The sidebar names the commands it wants and the registry supplies their labels and
   * preconditions, so a renamed or newly-disabled command cannot leave a stale string or a live row
   * behind in a menu. Same reason the tree's own context menu is built this way rather than from a
   * second list.
   * @param spec - command ids in display order; `'|'` draws a group hairline.
   * @returns rows for `Menu`, skipping any id the registry does not carry.
   */
  const menuRows = useCallback(
    (spec: readonly (string | '|')[]): MenuEntry[] => pickCommands(commandsById, spec),
    [commandsById],
  )

  /** What can be done to the whole directory. */
  /** What the toolbar's 更多 menu holds: which mode, and saving. */
  const moreMenuRows = useMemo(() => menuRows(['modeEdit', 'modeSource', 'save']), [menuRows])

  const vaultMenuRows = useMemo(
    // One list, no separators: the reader asked for no grouping. The document-scoped entries sit
    // between the directory ones because that is the order they were asked for, not because the
    // groups are meaningful here — the menu belongs to the directory but reaches the open document,
    // and pretending otherwise would have meant inventing a separator to defend.
    //
    // 功能介绍 and 关于 are last of the ordinary rows and 撤销授权 keeps the bottom: a menu whose
    // destructive row sits between two readable ones is a menu that gets mis-clicked.
    //
    // 检查更新 sits beside 关于 because that is what it is about — this plugin, not the directory.
    // It is in this list *and* in the palette (the registry allows both; the list is the only way
    // into this menu), so the writer can reach it from either place.
    () =>
      menuRows([
        'refresh',
        'chooseVault',
        'openPalette',
        'reloadDocument',
        'openFeatures',
        'openAbout',
        'checkUpdate',
        'revokeVault',
      ]),
    [menuRows],
  )

  /** What can be added to the directory the tree is showing. */
  const createMenuRows = useMemo(() => menuRows(['newFile', 'newFolder']), [menuRows])

  /**
   * Rows for the command palette: every workbench command and every editor block
   * operation.
   *
   * Both come from registries that already exist, so the palette is another
   * surface over them rather than a third list to keep in step — which is the
   * whole reason those registries were built.
   */
  const paletteEntries = useMemo<readonly PaletteEntry[]>(
    () => [
      ...commands.map(command => ({
        id: `workbench:${command.id}`,
        label: command.label,
        section: '工作台',
        enabled: command.enabled !== false,
        active: command.active,
        run: () => runCommand(command.id),
      })),
      ...BLOCK_OPERATIONS.map(operation => ({
        id: `editor:${operation.id}`,
        label: operation.label,
        section: '编辑',
        keywords: operation.keywords,
        // Block operations act on the composer's selection, so they mean nothing without an open
        // document — and nothing at all in a read-only one: they reach the tree through
        // `editor.dispatchCommand`, which Lexical does not gate on the editable flag, so this row
        // being runnable would be a way to reformat a document nothing may write.
        enabled: editor !== null && open !== null && !readOnlyDocument(open, vaultKind),
        run: () => {
          if (editor === null) return
          applyBlockOperation(editor, operation)
          editor.focus()
        },
      })),
      /*
       * Table structure edits, only while the caret is inside a table. The target is captured when
       * the palette opens; rows that cannot run on that target stay listed but disabled, so the
       * menu and the palette say the same thing about the same table.
       */
      ...(paletteTable === null
        ? []
        : TABLE_EDITS.map(operation => ({
            id: `table:${operation.id}`,
            label: operation.label,
            section: '表格',
            keywords: operation.keywords,
            enabled: refusalOf(operation, paletteTable) === null,
            run: () => {
              if (editor === null) return
              applyTableEdit(editor, operation.id, paletteTable)
              editor.focus()
            },
          }))),
    ],
    [commands, editor, open, paletteTable, runCommand, vaultKind],
  )

  /**
   * The tree row under the pointer, and the element itself.
   *
   * A ref rather than state: this changes on every pointer move across the tree, and
   * nothing renders because of it.
   *
   * **It carries no "may I" flag, and that is a decision made after measuring.** The first
   * version let each row decide: a folder was always renameable, a document only while it
   * was the document currently open in the tree (`active`, the same value that draws
   * `rowSelected`). That was the reader's own rule, and it was wrong in practice — hovering
   * a document and pressing F2 did nothing, and said so:
   * 「F2 没反应：这一行不是当前打开的那一篇文档，按规则不改名」. F2 now renames **whatever
   * row the pointer is over**, which is also what the folder half already did, so the rule
   * is one sentence instead of two. See §6.106.
   *
   * What survives is the guard, not the rule: **`node` is how "is that row still there" is
   * answered, and it replaced a path lookup.** The first version re-found the row by looking
   * its parent directory up in `levels` by exact string — a spelling question in disguise:
   * `childPath` returns a parent with a trailing separator when the parent has one,
   * `dirnameOf` strips it, and `samePath` deliberately does not reconcile trailing
   * separators. So a root spelled with one made the lookup miss and the shortcut do nothing,
   * silently. `isConnected` asks the DOM the same question with no spelling in it.
   */
  const hoveredRow = useRef<{ readonly node: Element; readonly target: TreeTarget } | null>(null)

  /**
   * Dispatch one matched binding.
   *
   * **Held in a ref, and refreshed after every render.** `runCommand` and `canRun` change
   * identity whenever `commandsById` does — which is every keystroke, because the registry
   * is rebuilt from `content` — so a listener that closed over them would either act on a
   * stale `open`/`content` or, if it listed them as dependencies, unsubscribe and
   * resubscribe the window listener on every character typed. The ref is the one shape
   * that is always current and subscribes once.
   */
  const dispatchShortcut = useRef<(shortcut: Shortcut) => void>(() => undefined)
  useEffect(() => {
    dispatchShortcut.current = (shortcut: Shortcut): void => {
      // The precondition before the effect, always: `save` declares `dirty && !busy` in the
      // registry and the write itself does **not** re-check it, so dispatching around
      // `canRun` would write a clean document back to disk for nothing.
      if (!canRun(shortcut.commandId)) return
      if (shortcut.target !== 'hovered') {
        runCommand(shortcut.commandId)
        return
      }
      const hovered = hoveredRow.current
      // The row can go away without a `pointerleave` — a level reloading, the entry renamed
      // or deleted elsewhere. Asked of the DOM rather than of the path: `isConnected` is
      // exact, and a path comparison here would be a spelling question (see the ref's doc).
      if (hovered === null || !hovered.node.isConnected) return
      runCommand(shortcut.commandId, hovered.target)
    }
  })

  // Every binding this panel owns is a row in `./shortcuts` — including `Mod+Shift+K`, so that
  // one table is the whole answer to "which keys does this panel take" and a check can look for
  // collisions in it.
  //
  // `Mod+Shift+K` rather than `Mod+K`: the harness binds `Mod+K` to session search
  // ("Desktop defaults use the platform's primary modifier, with Mod+K for search"), and a
  // plugin must not take a platform shortcut. The neighbouring combination keeps the
  // association while colliding with nothing.
  //
  // A raw listener rather than the harness shortcut service, which is not among the client
  // services this composition exposes. It is panel-scoped for free: the `main` slot is
  // keyed, so this component — and the listener with it — only exists while the Markdown
  // panel is the one on screen. **What that does not give us is the service's other
  // guarantees** — it blocks commands behind modals, resolves IME and dead keys, and
  // refuses overlapping defaults; this listener does none of those, which is why the table
  // is checked statically instead.
  useEffect(() => {
    // Asked once, here: the runtime cannot change while the page is loaded.
    const device = currentDevice()
    const onKeyDown = (event: KeyboardEvent): void => {
      // 「长按产生的重复按键不执行操作」 — the platform's own rule, and the one that matters
      // most here: holding F2 down must not open a rename prompt per repeat.
      if (event.repeat) return
      const shortcut = shortcutFor(event, device)
      if (shortcut === null) return
      event.preventDefault()
      dispatchShortcut.current(shortcut)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  /**
   * The editor's own find yields nothing to nobody, but the sidebar's search yields to it.
   *
   * Both can be on screen. When the reader opens 查找 they are working in this document, and two
   * sets of yellow with two different "current" marks would make neither readable — so the search's
   * marks go while the bar is open. Its request is untouched: closing the bar and clicking a result
   * again marks as usual.
   */
  useEffect(() => {
    if (findOpen) clearMarks('search')
  }, [findOpen])

  /**
   * Two ways the find ends that the bar cannot know about, in one place.
   *
   * Source mode has no find at all — the bar is not rendered there — and with no document open there is no
   * toolbar to render it in. Both leave `findOpen` true unless something says otherwise, and then the bar
   * would reappear when the reader came back, having been closed by nothing they did.
   *
   * Stated as one rule rather than a line at each exit, which is the shape the sidebar's search already uses
   * for the same reason: an exit added later cannot forget it.
   */
  useEffect(() => {
    if (showingSource || open === null) setFindOpen(false)
  }, [showingSource, open])

  return (
    <div style={panel}>
      <WorkbenchSidebar
        root={root}
        vaultKind={vaultKind}
        levels={levels}
        expanded={expanded}
        orders={orders}
        ordersReady={ordersReady}
        activePath={activePath}
        busy={busy}
        canDrag={canDrag}
        dragging={dragging}
        menuOpenPath={rowMenu?.target.path ?? null}
        treeRef={treeRef}
        search={search}
        vaultMenuRows={vaultMenuRows}
        createMenuRows={createMenuRows}
        rootEntry={rootEntry}
        canChooseVault={canRun('chooseVault')}
        initialTreeScroll={treeScroll}
        onTreeScroll={rememberTreeScroll}
        onRowLeave={() => {
          hoveredRow.current = null
        }}
        onCommand={(id, target) => runCommand(id, target)}
        onOpenFile={path => void openFile(path)}
        onToggleDirectory={path => toggleDirectory(path)}
        onRowMenu={(target, anchor) => setRowMenu({ target, anchorRect: anchor })}
        onCloseRowMenu={() => setRowMenu(null)}
        onRowHover={(node, target) => {
          hoveredRow.current = { node, target }
        }}
        onDragStart={(event, source) => startDrag(event, source)}
        onDragEnd={() => endDrag()}
        onDragOver={(event, source, parent) => trackDrag(event, source, parent)}
        onDrop={(event, source, parent) => finishDrag(event, source, parent)}
      />

      <section style={main}>
        {open === null ? (
          /*
            Nothing is open.
            
            Not a document area whose document is missing — an empty area, holding nothing else: no
            tab strip, no toolbar of controls that cannot act, no outline. The outline's absence is
            not a rule of its own; it is inside the other branch, which is the whole reason this is
            one branch rather than four places that each have to remember.
          */
          <div className={styles.emptyState}>
            {/* The same condition the sidebar uses, so the two cannot disagree about whether a
                directory is associated. This read `root === null`, which is a different fact:
                with nothing associated, `root` points at the plugin's own samples — that is how
                the sidebar lists 示例 — so the copy never changed. */}
            {vaultKind === 'user' ? '请在左侧选择或创建文档' : '请先在左侧关联文档仓库'}
          </div>
        ) : (
          <>
          <WorkbenchTabs
            documents={tabs.flatMap(path => {
              const buffer = buffers[path]
              if (buffer === undefined) return []
              return [
                {
                  path,
                  title: buffer.title,
                  label: documentLabel(buffer.title),
                  stale: stale.includes(path),
                },
              ]
            })}
            activePath={activePath}
            webTabs={web.tabs}
            activeWebId={web.activeId}
            onShowDocument={path => showDocument(path)}
            onCloseDocument={(path, disposition) => {
              if (disposition === 'discard') {
                runCommand('closeDocumentDiscard', {
                  path,
                  name: buffers[path]?.title ?? '',
                  isDirectory: false,
                })
                return
              }
              runCommand('closeDocument', {
                path,
                name: buffers[path]?.title ?? '',
                isDirectory: false,
              })
            }}
            onSelectWeb={id => web.select(id)}
            onCloseWeb={id => web.close(id)}
          />

          {/*
            One container, two contents. The toolbar and the find row are alternatives rather than two
            bands stacked — the same width, the same height, and neither able to change the other's
            geometry, because there is only one of them at a time.
          */}
          {/* 网页状态下工具条整条收起：那一刻屏幕上是「标签栏 ＋ 左侧栏 ＋ 网页」三样，没有第四样。 */}
          <WorkbenchToolbar
            hidden={web.active !== null}
            findOpen={findOpen}
            sourceMode={showingSource}
            editor={editor}
            query={findQuery}
            replacement={findReplacement}
            onQuery={setFindQuery}
            onReplacement={setFindReplacement}
            onCloseFind={() => setFindOpen(false)}
            readOnly={readOnly}
            dirty={dirty}
            path={open.path}
            stats={describeStats(stats)}
            canFind={canRun('toggleFind')}
            onToggleFind={() => runCommand('toggleFind')}
            moreMenuRows={moreMenuRows}
            onCommand={id => runCommand(id)}
          />

        <WorkbenchBand
          outlineOpen={outlineOpen}
          outlineWidth={outlineWidthNow}
          workspaceWidth={workspaceWidth}
          workspaceHeight={workspaceHeight}
          attachWorkspace={attachWorkspace}
          onToggleOutline={() => runCommand('toggleOutline')}
          onOutlineDragStart={startOutlineDrag}
          onOutlineResize={setOutlineWidth}
          onPaste={() => {
            const path = activePathRef.current
            if (path !== null) markImmediate(path)
          }}
          onBlur={() => {
            const path = activePathRef.current
            if (path === null) return
            markImmediate(path)
            bumpWriteEpoch()
          }}
          sourceMode={showingSource}
          saved={open.saved}
          source={open.source}
          sourceRef={sourceRef}
          onSourceScroll={top => rememberDocumentScroll(open.path, top)}
          readOnly={readOnly || closeFrozen}
          path={open.path}
          sample={open.sample}
          revision={revision}
          historyState={historyState ?? sessions.ensure(open.path)}
          sourceBase={sessions.ensureBase(open.path)}
          vaultRoot={root}
          writeAsset={writeAssetRoute}
          onEditorChange={markdown => updateContent(markdown)}
          onEditorReady={next => {
            editorRef.current = next
            setEditorPath(open?.path ?? null)
            setEditor(next)
          }}
          onEditorGone={gone => {
            // The view is gone, so the workbench must stop holding its tree (and its undo
            // history's editor reference). The identity check ignores a late cleanup from an
            // older editor after a replacement has already reported ready.
            if (editorRef.current !== gone) return
            editorRef.current = null
            setEditor(null)
            setEditorPath(null)
          }}
          onEditorNotice={reportFromEditor}
          onEditorImportMs={ms => {
            if (open !== null) reportImportTime(open.path, ms)
          }}
          onShowSource={() => {
            if (open !== null) showDocumentSource(open.path)
          }}
          openWebPage={url => web.openPage(url)}
          outline={outline}
          outlineDeferred={outlineDeferred}
          onParseOutline={parseOutline}
          activeOutlineIndex={outlineActiveIndex}
          onOutlineClick={scrollToHeading}
          notices={notices}
          webTab={web.active}
          onWebTitle={title => {
            if (web.active !== null) web.rename(web.active.id, title)
          }}
        />
          </>
        )}
      </section>
      {/*
        The entry menu — the tree's only one.

        Its trigger is not rendered here: `Menu` renders its `anchor` in place, and this
        menu is opened from two places that are not this element — a row's ⋯ button and
        a right-click anywhere on a row — so the hidden span stays the wrapper and
        `getAnchorRect` answers where the card hangs. Which entry it acts on arrives in
        the same state, so both ways in show one list and run through one lookup; a
        second `Menu` per row would be the way those two drift apart.
      */}
      <WorkbenchDialogs
        rowMenu={rowMenu}
        rowMenuRows={menuRowsFor(commands, rowMenu?.target.isDirectory === true)}
        onRowCommand={(id, target) => runCommand(id, target)}
        onCloseRowMenu={() => setRowMenu(null)}
        prompt={prompt}
        promptValue={promptValue}
        onPromptValue={value => {
          setPromptValue(value)
          // The message belongs to the name it was about; typing a new one starts clean.
          setPromptError(null)
        }}
        onClosePrompt={() => {
          setPrompt(null)
          setPromptError(null)
        }}
        onSubmitPrompt={() => void submitPrompt()}
        promptError={promptError}
        busy={busy}
        moveTarget={moveTarget}
        moveFilter={moveFilter}
        onMoveFilter={setMoveFilter}
        moveChoices={moveChoices}
        onCloseMove={() => setMoveTarget(null)}
        onSubmitMove={directory => void submitMove(directory)}
        pendingDelete={pendingDelete}
        onCloseDelete={() => setPendingDelete(null)}
        onPerformDelete={() => void performDelete()}
        closeRequest={closeRequest}
        onCloseSave={() => retryClose()}
        onCloseDiscard={() => confirmCloseDiscard()}
        onCloseCancel={() => cancelClose()}
        conflict={closeRequest === null ? conflict : null}
        onConflictUseDisk={() => {
          void conflictUseDisk()
        }}
        onConflictKeepMine={() => {
          void conflictKeepMine()
        }}
        onConflictCancel={() => setConflict(null)}
        openError={openError}
        onCloseOpenError={() => setOpenError(null)}
        onRetryOpen={failure => {
          setOpenError(null)
          if (failure.route === 'sample') void openSample(failure.path)
          else void openFile(failure.path)
        }}
        paletteOpen={paletteOpen}
        paletteEntries={paletteEntries}
        onClosePalette={() => setPaletteOpen(false)}
        largeOpen={largeOpen}
        largeRemember={largeRemember}
        onLargeRemember={setLargeRemember}
        onLargeChoose={chooseLargeOpen}
        onLargeClose={closeLargeOpen}
      />
    </div>
  )
}
