/**
 * 文档目录跟着正文走：量标题的位置、听滚动、算出"当前是第几行"。
 *
 * 内容
 * - ActiveHeadingOptions / ActiveHeading、useActiveHeading。
 *
 * 行为
 * - 判定依据是**正文滚动区域**（调用方给的 `scrollport`：编辑带里那个真正滚动的元素），不是窗口 /
 *   屏幕的可见范围 —— 工具条、提示层挡住多少都不改变"正文滚到哪儿了"。
 * - 位置只在**布局可能变了**的时候重量（内容变、滚动盒变尺寸、正文盒变尺寸、目录开关）；
 *   滚动本身只做一次数组扫描（`../editor/outlineActive.ts`），而且**只在序号变化时**才通知 React。
 * - 量的是**滚动区域的内容坐标**（`rect.top - 滚动盒 top + scrollTop`），所以滚动时不必重量。
 * - 拿不到 DOM 的标题按"无穷远"占位：不挤掉后面标题的序号（序号是点击滚动的索引）。
 * - 点目录时先 `hold(index)`：高亮立刻落在被点的那一行，滚动途中不被滚动监听抢走；
 *   `scrollend`（或 900 ms 兜底）之后交还给滚动监听。
 * - 关掉时（目录折叠、源码视图）清空高亮，不做任何测量与监听。
 *
 * 边界
 * - 不认识渲染与样式（当前行怎么画在 `Band.tsx`）。
 * - 不保存、不记忆：每次挂载/切换文档都从当前位置重新算。
 *
 * 相关文件
 * - 依赖：../editor/headingTree.ts（标题的 key 与顺序）、../editor/outlineActive.ts（判据）。
 * - 被依赖：./useOutlineColumn.ts。
 *
 * 改哪里
 * - 改判定线：outlineActive.ts。
 * - 改测量时机：useActiveHeading 里的三个 effect。
 */
import type { LexicalEditor } from 'lexical'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { headingKeys } from '../editor/headingTree'
import { activeHeadingOf } from '../editor/outlineActive'

/** 点击目录之后，滚动监听最多被压住多久（毫秒）。`scrollend` 正常会先到。 */
const HOLD_FALLBACK_MS = 900

/** What the hook needs. */
export interface ActiveHeadingOptions {
  /** The live composer, or `null` in the source view. */
  readonly editor: LexicalEditor | null
  /** The element that scrolls the document (the band's workspace). */
  readonly scrollport: HTMLDivElement | null
  /** The document text: a change means the layout may have moved. */
  readonly content: string
  /** Whether the column is visible (open, rich text, a document on screen). */
  readonly enabled: boolean
}

/** What the hook hands back. */
export interface ActiveHeading {
  /** Row number of the heading being read, or `-1`. */
  readonly activeIndex: number
  /** Light `index` now and keep the scroll listener off until the jump settles. */
  hold(index: number): void
}

/**
 * @param options - editor, scrollport, content, enabled.
 * @returns the active row number and the click-side `hold`.
 */
export function useActiveHeading(options: ActiveHeadingOptions): ActiveHeading {
  const { editor, scrollport, content, enabled } = options
  const [activeIndex, setActiveIndex] = useState(-1)
  const activeRef = useRef(-1)
  const topsRef = useRef<readonly number[]>([])
  const holdRef = useRef<number | null>(null)
  const releaseRef = useRef<number | null>(null)
  activeRef.current = activeIndex

  /** Only touch React when the number really changed. */
  const settle = useCallback((next: number): void => {
    if (next === activeRef.current) return
    activeRef.current = next
    setActiveIndex(next)
  }, [])

  /** Read every heading's top in content coordinates. */
  const measure = useCallback((): void => {
    if (!enabled || editor === null || scrollport === null) {
      topsRef.current = []
      return
    }
    const box = scrollport.getBoundingClientRect()
    const scrollTop = scrollport.scrollTop
    topsRef.current = headingKeys(editor).map(key => {
      const element = editor.getElementByKey(key)
      // A heading without a DOM element cannot be the current row, and must not shift the ones after it.
      return element === null
        ? Number.POSITIVE_INFINITY
        : element.getBoundingClientRect().top - box.top + scrollTop
    })
  }, [editor, scrollport, enabled])

  /** One arithmetic pass over the measured tops. */
  const recompute = useCallback((): void => {
    if (!enabled || scrollport === null || holdRef.current !== null) return
    settle(
      activeHeadingOf(topsRef.current, scrollport.scrollTop, scrollport.clientHeight, scrollport.scrollHeight),
    )
  }, [enabled, scrollport, settle])

  /**
   * Layout may have moved: measure once, then recompute — on the next frame, so typing never waits for
   * a forced layout. `content` is the signal (a heading was added, removed or renamed).
   */
  useLayoutEffect(() => {
    if (!enabled) {
      topsRef.current = []
      settle(-1)
      return undefined
    }
    const frame = requestAnimationFrame(() => {
      measure()
      recompute()
    })
    return () => {
      cancelAnimationFrame(frame)
    }
  }, [enabled, editor, scrollport, content, measure, recompute, settle])

  /** A sizing change (window, outline width, images loading) moves the headings without a `content` change. */
  useEffect(() => {
    if (!enabled || scrollport === null) return undefined
    const root = editor?.getRootElement() ?? null
    const observer = new ResizeObserver(() => {
      measure()
      recompute()
    })
    observer.observe(scrollport)
    if (root !== null) observer.observe(root)
    return () => {
      observer.disconnect()
    }
  }, [enabled, editor, scrollport, measure, recompute])

  /** Scrolling only recomputes; it never measures and never re-renders when the row stays the same. */
  useEffect(() => {
    if (!enabled || scrollport === null) return undefined
    let frame = 0
    const onScroll = (): void => {
      if (frame !== 0) return
      frame = requestAnimationFrame(() => {
        frame = 0
        recompute()
      })
    }
    scrollport.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      scrollport.removeEventListener('scroll', onScroll)
      if (frame !== 0) cancelAnimationFrame(frame)
    }
  }, [enabled, scrollport, recompute])

  /** The click side: light the row at once, and hand control back when the jump is over. */
  const hold = useCallback(
    (index: number): void => {
      if (!enabled) return
      holdRef.current = index
      settle(index)
      if (releaseRef.current !== null) window.clearTimeout(releaseRef.current)
      releaseRef.current = window.setTimeout(() => {
        releaseRef.current = null
        holdRef.current = null
        recompute()
      }, HOLD_FALLBACK_MS)
    },
    [enabled, recompute, settle],
  )

  /** A finished scroll ends the hold early; the fallback above covers "the row was already in view". */
  useEffect(() => {
    if (scrollport === null) return undefined
    const release = (): void => {
      if (holdRef.current === null) return
      holdRef.current = null
      if (releaseRef.current !== null) {
        window.clearTimeout(releaseRef.current)
        releaseRef.current = null
      }
      recompute()
    }
    scrollport.addEventListener('scrollend', release)
    return () => {
      scrollport.removeEventListener('scrollend', release)
    }
  }, [scrollport, recompute])

  /** A timer must not outlive the panel. */
  useEffect(
    () => () => {
      if (releaseRef.current !== null) window.clearTimeout(releaseRef.current)
    },
    [],
  )

  return { activeIndex, hold }
}
