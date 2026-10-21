/**
 * 选中文本时浮出的格式栏。
 *
 * 内容
 * - FloatingToolbar 与栏内常量（BAR_* / HEADING_*）。
 *
 * 行为
 * - 块操作在前（正文 / 标题 / 引用 / 列表），行内格式在中（粗 / 斜 / 删除线 / 代码），链接在后。
 * - 位置交给 selectionPlacement：单行在上、多行在下，再挪进可视带。
 * - 指针在编辑区内按住时不出现，松开后再决定。
 * - 撤销 / 重做（HISTORIC_TAG）收起格式栏，不把恢复出的选区当成一次新手势。
 * - 表面吃掉 pointer-down，保住选区；链接弹窗例外，保存 / 恢复选区。
 * - 链接弹窗里**回车只执行「应用」**；「应用」置灰（地址为空）时回车什么也不做——不换行、不关窗。
 *   一律 `preventDefault()`：否则这次回车的默认动作会落到随即拿到焦点的编辑区上，多出一个空段落。
 * - 弹窗本身在 `LinkDialog.tsx`：地址 + 显示文字（标题字段已移除，已有的悬停提示原样保留）。
 * - DOM 回答有没有选区与在哪，Lexical 回答是什么格式 / 块。
 *
 * 边界
 * - 不负责位置计算（selectionPlacement.ts）。
 * - 不负责块操作定义（operations.ts）。
 *
 * 相关文件
 * - 依赖：selectionPlacement、operations、linkEdit、LinkDialog、toolbar 样式表、primitives。
 * - 被依赖：MarkdownEditor.tsx。
 *
 * 改哪里
 * - 改呈现：FloatingToolbar 的渲染。
 * - 改出现时机：readSelection / pointer 处理。
 * - 改位置：selectionPlacement.ts。
 */
import { $isLinkNode } from '@lexical/link'
import { ListNode } from '@lexical/list'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { $isHeadingNode, HeadingNode } from '@lexical/rich-text'
import { $setBlocksType } from '@lexical/selection'
import {
  $getSelection,
  $isRangeSelection,
  $isRootNode,
  $setSelection,
  FORMAT_TEXT_COMMAND,
  HISTORIC_TAG,
  type ElementNode,
  type LexicalEditor,
  type LexicalNode,
  type RangeSelection,
  type TextFormatType,
} from 'lexical'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Button,
  IconCodeOutlineRegular,
  IconLinkOutlineRegular,
  Menu,
  type MenuEntry,
  MenuSurface,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { $getNearestNodeOfType } from '@lexical/utils'
import { $isTableCellNode, $isTableNode, $isTableRowNode } from '@lexical/table'

/** Inline and block state of the current selection, as the bar renders it. */
interface SelectionFormats {
  readonly bold: boolean
  readonly italic: boolean
  readonly strike: boolean
  readonly code: boolean
  readonly link: boolean
  /** Top-level block kind: `paragraph`, `heading`, `quote`, `list`, … */
  readonly block: string
  /** Heading tag when `block` is `heading`. */
  readonly heading: string
  /** `bullet` / `number` / `check` when `block` is `list`. */
  readonly listKind: string
}

/** What the bar is anchored to: the selection's box, the band, and how many lines it covers. */
interface BarAnchor {
  /** Bounding rect of the selection, in viewport coordinates. */
  readonly selection: ClientRect
  /** Visible band the bar must stay inside. */
  readonly band: ClientRect
  /** Visual lines the selection covers. */
  readonly lines: number
  /** Whether the selection sits in a table's first row, where hanging above would hit the column handle. */
  readonly firstTableRow: boolean
}

import { $insertLink, $readLink, $writeLink, removeLink } from './linkEdit'
import { LinkDialog, EMPTY_LINK_SEED, type LinkDialogSeed } from './LinkDialog'
import { applyBlockOperation, blockOperation, canNest } from './operations'
import {
  countLines,
  fitSubmenu,
  placeBar,
  visibleBand,
  type BarPlacement,
  type ClientRect,
  type SubmenuFit,
} from './selectionPlacement'
import toolbar from './toolbar.module.css'

/**
 * The bar's heading entry.
 *
 * A constant rather than a quoted literal in {@link BAR_BLOCKS}: a heading trigger is not an
 * operation — it is a way into six of them — so it is named once and never spelled like one.
 * Same reason the level list below is a plain array of strings.
 */
const HEADING_ID = 'heading'

/**
 * The six levels the heading trigger offers, in the order a reader counts them.
 *
 * All six; the bar offers every level. `./operations` has defined `h4`–`h6`
 * since it was written and the slash menu has always listed them; only this bar
 * stopped at `h3`, because three buttons was as many as a row could carry.
 */
const HEADING_LEVELS = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'] as const

/**
 * The heading card's rows, taken from the shared catalogue.
 *
 * The label is the operation's own (`一级标题` …), so the bar and the slash menu say
 * the same words about the same thing. The leading glyph is the level's own name —
 * for a list of levels, `H1`…`H6` *is* the artwork, and the bar already labels its
 * block buttons with text because the product icon set ships no heading glyph
 * (all 94 of its `…Regular` icons were listed; none is one).
 */
const HEADING_ITEMS: readonly MenuEntry[] = HEADING_LEVELS.map(id => ({
  id,
  label: blockOperation(id)?.label ?? id,
  icon: id.toUpperCase(),
}))

/**
 * How this bar presents the block operations it offers.
 *
 * The operations themselves come from `./operations` — the seven this bar shares
 * shared with the slash menu is defined once, so changing how a
 * heading is produced meant changing two places and hoping. Only the glyph and
 * the "is it on" test live here, because a floating bar and a menu present the
 * same operation differently.
 */
const BAR_BLOCKS: readonly {
  readonly id: string
  readonly glyph: React.ReactNode
  readonly isActive: (formats: SelectionFormats) => boolean
}[] = [
  { id: 'paragraph', glyph: '正文', isActive: formats => formats.block === 'paragraph' },
  { id: HEADING_ID, glyph: '标题', isActive: formats => formats.heading !== '' },
  { id: 'quote', glyph: '❝', isActive: formats => formats.block === 'quote' },
]

/** The two lists this bar toggles. */
const BAR_LISTS: readonly { readonly id: string; readonly glyph: string }[] = [
  { id: 'bullet', glyph: '•' },
  { id: 'number', glyph: '1.' },
]

/**
 * The nesting pair's glyphs.
 *
 * Typographic, and deliberately so: the product icon set has no indent glyph — all 94 of its `…Regular`
 * icons were listed and none is one — and this bar already ships text glyphs (`正文`, `H1`, `❝`, `•`, `1.`)
 * rather than drawing artwork the product does not have. `⇥` is the tab arrow, the key that does this.
 */
const BAR_NESTING: readonly { readonly id: string; readonly glyph: string }[] = [
  { id: 'indent', glyph: '⇥' },
  { id: 'outdent', glyph: '⇤' },
]

/** Separator between the bar's sections. */
const BAR_DIVIDER = (
  <span
    style={{
      width: 1,
      alignSelf: 'stretch',
      background: 'var(--dsw-alias-interactive-bg-hover)',
    }}
  />
)

/** Distance between the bar and the selection edge it hangs from. */
const BAR_GAP = 8

/** Distance the bar keeps from the content container's edges. */
const BAR_MARGIN = 8

/**
 * Distance between the heading trigger and its card.
 *
 * `4` because that is the offset the shell's own menu card uses — `Menu.module.css`
 * places a list at `calc(100% ± 4px)` from its anchor — and this card is that card.
 */
const HEADING_GAP = 4

const NO_FORMATS: SelectionFormats = {
  bold: false,
  italic: false,
  strike: false,
  code: false,
  link: false,
  block: 'paragraph',
  heading: '',
  listKind: '',
}

/**
 * Classify the block the selection sits in. Must run inside a read or update.
 * @param selection - the live range selection.
 * @returns the top-level block facts.
 */
function $describeBlock(selection: RangeSelection): Pick<SelectionFormats, 'block' | 'heading' | 'listKind'> {
  const anchor = selection.anchor.getNode()

  const list = $getNearestNodeOfType(anchor, ListNode)
  if (list !== null) {
    return { block: 'list', heading: '', listKind: list.getListType() }
  }

  // Walk to the child of root that contains the anchor.
  let current: LexicalNode | null = anchor
  while (current !== null) {
    const parent: LexicalNode | null = current.getParent()
    if (parent === null) break
    if ($isRootNode(parent)) {
      const type = current.getType()
      if ($isHeadingNode(current)) {
        return { block: 'heading', heading: current.getTag(), listKind: '' }
      }
      return { block: type, heading: '', listKind: '' }
    }
    current = parent
  }
  return { block: 'paragraph', heading: '', listKind: '' }
}

/**
 * Whether the caret sits in a table's first row.
 *
 * The bar hangs **above** a single-line selection, and for that row "above" is exactly where the
 * column handle floats — the handle is drawn above the bar's layer, so the two overlap. The owner
 * of the placement rule turns this into "hang below instead".
 * @param selection - the live range selection.
 * @returns true when the anchor cell is in row 0 of a table.
 */
function $inFirstTableRow(selection: RangeSelection): boolean {
  let node: LexicalNode | null = selection.anchor.getNode()
  while (node !== null) {
    if ($isTableCellNode(node)) {
      const row = node.getParent()
      if (row === null || !$isTableRowNode(row)) return false
      const table = row.getParent()
      if (table === null || !$isTableNode(table)) return false
      return table.getChildren().indexOf(row) === 0
    }
    if ($isTableRowNode(node) || $isTableNode(node)) return false
    node = node.getParent()
  }
  return false
}

/** Text label of one bar action. */
interface BarActionProps {
  /** Accessible name; also the tooltip. */
  readonly label: string
  /** Visible content: a short text glyph, or an icon node. */
  readonly glyph: React.ReactNode
  /** Whether the action's format is currently on. */
  readonly active?: boolean
  /** Activation. */
  readonly onSelect: () => void
}

/**
 * One format-bar action: an official button with an official tooltip.
 * @param props - label, glyph, active state, and activation.
 * @returns the action button.
 */
function BarAction({ label, glyph, active, onSelect }: BarActionProps) {
  return (
    <Tooltip label={label} side="top">
      <Button
        size="sm"
        variant="ghost"
        className={toolbar.toggle}
        aria-label={label}
        // A boolean, never `undefined`: the stylesheet keys off the attribute, and
        // React omits an attribute whose value is undefined.
        aria-pressed={active === true}
        onClick={onSelect}
      >
        {glyph}
      </Button>
    </Tooltip>
  )
}

/**
 * The element that scrolls the document: the nearest ancestor of the editor root whose
 * `overflow-y` is auto or scroll and whose content is taller than its box.
 *
 * The platform `Modal` hands focus back to whatever had it when the dialog opened — in this panel
 * that is the editable root. Focusing an element taller than the viewport scrolls its top into
 * view, so closing the link dialog would jump the document to the top. The dialog parks this
 * element's offset and puts it back when it closes.
 * @param start - the editor root.
 * @returns the scroller, or `null` when nothing scrolls.
 */
function scrollerOf(start: Element | null): HTMLElement | null {
  for (let node = start?.parentElement ?? null; node !== null; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY
    if ((overflow === 'auto' || overflow === 'scroll') && node.scrollHeight > node.clientHeight) {
      return node
    }
  }
  return null
}

/**
 * Render the selection-anchored format bar.
 * @returns the floating bar, or `null` while nothing is selected.
 */
export function FloatingToolbar() {
  const [editor] = useLexicalComposerContext()
  const [formats, setFormats] = useState<SelectionFormats>(NO_FORMATS)
  /**
   * Whether the caret is in a list item, so the nesting pair has something to act on.
   *
   * Held in React state and set from the same evaluation as `formats`, because it has to change when
   * the **caret** moves, and a caret move is not a re-render.
   */
  const [nestable, setNestable] = useState(false)
  const [anchor, setAnchor] = useState<BarAnchor | null>(null)
  const [placed, setPlaced] = useState<BarPlacement | null>(null)
  const [linkOpen, setLinkOpen] = useState(false)
  /**
   * 弹窗要预填的东西：地址、显示文字、是不是在编辑一处已有链接。
   *
   * 在**打开那一刻**从 `$readLink()` 读出来并留在这里，不在弹窗打开期间重算：弹窗拿走焦点后
   * 编辑器选区会动，重算会让标题与次按钮在读者眼皮底下翻面。
   */
  const [linkSeed, setLinkSeed] = useState<LinkDialogSeed>(EMPTY_LINK_SEED)
  const panelRef = useRef<HTMLDivElement>(null)

  /**
   * Whether the heading card is showing, and where it was measured to fit.
   *
   * `Menu` is owner-controlled, so opening is this component's decision — hover, a
   * click, and keyboard focus all take it (the three the shell's own submenu rows
   * answer to). Closing is the shell's: `closeOnPointerLeave` arms a pointer grace
   * that covers the few pixels between the button and the card, so crossing them
   * neither closes the card nor leaves it behind.
   */
  const [headingOpen, setHeadingOpen] = useState(false)
  const [headingFit, setHeadingFit] = useState<SubmenuFit | null>(null)
  /** The trigger, measured to decide which side the card fits on. */
  const headingRef = useRef<HTMLSpanElement>(null)

  /**
   * Whether a pointer is down inside the editable, i.e. a selection is still being made.
   *
   * A ref rather than state: it is read by the evaluation below and by the pointer
   * handlers, and the thing that has to re-render when it changes is the bar's
   * position, which the evaluation already owns.
   */
  const dragging = useRef(false)

  // The saved selection is restorable across the link dialog's focus change.
  const savedSelection = useRef<RangeSelection | null>(null)

  /**
   * Where the document was scrolled when the link dialog opened, and in which element.
   *
   * Closing the dialog hands focus back to the editable root (see {@link scrollerOf}), and that
   * focus scrolls the document to its top. Parking the offset here lets the commit that closes the
   * modal put the reader back exactly where they were.
   */
  const parkedScroll = useRef<{ readonly element: HTMLElement; readonly top: number } | null>(null)

  const open = anchor !== null && !linkOpen

  /*
   * **Closing the link dialog must not move the reader.** The platform `Modal` gives focus back to
   * the editable root, and focusing it scrolls the document to its top (measured: 2785 → 0 in the
   * harness). Put the parked offset back in the same commit, and once more on the next frame in case
   * the focus-driven scroll lands after layout.
   */
  useLayoutEffect(() => {
    if (linkOpen) return undefined
    const parked = parkedScroll.current
    if (parked === null) return undefined
    parkedScroll.current = null
    parked.element.scrollTop = parked.top
    const frame = requestAnimationFrame(() => {
      parked.element.scrollTop = parked.top
    })
    return () => cancelAnimationFrame(frame)
  }, [linkOpen])

  /**
   * Decide the bar from the live editor and the live DOM: what the selection is
   * formatted as, and where it is.
   *
   * One function for both callers — the editor's update listener and the
   * pointer-up handler — because "the selection may have changed" and "the
   * selection was finished" are the same question here, and answering it twice
   * would be two places to keep in step.
   *
   * Must run inside a read.
   */
  const readSelection = useCallback((): void => {
    // Still choosing. A bar now would chase the pointer and change sides as the
    // selection crosses a line, so the decision is deferred to the release.
    if (dragging.current) {
      setAnchor(null)
      return
    }

    /*
     * **Whether there is a selection is decided from the DOM, not from Lexical.**
     *
     * `selectionchange` is asynchronous — Lexical's own source says so twice
     * (`lexical/dist/Lexical.dev.js:11240` and `:11368`, both "it will be
     * asynchronous") — so there is a window in which the DOM selection has already
     * collapsed but `$getSelection()` still reports the range the reader just clicked
     * away from. Deciding on Lexical's copy inside that window re-shows the bar over
     * the new caret for a frame, and then the real update hides it again: the flash.
     * The DOM range is current at every instant, including inside a `pointerup`
     * handler, which is exactly when this runs.
     */
    const root = editor.getRootElement()
    const native = window.getSelection()
    if (root === null || native === null || native.rangeCount === 0) {
      setAnchor(null)
      return
    }
    const range = native.getRangeAt(0)
    /*
     * `collapsed` is the same question Lexical's `isCollapsed()` answers, asked of the
     * copy that is current. A selection made **anywhere else on the page** is refused
     * too: this function also runs from window-level listeners — `pointerup`, `scroll`,
     * `resize` — and those see a selection in the file tree or the conversation just as
     * well as one in the document.
     */
    if (
      range.collapsed ||
      range.toString().trim() === '' ||
      !root.contains(range.commonAncestorContainer)
    ) {
      setAnchor(null)
      return
    }
    // `getClientRects`, not the bounding rect: the line count is what picks the
    // side, and a bounding rect cannot tell one line from four.
    const lines = countLines(Array.from(range.getClientRects()))
    if (lines === 0) {
      setAnchor(null)
      return
    }

    // Lexical is asked what the selection **is** — the formats, the block, whether a
    // nesting operation has anything to act on. It may be one `selectionchange` behind,
    // and that is the harmless direction: the geometry above is the DOM's either way.
    const selection = $getSelection()
    if (!$isRangeSelection(selection)) {
      setAnchor(null)
      return
    }

    const block = $describeBlock(selection)
    setFormats({
      bold: selection.hasFormat('bold'),
      italic: selection.hasFormat('italic'),
      strike: selection.hasFormat('strikethrough'),
      code: selection.hasFormat('code'),
      link: $isLinkNode(selection.anchor.getNode().getParent()),
      ...block,
    })
    setNestable(canNest(editor))

    const box = range.getBoundingClientRect()
    setAnchor({
      selection: { left: box.left, top: box.top, right: box.right, bottom: box.bottom },
      band: visibleBand(root),
      lines,
      firstTableRow: $inFirstTableRow(selection),
    })
  }, [editor])

  // Re-evaluate on every editor update: an update fires for selection changes as
  // well as edits, which is exactly when this must re-evaluate.
  useEffect(
    () =>
      editor.registerUpdateListener(({ editorState, tags }) => {
        /**
         * Undo / redo restores text and selection, not a formatting gesture. A restored
         * non-collapsed selection would otherwise make the format bar reappear by itself; the
         * bar belongs to the writer's current selection gesture, so historic updates hide it
         * instead of evaluating it.
         */
        if (tags.has(HISTORIC_TAG)) {
          setAnchor(null)
          return
        }
        editorState.read(readSelection)
      }),
    [editor, readSelection],
  )

  /**
   * A pointer going down **inside the editable** starts a selection being made.
   *
   * Inside the editable, and not anywhere: the bar itself is portaled to `body`, and
   * a pointer-down on one of its buttons must not be mistaken for the start of a
   * new selection and hide the button before its click lands.
   */
  useEffect(() => {
    let detach: (() => void) | null = null
    const unregister = editor.registerRootListener(rootElement => {
      detach?.()
      detach = null
      if (rootElement === null) return
      const onPointerDown = (): void => {
        dragging.current = true
        setAnchor(null)
      }
      rootElement.addEventListener('pointerdown', onPointerDown)
      detach = () => rootElement.removeEventListener('pointerdown', onPointerDown)
    })
    return () => {
      unregister()
      detach?.()
    }
  }, [editor])

  /**
   * The release ends it — including a release outside the editable, which is why
   * this listens on the window rather than on the editable.
   */
  useEffect(() => {
    const onRelease = (): void => {
      if (!dragging.current) return
      dragging.current = false
      // Re-decide here rather than wait for an update: letting go does not by
      // itself change the selection, so no update is necessarily coming.
      editor.getEditorState().read(readSelection)
    }
    window.addEventListener('pointerup', onRelease)
    window.addEventListener('pointercancel', onRelease)
    return () => {
      window.removeEventListener('pointerup', onRelease)
      window.removeEventListener('pointercancel', onRelease)
    }
  }, [editor, readSelection])

  /** Follow the document when it scrolls or the window changes size under the bar. */
  useEffect(() => {
    if (!open) return undefined
    const remeasure = (): void => {
      editor.getEditorState().read(readSelection)
    }
    window.addEventListener('scroll', remeasure, true)
    window.addEventListener('resize', remeasure)
    return () => {
      window.removeEventListener('scroll', remeasure, true)
      window.removeEventListener('resize', remeasure)
    }
  }, [editor, open, readSelection])

  /**
   * Turn the anchor and the bar's own measured size into fixed coordinates.
   *
   * The size is only knowable once the bar is in the DOM, so the first pass renders
   * it hidden at the anchor and this corrects it before the browser paints.
   */
  const place = useCallback((): void => {
    const panel = panelRef.current
    if (!open || anchor === null || panel === null) {
      setPlaced(null)
      return
    }
    const next = placeBar({
      selection: anchor.selection,
      band: anchor.band,
      bar: { width: panel.offsetWidth, height: panel.offsetHeight },
      lines: anchor.lines,
      gap: BAR_GAP,
      margin: BAR_MARGIN,
      // The column handle floats just above a table's first row, above this bar's own layer.
      avoidTop: anchor.firstTableRow,
    })
    // Keeping the previous object when nothing moved lets React skip the second
    // render, which is what makes re-measuring on every scroll event affordable.
    setPlaced(current =>
      current !== null && current.left === next.left && current.top === next.top && current.side === next.side
        ? current
        : next,
    )
  }, [anchor, open])

  useLayoutEffect(() => {
    place()
  }, [place])

  // The bar's own width changes without the selection moving — the nesting pair
  // appearing in a list item is the case — so the clamp is re-run when it does.
  useEffect(() => {
    const panel = panelRef.current
    if (!open || panel === null || typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(() => {
      place()
    })
    observer.observe(panel)
    return () => {
      observer.disconnect()
    }
  }, [open, place])

  // The card belongs to the bar: when the bar goes the card goes with it, and the
  // next bar opens with it closed rather than reopening a menu nobody asked for.
  useEffect(() => {
    if (!open) {
      setHeadingOpen(false)
      setHeadingFit(null)
    }
  }, [open])

  /**
   * Decide which side and alignment the heading card opens on.
   *
   * Both inputs are **read rather than assumed**: the trigger's box and the card's
   * own measured box. Assuming either would mean writing a row height, a padding and
   * the trigger's width into this file, and all three belong to the shell's
   * stylesheet — the bar's own placement module already made that trade once, for the
   * same reason.
   *
   * It is a **layout** effect so the correction lands before the browser paints: the
   * card is rendered on the preferred side first, and a reader never sees it jump.
   * The card's size does not depend on which side it is on, so measuring it where it
   * currently sits and then moving it cannot feed back into the measurement.
   */
  useLayoutEffect(() => {
    if (!open || !headingOpen || anchor === null) return
    const trigger = headingRef.current?.getBoundingClientRect()
    if (trigger === undefined) return
    // Scoped to this bar's own surface, and keyed on the shell's own attribute: the
    // card is a `Menu` list, which is the only `role="menu"` in here — the bar itself
    // is a `MenuSurface` and carries no role of its own.
    const card = panelRef.current?.querySelector('[role="menu"]')
    if (!(card instanceof HTMLElement)) return
    const box = card.getBoundingClientRect()
    const next = fitSubmenu({
      anchor: { left: trigger.left, top: trigger.top, right: trigger.right, bottom: trigger.bottom },
      band: anchor.band,
      size: { width: box.width, height: box.height },
      // The bar's own side, so the card lands on the far side of the bar from the
      // selection instead of over the text being formatted.
      preferred: placed?.side ?? 'bottom',
      gap: HEADING_GAP,
      margin: BAR_MARGIN,
    })
    setHeadingFit(current =>
      current !== null && current.side === next.side && current.align === next.align ? current : next,
    )
  }, [anchor, headingOpen, open, placed])

  /** Run one command against the retained selection, then return focus to it. */
  const run = useCallback(
    (action: (target: LexicalEditor) => void): void => {
      action(editor)
      editor.focus()
    },
    [editor],
  )

  const toggleInline = useCallback(
    (format: TextFormatType): void => {
      run(current => current.dispatchCommand(FORMAT_TEXT_COMMAND, format))
    },
    [run],
  )

  const setBlock = useCallback(
    (create: () => ElementNode): void => {
      run(current => {
        current.update(() => {
          const selection = $getSelection()
          if (!$isRangeSelection(selection)) return
          $setBlocksType(selection, create)
        })
      })
    },
    [run],
  )

  /**
   * Open the link dialog with the current selection parked for restoration.
   *
   * **The boxes are filled with what the link really says.** `$readLink` reads the node's own
   * address and visible text; the value-equal check in `$writeLink` is what makes "open, change
   * nothing, apply" leave the bytes alone.
   *
   * 一处细节：**显示文字恰好等于地址**的链接（`/` 菜单插入的那种），预填时把显示文字留空——
   * 否则用户改地址后，文字还固执地留着旧地址。
   */
  const openLinkDialog = useCallback((): void => {
    const parked = editor.getEditorState().read(() => {
      const current = $getSelection()
      return {
        selection: $isRangeSelection(current) ? current : null,
        reading: $readLink(),
        selected: $isRangeSelection(current) ? current.getTextContent() : '',
      }
    })
    savedSelection.current = parked.selection
    const scroller = scrollerOf(editor.getRootElement())
    parkedScroll.current = scroller === null ? null : { element: scroller, top: scroller.scrollTop }
    const reading = parked.reading
    setLinkSeed(
      reading === null
        ? { url: '', text: parked.selected.trim(), editing: false }
        : {
            url: reading.url,
            text: reading.text === reading.url ? '' : reading.text,
            editing: true,
          },
    )
    setLinkOpen(true)
  }, [editor])

  /**
   * Apply the link dialog, or remove the link.
   *
   * `null` removes. Otherwise the selection decides which half runs: with no link under it the dialog
   * **inserts** (`$insertLink` — wraps the selected text, or drops a new link at a caret); with one it
   * **edits** (`$writeLink`, which does nothing at all when the address and the visible text are
   * unchanged, so opening a reference-style link and pressing apply cannot silently rewrite it as an
   * inline link).
   * @param url - the new address, or `null` to remove the link.
   * @param text - 显示文字；空串表示用地址。
   */
  const applyLink = useCallback(
    (url: string | null, text: string): void => {
      const selection = savedSelection.current
      editor.update(
        () => {
          // **A selection captured from a committed state is frozen.** Lexical freezes selections at
          // the end of every update, and `$setSelection` refuses a frozen one — so the parked copy is
          // cloned back into the update rather than handed over as it was read.
          if (selection !== null) $setSelection(selection.clone())
          if (url === null) return
          if ($readLink() === null) $insertLink(url, text)
          else $writeLink(url, text)
        },
        { discrete: true },
      )
      if (url === null) removeLink(editor)
      savedSelection.current = null
      setLinkOpen(false)
      setAnchor(null)
      editor.focus()
    },
    [editor],
  )

  return (
    <>
      {open && anchor !== null
        ? createPortal(
            <MenuSurface
              ref={panelRef}
              compact
              className={toolbar.panel}
              // Keep the editor's selection alive across every action click.
              onMouseDown={event => event.preventDefault()}
              style={{
                position: 'fixed',
                // Until the bar has been measured it is hidden rather than parked
                // somewhere visible: the first measurement cannot happen before the
                // element exists, and a bar that flashes in the wrong place before
                // settling reads as a bug.
                left: placed?.left ?? anchor.selection.left,
                top: placed?.top ?? anchor.selection.top,
                visibility: placed === null ? 'hidden' : undefined,
                display: 'flex',
                alignItems: 'center',
                gap: 2,
                padding: 4,
                zIndex: 40,
              }}
            >
              {BAR_BLOCKS.map(({ id, glyph, isActive }) => {
                /*
                 * The heading entry is a **way into** six operations rather than one
                 * of them, so it is the one branch here that does not come from
                 * `blockOperation`. Everything it offers still does.
                 */
                if (id === HEADING_ID) {
                  return (
                    <Menu
                      key={id}
                      open={headingOpen}
                      anchor={
                        <span ref={headingRef} style={{ display: 'inline-flex' }}>
                          {/*
                            No `Tooltip`, unlike every other action in this bar: the card
                            *is* this button's label, and a tooltip would race it for the
                            same hover and then sit on top of it. The accessible name is
                            kept, so nothing is lost to a screen reader.
                          */}
                          <Button
                            size="sm"
                            variant="ghost"
                            className={toolbar.toggle}
                            aria-label="标题"
                            aria-haspopup="menu"
                            aria-expanded={headingOpen}
                            aria-pressed={isActive(formats)}
                            // The three ways in, matching what the shell's own submenu
                            // rows answer to: pointer, keyboard focus, and a click.
                            onPointerEnter={() => setHeadingOpen(true)}
                            onFocus={() => setHeadingOpen(true)}
                            onClick={() => setHeadingOpen(current => !current)}
                          >
                            {glyph}
                          </Button>
                        </span>
                      }
                      items={HEADING_ITEMS}
                      // The level the selection is already on. Marked with the trailing
                      // check rather than the fill the slash menu uses: there the fill
                      // means "the row the keyboard is on", here it would mean "the
                      // level you are in", and a check says that without looking hovered.
                      selectedId={formats.heading === '' ? undefined : formats.heading}
                      selection="check"
                      // Preferred side first; the layout effect above corrects it before
                      // paint when the card does not fit there.
                      side={headingFit?.side ?? placed?.side ?? 'bottom'}
                      align={headingFit?.align ?? 'start'}
                      // Crossing the few pixels between button and card must not close
                      // it; the shell's grace covers the gap and a brief overshoot.
                      closeOnPointerLeave
                      onSelect={chosen => {
                        setHeadingOpen(false)
                        const operation = blockOperation(chosen)
                        if (operation !== undefined && operation.kind === 'block') {
                          setBlock(operation.create)
                        }
                      }}
                      onClose={() => setHeadingOpen(false)}
                    />
                  )
                }

                const operation = blockOperation(id)
                if (operation === undefined || operation.kind !== 'block') return null
                return (
                  <BarAction
                    key={id}
                    label={operation.label}
                    glyph={glyph}
                    active={isActive(formats)}
                    onSelect={() => setBlock(operation.create)}
                  />
                )
              })}

              {BAR_DIVIDER}

              {BAR_LISTS.map(({ id, glyph }) => {
                const operation = blockOperation(id)
                if (operation === undefined || operation.kind !== 'list') return null
                const on = formats.listKind === operation.listKind
                return (
                  <BarAction
                    key={id}
                    label={operation.label}
                    glyph={glyph}
                    active={on}
                    // This bar toggles. The slash menu inserts instead, because
                    // it is reached in an emptied block where "already a list"
                    // cannot be true.
                    onSelect={() =>
                      run(current =>
                        current.dispatchCommand(on ? operation.remove : operation.insert, undefined),
                      )
                    }
                  />
                )
              })}

              {/* Offered only in a list item: outside one, `INDENT_CONTENT_COMMAND` has nothing to
                  indent and its handler returns `false`, so two always-visible buttons would be two
                  buttons that silently do nothing. */}
              {nestable ? (
                <>
                  {BAR_DIVIDER}
                  {BAR_NESTING.map(({ id, glyph }) => {
                    const operation = blockOperation(id)
                    if (operation === undefined || operation.kind !== 'nest') return null
                    return (
                      <BarAction
                        key={id}
                        label={operation.label}
                        glyph={glyph}
                        active={false}
                        onSelect={() => run(current => applyBlockOperation(current, operation))}
                      />
                    )
                  })}
                </>
              ) : null}

              {BAR_DIVIDER}

              <BarAction label="粗体" glyph={<strong>B</strong>} active={formats.bold} onSelect={() => toggleInline('bold')} />
              <BarAction label="斜体" glyph={<em>I</em>} active={formats.italic} onSelect={() => toggleInline('italic')} />
              <BarAction label="删除线" glyph={<span style={{ textDecoration: 'line-through' }}>S</span>} active={formats.strike} onSelect={() => toggleInline('strikethrough')} />
              <BarAction label="行内代码" glyph={<IconCodeOutlineRegular size={16} />} active={formats.code} onSelect={() => toggleInline('code')} />
              <BarAction
                label="链接"
                glyph={<IconLinkOutlineRegular size={16} />}
                active={formats.link}
                // **Always the dialog.** While the selection is inside a link this used to remove it on
                // the spot, which hid the address from the reader and made "look at it" impossible;
                // removal is now the dialog's own 取消链接 button (see the footer below).
                onSelect={openLinkDialog}
              />
            </MenuSurface>,
            document.body,
          )
        : null}

      <LinkDialog
        open={linkOpen}
        seed={linkSeed}
        onSubmit={(url, text) => applyLink(url, text)}
        onRemove={() => applyLink(null, '')}
        onClose={() => setLinkOpen(false)}
      />
    </>
  )
}
