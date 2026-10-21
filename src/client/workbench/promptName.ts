/**
 * 新建 / 改名对话框最终会创建或改成的完整名字。
 *
 * 内容
 * - promptEntryName。
 *
 * 行为
 * - 新建文档：没有扩展名就补 `.md`；新建文件夹：原样。
 * - 改名文档：格式由原文件接回；改名文件夹：原样。
 * - 输入为空 ⇒ 空串，调用方据此禁用提交。
 *
 * 边界
 * - 只算名字，不判合法性（shared/entryName）、不判重名、不发请求。
 *
 * 相关文件
 * - 依赖：workbench/model 的 PromptState、shared/documents。
 * - 被依赖：Dialogs.tsx（输入时的提示）、useTreeOperations.ts（提交）。
 *
 * 改哪里
 * - 改四种 prompt 各自的名字：promptEntryName。
 */
import { createdDocumentName, renamedDocumentName } from '../../shared/documents'
import type { PromptState } from './model'

/**
 * The complete basename a prompt would create or rename to.
 * @param prompt - which prompt is open.
 * @param typedName - the name field's raw value.
 * @returns the basename, or `''` before anything was typed.
 */
export function promptEntryName(prompt: PromptState, typedName: string): string {
  const typed = typedName.trim()
  if (typed === '') return ''
  if (prompt.kind === 'rename') {
    return prompt.target.isDirectory ? typed : renamedDocumentName(prompt.target.name, typed)
  }
  if (prompt.kind === 'directory') return typed
  return createdDocumentName(typed)
}
