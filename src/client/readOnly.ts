/**
 * 哪一篇打开的文档拒绝编辑。
 *
 * 内容
 * - DocumentOrigin / readOnlyDocument。
 *
 * 行为
 * - 两个事实取或：buffer.sample（文本来自插件包）或 vaultKind !== 'user'（根不是用户选的）。
 * - 每个写入口都问这一个函数：写路径、空闲计时、卸载 beacon、保存答复、编辑器。
 *
 * 边界
 * - 不负责“怎么写”与版本比较（MarkdownWorkbench）。
 *
 * 相关文件
 * - 被依赖：MarkdownWorkbench.tsx、MarkdownEditor.tsx、FindBar.tsx、probe-units。
 *
 * 改哪里
 * - 改判据：readOnlyDocument。
 */

/** The one fact this rule needs from an open document. */
export interface DocumentOrigin {
  /** Whether the text came out of this package rather than out of the writer's directory. */
  readonly sample: boolean
}

/**
 * Whether one open document refuses edits.
 * @param buffer - the open document.
 * @param vaultKind - where the authorized root came from, or `null` when nothing is authorized.
 * @returns whether the document is read-only.
 */
export function readOnlyDocument(
  buffer: DocumentOrigin,
  vaultKind: 'sample' | 'user' | null,
): boolean {
  return buffer.sample || vaultKind !== 'user'
}
