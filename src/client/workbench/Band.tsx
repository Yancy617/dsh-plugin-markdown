/**
 * 编辑带：正文（富文本或源码）、文档目录那一列、提示层与网页层，共用一块下部。
 *
 * 内容
 * - WorkbenchBandProps / WorkbenchBand。
 * - 本盒子自己的布局样式对象（lower / workspace / editorPane / outlinePanel / foldedToggle /
 *   webLayer / sourceArea）。
 *
 * 行为
 * - 源码与富文本二选一；富文本按 `path#revision` 重挂，并把文档会话的 `historyState` 交给
 *   `MarkdownEditor`；源码框按文档重挂，是**只读**的文件查看面（编辑在富文本里），并禁用浏览器原生撤销。
 * - 文档目录那一列按宽度折叠（变量由调用方给），分隔条可拖、可用方向键 / Home / End 调整。
 * - 提示层与网页层都盖在这一块上；网页层填满「编辑区 ＋ 目录」。
 * - 滚动的可见高度由 `--dsh-workspace-height` 发布（测量在调用方）。
 *
 * 边界
 * - 不拥有文档文本、不写盘、不测量滚动盒（attachWorkspace / workspaceHeight 由调用方给）。
 * - 不决定提示内容与网页开不开。
 *
 * 相关文件
 * - 依赖：MarkdownEditor、NoticeStack、WebTab、editor/outline 的 OutlineEntry、layout。
 * - 被依赖：MarkdownWorkbench.tsx。
 *
 * 改哪里
 * - 改下部几何：本文件的样式对象与 sidebar.module.css。
 * - 改编辑器的 props：MarkdownEditor.tsx。
 */
import type { LexicalEditor } from 'lexical'
import type { HistoryState } from '@lexical/history'
import type { AssetWriter } from '../editor/assetWriter'
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactElement, RefObject } from 'react'
import { useEffect, useRef } from 'react'
import {
  Button,
  IconPersonalizationOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { OutlineEntry } from '../editor/outline'
import type { SourceBase } from '../editor/saveBase'
import { MarkdownEditor } from '../editor/MarkdownEditor'
import { EditorBoundary } from '../editor/EditorBoundary'
import type { OpenWebPage } from '../webPage'
import { NoticeStack, type NoticeItem } from '../NoticeStack'
import { WebTabView } from '../WebTab'
import { clampOutline, outlineCeiling, OUTLINE_DEFAULT, OUTLINE_MIN } from '../layout'
import type { WebTabState } from './model'
import styles from '../sidebar.module.css'

/** 下部: the editor and the outline, side by side inside the panel's lower band. */
/**
 * The lower band: the editor and the outline sharing one document, and the positioning context for
 * the folded outline's control.
 *
 * The heading's top padding is stated once, here, because the heading and the folded control both
 * sit that far down and must land on the same pixel in both states — two literals would be two
 * numbers that have to be kept equal by hand.
 */
const lower: CSSProperties = {
  position: 'relative',
  display: 'flex',
  flex: 1,
  minHeight: 0,
  ['--dsh-outline-head-pad']: '10px',
  // Declared here rather than on the outline, because two things read it and only one of them is
  // inside the outline: the heading's own rows, and the control that replaces the heading when the
  // column is folded. On the outline alone, the folded control could not see the value it has to match.
  ['--dsh-outline-inset']: '8px',
} as CSSProperties

/**
 * The folded outline's control, where the heading's own control sits when the column is open.
 * It clears the scrollbar, which owns the outer few pixels of the band.
 */
const foldedToggle: CSSProperties = {
  position: 'absolute',
  top: 'var(--dsh-outline-head-pad)',
  // What the heading's own control is inset by, added to what the scrollbar takes. The heading's
  // control clears its row's inline padding; this one is not in a row, so it clears that padding and
  // the scrollbar both. Previously it cleared only the scrollbar, which is why the two sat 8px apart.
  right: 'calc(var(--dsh-scrollbar-width) + var(--dsh-outline-inset))',
}

const workspace: CSSProperties = {
  display: 'flex',
  flex: 1,
  minHeight: 0,
  // The wrapper scrolls, and that is the whole of this change. A scrollbar belongs to its scroll
  // container, and the editor's container sits to the left of the outline — so its right edge is the
  // outline's left edge, and the bar could not be anywhere else. Scrolling here puts it at the
  // wrapper's right edge, which is the panel's.
  //
  // The editor and the outline are still two siblings in normal flow. That was never the problem.
  //
  // Always scrolled, never conditional. `auto` would bring the scrollbar when the document is tall
  // enough, and tall enough depends on how wide the editor is, which depends on whether the outline
  // is open — so the bar would come and go with the outline and everything placed against this edge
  // would move with it. The quiet rules keep it invisible until the region is hovered, so nothing is
  // gained by letting it disappear; its width is the thing that has to stay put.
  overflowY: 'scroll',
}

/**
 * 一个网页标签铺在哪：**编辑区 ＋「文档目录」整块**（`lower` 是定位祖先）。
 *
 * 这是"两种互斥状态"里的网页那一种：除了**标签栏**（`lower` 的兄弟、在上一行）与**左侧栏**
 * （文件树，面板的第一列)之外，剩下的地方全是网页 —— 文档工具条由 `WorkbenchToolbar` 的
 * `hidden` 整条收起。不透明，因为它是**替代**而不是叠加：底下的文档还在、状态也不动，只是这
 * 一刻用户在看网页。
 */
const webLayer: CSSProperties = {
  position: 'absolute',
  inset: 0,
  display: 'flex',
  zIndex: 2,
  background: 'var(--dsw-alias-bg-base, #fff)',
}

/** 下部-左. The editor gives up width to the outline only within this band. */
const editorPane: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  flex: 1,
  minWidth: 0,
  minHeight: 0,
  /*
   * **Deliberately not positioned**, and worth saying out loud because it carried
   * `position: relative` for a round: this box sits *inside* the element that scrolls, so anything
   * absolutely positioned against it gets two answers wrong at once — its width is measured below
   * the outline column instead of beside it, and `top: 0` is the top of the document, which scrolls
   * away. That is exactly what happened to the notice layer (§6.144). Nothing in here needs it: the
   * web layer floats on the band, the placeholder is positioned against `.md-root`, and the notice
   * layer is rendered on the band.
   */
  // The editor's inset, declared here rather than on `.md-root`, because three readers want it and
  // only one of them is inside the editor: the rich view's padding and its placeholder, and the
  // source view's textarea, which is a sibling of the editor rather than a descendant.
  ['--dsh-editor-pad-x']: '50px',
  ['--dsh-editor-pad-y']: '24px',
} as CSSProperties

/**
 * 下部-右. The outline, inside the lower band rather than beside the whole panel —
 * so the tab strip and the toolbar above it reach the panel's full width.
 */
const outlinePanel: CSSProperties = {
  // The width this panel is given is a `flex-basis`, and `flex-basis` sizes the same box `width`
  // does — the content box, by default. With `padding: 10px 8px` that made a declared 260 render as
  // 276.5: 16px of padding and a half-pixel border on top.
  //
  // The left sidebar's 260 is a grid track, and a track sizes the item's *border* box. So both
  // panels said 260 and drew 16.5px apart, with no arithmetic anywhere able to notice. This makes
  // the declared width the total, which is what the track already meant.
  boxSizing: 'border-box',
  // Hidden, not removed: these are still two boxes and this is the line between them. With the bar
  // now outside both of them and nothing else separating them, they read as one surface.
  borderLeft: 'none',
  // No padding. A container with any hands its scroll region an inset it did not ask for, and the
  // scrollbar then stops short of the line. The padding lives on the rows — the one place it cannot
  // move anything else. `border-box` stays so the width this box is given is the width it draws.
  //
  // `relative`, so the handle is positioned against this box's edge instead of being a sibling
  // that has to be nudged into place and lifted so it can still be clicked.
  // Sticky, replacing relative rather than joining it: sticky is itself a positioned element, so it
  // is still the containing block the handle is placed against. The outline now lives inside the
  // element that scrolls, and without this it would scroll away with the document.
  position: 'sticky',
  top: 0,
  // align-self, not a row-wide align-items: flex-start. The editor must still stretch to fill the
  // pane — that is what keeps the space below the last line clickable — so only this item opts out.
  alignSelf: 'flex-start',
  // Bounded by the visible area. Beyond letting this panel scroll its own body, this is what keeps
  // the page scrollbar honest: an outline free to grow past the pane would lengthen the scrollable
  // area, and the bar would stop corresponding to the document.
  maxHeight: 'var(--dsh-workspace-height, 100vh)',
  display: 'flex',
  flexDirection: 'column',
  minWidth: 0,
  minHeight: 0,
  // No `overflowY` here any more: the heading below is a child of this box, and anything
  // this box scrolls takes the heading with it. The rows scroll in their own element.
}

/** Raw Markdown editing surface: the whole file, exactly as it will be saved. */
const sourceArea: CSSProperties = {
  flex: 1,
  minHeight: 0,
  margin: 0,
  border: 'none',
  outline: 'none',
  resize: 'none',
  // The same inset the rich view uses, and the same variables, so the two cannot drift.
  padding: 'var(--dsh-editor-pad-y) var(--dsh-editor-pad-x) 45vh',
  fontFamily: 'var(--ds-font-family-code)',
  fontSize: 13,
  lineHeight: 1.7,
  background: 'transparent',
  color: 'inherit',
  overflow: 'auto',
}

/** The row holding the line-number gutter and the read-only code field. */
const sourceRow: CSSProperties = {
  display: 'flex',
  flex: 1,
  minHeight: 0,
}

/** Line numbers: same font metrics as the code, no scrolling of its own. */
const sourceGutter: CSSProperties = {
  flex: 'none',
  margin: 0,
  padding: 'var(--dsh-editor-pad-y) 8px 45vh 12px',
  fontFamily: 'var(--ds-font-family-code)',
  fontSize: 13,
  lineHeight: 1.7,
  textAlign: 'right',
  color: 'var(--dsh-color-text-tertiary, inherit)',
  overflow: 'hidden',
  userSelect: 'none',
}

/** What the band draws and reports. */
export interface WorkbenchBandProps {
  /** The outline column is open. */
  readonly outlineOpen: boolean
  /** The rendered outline width. */
  readonly outlineWidth: number
  /** The band's measured width, used as the drag ceiling. */
  readonly workspaceWidth: number
  /** The band's measured height, published as a custom property. */
  readonly workspaceHeight: number | null
  /** Attaches the scrolling wrapper; the caller measures it. */
  readonly attachWorkspace: (node: HTMLDivElement | null) => void
  onToggleOutline(): void
  onOutlineDragStart(event: ReactPointerEvent<HTMLDivElement>): void
  onOutlineResize(width: number): void
  /** The editor pane saw a paste (writes at once). */
  onPaste(): void
  /** The caret left the editing surface (writes at once). */
  onBlur(): void
  /** The source view is showing. */
  readonly sourceMode: boolean
  /** The disk text, shown read-only by the source view. */
  readonly saved: string
  /** The source mirror the editor patches; the source view never edits it. */
  readonly source: string
  /** The source textarea, shared with the caller's scroll effects. */
  readonly sourceRef: RefObject<HTMLTextAreaElement>
  onSourceScroll(top: number): void
  /** The document refuses edits. */
  readonly readOnly: boolean
  /** The showing document's path. */
  readonly path: string
  /** Whether the document came out of this package. */
  readonly sample: boolean
  /** The remount counter for the composer. */
  readonly revision: number
  /** The document's undo/redo history, owned by the open-document session. */
  readonly historyState: HistoryState
  /** The block-level save baseline, owned by the open-document session. */
  readonly sourceBase: SourceBase
  /** Authorized root, for the editor's pictures. */
  readonly vaultRoot: string | null
  /** How this panel stores a picture; `null` when there is no writer. */
  readonly writeAsset: AssetWriter | null
  /** The editor's text after an edit (full file, frontmatter included). */
  onEditorChange(markdown: string): void
  onEditorReady(editor: LexicalEditor): void
  onEditorGone(editor: LexicalEditor): void
  onEditorNotice(message: string): void
  /** How long the rich editor's import took, in milliseconds (reported once after mount). */
  onEditorImportMs(ms: number): void
  /** The rich editor could not render; ask for the source view. */
  onShowSource(): void
  /** How the editor opens an external link. */
  readonly openWebPage: OpenWebPage
  /** The document's headings. */
  readonly outline: readonly OutlineEntry[]
  /** The outline was deliberately not parsed because the document is large. */
  readonly outlineDeferred: boolean
  /** Parse the outline once, on request. */
  onParseOutline(): void
  /** Row number of the heading being read, or `-1`. */
  readonly activeOutlineIndex: number
  onOutlineClick(index: number): void
  /** The notice layer's items. */
  readonly notices: readonly NoticeItem[]
  /** The web tab in front, if any. */
  readonly webTab: WebTabState | null
  onWebTitle(title: string): void
}

/**
 * The lower band: the document, its outline, and the two layers over them.
 * @param props - the document, the outline state, and the band's measurements.
 * @returns the band.
 */
export function WorkbenchBand(props: WorkbenchBandProps): ReactElement {
  const outlineBodyRef = useRef<HTMLDivElement | null>(null)
  const sourceGutterRef = useRef<HTMLPreElement | null>(null)
  // The source view is a code reader: a trailing newline is a real empty last line, and an empty
  // file still shows line 1 (the caret-less blank line every code viewer shows).
  const lineCount = props.saved === '' ? 1 : props.saved.split('\n').length
  const gutter = Array.from({ length: lineCount }, (_, index) => String(index + 1)).join('\n')

  /**
   * Keep the current row inside the column.
   *
   * The column shows as many headings as fit and scrolls the rest without a bar. A highlight that
   * scrolls out of view is a highlight nobody sees — so when the active row leaves the visible band,
   * move the column by exactly the overshoot (`nearest`), never centring and never animating: the
   * reader is reading the document, and a second thing sliding around takes the eyes away.
   */
  useEffect(() => {
    const body = outlineBodyRef.current
    if (body === null || props.activeOutlineIndex < 0) return
    const row = body.querySelector<HTMLElement>('[aria-current="location"]')
    if (row === null) return
    const bodyRect = body.getBoundingClientRect()
    const rowRect = row.getBoundingClientRect()
    if (rowRect.top < bodyRect.top) body.scrollTop -= bodyRect.top - rowRect.top
    else if (rowRect.bottom > bodyRect.bottom) body.scrollTop += rowRect.bottom - bodyRect.bottom
  }, [props.activeOutlineIndex])

  return (
    <div
      style={
        {
          ...lower,
          /*
           * Two readers need it and only one is the column: the column's own `flex-basis`,
           * and the notice layer's right inset — a notice covers the document, not the
           * outline, so it has to stop where the outline starts.
           *
           * One declaration on the common ancestor, inherited by both readers, keeps them
           * from drifting into two numbers that happen to agree today.
           */
          '--dsh-outline-width': props.outlineOpen ? `${String(props.outlineWidth)}px` : '0px',
        } as CSSProperties
      }
    >
      <div
        ref={props.attachWorkspace}
        className={styles.workspace}
        style={
          props.workspaceHeight === null
            ? workspace
            : ({
                ...workspace,
                '--dsh-workspace-height': `${String(props.workspaceHeight)}px`,
              } as CSSProperties)
        }
      >
        <div
          style={editorPane}
          /**
           * A paste is noticed on the **DOM event**, not by guessing from the text: a paste and a
           * normalisation both arrive as "the editor exported something", and the difference that
           * matters here is that one of them was the writer's deliberate act. The event fires
           * before the editor's own update, so the mark is already in place when the export
           * schedules its write (see the timer).
           *
           * It covers both views: the rich composer and the source `<textarea>` bubble `paste`
           * through this element.
           */
          onPaste={() => props.onPaste()}
          /**
           * The caret leaving the editing surface — clicking the tree, the tab strip, the find box,
           * the chat box, or anywhere outside the panel. "No caret in the document" is the writer's
           * own definition of having left the editing state, so this writes at once.
           *
           * The bump is what makes it *at once*: without a re-render nothing would ask the
           * scheduling rules again, and the armed idle timer would quietly write two seconds later.
           * (The formatting toolbar keeps the selection alive by cancelling `mousedown`, so clicking
           * a format button is not a departure and does not land here.)
           */
          onBlur={() => props.onBlur()}
        >
          {props.sourceMode ? (
            <div style={sourceRow}>
              <pre ref={sourceGutterRef} aria-hidden="true" style={sourceGutter}>{gutter}</pre>
              <textarea
                /*
                  One element per document. The source view is a plain `<textarea>`, so the browser
                  keeps its own native undo stack on the element; reusing the element across a tab
                  switch could let one document's undo history surface in another. Remounting is the
                  simple structural answer, and the source view has no document-level undo anyway.
                */
                key={props.path}
                ref={props.sourceRef}
                value={props.saved}
                onScroll={event => {
                  const top = event.currentTarget.scrollTop
                  if (sourceGutterRef.current !== null) sourceGutterRef.current.scrollTop = top
                  props.onSourceScroll(top)
                }}
                /**
                 * 源码不参与撤销。The textarea would otherwise offer the browser's native undo,
                 * which is not this document's history and is exactly the cross-document path this
                 * view must not have. Physical `code` is used so a non-English layout cannot slip
                 * Ctrl/Cmd+Z through.
                 */
                onKeyDown={event => {
                  if (!(event.ctrlKey || event.metaKey) || event.altKey) return
                  if (event.code === 'KeyZ' || event.code === 'KeyY') event.preventDefault()
                }}
                onBeforeInput={event => {
                  const inputType = (event.nativeEvent as InputEvent).inputType
                  if (inputType === 'historyUndo' || inputType === 'historyRedo') {
                    event.preventDefault()
                  }
                }}
                spellCheck={false}
                aria-label="Markdown 源码"
                /*
                  **Read-only by design, not because this document refuses edits.** The source
                  view is the file's viewing face: it shows the disk text byte for byte, while
                  every edit happens in the rich editor and goes through the block-level save.
                  `readOnly` rather than `disabled`: a disabled field cannot be selected, and
                  copying the text out of one is exactly what this view is for.
                */
                readOnly
                style={sourceArea}
              />
            </div>
          ) : (
            /*
             * The rich editor can throw while it is being built — importing a whole document is
             * render-time work. The boundary turns that into a card with a way out instead of
             * letting the panel go blank; it is keyed with the composer so switching documents
             * (or reloading) starts from a clean failure state.
             */
            <EditorBoundary
              key={`${props.path}#${String(props.revision)}`}
              onShowSource={props.onShowSource}
            >
              <MarkdownEditor
                key={`${props.path}#${String(props.revision)}`}
                docKey={`${props.path}#${String(props.revision)}`}
                initialMarkdown={props.source}
                sourceBase={props.sourceBase}
                historyState={props.historyState}
                documentPath={props.path}
                vaultRoot={props.vaultRoot}
                writeAsset={props.writeAsset}
                // The document's own fact, not the vault's: a sample opened beside the writer's
                // files has its pictures inside this package, which is what `bundled` means.
                bundled={props.sample}
                readOnly={props.readOnly}
                onChange={markdown => props.onEditorChange(markdown)}
                onReady={next => props.onEditorReady(next)}
                onGone={gone => props.onEditorGone(gone)}
                onNotice={message => props.onEditorNotice(message)}
                onImportMs={ms => props.onEditorImportMs(ms)}
                openWebPage={props.openWebPage}
              />
            </EditorBoundary>
          )}
        </div>

        <aside
          className={styles.outlineColumn}
          style={props.sourceMode ? { ...outlinePanel, display: 'none' } : outlinePanel}
          aria-label="文档目录"
        >
          {/*
            The divider, and the only control the outline's width has.

            A focusable `separator` is the platform's own splitter pattern: it carries the value and
            its bounds, and the arrow keys move it. `ArrowLeft` widens, because the outline is
            anchored to the panel's right edge.
          */}
          <div
            className={styles.outlineHandle}
            role="separator"
            aria-orientation="vertical"
            aria-label="调整文档目录宽度"
            aria-valuenow={props.outlineWidth}
            aria-valuemin={OUTLINE_MIN}
            aria-valuemax={outlineCeiling(props.workspaceWidth)}
            tabIndex={0}
            onPointerDown={props.onOutlineDragStart}
            onDoubleClick={() => props.onOutlineResize(OUTLINE_DEFAULT)}
            onKeyDown={event => {
              const step = event.shiftKey ? 40 : 8
              if (event.key === 'ArrowLeft') {
                event.preventDefault()
                props.onOutlineResize(
                  clampOutline(props.outlineWidth + step, props.workspaceWidth),
                )
              } else if (event.key === 'ArrowRight') {
                event.preventDefault()
                props.onOutlineResize(
                  clampOutline(props.outlineWidth - step, props.workspaceWidth),
                )
              } else if (event.key === 'Home') {
                event.preventDefault()
                props.onOutlineResize(OUTLINE_MIN)
              } else if (event.key === 'End') {
                event.preventDefault()
                props.onOutlineResize(
                  outlineCeiling(props.workspaceWidth),
                )
              }
            }}
          />
          <div className={styles.outlineHead}>
            {/* The row owns the inset; the text carries none of its own. `styles.label` is the
                sidebar's kind of heading and states its own padding, which would double this row's
                and move the control off the pixel the folded state places it on. */}
            <span className={styles.outlineHeadText}>文档目录</span>
            <Button
              className={styles.iconButton}
              size="sm"
              variant="ghost"
              icon={<IconPersonalizationOutlineRegular size={16} />}
              aria-label="收起文档目录"
              title="收起文档目录"
              onClick={() => props.onToggleOutline()}
            />
          </div>
          <div className={styles.outlineBody} ref={outlineBodyRef}>
            {props.outlineDeferred ? (
              /*
               * A large document in the source view: parsing every pause cost 2.7–5.5s at 8MB, so
               * the outline waits to be asked for. The one click parses the document once.
               */
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'flex-start',
                  gap: 6,
                  padding: '6px 8px',
                  fontSize: 12,
                  lineHeight: 1.6,
                  opacity: 0.7,
                }}
              >
                <span>这篇较大，暂不解析目录。</span>
                <Button size="sm" variant="ghost" onClick={props.onParseOutline}>
                  解析目录
                </Button>
              </div>
            ) : props.outline.length === 0 ? (
              <div style={{ padding: '4px 8px', opacity: 0.45, fontSize: 12 }}>（无标题）</div>
            ) : (
              props.outline.map((entry, index) => {
                const active = index === props.activeOutlineIndex
                return (
                <Button
                  key={`${String(index)}:${entry.text}`}
                  size="sm"
                  variant="ghost"
                  onClick={() => props.onOutlineClick(index)}
                  className={`${styles.outlineRow}${active ? ` ${styles.outlineRowActive}` : ''}`}
                  /*
                   * The row the reader is in. `location` rather than `page`: the value says "you are
                   * here in this list", which is exactly what the blue means — a screen reader gets
                   * the same fact the colour carries.
                   */
                  aria-current={active ? 'location' : undefined}
                  style={{
                    // The step is this row's own; where the column starts is not. The first level
                    // therefore lands exactly under the grey heading, and the deeper ones keep their
                    // distance from it.
                    paddingLeft: `calc(var(--dsh-outline-inset) + ${String((entry.level - 1) * 12)}px)`,
                    paddingRight: 8,
                    justifyContent: 'flex-start',
                    textAlign: 'left',
                    width: '100%',
                    // The current row is at full strength: the per-level fade would wash the blue out.
                    opacity: active || entry.level === 1 ? 1 : 0.78,
                  }}
                >
                  {/* Its own element: a `Button` is a flex container, so text placed directly inside
                  one becomes an anonymous flex item and `text-overflow` cannot apply. */}
                  <span className={styles.outlineLabel}>
                    {entry.text === '' ? '（空标题）' : entry.text}
                  </span>
                </Button>
                )
              })
            )}
          </div>
        </aside>
      </div>

      {/*
        The notices float over the document instead of sitting above it in the flow, so a paste
        landing or a file turning out to carry frontmatter no longer moves the first lines of text.

        **On the band, not inside the editor pane**, and that is part of the rule rather than a
        detail of the tree. The band is the nearest positioned ancestor and the box that scrolls
        sits between the two — which is what makes `top: 0` mean "the top of what is visible"
        instead of "the top of the document", and what makes the layer's right edge measurable
        against the outline column (inside the pane it was measured against the pane, so the
        outline's width came off twice: §6.144). Everything about *which* notices exist is decided
        here; everything about how one looks and where the layer sits is `./NoticeStack`.
      */}
      <NoticeStack items={props.notices} />

      {/*
        The folded outline still needs its control. It sits against the lower band rather than
        against the panel — whose top is above the toolbar — or inside the scroller, whose children
        scroll away. Its offset and the heading's padding are the same value, so the control lands
        on one pixel whether the column is open or folded.
      */}
      {/*
        Always mounted, faded rather than removed. A control that is not rendered cannot fade, and
        the two would otherwise swap in one frame — which is what the reader would see as the jump
        the animation is meant to remove.
      */}
      <Button
        className={`${styles.iconButton} ${styles.foldedToggle}`}
        data-shown={props.outlineOpen ? 'false' : 'true'}
        size="sm"
        variant="ghost"
        icon={<IconPersonalizationOutlineRegular size={16} />}
        aria-label="展开文档目录"
        title="展开文档目录"
        onClick={() => props.onToggleOutline()}
        style={foldedToggle}
      />
      {/*
        网页状态：这一层把**编辑区与「文档目录」整块**盖住（`lower` 是定位祖先），于是这一刻
        屏幕上只剩「标签栏 ＋ 左侧栏（文件树）＋ 这一格的说明与按钮」—— 与文档状态互斥
        （工具条由 WorkbenchToolbar 的 `hidden` 整条收起）。

        自研浏览器载体已按用户决定**整个砍掉**（§6.137：网页一直闪、鼠标点不动，两轮排查未解），
        正文只剩「地址 ＋ 用系统浏览器打开」。
      */}
      {props.webTab === null ? null : (
        <div style={webLayer}>
          <WebTabView
            url={props.webTab.url}
            storageKey={props.vaultRoot ?? ''}
            onTitle={title => props.onWebTitle(title)}
          />
        </div>
      )}
    </div>
  )
}
