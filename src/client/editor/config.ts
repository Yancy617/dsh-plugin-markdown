/**
 * 编辑器装配：节点白名单、主题与样式。
 *
 * 内容
 * - EDITOR_NODES：编辑器可构造的节点类。
 * - EDITOR_THEME / EDITOR_CSS / ensureEditorStyles：主题与样式注入。
 *
 * 行为
 * - 节点白名单只收 Markdown 能表达的语义节点；没有“转换器表”这一层。
 * - 读写交给 mdast：mdastLower.ts（读）、mdastLift.ts（写）、blockSave.ts（块级保存）。
 * - 代码节点来自 @lexical/code-core，不引 @lexical/code 与 prismjs。
 * - 样式表通过 ensureEditorStyles 注入一次。
 *
 * 边界
 * - 不含任何构造的读写实现。
 * - 不负责 frontmatter（frontmatter.ts）与文档级开关（documentMarkdown.ts）。
 *
 * 相关文件
 * - 被依赖：MarkdownEditor.tsx、mdastLower.ts、mdastLift.ts。
 * - 依赖：RuleNode / image / rawBlocks / rawInline / definitions。
 *
 * 改哪里
 * - 新增节点：EDITOR_NODES + 对应 lower / lift 分支。
 * - 改主题 / 样式：EDITOR_THEME / EDITOR_CSS。
 */
import { CodeHighlightNode, CodeNode } from '@lexical/code-core'
import { LinkNode } from '@lexical/link'
import { ListItemNode, ListNode } from '@lexical/list'
import { HeadingNode, QuoteNode } from '@lexical/rich-text'
import { TableCellNode, TableNode, TableRowNode } from '@lexical/table'
import type { EditorThemeClasses, Klass, LexicalNode } from 'lexical'
import { RuleNode } from './RuleNode'
import { ImageNode } from './image'
import { RawBlockNode } from './rawBlocks'
import { RawInlineNode } from './rawInline'
import { DEFINITION_NODE } from './definitions'
import { MdBlockBreakNode } from './blockBreak'
import { SourceBlockNode } from './sourceBlock'

/** Node classes the editor may construct. No Markdown transformer table lives here any more. */
export const EDITOR_NODES: ReadonlyArray<Klass<LexicalNode>> = [
  HeadingNode,
  QuoteNode,
  ListNode,
  ListItemNode,
  CodeNode,
  CodeHighlightNode,
  LinkNode,
  RuleNode,
  ImageNode,
  RawBlockNode,
  RawInlineNode,
  TableNode,
  TableRowNode,
  TableCellNode,
  // 链接定义的载体：不可见、块级，保住定义那一行的原文直到它被改。
  DEFINITION_NODE,
  // 块间分隔：只存在于模型里，阻止相邻同类列表被 Lexical 合并；不写文件。
  MdBlockBreakNode,
  // 可编辑的普通文本 source 块：不能无损建模的构造按源文本显示，仍然可编辑。
  SourceBlockNode,
]
/** Class names the stylesheet below targets. */
export const EDITOR_THEME: EditorThemeClasses = {
  paragraph: 'md-p',
  heading: {
    h1: 'md-h1',
    h2: 'md-h2',
    h3: 'md-h3',
    h4: 'md-h4',
    h5: 'md-h5',
    h6: 'md-h6',
  },
  quote: 'md-quote',
  list: {
    ul: 'md-ul',
    ol: 'md-ol',
    listitem: 'md-li',
    listitemChecked: 'md-li-checked',
    listitemUnchecked: 'md-li-unchecked',
    nested: { listitem: 'md-li-nested' },
  },
  link: 'md-link',
  text: {
    bold: 'md-bold',
    italic: 'md-italic',
    strikethrough: 'md-strike',
    code: 'md-inline-code',
  },
  /**
   * NOT `md-code-block`. The official `CodeBlock` attaches that exact literal
   * to its own wrapper (`dsh-client-ui-primitives/lib/index.js`, in the `clsx`
   * beside `css$31.block`), and this stylesheet is injected into `document.head`
   * with no scope — so a class of the same name restyled every code block the
   * product renders, in the conversation, the trajectory view and the document
   * preview alike. One class name, two owners.
   *
   * `md-table-wide` is the other literal the official markdown renderer owns;
   * nothing here declares it.
   */
  code: 'md-editor-code',
  hr: 'md-rule',
  hrSelected: 'md-rule-selected',
  table: 'md-table',
  tableCell: 'md-cell',
  tableCellHeader: 'md-cell-head',
  tableRow: 'md-row',
  tableSelection: 'md-cell-selected',
  codeHighlight: {},
}

/**
 * 点目录之后落点闪一下的那个类名与时长。
 *
 * 两样东西共用一个出处：`headingFlash.ts` 拿它们挂类、比对 `animationName`、决定清理的超时；
 * 下面的 `EDITOR_CSS` 拿它们写 `animation` 与 `@keyframes` 的名字。分成两处写，就会有一天
 * 样式改了名、代码还挂着旧类 —— 表现是"点了没反应"，而两处都看不出来。
 *
 * 时长 900ms 是方案里定的（短到不打断阅读，长到能看见）。
 */
export const EDITOR_FLASH = 'md-flash'
export const EDITOR_FLASH_MS = 900

/**
 * 单元格对齐写在 DOM 上的属性名。
 *
 * 对齐是 GFM 的渲染信息，编辑器里也必须看得见：`./tableAlign.ts` 每次更新把
 * `tableAlignmentsState` 按列写到格子上，下面的样式表按这个属性选边。两处必须同名，
 * 所以只声明一次（理由与 `EDITOR_FLASH` 相同：分两处写，改名那天就是"菜单点了没反应"）。
 */
export const TABLE_ALIGN_ATTRIBUTE = 'data-md-align'

/**
 * 图片“被选中”写在 DOM 上的属性名。
 *
 * `./imageSelection.ts` 每次选区变化把当前选中的图片标在这个属性上，下面的样式表画蓝色描边。
 * 它只属于显示：不进节点状态、不进剪贴板、不进保存基线 —— 所以属性名只有这一处声明。
 */
export const IMAGE_SELECTED_ATTRIBUTE = 'data-md-image-selected'

/**
 * The editor's own stylesheet, injected once per page.
 *
 * Component styles live in `*.module.css` and are compiled into the bundle by the build; this
 * string is the editor's global sheet (theme classes, code chrome, table borders) and is
 * installed by {@link ensureEditorStyles}.
 */
export const EDITOR_CSS = `
/* No height and no overflow: what scrolls is now the wrapper above both panels, and a box that
   scrolled here would be a second scrollbar inside the first. The relative positioning stays,
   because the floating toolbar and the slash menu are positioned against it. */
/* The editor's own root. The inset lives on the pane, because the source
   view reads it too and the source view is not inside this element. */
.md-root { position: relative; }
/* The minimum is the visible area rather than a percentage. A percentage resolved against an
   auto-height parent, and that parent no longer has a height to give — the box grows to its content
   now. Same job, with a value that exists. */
/* The inset is read, not written: the placeholder is positioned by the same two values. */
.md-editable { outline: none; min-height: var(--dsh-workspace-height, 100vh); padding: var(--dsh-editor-pad-y) var(--dsh-editor-pad-x) 45vh; line-height: 1.75; }
/* Read from the same pair the content pads itself by. */
.md-placeholder { position: absolute; top: var(--dsh-editor-pad-y); left: var(--dsh-editor-pad-x); pointer-events: none; opacity: .4; }
.md-p { margin: 0 0 .75em; }
/* Headings and the quote take their values from the official markdown sheet,
   'dsh-client-ui-primitives/lib/markdown/MarkdownText.module.css', read out of 'app.asar'. The
   tokens behind them live in 'dsh-client-ui-theme/lib/client.js'; the values below are that sheet's
   own 'font:'/'margin:' declarations, not a re-invention of them.

   **H1–H4 were ours** until a reader reported H6 as grey. Aligning only H6 would have left the six
   levels drawn from two different sources, so the whole set moved to the official ones: sizes come
   out as 21/19/18/14px, then 'base-strong' (600/14px) for H5–H6. The grey was '.md-h6''s own
   'opacity: .8' — the official sheet carries no opacity there, and 'label-primary' is the colour
   the rest of the document uses. */
.md-h1 { font: var(--dsw-font-markdown-h1); margin: 32px 0 16px; }
.md-h2 { font: var(--dsw-font-markdown-h2); margin: 32px 0 16px; }
.md-h3 { font: var(--dsw-font-markdown-h3); margin: 32px 0 16px; }
.md-h4 { font: var(--dsw-font-markdown-h4); margin: 16px 0; }
.md-h5, .md-h6 { font: var(--dsw-font-markdown-base-strong); margin: 16px 0; }
/* 点目录之后落点的回执：整行标题铺一层「当前行」蓝，900ms 淡掉，只播一次。
   颜色是**产品自己的 token**（目录当前行、文件树展开图标用的是同一颗），16% 只当底纹 ——
   再浓像文本选区，再淡在深色主题下看不见。只改颜色，不动布局，所以标题文字一个像素都不移。
   类名与时长从 EDITOR_FLASH / EDITOR_FLASH_MS 来：headingFlash.ts 按下同一个名字挂类、比对
   animationName，两处写成两个字的那天就是"点了没反应"。 */
.md-flash { animation: ${EDITOR_FLASH} ${String(EDITOR_FLASH_MS)}ms ease-out; border-radius: 6px; }
@keyframes ${EDITOR_FLASH} {
  from { background-color: color-mix(in srgb, var(--dsw-alias-button-info-fill) 16%, transparent); }
  to { background-color: transparent; }
}
/* 不想要动效的人：颜色提示留着，渐变压到 120ms。 */
@media (prefers-reduced-motion: reduce) {
  .md-flash { animation-duration: 120ms; }
}
/* Official 'blockquote': 2px, 'label-caption' (a grey — measured '--dsw-static-neutral-bluish-400'),
   'padding-left: 14px', and **no opacity**. Ours was '3px solid currentColor' plus 'opacity: .78',
   which is why the line read as both too thick and too long: the opacity dimmed the whole block,
   and 'currentColor' made the rule as dark as the text instead of grey. */
.md-quote { margin: 16px 0 0; padding-left: 14px; border-left: 2px solid var(--dsw-alias-label-caption); }
.md-ul, .md-ol { margin: 1em 0; padding-left: 1.5em; }
/* Item spacing, to the official 'li:not(:first-child) { margin-top: 6px }' plus the body's line. A
   nested list under an item gets the official '+4px' rather than the full block gap, so a nested
   level reads as part of its parent item instead of as a new block. */
.md-li { margin: .18em 0; }
.md-li > .md-ul, .md-li > .md-ol { margin-top: .28em; }
/* **A list item holding nothing but a nested list draws no marker (§6.161).**
   
   That shape is what Enter-then-Tab leaves behind: the item the caret moved out of keeps a nested 'ul' as
   its only child, so it has no inline content and therefore **no line box of its own**. A marker is placed
   on its list item's first line box — with none, the marker floated up onto the nested list's own line,
   which is why a reader saw a hollow circle and a square **side by side**.
   
   Measured, because the earlier attempts at this were changes a stylesheet had not actually made. Rendered
   in Chromium with this sheet, on the exact DOM from the reader's own readout:
   
       before:  item 2 (empty wrapper) list-style-type=circle top=118   item 3 (empty) square top=118
       after:   item 2                 list-style-type=none   top=128   item 3         square top=128
   
   The two rows separate and the spurious circle is gone. The selector is ':has()' — supported by the
   Chromium this ships against, verified on the rendering machine (':has(> ul)' answers true for the
   wrapper) — and it reads "has no child that is not a list", so an item holding a paragraph, a line break
   or any inline content keeps its marker. */
.md-li:not(:has(> :not(ul):not(ol))) { list-style: none; }
/* **The marker gets a colour and nothing else — and that is the fix for a stale-marker artifact (§6.160).**
   A reader described it exactly: press Enter inside a nested item and a circle appears on the new line,
   then press Tab and the **circle stays where it was while a square appears at the new depth** — two
   markers on one line, until the panel is switched away and back. A pair a repaint clears is a **paint**
   defect, and list markers are a known shallow spot for it: Blink carries a dedicated repaint test for
   them ('fast/repaint/list-marker.html'), which is why a marker is repainted separately from its line and
   can survive a re-parent.
   This sheet made that worse in two ways, both now removed:
     - 'line-height: 24px' on '::marker' (copied from the official sheet) takes the marker **out of the
       host line box** so it paints on its own;
     - 'list-style-type' per nesting level made the glyph a function of the item's **current depth**, so
       re-parenting an item changed what had to be painted at a position already painted.
   The official sheet does neither — it sets the marker's colour and lets the UA pick disc/circle/square.
   That is the baseline this now matches. What remains here is the colour — a layout fact rather than a
   paint-time choice. */
.md-ul > .md-li::marker, .md-ol > .md-li::marker { color: var(--dsw-alias-label-secondary); }
/* **No rule for a nested item at all — that is the baseline, and it is deliberate (§6.160).**
   
   This class has now carried two wrong rules and one harmless one:
     - '.md-li-nested { list-style: none }' — a reader reported the first level missing its dot. That was
       the real defect, and removing it is what fixes it;
     - 'list-style-position: inside' — put the marker **in the content box**, so every nested item's text
       shifted right by the marker's width and a level read as indented one step too far;
     - 'list-style-position: outside' — restored the default and read as correct, but it is still this
       sheet deciding where a marker goes, and the marker is painted separately from its line (see the
       note above). A reader pressed Tab on a nested item and the circle from the old depth stayed beside
       the square from the new one.
   The official sheet carries **no** rule for a nested item, and the browser's own default is the outside
   position these lines were trying to state. So the fix is to state nothing: what this class still needs
   is the one thing it can do without touching paint — nothing. The class stays in the theme because the
   node still gets it; it simply has no declaration here. */
/* **Nested ordered lists are NOT given the official renderer's rule, and that is deliberate.**
   
   The official sheet carries '.markdown :where(ul, ol) ol { list-style-position: inside; padding-left: 0 }'
   ("nested ol under ul/ol: markers inside — models sometimes emit this shape"). That is the right
   trade-off for *reading* a chat message, and the wrong one for an *editing* surface: with
   'padding-left: 0' every nested ordered list starts at its parent item's content column, so level 2 and
   everything below it sit at the same x. Measured in Chromium (this sheet, 14px text, the '<span>' Lexical
   puts around item text), text x per level:
       unordered: 45.0 / 66.0 / 87.0 / 108.0        one 21px step per level
       ordered:   45.0 / 59.4 / 59.4 / 59.4         level 2 is where the movement stops
   So the rule is not copied at all here: a nested 'ol' inherits '.md-ol { padding-left: 1.5em }' and the
   browser's default outside marker, exactly like a nested 'ul'. Measured after removing it:
   45.0 / 66.0 / 87.0 / 108.0 / 129.0 for five levels.
   
   Do not paste the official rule back in: it flattens the very depth an editor exists to show. Chat
   rendering keeps it — that is a different surface and not this sheet. */
/* **Ordered lists change their marker per ordered level: 1. / a. / 1.**
   
   Levels are counted along *consecutive ordered nesting* — an 'ol' directly inside an 'li' of another
   'ol'. A 'ul' or a 'blockquote' in between ends that chain, so an ordered list that starts under a
   bullet (or inside a quote) is level 1 again and shows decimal numbers: it is a fresh ordered list,
   and its source starts at 1 too.
   
   The rules are written on the *ol*, not on the 'li', and that is load-bearing: an empty wrapper item
   (what Enter→Tab leaves behind) is kept marker-free by '.md-li:not(:has(...)) { list-style: none }', a
   **direct** declaration on the item. A direct 'list-style-type' on '.md-li' would outrank that rule and
   bring the hidden marker back; declared on the 'ol' it is merely inherited, and inheritance always
   loses to a direct declaration. Verified in Chromium on the empty-wrapper shape: no marker drawn.
   
   'lower-alpha' is exactly the sequence the product asked for (a–z, aa–az, …, zz, aaa, aab…): measured
   in Chromium, 26 → 'z.', 27 → 'aa.', 52 → 'az.', 53 → 'ba.', 702 → 'zz.', 703 → 'aaa.'. At 100 items
   the widest level-2 marker is 'cv.' (16.2px) and fits the 21px gutter. A 3-digit decimal ('100.' =
   25.7px) hangs ~5px to the left — an outside marker is right-aligned, so only the marker moves and the
   text column does not. 1000+ items would hang further; not addressed here.
   
   The per-depth glyph is the thing §6.160 removed to stop a stale marker surviving a re-parent. It is
   back because the product asks for it, but only 'list-style-type' changed: no 'line-height' and no
   'list-style-position' rule is added. A Chromium re-parent simulation showed only the new glyph; the
   GUI check is still the one that decides. */
.md-ol { list-style-type: decimal; }
.md-ol > .md-li > .md-ol { list-style-type: lower-alpha; }
.md-ol > .md-li > .md-ol > .md-li > .md-ol { list-style-type: decimal; }
/* **The task box matches the official *disabled* checkbox — measured from its render, not guessed.**
   The markdown renderer draws a native 'input[type=checkbox][disabled]' with
   'accent-color: var(--dsw-alias-label-secondary)'. A disabled checkbox is painted from Chromium's own
   palette, not from that accent: light theme → checked fill '#d1d1d1'; unchecked fill '#f8f8f8' with a
   '#d1d1d1' border. Dark theme → '#757575', and '#3b3b3b' with a '#626262' border. Those four values
   and the tick colour were pixel-sampled from the official render at 2x (the tick is a disabled grey,
   not the page colour: '#ededed' in light, '#3b3b3b' in dark).
   The box is 13x13 with a 1px border and a 2px radius, and keeps an 8px 'margin-right' before the text
   (the official 'input[type=checkbox]' margin). With the item's 1.5em text-indent, box 13 + gap 8 = 21px
   puts the text exactly on the content column; it used to sit 2px to the left of it because the old
   16px box had no gap. */
/* **The task box sits in the line, not on top of it — and that is a paint fix, not a taste one (§6.160).**
   It used to be 'position: absolute; left: 0; top: .28em' with the '<li>' at 'position: relative', and
   that is a member of the class of defects a reader described as "it looks wrong until I switch panels
   and come back": an absolutely positioned box has its place computed **at paint time** from its
   containing block, so when the list around it changes — a level added, a line removed — the box that was
   there can survive a frame while the line it belonged to is gone. A repaint clears it; nothing in the
   DOM was ever wrong. Anything drawn outside the layout flow is exposed to that, and these two boxes were
   the only things in this sheet that were.
   In the flow instead: 'display: inline-block' puts the box in the first line box, 'vertical-align'
   seats it on the text line, and the claim over the marker's column comes from a **negative
   text-indent** on the item rather than from 'left: 0'. The box moves with the line because the line
   owns it. The tick stays absolute so it does not add width — see the note on '.md-li-checked::after'. */
.md-li-checked, .md-li-unchecked {
  list-style: none;
  margin-left: -1.5em;
  padding-left: 1.5em;
  text-indent: -1.5em;
  /* For the tick only — see the note on '.md-li-checked::after' below. */
  position: relative;
}
.md-li-checked::before, .md-li-unchecked::before {
  content: '';
  display: inline-block; vertical-align: baseline;
  width: 13px; height: 13px; box-sizing: border-box;
  margin-right: 8px;
  border: 1px solid #d1d1d1; border-radius: 2px;
  background: #f8f8f8;
}
.md-li-checked::before {
  background: #d1d1d1;
}
body[data-ds-dark-theme] .md-li-unchecked::before {
  border-color: #626262;
  background: #3b3b3b;
}
body[data-ds-dark-theme] .md-li-checked::before {
  border-color: #757575;
  background: #757575;
}
/* **The blue ring a click put around a task item, and why it is only suppressed for the pointer.**
   Lexical gives a checkable item 'role="checkbox"' and 'tabIndex="-1"' (read out of
   '@lexical/list/dist/LexicalList.dev.mjs'), so clicking the box focuses the '<li>'. The platform's
   ring logic then drew around it: 'dsh-client-ui-theme/lib/client.js' carries
   'html[data-input-modality=pointer] body :focus-visible:not(:read-write){--dsw-focus-ring-color:transparent}'
   — pointer input is **meant** to show no ring — and ':not(:read-write)' is the clause that carves out
   editable content (the editor root keeps its own 'outline: none' for the same reason). A '<li>' is not
   ':read-write', so it fell on the "draw it" side and a click produced a blue box around the whole item.
   Scoping to the pointer keeps the ring for a real keyboard Tab — the attribute is written on '<html>'
   by '@deepseek-ai/dsh-client-ui-primitives' — so what is removed is a ring that only ever appeared for a
   mouse. Toggling is untouched: Lexical handles the click itself and does not need focus. */
html[data-input-modality='pointer'] body .md-li-checked:focus,
html[data-input-modality='pointer'] body .md-li-unchecked:focus,
html[data-input-modality='pointer'] body .md-li-checked:focus-visible,
html[data-input-modality='pointer'] body .md-li-unchecked:focus-visible {
  outline: none;
}
/* The tick stays **absolutely positioned on purpose**, and the asymmetry with the box above is the point:
   what a stale frame exposes is a box that moved, and the box is what moves when a list gains or loses a
   level. The tick never moves on its own — it is glued to the box, drawn over the same 13px cell — so
   putting it in the flow would only add width to the line. 'position: relative' therefore stays on the
   item, for this one pseudo-element. Its 'top' is the box's top in the item's coordinates: the box is
   baseline-aligned, so with this line-height the baseline sits at 1.214em and the 13px box starts
   '1.214em - 13px' below the item's top. Measured against the box at 2x; keep the two in step when the
   box size or the typography changes. The tick's colour is the sampled disabled grey ('#ededed' light,
   '#3b3b3b' dark); its mask is the same check artwork at 13px, which gives the native stroke weight. */
.md-li-checked::after {
  content: '';
  position: absolute; left: 0; top: calc(1.214em - 13px);
  width: 13px; height: 13px;
  background: #ededed;
  -webkit-mask-image: var(--md-check-glyph);
  mask-image: var(--md-check-glyph);
  -webkit-mask-repeat: no-repeat;
  mask-repeat: no-repeat;
  -webkit-mask-position: center;
  mask-position: center;
  -webkit-mask-size: 13px 13px;
  mask-size: 13px 13px;
}
body[data-ds-dark-theme] .md-li-checked::after {
  background: #3b3b3b;
}
.md-link { color: var(--dsw-alias-link); font-weight: 500; text-decoration: none; }
/* **The leading glyph, drawn rather than inserted.** Official links carry a leading '<LinkIconMedium>'
   as the anchor's first child, and for a URL that resolves to the globe artwork (a site brand mark
   is tried first — 'SITE_HOSTS' in the platform bundle — and the globe is the fallback).
   'LinkIconMedium' is **not on the primitives package's export surface**, so it cannot be imported
   here. It is also a DOM child we would have to add, and this editor's anchor is a Lexical node:
   'linkClick.ts' decides "did the click land on a link" from '$getNearestNodeFromDOMNode', and the
   caret has to move through the same element.

   A pseudo-element sidesteps all of it: it is **not in the DOM**, so node-to-DOM mapping, the click
   predicate and the selection are untouched. The artwork is the official SVG, read out of
   'app.asar' — four paths, 'viewBox 0 0 16 16', 'stroke="currentColor"', at the official
   'ICON_MEDIUM_STROKE = 1.3' — carried as a data URI so it inherits the link colour. The box and
   offsets are the official '.linkIcon': '1.1em', 'vertical-align: -0.25em', 'margin-right: 5px'. */
.md-link::before {
  content: '';
  display: inline-block;
  width: 1.1em; height: 1.1em;
  vertical-align: -0.25em;
  margin-right: 5px;
  background: currentColor;
  -webkit-mask-image: var(--md-link-glyph);
  mask-image: var(--md-link-glyph);
  -webkit-mask-repeat: no-repeat;
  mask-repeat: no-repeat;
  -webkit-mask-size: contain;
  mask-size: contain;
}
/* **图片链接不画地球。** 那个图标说的是"这一段是链接"；链接里装的是图片时（[![npm](图)](地址)），
   图自己就已经说明了它是什么，再加一个地球只是噪声。判据是链接里有没有那颗图片宿主 —— :has()
   让这条只留一个选择器，不需要给锚点加类或改节点。混排（图 + 文字）也按图片链接算。 */
.md-link:has(.md-image-host)::before { display: none; }
/* Set once, on the root, so the URI lives in a single place. The artwork is stroked at 1.3 on a
   16-unit viewBox, so the mask is what carries the line weight. */
.md-root { --md-link-glyph: url("data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%2016%2016'%20fill='none'%20stroke='%23000'%20stroke-width='1.3'%3E%3Cpath%20d='M7.99986%2014.0887C11.3626%2014.0887%2014.0886%2011.3627%2014.0886%207.99998C14.0886%204.63727%2011.3626%201.91125%207.99986%201.91125C4.63715%201.91125%201.91113%204.63727%201.91113%207.99998C1.91113%2011.3627%204.63715%2014.0887%207.99986%2014.0887Z'/%3E%3Cpath%20d='M2.34619%208H13.6538'/%3E%3Cpath%20d='M7.99976%2014.0889C9.23509%2014.0889%2010.1743%2011.3629%2010.1743%208.00006C10.1743%204.63739%209.23509%201.91138%207.99976%201.91138'/%3E%3Cpath%20d='M7.99973%2014.0889C6.76445%2014.0889%205.8252%2011.3629%205.8252%208.00006C5.8252%204.63739%206.76445%201.91138%207.99973%201.91138'/%3E%3C/svg%3E"); }
/* The tick a checked task box carries. A mask, so the stroke is painted in the box's own colour
   rather than in the artwork's. */
.md-root { --md-check-glyph: url("data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%2016%2016'%20fill='none'%20stroke='%23000'%20stroke-width='2.6'%20stroke-linecap='round'%20stroke-linejoin='round'%3E%3Cpath%20d='M3.5%208.5L6.5%2011.5L12.5%204.5'/%3E%3C/svg%3E"); }
/* Official links are not underlined until you point at them — 'none', then a **dotted** underline on
   hover/focus. Ours was underlined at rest. */
.md-link:hover, .md-link:focus { text-decoration: underline dotted var(--dsw-alias-link); text-underline-offset: 3px; }
.md-bold { font-weight: 680; }
.md-italic { font-style: italic; }
.md-strike { text-decoration: line-through; opacity: .7; }
/* The inline-code chip, to the official sheet: same background token, plus the hairline border a
   reader asked for — '0.5px solid var(--dsw-alias-border-l1)', radius '--dsw-radius-sm' (8px),
   'padding: 0 5px', font '--dsw-font-markdown-code' (12px/19px) at '0.875em'. The '!important' on
   the size is the official sheet's own: the 'font:' shorthand sets a px size, and the chip has to
   stay proportional when it sits inside a heading, which sets its own 'font:'. */
.md-inline-code {
  font-family: var(--ds-font-family-code);
  font-size: .875em !important;
  padding: 0 5px; border-radius: var(--dsw-radius-sm);
  border: .5px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-markdown-inline-code);
}
.md-editor-code {
  /* Values from the official code-block sheet,
     dsh-client-ui-primitives/lib/markdown/CodeBlock.module.css, read out of
     app.asar. The official layout splits them over a .block wrapper and the
     <pre> inside it; here one element is both. */
  /* The code element is inline by default; padding on an inline box does not
     advance line height, so a multi-line block paints overlapping backgrounds
     and the first lines look darker. Block display is the fix. */
  display: block;
  margin: 16px 0;
  /* 52 = the 36px banner above + the 16px inset every side already had. The banner is drawn by
     ./codeChrome.tsx in a layer outside this element, so this is the space it draws in. */
  padding: 52px 16px 16px;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-markdown-code-block);
  border-radius: var(--dsw-radius-lg);
  font: var(--dsw-font-markdown-code-block);
  white-space: pre-wrap;
  word-break: break-all;
  overflow-x: auto;
}
.md-editor-code:not(:last-child) { margin-bottom: 11px; }
/* The banner and its copy button are real elements, drawn by ./codeChrome.tsx in a layer beside the
   editable surface — everything inside a Lexical CodeNode is reconciled by Lexical, so a control
   cannot live there. The layer is absolutely positioned in .md-root, so it scrolls with the text;
   the block reserves its height through the padding above, and the bar covers exactly that area. */
.md-code-layer { position: absolute; inset: 0; z-index: 1; pointer-events: none; }
.md-code-banner {
  position: absolute;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  height: 36px;
  padding: 0 14px;
  background: var(--dsw-alias-markdown-code-block-banner);
  color: var(--dsw-alias-label-primary);
  font: 11px/18px var(--ds-font-family-code);
  border-top-left-radius: var(--dsw-radius-lg);
  border-top-right-radius: var(--dsw-radius-lg);
  user-select: none;
}
.md-code-lang { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* The official .action in CodeCard.module.css: 24x24, radius-sm, label-secondary, hover fill. */
.md-code-copy {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 0;
  border-radius: var(--dsw-radius-sm);
  color: var(--dsw-alias-label-secondary);
  background: transparent;
  cursor: pointer;
  pointer-events: auto;
}
.md-code-copy:hover { background: var(--dsw-alias-interactive-bg-hover); }
.md-code-copy:focus-visible {
  outline: 1px solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 2px;
}
/* 表格画成一张**有框的网格**：每格四边都画线，表头下沿用深一档的线。字号与内边距照官方表格
   （'padding: 10px 16px'、'table-head' / 'table' 字体 token、表头不填底），但**外框与竖线是作者要的** ——
   只有横线的表格在一屏文字里读不出左右边界。'border-collapse: collapse' 让相邻两格的线合成一条，
   所以内外框都是 '.5px'（第一格不再贴左边、最后一格不再贴右边，文字与框之间留出内边距）。
   'th'/'td' 是真实标签：'TableCellNode.getTag()' 返回 'hasHeader() ? 'th' : 'td''，节点还带
   '.md-cell' / '.md-cell-head'，两种选择器都行。':where()' 保持零特异性，节点的类仍然盖得住。 */
.md-table { border-collapse: collapse; margin: .9em 0; }
.md-table :where(th, td) {
  padding: 10px 16px; vertical-align: top; text-align: left;
  border: .5px solid var(--dsw-alias-border-l2);
  /* 空格子只剩内边距时内容宽度是 0，段落没有宽度、光标无处可画（新增一列之后看到的就是这种格子）。
     下限只要不是 0 就够画出一条光标；1em 是"够用且不占宽度"的那个值。 */
  min-width: 1em;
}
.md-table :where(th) {
  border-bottom-color: var(--dsw-alias-border-l3);
  font: var(--dsw-font-markdown-table-head);
}
.md-table :where(td) { font: var(--dsw-font-markdown-table); }
.md-table :where(th, td) code { font-size: 11px; }
/* 列对齐（./tableAlign.ts 写的属性）：GFM 的对齐行是渲染信息，编辑器里不表现出来，菜单里选了
   "居中"就只有文件变了。属性只写 center / right / left 三种；'none' 摘掉属性、落回上面那条
   默认的左对齐。选择器多一个属性选择器，所以盖得住上面那条。 */
.md-table :where(th, td)[${TABLE_ALIGN_ATTRIBUTE}='left'] { text-align: left; }
.md-table :where(th, td)[${TABLE_ALIGN_ATTRIBUTE}='center'] { text-align: center; }
.md-table :where(th, td)[${TABLE_ALIGN_ATTRIBUTE}='right'] { text-align: right; }
.md-cell-selected { background: var(--dsw-alias-bg-multi-select); }
/* 表格的行 / 列手柄（./tableChrome.tsx）：悬停时浮在表格外侧的两个圆钮。坐标由 JS 按实测矩形
   算出来，这里只管样子。它们画在 contentEditable 之外（portal 到 body），所以既不进 Lexical 的
   节点树，也不吃正文的样式与选区。 */
.md-table-grip {
  width: 18px; height: 18px; padding: 0; border-radius: 50%;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-secondary);
  display: inline-flex; align-items: center; justify-content: center;
  cursor: pointer;
}
.md-table-grip:hover,
.md-table-grip[aria-expanded='true'] {
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-interactive-bg-hover);
}
.md-table-grip:focus-visible {
  outline: 1px solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 2px;
}
.md-table-highlight {
  position: fixed; z-index: 49; pointer-events: none;
  border: 1.5px solid var(--dsw-alias-state-business-primary);
  border-radius: 2px;
}
.md-table-reason-wrap { display: inline-flex; align-items: baseline; gap: 8px; }
.md-table-reason { font-size: 11px; color: var(--dsw-alias-label-caption); }
/* 渲染期抛错时的那张卡（../../client/ErrorBoundary.tsx）。它 replace 掉出错的子树 —— 编辑器，
   或整块面板 —— 所以居中、限宽，像一页正文而不是一块报错；颜色只用主题 token，深色主题下不刺眼。
   技术详情默认折起：读者要的是"还能做什么"，栈是给排查用的。 */
.md-failure {
  display: flex; flex-direction: column; gap: 12px;
  max-width: 560px; margin: 48px auto; padding: 24px;
  border: .5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-lg);
  background: var(--dsw-alias-bg-base);
}
.md-failure-title { font: var(--dsw-font-markdown-h3); color: var(--dsw-alias-label-primary); }
.md-failure-reason {
  font: var(--dsw-font-markdown-code-block); color: var(--dsw-alias-label-secondary);
  word-break: break-word; white-space: pre-wrap;
}
.md-failure-hint { color: var(--dsw-alias-label-secondary); font-size: 12px; }
.md-failure-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 4px; }
.md-failure-tech { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.md-failure-tech summary { cursor: pointer; }
.md-failure-tech pre {
  margin: 8px 0 0; padding: 12px; max-height: 240px; overflow: auto;
  border-radius: var(--dsw-radius-md); background: var(--dsw-alias-markdown-code-block);
  font: var(--dsw-font-markdown-code-block); white-space: pre-wrap; word-break: break-word;
}
.md-cell > p, .md-cell-head > p { margin: 0; }
/* A construct this schema cannot model yet, kept verbatim (see ./rawBlocks.tsx).
   Read-only, so it reads as preformatted text rather than as an editable block:
   the writer's move is to switch to the source view. Same token family as the
   editor's code block, one step dimmer, so it is not mistaken for content the
   editor owns. */
.md-raw-block {
  display: block; margin: 16px 0; padding: 12px 16px;
  border-left: 3px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-lg);
  background: var(--dsw-alias-markdown-code-block);
  color: var(--dsw-alias-label-secondary);
  font: var(--dsw-font-markdown-code-block);
  white-space: pre-wrap; word-break: break-all;
  user-select: text;
}
/* A source block: plain, editable Markdown source; not rendered as rich text. */
.md-source-host { display: block; margin: 16px 0; }
.md-source-input {
  display: block; box-sizing: border-box; width: 100%; min-height: 3.5em;
  margin: 0; padding: 12px 16px; resize: vertical;
  border: 0; border-left: 3px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-lg);
  background: var(--dsw-alias-markdown-code-block);
  color: var(--dsw-alias-label-secondary);
  font: var(--dsw-font-markdown-code-block);
  white-space: pre-wrap; word-break: break-all;
}
.md-source-input:focus { outline: 2px solid var(--dsw-alias-link); outline-offset: 2px; }
/* The host carries no space of its own; height and margin sit on the 'hr' itself
   ('height: 0.5px; margin: 32px 0'), so the space is symmetric about the line.
   'RuleNode.createDOM' is a block div, not an inline host, so no line-box trick
   is needed here. */
.md-rule-host { margin: 0; }
.md-rule {
  border: none; height: .5px; margin: 32px 0;
  background: var(--dsw-alias-border-l2);
}
.md-rule-selected { outline: 2px solid var(--dsw-alias-link); outline-offset: 3px; }
/* The host is a span because the node is inline: an image belongs to the line it
   was written on, and the stand-in has to hold that line while it waits.
   A plain image keeps its own box on the line's bottom edge — untouched, as it always was. */
.md-image-host { display: inline-block; max-width: 100%; vertical-align: bottom; }
/* **A selected image gets a blue outline, and it is a paint only.**
   The image selection module writes 'data-md-image-selected="true"' on this host while the image is
   inside the selection (a text range that spans it, or a NodeSelection on it). The outline sits
   outside the border box and takes no space, so nothing on the line moves. It is flush with the host
   (offset 0) and square-cornered, so a plain image reads as the picture being boxed. Colour is the
   platform link blue — the same one '.md-rule-selected' uses for a selected thematic break. */
.md-image-host[${IMAGE_SELECTED_ATTRIBUTE}='true'] {
  outline: 1px solid var(--dsw-alias-link);
  outline-offset: 0;
}
/* **An image that is a link rides the line box, not the text box.** A badge is part of the line, so
   its centre belongs on the line box's centre; vertical-align has no "centre in the line box"
   value, so the host itself becomes one line tall and centres the picture inside it:
   min-height 1lh (this context's line-height — body, heading, list item and quote each have their
   own, and the same rule follows all of them) + inline-flex/align-items centre, top-aligned to the
   line's top. The line box is never shorter than its tallest inline content, so there is always
   space to distribute and never a picture taller than the line. */
.md-link > .md-image-host {
  display: inline-flex;
  align-items: center;
  min-height: 1lh;
  vertical-align: top;
}
.md-image { display: block; max-width: 100%; height: auto; border-radius: var(--dsw-radius-sm); }
/* One line, deliberately. Reserving the picture's own box would need its
   dimensions, which nobody knows before it loads; the trade is a reflow when it
   arrives, chosen over a document that cannot lay itself out first. */
.md-image-wait {
  display: inline-block; padding: 0 .4em; border-radius: var(--dsw-radius-sm);
  background: var(--dsw-alias-markdown-inline-code); color: var(--dsw-alias-label-secondary);
  font-size: .9em;
}
/* Cannot be shown: same chip, one step quieter, so it reads as a stand-in rather
   than as something the writer typed. */
.md-image-alt { display: inline-block; padding: 0 .4em; border-radius: var(--dsw-radius-sm); font-size: .9em; font-style: italic; opacity: .65; }
/* The insert dialog's two lines of prose, in the same token family as the panel's other hints. */
.md-image-hint { margin: 10px 0 0; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; }
.md-image-problem { margin: 8px 0 0; color: var(--dsw-alias-state-error-primary, inherit); font-size: 12px; line-height: 18px; }
/* The link dialog's two labelled fields: the label sits **left of** the box, and the two rows
   are separated here because the modal body is a gap-less column. */
.md-link-form { display: flex; flex-direction: column; gap: 14px; }
.md-link-field { display: flex; align-items: center; gap: 10px; }
.md-link-label { flex: none; width: 2.5em; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; }
/* The platform Input wrapper is an inline-flex; in this row it has to fill the rest of the line. */
.md-link-input { flex: 1; min-width: 0; }
/* One step darker than the platform's dimmed grey: an empty box still has to read as a field. */
.md-link-field input::placeholder { color: var(--dsw-alias-label-tertiary); }
`

let stylesInjected = false

/**
 * Insert {@link EDITOR_CSS} once per page.
 *
 * `*.module.css` files are compiled into the bundle by `css-modules.ts`; this sheet is a plain
 * string, so it is installed here with the same `data-plugin-css` tag the build uses for the
 * modules. That attribute is what makes a second mount a no-op.
 */
export function ensureEditorStyles(): void {
  if (stylesInjected || typeof document === 'undefined') return
  if (document.querySelector('style[data-plugin-css="@yancy617/dsh-plugin-markdown/editor"]') !== null) {
    stylesInjected = true
    return
  }
  stylesInjected = true
  const tag = document.createElement('style')
  tag.dataset.plugin = '@yancy617/dsh-plugin-markdown'
  tag.dataset.pluginCss = '@yancy617/dsh-plugin-markdown/editor'
  tag.textContent = EDITOR_CSS
  document.head.appendChild(tag)
}
