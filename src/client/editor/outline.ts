/**
 * 文档目录的一条：标题的层级与文字。
 *
 * 内容
 * - OutlineEntry、outlineOf、inlineText。
 *
 * 行为
 * - 从 Markdown 文本读，而且是**交给语法层读**（`./mdastParse.ts` 的 `parseBody`，与导入正文同一套
 *   解析器）：ATX、Setext、引用里的标题、列表项里的标题、围栏里的 `#`，全由结构决定，不再按行猜。
 * - frontmatter 是元数据、编辑区一个字都不渲染，整块跳过（旧的按行读会把里面的 `#` 列成标题）。
 * - 标题文字取行内节点的文字：`# **粗** 体` ⇒ `粗 体`，与编辑区里看到的一致；换行压成一个空格。
 * - 一次解析的实测开销（427 行 / 7 KB 的一份真实文档）：**16 ms**。所以这个函数**只在没有编辑器树时**
 *   用——源码视图与编辑器挂载前那一两帧；富文本走 `./headingTree.ts`（树已经解析过，读它近乎免费）。
 *
 * 边界
 * - 不缓存、不节流（调用方决定何时调；源码视图那边由一个延迟值兜住击键）。
 * - 不做锚点、折叠、层级校正。
 *
 * 相关文件
 * - 依赖：mdastParse.ts、frontmatter.ts。
 * - 被依赖：workbench/useOutlineColumn.ts、`./headingTree.ts` 的对照用例。
 *
 * 改哪里
 * - 改标题文字：inlineText。
 * - 改取法：outlineOf。
 */
import type { Nodes as MdastNode } from 'mdast'
import { splitFrontmatter } from './frontmatter'
import { parseBody } from './mdastParse'

/** One heading in the document. */
export interface OutlineEntry {
  /** Heading depth, 1–6. */
  readonly level: number
  /** Heading text as the editor shows it: no Markdown markers, no line breaks. */
  readonly text: string
}

/**
 * 标题在正文里出现的位置（文档顺序）。
 * @param markdown - 整篇文字（含 frontmatter）。
 * @returns 按文档顺序的标题；frontmatter 与围栏代码里的 `#` 不在其中。
 */
export function outlineOf(markdown: string): readonly OutlineEntry[] {
  const entries: OutlineEntry[] = []
  collect(parseBody(splitFrontmatter(markdown).body), entries)
  return entries
}

/**
 * 深度优先收标题：引用、列表项里的标题是它们容器的子节点，走一遍就都出来了。
 * @param node - mdast 节点。
 * @param entries - 收进来的地方。
 */
function collect(node: MdastNode, entries: OutlineEntry[]): void {
  if (node.type === 'heading') {
    entries.push({ level: node.depth, text: inlineText(node.children) })
    // 标题的子节点是行内内容，里面不可能再有标题。
    return
  }
  if ('children' in node) {
    for (const child of node.children) collect(child, entries)
  }
}

/**
 * 一段行内内容的**纯文字**：去掉标记，只留读者看见的字。
 *
 * 覆盖标题里会出现的行内构造：文字、行内代码、粗体 / 斜体 / 删除线（子节点递归）、链接（取文字）、
 * 图片（取 alt）、硬换行（算一个空格）、行内 HTML（原样，编辑区也是当字面量显示的）。
 * @param nodes - 行内节点。
 * @returns 压成一行、首尾去空白的文字。
 */
function inlineText(nodes: readonly MdastNode[]): string {
  let text = ''
  for (const node of nodes) {
    switch (node.type) {
      case 'text':
      case 'inlineCode':
      case 'html':
        text += node.value
        break
      case 'image':
      case 'imageReference':
        text += node.alt ?? ''
        break
      case 'break':
        text += ' '
        break
      default:
        if ('children' in node) text += inlineText(node.children)
        break
    }
  }
  return text.replace(/\s+/g, ' ').trim()
}
