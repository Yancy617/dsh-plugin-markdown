/**
 * 文档目录列：开关、宽度、目录内容、当前行与点击跳转。
 *
 * 内容
 * - OutlineColumnOptions / OutlineColumn、useOutlineColumn。
 *
 * 行为
 * - 目录内容：富文本读**编辑器树**（`../editor/headingTree.ts`），源码视图读文本
 *   （`../editor/outline.ts`）。两边都是"结构"，区别只在什么时候算 —— 文本那条用一个慢半拍的
 *   值兜住击键（解析一次约 16 ms），富文本读已经建好的树。
 * - 源码视图还有两个条件：目录列开着才算；文档超过 `OUTLINE_AUTO_BYTES` 时不自动算，
 *   读者按「解析目录」点一次（`parse`）才算。这两条让"切到源码视图"这条退路不被目录解析拖住。
 * - 宽度：渲染用 `clampStoredWidth`（只按目录自己的上下界，窗口宽度不参与）；拖动时另外受
 *   `clampOutline` 的编辑区地板约束。存进快照的是原始值（`storedWidth`，未决定时 `null`），
 *   没决定时按 `OUTLINE_DEFAULT`（220）显示 —— 不量左栏、不跟窗口。
 * - 当前行由 `useActiveHeading` 算；点一行时先 `hold` 住高亮，滚到地方再闪一下
 *   （`../editor/headingFlash.ts`）。
 * - 关掉的文档由 `forget(paths)` 丢掉它自己的"按需解析"记录。
 *
 * 边界
 * - 不拥有编辑器与滚动盒（都由调用方给引用）；不画界面（`Band.tsx`）。
 * - 不决定目录该不该显示（`showingSource` / `editor` 说明那一刻有没有树）。
 * - 不写盘、不改文档、不改选区。
 *
 * 相关文件
 * - 依赖：../editor/outline.ts、../editor/headingTree.ts、../editor/headingFlash.ts、
 *   ./useActiveHeading.ts、./useDelayedValue.ts、../largeDocument.ts、../layout.ts。
 * - 被依赖：MarkdownWorkbench.tsx。
 *
 * 改哪里
 * - 改宽度的上下界：../layout.ts。
 * - 改"当前读到哪一节"：../editor/outlineActive.ts（经 useActiveHeading）。
 * - 改目录内容的取法：../editor/outline.ts（文本）/ ../editor/headingTree.ts（树）。
 * - 改解析时机：本文件的 textDelayMs 与 OUTLINE_AUTO_BYTES 判断。
 */
import type { LexicalEditor } from 'lexical'
import {
  useCallback,
  useMemo,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react'
import { headingEntries, headingKeys } from '../editor/headingTree'
import { afterScrollSettles, flashHeading } from '../editor/headingFlash'
import { outlineOf, type OutlineEntry } from '../editor/outline'
import { OUTLINE_AUTO_BYTES } from '../largeDocument'
import {
  clampOutline,
  clampStoredWidth,
  OUTLINE_DEFAULT,
} from '../layout'
import { useActiveHeading } from './useActiveHeading'
import { useDelayedValue } from './useDelayedValue'

/** What the hook needs. */
export interface OutlineColumnOptions {
  /** The document text: both the source-view outline and its "did the layout move" signal. */
  readonly content: string
  /** The document's size in UTF-8 bytes, for the "do not parse a large source view" threshold. */
  readonly documentBytes: number
  /** The showing document's path, or `''` when none is open. */
  readonly openPath: string
  /** The source view is what is on screen: there is no editor tree to read. */
  readonly showingSource: boolean
  /** The live composer, or `null` in the source view. */
  readonly editor: LexicalEditor | null
  /** The element that scrolls the document, for the active row and the jump geometry. */
  readonly scrollport: HTMLDivElement | null
  /** The same element, read at click time rather than at render time. */
  readonly scrollportRef: RefObject<HTMLDivElement | null>
  /** Whether the column was open when the panel was last left. */
  readonly initialOpen: boolean
  /** The stored width from the snapshot, or `null` when it has never been decided. */
  readonly initialWidth: number | null
  /** How long the source view's text has to settle before it is parsed (milliseconds). */
  readonly textDelayMs: number
}

/** What the hook hands back. */
export interface OutlineColumn {
  /** The column is open. */
  readonly open: boolean
  /** Flip the column. */
  toggle(): void
  /** The stored width, or `null` while it has not been decided yet. */
  readonly storedWidth: number | null
  /** The width to render (`clampStoredWidth` applied). */
  readonly width: number
  /** Take a width from the keyboard resize in the band. */
  resize(width: number): void
  /** The document's headings, in document order. */
  readonly entries: readonly OutlineEntry[]
  /** The outline was deliberately not parsed because the document is large. */
  readonly deferred: boolean
  /** Parse the source view's outline once, because the reader asked for it. */
  parse(): void
  /** Row number of the heading being read, or `-1`. */
  readonly activeIndex: number
  /** Bring the heading at `index` into view, and flash it. */
  jumpTo(index: number): void
  /** Start dragging the divider. */
  startDrag(event: ReactPointerEvent<HTMLDivElement>): void
  /** Drop the per-document parse request of documents that are leaving. */
  forget(paths: readonly string[]): void
}

/**
 * @param options - the document, the two boxes the column measures, and the restored values.
 * @returns the column's open state, width, entries, active row and the four actions.
 */
export function useOutlineColumn(options: OutlineColumnOptions): OutlineColumn {
  const {
    content,
    documentBytes,
    openPath,
    showingSource,
    editor,
    scrollport,
    scrollportRef,
    initialOpen,
    initialWidth,
    textDelayMs,
  } = options

  const [open, setOpen] = useState(initialOpen)
  /**
   * The outline's width, or `null` while it has not been decided yet.
   *
   * `null` and not a number, so that a session that never touches the handle stores nothing and
   * keeps opening at `OUTLINE_DEFAULT`. A stored width is the writer's answer, and only the writer
   * gives one.
   */
  const [width, setWidth] = useState<number | null>(initialWidth)
  /** Source-view documents whose outline the reader asked to parse. */
  const [requested, setRequested] = useState<Readonly<Record<string, true>>>({})

  /**
   * 文档目录：富文本读**编辑器树**，源码视图（没有树）读文本。
   *
   * 两边都是"结构"：树是导入时 mdast 建出来的；文本那条路也交给同一个解析器
   * （`editor/outline.ts` 的 `parseBody`）。区别只在**什么时候算** —— 一次结构解析在 427 行的
   * 真实文档上要 **16 ms**，跟着每个键跑会卡住输入，所以源码视图用一个慢半拍的值兜住击键；
   * 富文本读已经建好的树，近乎免费。
   *
   * 源码那条路另有两个条件：**目录列开着**才算（收着的时候没人看，8MB 上一次 2.7–5.5s 是白费），
   * **文档超过 2MB 时不自动算**（读者可以按"解析目录"点一次）—— 这两条让"切到源码视图"
   * 这条退路本身不被目录解析拖住。
   */
  const outlineText = useDelayedValue(content, textDelayMs)
  const deferred =
    showingSource &&
    documentBytes > OUTLINE_AUTO_BYTES &&
    requested[openPath] !== true
  const textOutline = useMemo(
    () => (showingSource && open && !deferred ? outlineOf(outlineText) : null),
    [deferred, open, outlineText, showingSource],
  )
  const treeOutline = useMemo(
    () => (showingSource || editor === null ? null : headingEntries(editor)),
    [editor, content, showingSource],
  )
  const entries = treeOutline ?? textOutline ?? []

  /**
   * 当前读到哪一节 —— 目录那一行的蓝色就从这儿来。
   *
   * 只有三种情形不跟：没开文档、目录折叠、源码视图（那边没有标题 DOM）。滚动本身不写任何状态，
   * 序号不变连重渲染都不发生；点目录时 `hold` 先把高亮放到被点的那一行，跳到地方再交还。
   */
  const active = useActiveHeading({
    editor,
    scrollport,
    content,
    enabled: openPath !== '' && open && !showingSource,
  })

  /**
   * The width actually rendered.
   *
   * `clampStoredWidth`, not `clampOutline` — so it is bounded by the outline's own limits and
   * not by the live band width. The default therefore always renders at `OUTLINE_DEFAULT`, and
   * resizing the window never moves a panel nobody touched. The band width bounds *dragging*,
   * below.
   */
  const widthNow = clampStoredWidth(width ?? OUTLINE_DEFAULT)

  /**
   * Drag the divider. The outline is anchored to the panel's right edge, so dragging
   * left widens it — the delta is inverted, not the coordinate.
   */
  const startDrag = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return
      const startX = event.clientX
      const startWidth = widthNow
      const target = event.currentTarget
      target.setPointerCapture(event.pointerId)
      const move = (moved: PointerEvent) => {
        setWidth(
          clampOutline(startWidth + (startX - moved.clientX), scrollportRef.current?.clientWidth ?? 0),
        )
      }
      const end = () => {
        target.removeEventListener('pointermove', move)
        target.removeEventListener('pointerup', end)
        target.removeEventListener('pointercancel', end)
      }
      target.addEventListener('pointermove', move)
      target.addEventListener('pointerup', end)
      target.addEventListener('pointercancel', end)
    },
    [scrollportRef, widthNow],
  )

  /**
   * Bring the nth heading into view.
   *
   * The index is the outline's row number. It is turned into a node key by the **same** walk the
   * outline is read with (`editor/headingTree.ts`), so a row and a heading node cannot drift apart —
   * that is what makes the number safe to carry in a click handler.
   * @param index - position in the outline.
   */
  const jumpTo = useCallback(
    (index: number): void => {
      if (editor === null) return
      const key = headingKeys(editor)[index]
      if (key === undefined) return
      const element = editor.getElementByKey(key)
      if (element === null) return
      // Light the row first: the fallback list is what the reader just pointed at, and the smooth
      // scroll must not sweep the highlight through every heading on the way.
      active.hold(index)
      /**
       * Will this actually scroll? Asked **before** the jump, with geometry: the heading's distance
       * from the scrolling area's top. (Asking after the fact — "did `scrollTop` move in the next two
       * frames" — is unreliable: a smooth scroll does not start on the next frame, so a real jump
       * reads as "no jump" and the flash plays while the target is still off-screen. Measured.)
       */
      const port = scrollportRef.current
      const moves =
        port !== null &&
        Math.abs(element.getBoundingClientRect().top - port.getBoundingClientRect().top) > 1
      // `start`, not `center`: the outline's rule is "the block occupying the line 24px below the top
      // of the scrolling area is current", so the clicked heading has to land **at** that edge —
      // centred, it would sit below the line and the row just clicked would lose the highlight to
      // the one before it.
      element.scrollIntoView({ block: 'start', behavior: 'smooth' })
      // The receipt: flash the block once the jump has landed. Waiting is the whole point — started
      // at click time it would play while the target is still off-screen. Nothing to wait for when
      // the heading is already at the edge.
      if (moves && port !== null) afterScrollSettles(port, () => flashHeading(element))
      else flashHeading(element)
    },
    [active.hold, editor, scrollportRef],
  )

  /**
   * Parse this document's outline once, because the reader asked for it.
   *
   * Only reachable in the source view of a large document: everywhere else the outline is either
   * built from the tree or small enough to parse on its own.
   */
  const parse = useCallback((): void => {
    if (openPath === '') return
    setRequested(current =>
      current[openPath] === true ? current : { ...current, [openPath]: true },
    )
  }, [openPath])

  /** A closed document's own parse request goes with it: the path may be a different document next. */
  const forget = useCallback((paths: readonly string[]): void => {
    setRequested(current => {
      if (!paths.some(path => current[path] === true)) return current
      const kept = { ...current }
      for (const path of paths) delete kept[path]
      return kept
    })
  }, [])

  const toggle = useCallback((): void => {
    setOpen(value => !value)
  }, [])

  return {
    open,
    toggle,
    storedWidth: width,
    width: widthNow,
    resize: setWidth,
    entries,
    deferred,
    parse,
    activeIndex: active.activeIndex,
    jumpTo,
    startDrag,
    forget,
  }
}
