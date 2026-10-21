/**
 * 文档工具条：路径、只读 / 未保存、字数、查找入口、更多菜单；查找打开时整条换成查找行。
 *
 * 内容
 * - WorkbenchToolbarProps / WorkbenchToolbar。
 *
 * 行为
 * - 网页标签在前时整条收起（`hidden`）；查找行只在富文本视图里出现。
 * - 只读与未保存互斥：只读优先，未保存不再显示（见内联注释）。
 * - 「更多」菜单的开合是本地状态；菜单行与选中态由调用方给。
 *
 * 边界
 * - 不拥有文档状态，不执行命令（只把 id 交回）；不负责匹配与替换（FindBar）。
 *
 * 相关文件
 * - 依赖：FindBar、primitives（Button / Menu / PathLabel / Tag / 图标）、sidebar.module.css 的图标按钮类。
 * - 被依赖：MarkdownWorkbench.tsx。
 *
 * 改哪里
 * - 改工具条内容：WorkbenchToolbar。
 * - 改查找条：editor/FindBar.tsx。
 */
import type { LexicalEditor } from 'lexical'
import { useState, type CSSProperties, type ReactElement } from 'react'
import {
  Button,
  IconEllipsisOutlineRegular,
  IconSearchOutlineRegular,
  Menu,
  PathLabel,
  Tag,
  type MenuEntry,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { FindBar } from '../editor/FindBar'
import styles from '../sidebar.module.css'

/**
 * The toolbar's band.
 *
 * The separator is `border-l3`, not `l2`: the shell reserves the lighter `l2` for rows inside a
 * group (its settings rows, its list groups) and draws a panel header — which is what this is —
 * with `l3`. The two are one step apart in weight and the difference is the whole distinction
 * between a divider and a header edge.
 *
 * Its height is fixed and the vertical padding is inside it rather than around it — 44 is what
 * 8 + 28 + 8 came to, stated once instead of emerging. What that buys is a band nothing inside can
 * resize: the find row's fields are 32 tall, four more than the toolbar's own controls, and they
 * use the slack instead of pushing the editor down.
 */
const toolbar: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  boxSizing: 'border-box',
  height: 44,
  padding: '0 12px',
  borderBottom: '.5px solid var(--dsw-alias-border-l3)',
  flexShrink: 0,
  minWidth: 0,
}

/**
 * The toolbar while the find is showing.
 *
 * The same box — same padding, same border, same height — with `nowrap` because the fields inside
 * give rather than wrap. Wrapping would make the toolbar taller, and the reader asked for its
 * height not to move.
 */
const toolbarFind: CSSProperties = {
  ...toolbar,
  flexWrap: 'nowrap',
}

/** 网页状态下的文档工具条：整条收起。 */
const hiddenToolbar: CSSProperties = { display: 'none' }

/** What the toolbar draws and reports. */
export interface WorkbenchToolbarProps {
  /** A web tab is in front: the whole band is hidden. */
  readonly hidden: boolean
  /** The find row replaces the document controls. */
  readonly findOpen: boolean
  /** The source view is showing (the find row is not available there). */
  readonly sourceMode: boolean
  /** The live composer, for the find bar. */
  readonly editor: LexicalEditor | null
  /** Find query, held above the bar so it survives closing it. */
  readonly query: string
  /** Replacement text, same reason. */
  readonly replacement: string
  onQuery(value: string): void
  onReplacement(value: string): void
  onCloseFind(): void
  /** The document refuses edits. */
  readonly readOnly: boolean
  /** The writer changed the text. */
  readonly dirty: boolean
  /** The showing document's path. */
  readonly path: string
  /** The stats line, already formatted. */
  readonly stats: string
  /** Whether `toggleFind` may run. */
  readonly canFind: boolean
  onToggleFind(): void
  /** Rows for the 更多 menu. */
  readonly moreMenuRows: readonly MenuEntry[]
  /** Run one command by id. */
  onCommand(id: string): void
}

/**
 * The document toolbar.
 * @param props - document state, find state, and the menu's rows.
 * @returns the toolbar.
 */
export function WorkbenchToolbar(props: WorkbenchToolbarProps): ReactElement {
  /**
   * The 更多 menu's own open state.
   *
   * Local because it is transient UI state: it is not in the panel snapshot and nothing else reads
   * it. `Menu` owns no toggle — its props are open/anchor/items/onSelect/onClose — so the anchor's
   * click is what opens it, as it is for the other menus in this panel.
   */
  const [moreOpen, setMoreOpen] = useState(false)

  return (
    <header
      style={props.hidden ? hiddenToolbar : props.findOpen && !props.sourceMode ? toolbarFind : toolbar}
    >
      {props.findOpen && !props.sourceMode ? (
        <FindBar
          editor={props.editor}
          query={props.query}
          replacement={props.replacement}
          onQuery={props.onQuery}
          onReplacement={props.onReplacement}
          onClose={props.onCloseFind}
          readOnly={props.readOnly}
        />
      ) : (
        <>
          <span style={{ marginRight: 'auto', minWidth: 0 }}>
            <PathLabel path={props.path} />
          </span>

          {/*
            Which of the two states this document is in. 只读 replaces 未保存 rather than joining it:
            `dirty` is about what *the writer* changed, and a document that refuses edits has
            nothing of theirs to lose — while a 未保存 tag on it would claim exactly the opposite,
            and it can appear the moment such a document is opened (some documents do not survive a
            round trip through the editor byte for byte, so `content !== saved` from the first
            export onward).
          */}
          {props.readOnly ? <Tag>只读</Tag> : props.dirty && <Tag tone="warning">未保存</Tag>}

          <span style={{ opacity: 0.6, fontSize: 12, whiteSpace: 'nowrap' }}>{props.stats}</span>

          <Button
            className={styles.iconButton}
            size="sm"
            variant={props.findOpen ? 'outline' : 'ghost'}
            icon={<IconSearchOutlineRegular size={16} />}
            aria-label="查找替换"
            disabled={!props.canFind}
            onClick={props.onToggleFind}
          />

          <Menu
            open={moreOpen}
            portal
            align="end"
            autoFocus
            anchor={
              <Button
                className={styles.iconButton}
                size="sm"
                variant="ghost"
                icon={<IconEllipsisOutlineRegular size={16} />}
                aria-label="更多"
                title="更多"
                aria-expanded={moreOpen}
                onClick={() => setMoreOpen(current => !current)}
              />
            }
            items={props.moreMenuRows}
            // Which mode is in use. The two rows are the modes themselves rather than a toggle, so
            // without this the menu could say 编辑模式 while the editor is showing source.
            selectedId={props.sourceMode ? 'modeSource' : 'modeEdit'}
            selection="fill"
            onSelect={id => {
              setMoreOpen(false)
              props.onCommand(id)
            }}
            onClose={() => setMoreOpen(false)}
          />
        </>
      )}
    </header>
  )
}
