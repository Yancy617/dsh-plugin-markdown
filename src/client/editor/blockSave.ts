/**
 * 块级保存：未改的顶层块从原文切片，改过的块用 mdast 标准写。
 *
 * 内容
 * - $captureBase(source, parsed?)：给每个顶层内容块记一条“key + 原文 span + 标准写法”。
 * - $saveBody(source, base, eol, dirty?)：按当前树重建正文，并返回下一次保存要用的基线。
 *
 * 行为
 * - **“一块内容是什么”只有一个定义**：`serializeLexicalBlock(node)`。基线里存的
 *   `written` 就是它，判改也只是拿它再比一次——没有第二份“语义字段清单”。
 * - 一个块没改（同一 NodeKey，`written` 相同，且 base 里有 span）⇒ 原文 slicing，一个字节都不重写。
 * - 块改了 / 新块 / 键换了 ⇒ 用同一串 `written` 写出（mdast-util-to-markdown ＋ GFM）。
 * - `dirty` 是这次更新脏掉的顶层块 key：不在集合里的块直接复用基线里的 `written`，
 *   既省掉重新序列化，也不改变结果（probe-block 的“双跑”钉住这一点）。
 *   结构变化（有节点已经不在树里）时调用方传 `undefined`，整体重算。
 * - 相邻的、都没改的 base 块之间，复制原文里的间隔（空行、缩进）；否则用两个换行。
 * - 原文里本来就有的空行由 base 块之间的间隔复制；用户新加的空段落按一个换行计入。
 * - 内容块全被删光（基线里原来有内容）⇒ 正文写空；本来就是空文档 / 只有空行 ⇒ 保留原文。
 * - 图片 / 分割线 / 表格 / 代码等块与段落同一规则；块内部不再做逐字符补丁。
 * - 位置只存在这份 base 里（会话对象），**不在 Lexical 节点 state 上**，所以剪贴板带不走。
 *
 * 边界
 * - 只处理正文（frontmatter 由调用方切 / 拼）。
 * - 不解析 Markdown 的语法规则、不判断块有没有改以外的事：序列化在 mdastLift.ts。
 * - 不负责写盘与调度（MarkdownWorkbench.tsx）。
 *
 * 相关文件
 * - 依赖：saveBase.ts（形状）、emptyParagraph.ts、mdastLift.ts、mdastParse.ts。
 * - 被依赖：MarkdownEditor.tsx 的 EditorBridge、documentMarkdown.ts、scripts/probe-block.ts。
 *
 * 改哪里
 * - 改基线捕获：$captureBase。
 * - 改拼装规则：$saveBody。
 */
import { $getRoot, type LexicalNode } from 'lexical'
import { $isListNode } from '@lexical/list'
import type { Content, Root } from 'mdast'
import { $isEmptyParagraph } from './emptyParagraph'
import { $isBlockBreakNode } from './blockBreak'
import {
  serializeLexicalBlock,
  listWriteOptions,
} from './mdastLift'
import { serializeBlock, type BlockWriteOptions } from './core/serialize'
import { parseBody } from './core/mdastParse'
import { topLevelSpans } from './core/sourceMap'
import type { BaseBlock } from './saveBase'

/**
 * 这个块的“标准写法”。
 * source 原样写；rich 走写手；写手抛错时退回纯文本段落。
 * 保存路径因此不会因为语法把错误抛给用户。
 * @param node - 顶层块。
 * @param options - 相邻列表的标记覆盖。
 * @returns 由写手给出的那一串 Markdown（不含末尾换行）。
 */
function writtenOf(node: LexicalNode, options?: BlockWriteOptions): string {
  try {
    return serializeLexicalBlock(node, options)
  } catch {
    const text = node.getTextContent()
    const paragraph: Content = {
      type: 'paragraph',
      children: text === '' ? [] : [{ type: 'text', value: text }],
    }
    try {
      return serializeBlock(paragraph)
    } catch {
      return text
    }
  }
}

/**
 * 一段“两块之间的原文”里有几条空行。
 *
 * 两端的换行是块与块的分隔，不是空行：`\n\n` 是一条空行，`\n\n\n` 是两条。
 * @param gap - 两个 base 块之间的原文。
 * @returns 空行条数。
 */
function blankLinesIn(gap: string): number {
  return Math.max(0, gap.split(/\r?\n/).length - 2)
}

/**
 * 导入完成后捕获保存基线。
 *
 * 只收**带原文 span** 的内容块；空段落与没有位置的节点不收——它们没有可切的原文。
 * 与 `documentMarkdown.ts` 的导入共用这一份实现（导入时把已解析的树传进来，省一次解析）。
 * @param source - 这一次保存所依据的正文。
 * @param parsed - 已经解析好的 mdast 根；缺省时现解析。
 * @returns 基线块，按文档顺序。
 */
export function $captureBase(source: string, parsed: Root = parseBody(source)): BaseBlock[] {
  const blocks: BaseBlock[] = []
  /*
   * 与解析结果配对的是**内容块**（跳过空段落）：空段落是编辑器的写位置与块间空白，不是解析出来的
   * 构造。这样这条配对不依赖“根的孩子与 mdast 的孩子逐个同下标”这个巧合——用户自己加过空行时
   * 它也不成立。
   */
  const contentBlocks = $getRoot()
    .getChildren()
    .filter(node => !$isEmptyParagraph(node) && !$isBlockBreakNode(node))
  const spans = topLevelSpans(parsed.children, source)
  const count = Math.min(parsed.children.length, contentBlocks.length)
  let previousListType: string | null = null
  for (let index = 0; index < count; index += 1) {
    const node = contentBlocks[index]
    const span = spans[index]
    if (node === undefined || span === undefined) continue
    blocks.push({
      key: node.getKey(),
      start: span.start,
      end: span.end,
      written: writtenOf(node, listWriteOptions(previousListType, node)),
      index: blocks.length,
    })
    previousListType = $isListNode(node) ? node.getListType() : null
  }
  return blocks
}

/**
 * 按当前树拼出正文。
 *
 * 必须在 Lexical 的编辑器上下文里调用。
 * @param source - 上一次保存的正文（frontmatter 已切走）。
 * @param base - 上一次保存的块基线。
 * @param eol - 新内容使用的行尾。
 * @param dirty - 这次更新脏掉的顶层块 key；缺省表示全部重新序列化。
 * @returns 新正文，以及下一次保存要用的基线。
 */
export function $saveBody(
  source: string,
  base: readonly BaseBlock[],
  eol: '\n' | '\r\n',
  dirty?: ReadonlySet<string>,
): { readonly body: string; readonly blocks: BaseBlock[] } {
  const children = $getRoot().getChildren()
  let last = children.length - 1
  while (last >= 0) {
    const node = children[last]
    if (node === undefined) break
    if (!$isEmptyParagraph(node) && !$isBlockBreakNode(node)) break
    last -= 1
  }

  const byKey = new Map<string, BaseBlock>()
  for (const entry of base) byKey.set(entry.key, entry)

  const parts: string[] = []
  let length = 0
  const nextBase: BaseBlock[] = []
  let pendingBlanks = 0
  let previousEntry: BaseBlock | undefined
  let previousUnchanged = false
  let lastEntry: BaseBlock | undefined
  let lastUnchanged = false
  let emitted = false
  let previousListType: string | null = null

  const push = (text: string): void => {
    if (text === '') return
    parts.push(text)
    length += text.length
  }

  for (let index = 0; index <= last; index += 1) {
    const node = children[index]
    if (node === undefined) continue
    if ($isBlockBreakNode(node)) continue
    if ($isEmptyParagraph(node)) {
      // 空行可能是导入时带来的，也可能是用户新加的。相邻 base 块之间那一段原文里已经含有
      // 导入时的空行；到拼 gap 时再减去它们，只补用户新加的那几行（见 gapBlanks）。
      pendingBlanks += 1
      continue
    }

    const entry = byKey.get(node.getKey())
    /*
     * 没脏的块不重新序列化：它的 `written` 只可能等于基线里那一串，直接复用。
     * 脏块 / 新块现算一次——这一串同时是“判改”的判据和“写出”的内容，两者不会分家。
     */
    const reusable = entry !== undefined && dirty !== undefined && !dirty.has(entry.key)
    const options = listWriteOptions(previousListType, node)
    const written = reusable && entry !== undefined ? entry.written : writtenOf(node, options)
    const unchanged = entry !== undefined && written === entry.written
    let text: string
    if (unchanged && entry !== undefined) {
      text = source.slice(entry.start, entry.end)
    } else {
      text = eol === '\n' ? written : written.replace(/\n/g, eol)
    }
    if (text === '') continue
    previousListType = $isListNode(node) ? node.getListType() : null

    if (!emitted) {
      // 第一个内容块还是原文第一个块：前面那点（frontmatter 后的空行等）照抄。
      const prefix =
        entry !== undefined && unchanged && entry.index === 0
          ? source.slice(0, entry.start)
          : ''
      push(prefix)
      if (prefix !== '') pendingBlanks = Math.max(0, pendingBlanks - blankLinesIn(prefix))
      emitted = true
    } else {
      const previous = previousEntry
      const adjacent =
        previous !== undefined &&
        entry !== undefined &&
        previousUnchanged &&
        unchanged &&
        entry.index === previous.index + 1
      if (adjacent && previous !== undefined) {
        const gap = source.slice(previous.end, entry.start)
        push(gap)
        pendingBlanks = Math.max(0, pendingBlanks - blankLinesIn(gap))
      } else {
        push(`${eol}${eol}`)
      }
    }
    if (pendingBlanks > 0) {
      push(eol.repeat(pendingBlanks))
      pendingBlanks = 0
    }

    const start = length
    push(text)
    const recorded: BaseBlock = {
      key: node.getKey(),
      start,
      end: length,
      written,
      index: nextBase.length,
    }
    nextBase.push(recorded)
    previousEntry = entry
    previousUnchanged = unchanged
    lastEntry = entry
    lastUnchanged = unchanged
  }

  // 一个内容块都没有：本来就没有内容（空文档 / 只有空行）⇒ 保留原文，不要凭空造文件；
  // 基线里原来有内容、现在全被删光 ⇒ 用户把整篇删掉了，写空才算把这次编辑落盘。
  if (nextBase.length === 0) return { body: base.length === 0 ? source : '', blocks: [] }

  if (lastEntry !== undefined && lastUnchanged && lastEntry.index === base.length - 1) {
    push(source.slice(lastEntry.end))
  } else if (source.endsWith('\n')) {
    push(eol)
  }

  return { body: parts.join(''), blocks: nextBase }
}
