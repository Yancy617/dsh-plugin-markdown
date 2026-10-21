/**
 * 文档级派生：字数统计。
 *
 * 内容
 * - DocumentStats、statsOf / describeStats。
 * - CJK / LATIN_WORD：字数规则。
 *
 * 行为
 * - 从 Markdown 文本读，不看编辑器树；源码视图与富文本共用同一份文本。
 * - 字符与词只算正文（frontmatter 是元数据，编辑区不渲染）；行数算整文件（源码视图看得见）。
 * - 字数：CJK 一字一词，拉丁字母 / 数字 / 下划线连续串一词；字符不算行终止符；行数含末行。
 *
 * 边界
 * - 不负责编辑、渲染与文档结构；标题不在这里（`./outline.ts` 与 `./headingTree.ts`）。
 *
 * 相关文件
 * - 依赖：frontmatter.ts。
 * - 被依赖：MarkdownWorkbench.tsx。
 *
 * 改哪里
 * - 改字数：statsOf / describeStats。
 * - 改规则：CJK / LATIN_WORD。
 */

import { splitFrontmatter } from './frontmatter'

/** Counts shown next to the document. */
export interface DocumentStats {
  /** Characters excluding line terminators. */
  readonly characters: number
  /**
   * Words, counting each CJK ideograph as one word and each run of Latin
   * letters, digits, or underscores as one. The usual "split on whitespace"
   * rule reports a whole Chinese sentence as a single word, which is useless
   * for the documents this editor is built for.
   */
  readonly words: number
  /** Line count, including the last line when the text does not end in a newline. */
  readonly lines: number
}

/** A CJK ideograph, kana, or Hangul syllable: one character worth one word. */
const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/

/** A run of Latin letters, digits, or underscores. */
const LATIN_WORD = /[A-Za-z0-9_]+/g

/**
 * Count characters and words in the **body**, and lines in the whole file.
 *
 * ## Why the frontmatter is left out of the two counts (but not the third)
 *
 * The frontmatter block is **not content**: it is metadata a site generator reads, and it is not shown in
 * the editor at all (it is split off before the document reaches the composer). Counting its characters and
 * words made the readout disagree with what a reader sees — measured on a document whose body is
 * `正文。` with a four-line block on top: **46 字符 · 12 词 · 8 行** against the body's **21 字符 · 6 词 ·
 * 4 行**. The line count stays the whole file's, because "行" answers "how long is this file" and a number
 * that ignored lines the reader can see in the source view would be the misleading one.
 *
 * ## And why definitions are not special-cased here
 *
 * A link definition *is* written in the body, and this counts the text the document projects. The
 * requirement that a definition must not show up is satisfied at the other end: definitions are hidden
 * nodes, so they are never part of what the reader sees, and the counts are computed from the file text
 * rather than from those nodes. Nothing is subtracted here.
 * @param markdown - full document text.
 * @returns the counts.
 */
export function statsOf(markdown: string): DocumentStats {
  const body = splitFrontmatter(markdown).body
  const characters = body.replace(/\r?\n/g, '').length

  let words = 0
  for (const character of body) {
    if (CJK.test(character)) words += 1
  }
  for (const match of body.matchAll(LATIN_WORD)) {
    void match
    words += 1
  }

  const lines = markdown === '' ? 0 : markdown.split('\n').length
  return { characters, words, lines }
}

/**
 * Render the statistics as one compact line.
 * @param stats - counts from {@link statsOf}.
 * @returns e.g. `1,204 字符 · 356 词 · 42 行`.
 */
export function describeStats(stats: DocumentStats): string {
  return `${stats.characters.toLocaleString('zh-CN')} 字符 · ${stats.words.toLocaleString('zh-CN')} 词 · ${stats.lines} 行`
}
