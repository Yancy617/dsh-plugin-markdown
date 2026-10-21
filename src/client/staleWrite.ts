/**
 * 版本冲突只看内容是否不同；行尾与 BOM 不算内容。
 *
 * 内容
 * - StaleVerdict / classifyStaleWrite。
 *
 * 行为
 * - 先去掉文件开头的 BOM，再把 CRLF / CR 折成 LF，然后比较内容。
 * - 折完之后等于这次要写的内容 ⇒ `same-as-target`：文件里已经是目标内容，不用再写。
 * - 折完之后等于上次保存的内容 ⇒ `same-as-saved`：内容没变，只是版本令牌 / 行尾拼写被
 *   外部动作碰了，用新令牌重试一次。
 * - 其余 ⇒ `different`：内容真的不同，按冲突处理。
 *
 * 边界
 * - **空段落是内容**：外部增删空行会让折完之后的文本不同，仍按冲突处理。
 * - 不读文件、不写盘、不判断重试；调用方负责读与重试。
 *
 * 相关文件
 * - 被依赖：MarkdownWorkbench.tsx 的 writeActive。
 * - 依赖：无。
 *
 * 改哪里
 * - 改比较口径：classifyStaleWrite / comparable。
 */
export type StaleVerdict = 'same-as-target' | 'same-as-saved' | 'different'

/**
 * Text as it should be compared across an external editor: BOM and line-ending style are
 * presentation, not document content. Blank lines and paragraphs are deliberately left alone.
 * @param text - raw file / buffer text.
 * @returns the comparable form.
 */
function comparable(text: string): string {
  return text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
}

/**
 * Classify a stale-version refusal by comparing the file's current text with the two texts the
 * writer already knows.
 *
 * The only conflict decision is "different"; the two same-content outcomes only decide whether
 * the caller needs to write again.
 * @param fresh - the file's content, read after the refusal.
 * @param saved - the text the buffer believes is on disk.
 * @param outgoing - the text this write was trying to send.
 * @returns whether the content is already the target, still the saved text, or different.
 */
export function classifyStaleWrite(
  fresh: string,
  saved: string,
  outgoing: string,
): StaleVerdict {
  const current = comparable(fresh)
  if (current === comparable(outgoing)) return 'same-as-target'
  if (current === comparable(saved)) return 'same-as-saved'
  return 'different'
}
