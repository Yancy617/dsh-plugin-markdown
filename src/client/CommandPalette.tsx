/**
 * 工作台与编辑器所有可运行命令的浮层列表。
 *
 * 内容
 * - PaletteEntry / CommandPaletteProps / list / row / CommandPalette。
 *
 * 行为
 * - 只接收行并调用 run，不拥有命令；两份目录（工作台命令、BLOCK_OPERATIONS）都经这里到达。
 * - 打开时清空查询并聚焦；过滤匹配 label 与 keywords。
 * - ↑/↓ 循环选择，Enter 运行；分组标题随 section 变化输出。
 *
 * 边界
 * - 不定义命令、不判断前置条件（enabled 由调用方给）。
 *
 * 相关文件
 * - 依赖：primitives。
 * - 被依赖：MarkdownWorkbench.tsx。
 *
 * 改哪里
 * - 改过滤 / 键盘：matches / onKeyDown。
 * - 改呈现：list / row / Modal。
 */
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useMemo, useRef, useState } from 'react'

/** One runnable row. */
export interface PaletteEntry {
  /** Stable id, unique across every catalogue. */
  readonly id: string
  /** Row label. */
  readonly label: string
  /** Section heading, so a row's origin is visible. */
  readonly section: string
  /** Extra text the filter matches, beyond the label. */
  readonly keywords?: string
  /** Whether it can run right now. */
  readonly enabled: boolean
  /** For a toggle: whether it is currently on. */
  readonly active?: boolean
  /** Run it. */
  readonly run: () => void
}

/** Props for {@link CommandPalette}. */
export interface CommandPaletteProps {
  /** Whether the palette is showing. */
  readonly open: boolean
  /** Every row, in section order. */
  readonly entries: readonly PaletteEntry[]
  /** Close it. */
  readonly onClose: () => void
}

const list: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  maxHeight: 320,
  overflowY: 'auto',
  marginTop: 8,
}

const row: React.CSSProperties = {
  width: '100%',
  justifyContent: 'flex-start',
  textAlign: 'left',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
}

/**
 * Render the palette.
 * @param props - the rows and how to close it.
 * @returns the palette.
 */
export function CommandPalette({ open, entries, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  // A fresh query each time it opens, so the previous search never lingers.
  useEffect(() => {
    if (!open) return
    setQuery('')
    setActive(0)
    inputRef.current?.focus()
  }, [open])

  /** Rows the filter admits, in catalogue order. */
  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (needle === '') return entries
    return entries.filter(
      entry =>
        entry.label.toLowerCase().includes(needle) ||
        (entry.keywords ?? '').toLowerCase().includes(needle),
    )
  }, [entries, query])

  // Keep the cursor inside the filtered list as it shrinks.
  useEffect(() => {
    setActive(current => (current < matches.length ? current : 0))
  }, [matches.length])

  /** Run one row and close. */
  const choose = (index: number): void => {
    const entry = matches[index]
    if (entry === undefined || !entry.enabled) return
    onClose()
    entry.run()
  }

  let lastSection: string | null = null

  return (
    <Modal
      open={open}
      title="命令"
      closeLabel="关闭"
      description="输入以筛选，回车运行"
      onClose={onClose}
    >
      <Input
        ref={inputRef}
        value={query}
        placeholder="搜索命令…"
        aria-label="搜索命令"
        data-modal-autofocus
        onChange={event => {
          setQuery(event.target.value)
          setActive(0)
        }}
        onKeyDown={event => {
          if (event.key === 'ArrowDown') {
            event.preventDefault()
            setActive(current => (matches.length === 0 ? 0 : (current + 1) % matches.length))
          } else if (event.key === 'ArrowUp') {
            event.preventDefault()
            setActive(current =>
              matches.length === 0 ? 0 : (current - 1 + matches.length) % matches.length,
            )
          } else if (event.key === 'Enter') {
            event.preventDefault()
            choose(active)
          }
        }}
      />

      <div style={list} role="listbox" aria-label="命令列表">
        {matches.length === 0 ? (
          <div style={{ padding: '8px 4px', opacity: 0.5, fontSize: 12 }}>（无匹配命令）</div>
        ) : (
          matches.map((entry, index) => {
            // A heading is emitted whenever the section changes, which keeps the
            // grouping correct after filtering without a second pass.
            const heading = entry.section === lastSection ? null : entry.section
            lastSection = entry.section
            return (
              <div key={entry.id}>
                {heading !== null && (
                  <div
                    style={{
                      padding: '6px 4px 2px',
                      fontSize: 11,
                      opacity: 0.5,
                      letterSpacing: '.04em',
                    }}
                  >
                    {heading}
                  </div>
                )}
                <Button
                  size="sm"
                  variant={index === active ? 'outline' : 'ghost'}
                  disabled={!entry.enabled}
                  style={row}
                  onClick={() => choose(index)}
                >
                  {entry.active === true ? `✓ ${entry.label}` : entry.label}
                </Button>
              </div>
            )
          })
        )}
      </div>
    </Modal>
  )
}
