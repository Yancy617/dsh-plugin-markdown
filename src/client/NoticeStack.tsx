/**
 * 工作台的通知层。
 *
 * 内容
 * - DEFAULT_NOTICE_MS / NoticeTone / DEFAULT_NOTICE_TONE / NoticeItem。
 * - LINE / COLLAPSED_LINES / COLLAPSED_MAX / GAP / row。
 * - NoticeStack。
 *
 * 行为
 * - 通知浮在文档上（渲染在 lower band 上），不占布局、不随文档滚走。
 * - 悬停时倒计时暂停；离开后重新给整段时长。
 * - 每条最多两行，超出才出现展开控件；替换文本重新折叠并重新计时。
 * - 栈只显示一条，其余收在计数后面。
 *
 * 边界
 * - 不决定有哪些通知 / 文案 / 时长 / 关闭含义（workbench/useNotices.ts）。
 *
 * 相关文件
 * - 依赖：primitives。
 * - 被依赖：workbench/useNotices.ts、sidebar.module.css。
 *
 * 改哪里
 * - 改默认时长 / 音色：DEFAULT_NOTICE_MS / DEFAULT_NOTICE_TONE。
 * - 改折叠：LINE / COLLAPSED_LINES。
 * - 改布局：GAP / row。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  Button,
  IconChevronDownOutlineRegular,
  IconChevronUpOutlineRegular,
  IconCloseOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'

/**
 * How long a notice stays when its caller does not say.
 *
 * The project's own value for a status message: 「提示不驻留」, six seconds and closable by
 * hand, decided in the 0.1.0 round. It lives here rather than in each caller so that
 * "how long does a notice stay" has one answer by default, and a caller that needs a
 * different one has to write the number down — which is the point, because the two
 * callers that differ are differing on purpose.
 */
export const DEFAULT_NOTICE_MS = 6000

/** One notice: what it says, how it reads, and when it goes. */
export interface NoticeItem {
  /**
   * Identity, so React keeps this row — and with it the countdown — across
   * rebuilds. Keying by position instead would restart a timer whenever an earlier
   * notice joined or left.
   */
  readonly id: string
  /**
   * The message. Replacing it restarts the countdown, which is the rule this layer
   * inherited: a notice whose text changed is a different thing to read, so it gets
   * the full time again rather than the remainder of the previous one's.
   */
  readonly text: string
  /**
   * Which tone it wears. Omit for {@link DEFAULT_NOTICE_TONE} — the grey/grey one.
   *
   * Optional so that a caller with nothing to say about outcome says nothing: the
   * default is the tone for "this is a notice", and a tone is only worth naming when it
   * means something.
   */
  readonly tone?: NoticeTone
  /**
   * Milliseconds before it dismisses itself. Omit it for {@link DEFAULT_NOTICE_MS}; pass
   * `null` for a notice that stays until the reader closes it.
   *
   * The three values a save needs are all deliberate, which is why each is written at
   * the call site rather than left to the default: a write in flight has nothing to time
   * out, a four-character receipt does not need six seconds, and a message saying the
   * text did not reach the disk is the one kind that should not leave on its own.
   */
  readonly autoMs?: number | null
  /** Called by the timer and by the row's close button. */
  readonly onDismiss: () => void
}

/**
 * The line height the row's text carries, and the lines a collapsed notice shows.
 *
 * One constant feeding both the `lineHeight` and the collapsed `maxHeight`, because
 * the cap is only exactly N lines while the two agree — two literals would be two
 * numbers to keep in step by hand, and the symptom of them drifting is a notice cut
 * through the middle of a line.
 */
const LINE = 1.7
const COLLAPSED_LINES = 2

/** What the message is clamped to until the reader asks for the rest. */
const COLLAPSED_MAX = `${String(LINE * COLLAPSED_LINES)}em`

/**
 * 通知条在它所覆盖的盒子内浮多深 —— 三条边共用一个数。
 *
 * 距编辑面左右各 1px、距 band 顶部 1px，让通知读起来像坐在这一列里，而不是贴着边。
 * 三条边都读这一个常量，改一处即可。
 *
 * 故意不用 --dsh-editor-pad-x：那是正文的缩进（50px），通知覆盖整列，不对齐正文的测量宽度。
 */
const GAP = 1

/**
 * One row's geometry.
 *
 * **No horizontal margin**, so the card's own edges *are* the layer's edges — and the layer is the
 * editor pane inset by {@link GAP}. A second inset here would make every notice narrower than the
 * column it is talking about; {@link GAP} above it is the strip's own float, not a measure of the
 * document.
 *
 * `flexShrink: 0` because the layer is a flex column: without it a stack taller
 * than the space it floats over would compress the rows instead of overflowing.
 */
const row: React.CSSProperties = {
  margin: `${String(GAP)}px 0 0`,
  padding: '8px 10px',
  borderRadius: 8,
  fontSize: 12,
  lineHeight: LINE,
  flexShrink: 0,
  // Flex, so the message takes the room and the buttons are pushed to the
  // far right. Without it they sit next to each other as inline boxes.
  display: 'flex',
  /*
   * **Centred, and the reason is arithmetic rather than taste.** The buttons are
   * `Button size="sm"`, which the shipped stylesheet gives `height: 28px`, while one
   * line of this row's text is `fontSize: 12` × `lineHeight: 1.7` = **20.4px**. So on a
   * one-line notice the row's content box is 28px tall and the text is 20.4 of it:
   * top-aligned, all 7.6px of slack lands below the text and the message sits visibly
   * high in its own card.
   *
   * Centring also settles the two-line case, where the buttons meet a 40.8px message
   * instead of a 20.4px one — they stay level with the middle of what they act on.
   */
  alignItems: 'center',
  gap: 8,
  // The layer switches the pointer off for the gaps; each row switches it back on.
  pointerEvents: 'auto',
}

/**
 * The four tones a notice can wear, declared as **fill + stroke** pairs.
 *
 * A tone is a (background, left stroke) pair and nothing else, so adding a fifth is one
 * row in the table below. Anything that is not a tone — the collapse control, the close
 * button, the layer — stays out of it.
 *
 * ## Every value here has to be opaque and themed, and that rules out literals
 *
 * 通知浮在文档上，半透明填充会让文字透出来、读起来像浮在通知上面。
 * 所以每个音色必须是“不透明 + 主题色”，不能写字面量颜色；下面的值都从 app.asar 读出，各有明暗两套。
 *
 *   `--dsw-alias-bg-overlay`             `neutral-bluish-150` / `-700`   ← the grey fill
 *   `--dsw-alias-state-idle-primary`     `neutral-300` / `-600`         ← the grey stroke
 *   `--dsw-alias-state-success-primary`  `green-500`                    ← the green stroke
 *   `--dsw-alias-state-warn-tertiary`    `amber-100` / `amber-900`      ← the yellow fill
 *   `--dsw-alias-state-warn-primary`     `amber-500`                    ← the amber stroke
 *   `--dsw-alias-state-error-primary`    `red-600` / `red-400`          ← the red stroke
 *
 * ## The one constructed value, and why it is constructed
 *
 * **The red fill has no token.** The product publishes `-tertiary` surfaces for the
 * warning and success families and none for the error family — `--dsw-alias-state-error-*`
 * stops at `-primary` and `-secondary`. So the pink is mixed from the error accent over
 * the page's own base: `color-mix` with an **opaque** second colour, which is what keeps
 * the result opaque, and `--dsw-alias-bg-base` is what makes it follow the theme.
 * (`color-mix(… , transparent)` is the shell's own idiom elsewhere and would have been
 * translucent — the one thing this palette cannot have.)
 *
 * The `10%` is the only number on this table that was chosen rather than read. It was
 * seen against a real refusal before it was kept — see §6.102 — which is the only way a
 * chosen number can be settled.
 */
export type NoticeTone = 'neutral' | 'success' | 'warning' | 'danger'

/** The tone a notice wears when its caller does not say. */
export const DEFAULT_NOTICE_TONE: NoticeTone = 'neutral'

/**
 * One tone: what it fills with, and what colour its left stroke is.
 *
 * **Those two things and nothing else.** A field that only one tone would set is a
 * property of a notice's *content*, not of its tone, and belongs where the content is
 * decided. (This table briefly carried a `weight` for the warning tone's bold message.
 * It went when the failure moved off `warning`: the look the reader approved is not
 * bold, and bold-for-one-tone was only ever a leftover.)
 */
interface ToneStyle {
  /** Opaque, themed background. */
  readonly fill: string
  /** Colour of the 3px left stroke. */
  readonly stroke: string
}

const TONES: Readonly<Record<NoticeTone, ToneStyle>> = {
  /** Nothing has gone wrong and nothing has finished either — the in-progress and default tone. */
  neutral: {
    fill: 'var(--dsw-alias-bg-overlay)',
    stroke: 'var(--dsw-alias-state-idle-primary)',
  },
  /** It worked. Same grey fill as `neutral`: what changed is the outcome, not the surface. */
  success: {
    fill: 'var(--dsw-alias-bg-overlay)',
    stroke: 'var(--dsw-alias-state-success-primary)',
  },
  /**
   * Reserved, and currently unused — the yellow pair has no caller.
   *
   * The save failure lived here until the reader compared it with the pink against a real
   * refusal and kept the pink (§6.102). Yellow stays declared rather than deleted because
   * it is the one colour in the set that is neither "nothing happened" nor "it failed",
   * which is exactly what a future notice will want.
   */
  warning: {
    fill: 'var(--dsw-alias-state-warn-tertiary)',
    stroke: 'var(--dsw-alias-state-warn-primary)',
  },
  /** It did not work, and the reader has to know: a refused save, and the local conflict that causes most of them. */
  danger: {
    fill: 'color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, var(--dsw-alias-bg-base))',
    stroke: 'var(--dsw-alias-state-error-primary)',
  },
}

/**
 * Draw one tone over the row's geometry.
 * @param tone - which tone.
 * @returns the row's style.
 */
function rowStyle(tone: NoticeTone): React.CSSProperties {
  const { fill, stroke } = TONES[tone]
  return {
    ...row,
    background: fill,
    borderLeft: `3px solid ${stroke}`,
  }
}

/**
 * The layer's right inset: the outline column, and the same gap inside it.
 *
 * Spelled once because it is one question asked of two boxes: the band holds the pane *and* the
 * outline column, so "GAP inside the pane's right edge" is the outline's width plus {@link GAP}.
 */
const LAYER_RIGHT = `calc(var(--dsh-outline-width, 0px) + ${String(GAP)}px)`

/**
 * The layer itself: pinned to the top of the visible area, over the **document**.
 *
 * Its box **is the editor pane** — the column the document is read in, which is the box the reader
 * compares a notice against — inset by {@link GAP} on the three edges the writer named. Two insets
 * off the band, both derived from that one number:
 *
 *   `left: GAP`                the band's left edge is the pane's, so this is 1px inside the pane
 *   `right: LAYER_RIGHT`       the outline column, plus the same 1px
 *
 * The card adds no horizontal inset of its own (see `row`), so the strip's edges are the pane's
 * edges, two pixels in. It deliberately does **not** read `--dsh-editor-pad-x`: the editor's gutter
 * is the *text's* inset, and this layer covers the column the text lives in, not the text's
 * measure.
 *
 * Folded, the outline's value is `0px` and the notice spans a pane that has the whole band.
 *
 * **Rendered on the band** (`lower` in `./MarkdownWorkbench.tsx`) rather than inside the pane,
 * and that is part of the rule rather than a detail of the tree: the band is the nearest
 * positioned ancestor, the box that clips and scrolls is a child of it, and an absolutely
 * positioned element whose containing block lies outside a scroll container is neither clipped
 * nor scrolled by it — so `top: 0` is the top of the visible area, not of the document. Inside
 * the pane both answers went wrong at once for a round (§6.144).
 *
 * `pointerEvents: 'none'` on the layer and `'auto'` on each row, so the strip of
 * empty space the rows leave beside themselves does not swallow a click meant for
 * the document underneath. A layer that took the pointer across its whole width
 * would make the top band of the document — one of the places a reader aims at
 * most — unclickable while a notice happened to be showing.
 *
 * `zIndex` is **read off the shell's own scale rather than picked**. The layers this
 * one has to stay above and below are all in the shipped stylesheets:
 *
 *   `markdown/CodeBlock.module.css`  z-index: 6      ← the highest thing the document
 *   `MenuGroup` / `SegmentedControl` z-index: 1         itself can draw
 *   `Tooltip` / `HoverCard` / `Menu` z-index: 100 … 1100, all portaled to `body`
 *
 * `10` clears everything the document can draw and stays well under every portaled
 * overlay, which is the right order: a notice belongs to the document, and a menu
 * the reader just opened belongs on top of it. The first version used `5`, which was
 * under `CodeBlock`'s `6` — a number chosen without looking at the scale.
 */
const layer: React.CSSProperties = {
  position: 'absolute',
  // The band's own top edge, which does not move: the band is the box below the toolbar and
  // outside the scroller. The strip's own float above it is the row's margin, so the visible gap is
  // stated where the strip is drawn.
  top: 0,
  left: GAP,
  right: LAYER_RIGHT,
  zIndex: 10,
  display: 'flex',
  flexDirection: 'column',
  pointerEvents: 'none',
}

/**
 * One notice row: the message, its tone, the two buttons, and the timer.
 *
 * ## The countdown stops while the pointer is inside
 *
 * A notice that can vanish from under the pointer is one the reader cannot finish
 * reading or copy out in full — which is exactly what a long message is for. So the
 * countdown does not merely pause: while the pointer is inside the row there is **no
 * pending timer at all**, and leaving arms a fresh one for the **full** duration
 * rather than the remainder of the old one. Coming back suspends it again, and the
 * close button works at any time.
 *
 * `onDismiss` is held in a ref rather than listed as an effect dependency: it is
 * almost always an inline arrow, so depending on it would restart the timer on
 * every render and the notice would never actually expire.
 * @param props - the item's text, tone, delay and dismissal.
 * @returns the notice row.
 */
function NoticeRow({
  text,
  tone = DEFAULT_NOTICE_TONE,
  autoMs = DEFAULT_NOTICE_MS,
  onDismiss,
}: Omit<NoticeItem, 'id'>): React.JSX.Element {
  const dismissRef = useRef(onDismiss)
  dismissRef.current = onDismiss

  /** The pending auto-dismiss, or `null` while none is armed. */
  const pending = useRef<number | null>(null)
  /**
   * Whether the pointer is inside this row.
   *
   * A ref, not state: it decides whether a countdown may exist, and nothing renders
   * from it — re-rendering to change a timer would be a render for nothing.
   */
  const inside = useRef(false)

  const disarm = useCallback((): void => {
    if (pending.current === null) return
    window.clearTimeout(pending.current)
    pending.current = null
  }, [])

  const arm = useCallback((): void => {
    disarm()
    // While the pointer is inside there is no countdown at all, not a paused one:
    // there is nothing to resume, and leaving starts the full duration again. A null
    // duration means there is never a countdown to arm.
    if (inside.current || autoMs === null) return
    pending.current = window.setTimeout(() => dismissRef.current(), autoMs)
  }, [autoMs, disarm])

  // Armed on mount, and re-armed when the message is replaced — a notice whose text
  // changed is a different thing to read, so it gets the full time again.
  useEffect(() => {
    arm()
    return disarm
  }, [arm, disarm, text])

  /**
   * Whether the message is longer than a collapsed row shows.
   *
   * Measured rather than assumed: whether two lines actually hide anything depends
   * on the text, the width and the font, and none of those is knowable here.
   */
  const [overflowing, setOverflowing] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const body = useRef<HTMLSpanElement>(null)

  useLayoutEffect(() => {
    // Measured only while collapsed, where `clientHeight` is the cap and
    // `scrollHeight` is the whole message. Expanded, the two are equal and this
    // would answer "nothing is hidden" — which would take away the control that
    // collapses it again.
    if (expanded) return
    const node = body.current
    if (node === null) return
    setOverflowing(node.scrollHeight > node.clientHeight + 1)
  }, [expanded, text])

  // A replaced message starts collapsed, like a fresh one: "show me the rest" is a
  // decision about *that* text, not a standing preference.
  useEffect(() => {
    setExpanded(false)
  }, [text])

  return (
    <div
      style={rowStyle(tone)}
      onPointerEnter={() => {
        inside.current = true
        disarm()
      }}
      onPointerLeave={() => {
        inside.current = false
        arm()
      }}
    >
      <span
        ref={body}
        style={{
          flex: 1,
          minWidth: 0,
          // Clipped in both states, so `scrollHeight` stays the whole message even
          // while collapsed. `maxHeight: none` is the expanded state rather than
          // removing `overflow`, which would take that reading away.
          overflow: 'hidden',
          ...(expanded ? {} : { maxHeight: COLLAPSED_MAX }),
        }}
      >
        {text}
      </span>
      {overflowing && (
        <Button
          size="sm"
          variant="ghost"
          icon={
            expanded ? (
              <IconChevronUpOutlineRegular size={14} />
            ) : (
              <IconChevronDownOutlineRegular size={14} />
            )
          }
          aria-label={expanded ? '收起提示' : '展开提示'}
          aria-expanded={expanded}
          style={{ flexShrink: 0 }}
          onClick={() => setExpanded(current => !current)}
        />
      )}
      <Button
        size="sm"
        variant="ghost"
        icon={<IconCloseOutlineRegular size={14} />}
        aria-label="关闭提示"
        style={{ flexShrink: 0 }}
        onClick={onDismiss}
      />
    </div>
  )
}

/**
 * Rows a collapsed layer shows before it offers the rest.
 *
 * One, because the stack is an interruption: opening a file that carries both
 * frontmatter and constructs this editor cannot model puts two multi-line blocks
 * over the top of the document at once, and a save receipt could make it three.
 */
const COLLAPSED_ROWS = 1

/**
 * The layer's own control, for the rows it is holding back.
 *
 * A chip rather than a row: it reports a count instead of a message, and it carries
 * the plain row's fill so it reads as part of the stack rather than as text left
 * floating over the document.
 */
const more: React.CSSProperties = {
  display: 'flex',
  // The same box the rows sit in, with the same float above it and no horizontal inset of its own.
  margin: `${String(GAP)}px 0 0`,
  alignSelf: 'flex-start',
  flexShrink: 0,
  borderRadius: 8,
  background: 'var(--dsw-alias-markdown-inline-code)',
  // The layer switches the pointer off for the gaps; this switches it back on.
  pointerEvents: 'auto',
}

/**
 * Render the notices the workbench is currently raising, stacked in one layer.
 *
 * Collapsed to {@link COLLAPSED_ROWS} row, with the rest behind one control — the
 * rule the rows themselves follow for long text, applied to the stack. Both are
 * about the same thing: an overlay earns its space by being read, and a stack that
 * grows with every condition a document happens to meet stops being read at all.
 * @param props.items - the notices to show, in the order they should stack.
 * @returns the layer, or `null` when there is nothing to say.
 */
export function NoticeStack({
  items,
}: {
  readonly items: readonly NoticeItem[]
}): React.JSX.Element | null {
  const [allShown, setAllShown] = useState(false)

  // A stack that emptied out starts collapsed again: "show me all of them" is a
  // decision about the notices that were on screen, not a standing preference.
  // Nothing renders while it is empty, so this settles before the next notice
  // arrives rather than flashing an expanded stack.
  useEffect(() => {
    if (items.length === 0) setAllShown(false)
  }, [items.length])

  if (items.length === 0) return null
  const held = items.length - COLLAPSED_ROWS
  const shown = allShown ? items : items.slice(0, COLLAPSED_ROWS)

  return (
    <div style={layer} role="status" aria-live="polite">
      {shown.map(({ id, ...rest }) => (
        <NoticeRow key={id} {...rest} />
      ))}
      {held > 0 && (
        <div style={more}>
          <Button
            size="sm"
            variant="ghost"
            aria-expanded={allShown}
            onClick={() => setAllShown(current => !current)}
          >
            {allShown ? '收起' : `还有 ${String(held)} 条`}
          </Button>
        </div>
      )}
    </div>
  )
}
