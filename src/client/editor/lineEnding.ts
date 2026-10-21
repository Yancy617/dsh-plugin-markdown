/**
 * 文件行尾：新写出来的内容用哪一种换行。
 *
 * 内容
 * - eolOf(source)：CRLF 文件用 `\r\n`，其余用 `\n`。
 *
 * 行为
 * - 只看源里有没有 CRLF；不改写、不归一化原文。
 *
 * 边界
 * - 不负责读写文件，也不负责把已有字节换算成行尾。
 *
 * 相关文件
 * - 被依赖：MarkdownEditor.tsx、blockSave.ts。
 *
 * 改哪里
 * - 改判据：eolOf。
 */

/**
 * @param source - 正文。
 * @returns 新内容使用的行尾。
 */
export function eolOf(source: string): '\n' | '\r\n' {
  return source.includes('\r\n') ? '\r\n' : '\n'
}
