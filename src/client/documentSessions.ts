/**
 * 每篇打开的文档的编辑会话：撤销/重做历史、块级保存基线，以及它们跨视图存活的规则。
 *
 * 内容
 * - DocumentSessions / createDocumentSessions。
 *
 * 行为
 * - 按绝对路径给每篇打开的文档一份 Lexical `HistoryState` 与一份 `SourceBase`（每个顶层块的
 *   原文 span + 指纹）；同一篇在标签切换、源码/富文本切换、面板卸载重挂后仍拿到同一份。
 * - `ensure` / `ensureBase` 懒创建；`forget` 在文档关闭 / 删除 / 重新载入时丢掉；
 *   `repath` 在改名 / 移动后改写键，子树一起改。
 * - 只在内存里，不写 `.md`、不写 localStorage；插件重载即清空。
 *
 * 边界
 * - 不创建编辑器、不注册监听、不决定什么时候保存。
 * - 不保存正文与保存状态（那是 workbench 的 buffers）；这里只有撤销/重做与保存基线。
 *
 * 相关文件
 * - 被依赖：MarkdownWorkbench.tsx、index.tsx、editor/historySession.ts、editor/MarkdownEditor.tsx。
 * - 依赖：@lexical/history 的 HistoryState / createEmptyHistoryState、editor/saveBase（纯模型，不拉保存层）、
 *   workbench/repath。
 *
 * 改哪里
 * - 改会话生命周期：ensure / ensureBase / forget / repath 的调用方。
 */
import { createEmptyHistoryState, type HistoryState } from '@lexical/history'
import { createSourceBase, type SourceBase } from './editor/saveBase'
import { repathUnder } from './workbench/repath'

/** The undo/redo history of every open document, keyed by absolute path. */
export interface DocumentSessions {
  /**
   * The history for one open document, created empty on first use.
   * @param path - absolute document path.
   * @returns its history; the same object until forgotten.
   */
  ensure(path: string): HistoryState

  /**
   * @param path - absolute document path.
   * @returns its history, or `undefined` when no session exists.
   */
  get(path: string): HistoryState | undefined

  /**
   * The block-level save baseline for one open document, created empty on first use.
   *
   * Kept beside the history because both describe the same editing session: a tab switch or a
   * composer remount must keep the byte spans that let unchanged blocks stay untouched, and a
   * reload / source-view edit must drop them together with the undo stack.
   * @param path - absolute document path.
   * @returns its baseline; the same object until forgotten.
   */
  ensureBase(path: string): SourceBase

  /**
   * Drop one document's history and save baseline. Called when the document closes, is deleted,
   * or is reloaded.
   * @param path - absolute document path.
   */
  forget(path: string): void

  /**
   * Re-key every history at or under a path that moved, so a rename / folder move keeps undo.
   * @param from - the path the entry had.
   * @param to - the path it has now.
   */
  repath(from: string, to: string): void
}

/**
 * Create the in-memory session table for one plugin lifetime.
 * @returns an empty session table.
 */
export function createDocumentSessions(): DocumentSessions {
  const sessions = new Map<string, HistoryState>()
  const bases = new Map<string, SourceBase>()
  return {
    ensure(path) {
      let history = sessions.get(path)
      if (history === undefined) {
        history = createEmptyHistoryState()
        sessions.set(path, history)
      }
      return history
    },
    get: path => sessions.get(path),
    ensureBase(path) {
      let base = bases.get(path)
      if (base === undefined) {
        base = createSourceBase()
        bases.set(path, base)
      }
      return base
    },
    forget: path => {
      sessions.delete(path)
      bases.delete(path)
    },
    repath: (from, to) => {
      for (const [path, history] of [...sessions]) {
        const moved = repathUnder(path, from, to)
        if (moved === null || moved === path) continue
        sessions.delete(path)
        sessions.set(moved, history)
      }
      for (const [path, base] of [...bases]) {
        const moved = repathUnder(path, from, to)
        if (moved === null || moved === path) continue
        bases.delete(path)
        bases.set(moved, base)
      }
    },
  }
}
