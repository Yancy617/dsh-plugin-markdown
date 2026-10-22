/**
 * 块级保存的验收仪器。
 *
 * 判据（与保真口径一致）：
 * 1. 打开示例、不改、保存 → 逐字节等于原文。
 * 2. 改一段里的一个字 → 只有那一段变（输出 === 原文只替换那个词）。
 * 3. 空基线上重写整篇（相当于新文档 / 粘贴）→ 标准 GFM：没有重复分割线、定义还在、
 *    没有 `%%dsh-` / `dshref:` / 不可见哨兵。
 * 4. 往已打开的文档末尾插一个新块 → 原有字节不动，新块按标准写。
 * 5. 表格里改一格 → 表格外一个字节不动，表格里出现新文字。
 * 6. 复制成 Markdown → 正文与定义都在，没有私有哨兵。
 * 7. 复制 → 粘贴 → 保存 → 结构与定义都还在。
 * 8. **改一个字段 → 必须写回**（保存语义矩阵）：段内格式 / 段内链接 / 空 alt 图片段落 /
 *    行内 HTML / 代码围栏 meta / 有序任务项 / 引用式链接 / 引用块里的定义。
 * 9. **列表嵌套（真命令）**：有序列表任意层的往返；缩进造出的新子列表从 1 开始；反缩进在
 *    “唯一子项”时拒绝（Tab 与工具栏同一个入口）；样式表守住逐层缩进与逐层标记形态
 *    （1. / a. / 1.，且字形写在 ol 上）。
 * 10. **图片的选中 / 删除 / 左右键**：文字点跨图与元素点整段选都要能删；NodeSelection 交给 rich-text；
 *    左右键落在图片两侧；“图片后面的文字选区”不算选中图片；删光内容按 P3 写空。
 *
 * 基线一律取 `importDocumentMarkdown` 的返回值（生产路径），不再用 `$captureBase` 另建一份。
 *
 * 只报读数、失败时退出码 1；不写用户的文件。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createHeadlessEditor } from '@lexical/headless'
import {
  $createNodeSelection,
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $isRootNode,
  $selectAll,
  $setSelection,
  DELETE_CHARACTER_COMMAND,
  KEY_ARROW_LEFT_COMMAND,
  KEY_ARROW_RIGHT_COMMAND,
  KEY_TAB_COMMAND,
  type LexicalEditor,
  type LexicalNode,
  type TextNode,
} from 'lexical'
import { $createLinkNode } from '@lexical/link'
import { registerList } from '@lexical/list'
import { registerRichText } from '@lexical/rich-text'
import { EDITOR_CSS, EDITOR_NODES } from '../src/client/editor/config'
import { importDocumentMarkdown, $pastedMarkdownNodes, serializeDocumentMarkdown } from '../src/client/editor/documentMarkdown'
import { $captureBase, $saveBody } from '../src/client/editor/blockSave'
import type { BaseBlock } from '../src/client/editor/saveBase'
import { $selectionMarkdown } from '../src/client/editor/clipboardMarkdown'
import { splitFrontmatter } from '../src/client/editor/frontmatter'
import { $createImageNode, $isImageNode } from '../src/client/editor/image'
import { $isRawInlineNode } from '../src/client/editor/rawInline'
import { $insertLink, $writeLink } from '../src/client/editor/linkEdit'
import { registerListIndent } from '../src/client/editor/listNesting'
import { $selectedImageKeys, registerImageKeys } from '../src/client/editor/imageSelection'
import { applyBlockOperation, NESTING_OPERATIONS } from '../src/client/editor/operations'
import { parseBody } from '../src/client/editor/mdastParse'
import { $isSourceBlockNode, SOURCE_EDIT_TAG } from '../src/client/editor/sourceBlock'

function makeEditor(): LexicalEditor {
  return createHeadlessEditor({
    nodes: [...EDITOR_NODES],
    onError: (error: Error) => {
      throw error
    },
  })
}

/**
 * The corpus every check below reads.
 *
 * A fixture of its own, not the shipped sample: the sample is a **product** document whose wording
 * changes whenever its audience changes, and these checks name its sections and need its constructs
 * (reference definitions, fence meta, task lists). Pinning them to a file that ships would make a
 * copy-edit break the acceptance run.
 */
const SAMPLE = fileURLToPath(new URL('../scripts/fixtures/综合样张.md', import.meta.url))
const { body } = splitFrontmatter(readFileSync(SAMPLE, 'utf8'))

let failures = 0
function check(title: string, ok: boolean, detail = ''): void {
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${title}${detail === '' ? '' : ` — ${detail}`}`)
}

/** 打开一篇正文，返回编辑器与它的保存基线（与生产同一条导入路径）。 */
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

/** 按当前树保存一份正文。 */
function saveWith(editor: LexicalEditor, source: string, base: readonly BaseBlock[]): string {
  return editor.getEditorState().read(() => $saveBody(source, base, '\n').body)
}

/** 在一份正文上做一次编辑，返回保存结果。 */
function editAndSave(markdown: string, edit: () => void): string {
  const { editor, base } = openDocument(markdown)
  editor.update(edit, { discrete: true })
  return saveWith(editor, markdown, base)
}

/**
 * 打开一篇正文，并接上**真的**缩进命令。
 *
 * 与 {@link openDocument} 分开：其余用例只需要节点；把 `@lexical/rich-text` / `@lexical/list` 的
 * 转换器与命令也挂上会改变它们的前提（缩进、回车、列表归一化都开始真的跑）。
 */
function openNestingDocument(markdown: string): { editor: LexicalEditor; base: BaseBlock[] } {
  const editor = createHeadlessEditor({
    nodes: [...EDITOR_NODES],
    onError: (error: Error) => {
      throw error
    },
  })
  registerRichText(editor)
  registerList(editor)
  registerListIndent(editor)
  let base: BaseBlock[] = []
  editor.update(
    () => {
      base = [...importDocumentMarkdown(markdown)]
    },
    { discrete: true },
  )
  return { editor, base }
}

/** 把折叠光标放进内容等于 `text` 的那个文字节点。 */
function caretIn(editor: LexicalEditor, text: string): void {
  editor.update(
    () => {
      const node = $getRoot()
        .getAllTextNodes()
        .find(candidate => candidate.getTextContent() === text)
      if (node === undefined) return
      const selection = $createRangeSelection()
      selection.anchor.set(node.getKey(), 0, 'text')
      selection.focus.set(node.getKey(), 0, 'text')
      $setSelection(selection)
    },
    { discrete: true },
  )
}

/** 让按键命令那次 update 提交（与生产里的按键同一条路：命令监听器在 update 里跑）。 */
function settle(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0))
}

/**
 * 模拟一次 Tab / Shift+Tab：派发插件真正注册的那条命令。
 *
 * 与生产同一条路——按键监听本身就在一次编辑器 update 里跑，所以这里验证的是
 * `$nestSelection` 在 update 里被调用（在外面直接调它会违反它的约定）。
 */
function pressTab(editor: LexicalEditor, shiftKey = false): boolean {
  const event = { shiftKey, preventDefault: () => undefined } as unknown as KeyboardEvent
  return editor.dispatchCommand(KEY_TAB_COMMAND, event)
}

/** 一篇 Markdown 里最深的列表层数（1 = 只有一层）。 */
function listDepthOf(markdown: string): number {
  const depth = (node: unknown): number => {
    const current = node as { type: string; children?: unknown[] }
    if (current.type === 'list') {
      return 1 + Math.max(0, ...(current.children ?? []).map(depth))
    }
    return Math.max(0, ...(current.children ?? []).map(depth))
  }
  return depth(parseBody(markdown))
}

/** 树里所有链接的地址（文档顺序）。 */
function linkDestinations(editor: LexicalEditor): string[] {
  return editor.getEditorState().read(() => {
    const out: string[] = []
    const walk = (node: LexicalNode): void => {
      if (node.getType() === 'link') {
        out.push((node as unknown as { getURL(): string }).getURL())
      }
      const children = 'getChildren' in node ? (node as unknown as { getChildren(): LexicalNode[] }).getChildren() : []
      for (const child of children) walk(child)
    }
    for (const child of $getRoot().getChildren()) walk(child)
    return out
  })
}

/** 一段文字的字数（用来数某个片段出现几次）。 */
function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1
}

// 1. 打开、不改、保存。
{
  const { editor, base } = openDocument(body)
  const unchanged = saveWith(editor, body, base)
  check('打开后不改，保存逐字节等于原文', unchanged === body, `${String(unchanged.length)} / ${String(body.length)} 字符`)
}

// 1b. 定义紧跟 Setext 标题：mdast 会把标题的起点报成 0，基线必须夹紧。
{
  const source = '[foo]: /url\nbar\n===\n[foo]\n'
  const { editor, base } = openDocument(source)
  const unchanged = saveWith(editor, source, base)
  check('定义紧跟 Setext：保存不重复定义', unchanged === source, JSON.stringify(unchanged))
}

// 1c. 相邻的两张列表：Lexical 会合并；分隔节点必须让两张都留下。
{
  const source = '- foo\n- bar\n+ baz\n'
  const { editor, base } = openDocument(source)
  const unchanged = saveWith(editor, source, base)
  check('相邻无序列表：保存保留第二张', unchanged === source, JSON.stringify(unchanged))
}
{
  const source = '1. foo\n2. bar\n3) baz\n'
  const { editor, base } = openDocument(source)
  const unchanged = saveWith(editor, source, base)
  check('相邻有序列表：保存保留第二张', unchanged === source, JSON.stringify(unchanged))
}

// 1d. 表格单元格里的引用式链接：改另一个格子时不能被清空。
{
  const source = '| a | b |\n| --- | --- |\n| [x][r] | y |\n\n[r]: https://e.x\n'
  const { editor, base } = openDocument(source)
  editor.update(
    () => {
      const target: TextNode | undefined = $getRoot()
        .getAllTextNodes()
        .find(node => node.getTextContent() === 'a')
      target?.setTextContent('aX')
    },
    { discrete: true },
  )
  const saved = saveWith(editor, source, base)
  check('表格引用式链接：改表头后仍在', saved.includes('[x][r]'), JSON.stringify(saved))
}

// 1e. 引用块里的 HTML：raw 值不能带续行的 `>`。
{
  const source = '> <div>\n> foo\n\nbar\n'
  const { editor, base } = openDocument(source)
  const saved = saveWith(editor, source, base)
  check('引用里的 HTML：保存不多 >', saved === source, JSON.stringify(saved))
}

// 1f. 列表项里的段首换行：不能每轮再叠一个 `&#xA;`。
{
  const source = '1.  foo\n\n    ```\n    bar\n    ```\n\n    baz\n\n    > bam\n'
  const first = (() => {
    const { editor } = openDocument(source)
    return editor.getEditorState().read(() => serializeDocumentMarkdown())
  })()
  const second = (() => {
    const { editor } = openDocument(first)
    return editor.getEditorState().read(() => serializeDocumentMarkdown())
  })()
  check('列表项首换行：第二轮不再增长', first === second, JSON.stringify({ first, second }))
}

// 1g. 不能无损建模的块：投影成可编辑的 source 块，保存仍标准。
{
  const source = '*_foo_*\n'
  const { editor, base } = openDocument(source)
  const first = editor.getEditorState().read(() => $getRoot().getFirstChild())
  check('嵌套强调：投影成 source 块', $isSourceBlockNode(first))
  editor.update(
    () => {
      const node = $getRoot().getFirstChild()
      if ($isSourceBlockNode(node)) node.setRaw('*_fooX_*')
    },
    { discrete: true },
  )
  const saved = saveWith(editor, source, base)
  check('嵌套强调：改 source 文本后保存仍是标准写法', saved.includes('fooX'), JSON.stringify(saved))
}

// 1g2. source 块改成多个块：保存不能只写第一段。
{
  const source = '*_foo_*\n'
  const { editor, base } = openDocument(source)
  editor.update(
    () => {
      const node = $getRoot().getFirstChild()
      if ($isSourceBlockNode(node)) node.setRaw('one\n\ntwo')
    },
    { discrete: true },
  )
  const saved = saveWith(editor, source, base)
  check('source 块改成两块：两段都落盘', saved.includes('one') && saved.includes('two'), JSON.stringify(saved))
}

// 1g3. source 块的改动必须带 SOURCE_EDIT_TAG，否则保存会复用旧 written。
{
  const source = '*_foo_*\n'
  const { editor } = openDocument(source)
  let hit = false
  const unregister = editor.registerUpdateListener(({ tags }) => {
    if (tags.has(SOURCE_EDIT_TAG)) hit = true
  })
  editor.update(
    () => {
      const node = $getRoot().getFirstChild()
      if ($isSourceBlockNode(node)) node.setRaw('*_bar_*')
    },
    { discrete: true },
  )
  unregister()
  check('source 块改动带 SOURCE_EDIT_TAG', hit)
}

// 1h. 松列表：不能无损建模时投影成 source；文本与两个段落都还在。
{
  const source = '- one\n\n  two\n'
  const { editor } = openDocument(source)
  const first = editor.getEditorState().read(() => $getRoot().getFirstChild())
  check('松列表：投影成 source 块', $isSourceBlockNode(first))
}

// 1j. 定义行：投影成可编辑 source，改后仍按引用式保存。
{
  const source = '[a]: /x\n\n[a]\n'
  const { editor, base } = openDocument(source)
  const first = editor.getEditorState().read(() => $getRoot().getFirstChild())
  check('定义行：投影成 source 块', $isSourceBlockNode(first))
  editor.update(
    () => {
      const node = $getRoot().getFirstChild()
      if ($isSourceBlockNode(node)) node.setRaw('[a]: /y')
    },
    { discrete: true },
  )
  const saved = saveWith(editor, source, base)
  check('定义行：改 source 后保存新地址', saved.includes('[a]: /y') && saved.includes('[a]'), JSON.stringify(saved))
}

// 1i. HTML 块：投影成 source，仍可改、保存不多字节。
{
  const source = '<div>\nfoo\n</div>\n'
  const { editor, base } = openDocument(source)
  const first = editor.getEditorState().read(() => $getRoot().getFirstChild())
  check('HTML 块：投影成 source 块', $isSourceBlockNode(first))
  editor.update(
    () => {
      const node = $getRoot().getFirstChild()
      if ($isSourceBlockNode(node)) node.setRaw('<div>\nbar\n</div>')
    },
    { discrete: true },
  )
  const saved = saveWith(editor, source, base)
  check('HTML 块：改 source 后保存仍标准', saved.includes('bar'), JSON.stringify(saved))
}

// 2. 改一段里的一个字。
{
  const { editor, base } = openDocument(body)
  editor.update(
    () => {
      const target: TextNode | undefined = $getRoot()
        .getAllTextNodes()
        .find(node => node.getTextContent().includes('普通段落'))
      target?.setTextContent(target.getTextContent().replace('普通段落', '普通段落X'))
    },
    { discrete: true },
  )
  const edited = saveWith(editor, body, base)
  check('改一个字，只有那一段变', edited === body.replace('普通段落', '普通段落X'), `长度 ${String(edited.length)}`)
}

// 3. 空基线上重写整篇：相当于新建文档 / 粘贴。
{
  const { editor } = openDocument(body)
  const freshSaved = saveWith(editor, '', [])
  const duplicatedRules = /\n---\n\n- - -\n\n\*\*\*\n\n_ _ _/.test(freshSaved)
  const definitions = freshSaved.includes('[ref]: https://commonmark.org/')
  const sentinels = /%%dsh-|dshref:|\u2060|\u0000/.test(freshSaved)
  check('整篇标准写没有重复分割线', !duplicatedRules)
  check('整篇标准写保留链接定义', definitions)
  check('整篇标准写没有私有哨兵', !sentinels)
  check('整篇标准写仍有正文', freshSaved.includes('# 功能介绍') && freshSaved.includes('## 七、这个插件不做什么'))
}

// 4. 已打开文档末尾插一个新块。
{
  const { editor, base } = openDocument(body)
  editor.update(
    () => {
      const paragraph = $createParagraphNode()
      paragraph.append($createTextNode('粘贴进来的新块'))
      const root = $getRoot()
      const last = root.getLastChild()
      if (last === null) root.append(paragraph)
      else last.insertBefore(paragraph)
    },
    { discrete: true },
  )
  const appended = saveWith(editor, body, base)
  const original = body.trimEnd()
  check('新块之前一个字节不动', appended.startsWith(`${original}\n\n粘贴进来的新块`))
  check('新块之后仍保留文末换行', appended.endsWith('\n'))
  check('新块不会把定义吞掉', appended.includes('[ref]: https://commonmark.org/'))
}

// 5. 表格里改一格。
{
  const { editor, base } = openDocument(body)
  editor.update(
    () => {
      const cell: TextNode | undefined = $getRoot()
        .getAllTextNodes()
        .find(node => node.getTextContent() === '多标签')
      cell?.setTextContent('多标签X')
    },
    { discrete: true },
  )
  const tableSaved = saveWith(editor, body, base)
  const tableStart = body.lastIndexOf('| 功能 | 在哪 | 说明 |', body.indexOf('多标签'))
  const beforeTable = body.slice(0, tableStart)
  check('表格外（之前）一个字节不动', tableSaved.startsWith(beforeTable))
  check('表格里出现新文字', tableSaved.includes('多标签X'))
  check('表格不会丢定义', tableSaved.includes('[ref]: https://commonmark.org/'))
}

// 6. 复制成 Markdown：Ctrl+A 的选区 ⇒ 标准 Markdown，没有私有哨兵。
{
  const { editor } = openDocument(body)
  editor.update(
    () => {
      $selectAll()
    },
    { discrete: true },
  )
  const copied = editor.getEditorState().read(() => {
    const selection = $getSelection()
    return selection === null ? '' : $selectionMarkdown(editor, selection)
  })
  check('复制成 Markdown 有正文', copied.includes('# 功能介绍') && copied.includes('## 七、这个插件不做什么'))
  check('复制成 Markdown 保留链接定义', copied.includes('[ref]: https://commonmark.org/'))
  check('复制成 Markdown 没有私有哨兵', !/%%dsh-|dshref:|\u2060|\u0000/.test(copied))

  // 7. 复制出的 Markdown 再粘回空文档、保存：结构与定义都还在。
  const pasteEditor = makeEditor()
  pasteEditor.update(
    () => {
      $getRoot().clear()
      $getRoot().append(...$pastedMarkdownNodes(copied))
      $getRoot().append($createParagraphNode())
    },
    { discrete: true },
  )
  const pasted = pasteEditor.getEditorState().read(() => $saveBody('', [], '\n').body)
  check('复制 → 粘贴 → 保存有正文', pasted.includes('# 功能介绍') && pasted.includes('## 七、这个插件不做什么'))
  check('复制 → 粘贴 → 保存保留定义', pasted.includes('[ref]: https://commonmark.org/'))
  check('复制 → 粘贴 → 保存没有私有哨兵', !/%%dsh-|dshref:|\u2060|\u0000/.test(pasted))
}

/*
 * 8. 保存语义矩阵：改一个字段 → 必须写回。
 *
 * 这八条覆盖的是"块被判定为改过、写出时却丢掉改动"的整族：段落里的格式与链接、
 * 空 alt 图片段落、行内 HTML、代码围栏的 info meta、有序任务项、引用式链接、嵌套定义。
 * 每一条都应当先红后绿；红了说明这一次改动没有被写手看见。
 */
{
  // 8.1 段落里只改格式（文字不变）。
  const boldFace = editAndSave('普通段落内容\n\n第二段\n', () => {
    const node: TextNode | undefined = $getRoot()
      .getAllTextNodes()
      .find(candidate => candidate.getTextContent() === '普通段落内容')
    node?.setFormat(1)
  })
  check('段内只加粗：保存写回 **…**', boldFace.includes('**普通段落内容**'), JSON.stringify(boldFace))

  // 8.2 段落里把一个词变成链接（文字不变）。
  const linked = editAndSave('前 中 后\n', () => {
    const node: TextNode | undefined = $getRoot()
      .getAllTextNodes()
      .find(candidate => candidate.getTextContent() === '前 中 后')
    if (node === undefined) return
    node.setTextContent('前 ')
    const link = $createLinkNode('https://example.com')
    link.append($createTextNode('中'))
    node.insertAfter(link)
    link.insertAfter($createTextNode(' 后'))
  })
  check('段内加链接：保存写回 ](…)', linked.includes('](https://example.com)'), JSON.stringify(linked))

  // 8.3 空 alt 图片独占一段，别处改一个字。
  const imageKept = editAndSave('![](p.png)\n\n后段\n', () => {
    const node: TextNode | undefined = $getRoot()
      .getAllTextNodes()
      .find(candidate => candidate.getTextContent() === '后段')
    node?.setTextContent('后段X')
  })
  check('空 alt 图片段落：保存后图片行仍在', imageKept.includes('![](p.png)'), JSON.stringify(imageKept))

  // 8.4 新文档只插一张空 alt 图片（图片对话框那一条路）。
  {
    const editor = makeEditor()
    editor.update(
      () => {
        const paragraph = $createParagraphNode()
        paragraph.append($createImageNode('', 'p.png', null))
        $getRoot().clear()
        $getRoot().append(paragraph)
        $getRoot().append($createParagraphNode())
      },
      { discrete: true },
    )
    const inserted = editor.getEditorState().read(() => $saveBody('', [], '\n').body)
    check('新文档只插一张空 alt 图片：保存不是空文件', inserted.includes('p.png'), JSON.stringify(inserted))
  }

  // 8.5 行内 HTML 改一个属性（原样载体可编辑）。
  const rawEdited = editAndSave('前 <span class="a">旧</span> 后\n', () => {
    const raw = $getRoot()
      .getAllTextNodes()
      .find(node => $isRawInlineNode(node) && node.getRaw().includes('class='))
    if (raw !== undefined) raw.setTextContent('<span class="b">')
  })
  check('行内 HTML 改属性：保存写回新属性', rawEdited.includes('class="b"'), JSON.stringify(rawEdited))

  // 8.6 行内 HTML 被切开之后，同一块再改一个字：不得重复字节。
  const rawSplit = editAndSave('前 <span class="a">旧</span> 后\n', () => {
    const raw = $getRoot()
      .getAllTextNodes()
      .find(node => $isRawInlineNode(node))
    if (raw === undefined) return
    raw.splitText(6)
    const text: TextNode | undefined = $getRoot()
      .getAllTextNodes()
      .find(candidate => candidate.getTextContent() === '旧')
    text?.setTextContent('旧X')
  })
  check(
    '行内 HTML 被切开后再编辑：没有重复字节',
    !rawSplit.includes('class="a">class="a">'),
    JSON.stringify(rawSplit),
  )
  check('行内 HTML 被切开后再编辑：改动写回', rawSplit.includes('旧X'), JSON.stringify(rawSplit))

  // 8.7 代码围栏的 info meta。
  const codeMeta = editAndSave('```js title="x"\nconst a = 1\n```\n', () => {
    const code = $getRoot().getAllTextNodes().find(node => node.getTextContent().includes('const a'))
    code?.setTextContent('const a = 2')
  })
  check('代码围栏 meta：保存保留 title', codeMeta.includes('title="x"'), JSON.stringify(codeMeta))
  check('代码围栏 meta：改动写回', codeMeta.includes('const a = 2'), JSON.stringify(codeMeta))

  // 8.8 有序任务项。
  const orderedTask = editAndSave('1. [x] 甲\n2. [ ] 乙\n', () => {
    const node: TextNode | undefined = $getRoot()
      .getAllTextNodes()
      .find(candidate => candidate.getTextContent() === '甲')
    node?.setTextContent('甲X')
  })
  check('有序任务项：保存仍是 1.', orderedTask.includes('1. [x]'), JSON.stringify(orderedTask))
  check('有序任务项：第二项仍是 2.', orderedTask.includes('2. [ ]'), JSON.stringify(orderedTask))

  // 8.9 根定义的引用式链接：改字之后仍写引用式，定义只有一份。
  const referenceKept = editAndSave('[文字][ref]\n\n[ref]: https://example.com\n', () => {
    const node: TextNode | undefined = $getRoot()
      .getAllTextNodes()
      .find(candidate => candidate.getTextContent() === '文字')
    node?.setTextContent('文字X')
  })
  check('引用式链接：保存仍写 [文字][ref]', referenceKept.includes('[文字X][ref]'), JSON.stringify(referenceKept))
  check(
    '引用式链接：定义只有一份',
    occurrences(referenceKept, '[ref]: https://example.com') === 1,
    JSON.stringify(referenceKept),
  )

  // 8.10 引用块里的定义：打开时就能解析成链接（CommonMark §4.7：定义影响整篇）。
  const nestedBody = '> [文字][ref]\n>\n> [ref]: https://example.com\n'
  const nested = openDocument(nestedBody)
  check(
    '引用块里的定义：打开时解析成链接',
    linkDestinations(nested.editor).includes('https://example.com'),
    JSON.stringify(linkDestinations(nested.editor)),
  )
  nested.editor.update(
    () => {
      const node: TextNode | undefined = $getRoot()
        .getAllTextNodes()
        .find(candidate => candidate.getTextContent() === '文字')
      node?.setTextContent('文字X')
    },
    { discrete: true },
  )
  const nestedSaved = saveWith(nested.editor, nestedBody, nested.base)
  check('引用块里的定义：改字之后链接仍在', nestedSaved.includes('[文字X][ref]'), JSON.stringify(nestedSaved))
}

// 9. 双跑：**只把改过的那一块算脏**与整体重算必须逐字节相同（缓存的正确性）。
{
  const { editor, base } = openDocument(body)
  editor.update(
    () => {
      const target: TextNode | undefined = $getRoot()
        .getAllTextNodes()
        .find(node => node.getTextContent().includes('普通段落'))
      target?.setTextContent(target.getTextContent().replace('普通段落', '普通段落Y'))
    },
    { discrete: true },
  )
  const dirtyKeys = editor.getEditorState().read(() => {
    const node = $getRoot()
      .getAllTextNodes()
      .find(candidate => candidate.getTextContent().includes('普通段落Y'))
    if (node === undefined) return new Set<string>()
    let current: LexicalNode = node
    while (current.getParent() !== null && !$isRootNode(current.getParent())) {
      const parent = current.getParent()
      if (parent === null) break
      current = parent
    }
    return new Set([current.getKey()])
  })
  const withDirty = editor.getEditorState().read(() => $saveBody(body, base, '\n', dirtyKeys).body)
  const withoutDirty = editor.getEditorState().read(() => $saveBody(body, base, '\n').body)
  check(
    '双跑：只算一块脏 与 整体重算 逐字节相同',
    withDirty === withoutDirty,
    `${String(dirtyKeys.size)} 块脏`,
  )
  check('双跑：改动确实写出来了', withDirty.includes('普通段落Y'), JSON.stringify(withDirty.slice(0, 40)))
}

// 10. 综合样张：零编辑逐字节；改一处时其余字节不动。
{
  const kitchen = [
    '# 标题',
    '',
    '段落里有 [文字][ref] 和 ![图][img]，还有一个 [普通链接](https://example.org)。',
    '',
    '1. [x] 任务一',
    '2. [ ] 任务二',
    '',
    '```js title="示例"',
    'const a = 1',
    '```',
    '',
    '> 引用里的 [文字][ref]',
    '',
    '| 列 | 值 |',
    '| --- | --- |',
    '| a | b |',
    '',
    '[ref]: https://example.com',
    '[img]: p.png "图注"',
    '',
  ].join('\n')
  const untouched = openDocument(kitchen)
  check('综合样张：零编辑保存逐字节相等', saveWith(untouched.editor, kitchen, untouched.base) === kitchen)

  const edited = openDocument(kitchen)
  edited.editor.update(
    () => {
      const target: TextNode | undefined = $getRoot()
        .getAllTextNodes()
        .find(node => node.getTextContent() === '标题')
      target?.setTextContent('标题X')
    },
    { discrete: true },
  )
  const after = saveWith(edited.editor, kitchen, edited.base)
  check('综合样张：只改标题 ⇒ 差异只在那一行', after === kitchen.replace('# 标题', '# 标题X'), JSON.stringify(after.slice(0, 60)))
  check('综合样张：引用式链接与图片都还在', after.includes('[文字][ref]') && after.includes('![图][img]'))
  check('综合样张：有序任务项与围栏 meta 都在', after.includes('1. [x]') && after.includes('title="示例"'))
  check('综合样张：表格与定义都在', after.includes('| a | b |') && after.includes('[img]: p.png "图注"'))
  check('综合样张：引用块里的引用式链接仍在', after.includes('> 引用里的 [文字][ref]'))
}

// 11. 基线捕获：用户加过空段落时，配对仍然按“内容块”走。
{
  const { editor } = openDocument('一\n\n二\n')
  const keys = editor.getEditorState().read(() => {
    const before = $getRoot().getChildren()
    return { first: before[0]?.getKey() ?? '', second: before[1]?.getKey() ?? '' }
  })
  let emptyKey = ''
  editor.update(
    () => {
      const first = $getRoot().getChildren()[0]
      const blank = $createParagraphNode()
      emptyKey = blank.getKey()
      first?.insertAfter(blank)
    },
    { discrete: true },
  )
  const captured = editor.getEditorState().read(() => $captureBase('一\n\n二\n'))
  check(
    '基线捕获：用户加过空段落也按内容块配对',
    captured.length === 2 &&
      captured[0]?.key === keys.first &&
      captured[1]?.key === keys.second &&
      !captured.some(entry => entry.key === emptyKey),
    captured.map(entry => `${entry.key}:${String(entry.start)}`).join(','),
  )
}

// 12. 链接弹窗的写入判据：显示文字（空 = 用地址）、引用式身份、悬停提示、没变就不动。
{
  /** 在 update 里把某个文字节点整段选中。 */
  const selectText = (match: string): void => {
    const node = $getRoot()
      .getAllTextNodes()
      .find(candidate => candidate.getTextContent() === match)
    if (node === undefined) return
    const selection = $createRangeSelection()
    selection.anchor.set(node.getKey(), 0, 'text')
    selection.focus.set(node.getKey(), node.getTextContentSize(), 'text')
    $setSelection(selection)
  }

  const editedText = editAndSave('[旧](https://a.example)\n', () => {
    selectText('旧')
    $writeLink('https://a.example', '新')
  })
  check('链接：只改显示文字 ⇒ 文字换了、地址没动', editedText === '[新](https://a.example)\n', JSON.stringify(editedText))

  const emptyText = editAndSave('[旧](https://a.example)\n', () => {
    selectText('旧')
    $writeLink('https://a.example', '')
  })
  check('链接：显示文字留空 ⇒ 用地址（尖括号形态）', emptyText.includes('<https://a.example>'), JSON.stringify(emptyText))

  const keptTitle = editAndSave('[旧](https://a.example "提示")\n', () => {
    selectText('旧')
    $writeLink('https://b.example', '旧')
  })
  check(
    '链接：改地址时悬停提示原样保留',
    keptTitle === '[旧](https://b.example "提示")\n',
    JSON.stringify(keptTitle),
  )

  const referenceText = editAndSave('[文字][ref]\n\n[ref]: https://a.example\n', () => {
    selectText('文字')
    $writeLink('https://a.example', '新')
  })
  check(
    '链接：只改文字 ⇒ 引用式写法保留',
    referenceText.includes('[新][ref]') && !referenceText.includes('](https://a.example)'),
    JSON.stringify(referenceText),
  )

  const referenceUrl = editAndSave('[文字][ref]\n\n[ref]: https://a.example\n', () => {
    selectText('文字')
    $writeLink('https://b.example', '文字')
  })
  check(
    '链接：改地址 ⇒ 转成内联链接（定义行不动）',
    referenceUrl.includes('[文字](https://b.example)') && referenceUrl.includes('[ref]: https://a.example'),
    JSON.stringify(referenceUrl),
  )

  const sameBody = '[旧](https://a.example)\n'
  const untouched = openDocument(sameBody)
  let wrote = true
  untouched.editor.update(
    () => {
      const node = $getRoot()
        .getAllTextNodes()
        .find(candidate => candidate.getTextContent() === '旧')
      if (node === undefined) return
      const selection = $createRangeSelection()
      selection.anchor.set(node.getKey(), 0, 'text')
      selection.focus.set(node.getKey(), node.getTextContentSize(), 'text')
      $setSelection(selection)
      wrote = $writeLink('https://a.example', '旧')
    },
    { discrete: true },
  )
  check('链接：值没变 ⇒ 不写（返回 false）', !wrote)
  check('链接：值没变 ⇒ 保存逐字节相同', saveWith(untouched.editor, sameBody, untouched.base) === sameBody)

  const caretLink = editAndSave('前 后\n', () => {
    const node = $getRoot()
      .getAllTextNodes()
      .find(candidate => candidate.getTextContent() === '前 后')
    if (node === undefined) return
    const selection = $createRangeSelection()
    selection.anchor.set(node.getKey(), 1, 'text')
    selection.focus.set(node.getKey(), 1, 'text')
    $setSelection(selection)
    $insertLink('example.com', '')
  })
  check('链接：光标处插入、显示文字留空 ⇒ 地址即文字', caretLink.includes('<https://example.com>'), JSON.stringify(caretLink))

  const caretText = editAndSave('前 后\n', () => {
    const node = $getRoot()
      .getAllTextNodes()
      .find(candidate => candidate.getTextContent() === '前 后')
    if (node === undefined) return
    const selection = $createRangeSelection()
    selection.anchor.set(node.getKey(), 1, 'text')
    selection.focus.set(node.getKey(), 1, 'text')
    $setSelection(selection)
    $insertLink('example.com', '点这里')
  })
  check(
    '链接：光标处插入、填了显示文字 ⇒ [文字](地址)',
    caretText.includes('[点这里](https://example.com)'),
    JSON.stringify(caretText),
  )
}

/*
 * 13. 有序列表的嵌套：任意层都保得住，新子列表从 1 开始，反缩进不删内容。
 *
 * 这里走**真的命令**（registerRichText / registerList），不直接改节点：`$handleIndent` 造出来的
 * 子列表会不会继承父列表的 `start`、反缩进会不会删上一项，都只有真命令能回答。
 * `KEY_TAB_COMMAND` 与生产同一条路（命令监听器在 update 里跑），所以每次之后等一拍再读。
 */
{
  const indentOp = NESTING_OPERATIONS.find(operation => operation.id === 'indent')
  const outdentOp = NESTING_OPERATIONS.find(operation => operation.id === 'outdent')

  // 13.1 父列表不是从 1 开始时，新子列表仍从 1 开始。
  const started = '3. a\n4. b\n'
  const first = openNestingDocument(started)
  caretIn(first.editor, 'b')
  const firstHandled = pressTab(first.editor)
  await settle()
  const nestedOnce = saveWith(first.editor, started, first.base)
  check('嵌套：缩进命令真的做了事', firstHandled)
  check('嵌套：新子列表从 1 开始（不是父列表的 3）', nestedOnce === '3. a\n4. 1. b\n', JSON.stringify(nestedOnce))

  // 13.2 再缩一层：还是从 1 开始，层数 3。
  const secondHandled = pressTab(first.editor)
  await settle()
  const nestedTwice = saveWith(first.editor, started, first.base)
  check('嵌套：再缩一层也做了事', secondHandled)
  check('嵌套：第二层仍从 1 开始', nestedTwice === '3. a\n4. 1. 1. b\n', JSON.stringify(nestedTwice))
  check('嵌套：保存出来的层数是 3', listDepthOf(nestedTwice) === 3, String(listDepthOf(nestedTwice)))

  // 13.3 重开这份三层文件、改最内层一个字：层数不变。
  const reopened = openNestingDocument(nestedTwice)
  reopened.editor.update(
    () => {
      const node = $getRoot()
        .getAllTextNodes()
        .find(candidate => candidate.getTextContent() === 'b')
      node?.setTextContent('bX')
    },
    { discrete: true },
  )
  const resaved = saveWith(reopened.editor, nestedTwice, reopened.base)
  check('嵌套：重开后改字，层数与文字都对', resaved === '3. a\n4. 1. 1. bX\n', JSON.stringify(resaved))

  // 13.4 工具栏 / 斜杠菜单那条路：同一个入口，编号也归 1。
  const viaOperation = openNestingDocument(started)
  caretIn(viaOperation.editor, 'b')
  if (indentOp !== undefined) applyBlockOperation(viaOperation.editor, indentOp)
  await settle()
  const operationSaved = saveWith(viaOperation.editor, started, viaOperation.base)
  check(
    '嵌套：工具栏「增加缩进」也把新层编号归 1',
    operationSaved === '3. a\n4. 1. b\n',
    JSON.stringify(operationSaved),
  )

  // 13.5 有序任务列表：新层同样从 1 开始。
  const task = '3. [x] a\n4. [ ] b\n'
  const taskEditor = openNestingDocument(task)
  caretIn(taskEditor.editor, 'b')
  pressTab(taskEditor.editor)
  await settle()
  const taskSaved = saveWith(taskEditor.editor, task, taskEditor.base)
  check('嵌套：有序任务列表的新层从 1 开始', taskSaved === '3. [x] a\n4. 1. [ ] b\n', JSON.stringify(taskSaved))

  // 13.6 反缩进：唯一子项那种形状拒绝执行（否则上一项会被删掉）。
  const dangerous = '- a\n  - b\n'
  const guarded = openNestingDocument(dangerous)
  caretIn(guarded.editor, 'b')
  const outHandled = pressTab(guarded.editor, true)
  await settle()
  const guardedSaved = saveWith(guarded.editor, dangerous, guarded.base)
  check('反缩进：唯一子项时拒绝（命令报没做）', !outHandled)
  check('反缩进：拒绝之后一个字节都没动', guardedSaved === dangerous, JSON.stringify(guardedSaved))

  // 13.7 工具栏「减少缩进」走同一个入口，不会再删掉上一项。
  const viaToolbar = openNestingDocument(dangerous)
  caretIn(viaToolbar.editor, 'b')
  if (outdentOp !== undefined) applyBlockOperation(viaToolbar.editor, outdentOp)
  await settle()
  const toolbarSaved = saveWith(viaToolbar.editor, dangerous, viaToolbar.base)
  check(
    '反缩进：工具栏那条路也拒绝，内容还在',
    toolbarSaved === dangerous,
    JSON.stringify(toolbarSaved),
  )

  // 13.8 可以安全反缩进的形状仍然照做（被反缩进的项不是父列表的唯一孩子）。
  const safe = '- a\n- b\n  - c\n  - d\n'
  const outdentable = openNestingDocument(safe)
  caretIn(outdentable.editor, 'c')
  const safeHandled = pressTab(outdentable.editor, true)
  await settle()
  const safeSaved = saveWith(outdentable.editor, safe, outdentable.base)
  check('反缩进：安全形状照做', safeHandled, JSON.stringify(safeSaved))
  check(
    '反缩进：安全形状不丢任何一项',
    ['a', 'b', 'c', 'd'].every(text => safeSaved.includes(text)),
    JSON.stringify(safeSaved),
  )
}

// 14. 有序列表：源里本来就有多层时，改一个字只动那一个字、层数不变。
{
  const deep = '1. a\n   1. b\n      1. c\n         1. d\n'
  const edited = editAndSave(deep, () => {
    const node = $getRoot()
      .getAllTextNodes()
      .find(candidate => candidate.getTextContent() === 'd')
    node?.setTextContent('dX')
  })
  check('深层有序列表：改最内层一个字，其余字节不动', edited === deep.replace('d\n', 'dX\n'), JSON.stringify(edited))
  check('深层有序列表：层数仍是 4', listDepthOf(edited) === 4, String(listDepthOf(edited)))

  // 命令缩进写出来的紧凑形状（`2. 1. b`）重开后仍是同样的层，改字也稳定。
  const compact = '1. a\n2. 1. b\n'
  const compactEdited = editAndSave(compact, () => {
    const node = $getRoot()
      .getAllTextNodes()
      .find(candidate => candidate.getTextContent() === 'b')
    node?.setTextContent('bX')
  })
  check('紧凑写法：重开后改字，层数仍是 2', listDepthOf(compactEdited) === 2, JSON.stringify(compactEdited))
  check('紧凑写法：改字只动那一个字', compactEdited === '1. a\n2. 1. bX\n', JSON.stringify(compactEdited))
}

// 15. 样式表：列表的缩进、标记形态与任务框（布局在 CI 里量不到，这里只守来源）。
{
  const rules = EDITOR_CSS.replace(/\/\*[\s\S]*?\*\//g, '')
  check(
    '样式表：没有把列表缩进归零（官方渲染器那条规则会把第 2 层起压平）',
    !/padding-left:\s*0/.test(rules),
  )
  check(
    '样式表：列表容器的缩进仍是 1.5em',
    /\.md-ul,\s*\.md-ol\s*\{[^}]*padding-left:\s*1\.5em/.test(rules),
  )
  check(
    '样式表：有序列表第 1 层是数字',
    /\.md-ol\s*\{[^}]*list-style-type:\s*decimal/.test(rules),
  )
  check(
    '样式表：有序列表第 2 层是字母',
    /\.md-ol > \.md-li > \.md-ol\s*\{[^}]*list-style-type:\s*lower-alpha/.test(rules),
  )
  check(
    '样式表：第 3 层起回到数字',
    /\.md-ol > \.md-li > \.md-ol > \.md-li > \.md-ol\s*\{[^}]*list-style-type:\s*decimal/.test(rules),
  )
  /*
   * 层级字形必须写在 `ol` 上（由项继承）：空父项靠 `.md-li … { list-style: none }` 这条**直接**
   * 声明不画标记，而直接写在 `.md-li` 上的 `list-style-type` 权重更高，会把那条压掉、让隐藏的标记
   * 重新冒出来。这条断言守的就是这个“写在谁身上”。
   */
  check(
    '样式表：空父项仍然不画标记',
    /\.md-li:not\(:has\(> :not\(ul\):not\(ol\)\)\)\s*\{\s*list-style:\s*none/.test(rules),
  )
  check(
    '样式表：层级字形写在 ol 上，不直接写在 li 上',
    !/\.md-li\s*\{[^}]*list-style-type/.test(rules),
  )
  /*
   * 任务框照官方**禁用态**的实测值：13px 框、1px 边框、8px 间距；浅色 #d1d1d1 / #f8f8f8，
   * 深色 #757575 / #3b3b3b + #626262。这三条守的是“别又改回满色/16px”。
   */
  check(
    '样式表：任务框 13px、间距 8px（官方几何）',
    /\.md-li-checked::before,\s*\.md-li-unchecked::before\s*\{[^}]*width:\s*13px[^}]*height:\s*13px[^}]*margin-right:\s*8px/.test(
      rules,
    ),
  )
  check(
    '样式表：任务框用官方禁用色（浅色）',
    /\.md-li-checked::before\s*\{[^}]*background:\s*#d1d1d1/.test(rules) &&
      /\.md-li-unchecked::before\s*\{[^}]*background:\s*#f8f8f8/.test(rules) &&
      /\.md-li-checked::before,\s*\.md-li-unchecked::before\s*\{[^}]*border:\s*1px solid #d1d1d1/.test(rules),
  )
  check(
    '样式表：任务框用官方禁用色（深色）',
    /body\[data-ds-dark-theme\] \.md-li-checked::before\s*\{[^}]*background:\s*#757575/.test(rules) &&
      /body\[data-ds-dark-theme\] \.md-li-unchecked::before\s*\{[^}]*border-color:\s*#626262[^}]*background:\s*#3b3b3b/.test(
        rules,
      ),
  )
  check(
    '样式表：勾的深浅也照官方禁用态（#ededed / #3b3b3b）',
    /\.md-li-checked::after\s*\{[^}]*background:\s*#ededed/.test(rules) &&
      /body\[data-ds-dark-theme\] \.md-li-checked::after\s*\{[^}]*background:\s*#3b3b3b/.test(rules),
  )
  check(
    '样式表：选中的图片有蓝色描边',
    /\.md-image-host\[data-md-image-selected='true'\]\s*\{[^}]*outline:\s*1px solid var\(--dsw-alias-link\)/.test(rules),
  )
}

/*
 * 16. 图片的选中、删除与左右键。
 *
 * 这里走**真的命令**（registerRichText + registerImageKeys），不直接改节点：元素点选区删不动、
 * NodeSelection 走 rich-text、左右键要落到图片两侧，都只有真命令能回答。选中属性是 DOM 上的，
 * headless 量不到（`getElementByKey` 在 headless 抛错），所以这一节只测 `$selectedImageKeys` 的判据。
 */
{
  /** 打开一篇带图片的正文，并挂上真命令。 */
  const openImageDocument = (markdown: string): { editor: LexicalEditor; base: BaseBlock[] } => {
    const editor = createHeadlessEditor({
      nodes: [...EDITOR_NODES],
      onError: (error: Error) => {
        throw error
      },
    })
    registerRichText(editor)
    registerList(editor)
    registerImageKeys(editor)
    let base: BaseBlock[] = []
    editor.update(
      () => {
        base = [...importDocumentMarkdown(markdown)]
      },
      { discrete: true },
    )
    return { editor, base }
  }

  /** 树里第一张图片的节点键。 */
  const imageKeyOf = (editor: LexicalEditor): string =>
    editor.getEditorState().read(() => {
      let found = ''
      const walk = (node: LexicalNode): void => {
        if ($isImageNode(node) && found === '') found = node.getKey()
        if ('getChildren' in node) {
          for (const child of (node as unknown as { getChildren(): LexicalNode[] }).getChildren()) walk(child)
        }
      }
      walk($getRoot())
      return found
    })

  /** 第 index 个顶层块的键。 */
  const blockKeyOf = (editor: LexicalEditor, index: number): string =>
    editor.getEditorState().read(() => $getRoot().getChildren()[index]?.getKey() ?? '')

  /** 文字点跨过图片（从图片前文字的末尾到图片后文字的开头）。 */
  const selectAcrossImage = (editor: LexicalEditor): void => {
    editor.update(
      () => {
        const texts = $getRoot().getAllTextNodes()
        const before = texts[0]
        const after = texts[1]
        if (before === undefined || after === undefined) return
        const selection = $createRangeSelection()
        selection.anchor.set(before.getKey(), before.getTextContentSize(), 'text')
        selection.focus.set(after.getKey(), 0, 'text')
        $setSelection(selection)
      },
      { discrete: true },
    )
  }

  /** 整块选中（元素点选区，浏览器拖过独占图片的段落会得到这种形状）。 */
  const selectBlock = (editor: LexicalEditor, index: number): void => {
    editor.update(
      () => {
        const block = $getRoot().getChildren()[index]
        if (block === undefined || !('select' in block)) return
        const element = block as unknown as { select(anchor: number, focus: number): void; getChildrenSize(): number }
        element.select(0, element.getChildrenSize())
      },
      { discrete: true },
    )
  }

  /** 把图片选成 NodeSelection。 */
  const selectImageNode = (editor: LexicalEditor, key: string): void => {
    editor.update(
      () => {
        const selection = $createNodeSelection()
        selection.add(key)
        $setSelection(selection)
      },
      { discrete: true },
    )
  }

  /** 跑一次 Delete。 */
  const deleteSelection = (editor: LexicalEditor): void => {
    editor.update(
      () => {
        editor.dispatchCommand(DELETE_CHARACTER_COMMAND, true)
      },
      { discrete: true },
    )
  }

  /** 跑一次左右键（命令由 registerImageKeys 接管）。 */
  const pressArrow = (editor: LexicalEditor, command: typeof KEY_ARROW_LEFT_COMMAND): boolean => {
    let handled = false
    const event = {
      shiftKey: false,
      altKey: false,
      metaKey: false,
      ctrlKey: false,
      preventDefault: () => undefined,
    } as unknown as KeyboardEvent
    editor.update(
      () => {
        handled = editor.dispatchCommand(command, event)
      },
      { discrete: true },
    )
    return handled
  }

  /** 选区读数：折叠与否 + 锚点。 */
  const selectionReading = (editor: LexicalEditor): string =>
    editor.getEditorState().read(() => {
      const selection = $getSelection()
      if (!$isRangeSelection(selection)) return 'not-range'
      return `${selection.isCollapsed() ? 'collapsed' : 'range'} ${selection.anchor.type}:${selection.anchor.key}:${String(selection.anchor.offset)}`
    })

  /** 当前选区里的图片键。 */
  const selectedKeys = (editor: LexicalEditor): string[] =>
    editor.getEditorState().read(() => $selectedImageKeys())

  // 16.1 文字点跨图：Delete 删图，文字保留（两侧空格留下）。
  {
    const source = '前 ![图](p.png) 后\n'
    const { editor, base } = openImageDocument(source)
    selectAcrossImage(editor)
    check('图片：文字点跨图时，选中键里只有这张图', selectedKeys(editor).length === 1, selectedKeys(editor).join(','))
    deleteSelection(editor)
    const after = saveWith(editor, source, base)
    check('图片：文字点跨图 + Delete，图片没了、文字还在', after === '前  后\n', JSON.stringify(after))
  }

  // 16.2 元素点整段选中一张独占的图：Delete 也能删（改前 rich-text 什么都不删）。
  {
    const source = '段落\n\n![图](p.png)\n'
    const { editor, base } = openImageDocument(source)
    selectBlock(editor, 1)
    deleteSelection(editor)
    const after = saveWith(editor, source, base)
    check('图片：整段选中独占图片 + Delete，图片没了、前一段一个字节不动', after === '段落\n', JSON.stringify(after))
  }

  // 16.3 整篇只有这张图：删掉后按 P3 写空。
  {
    const source = '![图](p.png)\n'
    const { editor, base } = openImageDocument(source)
    selectBlock(editor, 0)
    deleteSelection(editor)
    const after = saveWith(editor, source, base)
    check('图片：整篇只有一张图，删掉后正文写空（P3）', after === '', JSON.stringify(after))
  }

  // 16.4 元素点整段选中“文字 + 图片”：文字与图片都删，前面那段不动。
  {
    const source = '段落\n\n前 ![图](p.png) 后\n'
    const { editor, base } = openImageDocument(source)
    selectBlock(editor, 1)
    deleteSelection(editor)
    const after = saveWith(editor, source, base)
    check('图片：整段选中文字+图片 + Delete，两样都没了、前一段不动', after === '段落\n', JSON.stringify(after))
  }

  // 16.4b 文字点选中“文字 + 图片”：两样都删。
  {
    const source = '前 ![图](p.png) 后\n'
    const { editor, base } = openImageDocument(source)
    editor.update(
      () => {
        const texts = $getRoot().getAllTextNodes()
        const before = texts[0]
        const after = texts[1]
        if (before === undefined || after === undefined) return
        const selection = $createRangeSelection()
        selection.anchor.set(before.getKey(), 0, 'text')
        selection.focus.set(after.getKey(), after.getTextContentSize(), 'text')
        $setSelection(selection)
      },
      { discrete: true },
    )
    deleteSelection(editor)
    const after = saveWith(editor, source, base)
    check('图片：文字点选中文字+图片 + Delete，两样都没了', after === '', JSON.stringify(after))
  }

  // 16.5 NodeSelection：交给 rich-text，图片删掉。
  {
    const source = '前 ![图](p.png) 后\n'
    const { editor, base } = openImageDocument(source)
    selectImageNode(editor, imageKeyOf(editor))
    deleteSelection(editor)
    const after = saveWith(editor, source, base)
    check('图片：NodeSelection + Delete，图片没了', after === '前  后\n', JSON.stringify(after))
  }

  // 16.6 左/右：只选图片时，光标贴到图片两侧。
  {
    const source = '前 ![图](p.png) 后\n'
    const { editor } = openImageDocument(source)
    const texts = editor.getEditorState().read(() =>
      $getRoot().getAllTextNodes().map(text => ({ key: text.getKey(), size: text.getTextContentSize() })),
    )
    selectAcrossImage(editor)
    const left = pressArrow(editor, KEY_ARROW_LEFT_COMMAND)
    check('图片：左键被接管', left)
    check(
      '图片：左键落在图片左侧（前一个文字节点的末尾）',
      selectionReading(editor) === `collapsed text:${texts[0]?.key ?? ''}:${String(texts[0]?.size ?? 0)}`,
      selectionReading(editor),
    )

    selectAcrossImage(editor)
    const right = pressArrow(editor, KEY_ARROW_RIGHT_COMMAND)
    check('图片：右键被接管', right)
    check(
      '图片：右键落在图片右侧（后一个文字节点的开头）',
      selectionReading(editor) === `collapsed text:${texts[1]?.key ?? ''}:0`,
      selectionReading(editor),
    )
  }

  // 16.7 独占图片的整段：左右键落在块元素偏移 0 / 1（图片前 / 后）。
  {
    const source = '![图](p.png)\n'
    const { editor } = openImageDocument(source)
    const paragraphKey = blockKeyOf(editor, 0)
    selectBlock(editor, 0)
    const left = pressArrow(editor, KEY_ARROW_LEFT_COMMAND)
    check('图片：独占图片时左键被接管', left)
    check('图片：左键落在图片前（块元素偏移 0）', selectionReading(editor) === `collapsed element:${paragraphKey}:0`, selectionReading(editor))

    selectBlock(editor, 0)
    const right = pressArrow(editor, KEY_ARROW_RIGHT_COMMAND)
    check('图片：独占图片时右键被接管', right)
    check('图片：右键落在图片后（块元素偏移 1）', selectionReading(editor) === `collapsed element:${paragraphKey}:1`, selectionReading(editor))
  }

  // 16.8 选中判据：图片前后紧挨着的文字不会把图片带进来；折叠不算选中。
  {
    const source = '前 ![图](p.png) 后 尾\n'
    const { editor } = openImageDocument(source)
    const imageKey = imageKeyOf(editor)

    // 从图片后面的文字中间开始选：选区里只有文字。
    editor.update(
      () => {
        const after = $getRoot().getAllTextNodes()[1]
        if (after === undefined) return
        const selection = $createRangeSelection()
        selection.anchor.set(after.getKey(), 1, 'text')
        selection.focus.set(after.getKey(), 3, 'text')
        $setSelection(selection)
      },
      { discrete: true },
    )
    check('图片：图片后面的文字选区不算选中图片', selectedKeys(editor).length === 0, selectedKeys(editor).join(','))

    // 从图片后面的文字开头选到文字中段：仍然不算。
    editor.update(
      () => {
        const after = $getRoot().getAllTextNodes()[1]
        if (after === undefined) return
        const selection = $createRangeSelection()
        selection.anchor.set(after.getKey(), 0, 'text')
        selection.focus.set(after.getKey(), 2, 'text')
        $setSelection(selection)
      },
      { discrete: true },
    )
    check('图片：从图片正后方开始的选区仍不算选中图片', selectedKeys(editor).length === 0, selectedKeys(editor).join(','))

    // 折叠选区不算选中。
    editor.update(
      () => {
        const before = $getRoot().getAllTextNodes()[0]
        if (before === undefined) return
        const selection = $createRangeSelection()
        selection.anchor.set(before.getKey(), 1, 'text')
        selection.focus.set(before.getKey(), 1, 'text')
        $setSelection(selection)
      },
      { discrete: true },
    )
    check('图片：折叠选区不算选中图片', selectedKeys(editor).length === 0, selectedKeys(editor).join(','))

    // 文字 + 图片一起选：图片仍算选中（高亮跟着选区走）。
    selectAcrossImage(editor)
    check('图片：文字跨图时图片算选中', selectedKeys(editor).length === 1 && selectedKeys(editor)[0] === imageKey, selectedKeys(editor).join(','))

    selectImageNode(editor, imageKey)
    check('图片：NodeSelection 时图片算选中', selectedKeys(editor).length === 1, selectedKeys(editor).join(','))
  }

  // 16.9 图片后面的文字再删，也不许把图片带走。
  {
    const source = '前 ![图](p.png) 后 尾\n'
    const { editor, base } = openImageDocument(source)
    editor.update(
      () => {
        const after = $getRoot().getAllTextNodes()[1]
        if (after === undefined) return
        const selection = $createRangeSelection()
        selection.anchor.set(after.getKey(), 1, 'text')
        selection.focus.set(after.getKey(), 3, 'text')
        $setSelection(selection)
      },
      { discrete: true },
    )
    deleteSelection(editor)
    const after = saveWith(editor, source, base)
    check('图片：删图片后面的文字，图片仍在', after.includes('![图](p.png)'), JSON.stringify(after))
  }

  // 16.9b 链接里的图片（徽章）：删图后空链接被清理，前一段不动。
  {
    const source = '段落\n\n[![图](p.png)](https://example.com)\n'
    const { editor, base } = openImageDocument(source)
    selectBlock(editor, 1)
    deleteSelection(editor)
    const after = saveWith(editor, source, base)
    check('图片：链接里的图片也能删，前一段不动', after === '段落\n', JSON.stringify(after))
  }

  // 16.10 P3：删光内容写空；空文档 / 只有空行保留原文。
  {
    const { editor, base } = openDocument('段落\n')
    editor.update(
      () => {
        $getRoot().clear()
      },
      { discrete: true },
    )
    check('保存：内容块全被删光 ⇒ 正文写空', saveWith(editor, '段落\n', base) === '', JSON.stringify(saveWith(editor, '段落\n', base)))

    const blank = openDocument('\n\n')
    check('保存：只有空行的原文保留', saveWith(blank.editor, '\n\n', blank.base) === '\n\n')
    check('保存：空文档 / 空基线仍是空串', saveWith(blank.editor, '', []) === '')
  }
  // ── 随包示例：能打开 ──────────────────────────────────────────────────
  // The shipped templates are product text, so nothing here may depend on their wording — but a
  // copy-edit must not be able to ship a document the editor refuses to import.
  for (const name of ['关于.md', '功能介绍.md']) {
    const path = fileURLToPath(new URL(`../_vault-test/${name}`, import.meta.url))
    let blocks = 0
    try {
      const { editor } = openDocument(splitFrontmatter(readFileSync(path, 'utf8')).body)
      blocks = editor.getEditorState().read(() => $getRoot().getChildrenSize())
    } catch {
      blocks = 0
    }
    check(`示例：${name} 能打开`, blocks > 0, String(blocks))
  }
}

console.log(`\n${failures === 0 ? '全部通过' : `${String(failures)} 项失败`}`)
if (failures > 0) process.exitCode = 1
