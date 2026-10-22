/**
 * 顶层块的源坐标：把 mdast 的 position 修成可切片的 span。
 *
 * 内容
 * - topLevelSpans(children, source)：每个顶层块在正文里的 [start, end)。
 *
 * 行为
 * - mdast / micromark 在“链接定义紧跟 Setext 标题”时会把标题的 start 报成 0，与定义重叠；
 *   这里按顺序夹紧：start 不得小于前一块的 end，并越过落在前一块之后的行尾。
 * - span 严格递增、非空；后一块的 end 不早于 start。
 * - 不解析 Markdown、不建节点、不认识 Lexical。
 *
 * 边界
 * - 只修顶层块的 span；容器内部的 raw 内容切片在后续的 contentOf 里处理。
 * - 位置信息缺失的块保留 undefined，由调用方决定是否收进基线。
 *
 * 相关文件
 * - 被依赖：blockSave.ts（$captureBase）。
 * - 依赖：mdast 的 RootContent 类型。
 *
 * 改哪里
 * - 改 span 规则：topLevelSpans。
 */
import type { RootContent } from 'mdast'

/** 一个顶层块在正文里的半开区间。 */
export interface BlockSpan {
  readonly start: number
  readonly end: number
}

/**
 * 跳过前一块 end 之后的行尾，落到下一块真正的第一行。
 * @param source - 正文。
 * @param index - 起点。
 * @param end - 这一块的 end，不能越过。
 * @returns 新的起点。
 */
function skipLineEnding(source: string, index: number, end: number): number {
  let cursor = index
  if (cursor < end && source[cursor] === '\r') cursor += 1
  if (cursor < end && source[cursor] === '\n') cursor += 1
  return cursor
}

/**
 * 每个顶层块的源 span。
 *
 * 位置缺失的块给 `undefined`，与“位置存在”区分开；调用方不应给这种块建基线。
 * @param children - mdast 的顶层块。
 * @param source - 正文。
 * @returns 与 children 等长的 span；缺位置的项为 undefined。
 */
export function topLevelSpans(
  children: readonly RootContent[],
  source: string,
): Array<BlockSpan | undefined> {
  const spans: Array<BlockSpan | undefined> = []
  let previousEnd = 0
  for (const child of children) {
    const rawStart = child.position?.start.offset
    const rawEnd = child.position?.end.offset
    if (rawStart === undefined || rawEnd === undefined) {
      spans.push(undefined)
      continue
    }
    // 块级位置通常指向内容首字符；原文切片要连行首缩进一起带走。
    const lineStart = source.lastIndexOf('\n', Math.max(0, rawStart - 1)) + 1
    let start = Math.max(lineStart, previousEnd)
    if (rawStart < previousEnd) {
      start = skipLineEnding(source, previousEnd, rawEnd)
      if (start >= rawEnd) start = previousEnd
    }
    if (start < previousEnd) start = previousEnd
    const end = Math.max(start, rawEnd)
    spans.push({ start, end })
    previousEnd = Math.max(previousEnd, end)
  }
  return spans
}
