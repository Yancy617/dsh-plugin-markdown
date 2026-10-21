/**
 * 面板快照：面板切换后要活下来的那份数据怎么存，以及滚动位置怎么记住。
 *
 * 内容
 * - UseWorkbenchSnapshotArgs / WorkbenchSnapshotState / WorkbenchSnapshotPort / useWorkbenchSnapshot。
 *
 * 行为
 * - **每次变化写穿**（`useEffect`），不靠卸载钩子：快照必须在面板离开的那一刻就是当前值，
 *   而清理路径是唯一一个"顺序可以悄悄跳过它"的地方。
 * - 滚动**不触发渲染**：它只改本文件的 ref，并把最后一个快照补上新的 `scroll` 再写一次。
 * - 面板已经卸载时落地的写结果（`patchSnapshot`）直接补进快照，不回到 React 状态。
 * - 关掉的文档由 `forgetScroll(paths)` 丢掉它的滚动位置（下次打开从顶上开始）。
 * - `documentScroll` / `treeScroll` 供恢复用；树的位置只在渲染时读一次（此后树的滚动不再渲染）。
 *
 * 边界
 * - 不拥有面板状态：`root` / `buffers` / `tabs` 等由调用方给值，这里只负责写穿。
 * - 不写盘、不读盘、不决定什么时候保存；快照的形状在 `./model.ts` 的 `WorkbenchSnapshot`。
 * - 不实现 `WorkbenchStore`（平台给的存储），不决定面板切换。
 *
 * 相关文件
 * - 依赖：../workbenchStore（WorkbenchStore）、./model（WorkbenchSnapshot / ScrollState 等）。
 * - 被依赖：MarkdownWorkbench.tsx。
 *
 * 改哪里
 * - 加快照字段：`./model.ts` 的 `WorkbenchSnapshot` ＋ 本文件的状态参数与写穿 effect。
 * - 改滚动记忆的时机：MarkdownWorkbench.tsx 里那两个 effect（恢复 / 监听）仍由调用方接线。
 */
import { useCallback, useEffect, useRef } from 'react'
import type { WorkbenchStore } from '../workbenchStore'
import type {
  BufferState,
  LargeOpenChoice,
  LevelState,
  ScrollState,
  WorkbenchSnapshot,
} from './model'

/** The panel state the snapshot is built from (everything except the scroll offsets). */
export interface WorkbenchSnapshotState {
  /** Authorized vault root, or `null`. */
  readonly root: string | null
  /** Where that root came from. */
  readonly vaultKind: 'sample' | 'user' | null
  /** Loaded directory levels, keyed by absolute path. */
  readonly levels: Record<string, LevelState>
  /** Expanded directory paths. */
  readonly expanded: readonly string[]
  /** Open documents, keyed by path. */
  readonly buffers: Record<string, BufferState>
  /** Tab order. */
  readonly tabs: readonly string[]
  /** The showing tab. */
  readonly activePath: string | null
  /** Whether the manual source switch is on. */
  readonly sourceMode: boolean
  /** Documents whose own view is the source view. */
  readonly sourceOnly: Readonly<Record<string, true>>
  /** The answer to "this document is large" for the whole session. */
  readonly largeOpenChoice: LargeOpenChoice | null
  /** Whether the outline column was open. */
  readonly outlineOpen: boolean
  /** The outline's stored width, or `null` when never set. */
  readonly outlineWidth: number | null
}

/** What the hook needs. */
export interface UseWorkbenchSnapshotArgs {
  /** The platform store the snapshot is written to. */
  readonly store: WorkbenchStore<WorkbenchSnapshot>
  /** The scroll offsets restored with the panel (a fresh panel starts at zero). */
  readonly initialScroll: ScrollState
  /** The current panel state. */
  readonly state: WorkbenchSnapshotState
}

/** What the hook hands back. */
export interface WorkbenchSnapshotPort {
  /** The tree's stored offset, read at render (a remounted sidebar starts here). */
  readonly treeScroll: number
  /** One document's stored offset, or `0`. */
  documentScroll(path: string): number
  /** Remember where the tree was left. */
  rememberTreeScroll(top: number): void
  /** Remember where one document was left. */
  rememberDocumentScroll(path: string, top: number): void
  /** Drop the offsets of documents that are closing. */
  forgetScroll(paths: readonly string[]): void
  /** Patch one buffer in the snapshot, for a result that lands after the panel is gone. */
  patchSnapshot(path: string, patch: Partial<BufferState>): void
}

/**
 * @param args - the store, the restored offsets, and the panel state to keep current.
 * @returns the readers and writers the panel needs.
 */
export function useWorkbenchSnapshot(args: UseWorkbenchSnapshotArgs): WorkbenchSnapshotPort {
  const { store, initialScroll, state } = args
  /** Live scroll offsets. A ref, because scrolling must not re-render. */
  const scrollRef = useRef<ScrollState>(initialScroll)
  /** The last snapshot written, so a scroll can extend it without a re-render. */
  const latestRef = useRef<WorkbenchSnapshot | null>(null)

  // Write-through on every change rather than on unmount: the snapshot has to
  // be current at the instant the panel goes away, and a cleanup path is the
  // one place where ordering can quietly skip it.
  //
  // The dependency list names every field instead of `state`: the caller rebuilds that object
  // each render, so depending on it would write the snapshot on every render (including the
  // ones scrolling deliberately avoids).
  useEffect(() => {
    const snapshot: WorkbenchSnapshot = {
      root: state.root,
      vaultKind: state.vaultKind,
      levels: state.levels,
      expanded: state.expanded,
      buffers: state.buffers,
      tabs: state.tabs,
      activePath: state.activePath,
      sourceMode: state.sourceMode,
      sourceOnly: state.sourceOnly,
      largeOpenChoice: state.largeOpenChoice,
      outlineOpen: state.outlineOpen,
      outlineWidth: state.outlineWidth,
      scroll: scrollRef.current,
    }
    latestRef.current = snapshot
    store.write(snapshot)
  }, [
    store,
    state.root,
    state.vaultKind,
    state.levels,
    state.expanded,
    state.buffers,
    state.tabs,
    state.activePath,
    state.sourceMode,
    state.sourceOnly,
    state.largeOpenChoice,
    state.outlineOpen,
    state.outlineWidth,
  ])

  /** Write one snapshot and remember it as the base a later scroll extends. */
  const write = useCallback(
    (next: WorkbenchSnapshot): void => {
      latestRef.current = next
      store.write(next)
    },
    [store],
  )

  /**
   * Record scroll offsets **without a render**.
   *
   * It extends the last snapshot rather than rebuilding one: this runs on every scroll frame,
   * and the panel state at that moment is whatever the last write-through already stored.
   * @param scroll - the offsets to store.
   */
  const remember = useCallback(
    (scroll: ScrollState): void => {
      scrollRef.current = scroll
      const base = latestRef.current
      if (base === null) return
      write({ ...base, scroll })
    },
    [write],
  )

  const rememberTreeScroll = useCallback(
    (top: number): void => {
      remember({ ...scrollRef.current, tree: top })
    },
    [remember],
  )

  const rememberDocumentScroll = useCallback(
    (path: string, top: number): void => {
      remember({
        ...scrollRef.current,
        documents: { ...scrollRef.current.documents, [path]: top },
      })
    },
    [remember],
  )

  const documentScroll = useCallback((path: string): number => {
    return scrollRef.current.documents[path] ?? 0
  }, [])

  /**
   * Drop a closing document's offset.
   *
   * Read through the ref (not React state), so this does not need a render of its own; the close
   * that calls it is already changing `tabs` / `buffers`, and the next write-through carries the
   * shortened map.
   * @param paths - documents that are leaving.
   */
  const forgetScroll = useCallback((paths: readonly string[]): void => {
    if (!paths.some(path => scrollRef.current.documents[path] !== undefined)) return
    const documents = { ...scrollRef.current.documents }
    for (const path of paths) delete documents[path]
    scrollRef.current = { ...scrollRef.current, documents }
  }, [])

  /**
   * Patch one buffer **in the snapshot** rather than in React state.
   *
   * The snapshot is a plain object the plugin owns, so it survives the component; that is what
   * makes it the right place for a result that arrives after the panel is gone (I13/I14).
   * @param path - absolute document path.
   * @param patch - fields to replace on its buffer.
   */
  const patchSnapshot = useCallback(
    (path: string, patch: Partial<BufferState>): void => {
      const snapshot = latestRef.current
      if (snapshot === null) return
      const existing = snapshot.buffers[path]
      if (existing === undefined) return
      write({
        ...snapshot,
        buffers: { ...snapshot.buffers, [path]: { ...existing, ...patch } },
      })
    },
    [write],
  )

  return {
    treeScroll: scrollRef.current.tree,
    documentScroll,
    rememberTreeScroll,
    rememberDocumentScroll,
    forgetScroll,
    patchSnapshot,
  }
}
