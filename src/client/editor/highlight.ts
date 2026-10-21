/**
 * 在打开的文档里标记匹配：CSS Custom Highlight API。
 *
 * 内容
 * - MatchRange（nodeKey / start / end）、MarkOwner（search / find）。
 * - markMatches / clearMarks、keysOf、supported、LexicalEditorLike。
 *
 * 行为
 * - 不变成选区：用 CSS.highlights 注册 current / others 两个命名空间。
 * - 两个功能共用一套：查找与仓库搜索。
 * - CSS.highlights 是文档全局，键带 dsh-markdown- 前缀。
 * - 运行时不支持就退化为不标记，编辑器仍可用。
 *
 * 边界
 * - 不负责找匹配（FindBar.tsx / src/host/search.ts）。
 * - 不负责滚动到当前项。
 *
 * 相关文件
 * - 被依赖：FindBar.tsx、MarkdownWorkbench.tsx。
 *
 * 改哪里
 * - 改命名空间：keysOf。
 * - 改标记：markMatches / clearMarks。
 */

/** One occurrence, as the editor describes it: offsets inside one text node. */
export interface MatchRange {
  readonly nodeKey: string
  readonly start: number
  readonly end: number
}

/**
 * Which feature a mark belongs to.
 *
 * Two can be on screen at once — the sidebar's search and the editor's find bar — and they are
 * separate things the reader is doing. One namespace would mean the second erasing the first's
 * marks, and the reader watching their search highlight disappear because they opened a find bar.
 */
export type MarkOwner = 'search' | 'find'

/**
 * The two registrations one owner uses.
 * @param owner - which feature.
 * @returns its current and other keys.
 */
function keysOf(owner: MarkOwner): readonly [string, string] {
  return [`dsh-markdown-${owner}-current`, `dsh-markdown-${owner}-others`]
}

/**
 * Whether this runtime has the API.
 *
 * Checked rather than assumed, and every entry point degrades to doing nothing without it: the
 * editor still works, and the only loss is the mark.
 * @returns whether highlights can be registered.
 */
function supported(): boolean {
  return (
    typeof CSS !== 'undefined' &&
    CSS.highlights !== undefined &&
    typeof Highlight === 'function' &&
    typeof Range === 'function'
  )
}

/**
 * Build a DOM range for one match.
 *
 * The offsets are measured along the element's text, which may be split across several text nodes,
 * so they are counted across all of them rather than assumed to be in the first.
 * @param element - the element the editor reports for the match's node.
 * @param match - the offsets to cover.
 * @returns the range, or `null` if the element does not hold that much text.
 */
function rangeOf(element: HTMLElement, match: MatchRange): Range | null {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
  const range = document.createRange()
  let seen = 0
  let started = false
  let node = walker.nextNode()
  while (node !== null) {
    const length = node.textContent?.length ?? 0
    if (!started && seen + length > match.start) {
      range.setStart(node, match.start - seen)
      started = true
    }
    if (started && seen + length >= match.end) {
      range.setEnd(node, match.end - seen)
      return range
    }
    seen += length
    node = walker.nextNode()
  }
  return null
}

/**
 * Mark every match, with one of them current.
 * @param editor - the editor whose document is being marked.
 * @param matches - every occurrence, in document order.
 * @param activeIndex - which of them is current.
 * @returns how many ranges were registered. Zero while the editor still has its content to render,
 *   which the caller has to be able to tell from "the term is not here" — one means try again, the
 *   other means stop.
 */
export function markMatches(
  owner: MarkOwner,
  editor: LexicalEditorLike,
  matches: readonly MatchRange[],
  activeIndex: number,
): number {
  if (!supported()) return 0
  const current: Range[] = []
  const others: Range[] = []
  matches.forEach((match, index) => {
    const element = editor.getElementByKey(match.nodeKey)
    if (element === null) return
    const range = rangeOf(element, match)
    if (range === null) return
    if (index === activeIndex) current.push(range)
    else others.push(range)
  })
  const [currentKey, othersKey] = keysOf(owner)
  CSS.highlights.set(currentKey, new Highlight(...current))
  CSS.highlights.set(othersKey, new Highlight(...others))
  return current.length + others.length
}

/**
 * Remove one owner's marks, and only that owner's.
 * @param owner - which feature.
 */
export function clearMarks(owner: MarkOwner): void {
  if (!supported()) return
  const [currentKey, othersKey] = keysOf(owner)
  CSS.highlights.delete(currentKey)
  CSS.highlights.delete(othersKey)
}

/** The part of the editor this module needs, named so it does not depend on Lexical directly. */
export interface LexicalEditorLike {
  getElementByKey(key: string): HTMLElement | null
}
