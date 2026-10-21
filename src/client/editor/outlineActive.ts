/**
 * 文档目录与正文的联动：**哪一节是"当前"**。
 *
 * 内容
 * - ACTIVE_LEAD_PX、activeHeadingOf。
 *
 * 行为
 * - 判定依据是**正文滚动区域**，不是"可视区域"：滚动容器的 `scrollTop` / 可视高 / `scrollHeight`
 *   （`useActiveHeading` 从那个元素上读）。窗口、屏幕、被工具条或提示层挡住的那一部分都不参与 ——
 *   它们回答的是"看得见多少"，不是"正文滚到哪儿了"。
 * - 判定线 = 滚动区域顶边**往下 24px**（用户定的提前量：「提前 N px：24px」）。占着这条线的那一块
 *   （当前节）高亮 —— 标题还差 24px 到顶边就亮，读起来比"到顶边才亮"早半拍。
 * - 一块的"开始"是它的标题。于是下一块开始 = 当前块的内容已经滚出这条线，那一瞬间换下一个：
 *   序号 = **标题顶边已在这条线之上的最后一个**（序号随滚动单调增加，不会来回跳）。
 * - 顶线之上还没有任何标题时，取**滚动区域里最靠上的那个标题**（第一个标题还在区域里就亮它，
 *   前言比一屏还长则谁都不亮）—— 打开文档就亮第一行，靠的是这一条。
 * - 滚到底 ⇒ 最后一个（最后一节太短时，它的标题可能压不到线，而读者确实已经读到文末）。
 * - 空列表 / 可视高为 0 ⇒ `-1`。
 *
 * 边界
 * - 只做算术：不量 DOM、不监听滚动、不认识 Lexical。
 * - `tops` 必须是**升序**的、并且是**相对滚动区域内容起点**的坐标（不随滚动变）——量的人负责。
 *
 * 相关文件
 * - 被依赖：../workbench/useActiveHeading.ts。
 *
 * 改哪里
 * - 改提前量：ACTIVE_LEAD_PX。
 * - 改判据 / 回落：activeHeadingOf。
 */

/**
 * 判定线在滚动区域顶边**下面**多少像素就提前亮。
 *
 * 24 是用户定的（「提前 N px：24px」）。它同时是正文上内边距那个数，但**不要**把它改成读那个变量：
 * 一个是排版留白、一个是联动的提前量，两者今天相等只是巧合，改一个不该动另一个。
 */
export const ACTIVE_LEAD_PX = 24

/**
 * 当前读到第几个标题。
 * @param tops - 每个标题顶边在**滚动区域内容坐标**里的位置，升序。
 * @param scrollTop - 滚动区域的偏移。
 * @param viewHeight - 滚动区域的可视高度（滚动容器的 `clientHeight`）。
 * @param scrollHeight - 滚动区域的内容总高。
 * @returns 标题序号；一个都还没进入滚动区域时是 `-1`。
 */
export function activeHeadingOf(
  tops: readonly number[],
  scrollTop: number,
  viewHeight: number,
  scrollHeight: number,
): number {
  if (tops.length === 0 || viewHeight <= 0) return -1

  /**
   * 滚到底：**只在真的能滚时**才压最后一行。文档比滚动区域短（`scrollHeight <= viewHeight`）时也满足
   * `scrollTop + viewHeight >= scrollHeight`，那时压最后一行是错的 —— 那种文档整篇都在眼前，当前节
   * 就是第一节。
   */
  const scrollable = scrollHeight > viewHeight + 2
  if (scrollable && scrollTop + viewHeight >= scrollHeight - 2) return tops.length - 1

  // 判定线：占着滚动区域顶边往下 `ACTIVE_LEAD_PX` 的那一块是当前节。
  const line = scrollTop + ACTIVE_LEAD_PX
  let active = -1
  for (let index = 0; index < tops.length; index += 1) {
    const top = tops[index] ?? Number.POSITIVE_INFINITY
    if (top > line) break
    active = index
  }
  if (active !== -1) return active

  /**
   * 判定线之上还没有任何标题（正打开文档、或前言很长）：亮**滚动区域里最靠上的那个标题**。
   * 第一个标题还在区域里 ⇒ 亮它；比一屏还低 ⇒ 区域上方那一块没有标题，不亮。
   */
  const first = tops[0] ?? Number.POSITIVE_INFINITY
  return first <= scrollTop + viewHeight ? 0 : -1
}
