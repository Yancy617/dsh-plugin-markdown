/**
 * 列表的嵌套：缩进 / 反缩进这一层，以及新子列表的起始编号。
 *
 * 内容
 * - $nestSelection(editor, direction)：在光标所在的列表项上缩进 / 反缩进一层（必须在 update 里调用）。
 * - registerListIndent(editor)：把这一步接到 Tab / Shift+Tab。
 * - $listItemAtCaret()：包住光标的列表项；走到代码块即答 `null`。
 *
 * 行为
 * - 缩进派发 `INDENT_CONTENT_COMMAND`，并在**同一次 update** 里把这次新建的列表编号归 1。
 *   `@lexical/list` 的 `$handleIndent` 用 `$copyNode(parent)` 造新子列表，会把父列表的 `start`
 *   一起复制：`3. a` / `4. b` 缩进出来曾是 `4. 3. b`（新层显示 3.），现在是 `4. 1. b`。
 *   有序任务列表的 `taskListForm`（`1. [x]` 那条状态）一起归 1。
 * - **只归这次新建的列表**：缩进到旁边已经存在的子列表时不动它——源里本来就写 `start=3` 的
 *   嵌套列表是作者的意思，不是这一层该改的。
 * - 反缩进在“被反缩进的项是父列表唯一孩子”时拒绝：`@lexical/list` 的 `$handleOutdent` 会把
 *   上一层的项整个删掉（实测：`- a` / `  - b` 反缩进 → `- b`，`a` 没了）。拒绝就是“这一步做不到，
 *   但不静默删内容”。
 * - 命令与编号修正落在同一条撤销记录里：调用方那一次 update 同时装下两者。
 * - `registerListIndent` 只做按键绑定：Tab / Shift+Tab → 上面这一步，真的做了事才 `preventDefault`。
 *
 * 边界
 * - 光标不在列表项里就返回 `false`（不拦 Tab、不动段落缩进）。
 * - 不定义操作的名字与图标（operations.ts）。
 * - 不改保存规则：块被改过才走标准写（blockSave.ts）。
 *
 * 相关文件
 * - 依赖：tree.ts（顶层块定位）、taskListForm.ts、@lexical/list。
 * - 被依赖：operations.ts、MarkdownEditor.tsx、scripts/probe-block.ts。
 *
 * 改哪里
 * - 新子列表的初始编号：$resetCreatedListStarts。
 * - 反缩进的拒绝条件：$nestSelection。
 */
import {
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  COMMAND_PRIORITY_LOW,
  INDENT_CONTENT_COMMAND,
  KEY_TAB_COMMAND,
  OUTDENT_CONTENT_COMMAND,
  type LexicalEditor,
  type LexicalNode,
} from 'lexical'
import { $isListItemNode, $isListNode, type ListItemNode } from '@lexical/list'
import { $setTaskListForm, $taskListFormOf } from './taskListForm'
import { $topLevelBlockOf } from './tree'

/** 缩进（`in`）还是反缩进（`out`）。 */
export type NestDirection = 'in' | 'out'

/**
 * 包住光标的列表项。
 *
 * 一路往上走，遇到代码块立刻答 `null`：Tab 在代码块里属于代码块，不是列表缩进。
 * 必须在 Lexical 的编辑器上下文里调用。
 * @returns 列表项，或 `null`。
 */
export function $listItemAtCaret(): ListItemNode | null {
  const selection = $getSelection()
  if (!$isRangeSelection(selection)) return null
  let node: LexicalNode | null = selection.anchor.getNode()
  while (node !== null) {
    if ($isListItemNode(node)) return node
    if (node.getType() === 'code') return null
    node = node.getParent()
  }
  return null
}

/**
 * 在光标所在的列表项上走一层。
 *
 * **必须在编辑器 update 里调用**（`$` 开头就是这条约定）：读选区、派发命令、修正新列表的编号都在
 * 调用方那一次 update 里完成，所以一步缩进只留下一条撤销记录。两条入口各自负责上下文：
 * `registerListIndent` 在按键命令自己的 update 里调它，`operations.ts` 的工具栏 / 斜杠菜单那条路
 * 先开一次 update。
 *
 * 返回 `false` 表示“这一步没有发生”，调用方应当把按键留给浏览器（Tab 不 `preventDefault`）；
 * 返回 `true` 表示命令真的做了事。反缩进被拒绝也算 `false`——那一步做不到。
 * @param editor - 正在编辑的编辑器。
 * @param direction - 缩进还是反缩进。
 * @returns 这一步有没有发生。
 */
export function $nestSelection(editor: LexicalEditor, direction: NestDirection): boolean {
  const item = $listItemAtCaret()
  if (item === null) return false
  if (direction === 'out') {
    if (isOnlyChild(item)) return false
    return editor.dispatchCommand(OUTDENT_CONTENT_COMMAND, undefined)
  }

  const before = $listKeysAroundCaret()
  const handled = editor.dispatchCommand(INDENT_CONTENT_COMMAND, undefined)
  if (handled) $resetCreatedListStarts(before)
  return handled
}

/**
 * Bind {@link $nestSelection} to Tab / Shift+Tab.
 *
 * Above rich-text's own `KEY_TAB_COMMAND` handler, which is at `COMMAND_PRIORITY_EDITOR`, only escapes
 * format triggers and returns `false` (the browser would move focus out of the editor). Only a step that
 * really happened gets `preventDefault`.
 * @param editor - the editor to bind.
 * @returns the unregister function.
 */
export function registerListIndent(editor: LexicalEditor): () => void {
  return editor.registerCommand(
    KEY_TAB_COMMAND,
    event => {
      const handled = $nestSelection(editor, event.shiftKey ? 'out' : 'in')
      if (handled) event.preventDefault()
      return handled
    },
    COMMAND_PRIORITY_LOW,
  )
}

/**
 * 被反缩进的项是不是父列表的唯一孩子——`$handleOutdent` 会因此删掉上一项。
 * @param item - 光标所在的列表项。
 * @returns 是否只有它一个。
 */
function isOnlyChild(item: ListItemNode): boolean {
  const parent = item.getParent()
  if (parent === null) return false
  return parent.getChildren().filter($isListItemNode).length === 1
}

/**
 * 光标所在顶层块里的列表节点键（缩进前的快照）。
 *
 * 只走顶层块：缩进不会把节点搬出它所在的块，所以“新列表”一定落在这份快照的补集里。
 * 必须在 Lexical 的编辑器上下文里调用。
 * @returns 列表节点键。
 */
function $listKeysAroundCaret(): ReadonlySet<string> {
  const keys = new Set<string>()
  const selection = $getSelection()
  if (!$isRangeSelection(selection)) return keys
  const block = $topLevelBlockOf(selection.anchor.getNode())
  if (block === null) return keys
  const walk = (node: LexicalNode): void => {
    if ($isListNode(node)) keys.add(node.getKey())
    if ($isElementNode(node)) for (const child of node.getChildren()) walk(child)
  }
  walk(block)
  return keys
}

/**
 * 把这次缩进新建的列表的起始编号归 1。
 *
 * “新建”＝不在 `before` 快照里；已存在的子列表保持原样（可能是源里写的 `start`）。
 * 必须在 Lexical 的编辑器上下文里调用。
 * @param before - 缩进前的列表节点键。
 */
function $resetCreatedListStarts(before: ReadonlySet<string>): void {
  const selection = $getSelection()
  if (!$isRangeSelection(selection)) return
  const block = $topLevelBlockOf(selection.anchor.getNode())
  if (block === null) return
  const walk = (node: LexicalNode): void => {
    if ($isListNode(node) && !before.has(node.getKey())) {
      if (node.getStart() !== 1) node.setStart(1)
      const form = $taskListFormOf(node)
      if (form !== null && form.ordered && form.start !== 1) {
        $setTaskListForm(node, { ordered: true, start: 1 })
      }
    }
    if ($isElementNode(node)) for (const child of node.getChildren()) walk(child)
  }
  walk(block)
}
