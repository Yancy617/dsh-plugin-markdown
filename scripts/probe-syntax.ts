/**
 * Syntax conformance gate: CommonMark 0.31.2 + GFM.
 *
 * Part of `pnpm test`; report goes to `_probe/syntax-report.json`.
 *
 * Criteria, per CommonMark 0.31.2 + GFM as read back by the same spec parser:
 * 1. Open: every spec example imports without throwing.
 * 2. Zero-edit save, normal update: no content block is dirty; the writer must return
 *    the source byte for byte.
 * 3. Zero-edit save, full recompute: same, with `dirty` omitted (undo / structural path).
 * 4. Standard rewrite: whole document written by the GFM writer, reparsed; the mdast tree
 *    must match the source tree (positions ignored). `loose` also ignores reference-link
 *    spelling (`[x]` vs `[x][x]`) and trailing newlines inside raw HTML blocks.
 * 5. Stability: rewriting the rewritten document again is byte-identical.
 * 6. No private sentinels.
 * 7. How many examples need an opaque raw carrier.
 *
 * Usage:
 *   node node_modules/tsdown/dist/run.mjs --config tsdown.sweep.config.ts
 *   node _probe/spec-sweep.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createHeadlessEditor } from '@lexical/headless'
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  type LexicalEditor,
  type LexicalNode,
} from 'lexical'
import { $createListItemNode, $createListNode, registerList } from '@lexical/list'
import { registerRichText } from '@lexical/rich-text'
import type { Root, RootContent } from 'mdast'
import { EDITOR_NODES } from '../src/client/editor/config'
import {
  importDocumentMarkdown,
  serializeDocumentMarkdown,
} from '../src/client/editor/documentMarkdown'
import { $saveBody } from '../src/client/editor/blockSave'
import { parseBody } from '../src/client/editor/mdastParse'
import type { BaseBlock } from '../src/client/editor/saveBase'

const SPEC = fileURLToPath(new URL('../reference/CommonMark-0.31.2-spec.txt', import.meta.url))
const OUT = fileURLToPath(new URL('../_probe/syntax-report.json', import.meta.url))
const FENCE = '`'.repeat(32)
const SENTINEL = /%%dsh-|dshref:|\u2060|\u0000|\u200b|\u200c/

interface Case {
  readonly number: number
  readonly section: string
  readonly markdown: string
  readonly name: string | null
}

interface Result {
  readonly number: number
  readonly section: string
  readonly name: string | null
  readonly opened: boolean
  readonly openError: string | null
  readonly zeroStrict: boolean
  readonly zeroFallback: boolean
  readonly source: string
  readonly savedStrict: string
  readonly savedFallback: string
  readonly rewritten: string
  readonly rewrittenAgain: string
  readonly semanticStrict: boolean
  readonly semanticLoose: boolean
  readonly difference: string | null
  readonly newDocEqual: boolean
  readonly contentEqual: boolean
  readonly stable: boolean
  readonly sentinelFree: boolean
  readonly rawCount: number
  readonly overlaps: boolean
  readonly error: string | null
}

function makeEditor(): LexicalEditor {
  return createHeadlessEditor({
    nodes: [...EDITOR_NODES],
    onError: (error: Error) => {
      throw error
    },
  })
}

function openDocument(markdown: string): { editor: LexicalEditor; base: BaseBlock[] } {
  const editor = makeEditor()
  let base: BaseBlock[] = []
  editor.update(
    () => {
      base = [...importDocumentMarkdown(markdown)]
    },
    { discrete: true },
  )
  return { editor, base }
}

function saveWith(
  editor: LexicalEditor,
  source: string,
  base: readonly BaseBlock[],
  dirty?: ReadonlySet<string>,
): string {
  return editor.getEditorState().read(() => $saveBody(source, base, '\n', dirty).body)
}

function rewrite(editor: LexicalEditor): string {
  return editor.getEditorState().read(() => serializeDocumentMarkdown())
}

function normalise(node: RootContent | Root, loose = false): unknown {
  const record = node as unknown as Record<string, unknown>
  const out: Record<string, unknown> = { type: record.type }
  for (const key of [
    'value',
    'depth',
    'ordered',
    'start',
    'spread',
    'checked',
    'align',
    'alt',
    'title',
    'url',
    'lang',
    'meta',
    'identifier',
    'referenceType',
  ]) {
    if (loose && key === 'referenceType') continue
    const value = record[key]
    if (value !== undefined && value !== null) out[key] = value
  }
  if (loose && record.type === 'html' && typeof out.value === 'string') {
    out.value = out.value.replace(/\n+$/, '')
  }
  const children = record.children
  if (Array.isArray(children)) {
    out.children = children.map(child => normalise(child as RootContent, loose))
  }
  return out
}

function contentOf(node: RootContent | Root): string {
  const record = node as unknown as Record<string, unknown>
  const own = ['value', 'alt', 'url', 'title', 'identifier'].map(key => {
    const value = record[key]
    return typeof value === 'string' ? value : ''
  })
  const children = Array.isArray(record.children)
    ? (record.children as RootContent[]).map(contentOf).join('')
    : ''
  return `${own.join('')}${children}`
}

function typesOf(node: LexicalNode): string[] {
  const types = [node.getType()]
  const element = node as unknown as { getChildren?: () => LexicalNode[] }
  if (typeof element.getChildren === 'function') {
    for (const child of element.getChildren()) types.push(...typesOf(child))
  }
  return types
}

function rawCountOf(editor: LexicalEditor): number {
  return editor.getEditorState().read(() => {
    const all = $getRoot().getChildren().flatMap(typesOf)
    return all.filter(type => type === 'md-raw-block' || type === 'md-raw-inline').length
  })
}

function runCase(item: Case): Result {
  const result = {
    number: item.number,
    section: item.section,
    name: item.name,
    opened: false,
    openError: null as string | null,
    zeroStrict: false,
    zeroFallback: false,
    source: item.markdown,
    savedStrict: '',
    savedFallback: '',
    rewritten: '',
    rewrittenAgain: '',
    semanticStrict: false,
    semanticLoose: false,
    difference: null as string | null,
    newDocEqual: false,
    contentEqual: false,
    stable: false,
    sentinelFree: false,
    rawCount: 0,
    overlaps: false,
    error: null as string | null,
  }

  try {
    const { editor, base } = openDocument(item.markdown)
    result.opened = true

    const parsed = parseBody(item.markdown)
    let previousEnd = -1
    for (const child of parsed.children) {
      const start = child.position?.start.offset
      const end = child.position?.end.offset
      if (start === undefined || end === undefined) continue
      if (start < previousEnd) result.overlaps = true
      previousEnd = Math.max(previousEnd, end)
    }

    result.savedStrict = saveWith(editor, item.markdown, base, new Set())
    result.savedFallback = saveWith(editor, item.markdown, base)
    result.zeroStrict = result.savedStrict === item.markdown
    result.zeroFallback = result.savedFallback === item.markdown

    result.rewritten = rewrite(editor)
    result.newDocEqual = saveWith(editor, '', [], new Set()) === result.rewritten
    result.sentinelFree = !SENTINEL.test(result.rewritten)
    result.rawCount = rawCountOf(editor)

    const originalStrict = normalise(parsed)
    const rewrittenStrict = normalise(parseBody(result.rewritten))
    result.semanticStrict =
      JSON.stringify(originalStrict) === JSON.stringify(rewrittenStrict)
    result.semanticLoose =
      JSON.stringify(normalise(parsed, true)) ===
      JSON.stringify(normalise(parseBody(result.rewritten), true))
    result.difference = result.semanticLoose
      ? null
      : firstTreeDifference(
          normalise(parsed, true),
          normalise(parseBody(result.rewritten), true),
        )
    result.contentEqual = contentOf(parsed) === contentOf(parseBody(result.rewritten))

    const again = openDocument(result.rewritten)
    result.rewrittenAgain = rewrite(again.editor)
    result.stable = result.rewrittenAgain === result.rewritten
  } catch (caught) {
    result.error = caught instanceof Error ? `${caught.name}: ${caught.message}` : String(caught)
    if (!result.opened) result.openError = result.error
  }

  return result
}

function parseSpec(): Case[] {
  const text = readFileSync(SPEC, 'utf8').replace(/\r\n/g, '\n')
  const lines = text.split('\n')
  const cases: Case[] = []
  let section = ''
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (line?.startsWith('## ')) section = line.slice(3).trim()
    if (line !== `${FENCE} example`) continue
    const markdown: string[] = []
    let cursor = index + 1
    while (cursor < lines.length && lines[cursor] !== '.') {
      markdown.push(lines[cursor] ?? '')
      cursor += 1
    }
    cursor += 1
    while (cursor < lines.length && lines[cursor] !== FENCE) cursor += 1
    cases.push({
      number: cases.length + 1,
      section,
      markdown: markdown.length === 0 ? '' : `${markdown.join('\n')}\n`,
      name: null,
    })
    index = cursor
  }
  return cases
}

const GFM_CASES: Case[] = (
  [
  ['table basic', '| a | b |\n| --- | --- |\n| c | d |\n'],
  ['table align', '| a | b | c |\n| :-- | :-: | --: |\n| 1 | 2 | 3 |\n'],
  ['table no outer pipes', 'a | b\n--- | ---\nc | d\n'],
  ['table escaped pipe', '| a | b |\n| --- | --- |\n| c \\| d | e |\n'],
  ['table code with pipe', '| a | b |\n| --- | --- |\n| `x|y` | z |\n'],
  ['table empty cells', '| a | b |\n| --- | --- |\n|  |  |\n'],
  ['table header only', '| a | b |\n| --- | --- |\n'],
  ['table body extra cell', '| a | b |\n| --- | --- |\n| 1 | 2 | 3 |\n'],
  ['table body short row', '| a | b |\n| --- | --- |\n| 1 |\n'],
  ['table in quote', '> | a | b |\n> | --- | --- |\n> | 1 | 2 |\n'],
  ['table in list', '- | a | b |\n  | --- | --- |\n  | 1 | 2 |\n'],
  ['table cjk and inline', '| a | b |\n| --- | --- |\n| **bold** | `code` |\n'],
  ['table with link', '| a | b |\n| --- | --- |\n| [x](https://e.x) | y |\n'],
  ['task basic', '- [ ] a\n- [x] b\n'],
  ['task upper x', '- [X] a\n'],
  ['task ordered', '1. [x] a\n2. [ ] b\n'],
  ['task nested', '- [ ] a\n  - [x] b\n'],
  ['task empty item', '- [ ]\n'],
  ['task no marker', '[ ] a\n'],
  ['strike double', '~~a~~\n'],
  ['strike single', '~a~\n'],
  ['strike with space', '~~a b~~\n'],
  ['strike intraword', 'a~~b~~c\n'],
  ['strike across lines', '~~a\nb~~\n'],
  ['strike around bold', '~~**a**~~\n'],
  ['bare link www', 'www.example.com\n'],
  ['bare link http', 'http://example.com\n'],
  ['bare link https', 'https://example.com/a_b?c=d\n'],
  ['bare link email', 'foo@bar.example.com\n'],
  ['bare link trailing dot', 'see www.example.com.\n'],
  ['bare link trailing paren', '(www.example.com)\n'],
  ['bare link prefixed', 'xwww.example.com\n'],
  ['bare link ftp', 'ftp://example.com\n'],
  ['mixed table task strike', '| a | b |\n| --- | --- |\n| ~~x~~ | [ ] y |\n'],
  ['mixed crlf table', '| a | b |\r\n| --- | --- |\r\n| c | d |\r\n'],
  ['mixed table and definition', '| a | b |\n| --- | --- |\n| [x][r] | y |\n\n[r]: https://e.x\n'],
  ['mixed html block', '<div>\n**x**\n</div>\n'],
  ['mixed footnote', 'a[^1]\n\n[^1]: b\n'],
  ['mixed indented code', '    a\n    b\n'],
  ['mixed fenced info', '```js title="x"\na\n```\n'],
  ['mixed tilde fence', '~~~js\na\n~~~\n'],
  ['mixed quote list', '> - a\n> - b\n'],
  ['mixed loose list item', '- a\n\n  b\n'],
  ['mixed hard break spaces', 'a  \nb\n'],
  ['mixed hard break backslash', 'a\\\nb\n'],
  ['mixed angle autolink', '<https://example.com>\n'],
  ['mixed duplicate definition', '[a]: https://a.x\n[a]: https://b.x\n\ntext [a]\n'],
  ] as Array<[string, string]>
).map(([name, markdown], index) => ({
  number: index + 1,
  section: 'GFM handwritten',
  markdown,
  name,
}))

function pct(part: number, total: number): string {
  return total === 0 ? '-' : `${((part / total) * 100).toFixed(1)}%`
}

function firstDiffIndex(left: string, right: string): number {
  const limit = Math.min(left.length, right.length)
  for (let index = 0; index < limit; index += 1) {
    if (left[index] !== right[index]) return index
  }
  return limit
}

function excerpt(text: string, around: number): string {
  const start = Math.max(0, around - 40)
  const end = Math.min(text.length, around + 80)
  return `${start > 0 ? '...' : ''}${text.slice(start, end).replace(/\n/g, '\\n')}${
    end < text.length ? '...' : ''
  }`
}

function firstTreeDifference(left: unknown, right: unknown, path = '$'): string | null {
  if (typeof left !== typeof right) return `${path}: ${typeof left} vs ${typeof right}`
  if (left === null || right === null || typeof left !== 'object') {
    return left === right ? null : `${path}: ${JSON.stringify(left)} vs ${JSON.stringify(right)}`
  }
  const leftRecord = left as Record<string, unknown>
  const rightRecord = right as Record<string, unknown>
  for (const key of new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)])) {
    const leftValue = leftRecord[key]
    const rightValue = rightRecord[key]
    if (key === 'children' && Array.isArray(leftValue) && Array.isArray(rightValue)) {
      if (leftValue.length !== rightValue.length) {
        return `${path}.children: ${leftValue.length} vs ${rightValue.length}`
      }
      for (let index = 0; index < leftValue.length; index += 1) {
        const difference = firstTreeDifference(
          leftValue[index],
          rightValue[index],
          `${path}.children[${index}]`,
        )
        if (difference !== null) return difference
      }
      continue
    }
    const difference = firstTreeDifference(leftValue, rightValue, `${path}.${key}`)
    if (difference !== null) return difference
  }
  return null
}

function summarise(title: string, results: readonly Result[]): void {
  const total = results.length
  const count = (predicate: (result: Result) => boolean): number =>
    results.filter(predicate).length

  console.log(`\n## ${title} (${total} examples)`)
  console.log(
    `open ${count(result => result.opened)}/${total} (${pct(count(result => result.opened), total)})` +
      ` | zero-edit normal ${count(result => result.zeroStrict)}/${total}` +
      ` (${pct(count(result => result.zeroStrict), total)})` +
      ` | zero-edit full ${count(result => result.zeroFallback)}/${total}` +
      ` (${pct(count(result => result.zeroFallback), total)})` +
      ` | rewrite semantic ${count(result => result.semanticStrict)}/${total}` +
      ` (${pct(count(result => result.semanticStrict), total)})` +
      ` | loose ${count(result => result.semanticLoose)}/${total}` +
      ` | content ${count(result => result.contentEqual)}/${total}` +
      ` | stable ${count(result => result.stable)}/${total}` +
      ` | new-doc path ${count(result => result.newDocEqual)}/${total}` +
      ` | no sentinel ${count(result => result.sentinelFree)}/${total}` +
      ` | raw carrier ${count(result => result.rawCount > 0)}/${total}`,
  )

  const sections = new Map<string, Result[]>()
  for (const result of results) {
    const list = sections.get(result.section) ?? []
    list.push(result)
    sections.set(result.section, list)
  }
  for (const [section, list] of sections) {
    console.log(
      `- ${section}: ${list.length} | open ${list.filter(result => result.opened).length}` +
        ` | byte ${list.filter(result => result.zeroStrict).length}` +
        ` | semantic ${list.filter(result => result.semanticStrict).length}` +
        ` | loose ${list.filter(result => result.semanticLoose).length}` +
        ` | stable ${list.filter(result => result.stable).length}` +
        ` | raw ${list.filter(result => result.rawCount > 0).length}`,
    )
  }

  const categories = new Map<string, number>()
  for (const result of results.filter(candidate => !candidate.semanticLoose)) {
    const difference = firstTreeDifference(
      normalise(parseBody(result.source), true),
      normalise(parseBody(result.rewritten), true),
    )
    const field = difference?.split(':')[0]?.split('.').pop() ?? 'unknown'
    categories.set(field, (categories.get(field) ?? 0) + 1)
  }
  console.log(
    `first semantic difference: ${[...categories.entries()]
      .sort((left, right) => right[1] - left[1])
      .map(([field, number]) => `${field}=${number}`)
      .join(' | ')}`,
  )
}

function main(): void {
  if (process.argv.includes('--grow')) {
    for (const source of [
      '> <div>\n> foo\n\nbar\n',
      '1.  foo\n\n    ```\n    bar\n    ```\n\n    baz\n\n    > bam\n',
      '1.     indented code\n\n   paragraph\n\n       more code\n',
      '1. ```\n   foo\n   ```\n\n   bar\n',
      '- # Foo\n- Bar\n  ---\n  baz\n',
      '* foo\n  * bar\n\n  baz\n',
    ]) {
      let current = source
      console.log(`\nsource=${JSON.stringify(source)}`)
      for (let round = 1; round <= 6; round += 1) {
        const { editor } = openDocument(current)
        current = rewrite(editor)
        console.log(`  r${round} (${current.length}) ${JSON.stringify(current)}`)
      }
    }
    return
  }
  if (process.argv.includes('--scenario')) {
    const scenarios: Array<[string, string, 'normal' | 'full' | 'edit-first' | 'edit-last']> = [
      ['adjacent lists', '- foo\n- bar\n+ baz\n', 'normal'],
      ['definition before setext', '[foo]: /url\nbar\n===\n[foo]\n', 'normal'],
      ['nested emphasis', '*_foo_*\n', 'full'],
      ['table with reference link', '| a | b |\n| --- | --- |\n| [x][r] | y |\n\n[r]: https://e.x\n', 'edit-first'],
      ['html in blockquote', '> <div>\n> foo\n\nbar\n', 'normal'],
      ['nested emphasis edit', '*_foo_*\n', 'edit-first'],
      ['loose list edit', '- one\n\n  two\n', 'edit-first'],
      ['setext multiline edit', 'Foo *bar\nbaz*\n====\n', 'edit-first'],
      ['table reference link edit', '| a | b |\n| --- | --- |\n| [x][r] | y |\n\n[r]: https://e.x\n', 'edit-first'],
      ['edit after adjacent lists', '- foo\n- bar\n+ baz\n\ntext\n', 'edit-last'],
      ['edit after definition setext', '[foo]: /url\nbar\n===\n[foo]\n\ntext\n', 'edit-last'],
    ]
    for (const [name, source, mode] of scenarios) {
      const { editor, base } = openDocument(source)
      if (mode === 'edit-last') {
        editor.update(
          () => {
            const text = $getRoot().getAllTextNodes().at(-1)
            if (text === undefined) return
            text.setTextContent(`${text.getTextContent()}X`)
          },
          { discrete: true },
        )
        const dirty = editor.getEditorState().read(() => {
          const text = $getRoot().getAllTextNodes().at(-1)
          const top = text?.getTopLevelElement() ?? null
          return new Set(top === null ? [] : [top.getKey()])
        })
        console.log(`\n[${name}] edit-last dirty=${dirty.size}`)
        console.log(`  source=${JSON.stringify(source)}`)
        console.log(`  saved=${JSON.stringify(saveWith(editor, source, base, dirty))}`)
        continue
      }
      if (mode === 'edit-first') {
        const before = editor.getEditorState().read(() => $getRoot().getTextContent())
        editor.update(
          () => {
            const text = $getRoot().getAllTextNodes()[0]
            if (text !== undefined) text.setTextContent(`${text.getTextContent()}X`)
          },
          { discrete: true },
        )
        const dirty = editor.getEditorState().read(
          () => new Set($getRoot().getChildren().map(node => node.getKey())),
        )
        console.log(`\n[${name}] edit-first dirty=${dirty.size}`)
        console.log(`  visible=${JSON.stringify(before)}`)
        console.log(`  source=${JSON.stringify(source)}`)
        console.log(`  saved=${JSON.stringify(saveWith(editor, source, base, dirty))}`)
        continue
      }
      const saved =
        mode === 'normal'
          ? saveWith(editor, source, base, new Set())
          : saveWith(editor, source, base)
      console.log(`\n[${name}] ${mode}`)
      console.log(`  source=${JSON.stringify(source)}`)
      console.log(`  saved =${JSON.stringify(saved)}`)
      console.log(`  rewrite=${JSON.stringify(rewrite(editor))}`)
    }
    return
  }
  if (process.argv.includes('--minimal')) {
    const editor = makeEditor()
    registerRichText(editor)
    registerList(editor)
    editor.update(
      () => {
        const root = $getRoot()
        for (const text of ['a', 'b']) {
          const list = $createListNode('bullet')
          const item = $createListItemNode()
          const paragraph = $createParagraphNode()
          paragraph.append($createTextNode(text))
          item.append(paragraph)
          list.append(item)
          root.append(list)
        }
      },
      { discrete: true },
    )
    editor.getEditorState().read(() => {
      console.log(
        `children=${$getRoot().getChildren().length} types=${$getRoot()
          .getChildren()
          .map(child => child.getType())
          .join(',')}`,
      )
    })
    return
  }
  const specCases = parseSpec()
  console.log(`spec examples: ${specCases.length}`)
  const results: Result[] = []
  for (const item of specCases) results.push(runCase(item))
  for (const item of GFM_CASES) results.push(runCase(item))

  const specResults = results.slice(0, specCases.length)
  const gfmResults = results.slice(specCases.length)
  summarise('CommonMark 0.31.2 spec.txt', specResults)
  summarise('GFM handwritten', gfmResults)

  const zeroStrict = results.filter(result => result.opened && !result.zeroStrict)
  console.log(`\n## zero-edit save changed bytes (normal path): ${zeroStrict.length}`)
  for (const result of zeroStrict) {
    const at = firstDiffIndex(result.source, result.savedStrict)
    console.log(
      `- example ${result.number} (${result.section}) overlap=${result.overlaps} byte@${at}`,
    )
    console.log(`  src=${JSON.stringify(excerpt(result.source, at))}`)
    console.log(`  got=${JSON.stringify(excerpt(result.savedStrict, at))}`)
  }

  const zeroFallbackOnly = results.filter(
    result => result.opened && result.zeroStrict && !result.zeroFallback,
  )
  console.log(`\n## zero-edit save changed bytes (full recompute only): ${zeroFallbackOnly.length}`)
  for (const result of zeroFallbackOnly) {
    const at = firstDiffIndex(result.source, result.savedFallback)
    console.log(`- example ${result.number} (${result.section}) byte@${at}`)
    console.log(`  src=${JSON.stringify(excerpt(result.source, at))}`)
    console.log(`  got=${JSON.stringify(excerpt(result.savedFallback, at))}`)
  }

  const semantic = results.filter(result => result.opened && !result.semanticLoose)
  console.log(`\n## rewrite semantic differences: ${semantic.length}`)
  for (const result of semantic) {
    const label = result.name ?? `example ${result.number}`
    const difference = firstTreeDifference(
      normalise(parseBody(result.source), true),
      normalise(parseBody(result.rewritten), true),
    )
    console.log(`- [${result.section}] ${label}: ${difference}`)
    console.log(`  src=${JSON.stringify(result.source.slice(0, 160))}`)
    console.log(`  out=${JSON.stringify(result.rewritten.slice(0, 160))}`)
  }

  const unstable = results.filter(result => result.opened && !result.stable)
  console.log(`\n## rewrite unstable: ${unstable.length}`)
  for (const result of unstable) {
    console.log(`- example ${result.number} (${result.section})`)
    console.log(`  round1=${JSON.stringify(result.rewritten)}`)
    console.log(`  round2=${JSON.stringify(result.rewrittenAgain)}`)
  }

  const report = {
    generatedAt: new Date().toISOString(),
    spec: specResults,
    gfm: gfmResults,
  }
  writeFileSync(OUT, JSON.stringify(report, null, 2), 'utf8')
  console.log(`\nreport: ${OUT}`)

  const hardFailures = results.filter(
    result =>
      !result.opened ||
      !result.zeroStrict ||
      !result.zeroFallback ||
      !result.semanticLoose ||
      !result.stable ||
      !result.newDocEqual ||
      !result.sentinelFree,
  )
  process.exitCode = hardFailures.length === 0 ? 0 : 1
}

main()

