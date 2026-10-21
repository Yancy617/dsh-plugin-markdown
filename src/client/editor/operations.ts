/**
 * 块级 / 列表操作的定义：一次定义，两个界面共用。
 *
 * 内容
 * - ListKind / BlockConversion / BlockOperation / NESTING_OPERATIONS / BLOCK_OPERATIONS。
 * - blockOperation / convertBlock / applyBlockOperation / canNest。
 *
 * 行为
 * - 块操作（段落、标题、引用、无序 / 有序列表）在这里定义。
 * - 转换走 $setBlocksType；缩进 / 反缩进交给 listNesting.ts 的 $nestSelection（命令与
 *   新子列表编号在那里同一次 update 里完成）。
 * - 表现（图标、标签）留在各自界面；关键词属于操作本身，供搜索。
 *
 * 边界
 * - 不负责界面渲染与菜单。
 * - 不负责快捷键（shortcuts.ts）。
 * - 不负责列表嵌套的树操作与判据（listNesting.ts）。
 *
 * 相关文件
 * - 依赖：listNesting.ts。
 * - 被依赖：FloatingToolbar.tsx、SlashMenu.tsx、MarkdownWorkbench.tsx。
 *
 * 改哪里
 * - 新增操作：BLOCK_OPERATIONS / NESTING_OPERATIONS。
 * - 改转换：convertBlock / applyBlockOperation。
 */
import { $createCodeNode } from '@lexical/code-core'
import {
  INSERT_CHECK_LIST_COMMAND,
  INSERT_ORDERED_LIST_COMMAND,
  INSERT_UNORDERED_LIST_COMMAND,
  REMOVE_LIST_COMMAND,
} from '@lexical/list'
import { $createHeadingNode, $createQuoteNode } from '@lexical/rich-text'
import { $setBlocksType } from '@lexical/selection'
import {
  $createParagraphNode,
  $getSelection,
  $isRangeSelection,
  type ElementNode,
  type LexicalCommand,
  type LexicalEditor,
  type LexicalNode,
} from 'lexical'
import { $listItemAtCaret, $nestSelection } from './listNesting'

/** The list kinds this package offers. */
export type ListKind = 'bullet' | 'number' | 'check'

/** An operation that converts the current block into another kind of block. */
export interface BlockConversion {
  readonly kind: 'block'
  /** Stable id. */
  readonly id: string
  /** Human label. */
  readonly label: string
  /**
   * Extra text a search should match, beyond the label.
   *
   * Part of the operation rather than of any one surface: how you *find* an
   * operation is the same question whichever menu is asking.
   */
  readonly keywords: string
  /**
   * Produce the block to convert into.
   *
   * A builder rather than a node: the import path may already hold one, and a
   * node can only ever be in one place.
   */
  readonly create: () => ElementNode
}

/** An operation that inserts a list. */
export interface ListInsertion {
  readonly kind: 'list'
  /** Stable id. */
  readonly id: string
  /** Human label. */
  readonly label: string
  /** Extra text a search should match, beyond the label. */
  readonly keywords: string
  /** Which list this is, so a surface that toggles knows what "already on" means. */
  readonly listKind: ListKind
  /** Inserts the list. */
  readonly insert: LexicalCommand<void>
  /** Turns it back into plain blocks. */
  readonly remove: LexicalCommand<void>
}

/** An operation that moves the current list item one level deeper, or takes it back out. */
export interface Nesting {
  readonly kind: 'nest'
  /** Stable id. */
  readonly id: string
  /** Human label. */
  readonly label: string
  /** Extra text a search should match, beyond the label. */
  readonly keywords: string
  /** What the operation does to the item the caret is on. */
  readonly direction: 'in' | 'out'
}

/** One block-level operation. */
export type BlockOperation = BlockConversion | ListInsertion | Nesting

/**
 * Block and list operations, in the order a menu should offer them.
 *
 * Ordered block kinds first, then lists, then the code block — the order both
 * surfaces already used.
 */
export const BLOCK_OPERATIONS: readonly BlockOperation[] = [
  {
    kind: 'block',
    id: 'paragraph',
    label: '正文',
    keywords: 'text paragraph p',
    create: () => $createParagraphNode(),
  },
  {
    kind: 'block',
    id: 'h1',
    label: '一级标题',
    keywords: 'h1 heading title',
    create: () => $createHeadingNode('h1'),
  },
  {
    kind: 'block',
    id: 'h2',
    label: '二级标题',
    keywords: 'h2 heading',
    create: () => $createHeadingNode('h2'),
  },
  {
    kind: 'block',
    id: 'h3',
    label: '三级标题',
    keywords: 'h3 heading',
    create: () => $createHeadingNode('h3'),
  },
  {
    kind: 'block',
    id: 'h4',
    label: '四级标题',
    keywords: 'h4 heading',
    create: () => $createHeadingNode('h4'),
  },
  {
    kind: 'block',
    id: 'h5',
    label: '五级标题',
    keywords: 'h5 heading',
    create: () => $createHeadingNode('h5'),
  },
  {
    kind: 'block',
    id: 'h6',
    label: '六级标题',
    keywords: 'h6 heading',
    create: () => $createHeadingNode('h6'),
  },
  {
    kind: 'block',
    id: 'quote',
    label: '引用',
    keywords: 'quote blockquote',
    create: () => $createQuoteNode(),
  },
  {
    kind: 'list',
    id: 'bullet',
    label: '无序列表',
    keywords: 'ul bullet list unordered',
    listKind: 'bullet',
    insert: INSERT_UNORDERED_LIST_COMMAND,
    remove: REMOVE_LIST_COMMAND,
  },
  {
    kind: 'list',
    id: 'number',
    label: '有序列表',
    keywords: 'ol number ordered list',
    listKind: 'number',
    insert: INSERT_ORDERED_LIST_COMMAND,
    remove: REMOVE_LIST_COMMAND,
  },
  {
    kind: 'list',
    id: 'check',
    label: '任务列表',
    keywords: 'todo task check list',
    listKind: 'check',
    insert: INSERT_CHECK_LIST_COMMAND,
    remove: REMOVE_LIST_COMMAND,
  },
  {
    kind: 'block',
    id: 'code',
    label: '代码块',
    keywords: 'code fence pre',
    create: () => $createCodeNode(),
  },
  // **The two nesting operations come last, and they are the only two that are conditional.** They do
  // nothing outside a list item — `@lexical/rich-text`'s `INDENT_CONTENT_COMMAND` handler returns `false`
  // when there is no block under the selection that can be indented — so a surface offering them must
  // hide them rather than show a button that does nothing. `NESTING_OPERATIONS` below is what a surface
  // appends after `canNest` says yes; keeping them out of `BLOCK_OPERATIONS` is what stops the slash
  // menu from listing them in an empty paragraph.
  {
    kind: 'nest',
    id: 'indent',
    label: '增加缩进',
    keywords: 'indent tab nest deeper 缩进',
    direction: 'in',
  },
  {
    kind: 'nest',
    id: 'outdent',
    label: '减少缩进',
    keywords: 'outdent unindent shift tab shallower 反缩进 取消缩进',
    direction: 'out',
  },
]

/**
 * The nesting operations, in the order a menu should offer them.
 *
 * Separate from {@link BLOCK_OPERATIONS} because they are conditional: a surface adds these only when
 * the caret is in a list item, and appending them unconditionally would put two entries in the slash
 * menu that cannot do anything there.
 */
export const NESTING_OPERATIONS: readonly Nesting[] = BLOCK_OPERATIONS.filter(
  (operation): operation is Nesting => operation.kind === 'nest',
)

/**
 * Look up a block operation.
 * @param id - operation id.
 * @returns the operation, or `undefined` when the id is unknown.
 */
export function blockOperation(id: string): BlockOperation | undefined {
  return BLOCK_OPERATIONS.find(operation => operation.id === id)
}

/**
 * Convert the selection's block into another kind.
 * @param editor - the live editor.
 * @param create - builds the block to convert into.
 */
export function convertBlock(editor: LexicalEditor, create: () => ElementNode): void {
  editor.update(() => {
    const selection = $getSelection()
    if ($isRangeSelection(selection)) $setBlocksType(selection, create)
  })
}

/**
 * Run one block operation against a live editor.
 *
 * The single place that knows how an operation is applied, so a surface never
 * has to decide between "convert the block" and "dispatch the list command" for
 * itself. Focus is deliberately left to the caller: a slash menu and a command
 * palette want different things afterwards.
 * @param editor - the live editor.
 * @param operation - which operation.
 */
export function applyBlockOperation(editor: LexicalEditor, operation: BlockOperation): void {
  if (operation.kind === 'block') convertBlock(editor, operation.create)
  else if (operation.kind === 'nest') {
    editor.update(() => $nestSelection(editor, operation.direction))
  } else editor.dispatchCommand(operation.insert, undefined)
}

/**
 * Whether a nesting operation would do something at the caret.
 *
 * The one walk lives in `listNesting.ts` (`$listItemAtCaret`), so a **surface** can ask the question
 * without reaching into Lexical's node classes, and the answer cannot drift from what
 * {@link $nestSelection} actually acts on: both the toolbar and the slash menu use it to decide whether
 * to offer the pair at all.
 *
 * **It looks at the anchor only, and deliberately does not require a collapsed selection.** Requiring one
 * would make this answer `false` for the floating bar every time, because that bar is shown only for a
 * non-collapsed selection — it would hide the buttons exactly where they are wanted. The caret is what
 * decides here, and a selection that starts inside a list item can be indented.
 *
 * A code block is excluded for the same reason Tab inside one belongs to the code block.
 * @param editor - the live editor.
 * @returns whether a nesting operation would have something to act on.
 */
export function canNest(editor: LexicalEditor): boolean {
  return editor.getEditorState().read(() => $listItemAtCaret() !== null)
}
