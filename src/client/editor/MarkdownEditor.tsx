/**
 * Markdown 编辑区：Lexical 富文本编辑器 + mdast 读写的装配。
 *
 * 内容
 * - MarkdownEditor：组件；props 见 MarkdownEditorProps。
 * - EditorBridge：在 LexicalComposer 内把 onChange / onReady / onGone 接出来；
 *   每次更新提交后核对文末空段落（$ensureTrailingParagraph）。
 * - 插件：DocumentHistoryPlugin、UnderlineBlockPlugin、EmptyLinkPlugin、LinkClickPlugin、
 *   ListIndentPlugin、ParagraphAfterPlugin、EditableSyncPlugin、TableAlignPlugin、ImageSelectionPlugin、
 *   MarkdownClipboardPlugin、PasteMarkdownPlugin。
 * - MarkdownEditorProps：docKey / initialMarkdown / sourceBase / historyState / onChange /
 *   onReady / onGone / onNotice / documentPath / vaultRoot / bundled / readOnly / openWebPage。
 *
 * 行为
 * - 初始化：initialConfig 来自 config.ts 的 EDITOR_NODES / EDITOR_THEME；editable = !readOnly。
 * - 导入：initialMarkdown 经 importDocumentMarkdown（mdastLower）建树，并返回块级保存基线。
 * - 保存：每次内容更新经 blockSave 的 $saveBody 重建正文；未改的顶层块从原文切片，改过的块
 *   由 mdastLift 标准写。整篇标准写只在复制 / 对照时用（documentMarkdown 的 export）。
 * - onChange 的第二个参数是“这次更新有没有改树”（dirtyElements / dirtyLeaves）；
 *   自动保存的零点靠它。
 * - 文档切换：docKey 变 ⇒ LexicalComposer 重挂，文本与选区重置；撤销/重做由本次挂载的
 *   `DocumentHistoryPlugin` 从 `historyState` 接回，因此历史跟着打开的文章走。
 * - 历史：`historyState` 由文档会话给入；已有 `current` 时直接作为初始状态，新会话由插件补起点。
 * - 只读：readOnly 关掉 Lexical 的 editable；只读时不挂 FloatingToolbar / SlashMenu；
 *   EditableSyncPlugin 处理“挂载后变只读”。
 * - bundled：交给 ImageHostProvider，示例文档的图片走包内路由。
 * - frontmatter：splitFrontmatter 进、joinFrontmatter 出；编辑区只收正文。
 * - Tab / Shift+Tab：在列表项里走 `listNesting.ts` 的 $nestSelection（缩进 / 反缩进、反缩进保护、
 *   新子列表编号归 1 都在那一处）；其他位置不处理，交浏览器默认。
 * - 链接点击：LinkClickPlugin 把 openWebPage（缺省系统浏览器）交给 registerLinkClick。
 *
 * 边界
 * - 不负责 Markdown 语法的读写规则（documentMarkdown.ts 与 editor/*）。
 * - 不负责工作台保存 / 标签 / 文件树（MarkdownWorkbench.tsx）。
 * - 不负责浮窗与 / 菜单的表现（FloatingToolbar.tsx / SlashMenu.tsx）。
 *
 * 相关文件
 * - 依赖：documentMarkdown.ts、blockSave.ts、mdastLift.ts、config.ts、frontmatter.ts、
 *   trailingParagraph.ts、linkClick.ts、paragraphAfter.ts、imageView.tsx、webPage.ts、
 *   historySession.ts、documentSessions.ts。
 * - 被依赖：MarkdownWorkbench.tsx。
 *
 * 改哪里
 * - 导入 / 导出链路：documentMarkdown.ts。
 * - 只读行为：readOnly / EditableSyncPlugin。
 * - 文档切换：docKey。
 * - 插件组合：本文件顶部的插件列表。
 */
import {
  LexicalComposer,
  type InitialConfigType,
} from '@lexical/react/LexicalComposer'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { ContentEditable } from '@lexical/react/LexicalContentEditable'
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary'
import { LinkPlugin } from '@lexical/react/LexicalLinkPlugin'
import { CheckListPlugin } from '@lexical/react/LexicalCheckListPlugin'
import { ListPlugin } from '@lexical/react/LexicalListPlugin'
import { PasteMarkdownPlugin } from './PasteMarkdownPlugin'
import { MarkdownClipboardPlugin } from './clipboardMarkdown'
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin'
import { TablePlugin } from '@lexical/react/LexicalTablePlugin'
import type { HistoryState } from '@lexical/history'
import type { LexicalEditor } from 'lexical'
import { useEffect, useMemo, useRef, type MutableRefObject } from 'react'
import {
  $addUpdateTag,
  $getNodeByKey,
  $getRoot,
  $isRootNode,
  HISTORIC_TAG,
  type LexicalNode,
} from 'lexical'
import { registerUnderlineBlock } from './underline'
import { registerEmptyLinkCleanup } from './emptyLink'
import { registerParagraphAfter } from './paragraphAfter'
import { EDITOR_NODES, EDITOR_THEME, ensureEditorStyles } from './config'
import { ImageHostProvider } from './imageView'
import type { AssetWriter } from './assetWriter'
import { CodeHighlightPlugin } from './codeHighlight'
import { CodeChromePlugin } from './codeChrome'
import { TableChrome } from './tableChrome'
import { TableAlignPlugin } from './tableAlign'
import { ImageSelectionPlugin } from './imageSelection'
import { DocumentHistoryPlugin } from './historySession'
import { registerLinkClick } from './linkClick'
import { openInSystemBrowser, type OpenWebPage } from '../webPage'
import { importDocumentMarkdown } from './documentMarkdown'
import { $ensureTrailingParagraph } from './trailingParagraph'
import { eolOf } from './lineEnding'
import { $captureBase, $saveBody } from './blockSave'
import { isStaleBase, type BaseBlock, type SourceBase } from './saveBase'
import { SOURCE_EDIT_TAG } from './sourceBlock'
import { $isEmptyParagraph } from './emptyParagraph'
import { FloatingToolbar } from './FloatingToolbar'
import { joinFrontmatter, splitFrontmatter } from './frontmatter'
import { SlashMenu } from './SlashMenu'
import { registerListIndent } from './listNesting'

/** Props for {@link MarkdownEditor}. */
export interface MarkdownEditorProps {
  /**
   * Identity of the open document. Changing it remounts the composer, which is
   * how a document switch resets both the text and the undo stack.
   */
  readonly docKey: string
  /** Source Markdown the editor state is built from. */
  readonly initialMarkdown: string
  /**
   * The document's block-level save baseline.
   *
   * Owned by the open-document session (it survives a tab switch / composer remount), and mutated
   * by the editor after each write: unchanged blocks keep their original byte span, changed and new
   * blocks get the span of what was just written.
   */
  readonly sourceBase: SourceBase
  /**
   * The document's undo/redo history.
   *
   * Owned by the open-document session, not by this component: a tab switch or a panel remount
   * creates a new editor, and the history has to be attached to the new one. When its `current`
   * entry exists, the editor starts from that entry instead of re-importing the Markdown, so undo
   * can reach the state the document was left in.
   */
  readonly historyState: HistoryState
  /**
   * Called with freshly serialized Markdown after every editor update.
   *
   * This is both what the rich view shows and what the workbench will write: the editor's block
   * patcher produces one text, and the workbench keeps it in `content` (display / word count /
   * outline / re-import) and in `source` (the save subject). They are the same string, written by
   * one callback — there is no second "source mirror" callback that could drift from it.
   */
  readonly onChange: (markdown: string) => void
  /** Called once with the live editor instance, for out-of-band operations. */
  readonly onReady?: (editor: LexicalEditor) => void
  /**
   * Called when this editor is unmounted.
   *
   * The workbench keeps only a handle to the showing composer; without this callback it would go
   * on holding the previous document's editor (and its tree) after the tab closes or the view
   * switches to source.
   */
  readonly onGone?: (editor: LexicalEditor) => void
  /** Called with a one-line report when a paste is handled or deferred. */
  readonly onNotice?: (message: string) => void
  /**
   * Called once after mount with how long the initial rich-text import took, in milliseconds.
   *
   * Omitted when the composer started from a session snapshot rather than importing. This is the
   * only honest measure of "this document opened slowly": file size alone does not predict it
   * (a dense 854KB document imported slower than a plain 1MB one).
   */
  readonly onImportMs?: (ms: number) => void
  /**
   * Absolute path of the document on disk, when there is one.
   *
   * An image's destination is usually relative to the file it was written in, and
   * the file route wants an absolute path, so the editor has to publish where its
   * document lives. `null` before the document's path is known.
   */
  readonly documentPath?: string | null
  /**
   * The authorized vault root, when one is associated.
   *
   * Needed by the two paths that **store** a picture: where it goes is a decision
   * about the vault, and the insertion code would otherwise have to guess it from
   * the note's own path.
   */
  readonly vaultRoot?: string | null
  /**
   * Whether this document is one of the plugin's own bundled samples.
   *
   * Their pictures ship inside this package rather than sitting on a disk the platform's file
   * route can read, so the display side has to ask for them differently — see
   * `./imagePath.ts`'s `bundledImageUrl`. Defaults to `false`, which is every document in a
   * directory the writer authorized.
   */
  readonly bundled?: boolean
  /**
   * Whether this document refuses edits.
   *
   * A document that is read-only is not "an editor whose save is not offered" — **there is no
   * caret at all**: Lexical's own editable state is turned off, so a click places nothing, the
   * keyboard has nowhere to type, and the element reports itself as read-only
   * (`ContentEditableElement` writes `contentEditable={isEditable}`, `aria-readonly` and
   * `tabIndex={-1}` — read out of the installed package).
   *
   * **What that closes, and what it does not** (both read out of the installed `lexical`, not
   * assumed): Lexical's own DOM boundary asks `editor.isEditable()` before dispatching anything an
   * input event would carry — `keydown` and `pointerdown` are not even wired when it is false
   * (`lexical.dev.mjs`: `if (editor.isEditable() || eventName === 'click')`), and `cut` / `paste` /
   * `dragstart` / `dragover` / `dragend` / `drop` / `focus` / `blur` each check it before
   * dispatching their command. `copy` is deliberately always allowed, which is what lets a reader
   * copy text out of a read-only document. So typing, pasting, cutting, dragging and every
   * keystroke-driven command (including `Mod+Enter`) are closed by this flag alone.
   *
   * What it does **not** close is a command this plugin dispatches **programmatically**:
   * `editor.dispatchCommand` runs its listeners whatever the editable flag says — no `isEditable`
   * guard exists in `@lexical/rich-text`'s `registerRichText` (grepped). Those callers are
   * `FloatingToolbar`, `SlashMenu` and the palette's block operations, and they are handled where
   * they live: the two components are **not mounted** here, and the palette row is disabled.
   * (`@lexical/list`'s task checkbox is the one command handler that checks for itself, so it needs
   * nothing.)
   *
   * Defaults to `false`, which is every document in a directory the writer authorized.
   */
  readonly readOnly?: boolean
  /**
   * How this mount stores a picture, when it has a writer.
   *
   * Supplied by the workbench; omitted (a probe, or a mount with no vault) means the image-insert
   * paths answer with a sentence instead of pretending to write.
   */
  readonly writeAsset?: AssetWriter | null
  /**
   * How a web page in the document is opened when it is clicked.
   *
   * Supplied by the client half (`../webPage.ts`), which asks the platform's own
   * right-sidebar browser tab first and falls back to the system browser. Omitted
   * (a mount with no capability, as in a probe) means the fallback alone.
   */
  readonly openWebPage?: OpenWebPage
}

/**
 * 这次更新脏掉的顶层块（key 集合）。
 *
 * Lexical 的 `dirtyElements` 里**每次都有根节点**（一次普通的输入也是如此），所以根不能当作
 * “整篇都脏”。这里的规则是：
 *
 * - 根自己（没有父节点）与已经不在树里的节点都跳过——前者不代表某一块，后者的邻居一定脏；
 * - 其余节点沿父链走到顶层块，把它记进集合；
 * - 撤销 / 重做由调用方按 `HISTORIC_TAG` 判成整体重算，不靠脏集合（历史恢复的脏集合不可依赖）。
 *
 * 没脏的块，`blockSave.ts` 直接复用基线里的标准写法，不再重新序列化；这条缓存必须与
 * “整体重算”给出逐字节相同的结果（`probe-block.ts` 的双跑用例钉住它）。
 * @param elements - 本次更新的 `dirtyElements` 的 key。
 * @param leaves - 本次更新的 `dirtyLeaves` 的 key。
 * @returns 脏掉的顶层块 key（可能为空）。
 */
function $dirtyTopLevelBlocks(elements: Iterable<string>, leaves: Iterable<string>): ReadonlySet<string> {
  const dirty = new Set<string>()
  for (const key of [...elements, ...leaves]) {
    const node = $getNodeByKey(key)
    if (node === null) continue
    let current: LexicalNode = node
    while (current.getParent() !== null && !$isRootNode(current.getParent())) {
      const parent = current.getParent()
      if (parent === null) break
      current = parent
    }
    if ($isRootNode(current.getParent())) dirty.add(current.getKey())
  }
  return dirty
}

/**
 * Headless child bridging the composer context to the host component's
 * callbacks. Lives inside `LexicalComposer` so it can read the editor.
 * @param props - change and readiness callbacks.
 * @returns nothing; this component renders no DOM.
 */
function EditorBridge({
  frontmatter,
  initialBody,
  sourceBase,
  initialBase,
  onChange,
  onReady,
  onGone,
}: {
  readonly frontmatter: string | null
  readonly initialBody: string
  readonly sourceBase: SourceBase
  readonly initialBase: MutableRefObject<BaseBlock[] | null>
  readonly onChange: (markdown: string) => void
  readonly onReady?: ((editor: LexicalEditor) => void) | undefined
  readonly onGone?: ((editor: LexicalEditor) => void) | undefined
}) {
  const [editor] = useLexicalComposerContext()
  const onChangeRef = useRef(onChange)
  const onReadyRef = useRef(onReady)
  const onGoneRef = useRef(onGone)
  const frontmatterRef = useRef(frontmatter)
  const sourceRef = useRef(initialBody)
  const initialBodyRef = useRef(initialBody)
  const sourceBaseRef = useRef(sourceBase)
  initialBodyRef.current = initialBody
  sourceBaseRef.current = sourceBase
  onChangeRef.current = onChange
  onReadyRef.current = onReady
  onGoneRef.current = onGone
  frontmatterRef.current = frontmatter

  useEffect(() => {
    onReadyRef.current?.(editor)
    return () => {
      onGoneRef.current?.(editor)
    }
  }, [editor])

  useEffect(() => {
    sourceRef.current = initialBodyRef.current
    /*
     * **The base is captured once per document session.** It is the only place that remembers where
     * each top-level block sat in the file; it is deliberately *not* stored on the Lexical nodes, so
     * no position can travel through the clipboard or be restored by a foreign JSON payload. A
     * pasted node has a new NodeKey, so it has no base entry and is written as new content.
     */
    const base = sourceBaseRef.current
    /**
     * **基线自检：它描述的必须是现在这一份正文。**
     *
     * `base.source` 是那组 span 所属的正文。任何“在编辑器之外改写正文”的路径（重新载入、
     * 移动改址、以后可能出现的整篇替换）都必须丢掉会话（`documentSessions.forget`），
     * 让视图重挂；万一有一条路忘了，这里就把基线丢掉，下一次保存整篇按标准重写。
     * 方向是安全的那一边：内容一个字节不丢，只丢掉未改块的原文拼写。
     *
     * **丢掉之后不再就地重捕**：重捕会把“新正文的解析”与“旧树的节点”配成一对，偏移照样是错的。
     * 空基线让下一次保存把每个块都当成新块——整篇标准写，结果正确。
     */
    const stale = isStaleBase(base, sourceRef.current)
    if (stale) {
      console.info('[markdown] 保存基线描述的正文与当前正文不一致，已丢弃；下一次保存会整篇按标准重写')
      base.blocks = []
      base.source = ''
    }
    if (base.blocks.length === 0) {
      const imported = initialBase.current
      if (!stale && imported !== null && imported.length > 0) {
        base.blocks = imported
        base.source = initialBodyRef.current
      } else if (!stale && initialBodyRef.current !== '') {
        base.blocks = editor.getEditorState().read(() => $captureBase(initialBodyRef.current))
        base.source = initialBodyRef.current
      }
    }
    return editor.registerUpdateListener(({ editorState, dirtyElements, dirtyLeaves, tags }) => {
        /**
         * **文末空段落的补写继承“历史更新”这个标签**：撤销 / 重做恢复出的状态已经是一次结果，
         * 不是编辑器（以及任何 UI 弹层）刚刚发生的一次动作。若这次补写还会改树，它也必须被历史
         * 插件和菜单监听当成同一次历史更新，而不是一条新编辑 / 一次新弹窗。
         */
        const historic = tags.has(HISTORIC_TAG)
        /*
         * source 块是 DecoratorNode：改它的 __raw 不会进 dirtyElements / dirtyLeaves，
         * 但这次 update 带了 SOURCE_EDIT_TAG。保存要把它当“改过”，并且整篇重算，
         * 否则会复用旧 written 把用户的编辑吞掉。
         */
        const sourceEdit = tags.has(SOURCE_EDIT_TAG)
        /**
         * **"文末始终有一个空段落"这条不变量在这里守**（`./trailingParagraph.ts` 的
         * `$ensureTrailingParagraph`）。
         *
         * 为什么是这里：它要的是"**每次编辑提交之后**都成立"—— 用户退格、剪切、Delete、拖走、撤销
         * 都会让末尾不再是空段落，而只有"结果守"能把这些路径一次管住（拦按键只守得住一个键）。
         *
         * 两处细节：
         *
         *   - **先读 `editorState`，后补**：`editorState.read()` 里不许改树，所以先算"要不要补"，
         *     再用一次 `discrete` 更新补上（补完不会再触发一轮：条件那时已经不成立了）；
         *   - **放在导出之前**：补出来的空段落在文末，块级保存不会把它当成内容块。
         */
        const needsTrailing = editorState.read(() => !$isEmptyParagraph($getRoot().getLastChild()))
        if (needsTrailing) {
          editor.update(
            () => {
              if (historic) $addUpdateTag(HISTORIC_TAG)
              $ensureTrailingParagraph($getRoot())
            },
            { discrete: true },
          )
        }
        // 只改选区的更新两个集合都是空的，而粘贴、输入、格式化命令一定至少脏一个节点。
        // 这种更新不需要重新算正文：正文没变，`onChange` 把同一份交回去就够了（调用方比较后不动）。
        const changed = sourceEdit || dirtyElements.size > 0 || dirtyLeaves.size > 0
        if (!changed) {
          onChangeRef.current(joinFrontmatter(frontmatterRef.current, sourceRef.current))
          return
        }
        const saved = editorState.read(() =>
          $saveBody(
            sourceRef.current,
            sourceBaseRef.current.blocks,
            eolOf(sourceRef.current),
            // 历史恢复（撤销 / 重做）的脏集合不可依赖；source 块改动也不在 dirty 集合里。
            // 两者都整篇重算；其余更新只把脏掉的顶层块交给写手。
            historic || sourceEdit ? undefined : $dirtyTopLevelBlocks(dirtyElements.keys(), dirtyLeaves),
          ),
        )
        sourceBaseRef.current.blocks = saved.blocks
        sourceBaseRef.current.source = saved.body
        if (saved.body !== sourceRef.current) sourceRef.current = saved.body
        onChangeRef.current(joinFrontmatter(frontmatterRef.current, saved.body))
      })
  }, [editor])

  return null
}

/**
 * Keep Lexical's editable state in step with the prop.
 *
 * `LexicalComposer` reads `initialConfig.editable` **once**, when it creates the editor, and
 * applies it in a mount-only layout effect — read out of the installed package, not assumed. That
 * is enough for a document switch (the composer is keyed by `docKey`, so it remounts and reads the
 * new value), but not for the showing document becoming read-only underneath a mounted editor: a
 * writer who revokes the authorization keeps their tabs, the panel turns read-only, and the
 * composer would stay editable. `setEditable` is Lexical's own answer to that, and
 * `ContentEditableElement` reflects it onto the DOM through `registerEditableListener`.
 *
 * It is also what closes the **DOM** half: `lexical`'s own root-element wiring asks
 * `isEditable()` before dispatching anything an input event carries (`lexical.dev.mjs`).
 * @param props.editable - whether the document may be edited.
 * @returns nothing rendered.
 */
function EditableSyncPlugin({ editable }: { readonly editable: boolean }): null {
  const [editor] = useLexicalComposerContext()

  useEffect(() => {
    editor.setEditable(editable)
  }, [editor, editable])
  return null
}

/**
 * Mount {@link registerUnderlineBlock} for as long as the editor lives.
 * @returns nothing rendered.
 */
function UnderlineBlockPlugin(): null {
  const [editor] = useLexicalComposerContext()

  useEffect(() => registerUnderlineBlock(editor), [editor])
  return null
}

/**
 * Mount {@link registerEmptyLinkCleanup} for as long as the editor lives.
 * @returns nothing rendered.
 */
function EmptyLinkPlugin(): null {
  const [editor] = useLexicalComposerContext()

  useEffect(() => registerEmptyLinkCleanup(editor), [editor])
  return null
}

/**
 * Mount {@link registerLinkClick} for as long as the editor lives.
 *
 * 编辑区是个 `contenteditable`，里面的 `<a>` 点了不导航，所以"点链接打开网页"必须自己接一条
 * 点击监听 —— 判据与出处（官方哪一行）写在 `./linkClick.ts`，**开到哪儿**写在 `../webPage.ts`
 * （先问 DSH 自己的右侧栏浏览器标签，问不通才退系统浏览器）。
 * @param props - the opener supplied by the client half.
 * @returns nothing rendered.
 */
function LinkClickPlugin({ openWebPage }: { readonly openWebPage: OpenWebPage }): null {
  const [editor] = useLexicalComposerContext()

  useEffect(() => registerLinkClick(editor, openWebPage), [editor, openWebPage])
  return null
}

/**
 * Make Tab indent a list item, and Shift+Tab take it back.
 * ## Why this is needed at all
 *
 * `@lexical/rich-text` already registers `INDENT_CONTENT_COMMAND`, and `@lexical/list` already stores a
 * per-item indent — but **nothing dispatches the command for Tab**: rich-text's own `KEY_TAB_COMMAND`
 * handler only escapes format triggers and returns `false`, which lets the browser's default happen
 * (the focus leaves the editor). So the pieces existed and were never connected.
 *
 * ## What one step is
 *
 * The walk from the caret to the list item, the outdent guard that keeps `@lexical/list`'s
 * `$handleOutdent` from deleting the item above, resetting a newly created sublist's start number to 1,
 * and the key binding itself all live in one place: `./listNesting.ts`. This plugin only mounts it.
 * @returns nothing rendered.
 */
function ListIndentPlugin(): null {
  const [editor] = useLexicalComposerContext()

  useEffect(() => registerListIndent(editor), [editor])
  return null
}

/**
 * Mount `Mod+Enter` ("a new paragraph after this block") for as long as the editor lives.
 *
 * 判据、键位与"为什么是顶层块"都在 `./paragraphAfter.ts`：那一条同时是**从表格里出来**的路
 * （表格里按回车只在单元格里再开一段，而那一格写不回文件）。
 * @returns nothing rendered.
 */
function ParagraphAfterPlugin(): null {
  const [editor] = useLexicalComposerContext()

  useEffect(() => registerParagraphAfter(editor), [editor])
  return null
}

/**
 * Render the editing surface for one document.
 * @param props - document identity, initial text, and change callback.
 * @returns the composer subtree.
 */
export function MarkdownEditor({
  docKey,
  initialMarkdown,
  sourceBase,
  historyState,
  onChange,
  onReady,
  onGone,
  onNotice,
  onImportMs,
  documentPath = null,
  vaultRoot = null,
  bundled = false,
  readOnly = false,
  writeAsset = null,
  openWebPage,
}: MarkdownEditorProps) {
  /**
   * How long the initial import took, written during render and reported after mount.
   *
   * It cannot call `onImportMs` from inside the initializer: that runs while this component is
   * rendering, and updating the parent there is a React error. A ref carries the number across
   * the commit and the effect below delivers it once.
   */
  const importMsRef = useRef<number | null>(null)
  const initialBaseRef = useRef<BaseBlock[] | null>(null)
  const onImportMsRef = useRef(onImportMs)
  onImportMsRef.current = onImportMs

  useEffect(() => {
    ensureEditorStyles()
  }, [])

  useEffect(() => {
    const measured = importMsRef.current
    importMsRef.current = null
    // Absent when the document resumed from its session (no import happened) — nothing to report.
    if (measured !== null) onImportMsRef.current?.(measured)
  }, [])

  const { frontmatter, body } = useMemo(() => splitFrontmatter(initialMarkdown), [initialMarkdown])

  const initialConfig = useMemo<InitialConfigType>(
    () => ({
      namespace: 'dsh-markdown-editor',
      theme: EDITOR_THEME,
      // The **starting** editable state. It is read once, so a document that turns read-only while
      // it is open is handled by `EditableSyncPlugin` — this field is what makes the first frame
      // right rather than editable-then-not.
      editable: !readOnly,
      // Single source of truth: the Markdown-expressible whitelist. Every entry
      // has a lower / lift branch in mdastLower.ts / mdastLift.ts.
      nodes: [...EDITOR_NODES],
      /**
       * **A returning document starts from its session, not from a fresh import.**
       *
       * The history's `current` entry is the editor state this document was left in. Re-importing
       * the Markdown would produce an equal-looking but different state, and the next undo would
       * then step to a state the editor never showed. A new document has no `current` entry and
       * takes the ordinary import path.
       */
      editorState:
        historyState.current !== null
          ? historyState.current.editorState
          : () => {
              // Only the body reaches the editor: a `---` fence would otherwise be
              // read as two thematic breaks and destroy the note's metadata.
              //
              // 正文的全部处理都在 `./documentMarkdown.ts` 的导入入口里：mdast 解析原始正文，
              // `mdastLower.ts` 只做语义映射；没有编码、没有哨兵、没有“位置可用度”这一层。
              //
              // **这段耗时会被报给工作台**：大文档保护的"慢"用的是实测值，不是按大小猜
              // （见 `../largeDocument.ts`）。这里只量导入，不量 DOM —— DOM 这一层没有钩子。
              const started = performance.now()
              initialBaseRef.current = importDocumentMarkdown(body)
              importMsRef.current = performance.now() - started
            },
      onError: (error: Error) => {
        // Lexical swallows listener errors by default; rethrowing surfaces them
        // in the browser console instead of silently dropping the update.
        throw error
      },
    }),
    [body, historyState, readOnly],
  )

  return (
    /*
      The provider sits outside the composer on purpose: a decorator's element is portalled in by the
      reconciler, so an image reads the document's path from *this* React tree. Inside the composer it
      would still work, but the two facts — where the document is, and what the editor is showing —
      would then travel in opposite directions.
    */
    <ImageHostProvider
      documentPath={documentPath}
      vaultRoot={vaultRoot}
      bundled={bundled}
      writeAsset={writeAsset}
    >
      <LexicalComposer key={docKey} initialConfig={initialConfig}>
        <div className="md-root">
          <RichTextPlugin
            contentEditable={
              /*
                **No native spellcheck.** Lexical's `ContentEditable` writes `spellCheck` (default
                `true`) onto the editable, and Chromium then draws red waves under every word its
                dictionary does not know — English names, versions and URLs throughout a Markdown
                file. This editor is for documents, not for prose the browser should proof-read, and
                the source view's textarea already turns it off; this is the same switch for the
                rich-text half.
              */
              <ContentEditable className="md-editable" aria-label="Markdown 编辑区" spellCheck={false} />
            }
            placeholder={
              <div className="md-placeholder">
                {'输入"/"快速插入内容'}
              </div>
            }
            ErrorBoundary={LexicalErrorBoundary}
          />
          <DocumentHistoryPlugin history={historyState} />
          <ListPlugin />
          {/*
            `CheckListPlugin` is what registers the listeners for the check-list
            commands, and without it the "任务列表" operation dispatched
            `INSERT_CHECK_LIST_COMMAND` into nothing — `registerCheckList` lives
            here, not in `ListPlugin`. Mounting it also makes the checkbox in a
            task item clickable, which is the third part of check-list support.
          */}
          <CheckListPlugin />
          <UnderlineBlockPlugin />
          <EmptyLinkPlugin />
          <ListIndentPlugin />
          <ParagraphAfterPlugin />
          <LinkPlugin />
          <LinkClickPlugin openWebPage={openWebPage ?? openInSystemBrowser} />
          <TablePlugin />
          {/*
            The table handles: hover a row or a column and a grip appears outside it. Like the code
            banner, everything it draws is a portal outside the contentEditable, so Lexical never
            reconciles a node it did not ask for. Absent while read-only, for the same reason the
            floating toolbar and the slash menu are.
          */}
          {readOnly ? null : <TableChrome />}
          {/*
            Column alignment is painted on the cells themselves (`data-md-align`), because a GFM
            delimiter row is render information the editor has to show. It stays mounted while
            read-only: an aligned table must still read as aligned.
          */}
          <TableAlignPlugin />
          {/*
            Images get a selected state (`data-md-image-selected` -> blue outline), a click that
            selects one (not inside a link), and the keys that act on a selected image. It stays
            mounted while read-only: a selection must still read as a selection; the key handlers
            themselves check `editor.isEditable()`.
          */}
          <ImageSelectionPlugin />
          <CodeHighlightPlugin onReport={onNotice} />
          {/*
            The code-block banner and its copy button. It draws a sibling layer inside `.md-root`,
            never inside the contentEditable: Lexical reconciles everything under its root, so a
            control placed there would be a node the reconciler never asked for.
          */}
          <CodeChromePlugin />
          <MarkdownClipboardPlugin />
          <PasteMarkdownPlugin onReport={onNotice} />
          {/*
            The two surfaces that *dispatch* a change, and they are absent rather than disabled:
            with no caret in the document there is nothing for them to act on, and a command
            dispatched programmatically runs whatever the editable flag says (see
            `MarkdownEditorProps.readOnly`). Everything else inside the composer is reached through
            a DOM input event, which Lexical's own boundary refuses while not editable.
          */}
          {readOnly ? null : <FloatingToolbar />}
          {readOnly ? null : <SlashMenu />}
          <EditableSyncPlugin editable={!readOnly} />
          <EditorBridge
            frontmatter={frontmatter}
            initialBody={body}
            sourceBase={sourceBase}
            initialBase={initialBaseRef}
            onChange={onChange}
            onReady={onReady}
            onGone={onGone}
          />
        </div>
      </LexicalComposer>
    </ImageHostProvider>
  )
}
