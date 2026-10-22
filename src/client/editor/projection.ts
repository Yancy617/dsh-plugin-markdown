/**
 * 投影：每个顶层块要么 rich（能无损 lower→lift），要么 source（普通文本、可编辑）。
 *
 * 内容
 * - projectDocumentNodes(parsed, nodes, source)：按 mdast 顶层块逐个判定并替换。
 *
 * 行为
 * - rich：lower 出的节点经 lift 后与 mdast 同构（忽略 position / label / 写法）。
 * - source：不同构、含 raw 载体、或本来就是定义行 ⇒ 换成 SourceBlockNode，文本是原文切片。
 * - source 不是只读；用户可以在 source 块里改字，保存时重新解析、标准写。
 * - 块数是硬前提：mdast 顶层块数与编辑器内容块数不一致时，保留原节点，不猜配对。
 *
 * 边界
 * - 只做顶层块；容器里的子块由后续的递归投影补。
 * - 不解析 Markdown、不写文件；lift 抛错按 source 处理。
 *
 * 相关文件
 * - 被依赖：documentMarkdown.ts（导入 / 粘贴）。
 * - 依赖：mdastLift.ts、sourceMap.ts、sourceBlock.tsx、rawBlocks/rawInline/definitions。
 *
 * 改哪里
 * - 改判定：projectDocumentNodes / isRich。
 */
import { type LexicalNode } from 'lexical'
import type { Content, Root, RootContent } from 'mdast'
import { liftBlock } from './mdastLift'
import { topLevelSpans } from './core/sourceMap'
import { sameTree, standardizeContent } from './core/standardize'
import { $createSourceBlockNode } from './sourceBlock'
import { $isRawBlockNode } from './rawBlocks'

/**
 * 树里有没有“只能原样回放”的节点。
 * @param node - 顶层节点。
 * @returns 是否含 raw / 定义。
 */
function containsRaw(node: LexicalNode): boolean {
  if ($isRawBlockNode(node)) return true
  const element = node as unknown as { getChildren?: () => LexicalNode[] }
  if (typeof element.getChildren !== 'function') return false
  return element.getChildren().some(child => containsRaw(child))
}

/**
 * mdast 里有没有引用式链接 / 图片。
 * @param node - mdast 节点。
 * @returns 是否含引用式。
 */
function hasReference(node: unknown): boolean {
  if (typeof node !== 'object' || node === null) return false
  const record = node as { type?: unknown; children?: unknown }
  if (record.type === 'linkReference' || record.type === 'imageReference') return true
  return Array.isArray(record.children) && record.children.some(child => hasReference(child))
}

/**
 * 引用式链接里有没有非文字的子女（嵌套强调、链接、图片等）。
 * 这些形状的写回容易丢结构，直接 source。
 * @param node - mdast 节点。
 * @returns 是否是复杂引用式。
 */
function hasComplexReference(node: unknown): boolean {
  if (typeof node !== 'object' || node === null) return false
  const record = node as { type?: unknown; children?: unknown }
  if (record.type === 'linkReference' && Array.isArray(record.children)) {
    return record.children.some(child => {
      const type = (child as { type?: unknown }).type
      return type !== 'text' && type !== 'break'
    })
  }
  return Array.isArray(record.children) && record.children.some(child => hasComplexReference(child))
}

/**
 * 列表里有没有“缩进代码”（不是围栏代码）。
 * 缩进代码放进列表项后，写手会重新加缩进，代码的 `value` 会变；这种块直接 source。
 * @param node - mdast 节点。
 * @param source - 正文。
 * @returns 是否有缩进代码。
 */
function hasIndentedCode(node: unknown, source: string): boolean {
  if (typeof node !== 'object' || node === null) return false
  const record = node as { type?: unknown; position?: { start?: { offset?: number } }; children?: unknown }
  if (record.type === 'code') {
    const start = record.position?.start?.offset
    if (start !== undefined) {
      const head = source.slice(start, start + 3)
      if (!head.startsWith('```') && !head.startsWith('~~~')) return true
    }
  }
  return Array.isArray(record.children) && record.children.some(child => hasIndentedCode(child, source))
}

/**
 * 把一行 lower 出来的节点按 mdast 顶层块投影。
 * @param parsed - mdast 根。
 * @param nodes - lower 出来的顶层节点。
 * @param source - 正文。
 * @returns 投影后的顶层节点。
 */
export function projectDocumentNodes(
  parsed: Root,
  nodes: readonly LexicalNode[],
  source: string,
): LexicalNode[] {
  const spans = topLevelSpans(parsed.children, source)
  // 数量对不上说明 lower 把多个 mdast 块并成了一个（或漏了一个）：整篇逐块降级成
  // 可编辑 source，保住每一块的原文，不猜配对。分隔节点上线后相邻列表不会走到这里。
  if (nodes.length !== parsed.children.length) {
    return parsed.children.map((child, index) => {
      const span = spans[index]
      const start = span?.start ?? child.position?.start.offset ?? 0
      const end = span?.end ?? child.position?.end.offset ?? source.length
      return $createSourceBlockNode(source.slice(start, end))
    })
  }
  const out: LexicalNode[] = []
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index]
    const child = parsed.children[index]
    const span = spans[index]
    if (node === undefined || child === undefined || span === undefined) {
      if (node !== undefined) out.push(node)
      continue
    }
    let sourceBlock = false
    const indentedStart =
      span !== undefined &&
      child.position?.start.offset !== undefined &&
      span.start < child.position.start.offset
    if (
      containsRaw(node) ||
      hasComplexReference(child) ||
      hasIndentedCode(child, source) ||
      (child.type === 'list' && indentedStart)
    ) {
      sourceBlock = true
    } else {
      try {
        const lifted = liftBlock(node)
        sourceBlock = !sameTree(lifted, child)
        // 引用式链接要带着整篇定义才有意义；单块重解会把它读成文字，不能拿它当写手判据。
        if (!sourceBlock && !hasReference(child)) {
          sourceBlock = standardizeContent(lifted) === null
        }
      } catch {
        sourceBlock = true
      }
    }
    out.push(sourceBlock ? $createSourceBlockNode(source.slice(span.start, span.end)) : node)
  }
  return out
}
