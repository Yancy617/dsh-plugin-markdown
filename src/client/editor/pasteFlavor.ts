/**
 * 剪贴板两种形态里哪一形态说了算。
 *
 * 内容
 * - PasteFlavor / ClipboardFlavors / pasteFlavor。
 *
 * 行为
 * - 纯文本为空 → html；html 为空 → markdown。
 * - HTML 按本编辑器读成 Markdown 后与纯文本比：一样 → markdown，不一样 → html。
 * - HTML 建不出节点 → markdown（否则粘贴静默无事发生）。
 * - 比较前只归一 CRLF 与末尾空白，不动行内空格。
 *
 * 边界
 * - 不负责读剪贴板、不负责插入（PasteMarkdownPlugin.tsx）。
 * - 不负责 HTML → Markdown 的转换本身（htmlMarkdown.ts）；这一层只拿一条已经算好的结果去比。
 * - 纯函数、零依赖：`probe-units` 直接钉住它。
 *
 * 相关文件
 * - 被依赖：PasteMarkdownPlugin.tsx、scripts/probe-units.ts。
 *
 * 改哪里
 * - 改判据：pasteFlavor。
 */

/** 这次粘贴按哪一形态读：`markdown` = `text/plain` 当 Markdown 解析；`html` = 交给内置处理。 */
export type PasteFlavor = 'markdown' | 'html'

/** 剪贴板的三种形态：两种原始形态，以及 HTML 那一边按本编辑器读出来的 Markdown。 */
export interface ClipboardFlavors {
  /** `text/html` 形态，空串表示剪贴板没给。 */
  readonly html: string
  /** `text/plain` 形态，换行已归一（CRLF 是 Windows 剪贴板加的，不是内容）。 */
  readonly text: string
  /** `htmlMarkdown.ts` 的 `$htmlFlavorAsMarkdown` 结果（它建不出任何节点时是空串）。 */
  readonly htmlAsMarkdown: string
}

/**
 * 这次粘贴按哪一形态读。
 *
 * 纯函数：三份字符串进出，不碰 Lexical、不碰 DOM —— `probe:units` 直接钉住它。
 * @param flavors - 剪贴板的三种形态。
 * @returns `markdown` 或 `html`。
 */
export function pasteFlavor({ html, text, htmlAsMarkdown }: ClipboardFlavors): PasteFlavor {
  // 没有文本可解析：只有图片 / 文件的粘贴、只有标记没有字的粘贴都从这里过，交给内置。
  if (text.trim() === '') return 'html'
  // 只有纯文本（DSH 对话的复制按钮就是这一种）：没有第二种说法要问。
  if (html.trim() === '') return 'markdown'
  const asMarkdown = comparable(htmlAsMarkdown)
  // HTML 读出来是空：它建不出任何节点，也就没有可说的东西。`$defaultHtmlImporter` 会认领粘贴
  // 却插进 0 个节点（`<img>` 没有导入规则），于是粘贴静默无事发生；按纯文本解析至少把字符留下。
  if (asMarkdown === '') return 'markdown'
  return asMarkdown === comparable(text) ? 'markdown' : 'html'
}

/**
 * 比之前先抹平的那点差别：剪贴板的换行，以及末尾的空白。
 *
 * **只抹末尾**：行内多一个空格可能是有意思的（Markdown 的行尾两个空格是硬换行），不能一起抹。
 * @param markdown - 一种形态读出来的 Markdown。
 * @returns 可以逐字符比较的那一份。
 */
function comparable(markdown: string): string {
  return markdown.replace(/\r\n?/g, '\n').replace(/\s+$/, '')
}
