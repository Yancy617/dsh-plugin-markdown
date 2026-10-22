/**
 * Lexical 契约门：验证本插件依赖的几条 Lexical 行为仍然成立。
 *
 * 内容
 * - L1：相邻同类列表默认会被合并；块间分隔节点能阻止。
 * - L2：ListItemNode 默认把段落并成行内文字（多段项因此走投影 / source，不硬塞）。
 * - L3：SourceBlockNode 可创建、可改 raw、改动带 SOURCE_EDIT_TAG。
 *
 * 行为
 * - 只跑无头编辑器，不碰产品文件；失败 exit 1。
 * - 升级 Lexical 时先跑这一支；失败优先改 adapter，不改 Markdown 规则。
 *
 * 边界
 * - 不测 GUI / DOM / 选择；那些由人验收。
 * - 不测 Table / Link 的全部 API；只测本插件当前依赖的形状。
 *
 * 相关文件
 * - 被依赖：package.json（probe:lexical）、docs/开发环境.md。
 * - 依赖：config.ts、blockBreak.ts、sourceBlock.tsx。
 *
 * 改哪里
 * - 新增依赖行为：加一条 L。
 */
import { createHeadlessEditor } from '@lexical/headless'
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $isElementNode,
  type LexicalEditor,
  type LexicalNode,
} from 'lexical'
import { $createListItemNode, $createListNode } from '@lexical/list'
import { EDITOR_NODES } from '../src/client/editor/config'
import { $createBlockBreakNode } from '../src/client/editor/blockBreak'
import {
  $createSourceBlockNode,
  $isSourceBlockNode,
  $splitSourceBlock,
  SOURCE_EDIT_TAG,
} from '../src/client/editor/sourceBlock'

let failures = 0
function check(title: string, ok: boolean, detail = ''): void {
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${title}${detail === '' ? '' : ` — ${detail}`}`)
}

function makeEditor(): LexicalEditor {
  return createHeadlessEditor({
    nodes: [...EDITOR_NODES],
    onError: (error: Error) => {
      throw error
    },
  })
}

function listOf(text: string): ReturnType<typeof $createListNode> {
  const list = $createListNode('bullet')
  const item = $createListItemNode()
  const paragraph = $createParagraphNode()
  paragraph.append($createTextNode(text))
  item.append(paragraph)
  list.append(item)
  return list
}

// L1：两张相邻列表默认合并且只剩一个节点。
{
  const editor = makeEditor()
  editor.update(
    () => {
      $getRoot().append(listOf('a'), listOf('b'))
    },
    { discrete: true },
  )
  editor.getEditorState().read(() => {
    check('L1 相邻列表默认合并成一个', $getRoot().getChildrenSize() === 1)
  })
}

// L1b：中间隔一个块间分隔节点就不会合并。
{
  const editor = makeEditor()
  editor.update(
    () => {
      $getRoot().append(listOf('a'), $createBlockBreakNode(), listOf('b'))
    },
    { discrete: true },
  )
  editor.getEditorState().read(() => {
    const children = $getRoot().getChildren()
    check('L1b 分隔节点阻止列表合并', children.length === 3, children.map(child => child.getType()).join(','))
  })
}

// L2：ListItemNode 默认把段落并成文字；这是“多段项不硬塞”的理由。
{
  const editor = makeEditor()
  editor.update(
    () => {
      const list = $createListNode('bullet')
      const item = $createListItemNode()
      const first = $createParagraphNode()
      first.append($createTextNode('one'))
      const second = $createParagraphNode()
      second.append($createTextNode('two'))
      item.append(first, second)
      list.append(item)
      $getRoot().append(list)
    },
    { discrete: true },
  )
  editor.getEditorState().read(() => {
    const list = $getRoot().getFirstChild()
    const item = $isElementNode(list) ? list.getFirstChild() : null
    const types: string[] = $isElementNode(item)
      ? item.getChildren().map((child: LexicalNode) => child.getType())
      : []
    check('L2 ListItem 默认把段落并成文字', types.includes('text'), types.join(','))
  })
}

// L3：SourceBlockNode 改 raw 会带 SOURCE_EDIT_TAG。
{
  const editor = makeEditor()
  editor.update(
    () => {
      $getRoot().append($createSourceBlockNode('a'))
    },
    { discrete: true },
  )
  let tagged = false
  const unregister = editor.registerUpdateListener(({ tags }) => {
    if (tags.has(SOURCE_EDIT_TAG)) tagged = true
  })
  editor.update(
    () => {
      const node = $getRoot().getFirstChild()
      if ($isSourceBlockNode(node)) node.setRaw('b')
    },
    { discrete: true },
  )
  unregister()
  editor.getEditorState().read(() => {
    const node = $getRoot().getFirstChild()
    check('L3 source 块可改 raw 并带 tag', $isSourceBlockNode(node) && node.getRaw() === 'b' && tagged)
  })
}

// L4：多块 source 失焦拆分，每段仍是 source，原文不丢。
{
  const editor = makeEditor()
  editor.update(
    () => {
      $getRoot().append($createSourceBlockNode('a\n\nb'))
    },
    { discrete: true },
  )
  editor.update(
    () => {
      const node = $getRoot().getFirstChild()
      if ($isSourceBlockNode(node)) $splitSourceBlock(node)
    },
    { discrete: true },
  )
  editor.getEditorState().read(() => {
    const children = $getRoot().getChildren()
    const raws = children.map(child => ($isSourceBlockNode(child) ? child.getRaw() : ''))
    check('L4 多块 source 失焦拆分', raws.length === 2 && raws[0] === 'a' && raws[1] === 'b', raws.join('|'))
  })
}

console.log(failures === 0 ? '\n全部通过' : `\n${String(failures)} 条失败`)
if (failures > 0) process.exitCode = 1
