/**
 * 面板的数据形状：树的一层、一篇打开的文档、一次拖动、一个对话框、快照与保存三态。
 *
 * 内容
 * - LevelState / WriteOutcome / CloseResult / CloseRequest / BufferState / TreeTarget / RowMenu / DropZone / DragState。
 * - PromptState / ScrollState / WorkbenchSnapshot / SaveState / WebTabState / LargeOpenChoice / LargeDocumentOpen。
 * - ConflictState / OpenFailure。
 *
 * 行为
 * - 只有类型：没有函数、没有常量、不读 React，也不读组件状态。
 * - WorkbenchSnapshot 是“面板切换后要活下来”的那份数据的唯一形状。
 *
 * 边界
 * - 不定义任何行为规则（那是各自 feature 的事）；不拥有实例，只描述形状。
 *
 * 相关文件
 * - 依赖：shared/protocol（VaultEntry）、treeDrop（拖动落点类型）。
 * - 被依赖：MarkdownWorkbench.tsx、workbench 下的视图与 hook、index.tsx。
 *
 * 改哪里
 * - 加快照字段：WorkbenchSnapshot。
 * - 加一种面板状态：对应 type / interface。
 */
import type { VaultEntry, VaultReadResult } from '../../shared/protocol'
import type { DropKind, DropRefusal, DropSource } from '../treeDrop'

/** One directory level as the tree sees it. */
export interface LevelState {
  readonly status: 'loading' | 'ready' | 'failed'
  readonly entries: readonly VaultEntry[]
  readonly message?: string | undefined
}

/**
 * One attempt at writing a document, as its callers need to read it.
 *
 * `unchanged` is a success: there was nothing to write, so the document is as safe as a written
 * one (that is what lets a manual save on a clean document answer 「保存成功」 without a write, and
 * what lets a close proceed without one).
 */
export type WriteOutcome =
  | {
      readonly kind: 'written'
      /** The exact text that landed, so a close can tell whether the buffer moved on. */
      readonly text: string
    }
  | { readonly kind: 'unchanged' }
  | {
      readonly kind: 'failed'
      readonly message: string
      /** Protocol code, when the refusal carried one (e.g. `stale-version`). */
      readonly code?: string | undefined
    }
  | { readonly kind: 'discarded' }

/** What came of a tab close: it closed, or the save refused and the tab stayed. */
export type CloseResult =
  | { readonly kind: 'closed' }
  | { readonly kind: 'failed'; readonly message: string; readonly code?: string | undefined }

/**
 * One open document: its identity, its text, and what it was last read from.
 */
export interface BufferState {
  /**
   * Always `file`.
   *
   * Every open document is one the vault route read, samples included: the samples are the
   * plugin's own memory documents, but they arrive through the same `list` and `read` routes
   * as a note does, so there is no second kind to branch on. The union with `example` went
   * when the samples stopped being a separate client-side store (§6.49), and what they are
   * on the Host side is `vaultKind === 'sample'` (§6.143).
   */
  readonly kind: 'file'
  /** Absolute path. */
  readonly path: string
  /** Display title. */
  readonly title: string
  /**
   * Size in UTF-8 bytes when the document was opened or last reloaded.
   *
   * It is what the large-document decision reads: the bytes of the text that was just read, so a
   * 854KB document of dense inline nodes and a 1MB document of paragraphs are told apart by how
   * long they took to import, not by this number. Not recomputed on every keystroke.
   */
  readonly bytes: number
  /** Current text in the editor. */
  readonly content: string
  /** Text as last read from disk. */
  readonly saved: string
  /**
   * The source mirror: the file text as it will be written.
   *
   * Starts equal to `saved` and is patched block by block as the writer edits, so bytes the writer
   * never touched are carried from the file rather than re-spelled by the editor.
   */
  readonly source: string
  /** Freshness token from the last read, for the next compare-and-set write. */
  readonly version?: string | undefined
  /**
   * Whether this document's text came out of **this package** rather than out of the writer's
   * directory.
   *
   * It is a fact about the document, not about the vault, and the two are different: the
   * plugin's own two documents can now be open **beside** the writer's files (the settings menu
   * offers them whatever root is authorized), and a document opened in sample mode stays the
   * plugin's own after the writer picks a directory of their own — `chooseVault` and
   * `forgetVault` deliberately keep the open tabs.
   *
   * Read by two rules and nothing else: whether the document may be edited at all
   * (`./readOnly.ts`'s `readOnlyDocument`, which also asks `vaultKind`) and whether its pictures
   * come from the package's own table rather than from a directory (`MarkdownEditor`'s `bundled`).
   * It lives on the buffer rather than
   * being derived from `vaultKind` at the point of use because it has to survive both a panel
   * switch (the snapshot carries the buffers) and a change of authorized root.
   */
  readonly sample: boolean
}

/** One entry a row menu or a dialog acts on. */
export interface TreeTarget {
  /** Absolute path. */
  readonly path: string
  /** Basename, for prefill and messages. */
  readonly name: string
  /** Whether it is a directory. */
  readonly isDirectory: boolean
}

/**
 * The entry menu while it is open: what it acts on, and where its card hangs.
 *
 * `anchorRect` is how to *find* the anchor rather than the rectangle itself, because
 * `Menu` asks for it on open, on every animation frame while the card is up, and on
 * scroll/resize. A card opened from a row's own button therefore follows the tree as
 * it scrolls — the button is measured again each time — while a card opened by a
 * right-click keeps the point the pointer was at, the way it always has.
 *
 * The two ways in differ in exactly this one field, and that is what lets one `Menu`
 * serve both: the row's ⋯ and a right-click on the row open the same list.
 */
export interface RowMenu {
  /** The entry the chosen command acts on. */
  readonly target: TreeTarget
  /** Where the list hangs; `null` skips placement for that frame. */
  readonly anchorRect: () => DOMRect | null
}

/** Where a drop would land, as the row under the pointer sees it. */
export interface DropZone {
  /** The row the pointer is over. */
  readonly path: string
  /** Which band of that row. */
  readonly kind: DropKind
  /** The directory the carried entry would land in. */
  readonly directory: string
  /**
   * Why it cannot land there, or `null` when it can.
   *
   * A refused zone draws no marker at all and asks the browser for the "no drop" cursor,
   * which is the whole of how a refusal is said: a line that appeared and then did
   * nothing would be worse than no line.
   */
  readonly refusal: DropRefusal | null
}

/** A drag in flight: the row being carried, and the row it is over. */
export interface DragState {
  readonly source: DropSource
  /** `null` while the pointer is between rows. */
  readonly zone: DropZone | null
}

/** Which prompt dialog is open. */
export type PromptState =
  | { readonly kind: 'file'; readonly directory: string }
  | { readonly kind: 'directory'; readonly directory: string }
  | { readonly kind: 'rename'; readonly target: TreeTarget }

/** Scroll offsets worth restoring after a remount. */
export interface ScrollState {
  /** Per document path: where the editor or source view was scrolled to. */
  readonly documents: Record<string, number>
  /** The sidebar tree's own offset. */
  readonly tree: number
}

/** How a document over the large-document line (4 MiB) was opened, once the reader chose. */
export type LargeOpenChoice = 'source' | 'rich'

/** A read document waiting for the "it is large" choice. */
export interface LargeDocumentOpen {
  /** What the read route answered. */
  readonly file: VaultReadResult
  /** Whether it is one of the plugin's own samples. */
  readonly sample: boolean
  /** Its size in UTF-8 bytes. */
  readonly bytes: number
}

/** A read that failed, and which route it came from (so retry can use the same one). */
export interface OpenFailure {
  /** The path (or sample name) that was asked for. */
  readonly path: string
  /** The error's message. */
  readonly message: string
  /** Which route to call again. */
  readonly route: 'file' | 'sample'
}

/**
 * A save refused because the file on disk holds a different text.
 *
 * The dialog's whole content. Which side wins is the workbench's transaction, not this shape's:
 * the two answers are "write mine over it" and "read it in", and both need the document's own
 * buffer, timer state and undo session.
 */
export interface ConflictState {
  /** The document whose save was refused. */
  readonly path: string
  /** Its display title, for the dialog's subtitle. */
  readonly title: string
  /** The Host's own sentence explaining the refusal. */
  readonly message: string
}

/**
 * What survives a panel switch: everything the writer would call "the work in
 * progress". Nothing that belongs to a mounted composer is here, because none
 * of it can be reconstructed.
 */
export interface WorkbenchSnapshot {
  /** Authorized vault root, or `null`. */
  readonly root: string | null
  /**
   * Where that root came from.
   *
   * Carried, not re-derived. A snapshot with a `root` cannot say whether it is
   * the bundled samples or a directory the writer picked, and guessing "user"
   * made a panel switch turn the sample view into a full vault toolbar with a
   * path label over documents that are the plugin's, not the writer's.
   */
  readonly vaultKind: 'sample' | 'user' | null
  /** Loaded directory levels, keyed by absolute path. */
  readonly levels: Record<string, LevelState>
  /** Expanded directory paths. */
  readonly expanded: readonly string[]
  /** Open documents, keyed by path. */
  readonly buffers: Record<string, BufferState>
  /** Tab order. */
  readonly tabs: readonly string[]
  /** The showing tab. */
  readonly activePath: string | null
  /** Whether the source view was showing. */
  readonly sourceMode: boolean
  /**
   * Documents whose **own** view is the source view.
   *
   * The manual switch above is per workbench (it has always been); this is per document and is
   * written by two decisions that are about one document: a large document the reader chose to
   * open in source, and a document the rich editor failed to render. Removing one while closing or
   * reloading is unnecessary — the entry is a path, and the path's document starts fresh.
   */
  readonly sourceOnly: Record<string, true>
  /** The answer to "this one is large" for the whole session, or `null` until asked. */
  readonly largeOpenChoice: LargeOpenChoice | null
  /** Whether the outline column was open. */
  readonly outlineOpen: boolean
  /**
   * The outline's width in pixels, or `null` if the writer has never set one.
   *
   * `null` rather than the default: a session that never touched the handle must not come back
   * holding a number, or the default it should open at would stop being the default.
   */
  readonly outlineWidth: number | null
  /** Where the scrollports were left. */
  readonly scroll: ScrollState
}

/**
 * What the panel is saying about saving, if anything.
 *
 * One notice, three sentences, and the reader sees whichever is true. `saving` lasts
 * exactly as long as the write; `saved` is the receipt; `failed` is the one that
 * stays, because a refused write leaves the reader's text in the buffer and **off the
 * disk**.
 */
export type SaveState =
  | { readonly kind: 'saving' }
  | { readonly kind: 'saved' }
  | {
      readonly kind: 'failed'
      readonly message: string
      /**
       * Which document the refusal was about, when it is about one.
       *
       * Auto-save succeeds silently, but a success still has to take a **failure notice about the
       * same document** off screen (otherwise a lost write leaves a permanent pink row behind
       * after the next write lands). Comparing paths is what keeps that from clearing a notice
       * that belongs to another document.
       */
      readonly path?: string
    }
  | null

/** 本面板标签栏里的一格网页标签。 */
export interface WebTabState {
  /** 身份：同一个地址复用同一格。 */
  readonly id: string
  /** 要显示的地址。 */
  readonly url: string
  /** 标签上那行字：先是主机名，页面报了标题之后换成标题。 */
  readonly title: string
}

/**
 * A close that is waiting on a write.
 *
 * The default close starts saving immediately and freezes the view (`saving`). Only a refusal
 * becomes visible (`failed`); there is no "are you sure?" phase, because the default is
 * save-and-close and the discard path is an explicit action of its own.
 */
export interface CloseRequest {
  /** The document being closed. */
  readonly path: string
  /** Its tab title, for the dialog. */
  readonly title: string
  readonly phase: 'saving' | 'failed'
  /** Why the save was refused, when `phase` is `failed`. */
  readonly message?: string | undefined
  /** The refusal was a compare-and-set conflict rather than a transport / permission failure. */
  readonly conflict?: boolean | undefined
}
