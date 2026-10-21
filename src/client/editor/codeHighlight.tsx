/**
 * 编辑器内代码块的语法高亮：给可编辑文本加 CSS 范围，不替换编辑面。
 *
 * 内容
 * - CodeHighlightPlugin / HighlightedBlock。
 * - RULES / REPORTED / highlightSheet / rebuildSheet。
 * - textRuns / 按样式分组的 ::highlight 规则。
 *
 * 行为
 * - 用官方 useCodeHighlighter 拿 HighlightSpan[][]；颜色来自 --shiki-*。
 * - 用 CSS.highlights + ::highlight() 着色；同一声明按组归并，一组一条规则。
 * - 每个代码块一个高亮器；只报抛错，undefined 是正常回退，不报。
 * - REPORTED 按节点键去重，恢复正常后清掉。
 *
 * 边界
 * - 不替换编辑面，不渲染只读 CodeBlock。
 * - 不负责查找高亮（highlight.ts），也不负责横幅与复制按钮（codeChrome.tsx）。
 *
 * 相关文件
 * - 依赖：codeBlocks.ts（哪些块要着色）。
 * - 被依赖：MarkdownEditor.tsx。
 *
 * 改哪里
 * - 改着色：HighlightedBlock。
 * - 改规则生成：RULES / rebuildSheet。
 */
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import {
  useCodeHighlighter,
  type HighlightSpan,
} from '@deepseek-ai/dsh-client-ui-primitives'
import {
  $getRoot,
  type LexicalEditor,
} from 'lexical'
import { useEffect, useState, type CSSProperties, type ReactElement } from 'react'
import { collectCodeBlocks, type CodeBlockInfo } from './codeBlocks'

/**
 * Every generated rule, by the highlight name it belongs to.
 *
 * Document-global and shared across editor instances, because the stylesheet is
 * one element: a block that wrote its own rules there would erase every other
 * block's.
 */
const RULES = new Map<string, string>()

/**
 * Blocks whose current fault has already been reported, by node key.
 *
 * The per-block effect below re-runs on **every editor update** — `collectCodeBlocks`
 * rebuilds its `CodeBlockInfo` objects each time, so the object is never the same one
 * twice — which makes any report from it a report per keystroke. One entry per block
 * keeps a genuine fault to one notice; a block that stops faulting drops its entry, so
 * a fault that comes back is allowed to speak again.
 */
const REPORTED = new Set<string>()

let styleTag: HTMLStyleElement | null = null

/**
 * The stylesheet holding the generated `::highlight()` rules, created on first
 * use.
 * @returns the element, or `null` when there is no document.
 */
function highlightSheet(): HTMLStyleElement | null {
  if (typeof document === 'undefined') return null
  if (styleTag === null || !styleTag.isConnected) {
    styleTag = document.createElement('style')
    styleTag.dataset.plugin = '@yancy617/dsh-plugin-markdown'
    styleTag.dataset.pluginCss = '@yancy617/dsh-plugin-markdown/code-highlight'
    document.head.appendChild(styleTag)
  }
  return styleTag
}

/** Rewrite the stylesheet from {@link RULES}. */
function rebuildSheet(): void {
  const sheet = highlightSheet()
  if (sheet === null) return
  sheet.textContent = [...RULES]
    .map(([name, declared]) => `::highlight(${name}) { ${declared} }`)
    .join('\n')
}

/**
 * The DOM text nodes under an element, in document order, with the offset at
 * which each starts.
 * @param element - the code block's element.
 * @returns the nodes and their starting offsets.
 */
function textRuns(element: Element): { node: Text; start: number }[] {
  const runs: { node: Text; start: number }[] = []
  let offset = 0
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
  for (let current = walker.nextNode(); current !== null; current = walker.nextNode()) {
    const text = current as Text
    runs.push({ node: text, start: offset })
    offset += text.data.length
  }
  return runs
}

/**
 * Turn one absolute character offset into a DOM position.
 * @param runs - the text nodes and their offsets.
 * @param offset - the absolute offset.
 * @returns the position, or `null` when no run covers it.
 */
function positionAt(
  runs: readonly { node: Text; start: number }[],
  offset: number,
): { node: Text; offset: number } | null {
  for (const run of runs) {
    const end = run.start + run.node.data.length
    if (offset >= run.start && offset <= end) {
      return { node: run.node, offset: offset - run.start }
    }
  }
  return null
}

/**
 * A run's style as CSS declarations.
 * @param style - a run's style, as the official highlighter produced it.
 * @returns the declarations, or `null` when the style carries none.
 */
function declarationsOf(style: CSSProperties): string | null {
  const parts: string[] = []
  for (const [property, value] of Object.entries(style)) {
    if (value === undefined || value === null) continue
    // A custom property is already authored CSS; a React camelCase key is not.
    const name = property.startsWith('--')
      ? property
      : property.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)
    parts.push(`${name}: ${String(value)};`)
  }
  return parts.length === 0 ? null : parts.join(' ')
}

/**
 * Paint one code block's runs and register the rules they need.
 * @param editor - the owning editor.
 * @param info - the block to paint.
 * @param spans - one run list per line, as the official highlighter produced.
 * @returns the highlight names registered, for removal.
 */
function paint(
  editor: LexicalEditor,
  info: CodeBlockInfo,
  spans: readonly HighlightSpan[][],
): readonly string[] {
  if (typeof CSS === 'undefined' || CSS.highlights === undefined) return []
  const element = editor.getElementByKey(info.key)
  if (element === null) return []
  const runs = textRuns(element)
  if (runs.length === 0) return []

  // Ranges wanting identical declarations share one rule.
  const groups = new Map<string, Range[]>()
  let lineStart = 0
  for (const line of spans) {
    let offset = lineStart
    for (const span of line) {
      const declared = declarationsOf(span.style)
      if (declared !== null && span.text.length > 0) {
        const from = positionAt(runs, offset)
        const to = positionAt(runs, offset + span.text.length)
        if (from !== null && to !== null) {
          const range = document.createRange()
          range.setStart(from.node, from.offset)
          range.setEnd(to.node, to.offset)
          const ranges = groups.get(declared) ?? []
          ranges.push(range)
          groups.set(declared, ranges)
        }
      }
      offset += span.text.length
    }
    // The runs cover the line's text exactly; the newline is not a run.
    lineStart = offset + 1
  }

  const names: string[] = []
  let index = 0
  for (const [declared, ranges] of groups) {
    if (ranges.length === 0) continue
    const name = `dsh-md-code-${info.key}-${index}`
    CSS.highlights.set(name, new Highlight(...ranges))
    RULES.set(name, declared)
    names.push(name)
    index += 1
  }
  if (names.length > 0) rebuildSheet()
  return names
}

/**
 * Remove the highlights this block registered.
 * @param names - the names {@link paint} returned.
 */
function clear(names: readonly string[]): void {
  if (names.length === 0) return
  if (typeof CSS !== 'undefined' && CSS.highlights !== undefined) {
    for (const name of names) CSS.highlights.delete(name)
  }
  for (const name of names) RULES.delete(name)
  rebuildSheet()
}

/**
 * Where a code-block failure is reported.
 *
 * Set by the plugin so the per-block component need not thread a prop, and so a
 * throw inside an effect has somewhere to go other than the editor's own error
 * path, which unmounts the editable surface.
 *
 * **Only a fault goes through here.** A grammar that is unknown or still loading
 * returns `undefined` from the highlighter by design, and the census goes to the
 * console; neither is reported.
 */
let report: ((message: string) => void) | null = null

/**
 * One code block's highlighter.
 *
 * The hook is bound to one language, so it is called here — once per block —
 * rather than once for the document.
 *
 * It renders nothing on purpose: everything that draws belongs to
 * `./codeChrome.tsx`, which sits outside the editable tree and outside this
 * per-update effect. A throw from here unmounts the whole editor.
 */
function HighlightedBlock({
  editor,
  info,
}: {
  readonly editor: LexicalEditor
  readonly info: CodeBlockInfo
}): null {
  const highlight = useCodeHighlighter(info.language)

  useEffect(() => {
    try {
      const spans = highlight(info.code)
      /*
       * `undefined` is the documented return for "no grammar, or it has not loaded
       * yet" — `code-highlighting.d.ts` says it outright: *"unknown and loading
       * grammars return `undefined` for plain-text fallback"*. So this is the API's
       * normal path, not a failure.
       *
       * Reporting it would produce a notice reading
       * `代码块 (无语言)：高亮器返回 undefined（语法未注册或不支持）` — for a fence with no
       * info string, which is ordinary Markdown rather than an unsupported language,
       * and **on every keystroke**, because this effect re-runs on every update. A
       * notice saying nothing is wrong, repeating while nothing is wrong, is how a
       * reader learns to stop reading notices.
       */
      if (spans === undefined) {
        // Healthy, so a later fault is allowed to speak again.
        REPORTED.delete(info.key)
        return undefined
      }
      const names = paint(editor, info, spans)
      REPORTED.delete(info.key)
      return () => clear(names)
    } catch (error) {
      // Catching here is the point: an effect that throws unmounts the editor.
      //
      // Reported **once per block**, not once per keystroke — this effect re-runs on
      // every update, and the same fault forty times a minute is one a reader learns
      // to ignore. A throw is the one thing here that is genuinely a fault: unlike the
      // `undefined` above, nothing in the API documents it as a normal outcome.
      if (!REPORTED.has(info.key)) {
        REPORTED.add(info.key)
        report?.(
          `代码块高亮出错：${error instanceof Error ? error.message : String(error)}`,
        )
      }
      return undefined
    }
  }, [editor, info, highlight])

  return null
}

/**
 * Highlight every code block in the editor with the product's own highlighter.
 * @param props - optional reporter, wired to the workbench's notice area.
 * @returns one helper per code block.
 */
export function CodeHighlightPlugin({
  onReport,
}: {
  readonly onReport?: ((message: string) => void) | undefined
}): ReactElement | null {
  const [editor] = useLexicalComposerContext()
  const [blocks, setBlocks] = useState<readonly CodeBlockInfo[]>([])

  useEffect(() => {
    report = onReport ?? null
    return () => {
      report = null
    }
  }, [onReport])

  useEffect(() => {
    const sync = (): void => {
      setBlocks(
        editor.getEditorState().read(() => {
          const found: CodeBlockInfo[] = []
          collectCodeBlocks($getRoot(), found)
          return found
        }),
      )
    }
    sync()
    return editor.registerUpdateListener(sync)
  }, [editor])

  /*
   * The census goes to the console, not to the notice area.
   *
   * Reporting on every size change — **including on mount** — put every
   * document opened with 「代码块普查：0 个」 in the reader's face, and a document
   * with code blocks restated the count on every edit that changed one. The reading
   * is still worth keeping: a count that disagrees with what is on screen is what
   * tells collection apart from painting. It is just not worth interrupting someone's
   * writing for.
   *
   * The two `report` calls below stay on the notice area. They are failures rather
   * than censuses: something the reader wrote did not get highlighted, and that is
   * about their document.
   */
  const census = blocks.length
  useEffect(() => {
    console.info(
      census === 0
        ? '[markdown] 代码块普查：0 个'
        : `[markdown] 代码块普查：${String(census)} 个（${blocks
            .map(info => info.language ?? '(无语言)')
            .join('、')}）`,
    )
  }, [census, blocks])

  if (blocks.length === 0) return null
  return (
    <>
      {blocks.map(info => (
        <HighlightedBlock editor={editor} info={info} key={info.key} />
      ))}
    </>
  )
}
