/**
 * 在当前编辑器树上查找与替换。
 *
 * 内容
 * - Match / FindBarProps / $collectMatches / FindBar。
 * - REPLACE_TAG / row / fields / controls / closeGroup。
 *
 * 行为
 * - 查询变化时从当前树重算匹配，不缓存（任何编辑都会让偏移失效）。
 * - 替换走 editor.update 与 REPLACE_TAG；监听器忽略带 tag 的更新，输入不带 tag 就关闭。
 * - 只读时禁用替换与输入框，查找仍可用。
 * - 匹配由 highlight.ts 的 markMatches 标出，关闭时 clearMarks。
 *
 * 边界
 * - 不负责高亮实现（highlight.ts）与工具栏布局（toolbar.module.css）。
 *
 * 相关文件
 * - 依赖：highlight.ts、toolbar.module.css、sidebar.module.css、primitives。
 * - 被依赖：MarkdownWorkbench.tsx。
 *
 * 改哪里
 * - 改匹配：$collectMatches。
 * - 改替换：REPLACE_TAG 与替换处理。
 * - 改布局：row / fields / controls。
 */
import {
  $getNodeByKey,
  $getRoot,
  $isElementNode,
  $isTextNode,
  type LexicalEditor,
  type LexicalNode,
} from 'lexical'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { clearMarks, markMatches } from './highlight'
import toolbarStyles from './toolbar.module.css'
/* The one square icon button this plugin has, rather than a second definition of the same thing. */
import styles from '../sidebar.module.css'
import {
  Button,
  IconChevronDownOutlineRegular,
  IconChevronUpOutlineRegular,
  IconCloseOutlineRegular,
  IconSearchOutlineRegular,
  Input,
} from '@deepseek-ai/dsh-client-ui-primitives'

/** One occurrence of the query. */
export interface Match {
  /** Key of the text node containing it. */
  readonly nodeKey: string
  /** Offset of the first character. */
  readonly start: number
  /** Offset one past the last character. */
  readonly end: number
}

/**
 * The tag a replacement carries.
 *
 * The reader asked for typing in the document to close the find, and a replacement is a text change too.
 * Lexical tags updates for this: the replacement is tagged and the listener below ignores it, while typing
 * carries no tag and closes the bar.
 */
const REPLACE_TAG = 'dsh-find-replace'

/** Props for {@link FindBar}. */
export interface FindBarProps {
  /** The live editor, or `null` before the composer reports readiness. */
  readonly editor: LexicalEditor | null
  /** The query, held by the workbench so it survives this component unmounting. */
  readonly query: string
  /** The replacement, likewise. */
  readonly replacement: string
  /** Set the query. */
  readonly onQuery: (value: string) => void
  /** Set the replacement. */
  readonly onReplacement: (value: string) => void
  /** Close the bar. */
  readonly onClose: () => void
  /**
   * Whether the document refuses edits.
   *
   * **Finding is a read and stays**: searching a document you may not change is exactly what a
   * read-only view is for. Replacing is a write to the tree, and Lexical's own boundary would not
   * stop it — this is one of the **programmatic** dispatchers, calling `editor.update` directly,
   * while `isEditable()` is consulted at the *DOM* boundary (`lexical.dev.mjs`), never by
   * `update` or `dispatchCommand`. So the two controls are disabled here rather than left to fail
   * silently, and the field is disabled with them: an editable box beside two dead buttons would be
   * a promise nothing keeps.
   */
  readonly readOnly?: boolean
}

/*
 * The row the toolbar shows while finding. No padding and no border of its own: the toolbar is the container
 * and already has both, and stacking two would double them.
 *
 * `nowrap` where the old bar wrapped. Wrapping was fine when this was a band of its own and could grow
 * downwards; inside the toolbar it would push the toolbar taller, which is what must not happen. The fields
 * give instead, down to nothing.
 */
const row: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  flex: 1,
  minWidth: 0,
  flexWrap: 'nowrap',
}

/*
 * The fields block. It takes the room the row has to give, up to 480 — below that the two fields share it
 * evenly. The controls follow it directly rather than being pushed to the far edge, so past 480 the slack
 * collects at the right end of the row instead of between the two blocks.
 */
const fields: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  flex: '1 1 auto',
  minWidth: 0,
  maxWidth: 480,
}

/* The counter and the four controls: fixed, following the fields, and never the thing that gives. */
const controls: React.CSSProperties = {
  display: 'flex',
  flex: '0 0 auto',
  alignItems: 'center',
  gap: 8,
}

/*
 * The close control on its own, pushed to the right edge of the row.
 *
 * Alone rather than with the controls above, because it is answering a different question: they belong to
 * the fields and sit with them, while this one belongs to the toolbar's right end and has to stay on the
 * line the find button is on, at every width.
 */
const closeGroup: React.CSSProperties = {
  display: 'flex',
  flex: '0 0 auto',
  alignItems: 'center',
  gap: 8,
  marginLeft: 'auto',
}

/*
 * One field's container, and nothing about its height. The toolbar is a fixed 44 and the primitive's 32 fits
 * inside it, so the height is settled by the bar rather than by anything here.
 */
/*
 * One field's container.
 *
 * `flex: 1 1 0` against its sibling, so the two share the block evenly — equal basis, equal growth, equal
 * shrinkage. `grid` so the primitive inside fills it without being reached into.
 *
 * `minmax(0, 1fr)` because an `auto` column's minimum is the item's min-content, and that item is a native
 * `<input>` around 170 pixels wide by default — a floor no `min-width` on this box can lift, since the
 * constraint lives on the column. Stating the minimum as zero is what lets a field give all the way down.
 */
const field: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr)',
  minWidth: 0,
  flex: '1 1 0',
}

/**
 * Escape a string for literal use inside a RegExp.
 * @param value - raw text.
 * @returns the escaped text.
 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Collect every occurrence of a query in the editor tree. Must run inside a read.
 * @param query - the search text.
 * @returns the matches in document order.
 */
export function $collectMatches(query: string): Match[] {
  const needle = query.toLowerCase()
  const matches: Match[] = []

  const visit = (node: LexicalNode): void => {
    if ($isTextNode(node)) {
      const text = node.getTextContent().toLowerCase()
      let index = text.indexOf(needle)
      while (index >= 0) {
        matches.push({ nodeKey: node.getKey(), start: index, end: index + query.length })
        index = text.indexOf(needle, index + query.length)
      }
      return
    }
    if ($isElementNode(node)) for (const child of node.getChildren()) visit(child)
  }

  for (const child of $getRoot().getChildren()) visit(child)
  return matches
}

/**
 * Render the find and replace bar.
 * @param props - the live editor and the close callback.
 * @returns the bar.
 */
export function FindBar({
  editor,
  query,
  replacement,
  onQuery,
  onReplacement,
  onClose,
  readOnly = false,
}: FindBarProps) {
  const [active, setActive] = useState(0)
  const queryRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    queryRef.current?.focus()
  }, [])

  /**
   * Bumped on every editor update, so the list below is recomputed after an edit.
   *
   * Without it the memo keyed on `[editor, query]` alone, and a replacement changes neither — so
   * every offset in the list went stale the instant one was replaced, while the comment in
   * `replaceCurrent` said the list would be recomputed on the next render. Editor updates are the
   * event that invalidates those offsets, so they are what this listens to.
   */
  const [version, setVersion] = useState(0)

  useEffect(() => {
    if (editor === null) return undefined
    return editor.registerUpdateListener(({ tags }) => {
      // The bar's own replacement. It is a change to the document like any other, and the reader asked for
      // it not to count as typing.
      if (tags.has(REPLACE_TAG)) {
        setVersion(current => current + 1)
        return
      }
      /*
       * Anything else is the document being edited — by the keyboard, by a paste, by an undo. The reader is
       * done looking and has gone back to writing, so the find closes rather than sitting there over the
       * text they are now changing.
       *
       * Selecting and moving the caret do not arrive here at all: they are not document changes.
       */
      onClose()
    })
  }, [editor, onClose])

  /** Recompute matches from the current state. */
  const matches = useMemo<readonly Match[]>(() => {
    if (editor === null || query === '') return []
    return editor.getEditorState().read(() => $collectMatches(query))
  }, [editor, query, version])

  // A narrowed query shrinks the list; keep the cursor inside it.
  useEffect(() => {
    setActive(current => (current < matches.length ? current : 0))
  }, [matches.length])

  // Marked rather than selected, and left marked while the bar is open — the reader can see where
  // every occurrence is, not only the one being stepped to.
  useEffect(() => {
    if (editor === null || matches.length === 0) {
      clearMarks('find')
      return
    }
    markMatches('find', editor, matches, active)
  }, [editor, matches, active])

  // The marks belong to the bar, so they go when it does.
  useEffect(() => () => clearMarks('find'), [])

  /**
   * Step to the next or previous match, wrapping.
   *
   * Scrolls and moves the mark. Replacing the editor's selection and taking the caret would
   * meant stepping threw away whatever the reader had selected and pulled focus out of the find
   * field they were typing in. The scroll is instant rather than smooth, as the search landing is:
   * one gesture should not move differently depending on which feature asked for it.
   */
  const step = useCallback(
    (delta: number): void => {
      if (matches.length === 0) return
      const next = (active + delta + matches.length) % matches.length
      setActive(next)
      const match = matches[next]
      if (editor !== null && match !== undefined) {
        editor.getElementByKey(match.nodeKey)?.scrollIntoView({ block: 'center' })
      }
    },
    [active, editor, matches],
  )

  /** Replace the active match and advance. */
  const replaceCurrent = useCallback((): void => {
    const match = matches[active]
    if (editor === null || match === undefined) return
    editor.update(
      () => {
        const node = $getNodeByKey(match.nodeKey)
        if (!$isTextNode(node)) return
        const text = node.getTextContent()
        node.setTextContent(text.slice(0, match.start) + replacement + text.slice(match.end))
      },
      { tag: REPLACE_TAG },
    )
    // Offsets after this point all moved. The list is recomputed on the next render — the version bump
    // above is what the memo depends on — and the active index stays where it is, which lands on the
    // following occurrence because the one under it is gone.
  }, [active, editor, matches, replacement])

  /** Replace every occurrence in the document. */
  const replaceAll = useCallback((): void => {
    if (editor === null || query === '') return
    const pattern = new RegExp(escapeRegExp(query), 'gi')
    editor.update(() => {
      for (const match of $collectMatches(query)) {
        const node = $getNodeByKey(match.nodeKey)
        if (!$isTextNode(node)) continue
        const text = node.getTextContent()
        // The replacement is text the reader typed, not a pattern: `$&` and `$1` in it must stay
        // two characters rather than being read by `String.replace` as the match and a group.
        const next = text.replace(pattern, replacement.replace(/\$/g, '$$$$'))
        if (next !== text) node.setTextContent(next)
      }
    },
      { tag: REPLACE_TAG },
    )
    setActive(0)
  }, [editor, query, replacement])

  return (
    <div className={toolbarStyles.findRow} style={row}>
      <div style={fields}>
      <span style={{ display: 'inline-flex', flex: 'none', color: 'var(--dsw-alias-label-tertiary)', opacity: 0.7 }}>
        <IconSearchOutlineRegular size={16} />
      </span>
      <span style={field}>
      <Input
        ref={queryRef}
        value={query}
        placeholder="查找"
        aria-label="查找"
        onChange={event => onQuery(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Enter') step(event.shiftKey ? -1 : 1)
          if (event.key === 'Escape') onClose()
        }}
      />
      </span>
      <span style={field}>
      <Input
        value={replacement}
        placeholder="替换为"
        aria-label="替换为"
        disabled={readOnly}
        onChange={event => onReplacement(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Escape') onClose()
        }}
      />
      </span>

      </div>

      <div style={controls}>
      <span
        style={{
          opacity: 0.7,
          fontSize: 12,
          fontVariantNumeric: 'tabular-nums',
          textAlign: 'right',
        }}
      >
        {query === '' ? '' : matches.length === 0 ? '无匹配' : `${active + 1} / ${matches.length}`}
      </span>

      <Button
        size="sm"
        variant="ghost"
        disabled={matches.length === 0}
        icon={<IconChevronUpOutlineRegular size={16} />}
        aria-label="上一个"
        onClick={() => step(-1)}
      />
      <Button
        size="sm"
        variant="ghost"
        disabled={matches.length === 0}
        icon={<IconChevronDownOutlineRegular size={16} />}
        aria-label="下一个"
        onClick={() => step(1)}
      />
      <Button size="sm" variant="outline" disabled={readOnly || matches.length === 0} onClick={replaceCurrent}>
        替换
      </Button>
      <Button size="sm" variant="outline" disabled={readOnly || matches.length === 0} onClick={replaceAll}>
        全部替换
      </Button>
      </div>

      <div style={closeGroup}>
      <Button
        size="sm"
        variant="ghost"
        className={styles.iconButton}
        icon={<IconCloseOutlineRegular size={16} />}
        aria-label="关闭查找"
        onClick={onClose}
      />
      {/*
        Reserved, not empty: the width of the overflow button that follows the find button in the toolbar, so
        the close control here lands on the same vertical line the find button sits on. Same class, so the
        width is read from the one place that states it.
      */}
      <span className={styles.iconButton} style={{ visibility: 'hidden' }} aria-hidden="true" />
      </div>
    </div>
  )
}
