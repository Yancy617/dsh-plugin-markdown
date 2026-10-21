/**
 * 树上的操作：拖动、移动事务，以及新建 / 改名 / 删除三个入口对话框的状态。
 *
 * 内容
 * - TreeOperationsArgs / TreeOperations / useTreeOperations。
 * - 私有：DOCUMENT_LIMIT / collectDocuments（移动文件夹时要改写的笔记清单）。
 * - 状态：prompt / promptValue / promptError / pendingDelete / dragging / moveTarget /
 *   moveChoices / moveFilter。
 * - 拖动：canDrag / startDrag / endDrag / trackDrag / finishDrag 与边缘自动滚动。
 * - 事务：commitOrder / syncBuffer / performMove / duplicateEntry；对话框：loadMoveChoices /
 *   submitMove / submitPrompt / performDelete。
 *
 * 行为
 * - 同一目录内换位只写顺序文档；跨目录才动文件（`performMove` 的七步，先后不可换）。
 * - 移动先写当前文档、再移、再改图片地址、再跟随路径、再打开目的地、再同步缓冲区、最后写顺序。
 * - 改名只编辑名字，格式由原文件保留；名字没改就只关弹窗，不发请求。
 * - 名字的合法性由客户端先提示、Host 落盘前再判一次；Host 的拒绝写在 promptError 里。
 * - 复制：先保存源文档，再让 Host 做字节复制；新名字与落点由纯函数算，排序写失败只警告。
 * - 删除先落“已删除”标记并取消待写，再删文件，最后让路径跟随收掉标签与缓冲区。
 * - 拖动只在用户自己的仓库、且没有写在飞时可用；拒绝的落点不产生任何标记与删除。
 *
 * 边界
 * - 不拥有仓库会话（levels / expanded / orders 的读写器由调用方给）、不拥有打开的文档文本。
 * - 不实现路径跟随的其余一半（`applyPathChange` 在组合根：它还要改文档、标签与缓冲区）。
 * - 不画画（行与标记在 Tree.tsx，对话框在 Dialogs.tsx）。
 *
 * 相关文件
 * - 依赖：treeOrder、treeDrop、shared/documents、shared/paths、vaultClient、autoSave、imageRelink、
 *   model、reportQuietly。
 * - 被依赖：MarkdownWorkbench.tsx。
 *
 * 改哪里
 * - 改拖动与落点：startDrag / zoneFor / trackDrag / finishDrag。
 * - 改移动事务：performMove。
 * - 改三个对话框的提交：submitMove / submitPrompt / performDelete。
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type DragEvent,
  type SetStateAction,
} from 'react'
import { invalidate } from '../autoSave'
import { relinkImages } from '../editor/imageRelink'
import { reportQuietly } from '../reportQuietly'
import {
  basenameOf,
  chainTo,
  childPath,
  dirnameOf,
  isHiddenName,
  relativePath,
  samePath,
} from '../../shared/paths'
import { messageOf } from '../../shared/errors'
import { isDocument, nextCopyName, visibleEntries } from '../../shared/documents'
import {
  ERR_NOT_FOUND,
  type VaultDirectoriesResult,
  type VaultEntry,
} from '../../shared/protocol'
import {
  copyEntry,
  listDirectory,
  listVaultDirectories,
  makeDirectory,
  moveEntry,
  readFile,
  removeEntry,
  renameEntry,
  VaultRequestError,
  writeFile,
} from '../vaultClient'
import {
  orderEntries,
  placeCopy,
  renameOrderKey,
  sameNames,
  withOrder,
  type TreeOrders,
} from '../treeOrder'
import { dropKind, refuseDrop, type DropKind, type DropRow, type DropSource } from '../treeDrop'
import { promptEntryName } from './promptName'
import type {
  BufferState,
  DragState,
  DropZone,
  LevelState,
  PromptState,
  TreeTarget,
  WriteOutcome,
} from './model'
import type { NoticeTone } from '../NoticeStack'

/**
 * How many notes inside a moved folder are rewritten before the walk gives up.
 *
 * A vault can be arbitrarily large and the move has already happened by the time this runs, so
 * the work is bounded and the bound is **reported** rather than silently applied: a note whose
 * pictures still point at the old place is something the writer has to hear about.
 */
const DOCUMENT_LIMIT = 500

/**
 * How many times a copy name is asked for before the collision is reported.
 *
 * The first list is the tree's own; a 409 means it was stale (or a case variant the tree spells
 * differently), so the parent is re-read and the next number tried. Three rounds is enough to
 * absorb a stale level without turning a truly stuck name into an endless loop.
 */
const COPY_ATTEMPTS = 3

/** The drag's edge band, scroll step and interval, in pixels and milliseconds. */
const DRAG_EDGE = 28
const DRAG_SCROLL_STEP = 14
const DRAG_SCROLL_MS = 40

/**
 * Every document inside one directory, as paths relative to it.
 *
 * Needed when a **folder** moves. The notes inside it keep their bytes but change depth, and a
 * relative image destination is written for a depth — so moving `1` into `421` left
 * `…\31\1\14.md` with `../../../.img/…`, one `../` short, and the picture stopped loading. The
 * move of a document rewrites that one document; the move of a folder has to rewrite everything
 * it carries.
 *
 * Directories whose name starts with a dot are skipped: those are the plugin's own `.img` and
 * `.config`, and a writer's own hidden folders are not part of the tree either.
 * @param directory - absolute directory to walk.
 * @param limit - how many documents to collect before stopping.
 * @returns the relative paths, and whether the walk stopped early (the limit, or an unreadable
 *   directory — both mean "not everything was covered").
 */
async function collectDocuments(
  directory: string,
  limit: number,
): Promise<{ paths: string[]; truncated: boolean }> {
  const paths: string[] = []
  const queue: string[] = ['']
  while (queue.length > 0) {
    const relative = queue.shift() ?? ''
    let entries: readonly VaultEntry[]
    try {
      entries = (await listDirectory(relative === '' ? directory : childPath(directory, relative)))
        .entries
    } catch {
      // One unreadable subdirectory means the notes under it are not covered; the rest still are.
      return { paths, truncated: true }
    }
    for (const entry of entries) {
      const nested = relative === '' ? entry.name : `${relative}/${entry.name}`
      if (entry.type === 'directory') {
        if (!isHiddenName(entry.name)) queue.push(nested)
        continue
      }
      if (entry.type !== 'file' || !isDocument(entry.name)) continue
      if (paths.length >= limit) return { paths, truncated: true }
      paths.push(nested)
    }
  }
  return { paths, truncated: false }
}

/** What the tree operations read from the panel. */
export interface TreeOperationsArgs {
  /** The authorized root, or `null`. */
  readonly root: string | null
  /** Which kind of vault is showing; the sample vault refuses moves. */
  readonly vaultKind: 'sample' | 'user' | null
  /** A write / directory operation is in flight. */
  readonly busy: boolean
  setBusy: Dispatch<SetStateAction<boolean>>
  /** Loaded levels, for the names one level shows. */
  readonly levels: Record<string, LevelState>
  /** The writer's arrangement. */
  readonly orders: TreeOrders
  setOrders: Dispatch<SetStateAction<TreeOrders>>
  setExpanded: Dispatch<SetStateAction<readonly string[]>>
  /** Load one level (quiet keeps the rows while reloading). */
  loadLevel(path: string, quiet?: boolean): Promise<void>
  /** Reload a set of levels. */
  reloadLevels(paths?: readonly string[]): Promise<void>
  /** Write the order document. */
  writeOrders(mutate: (current: TreeOrders) => TreeOrders): Promise<void>
  /** The open documents, for the in-memory re-spelling after a move. */
  readonly buffers: Record<string, BufferState>
  setBuffers: Dispatch<SetStateAction<Record<string, BufferState>>>
  setStale: Dispatch<SetStateAction<readonly string[]>>
  /** Paths marked gone before the file goes, so a waiting write cannot resurrect them. */
  readonly droppedRef: { readonly current: Set<string> }
  /** Cancel one document's scheduled write. */
  cancelSchedule(path: string): void
  /** The shared flush, read at call time because it is assigned later in the panel. */
  readonly flushRef: { readonly current: (path: string) => Promise<WriteOutcome> }
  /** The tree's scrollport, for edge auto-scroll. */
  readonly treeRef: { readonly current: HTMLDivElement | null }
  /** Open one document (a newly created one). */
  openFile(path: string): Promise<void>
  /** Follow one path change across documents, levels and the order document. */
  applyPathChange(from: string | null, to: string | null): Promise<void>
  /**
   * 正文被改写（移动改址）时的唯一入口：丢会话、改正文、重挂视图（实现在组合根）。
   * 移动事务只负责算出新正文，落库那三件事不在这里各写一遍。
   */
  replaceText(
    path: string,
    next: {
      readonly content: string
      readonly saved: string
      readonly source: string
      readonly version?: string
    },
    reason: 'move',
  ): void
  /** Say something out loud: an operation's success or refusal. */
  reportOperation(text: string, tone: NoticeTone, autoMs?: number | null): void
}

/** The tree operations' public face. */
export interface TreeOperations {
  readonly prompt: PromptState | null
  setPrompt: Dispatch<SetStateAction<PromptState | null>>
  readonly promptValue: string
  setPromptValue: Dispatch<SetStateAction<string>>
  /** The Host's refusal of the last submit, shown under the name field. */
  readonly promptError: string | null
  setPromptError: Dispatch<SetStateAction<string | null>>
  readonly pendingDelete: TreeTarget | null
  setPendingDelete: Dispatch<SetStateAction<TreeTarget | null>>
  readonly dragging: DragState | null
  setDragging: Dispatch<SetStateAction<DragState | null>>
  readonly moveTarget: TreeTarget | null
  setMoveTarget: Dispatch<SetStateAction<TreeTarget | null>>
  readonly moveChoices: VaultDirectoriesResult | null
  setMoveChoices: Dispatch<SetStateAction<VaultDirectoriesResult | null>>
  readonly moveFilter: string
  setMoveFilter: Dispatch<SetStateAction<string>>
  /** Whether a row may be carried: only in the writer's own vault, and not mid-write. */
  readonly canDrag: boolean
  /** The names one level shows, or `null` while the level is not loaded. */
  displayNames(directory: string): string[] | null
  startDrag(event: DragEvent<HTMLElement>, source: DropSource): void
  endDrag(): void
  trackDrag(event: DragEvent<HTMLElement>, row: DropRow, parent: string): void
  finishDrag(event: DragEvent<HTMLElement>, row: DropRow, parent: string): void
  loadMoveChoices(): Promise<void>
  submitMove(directory: string): Promise<void>
  submitPrompt(): Promise<void>
  /** Copy one document to a sibling “ 副本<n>”. */
  duplicateEntry(source: TreeTarget): Promise<void>
  performDelete(): Promise<void>
}

/**
 * Own the tree's operations and the three entry dialogs.
 * @param args - the vault, the documents, and the callbacks the transactions hand over to.
 * @returns the state and the operations.
 */
export function useTreeOperations(args: TreeOperationsArgs): TreeOperations {
  const {
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
  } = args

  /**
   * The one prompt dialog, in whichever mode opened it: naming a new document, naming a new
   * directory, or renaming an entry. One dialog means one code path, one validation, and one
   * place the Host's refusals surface.
   */
  const [prompt, setPrompt] = useState<PromptState | null>(null)
  const [promptValue, setPromptValue] = useState('')
  const [promptError, setPromptError] = useState<string | null>(null)
  /** The entry awaiting delete confirmation; deletion is never one click. */
  const [pendingDelete, setPendingDelete] = useState<TreeTarget | null>(null)

  /** The row being carried, and the row the pointer has it over. */
  const [dragging, setDragging] = useState<DragState | null>(null)

  /** The entry the 移动到 dialog is about, and the directories it may choose. */
  const [moveTarget, setMoveTarget] = useState<TreeTarget | null>(null)
  const [moveChoices, setMoveChoices] = useState<VaultDirectoriesResult | null>(null)
  const [moveFilter, setMoveFilter] = useState('')

  /**
   * The names one level shows, in the order it shows them — the list a drag edits.
   *
   * `null` when the level is not loaded (a collapsed or empty folder): its order cannot be
   * computed from rows nobody has listed, and nothing has to be written for it either — an entry
   * the document does not list is drawn **at the top**, which is exactly where a drop into a
   * folder puts it.
   */
  const displayNames = (directory: string): string[] | null => {
    const level = levels[directory]
    if (level === undefined || level.status !== 'ready' || root === null) return null
    const key = relativePath(root, directory)
    const order = key === null ? undefined : orders.orders[key]
    return orderEntries(visibleEntries(level.entries), order).map(entry => entry.name)
  }

  /** Whether a row may be carried: only in the writer's own vault, and not mid-write. */
  const canDrag = vaultKind === 'user' && !busy

  /**
   * Start carrying a row.
   * @param event - the drag start.
   * @param source - the row being carried, with the directory it is in now.
   */
  const startDrag = (event: DragEvent<HTMLElement>, source: DropSource): void => {
    if (!canDrag) {
      event.preventDefault()
      return
    }
    // `move` and a `text/plain` payload, the way the shell's own row drag does it. The payload is
    // for the **outside**: dropped on another application it is a path that can be pasted,
    // spelled relative to the vault so it says nothing about this machine. This panel reads
    // nothing from it — what is being carried lives in `dragging`.
    const within = root === null ? null : relativePath(root, source.path)
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', within ?? source.path)
    setDragging({ source, zone: null })
  }

  /** Put the carried row down without a destination (a cancelled drag). */
  const endDrag = useCallback((): void => {
    setDragging(null)
  }, [])

  /**
   * Where a pointer position over one row would put the carried entry.
   * @param event - the drag event, whose `currentTarget` is the row.
   * @param row - the row under the pointer.
   * @param parent - the directory that row lives in.
   * @returns the zone, or `null` when this drag is not one of ours.
   */
  const zoneFor = (
    event: DragEvent<HTMLElement>,
    row: DropRow,
    parent: string,
  ): DropZone | null => {
    const carried = dragging
    if (carried === null) return null
    const kind = dropKind(event.currentTarget.getBoundingClientRect(), event.clientY, row.isDirectory)
    const directory = kind === 'into' ? row.path : parent
    // Over the row being carried: refused, and the vocabulary already has the word for it.
    // Nothing can be said about "before itself" or "after itself" that the writer would
    // recognise, and a marker there would be a line that promised a move.
    const refusal = samePath(carried.source.path, row.path)
      ? 'itself'
      : refuseDrop(carried.source, directory, displayNames(directory))
    return { path: row.path, kind, directory, refusal }
  }

  /**
   * The drag's own scrolling, for a list longer than the panel.
   *
   * The browser does scroll a scrollport when a dragged item rests near its edge — measured by the
   * writer, who saw the tree follow the pointer — but it is neither documented per engine nor
   * steerable, and the panel that scrolls here is an inner one. So the same thing is done
   * explicitly, from `dragover`, which is the event that definitely keeps arriving: rest within
   * `DRAG_EDGE` of an edge and the list keeps moving, at `DRAG_SCROLL_STEP` every `DRAG_SCROLL_MS`,
   * until the pointer comes back to the middle or the drag ends.
   *
   * The wheel is **not** handled: a browser does not deliver `wheel` to the page while an HTML5
   * drag is in flight, so this band is the only mechanism there is.
   */
  const autoScroll = useRef<number | null>(null)
  const autoScrollStep = useRef(0)

  const stopAutoScroll = useCallback((): void => {
    if (autoScroll.current === null) return
    window.clearInterval(autoScroll.current)
    autoScroll.current = null
  }, [])

  const trackAutoScroll = useCallback(
    (clientY: number): void => {
      const body = treeRef.current
      if (body === null) {
        stopAutoScroll()
        return
      }
      const rect = body.getBoundingClientRect()
      const above = clientY < rect.top + DRAG_EDGE
      const below = clientY > rect.bottom - DRAG_EDGE
      autoScrollStep.current = above ? -DRAG_SCROLL_STEP : below ? DRAG_SCROLL_STEP : 0
      if (autoScrollStep.current === 0) {
        stopAutoScroll()
        return
      }
      autoScroll.current ??= window.setInterval(() => {
        const target = treeRef.current
        if (target === null) {
          stopAutoScroll()
          return
        }
        target.scrollTop += autoScrollStep.current
      }, DRAG_SCROLL_MS)
    },
    [stopAutoScroll, treeRef],
  )

  // A drag can end anywhere — a drop, an Escape, the window losing it — and the interval must not
  // outlive the drag whichever way it ended.
  useEffect(() => stopAutoScroll, [stopAutoScroll])

  /*
   * There is deliberately **no** wheel handling here.
   *
   * A wheel listener was written for dragging (on `document`, capture phase, `preventDefault`) and
   * the writer tested it: it never fires. That is the measurement this comment exists to keep —
   * **a browser does not deliver `wheel` to the page while an HTML5 drag is in flight**, so no
   * listener can scroll the list that way, in this environment. The edge bands above are the
   * mechanism that works (they ride `dragover`), and they stay.
   *
   * Wheel scrolling *during* a drag would mean giving up HTML5 drag-and-drop for a pointer-events
   * drag of our own — and with it the native drag image, the `text/plain` payload another
   * application receives, and the platform's own edge scrolling. That is a round of its own, not a
   * line to slip in here.
   */

  /**
   * Say where the carried row would land.
   *
   * `dragover` is the only event that can say so and the only one that has to be prevented for a
   * drop to be allowed at all — which is why a drag this panel did not start returns before
   * touching either.
   */
  const trackDrag = (event: DragEvent<HTMLElement>, row: DropRow, parent: string): void => {
    const carried = dragging
    const zone = zoneFor(event, row, parent)
    if (carried === null || zone === null) return
    event.preventDefault()
    trackAutoScroll(event.clientY)
    event.dataTransfer.dropEffect = zone.refusal === null ? 'move' : 'none'
    const current = carried.zone
    if (
      current !== null &&
      current.path === zone.path &&
      current.kind === zone.kind &&
      current.refusal === zone.refusal
    ) {
      return
    }
    setDragging({ source: carried.source, zone })
  }

  /** Put the carried row down, if that is allowed here. */
  const finishDrag = (event: DragEvent<HTMLElement>, row: DropRow, parent: string): void => {
    const carried = dragging
    const zone = zoneFor(event, row, parent)
    stopAutoScroll()
    setDragging(null)
    if (carried === null || zone === null || zone.refusal !== null) return
    event.preventDefault()
    void dropInto(carried.source, zone)
  }

  /**
   * One level's names with an entry placed where it was dropped.
   *
   * The entry is taken out before it is put back, so a position below its own shifts up by one —
   * without that, dragging a row downwards lands it one row short of the mark. `into` and a
   * missing anchor both mean the top, which is what "into this folder" means when the row it was
   * dropped on stands for the whole folder.
   * @param names - the level's names, in display order.
   * @param name - the entry being placed.
   * @param kind - which band it was dropped on.
   * @param anchorName - the row it was dropped on, or `null` for `into`.
   * @returns a new array.
   */
  const placeName = (
    names: readonly string[],
    name: string,
    kind: DropKind,
    anchorName: string | null,
  ): string[] => {
    const from = names.indexOf(name)
    const rest = from === -1 ? [...names] : names.filter((_name, index) => index !== from)
    let at = 0
    if (kind !== 'into' && anchorName !== null) {
      const anchor = rest.indexOf(anchorName)
      at = anchor === -1 ? rest.length : anchor + (kind === 'after' ? 1 : 0)
    }
    return [...rest.slice(0, at), name, ...rest.slice(at)]
  }

  /**
   * Carry out one drop: a reorder when the entry stays in its directory, a move when it does not.
   *
   * The two are one gesture, and the branch is here rather than in the handlers because they
   * cannot know it: `before`/`after` within the entry's own level is a write to the order
   * document, and the same bands inside another level are a filesystem operation.
   * @param source - the row being carried.
   * @param zone - where it was dropped.
   */
  const dropInto = async (source: DropSource, zone: DropZone): Promise<void> => {
    const names = displayNames(zone.directory)
    const anchor = zone.kind === 'into' ? null : basenameOf(zone.path)
    if (samePath(zone.directory, source.parent)) {
      // Same directory: the rows changed places and the file does not move. A reorder needs the
      // level's own list, because that list is what is being edited.
      if (names === null) return
      const next = placeName(names, source.name, zone.kind, anchor)
      if (sameNames(names, next)) return
      await commitOrder(zone.directory, next)
      return
    }
    // A move. The destination's order only matters when it is known: `null` for a folder nobody
    // has expanded, and then nothing is written for that level — an entry the document does not
    // list is drawn at the top, which is where `into` puts it anyway.
    await performMove(
      source,
      zone.directory,
      names === null ? null : placeName(names, source.name, zone.kind, anchor),
    )
  }

  /**
   * Write one level's order, optimistically.
   *
   * The rows are already where the writer dropped them, so the document follows the screen; a
   * refusal rolls the screen back to what the document still says, and says why. A failed reorder
   * costs the arrangement and nothing else, which is why it is a warning.
   * @param directory - the level.
   * @param names - its names, in the order now on screen.
   */
  const commitOrder = async (directory: string, names: readonly string[]): Promise<void> => {
    if (root === null) return
    const key = relativePath(root, directory)
    if (key === null) return
    const before = orders
    setOrders(withOrder(before, key, names))
    try {
      await writeOrders(current => withOrder(current, key, names))
    } catch (error) {
      setOrders(before)
      reportOperation(`排序未保存：${messageOf(error)}`, 'warning')
    }
  }

  /**
   * Make one open document agree with what is on disk after a move.
   *
   * Used after a move: the text may have been re-spelled on the way (its image destinations), and
   * the buffer has to hold what the file holds or the next save writes the old spelling back.
   *
   * **正文真变了才走 `replaceText`**（它会丢会话并重挂视图）；只是版本变了就只更新版本 ——
   * 一次不改变文本的移动仍然保留撤销历史与原文基线。
   */
  const syncBuffer = async (path: string): Promise<void> => {
    const before = buffers[path]
    if (before === undefined) return
    const file = await readFile(path)
    if (
      before.content !== file.content ||
      before.saved !== file.content ||
      before.source !== file.content
    ) {
      replaceText(
        path,
        { content: file.content, saved: file.content, source: file.content, version: file.version },
        'move',
      )
    } else {
      setBuffers(current => {
        const open = current[path]
        if (open === undefined || open.version === file.version) return current
        return { ...current, [path]: { ...open, version: file.version } }
      })
    }
    setStale(current => current.filter(item => item !== path))
  }

  /**
   * Move one entry into another directory — the whole transaction.
   *
   * Ordered the way it has to be, and every step is here rather than in the drop handler because
   * each one can fail on its own:
   *
   * 1. **save first** — what follows rewrites the document's text on disk and then moves the
   *    file, and a buffer still holding the text it had under the old path would put the old
   *    image destinations back on the next save;
   * 2. **move**;
   * 3. **re-spell the destinations that depend on where the entry sits** — the document itself,
   *    or **every note a moved folder carries**, because a relative destination is written for a
   *    depth and a folder move changes the depth of everything inside it. Done after the move, so
   *    that a move which fails leaves every byte as it was;
   * 4. **follow the path** — the tree, the tabs, the buffers, the expanded levels;
   * 5. **open the way** — the destination and every level above it;
   * 6. **re-read the document** — step 3 may have changed its text;
   * 7. **the order document** — out of the old level, into the new one, and, for a folder, every
   *    key filed under the path it just left.
   *
   * A failure before the move leaves everything as it was. A failure after it does not: the file
   * is in its new place, and what is left to say is either where it sits in the list (step 7) or
   * which notes still point at the old place (step 3) — both are said out loud rather than
   * reporting a move that happened as one that did not.
   * @param source - the row being carried.
   * @param directory - the directory it is going into.
   * @param destinationNames - that directory's order with the entry already in place, or `null`
   *   when the level is not loaded and nothing can be written for it.
   */
  const performMove = async (
    source: DropSource,
    directory: string,
    destinationNames: readonly string[] | null,
  ): Promise<void> => {
    const vaultRoot = root
    if (vaultRoot === null) return
    const from = source.path
    const to = childPath(directory, source.name)
    setBusy(true)
    try {
      /**
       * 1. **save first** — as a write through the shared path rather than a bare `writeFile`.
       *
       * It has to be first for the reason below (the re-spelling), and it goes through `flush`
       * because a scheduled write must not be able to land *between* this one and the move: two
       * writes carrying the same version would have the later one refused, and a move that
       * worked perfectly would be followed by 「保存未生效」 (I16).
       */
      await flushRef.current(from)
      /**
       * What travels with the entry, decided **before** it moves so the paths are read from the
       * tree that is still standing: the note itself, or every note inside the folder.
       */
      const carried = source.isDirectory
        ? await collectDocuments(from, DOCUMENT_LIMIT)
        : { paths: [''], truncated: false }
      /**
       * The move itself, in a `try` of its own.
       *
       * **Two different paths, and the route wants `directory`.**
       *
       * `to` is where the entry ends up — `<destination directory>/<its own name>` — while
       * `directory` is the folder that receives it. The route's contract is the **directory**: it
       * keeps the basename itself and checks the name there.
       *
       * This call passed `to` for a while, and the symptom was a move that always failed with
       * 「目标目录不存在：…\<被移动对象自己的名字>」 — a path that reads exactly like the folder the
       * writer dropped on, and never was one. What gave it away was the same refusal twice, once
       * for a folder and once for a document: the second one's "destination" ended in `.md`.
       * Same-directory drags kept working the whole time, because a reorder never reaches this
       * call at all.
       *
       * Two refusals also arrive as a 404 and they mean opposite things, so they are told apart by
       * the **code** rather than by the status: the host's own refusal carries `not-found` (the
       * destination would not stat), while a 404 with any other code is the web server answering a
       * route that is not there — a host half that has not been restarted since the route was
       * added.
       */
      let moved: { readonly path: string }
      try {
        moved = await moveEntry(from, directory)
      } catch (error) {
        if (!(error instanceof VaultRequestError)) throw error
        if (error.code === ERR_NOT_FOUND) {
          /**
           * The host asked the directory above and said what it saw (see `moveEntry`), so its
           * sentence is the one to show. Only the thing it cannot know is added here: the row was
           * on screen because **the tree is a cache** — reloaded when the window regains focus and
           * by 刷新, watching nothing — so the level it came from is re-read, and that is what
           * makes a second attempt different from the first.
           */
          await reloadLevels([dirnameOf(directory)])
          reportOperation(
            `移动失败：${messageOf(error)}。这一层已经重新读取，请再试一次。`,
            'danger',
            null,
          )
          return
        }
        if (error.status === 404 || error.status === 405) {
          // Measured against the running server: a path with no route answers **405 with an
          // empty body**, not 404 — so this branch is about the request never reaching the route
          // (a host half older than the route), and it must not be confused with the host's own
          // refusal above.
          reportOperation(
            '移动失败：这条请求没有到达 /move 路由 —— 改过 Host 的版本要重启 DSH 才生效。',
            'danger',
            null,
          )
          return
        }
        throw error
      }
      /**
       * Re-spell the destinations that depend on where the entry sits — **after** the move, so a
       * move that fails leaves every byte as it was, and reading from the new path is reading the
       * file that is actually there.
       *
       * `relinkImages` takes both paths on purpose: the text in hand was written for `before`
       * (that is what its `../../../` count means) and has to be spelled for `after`.
       *
       * A folder takes its notes along, so one entry here becomes one entry per note inside it —
       * a document move rewrites the document, a folder move rewrites everything it carries. A
       * note that cannot be read or written does not stop the rest: the folder is already where
       * the writer put it, and which notes still point at the old place is worth saying out loud.
       */
      const failed: string[] = []
      for (const inside of carried.paths) {
        const before = inside === '' ? from : childPath(from, inside)
        const after = inside === '' ? moved.path : childPath(moved.path, inside)
        try {
          const file = await readFile(after)
          const relinked = relinkImages(file.content, before, after, vaultRoot)
          if (relinked !== file.content) await writeFile(after, relinked, file.version)
        } catch {
          failed.push(relativePath(vaultRoot, after) ?? after)
        }
      }
      if (carried.truncated) {
        reportOperation(
          `移动完成，但文件夹里超过 ${DOCUMENT_LIMIT} 篇笔记，只改了前 ${DOCUMENT_LIMIT} 篇里的图片地址。`,
          'warning',
        )
      }
      if (failed.length > 0) {
        reportOperation(
          `移动完成，但 ${failed.length} 篇笔记的图片地址没改过来：${failed.slice(0, 3).join('、')}${
            failed.length > 3 ? ' 等' : ''
          }`,
          'warning',
        )
      }
      await applyPathChange(from, moved.path)
      /**
       * An open note holds its own copy of the text, and that copy has the same old count of `../`
       * — rewriting only the file would leave the buffer to put the stale spelling back on the
       * next save. So the carried set is re-spelled in memory as well, under the **new** keys
       * `applyPathChange` has just installed. Dirtiness is preserved: a buffer that was clean
       * stays clean (its `saved` follows), one that was dirty stays dirty, with both spellings
       * rewritten.
       */
      /*
       * A move that changes the depth rewrites image destinations in the text. `content`, `saved`
       * and the save mirror (`source`) all describe the **old** spelling, so they are re-spelled
       * together — through `replaceText`, the one entry for "the body was rewritten outside the
       * editor": it drops the session (the block baseline is dropped, never re-spelled: its spans
       * are byte offsets into the old text) and remounts the view.
       *
       * Only the documents whose destinations actually moved are touched; a move that changes no
       * text leaves undo history and the baseline alone.
       */
      for (const inside of carried.paths) {
        const before = inside === '' ? from : childPath(from, inside)
        const after = inside === '' ? moved.path : childPath(moved.path, inside)
        const open = buffers[before] ?? buffers[after]
        if (open === undefined) continue
        const content = relinkImages(open.content, before, after, vaultRoot)
        const saved =
          open.saved === open.content ? content : relinkImages(open.saved, before, after, vaultRoot)
        const source = relinkImages(open.source, before, after, vaultRoot)
        if (content === open.content && saved === open.saved && source === open.source) continue
        replaceText(after, { content, saved, source }, 'move')
      }
      /**
       * Open the way to it.
       *
       * Into a folder that is closed, a successful move looks like nothing happened — the entry is
       * on disk, in the right place, and off screen. So the destination is opened, **and every
       * level between the root and it**: the drop can only land on a row that is drawn, but the
       * 移动到 dialog can name a folder three levels inside a branch nobody has opened.
       *
       * Nothing is ever closed (the union only adds), so a folder that was open stays open, and
       * one that was closed opens. The levels are read with `quiet`, which leaves an
       * already-loaded level on screen while it refreshes instead of blinking it back to
       * 「加载中…」.
       */
      const reveal = chainTo(vaultRoot, directory)
      if (reveal.length > 0) {
        setExpanded(current => [...new Set([...current, ...reveal])])
        await Promise.all(reveal.map(path => loadLevel(path, true)))
      }
      await syncBuffer(moved.path)

      const fromKey = relativePath(vaultRoot, from)
      const toKey = relativePath(vaultRoot, moved.path)
      const parentKey = relativePath(vaultRoot, source.parent)
      const sourceNames = displayNames(source.parent)
      const mutate = (current: TreeOrders): TreeOrders => {
        let document =
          source.isDirectory && fromKey !== null && toKey !== null
            ? renameOrderKey(current, fromKey, toKey)
            : current
        if (parentKey !== null && sourceNames !== null) {
          document = withOrder(
            document,
            parentKey,
            sourceNames.filter(name => name !== source.name),
          )
        }
        if (toKey !== null && destinationNames !== null) {
          document = withOrder(document, toKey, destinationNames)
        }
        return document
      }
      setOrders(mutate)
      try {
        await writeOrders(mutate)
      } catch (error) {
        reportOperation(`移动完成，但排序未保存：${messageOf(error)}`, 'warning')
      }
    } catch (error) {
      reportOperation(`移动失败：${messageOf(error)}`, 'danger', null)
    } finally {
      setBusy(false)
    }
  }

  /**
   * Load the directories the 移动到 dialog may offer.
   *
   * One request, made when the dialog opens rather than with the tree: every directory in the
   * vault is what a picker needs and what a tree never lists. A refusal leaves the list empty and
   * says so in the notice layer, which is where an action's failure belongs.
   */
  const loadMoveChoices = useCallback(async (): Promise<void> => {
    try {
      setMoveChoices(await listVaultDirectories())
    } catch (error) {
      setMoveChoices({ root: '', directories: [], truncated: false })
      reportOperation(`读取目录失败：${messageOf(error)}`, 'danger', null)
    }
  }, [reportOperation])

  /**
   * Move the entry the dialog is about.
   *
   * The same transaction the drag runs; the dialog only picks the directory. What a list of
   * directories cannot say is whether the target already holds that name — the host refuses that
   * one, and the refusal arrives in the operation notice.
   * @param directory - the chosen destination.
   */
  const submitMove = async (directory: string): Promise<void> => {
    const target = moveTarget
    if (target === null) return
    setMoveTarget(null)
    const names = displayNames(directory)
    await performMove(
      { ...target, parent: dirnameOf(target.path) },
      directory,
      names === null ? null : placeName(names, target.name, 'into', null),
    )
  }

  /**
   * Run whichever prompt is open.
   *
   * A new file sends no version: the Host applies a create-if-absent guard by itself when the
   * target does not exist, so an existing file is refused rather than silently emptied.
   *
   * A rename edits a document's **name**, not its file name: the format is carried over from the
   * file being renamed (`promptEntryName`), so the dialog never asks for it and a name that was
   * not changed closes the dialog instead of asking the platform to rename a file onto itself
   * — which it refuses, and which used to arrive as a console line with nothing on screen.
   *
   * The name is complete before any request goes out: the dialog's own check and this submit
   * both call `promptEntryName`, so what the writer sees validated is exactly what is asked for.
   */
  const submitPrompt = useCallback(async (): Promise<void> => {
    const active = prompt
    if (active === null) return
    const nextName = promptEntryName(active, promptValue)
    if (nextName === '') return
    setPromptError(null)
    if (active.kind === 'rename' && nextName === active.target.name) {
      setPrompt(null)
      return
    }
    setBusy(true)
    try {
      if (active.kind === 'rename') {
        const from = active.target.path
        /**
         * Leaving this document's path, so its unwritten text is written **before** the name
         * changes: `applyPathChange` re-keys the buffer, and a write that had already been sent
         * would be aimed at the old path. It is also the one honest way to settle whether renaming
         * the file changes its freshness token — after this, the buffer is clean and re-keying it
         * carries a token that still matches the file.
         */
        await flushRef.current(from)
        const result = await renameEntry(from, nextName)
        setPrompt(null)
        await applyPathChange(from, result.path)
      } else if (active.kind === 'directory') {
        const created = await makeDirectory(active.directory, nextName)
        setPrompt(null)
        await applyPathChange(null, created.path)
      } else {
        const target = childPath(active.directory, nextName)
        await writeFile(target, '')
        setPrompt(null)
        await applyPathChange(null, target)
        await openFile(target)
      }
    } catch (error) {
      const what = active.kind === 'rename' ? '重命名' : '新建'
      setPromptError(`${what}失败：${messageOf(error)}`)
      reportQuietly(`${what}失败`, error)
    } finally {
      setBusy(false)
    }
  }, [applyPathChange, openFile, prompt, promptValue, setBusy])

  /**
   * Copy one document to a sibling “ 副本<n>”.
   *
   * The bytes are the Host's job (`copyFile`); this transaction decides the name, saves the source
   * first when it has unwritten text, and files the new row. It deliberately does **not** open the
   * copy: the tree row is the receipt, and switching the editor away from the source would be a
   * second, unasked-for effect.
   * @param source - the document row to copy.
   */
  const duplicateEntry = useCallback(
    async (source: TreeTarget): Promise<void> => {
      const vaultRoot = root
      if (vaultRoot === null || source.isDirectory) return
      setBusy(true)
      try {
        /**
         * A copy of what the writer sees has to include text that has not reached disk yet, so
         * the source is written first. A failed save cancels the copy: copying the old bytes would
         * quietly make a copy of a different document than the one on screen.
         */
        const outcome = await flushRef.current(source.path)
        if (outcome.kind === 'failed') {
          reportOperation(
            `复制已取消：这篇文档没有保存成功。${outcome.message}`,
            'danger',
            null,
          )
          return
        }
        const parent = dirnameOf(source.path)
        const key = relativePath(vaultRoot, parent)
        if (key === null) {
          reportOperation('复制失败：源文件不在当前仓库里。', 'danger', null)
          return
        }
        /**
         * The names the copy must not take: every child of the directory, not just the visible
         * documents — a folder or a picture named `会议 副本1.md` is still a collision.
         */
        const level = levels[parent]
        let taken = new Set(
          level !== undefined && level.status === 'ready'
            ? level.entries.map(entry => entry.name)
            : [source.name],
        )
        taken.add(source.name)
        let name = nextCopyName(source.name, taken)
        let copied: { readonly path: string } | null = null
        for (let attempt = 0; attempt < COPY_ATTEMPTS; attempt += 1) {
          try {
            copied = await copyEntry(source.path, name)
            break
          } catch (error) {
            const collision = error instanceof VaultRequestError && error.status === 409
            if (!collision || attempt === COPY_ATTEMPTS - 1) throw error
            const attempted = name
            try {
              // The tree's list can be as old as the last focus / 刷新. A refusal means it missed
              // a name, so read the directory again before asking for the next number.
              const fresh = await listDirectory(parent)
              taken = new Set(fresh.entries.map(entry => entry.name))
            } catch {
              // Keep the list we had; the attempted name is added below either way.
            }
            // The attempted name is kept even when the fresh list spells a case variant
            // differently: the Host's collision was real, and asking for the same candidate again
            // would only earn the same 409.
            taken.add(attempted)
            taken.add(source.name)
            name = nextCopyName(source.name, taken)
          }
        }
        if (copied === null) throw new Error('复制没有返回路径')
        const names = displayNames(parent)
        if (names !== null) {
          const nextNames = placeCopy(names, source.name, basenameOf(copied.path))
          const mutate = (current: TreeOrders): TreeOrders => withOrder(current, key, nextNames)
          try {
            // Written before the level is re-read, so the new row appears in its final position
            // rather than at the top and then jumping. A failure leaves the copy on disk; the
            // warning says the order did not land, and the next read shows it unlisted.
            await writeOrders(mutate)
            setOrders(mutate)
          } catch (error) {
            reportOperation(`复制完成，但排序没保存：${messageOf(error)}`, 'warning')
          }
        }
        await loadLevel(parent, true)
      } catch (error) {
        /**
         * A Host that predates the route answers 405 (empty body) or a 404 that is not its own
         * `not-found` code. Saying so is the difference between "copy is broken" and "restart
         * DSH"; the same distinction `performMove` makes for `/move`.
         */
        const missingRoute =
          error instanceof VaultRequestError &&
          (error.status === 405 || (error.status === 404 && error.code !== ERR_NOT_FOUND))
        reportOperation(
          missingRoute
            ? '复制失败：这条请求没有到达 /copy 路由 —— 改过 Host 的版本要重启 DSH 才生效。'
            : `复制失败：${messageOf(error)}`,
          'danger',
          null,
        )
      } finally {
        setBusy(false)
      }
    },
    [displayNames, levels, loadLevel, reportOperation, root, setBusy, setOrders, writeOrders],
  )

  /** Delete the entry awaiting confirmation. */
  const performDelete = useCallback(async (): Promise<void> => {
    const target = pendingDelete
    if (target === null) return
    setBusy(true)
    try {
      /**
       * Mark it gone **before** the file goes, and cancel anything scheduled for it.
       *
       * A delete is two steps — the file, then the tab — and a write sitting in that window would
       * put the file the writer just deleted straight back. The mark is lifted when the path is
       * opened again (`openFile`); the scheduled write is cancelled because its turn is never
       * coming (§4.9 disposition *discard*).
       */
      droppedRef.current.add(target.path)
      cancelSchedule(target.path)
      invalidate(target.path)
      await removeEntry(target.path, target.isDirectory)
      setPendingDelete(null)
      await applyPathChange(target.path, null)
    } catch (error) {
      // The file is still there, so nothing is "dropped": a stale mark would block auto-save for
      // a document that is very much alive.
      droppedRef.current.delete(target.path)
      reportQuietly('删除失败', error)
    } finally {
      setBusy(false)
    }
  }, [applyPathChange, cancelSchedule, pendingDelete, setBusy])

  return {
    prompt,
    setPrompt,
    promptValue,
    setPromptValue,
    promptError,
    setPromptError,
    pendingDelete,
    setPendingDelete,
    dragging,
    setDragging,
    moveTarget,
    setMoveTarget,
    moveChoices,
    setMoveChoices,
    moveFilter,
    setMoveFilter,
    canDrag,
    displayNames,
    startDrag,
    endDrag,
    trackDrag,
    finishDrag,
    loadMoveChoices,
    submitMove,
    submitPrompt,
    duplicateEntry,
    performDelete,
  }
}
