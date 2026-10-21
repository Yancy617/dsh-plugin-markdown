/**
 * 把一份文档的撤销历史接到当前编辑器上。
 *
 * 内容
 * - DocumentHistoryPlugin：在 Lexical 上下文里注册 `registerHistory`，并处理跨编辑器重挂。
 * - adoptHistory / primeHistory。
 *
 * 行为
 * - 每条历史条目都带一个编辑器引用；编辑器重挂后先把这些引用改成本次挂载的编辑器，再注册历史。
 * - 新会话没有当前条目时，用本次编辑器的初始状态补上，保证“打开后的第一次编辑”也能撤销。
 * - 深度与合并窗口是这里的两个常量，只有这一份。
 * - 只在本编辑器挂载期间注册；卸载后历史对象留在文档会话里。
 *
 * 边界
 * - 不创建 / 保存文档，不决定历史何时丢弃（关闭、删除、重新载入由工作台调 sessions.forget）。
 * - 不负责源码视图；源码视图只读查看，不进入撤销。
 *
 * 相关文件
 * - 被依赖：MarkdownEditor.tsx。
 * - 依赖：@lexical/history、@lexical/react、lexical、documentSessions.ts。
 *
 * 改哪里
 * - 改历史接入：DocumentHistoryPlugin。
 * - 改跨编辑器重挂：adoptHistory / primeHistory。
 */
import { registerHistory, type HistoryState } from '@lexical/history'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import type { LexicalEditor } from 'lexical'
import { useEffect } from 'react'

/**
 * Undo stack depth, in logical steps.
 *
 * A step is not a keystroke: Lexical coalesces continuous typing inside {@link HISTORY_DELAY_MS}.
 * 100 is the product's ceiling; older steps are evicted FIFO.
 */
export const HISTORY_LIMIT = 100

/**
 * How long adjacent typing stays in the same undo step.
 *
 * Lexical's own continuous-typing coalescing is the reason a 100-step cap is usable at all;
 * changing this changes how much writing one undo gesture covers.
 */
export const HISTORY_DELAY_MS = 1000

/**
 * Point every existing history entry at the editor that is mounted now.
 *
 * Lexical's history entries are `{ editor, editorState }` and undo calls
 * `entry.editor.setEditorState(...)`. After a tab switch or a panel remount the old entry still
 * names the old editor, so the references have to move with the history.
 * @param history - the document's history.
 * @param editor - the editor it is being attached to.
 */
export function adoptHistory(history: HistoryState, editor: LexicalEditor): void {
  if (history.current !== null) history.current.editor = editor
  for (const entry of history.undoStack) entry.editor = editor
  for (const entry of history.redoStack) entry.editor = editor
}

/**
 * Make the editor's starting state the first undoable step.
 *
 * Without this, the first edit after opening a document has no `current` entry to push, so it
 * cannot be undone. The initial import happens before this plugin mounts, which is exactly why
 * the entry is primed here rather than left to the first user update.
 * @param history - the document's history.
 * @param editor - the editor that has just mounted.
 */
export function primeHistory(history: HistoryState, editor: LexicalEditor): void {
  if (history.current !== null) return
  history.current = { editor, editorState: editor.getEditorState() }
}

/**
 * Register one document's undo/redo history on the mounted editor.
 * @param props.history - the history of the document this editor shows.
 * @returns nothing rendered.
 */
export function DocumentHistoryPlugin({
  history,
}: {
  readonly history: HistoryState
}): null {
  const [editor] = useLexicalComposerContext()

  useEffect(() => {
    adoptHistory(history, editor)
    primeHistory(history, editor)
    return registerHistory(
      editor,
      history,
      HISTORY_DELAY_MS,
      Date.now,
      undefined,
      HISTORY_LIMIT,
    )
  }, [editor, history])

  return null
}
