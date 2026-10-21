/**
 * 选中浮窗放在哪。
 *
 * 内容
 * - ClientRect / BarSize / BarSide / BarPlacement / PlacementInput。
 * - countLines / placeBar / intersect / clippingAncestorOf / visibleBand / fitSubmenu。
 *
 * 行为
 * - 单行选区放上方，多行放下方；调用方说"上方会挡住东西"时（表格第一行）一律放下方。
 * - 再挪进内容容器的可视带（不是窗口）。
 * - countLines 按矩形垂直重叠合并成行；空矩形不算。
 * - 移到空区间时贴住起点，保住第一条控件。
 * - fitSubmenu / visibleBand 决定子菜单与可视带。
 *
 * 边界
 * - 不负责浮窗表面与 React / Lexical（FloatingToolbar.tsx）。
 *
 * 相关文件
 * - 被依赖：FloatingToolbar.tsx。
 *
 * 改哪里
 * - 改主规则：placeBar。
 * - 改行数：countLines。
 * - 改子菜单：fitSubmenu。
 */

/** A rectangle in viewport coordinates, as `getBoundingClientRect` reports one. */
export interface ClientRect {
  readonly left: number
  readonly top: number
  readonly right: number
  readonly bottom: number
}

/** The bar's measured size. */
export interface BarSize {
  readonly width: number
  readonly height: number
}

/** Which side of the selection the bar was placed on. */
export type BarSide = 'top' | 'bottom'

/** The bar's fixed coordinates and the side the rule chose. */
export interface BarPlacement {
  readonly left: number
  readonly top: number
  readonly side: BarSide
}

/** Everything {@link placeBar} needs. */
export interface PlacementInput {
  /** Bounding rect of the selection. */
  readonly selection: ClientRect
  /** Visible band of the content container, as {@link visibleBand} returns it. */
  readonly band: ClientRect
  /** Measured bar size. */
  readonly bar: BarSize
  /** Visual lines the selection covers, as {@link countLines} counts them. */
  readonly lines: number
  /** Distance kept between the bar and the selection edge it hangs from. */
  readonly gap: number
  /** Distance kept between the bar and the band's edges. */
  readonly margin: number
  /**
   * The caller says hanging above would cover something that must stay visible.
   *
   * Today that is a selection in a table's first row: the column handle floats just above that
   * row, above the bar's own layer, so the two would overlap. Hanging below the selection keeps
   * both, at the cost of covering the row under it.
   */
  readonly avoidTop?: boolean
}

/**
 * How many visual lines a set of range rects covers.
 *
 * A range reports **one rect per text run, not one per line**: bolding half a line
 * yields two rects sitting side by side on that same line. Counting rects would
 * therefore call a bolded single line a block and put the bar in the wrong place —
 * which is the one case a formatting bar is most often opened for.
 *
 * Two rects belong to the same line exactly when they overlap vertically, so the
 * rects are sorted by their top edge and merged while they overlap. What survives
 * is one band per line.
 * @param rects - the rects `Range.getClientRects()` reported, in any order.
 * @returns the number of lines; `0` for a set holding nothing with area.
 */
export function countLines(rects: readonly ClientRect[]): number {
  const bands: { top: number; bottom: number }[] = []
  for (const rect of [...rects].sort((a, b) => a.top - b.top)) {
    // A collapsed or empty run has no line of its own; counting it would add a band.
    if (rect.bottom <= rect.top || rect.right <= rect.left) continue
    const last = bands.at(-1)
    if (last !== undefined && rect.top < last.bottom) {
      last.bottom = Math.max(last.bottom, rect.bottom)
      continue
    }
    bands.push({ top: rect.top, bottom: rect.bottom })
  }
  return bands.length
}

/**
 * Place the bar for a selection.
 * @param input - the selection, the band, the measured bar, and the two distances.
 * @returns fixed `left`/`top`, plus the side they were derived from.
 */
export function placeBar(input: PlacementInput): BarPlacement {
  const side: BarSide = input.lines > 1 || input.avoidTop === true ? 'bottom' : 'top'
  const rawTop =
    side === 'top'
      ? input.selection.top - input.gap - input.bar.height
      : input.selection.bottom + input.gap
  return {
    left: shiftInto(
      input.selection.left,
      input.band.left + input.margin,
      input.band.right - input.margin - input.bar.width,
    ),
    top: shiftInto(
      rawTop,
      input.band.top + input.margin,
      input.band.bottom - input.margin - input.bar.height,
    ),
    side,
  }
}

/**
 * Move a coordinate into a range, and hold still when the range is empty.
 *
 * The empty range is real, not defensive: a bar taller than the band it must fit
 * in — a container the reader has dragged very short, or a window resized until
 * the band is a few pixels. Pinning to the range's start keeps the bar's **top
 * edge** on screen and lets it overflow the far edge, which loses less than
 * centring it would: the bar's first controls stay reachable.
 * @param value - the coordinate the placement rule produced.
 * @param min - the band's near edge, margin included.
 * @param max - the band's far edge, margin and the bar's own extent subtracted.
 * @returns the coordinate to use.
 */
function shiftInto(value: number, min: number, max: number): number {
  if (max <= min) return min
  return Math.min(Math.max(value, min), max)
}

/**
 * Intersect two rects.
 * @param a - first rect.
 * @param b - second rect.
 * @returns the overlap; its edges cross when the two do not meet.
 */
export function intersect(a: ClientRect, b: ClientRect): ClientRect {
  return {
    left: Math.max(a.left, b.left),
    top: Math.max(a.top, b.top),
    right: Math.min(a.right, b.right),
    bottom: Math.min(a.bottom, b.bottom),
  }
}

/**
 * The nearest ancestor that clips its overflow.
 *
 * `overflow-y` is the property that matters — the document's scroller sets
 * `overflowY: 'scroll'` while its own parent stays `visible` — and it is read from
 * the computed style rather than from a class name or a ref, because the box that
 * scrolls is the workbench's business and not this module's. Any value other than
 * `visible` clips: `auto` and `scroll` obviously, and `hidden` too.
 * @param start - the editor's content element.
 * @returns the clipping ancestor, or `null` when nothing above it clips.
 */
export function clippingAncestorOf(start: HTMLElement | null): HTMLElement | null {
  for (let node = start?.parentElement ?? null; node !== null; node = node.parentElement) {
    if (getComputedStyle(node).overflowY !== 'visible') return node
  }
  return null
}

/**
 * The band the bar must stay inside: the content container, cut down to the window.
 *
 * The container is intersected with the viewport because a container taller than
 * the window would otherwise offer a band reaching off-screen — and a band that
 * reaches off-screen is not a visible band.
 *
 * With no clipping ancestor at all this falls back to the window. That keeps the
 * rule total: the bar is then bounded by the same box the official primitive would
 * have bounded it by, which is the behaviour this module replaces rather than a
 * new one.
 * @param contentElement - the editor's content element, or `null` before it exists.
 * @returns the visible band, in viewport coordinates.
 */
export function visibleBand(contentElement: HTMLElement | null): ClientRect {
  const viewport: ClientRect = {
    left: 0,
    top: 0,
    right: window.innerWidth,
    bottom: window.innerHeight,
  }
  const clipper = clippingAncestorOf(contentElement)
  if (clipper === null) return viewport
  return intersect(clipper.getBoundingClientRect(), viewport)
}

/** Which side and which alignment a card hanging off a trigger should use. */
export interface SubmenuFit {
  readonly side: BarSide
  readonly align: 'start' | 'end'
}

/** Everything {@link fitSubmenu} needs. */
export interface SubmenuFitInput {
  /** The trigger's rect — the box the card hangs off. */
  readonly anchor: ClientRect
  /** Visible band of the content container, as {@link visibleBand} returns it. */
  readonly band: ClientRect
  /** The card's **measured** size. */
  readonly size: BarSize
  /** The side to use when both sides fit. */
  readonly preferred: BarSide
  /** Distance the card keeps from the trigger. */
  readonly gap: number
  /** Distance the card keeps from the band's edges. */
  readonly margin: number
}

/**
 * Choose the side and the alignment for a card hanging off a trigger.
 *
 * **The preference is honoured only while the card actually fits there.** The caller
 * passes the side the bar itself is on — so the card stays away from the selection —
 * and that is what happens whenever there is room. Past that the card flips, and it
 * has to: a card past the band's edge is clipped by the content container, and the
 * level the reader opened it for becomes unreachable.
 *
 * The size is taken as given rather than assumed, which is why the caller measures
 * the rendered card. Assuming it would mean writing a row height and a padding into
 * this module, and both of those belong to the shell's stylesheet.
 *
 * The alignment compares the two overflows rather than reacting to the first one. A
 * trigger near the band's right edge can be **worse** off aligned to its own right
 * edge than spilling past it, and only the comparison can tell which.
 * @param input - the trigger, the band, the measured card, and the two distances.
 * @returns the side and alignment to place it with.
 */
export function fitSubmenu(input: SubmenuFitInput): SubmenuFit {
  /** Space between one trigger edge and the band, margin already taken off. */
  const room = (side: BarSide): number =>
    side === 'top'
      ? input.anchor.top - input.band.top - input.margin
      : input.band.bottom - input.anchor.bottom - input.margin
  const needed = input.size.height + input.gap
  const other: BarSide = input.preferred === 'top' ? 'bottom' : 'top'
  let side: BarSide
  if (room(input.preferred) >= needed) side = input.preferred
  else if (room(other) >= needed) side = other
  // Neither fits: the roomier side still shows the first rows, which beats a card
  // pinned to an edge it does not fit inside.
  else side = room('top') >= room('bottom') ? 'top' : 'bottom'

  const spillStart = input.anchor.left + input.size.width - (input.band.right - input.margin)
  const spillEnd = input.band.left + input.margin - (input.anchor.right - input.size.width)
  return { side, align: spillStart > 0 && spillStart > spillEnd ? 'end' : 'start' }
}
