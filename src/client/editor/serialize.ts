/**
 * 标准写手：mdast 块 / 根 ⇒ 标准 GFM。
 *
 * 内容
 * - BlockWriteOptions：逐块写时覆盖的列表标记。
 * - serializeBlock(node, options)：一个块 ⇒ 不带末尾换行的 Markdown。
 * - serializeRoot(root)：一个 mdast 根 ⇒ 标准 Markdown。
 *
 * 行为
 * - 只做“mdast → 文本”；不判断块有没有改、不解析、不认识 Lexical。
 * - 选项一次定死：`-` 无序、`*` 强调、`` ` `` 围栏、`-` 分割线、GFM 扩展。
 * - 相邻列表的标记由调用方通过 BlockWriteOptions 覆盖；根级写手自己知道相邻列表。
 *
 * 边界
 * - 不读文件、不写文件；不碰 Lexical / React。
 *
 * 相关文件
 * - 被依赖：mdastLift.ts（再导出给旧调用方）、standardize.ts、blockSave.ts、projection.ts。
 * - 依赖：mdast-util-to-markdown、mdast-util-gfm。
 *
 * 改哪里
 * - 改标准写法：SERIALIZE_OPTIONS。
 */
import { toMarkdown, type Options as ToMarkdownOptions } from 'mdast-util-to-markdown'
import { gfmToMarkdown } from 'mdast-util-gfm'
import type { Content, Root } from 'mdast'

/** 逐块写时可覆盖的列表标记；根级写手不需要。 */
export interface BlockWriteOptions {
  readonly bullet?: ToMarkdownOptions['bullet']
  readonly bulletOrdered?: ToMarkdownOptions['bulletOrdered']
}

/** 标准 GFM 的写出选项；一次定死，所有改过的块共用。 */
const SERIALIZE_OPTIONS: ToMarkdownOptions = {
  bullet: '-',
  emphasis: '*',
  strong: '*',
  fence: '`',
  rule: '-',
  extensions: [gfmToMarkdown()],
}

/**
 * 一个块 ⇒ 标准 Markdown。
 * @param node - mdast 块。
 * @param options - 逐块写时覆盖的列表标记。
 * @returns 不带末尾换行的 Markdown 文本。
 */
export function serializeBlock(node: Content, options?: BlockWriteOptions): string {
  return toMarkdown(node, { ...SERIALIZE_OPTIONS, ...options }).replace(/\n$/, '')
}

/**
 * 一个 mdast 根 ⇒ 标准 Markdown。
 *
 * 根级写手知道“相邻列表要用不同标记”，所以相邻的两张列表不会被重解合并。
 * @param root - mdast 根。
 * @returns 标准 Markdown，不含末尾换行。
 */
export function serializeRoot(root: Root): string {
  return toMarkdown(root, SERIALIZE_OPTIONS).replace(/\n$/, '')
}
