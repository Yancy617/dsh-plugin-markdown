/**
 * 行内图片的**源语法**：括号里那一串怎么读、插图片时该写哪一种拼法。
 *
 * 内容
 * - ImageTarget / parseImageInside：读 `![alt](inside)` 的 inside（目的地与标题）。
 * - authoredInside：插入时按目的地选尖括号还是裸形态。
 * - IMAGE_PATTERN：扫源文本用的整条模式（`imageRelink.ts` 用）。
 *
 * 行为
 * - `parseImageInside` 按 CommonMark §6.6（链接目的地与标题）读；裸目的地不能含空白。
 * - `authoredInside` 只有在目的地含空格 / 括号时才选尖括号；含 `<` / `>` 的答 `null`（写不回去）。
 * - 整串 `inside` 由 `ImageNode` 原样保存，这里只回答“它**是不是**一个图片目的地”。
 *
 * 边界
 * - 不建节点、不渲染、不解析地址（imagePath.ts）。
 * - 纯函数 + 一个正则：不 import React、不 import Lexical，`imageRelink.ts` 与 `ImageDialog.tsx` 共用。
 *
 * 相关文件
 * - 被依赖：ImageDialog.tsx（插入校验）、imageRelink.ts（移动时重拼）、image.tsx（节点创建时的目的地解码）。
 *
 * 改哪里
 * - 改读法：parseImageInside。
 * - 改拼法：authoredInside / IMAGE_PATTERN。
 */

/** One destination as the source wrote it. */
export interface ImageTarget {
  /** Destination with any `<>` removed; not decoded. */
  readonly destination: string
  /** Title without its quotes, or `null` when there is none. */
  readonly title: string | null
}

/**
 * 目的地各段之间的空白：空格、制表符，以及行尾（§6.6）。
 * 行尾是分隔符，不是目的地的一部分；不认它会让裸目的地把换行吃进去，
 * 写回时要么进尖括号、要么每存一次多一个空行。
 */
const BLANK = /[ \t\n]/

/**
 * Read the text between an inline image's parentheses the way CommonMark does.
 *
 * The whole inside is kept by the node and written back untouched; this only
 * decides whether the inside **is** an image destination at all.
 * @param inside - text between the destination's parentheses, verbatim.
 * @returns the destination and title, or `null` when this is not an image.
 */
export function parseImageInside(inside: string): ImageTarget | null {
  let at = 0
  const skipBlank = (): void => {
    while (at < inside.length && BLANK.test(inside.charAt(at))) at += 1
  }

  skipBlank()
  let destination: string
  if (inside.charAt(at) === '<') {
    const close = inside.indexOf('>', at + 1)
    if (close === -1) return null
    destination = inside.slice(at + 1, close)
    at = close + 1
  } else {
    const start = at
    // A bare destination ends at the first whitespace, so `my file.png` yields
    // `my` and the rest stops being a title below — which is exactly why the
    // reference implementation reads that whole line as text.
    while (at < inside.length && !BLANK.test(inside.charAt(at))) at += 1
    destination = inside.slice(start, at)
  }

  skipBlank()
  if (at >= inside.length) return { destination, title: null }

  const opener = inside.charAt(at)
  const closer = opener === '(' ? ')' : opener
  if (opener !== '"' && opener !== "'" && opener !== '(') return null
  /*
   * 收尾引号是第一个未被转义的：CommonMark §6.6 里 \" 是转义引号，不是收尾。
   * 判据是前面有偶数个反斜杠；不认它会把合法标题判成不合法。
   */
  const close = indexOfUnescaped(inside, closer, at + 1)
  if (close === -1) return null
  const title = inside.slice(at + 1, close)
  at = close + 1
  skipBlank()
  if (at !== inside.length) return null
  /*
   * 标题里含反斜杠 ⇒ 答 null（认得出，但写不回去）。
   * 标题的引号种类与转义不在 LinkAttributes 里，写手只会用一种拼法重写；硬建会每存一次翻倍。
   * 答 null 让它落到 rawInline，字节不变。目的地不受这条限制（节点存源原文）。
   */
  if (title.includes('\\')) return null
  return { destination, title }
}

/**
 * `text` 里从 `from` 起**第一个未被反斜杠转义**的 `char`。
 *
 * "未被转义"= 它前面有**偶数**个连续反斜杠（`\"` 是转义的引号，`\\"` 是"一个反斜杠 + 收尾引号"）。
 * @param text - 要扫的字符串。
 * @param char - 要找的字符（单字符）。
 * @param from - 起扫下标。
 * @returns 下标，或 `-1`。
 */
function indexOfUnescaped(text: string, char: string, from: number): number {
  for (let at = from; at < text.length; at += 1) {
    if (text.charAt(at) !== char) continue
    let backslashes = 0
    for (let back = at - 1; back >= 0 && text.charAt(back) === '\\'; back -= 1) backslashes += 1
    if (backslashes % 2 === 0) return at
  }
  return -1
}

/**
 * The authored inside for a destination someone typed or pasted into the dialog.
 *
 * The bare form is what every other editor writes, so it is the default; the angle-bracket form is the
 * only spelling CommonMark allows a space or a parenthesis in, which is exactly where a file name from
 * a screenshot lands. Angle brackets cannot themselves be escaped inside that form, so a destination
 * carrying one is refused rather than written as something that would read back as literal text.
 * @param destination - what the writer typed.
 * @returns the inside to store, or `null` when it cannot be spelled.
 */
export function authoredInside(destination: string): string | null {
  if (/[<>]/.test(destination)) return null
  return /[\s()]/.test(destination) ? `<${destination}>` : destination
}

/**
 * 一个目的地：尖括号形态，或裸形态（可含配平括号）。
 *
 * 裸目的地不许以 < 开头（§6.3）；没有这一条，`[^()\s]*` 会把 `<a\_b` 整段吞下来，
 * 被认领又拒收的那一段此后没人接手，里面的反斜杠每存一次翻一倍。
 * 两个形态只写这一份，供下面的链接类模式共用。
 */
const DESTINATION = String.raw`<[^<>\n]*>|(?!<)[^()\s]*(?:\([^()\n]*\)[^()\s]*)*`

/** A title in any of the three spellings CommonMark allows. */
const TITLE = String.raw`"[^"\n]*"|'[^'\n]*'|\([^()\n]*\)`

/** The source pattern `imageRelink.ts` scans documents with. */
export const IMAGE_PATTERN = String.raw`(?<!\\)!\[([^[\]]*)\]\((\s*(?:${DESTINATION})(?:\s+(?:${TITLE}))?\s*)\)`
