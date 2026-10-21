/**
 * 斜杠命令菜单。
 *
 * 内容
 * - SlashCommand / SlashState / CLOSED / BLOCK_ICONS / EXTRA_COMMANDS / COMMANDS / SlashMenu。
 *
 * 行为
 * - 在块首或空白后输入 / 打开菜单；查询是文档的一部分，执行时随选区一起删除。
 * - 撤销 / 重做（HISTORIC_TAG）只恢复文档与选区，不按恢复出的 `/` 重开菜单。
 * - 键盘由本组件以 KEY_DOWN_COMMAND 高优先级处理（焦点始终在编辑器里）。
 * - 命令来自 operations.ts；分割线 / 表格 / 图片 / 链接是本菜单独有的四条。
 * - 图片与链接要先填值：选它们只删掉 `/查询`、打开各自的弹窗，写入由弹窗提交时完成。
 * - 插入块后用 $ensureParagraphAfter 留一个可写段落。
 *
 * 边界
 * - 不负责块操作定义（operations.ts）、图片弹窗（ImageDialog.tsx）与链接弹窗（LinkDialog.tsx）。
 *
 * 相关文件
 * - 依赖：operations、paragraphAfter、tree、RuleNode、table、ImageDialog、LinkDialog、linkEdit、primitives。
 * - 被依赖：MarkdownEditor.tsx。
 *
 * 改哪里
 * - 改命令：COMMANDS / EXTRA_COMMANDS。
 * - 改键盘：KEY_DOWN_COMMAND 处理。
 * - 改开合：SlashState / CLOSED。
 */
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import {
  $createRangeSelection,
  $getNodeByKey,
  $getSelection,
  $isRangeSelection,
  $isTextNode,
  $setSelection,
  COMMAND_PRIORITY_HIGH,
  HISTORIC_TAG,
  KEY_DOWN_COMMAND,
  type LexicalEditor,
  type LexicalNode,
  type RangeSelection,
} from 'lexical'
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  IconChecklistOutlineRegular,
  IconCodeOutlineRegular,
  IconLinkOutlineRegular,
  Menu,
  type MenuEntry,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { applyBlockOperation, BLOCK_OPERATIONS, canNest, NESTING_OPERATIONS } from './operations'
import { $ensureParagraphAfter } from './paragraphAfter'
import { $topLevelBlockOf } from './tree'
import { $createRuleNode } from './RuleNode'
import { $createFreshTable } from './tableModel'
import { IMAGE_COMMAND_ICON, ImagePathDialog } from './ImageDialog'
import { LinkDialog, EMPTY_LINK_SEED } from './LinkDialog'
import { $insertLink } from './linkEdit'

/** One insertable block. */
interface SlashCommand {
  /** Stable id passed to the menu and back. */
  readonly id: string
  /** Row label. */
  readonly label: string
  /** Extra text the filter matches, beyond the label. */
  readonly keywords: string
  /** Leading glyph, from the product icon set where one fits. */
  readonly icon: React.ReactNode
  /**
   * Apply the command. Runs after the `/query` text is already gone, so the
   * selection is collapsed in the emptied block.
   * @param editor - the live editor.
   */
  readonly run: (editor: LexicalEditor) => void
}

/** The open menu's anchor in the document. */
interface SlashState {
  readonly open: boolean
  /** Text typed after the slash, without it. */
  readonly query: string
  /** Key of the text node holding the `/query`. */
  readonly nodeKey: string
  /** Offset of the slash inside that node. */
  readonly slashOffset: number
  /** Offset just past the query inside that node. */
  readonly caretOffset: number
}

const CLOSED: SlashState = {
  open: false,
  query: '',
  nodeKey: '',
  slashOffset: 0,
  caretOffset: 0,
}

/**
 * Replace the current block with a node, always leaving a paragraph after it so
 * the caret has somewhere to continue — neither a thematic break nor a table
 * accepts typing on its own.
 *
 * 那一个空段落与光标由 `./paragraphAfter.ts` 的 `$ensureParagraphAfter` 落地（`Mod+Enter`
 * 用的是同一个动作）：**"一个块之后留一个可写的位置"只有一份实现**，两条路不会各写一套。
 * @param editor - the live editor.
 * @param create - builds the replacement node.
 */
function replaceBlock(editor: LexicalEditor, create: () => LexicalNode): void {
  editor.update(() => {
    const selection = $getSelection()
    if (!$isRangeSelection(selection)) return
    const top = $topLevelBlockOf(selection.anchor.getNode())
    if (top === null) return
    const replacement = create()
    top.replace(replacement)
    $ensureParagraphAfter(replacement)
  })
}

/**
 * The slash menu's icon for each block operation.
 *
 * Presentation only. The operations and their search keywords come from
 * `./operations`, so the seven this menu shares with the floating format bar —
 * and the keywords the command palette also searches — are defined in one place.
 *
 * **All six levels are listed, and that is the fix for a real defect.** `h4`–`h6`
 * All six are listed; missing ones would make the row builder fill the gap with the operation's
 * own label — so those three rows drew `四级标题` twice, once in the icon column and
 * once in the label column. `operations.ts` has defined all six since it was
 * written, which is why nothing caught it: the id was known, only its glyph was not.
 *
 * **No glyph is a multi-character CJK word.** The platform sizes this column at
 * 14px (`Menu.module.css` → `.itemIcon`) and starts the label 6px further right;
 * a full-width character is one em — 13px at the row's font size — so a
 * two-character word needs 26px. CJK breaks between characters, so it wrapped
 * onto a second line and the row became two lines tall. `正文` was exactly that,
 * and it also printed the row's own label a second time; `T` (text) is one cell
 * wide, the same kind of typographic glyph as `H1`, `❝`, `•` and `1.`.
 */
const BLOCK_ICONS: Readonly<Record<string, React.ReactNode>> = {
  paragraph: 'T',
  h1: 'H1',
  h2: 'H2',
  h3: 'H3',
  h4: 'H4',
  h5: 'H5',
  h6: 'H6',
  quote: '❝',
  bullet: '•',
  number: '1.',
  check: <IconChecklistOutlineRegular size={16} />,
  code: <IconCodeOutlineRegular size={16} />,
  // The product set has no indent glyph — all 94 of its `…Regular` icons were listed and none is one —
  // so these two are typographic, like `T`, `H1` and `❝` above. `⇥` is the tab arrow, which is the
  // key that performs this operation.
  indent: '⇥',
  outdent: '⇤',
}

/** The id of the one command that asks for a value before it can insert anything. */
const IMAGE_COMMAND_ID = 'image'

/** 先填地址、再插入的那种：与图片同一套节奏（弹窗提交时才写进文档）。 */
const LINK_COMMAND_ID = 'link'

/**
 * The operations this menu offers that the floating bar does not, built here
 * because they are the slash menu's alone.
 */
const EXTRA_COMMANDS: readonly SlashCommand[] = [
  {
    id: 'rule',
    label: '分割线',
    keywords: 'hr rule divider',
    icon: '—',
    run: editor => replaceBlock(editor, () => $createRuleNode()),
  },
  {
    id: 'table',
    label: '表格',
    keywords: 'table grid',
    // The product set has no table glyph; a drawn one here would be exactly the
    // duplicated artwork this plugin avoids, so the label is typographic.
    icon: '▦',
    run: editor => replaceBlock(editor, () => $createFreshTable(2, 3)),
  },
  {
    id: IMAGE_COMMAND_ID,
    label: '图片',
    keywords: 'image img picture photo 图片 插图',
    // The product set has no picture glyph, but it does have the file-type glyph it draws for image
    // files — the same one the sidebar's file rows use. Reusing it is what "the official artwork for
    // images" means here; drawing a second one would be the duplication this plugin avoids.
    icon: IMAGE_COMMAND_ICON,
    // Nothing to insert yet: a destination has to be typed first, so this one opens a dialog. The
    // caret is already in the emptied block by then, which is where the dialog writes.
    run: () => {},
  },
  {
    id: LINK_COMMAND_ID,
    label: '链接',
    keywords: 'link url hyperlink 超链接 网址 链接',
    icon: <IconLinkOutlineRegular size={16} />,
    // 与图片同一套：先填值。填了显示文字 ⇒ `[文字](地址)`；留空 ⇒ 链接本身就是那个地址。
    run: () => {},
  },
]

/** Every command the menu offers, in display order. */
const COMMANDS: readonly SlashCommand[] = [
  ...BLOCK_OPERATIONS.map(operation => ({
    id: operation.id,
    label: operation.label,
    keywords: operation.keywords,
    // No fallback to the label. A row whose glyph is missing shows the label once,
    // in the label column, where it belongs — the old `?? operation.label` drew it
    // a second time in the icon column, which is how the three missing levels went
    // unnoticed instead of looking empty.
    icon: BLOCK_ICONS[operation.id],
    // The menu inserts: it is reached by typing `/` in an empty block, so
    // toggling would be meaningless. The floating bar is where toggling lives.
    run: (editor: LexicalEditor) => applyBlockOperation(editor, operation),
  })),
  ...EXTRA_COMMANDS,
]

/**
 * The ids this menu hides unless the caret is in a list item.
 *
 * Taken from `operations.ts` rather than written out, so adding a third nesting operation there cannot
 * leave a stale list here.
 */
const NESTING_IDS = new Set(NESTING_OPERATIONS.map(operation => operation.id))

/**
 * Render the slash command menu.
 * @returns the menu, or `null` while it is closed.
 */
export function SlashMenu() {
  const [editor] = useLexicalComposerContext()
  const [slash, setSlash] = useState<SlashState>(CLOSED)
  const [highlighted, setHighlighted] = useState(0)
  const [imageDialog, setImageDialog] = useState(false)
  const [linkDialog, setLinkDialog] = useState(false)

  const mappable = useMemo(() => {
    const query = slash.query.trim().toLowerCase()
    if (query === '') return COMMANDS
    return COMMANDS.filter(
      command =>
        command.label.includes(query) ||
        command.id.includes(query) ||
        command.keywords.includes(query),
    )
  }, [slash.query])

  // **The nesting pair is offered only where it means something.** `canNest` asks the live editor
  // whether the caret is in a list item, so an empty paragraph does not list two entries that cannot do
  // anything there. It is read here rather than at module load because the answer depends on the caret,
  // and the menu is rebuilt on every caret move anyway.
  const matches = useMemo(
    () => (canNest(editor) ? mappable : mappable.filter(command => !NESTING_IDS.has(command.id))),
    [editor, mappable, slash.open],
  )

  // Re-evaluate on every update: an update covers both typing and caret moves.
  useEffect(
    () =>
      editor.registerUpdateListener(({ editorState, tags }) => {
        /**
         * **Undo / redo is result data, not a menu gesture.**
         *
         * A historic update restores the document's text and selection, and the restored caret can
         * happen to sit after a `/` that was already part of the document. Re-evaluating here
         * would pop the menu open for an action the writer did not just take; the menu is UI, and
         * undo must not drive it. Closing an already-open menu is the same rule: the restored state
         * is what the writer asked to see, not a fresh slash command.
         */
        if (tags.has(HISTORIC_TAG)) {
          setSlash(CLOSED)
          return
        }
        editorState.read(() => {
          const selection = $getSelection()
          if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
            setSlash(CLOSED)
            return
          }
          const anchor = selection.anchor
          if (anchor.type !== 'text') {
            setSlash(CLOSED)
            return
          }
          const node = anchor.getNode()
          if (!$isTextNode(node)) {
            setSlash(CLOSED)
            return
          }
          const before = node.getTextContent().slice(0, anchor.offset)
          const slashOffset = before.lastIndexOf('/')
          if (slashOffset < 0) {
            setSlash(CLOSED)
            return
          }
          // The slash must open the block, or follow whitespace, so a path or a
          // URL being typed never raises the menu.
          const preceding = slashOffset === 0 ? '' : before[slashOffset - 1]
          if (preceding !== undefined && preceding !== '' && !/\s/.test(preceding)) {
            setSlash(CLOSED)
            return
          }
          const query = before.slice(slashOffset + 1)
          if (/\s/.test(query)) {
            setSlash(CLOSED)
            return
          }
          setSlash({
            open: true,
            query,
            nodeKey: node.getKey(),
            slashOffset,
            caretOffset: anchor.offset,
          })
        })
      }),
    [editor],
  )

  // Keep the highlight inside the current result set as the query narrows.
  useEffect(() => {
    setHighlighted(current => (current < matches.length ? current : 0))
  }, [matches.length])

  /**
   * Remove the `/query` text, then run the chosen command.
   * @param id - the chosen command's id.
   */
  const choose = useCallback(
    (id: string): void => {
      const command = COMMANDS.find(candidate => candidate.id === id)
      const snapshot = slash
      setSlash(CLOSED)
      if (command === undefined || !snapshot.open) return

      editor.update(() => {
        const node = $getNodeByKey(snapshot.nodeKey)
        if (!$isTextNode(node)) return
        const range: RangeSelection = $createRangeSelection()
        range.anchor.set(snapshot.nodeKey, snapshot.slashOffset, 'text')
        range.focus.set(snapshot.nodeKey, snapshot.caretOffset, 'text')
        $setSelection(range)
        range.removeText()
      })

      // The one command that needs a value first. The `/query` text is already gone and the caret sits
      // in the emptied block, so the dialog opens over the document rather than instead of it — and
      // the focus goes to the dialog's field, not back to the editor.
      if (id === IMAGE_COMMAND_ID) {
        setImageDialog(true)
        return
      }
      if (id === LINK_COMMAND_ID) {
        setLinkDialog(true)
        return
      }
      command.run(editor)
      editor.focus()
    },
    [editor, slash],
  )
  // Keys while the menu is open. The caret stays in the editor, so the menu
  // cannot own these itself.
  useEffect(
    () =>
      editor.registerCommand(
        KEY_DOWN_COMMAND,
        event => {
          if (!slash.open) return false
          switch (event.key) {
            case 'ArrowDown':
              setHighlighted(current => (matches.length === 0 ? 0 : (current + 1) % matches.length))
              event.preventDefault()
              return true
            case 'ArrowUp':
              setHighlighted(current =>
                matches.length === 0 ? 0 : (current - 1 + matches.length) % matches.length,
              )
              event.preventDefault()
              return true
            case 'Enter': {
              /*
               * 带 Mod 的回车不归菜单管：Mod+Enter 是 paragraphAfter.ts 的“在当前块之后另起一段”。
               * 这一层跑在 KEY_DOWN_COMMAND 上、优先级又是 HIGH，不放手它永远轮不到。
               */
              if (event.ctrlKey || event.metaKey) return false
              const chosen = matches[highlighted]
              if (chosen === undefined) return false
              event.preventDefault()
              choose(chosen.id)
              return true
            }
            case 'Escape':
              event.preventDefault()
              setSlash(CLOSED)
              return true
            default:
              return false
          }
        },
        COMMAND_PRIORITY_HIGH,
      ),
    [choose, editor, highlighted, matches, slash.open],
  )

  const items = useMemo<MenuEntry[]>(
    () => matches.map(command => ({ id: command.id, label: command.label, icon: command.icon })),
    [matches],
  )

  return (
    <>
      <ImagePathDialog
        editor={editor}
        open={imageDialog}
        onClose={() => setImageDialog(false)}
      />
      <LinkDialog
        open={linkDialog}
        seed={EMPTY_LINK_SEED}
        onClose={() => setLinkDialog(false)}
        onSubmit={(url, text) => {
          /*
           * 光标就在被清空的那个块里（`/查询` 已经删掉），所以这里只做"在光标处插入一处链接"。
           * 显示文字留空时 `$insertLink` 用地址当文字 —— 写出来就是 `<地址>` 那种尖括号形态。
           */
          editor.update(
            () => {
              $insertLink(url, text)
            },
            { discrete: true },
          )
          editor.focus()
          setLinkDialog(false)
        }}
      />
      <Menu
      open={slash.open && matches.length > 0}
      portal
      side="bottom"
      align="start"
      autoFocus={false}
      anchor={<span aria-hidden="true" style={{ display: 'none' }} />}
      items={items}
      selectedId={matches[highlighted]?.id}
      selection="fill"
      onSelect={choose}
      onClose={() => setSlash(CLOSED)}
      // The caret never leaves the editor, so the menu has no trigger to
      // measure; the live selection rect is the anchor.
      getAnchorRect={() => {
        const native = window.getSelection()
        if (native === null || native.rangeCount === 0) return null
        return native.getRangeAt(0).getBoundingClientRect()
      }}
      />
    </>
  )
}
