/**
 * 当前仓库会话：哪个目录被授权、它的层级、展开状态与顺序文档。
 *
 * 内容
 * - VaultSessionArgs / VaultSession / useVaultSession。
 *
 * 行为
 * - 挂载时决定看哪个仓库：快照里有根就直接用（并静默重读已画的层）；否则问 Host，
 *   再试“上次选的那条”，最后落到插件自带示例。
 * - `initial` 只收快照的仓库字段（root / vaultKind / levels / expanded），不含 buffers：
 *   文档正文与撤销历史不该被仓库会话持有。
 * - `loadLevel` 只把两层私有目录从**根**的列表里滤掉（`.img` / `.config`），深处同名目录照常显示。
 * - 顺序文档：`readOrders` 读得宽（缺失 / 坏数据都退回磁盘顺序）；`writeOrders` 带一次 CAS 重试。
 * - 窗口重新获得焦点时静默重读在屏幕上的层（没有目录监听通道）。
 * - `root` / `vaultKind` / `levels` / `expanded` / `orders` 的 setter 也交给组合根：换目录与撤销授权
 *   是跨功能事务（先 flush 文档、再关示例、再重置树），它们的原子性由组合根保证。
 *
 * 边界
 * - 不拥有标签 / 缓冲区（文档会话），不执行树上的操作，不弹提示。
 * - 不决定换目录 / 撤销的顺序（组合根）。
 *
 * 相关文件
 * - 依赖：vaultClient、treeOrder、editor/imagePath 的 IMAGE_FOLDER、shared/paths、
 *   vaultMemory、reportQuietly、workbench/model 的类型。
 * - 被依赖：MarkdownWorkbench.tsx。
 *
 * 改哪里
 * - 改挂载采纳：useVaultSession 的第一个 effect。
 * - 改顺序文档：readOrders / writeOrders。
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react'
import { childPath } from '../../shared/paths'
import { ERR_STALE, type VaultEntry } from '../../shared/protocol'
import { IMAGE_FOLDER } from '../editor/imagePath'
import {
  CONFIG_FOLDER,
  EMPTY_ORDERS,
  ORDER_FILE,
  parseOrders,
  serializeOrders,
  type TreeOrders,
} from '../treeOrder'
import {
  VaultRequestError,
  authorizeVault,
  fetchSampleVault,
  fetchVaultState,
  hideEntry,
  listDirectory,
  makeDirectory,
  readFile,
  writeFile,
} from '../vaultClient'
import { clearStoredVault, readStoredVault } from '../vaultMemory'
import { reportQuietly } from '../reportQuietly'
import type { LevelState, WorkbenchSnapshot } from './model'

/** What the session starts from: the vault fields of the snapshot this panel was restored with. */
export interface VaultSessionArgs {
  readonly initial: Pick<
    WorkbenchSnapshot,
    'root' | 'vaultKind' | 'levels' | 'expanded'
  > | null
}

/** The vault session's public face. */
export interface VaultSession {
  readonly root: string | null
  readonly vaultKind: 'sample' | 'user' | null
  readonly levels: Record<string, LevelState>
  readonly expanded: readonly string[]
  /**
   * The Host's wire-protocol version.
   *
   * `undefined` before any answer, `null` when the Host answered without the field (it predates
   * the number), and the number itself otherwise.
   */
  readonly hostProtocol: number | null | undefined
  readonly orders: TreeOrders
  readonly ordersReady: boolean
  readonly visiblePaths: readonly string[]
  /** Where this vault's order document lives, or `null` before a root exists. */
  readonly configPaths: { readonly directory: string; readonly file: string } | null
  setRoot: Dispatch<SetStateAction<string | null>>
  setVaultKind: Dispatch<SetStateAction<'sample' | 'user' | null>>
  setLevels: Dispatch<SetStateAction<Record<string, LevelState>>>
  setExpanded: Dispatch<SetStateAction<readonly string[]>>
  setOrders: Dispatch<SetStateAction<TreeOrders>>
  /** Load one directory level (quiet keeps the current rows while reloading). */
  loadLevel(path: string, quiet?: boolean): Promise<void>
  /** Quietly reload a set of levels. */
  refreshLevels(paths: readonly string[]): Promise<void>
  /** Reload every visible level, or the given ones. */
  reloadLevels(paths?: readonly string[]): Promise<void>
  /** Expand or collapse one directory, loading it the first time. */
  toggleDirectory(path: string): void
  /** Keep the plugin's two private folders out of the platform's default view. */
  hideOwnFolders(directory: string): void
  /** Read the order document (missing or unparsable ⇒ filesystem order). */
  readOrders(): Promise<TreeOrders>
  /** Write the order document, with one compare-and-set retry. */
  writeOrders(mutate: (current: TreeOrders) => TreeOrders): Promise<void>
}

/**
 * Own the vault session.
 * @param args - the snapshot this panel was restored with.
 * @returns the session state and its loaders.
 */
export function useVaultSession(args: VaultSessionArgs): VaultSession {
  const restored = args.initial
  const [root, setRoot] = useState<string | null>(restored?.root ?? null)
  const [vaultKind, setVaultKind] = useState<'sample' | 'user' | null>(
    restored?.vaultKind ?? null,
  )
  const [levels, setLevels] = useState<Record<string, LevelState>>(restored?.levels ?? {})
  const [expanded, setExpanded] = useState<readonly string[]>(restored?.expanded ?? [])
  const [hostProtocol, setHostProtocol] = useState<number | null | undefined>(undefined)
  const [orders, setOrders] = useState<TreeOrders>(EMPTY_ORDERS)
  const [ordersReady, setOrdersReady] = useState(false)

  /** The root, readable from the loaders without rebuilding them for each change. */
  const rootRef = useRef<string | null>(root)
  rootRef.current = root

  /**
   * Load one directory level into the tree.
   * @param path - absolute directory.
   * @param quiet - keep the current rows on screen while reloading, so a refresh does not
   *   collapse and rebuild the tree.
   */
  const loadLevel = useCallback(async (path: string, quiet = false): Promise<void> => {
    if (!quiet) setLevels(current => ({ ...current, [path]: { status: 'loading', entries: [] } }))
    try {
      const listing = await listDirectory(path)
      setLevels(current => ({
        ...current,
        // Two folders the tree does not show, for the same reason: the vault's own material rather
        // than notes. Filtered here, where a listing enters the app's state, so the tree, the
        // disclosure rows and the root rows cannot disagree about them — and filtered **only at the
        // vault's own root**, so a directory a writer happens to name `.img` or `.config` further
        // down is still theirs to see. The route itself keeps reporting what is on disk: this is a
        // display decision, not a filesystem one.
        [path]: {
          status: 'ready',
          entries:
            path === rootRef.current
              ? listing.entries.filter(
                  (entry: VaultEntry) =>
                    entry.name !== IMAGE_FOLDER && entry.name !== CONFIG_FOLDER,
                )
              : listing.entries,
        },
      }))
    } catch (error) {
      setLevels(current => ({
        ...current,
        [path]: {
          status: 'failed',
          entries: [],
          message: error instanceof VaultRequestError ? error.message : String(error),
        },
      }))
    }
  }, [])

  /**
   * Quietly reload a set of levels.
   * @param paths - absolute directories to reload.
   */
  const refreshLevels = useCallback(
    async (paths: readonly string[]): Promise<void> => {
      await Promise.all(paths.map(path => loadLevel(path, true)))
    },
    [loadLevel],
  )

  /** Every directory currently on screen: the root plus every expanded one. */
  const visiblePaths = useMemo(
    () => (root === null ? [] : [...new Set([root, ...expanded])]),
    [expanded, root],
  )

  /**
   * Keep the plugin's own two folders out of the platform file manager's default view.
   *
   * The vault's `.img` and `.config` are the plugin's material, not the writer's notes, and a
   * writer who never turns on "show hidden files" should not have to look at them. On Windows that
   * is the Hidden attribute; on macOS and Linux a leading dot already is hidden, so the route
   * answers without doing anything.
   *
   * Called on every mount, not only at creation: that is how a folder which already existed before
   * this was added picks the attribute up, without asking whether it exists first (a missing path
   * is not an error on that route). **Not awaited and not fatal** — it is presentation, and a
   * mount must not wait on a platform command; **nothing in the plugin reads the attribute**, so
   * the tree cannot be affected either way.
   * @param directory - the authorized vault root.
   */
  const hideOwnFolders = useCallback((directory: string): void => {
    for (const path of [childPath(directory, IMAGE_FOLDER), childPath(directory, CONFIG_FOLDER)]) {
      void hideEntry(path).catch(error => {
        reportQuietly(`隐藏 ${path} 失败`, error)
      })
    }
  }, [])

  // Adopt the vault this session should be showing. The Host's authorization dies with its
  // process, so a remembered pick is re-authorized here rather than making the user choose the same
  // directory on every restart.
  useEffect(() => {
    /**
     * A snapshot already carrying a root means this mount is a panel switch rather than a page
     * load: the tree and the tabs are already here, and re-adopting would refetch exactly what is
     * on screen.
     *
     * **What it must not do is trust it.** Those listings are as old as the moment the panel went
     * away — hours, a restart, a session in another window — and nothing else invalidates them,
     * because this tree watches no filesystem. Painting them is right: it is what makes the switch
     * instant. Leaving them as the truth is not, so every level just painted is read again,
     * quietly, right behind the paint. Without this, a folder moved in a file manager stayed on
     * screen until 刷新, and a drag could aim at a destination that had not existed for hours —
     * which is the whole of §6.110.
     *
     * `refreshLevels` and `visiblePaths` are deliberately absent from the dependency list: this
     * runs **once**, against the state the snapshot restored, which is the state being refreshed.
     */
    if (restored?.root != null) {
      void refreshLevels(visiblePaths)
      if (restored.vaultKind === 'user') hideOwnFolders(restored.root)
      return undefined
    }

    let cancelled = false
    const adopt = async (path: string, kind: 'sample' | 'user' | null): Promise<void> => {
      if (cancelled) return
      setRoot(path)
      setVaultKind(kind)
      setExpanded([path])
      // The writer's own vault, so its two private folders get the Hidden attribute — they are
      // the plugin's material, not the writer's notes. The samples are the plugin's own too, but
      // they are shown on purpose, so nothing is hidden there.
      if (kind === 'user') hideOwnFolders(path)
      await loadLevel(path)
    }

    void (async () => {
      try {
        const state = await fetchVaultState()
        // A Host built before this field existed answers without it; that is the skew to report.
        setHostProtocol(state.protocol ?? null)
        if (state.root !== null) {
          await adopt(state.root, state.kind)
          return
        }
        const remembered = readStoredVault()
        if (remembered !== null) {
          const restoredState = await authorizeVault(remembered)
          if (restoredState.root !== null) {
            await adopt(restoredState.root, restoredState.kind)
            return
          }
          // A remembered directory that no longer resolves is forgotten instead of being retried
          // on every mount. Only this branch clears it: a failure fetching the samples says
          // nothing about what was remembered.
          clearStoredVault()
        }
        // Nothing authorized yet, so show the bundled samples. They are the plugin's own
        // documents, held in memory by the Host and never written anywhere, which is what makes
        // showing them unprompted safe: nothing here can reach a directory the writer has not
        // chosen.
        const sample = await fetchSampleVault()
        const adopted = await authorizeVault(sample.path)
        if (adopted.root !== null) await adopt(adopted.root, 'sample')
      } catch {
        // Nothing left to fall back to; the picker stays on screen.
      }
    })()

    return () => {
      cancelled = true
    }
  }, [loadLevel])

  // Files copied in from another window are the ordinary case, so pick the change up when this
  // window regains focus. There is no watch channel to use instead: the harness's directory
  // watching is workspace-scoped, and the vault deliberately is not a workspace — it is a plain
  // directory the user authorized, which is what lets a notes folder stay out of the styles.
  useEffect(() => {
    if (visiblePaths.length === 0) return undefined
    const onFocus = (): void => {
      void refreshLevels(visiblePaths)
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refreshLevels, visiblePaths])

  /** Expand or collapse one directory, loading it the first time. */
  const toggleDirectory = useCallback(
    (path: string): void => {
      const isOpen = expanded.includes(path)
      setExpanded(current => (isOpen ? current.filter(item => item !== path) : [...current, path]))
      if (!isOpen && levels[path] === undefined) void loadLevel(path)
    },
    [expanded, levels, loadLevel],
  )

  /**
   * Reload directory levels.
   *
   * The hidden `refresh` command and the path-change invalidator both go through this, so
   * "what refreshing means" is defined once rather than once per caller.
   * @param paths - absolute directories to reload; defaults to everything visible.
   */
  const reloadLevels = useCallback(
    async (paths?: readonly string[]): Promise<void> => {
      await refreshLevels(paths ?? visiblePaths)
    },
    [refreshLevels, visiblePaths],
  )

  /**
   * Where this vault's order document lives.
   *
   * `null` until a root is authorized, and every caller checks it: a path built from an absent
   * root is a path in the wrong place.
   */
  const configPaths = useMemo(() => {
    if (root === null) return null
    const directory = childPath(root, CONFIG_FOLDER)
    return { directory, file: childPath(directory, ORDER_FILE) }
  }, [root])

  /**
   * Read the order document.
   *
   * Two outcomes are ordinary and silent: the file is not there yet (nobody has dragged anything)
   * and the file cannot be parsed (someone edited it into nonsense). Both mean "the filesystem's
   * own order". Anything else — a refusal, a transport failure — means an arrangement the writer
   * made is not on screen with nothing saying so, and that one is reported to the console.
   */
  const readOrders = useCallback(async (): Promise<TreeOrders> => {
    const paths = configPaths
    if (paths === null) return EMPTY_ORDERS
    try {
      const file = await readFile(paths.file)
      return parseOrders(file.content)
    } catch (error) {
      const absent = error instanceof VaultRequestError && error.status === 404
      if (!absent) reportQuietly('读取排序配置失败', error)
      return EMPTY_ORDERS
    }
  }, [configPaths])

  /**
   * Write the order document, with the one retry a compare-and-set is worth.
   *
   * `mutate` is the change this action wanted, applied to whatever document it is handed — so a
   * stale version (another window, or this vault on another machine through a sync client) costs a
   * re-read and a re-apply rather than a lost drag. A second refusal is thrown to the caller, which
   * is what puts it on screen.
   */
  const writeOrders = useCallback(
    async (mutate: (current: TreeOrders) => TreeOrders): Promise<void> => {
      const paths = configPaths
      if (paths === null || root === null) return
      // The first drag in a vault is also the moment this folder appears. `recursive` makes that
      // one call — "make sure it is there" — so nothing has to be stat'd first and there is no
      // window in which two writers both create it.
      await makeDirectory(root, CONFIG_FOLDER, true)
      // And the moment it should stop being visible in the file manager. Not awaited: the
      // attribute is presentation, and a reorder must not wait on — or fail because of — a
      // platform command. A folder that is already hidden simply is.
      void hideEntry(paths.directory).catch(error => {
        reportQuietly(`隐藏 ${paths.directory} 失败`, error)
      })
      for (let attempt = 0; attempt < 2; attempt += 1) {
        let version: string | undefined
        let current = EMPTY_ORDERS
        try {
          const file = await readFile(paths.file)
          version = file.version
          current = parseOrders(file.content)
        } catch (error) {
          const absent = error instanceof VaultRequestError && error.status === 404
          if (!absent) throw error
        }
        try {
          await writeFile(paths.file, serializeOrders(mutate(current)), version)
          return
        } catch (error) {
          const stale = error instanceof VaultRequestError && error.code === ERR_STALE
          if (attempt === 0 && stale) continue
          throw error
        }
      }
    },
    [configPaths, root],
  )

  // The document is read whenever the vault changes, and the tree waits for it (`ordersReady`).
  // The sample vault has none: it is the plugin's own material rather than the writer's, and
  // dragging is refused there — see `canDrag`.
  useEffect(() => {
    if (root === null) {
      setOrders(EMPTY_ORDERS)
      setOrdersReady(false)
      return undefined
    }
    if (vaultKind !== 'user') {
      setOrders(EMPTY_ORDERS)
      setOrdersReady(true)
      return undefined
    }
    let cancelled = false
    setOrdersReady(false)
    void (async () => {
      const document = await readOrders()
      if (cancelled) return
      setOrders(document)
      setOrdersReady(true)
    })()
    return () => {
      cancelled = true
    }
  }, [readOrders, root, vaultKind])

  return {
    root,
    vaultKind,
    levels,
    expanded,
    hostProtocol,
    orders,
    ordersReady,
    visiblePaths,
    configPaths,
    setRoot,
    setVaultKind,
    setLevels,
    setExpanded,
    setOrders,
    loadLevel,
    refreshLevels,
    reloadLevels,
    toggleDirectory,
    hideOwnFolders,
    readOrders,
    writeOrders,
  }
}
