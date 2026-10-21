/**
 * 文档移动后，重拼它自己的图片目标。
 *
 * 内容
 * - relinkImages(text, from, to, vaultRoot)。
 * - imagePattern / destinationRange（私有）。
 *
 * 行为
 * - 只改本地、相对、落在仓库内的目的地；远程 / 绝对 / 越界原样。
 * - 只动目的地那几段字节，其余字节原样复制。
 * - 有尖括号的保留尖括号；裸的按 authoredInside 的判据重拼。
 * - 同一深度移动时字节不变。
 *
 * 边界
 * - 不 import 编辑器模型、不重导出整篇（避免碰别的构造）。
 * - 不移动图片文件本身。
 *
 * 相关文件
 * - 依赖：shared/paths、imageSyntax（纯语法）、imagePath。
 * - 被依赖：MarkdownWorkbench（移动入口）。
 *
 * 改哪里
 * - 改扫描：imagePattern。
 * - 改定位：destinationRange。
 * - 改重拼：relinkImages。
 */
import { relativePath } from '../../shared/paths'
import { IMAGE_PATTERN, authoredInside, parseImageInside } from './imageSyntax'
import { relativeDestination, resolveDestination, unescapeDestination } from './imagePath'

/**
 * The authored destination's raw range inside an image's parentheses.
 *
 * `parseImageInside` reports the destination but not where it sat, and the two ways of
 * finding it without a second parsing rule are exact rather than lucky:
 *
 * - the destination it returns is a **substring** of the inside, either the bare token
 *   or what the angle brackets held, so `indexOf` finds it;
 * - nothing before it can equal it: everything there is space or tab (`BLANK`), and a
 *   destination that parsed successfully is not empty here (an empty one is skipped by
 *   the caller).
 *
 * The bracket form is recognised from the text before the destination rather than from
 * the parse result, because the parse result has already lost it — and the style is
 * worth keeping: `<x.png>` and `x.png` mean the same thing, so a destination that does
 * not need brackets is not made to grow them by a move.
 * @param inside - text between the parentheses, verbatim.
 * @param destination - the destination `parseImageInside` reported, unescaped.
 * @returns the raw range and whether it was bracketed, or `null` when it cannot be found.
 */
function destinationRange(
  inside: string,
  destination: string,
): { readonly start: number; readonly end: number; readonly bracketed: boolean } | null {
  if (destination === '') return null
  const at = inside.indexOf(destination)
  if (at === -1) return null
  return {
    start: at,
    end: at + destination.length,
    bracketed: inside.slice(0, at).trimEnd().endsWith('<'),
  }
}

/**
 * Re-spell one document's own local image destinations for a new directory.
 *
 * Every destination that is **relative and resolves inside the vault** is spelled again
 * from `to`; everything else is left exactly as written — a remote address, an absolute
 * path and a relative one that leaves the vault do not depend on where the note sits,
 * and a destination this plugin cannot spell is not one to invent a spelling for.
 * @param text - the document's complete text, as saved on disk.
 * @param from - absolute path the text was read from.
 * @param to - absolute path it is about to be moved to.
 * @param vaultRoot - the authorized root; destinations resolving outside it are not ours.
 * @returns the text with the affected destinations re-spelled; byte-identical when none
 *   are affected, which is what makes "same depth" moves free.
 */
export function relinkImages(text: string, from: string, to: string, vaultRoot: string): string {
  const scan = new RegExp(IMAGE_PATTERN, 'g')
  let out = ''
  let copied = 0
  for (const match of text.matchAll(scan)) {
    const whole = match[0]
    const alt = match[1] ?? ''
    const inside = match[2] ?? ''
    const start = match.index
    const target = parseImageInside(inside)
    if (target === null) continue
    const destination = unescapeDestination(target.destination)
    if (destination === '') continue
    const resolved = resolveDestination(from, destination)
    if (resolved.kind !== 'local') continue
    const within = relativePath(vaultRoot, resolved.path)
    if (within === null || within === '') continue
    const next = relativeDestination(to, resolved.path)
    if (next === destination) continue
    const spelling = authoredInside(next)
    if (spelling === null) continue
    const range = destinationRange(inside, target.destination)
    if (range === null) continue
    // A bracketed destination keeps its brackets: only the text between them changes,
    // and `<x.png>` reads back exactly as `x.png` does — so what goes in is the bare
    // destination, never the bracketed spelling (that would nest two pairs). A bare one
    // takes whatever `authoredInside` decided, which is the only case where the style
    // can change at all.
    const patched =
      inside.slice(0, range.start) +
      (range.bracketed ? next : spelling) +
      inside.slice(range.end)
    // `![` + alt + `](` are the four bytes before the inside, by the pattern's own
    // shape; nothing else in the match can be mistaken for them.
    const insideAt = alt.length + 4
    out += text.slice(copied, start) + whole.slice(0, insideAt) + patched + whole.slice(insideAt + inside.length)
    copied = start + whole.length
  }
  return copied === 0 ? text : out + text.slice(copied)
}
