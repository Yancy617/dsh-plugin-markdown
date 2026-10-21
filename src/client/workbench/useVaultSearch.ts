/**
 * 侧栏搜索：输入、防抖、结果、以及“点一条结果之后落在正文哪一行”。
 *
 * 内容
 * - PendingHit / VaultSearchArgs / VaultSearch / useVaultSearch。
 *
 * 行为
 * - 提交式而非逐键：停手 300ms 才发请求（每次都是一次整仓 grep）；Enter 立即发并取消待发的计时器。
 * - 只让最新一次请求落地（序号比较）；关掉搜索会作废在飞的请求并清空查询。
 * - 落地：等目标文档成为当前文档、编辑器就绪，再按“这条结果在本文件命中里的序号”标记并滚动；
 *   树还没长出来时最多重试 12 帧。
 *
 * 边界
 * - 不拥有输入框 DOM（refs 由调用方挂）；不负责打开文档（落地前 `openFile` 由调用方跑）。
 * - 不决定侧栏长什么样。
 *
 * 相关文件
 * - 依赖：vaultClient.searchVault、editor/FindBar 的 $collectMatches、editor/highlight 的标记、shared/paths。
 * - 被依赖：MarkdownWorkbench.tsx、workbench/Sidebar.tsx。
 *
 * 改哪里
 * - 改搜索的节奏：useVaultSearch 的两个 effect。
 * - 改落地规则：landing effect。
 */
import type { LexicalEditor } from 'lexical'
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { samePath } from '../../shared/paths'
import { messageOf } from '../../shared/errors'
import type { VaultSearchResult } from '../../shared/protocol'
import { searchVault } from '../vaultClient'
import { $collectMatches } from '../editor/FindBar'
import { clearMarks, markMatches } from '../editor/highlight'

/** A line a search result asked for, waiting for its document. */
export interface PendingHit {
  readonly path: string
  /** What was actually searched for — what to mark, and the only thing worth matching. */
  readonly term: string
  /** Which hit this was, among the hits for its file, and how many there were. */
  readonly ordinal: number
  readonly total: number
}

/** What the landing needs from the panel. */
export interface VaultSearchArgs {
  /** The live composer. */
  readonly editor: LexicalEditor | null
  /** The document the composer belongs to. */
  readonly editorPath: string | null
  /** The showing document's path, or `null`. */
  readonly openPath: string | null
  /** The source view is showing. */
  readonly sourceMode: boolean
  /** The document's text — the landing waits for it. */
  readonly content: string
  /** Ask for the rich view (a textarea cannot be marked). */
  onShowSource(source: boolean): void
}

/** The search box's public face. */
export interface VaultSearch {
  readonly open: boolean
  readonly query: string
  readonly result: VaultSearchResult | null
  readonly searching: boolean
  readonly composing: boolean
  readonly pendingHit: PendingHit | null
  /** The input, focused when the box opens. */
  readonly inputRef: RefObject<HTMLInputElement>
  /** The field's own box, which is what "inside the search" means to a click. */
  readonly rootRef: RefObject<HTMLDivElement>
  setOpen(open: boolean): void
  setQuery(query: string): void
  setComposing(composing: boolean): void
  /** Submit now (Enter): cancels the debounce, then searches. */
  submit(): void
  /** Expand and focus. */
  openBox(): void
  /** Collapse, drop the results and the query. */
  close(): void
  setPendingHit(hit: PendingHit | null): void
}

/**
 * Own the sidebar search.
 * @param args - the editor and document the landing has to wait for.
 * @returns the search state and its actions.
 */
export function useVaultSearch(args: VaultSearchArgs): VaultSearch {
  const [query, setQuery] = useState('')
  const [result, setResult] = useState<VaultSearchResult | null>(null)
  const [searching, setSearching] = useState(false)
  const [open, setOpen] = useState(false)
  const [composing, setComposing] = useState(false)
  const [pendingHit, setPendingHit] = useState<PendingHit | null>(null)

  const inputRef = useRef<HTMLInputElement | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  /**
   * The newest search issued.
   *
   * A response is applied only by the request that is still the newest. Comparing arrival is the bug
   * this prevents: type `abc` quickly and three searches are in flight, and the `ab` one can land
   * last and win — leaving the panel showing results for a query the box no longer holds, with
   * nothing to correct it.
   *
   * A counter, not a timestamp: two requests can be issued in the same millisecond and tie, and a
   * tie has no correct answer.
   */
  const seq = useRef(0)
  /** The query the last search was issued for, so an unchanged one is not searched twice. */
  const lastSearched = useRef<string | null>(null)
  /** The pending debounce, so Enter can cancel it rather than search twice. */
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** How many frames the landing has waited for the editor. Bounded, so it cannot spin. */
  const retries = useRef(0)

  const run = useCallback(async (raw: string): Promise<void> => {
    const next = raw.trim()
    const mine = (seq.current += 1)
    if (next === '') {
      lastSearched.current = null
      setResult(null)
      setSearching(false)
      return
    }
    lastSearched.current = next
    setSearching(true)
    try {
      const answer = await searchVault(next)
      if (mine !== seq.current) return
      setResult(answer)
    } catch (error) {
      if (mine !== seq.current) return
      setResult({ files: [], truncated: false, unavailable: messageOf(error) })
    } finally {
      // Only the newest search may switch the indicator off. A discarded one that cleared it would
      // leave the panel claiming a search has finished while the one it is waiting for still runs.
      if (mine === seq.current) setSearching(false)
    }
  }, [])

  /**
   * Search when typing stops.
   *
   * The cleanup is what makes rapid typing safe: each keystroke cancels the timer the previous one
   * set, so only the last survives. Holding that timer anywhere but here would leave it behind on
   * unmount — `timer` exists only so Enter can cancel it too.
   */
  useEffect(() => {
    if (!open) return undefined
    const trimmed = query.trim()
    if (trimmed === '') {
      // Immediate, not debounced: there is no request to make, so waiting 300ms to give the tree
      // back is a delay with nothing behind it. It bumps the sequence too, so a search still in
      // flight cannot land on top of the tree after the box was cleared.
      void run('')
      return undefined
    }
    // Nothing to do while an IME is composing. The box holds pinyin or an unpicked candidate, not
    // what the writer means; `compositionend` re-runs this with the composed result.
    if (composing) return undefined
    if (trimmed === lastSearched.current) return undefined
    timer.current = setTimeout(() => {
      timer.current = null
      void run(query)
    }, 300)
    return () => {
      if (timer.current !== null) {
        clearTimeout(timer.current)
        timer.current = null
      }
    }
  }, [query, open, composing, run])

  /** Focus the field as soon as it opens, so expanding it is one action. */
  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  /**
   * Close an empty search when the click goes somewhere else.
   *
   * The shell's rule, and the whole of its "collapses when there is nothing in it" behaviour: a
   * click outside blurs the field, and the field closes only if the box is empty. A search with
   * words in it stays open, so its results can be read and clicked without the panel shutting under
   * the pointer — which is the difference between a search that behaves and one that flickers.
   */
  useEffect(() => {
    if (!open) return undefined
    const onClick = (event: MouseEvent): void => {
      if (!(event.target instanceof Node) || rootRef.current?.contains(event.target) === true) {
        return
      }
      inputRef.current?.blur()
      if (query.trim() !== '') return
      setOpen(false)
    }
    document.addEventListener('click', onClick)
    return () => {
      document.removeEventListener('click', onClick)
    }
  }, [open, query])

  /**
   * Collapse the search and drop what it found.
   *
   * Both together, because a collapsed box above a stale result list reads as a tree that has
   * quietly lost most of its entries. Closing the search is how the tree comes back.
   */
  const close = useCallback((): void => {
    // The field is going away, so nothing in flight has anywhere to land. Bumping the sequence
    // invalidates it, and every scrap of the search's own state goes with it — including the query
    // last searched for. Leave that behind and reopening the box, typing the same word, finds it
    // unchanged and searches nothing: an empty panel that looks like a broken search.
    seq.current += 1
    lastSearched.current = null
    if (timer.current !== null) {
      clearTimeout(timer.current)
      timer.current = null
    }
    setOpen(false)
    setResult(null)
    setQuery('')
    setSearching(false)
  }, [])

  /** Enter: the debounce is a delay, and this says the writer wants it now. */
  const submit = useCallback((): void => {
    if (timer.current !== null) {
      clearTimeout(timer.current)
      timer.current = null
    }
    void run(query)
  }, [run, query])

  /** Expand the box; the focus effect above lands the caret. */
  const openBox = useCallback((): void => {
    setOpen(true)
  }, [])

  /** The marks belong to the search, so they go when it does. */
  useEffect(() => {
    if (!open) clearMarks('search')
  }, [open])

  /**
   * Land on the line a search result named.
   *
   * Both branches clear the request when they are done, so a stale one cannot fire again on the
   * next document — or on a re-render of this one.
   */
  useEffect(() => {
    const hit = pendingHit
    if (hit === null) return
    // Still the wrong document, or none yet. `openFile` has to finish first.
    if (args.openPath === null || !samePath(args.openPath, hit.path)) return

    if (args.sourceMode) {
      // A textarea's text is not DOM text, so no Range reaches it and the Custom Highlight API does
      // not apply. There is no mark to show here, so the answer is to move to where there is one.
      //
      // `pendingHit` is deliberately kept: this effect depends on `sourceMode`, so switching re-runs
      // it and the landing completes in the rich view.
      console.info('[markdown] 已切回富文本模式进行搜索')
      args.onShowSource(false)
      return
    }

    if (args.editor === null) return
    // Still the previous document's editor. Matching against it would mark nodes that are being
    // unmounted and then clear the request, leaving the click with nothing to show — which is what
    // made the first of two clicks do nothing.
    if (args.editorPath === null || !samePath(args.editorPath, hit.path)) return

    /**
     * Ask for another frame.
     *
     * The editor is ready before its tree holds the document, so the first pass or two can see
     * nothing. A fresh `pendingHit` object is what makes this effect run again — it is the
     * dependency, and a new reference is the only way to say "look again" without a second piece of
     * state.
     *
     * Bounded, so a request that can never be satisfied does not spin.
     * @returns a cleanup that cancels the frame, or `undefined` once the bound is reached.
     */
    const retry = (): (() => void) | undefined => {
      if (retries.current >= 12) {
        retries.current = 0
        setPendingHit(null)
        return undefined
      }
      retries.current += 1
      const frame = requestAnimationFrame(() => {
        setPendingHit(current => (current === null ? null : { ...current }))
      })
      return () => {
        cancelAnimationFrame(frame)
      }
    }

    // Every occurrence in this document, from the same matcher 查找 uses.
    const matches = args.editor.getEditorState().read(() => $collectMatches(hit.term))
    if (matches.length === 0) {
      // The term was clicked in a search result for this file, so it is in the document by
      // construction. Nothing found means the tree is not holding it yet — retry, and do not clear.
      return retry()
    }

    // Which one was asked for, by the hit's place among its file's hits. Both lists are in document
    // order, so this is the one axis the two share — unlike a line number, whose share of the
    // document is nearly identical for two hits on one screen and so picked the same occurrence
    // every time. Where the two lists are the same length the mapping is exact.
    const span = Math.max(1, hit.total - 1)
    const index = Math.min(
      matches.length - 1,
      Math.round((hit.ordinal * (matches.length - 1)) / span),
    )

    const marked = markMatches('search', args.editor, matches, index)

    const active = matches[index]
    const block =
      active === undefined ? null : args.editor.getElementByKey(active.nodeKey)
    /**
     * Scroll to the block, then check that it stayed there.
     *
     * The editor replaces its root's content after `onReady`, and while that content is absent
     * nothing scrolls — so a scroll made first is clamped away and does not come back. Asserting
     * again over the next few frames is what makes the landing outlast the render, whichever frame
     * it finishes on.
     *
     * Bounded: a scroll that never holds must not spin.
     * @param attempt - how many times this has been re-asserted.
     */
    const assertScroll = (attempt: number): void => {
      if (block === null || attempt >= 10) return
      block.scrollIntoView({ block: 'center' })
      // Re-assert rather than test. `scrollIntoView` scrolls whichever ancestors need it, so "did
      // the position hold" cannot be asked of one element; measured on the wrong element it
      // answered "stable" while a freshly opened document was still laying out.
      requestAnimationFrame(() => {
        assertScroll(attempt + 1)
      })
    }
    assertScroll(0)

    // Matches were found and none could be marked: the blocks are not in the DOM yet. Same
    // situation as above, one step further along.
    if (marked === 0) return retry()

    retries.current = 0
    setPendingHit(null)
    /*
     * `content` is in the dependency list even though the body never reads it. The editor reports
     * itself ready before its tree holds the document, and until that text arrives the matcher
     * finds nothing — which this effect reads as "nothing to land on" and answers by clearing the
     * request. Without this dependency there is nothing to re-run the effect when the text lands.
     */
  }, [
    pendingHit,
    args.openPath,
    args.sourceMode,
    args.editor,
    args.editorPath,
    args.content,
    args.onShowSource,
  ])

  return {
    open,
    query,
    result,
    searching,
    composing,
    pendingHit,
    inputRef,
    rootRef,
    setOpen,
    setQuery,
    setComposing,
    submit,
    openBox,
    close,
    setPendingHit,
  }
}
