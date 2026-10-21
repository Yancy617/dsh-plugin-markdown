/**
 * 活过面板卸载的工作台状态。
 *
 * 内容
 * - WorkbenchStore<T> / createWorkbenchStore<T>。
 *
 * 行为
 * - main slot 有 key，切走会卸载面板；store 在插件生命周期内保留一个值。
 * - read() 在写入前返回 null；write() 替换整个值。
 *
 * 边界
 * - 不做持久化：刷新 / 重启即清空。
 * - 不恢复编辑器内部状态（滚动、光标、撤销）。
 *
 * 相关文件
 * - 被依赖：index.tsx、MarkdownWorkbench.tsx、workbench/useWorkbenchSnapshot.ts。
 *
 * 改哪里
 * - 改存储：createWorkbenchStore。
 */

/** A handed-over value store scoped to one plugin lifetime. */
export interface WorkbenchStore<T> {
  /**
   * @returns the current value, or `null` before anything was written.
   */
  read(): T | null

  /**
   * Replace the value.
   * @param value - the state to remember.
   */
  write(value: T): void
}

/**
 * Create a store.
 * @returns a store whose value starts unset.
 */
export function createWorkbenchStore<T>(): WorkbenchStore<T> {
  let value: T | null = null
  return {
    read: () => value,
    write: next => {
      value = next
    },
  }
}
