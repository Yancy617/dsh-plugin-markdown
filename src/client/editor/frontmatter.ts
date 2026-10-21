/**
 * YAML frontmatter 的保存：切分与拼回。
 *
 * 内容
 * - SplitMarkdown / splitFrontmatter(markdown) / joinFrontmatter(frontmatter, body)。
 * - FRONTMATTER_BLOCK：行首 --- 到行首 --- 的块（两条线之间可以是空的）。
 * - looksLikeFrontmatter：块里顶格的每一行都是空行 / 注释 / `key:`，且至少一个 key。
 *
 * 行为
 * - 只在文档开头匹配；两条 --- 之间必须像 YAML 映射才切走，否则整块按正文。
 * - split 切走 frontmatter，编辑器只收正文；join 原样拼回，正文没改时逐字节相同。
 * - 空正文时只返回 frontmatter，不额外加换行。
 * - 空块（只有空行）算 frontmatter；纯注释块不算。
 *
 * 边界
 * - 不解析 YAML：只判行形状，不校验值；顶格序列 / 流式映射 / `key:value`（冒号后没空格）
 *   会被当成正文。判据故意保守：把正文藏起来比把 frontmatter 显示出来贵得多。
 * - 不负责文档 Markdown 的读写（documentMarkdown.ts）。
 *
 * 相关文件
 * - 被依赖：MarkdownEditor.tsx、document.ts、outline.ts。
 *
 * 改哪里
 * - 改块匹配：FRONTMATTER_BLOCK。
 * - 改判据：looksLikeFrontmatter / NOT_A_KEY_START / KEY_LINE。
 * - 改拼回：joinFrontmatter。
 */

/** A document split into its optional frontmatter block and its body. */
export interface SplitMarkdown {
  /** The exact frontmatter text including both fences, or `null` when absent. */
  readonly frontmatter: string | null
  /** Everything after the frontmatter block, unchanged. */
  readonly body: string
}

/**
 * A leading `---` fence, an optional body, and a closing `---` fence at line start.
 * The body is optional so that an empty block (`---` immediately followed by `---`) is one
 * too. Anchored, so a thematic break that merely opens a document is not frontmatter unless
 * the block between the fences is shaped like a YAML mapping (see {@link looksLikeFrontmatter}).
 */
const FRONTMATTER_BLOCK = /^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/

/**
 * Line starts that cannot begin a YAML mapping key: each is a Markdown block marker or a YAML
 * indicator that is not allowed at the start of a plain scalar. A block with one at column 0
 * is ordinary content, not metadata.
 */
const NOT_A_KEY_START = /^(?:[+](?:[ \t]|$)|\*|\d+[.)][ \t]|>|\||\[|\{|<|!|&|%|@|`|~{3,})/

/** A top-level line shaped like `key: value` or `key:` — a colon followed by whitespace or EOL. */
const KEY_LINE = /^.+?:(?:[ \t]|$)/

/** A top-level sequence item (`- x`), allowed only where a key's value is a block sequence. */
const SEQUENCE_ITEM = /^-(?:[ \t]|$)/

/** A key whose value starts on the next line — the only place a top-level `- x` may follow. */
const EMPTY_VALUE_KEY = /:\s*(?:#.*)?$/

/**
 * Whether the text between the fences is shaped like a YAML mapping.
 *
 * Frontmatter is metadata, and in practice a YAML mapping. This does not parse YAML; it reads
 * the shape a mapping always has: every line at column 0 is blank, a comment, or `key: value`,
 * with at least one key. Anything else — a heading, a list, a table, a paragraph — means the
 * block is ordinary content that happens to sit between two thematic breaks; showing it is the
 * safe side, because a hidden paragraph is worse than a shown frontmatter.
 *
 * Known gaps, kept deliberately: a top-level sequence (`- a`), a flow mapping (`{a: b}`) and
 * `key:value` (no space after the colon) are shown as content even though YAML can read them.
 * A block of nothing but `Note: …` lines *is* a mapping, so it is still frontmatter — no
 * line-based rule can tell that apart from metadata.
 * @param content - the text between the opening and closing fences (may be empty).
 * @returns whether the block should be treated as frontmatter.
 */
function looksLikeFrontmatter(content: string): boolean {
  let keys = 0
  // YAML allows a block sequence at the same indentation as its key (`tags:` then `- a`),
  // which is a common frontmatter style (Hugo's own examples use it). `- a` is only a valid
  // continuation right after a key whose value is empty.
  let sequence = false
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.replace(/\r$/, '')
    if (line.trim() === '') continue
    if (/^\s/.test(line)) continue
    if (line.startsWith('#')) continue
    if (SEQUENCE_ITEM.test(line)) {
      if (!sequence) return false
      continue
    }
    if (NOT_A_KEY_START.test(line)) return false
    if (!KEY_LINE.test(line)) return false
    keys += 1
    sequence = EMPTY_VALUE_KEY.test(line)
  }
  // An empty block is still frontmatter (Jekyll's empty front matter); a block with only
  // comments is not — `# 标题` is equally a YAML comment and a Markdown heading, and showing
  // it is the safer failure.
  return keys > 0 || content.trim() === ''
}

/**
 * Split a document into frontmatter and body.
 * @param markdown - full document text.
 * @returns the split halves; `frontmatter` is `null` when no block is present.
 */
export function splitFrontmatter(markdown: string): SplitMarkdown {
  const match = FRONTMATTER_BLOCK.exec(markdown)
  if (match === null) return { frontmatter: null, body: markdown }
  // A block that does not look like a YAML mapping is content that merely starts with a
  // thematic break and has another one later; keep the whole document intact.
  if (!looksLikeFrontmatter(match[1] ?? '')) return { frontmatter: null, body: markdown }
  const block = match[0]
  return {
    // One terminator belongs to the boundary, not to the block; stripping only `\n` would leave
    // the `\r` of a CRLF fence behind and the join would double it.
    frontmatter: block.replace(/\r?\n$/, ''),
    body: markdown.slice(block.length),
  }
}

/**
 * Re-attach a frontmatter block to a body.
 *
 * The split consumed exactly one line terminator after the closing fence, so the join restores
 * exactly one — **in the file's own spelling**: a CRLF document stays CRLF on the fence boundary
 * instead of acquiring a single LF. The terminator is read from the two halves because the split
 * deliberately keeps neither.
 * @param frontmatter - block returned by {@link splitFrontmatter}.
 * @param body - edited body text.
 * @returns the document, byte-identical to the source when `body` is unchanged.
 */
export function joinFrontmatter(frontmatter: string | null, body: string): string {
  if (frontmatter === null) return body
  // A fence with nothing after it cannot have consumed a terminator.
  if (body === '') return frontmatter
  const eol = frontmatter.includes('\r\n') || body.includes('\r\n') ? '\r\n' : '\n'
  return `${frontmatter}${eol}${body}`
}
