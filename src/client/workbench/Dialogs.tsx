/**
 * 工作台的浮层：行菜单、新建 / 改名、移动、删除、命令面板。
 *
 * 内容
 * - promptTitle / promptDescription。
 * - WorkbenchDialogsProps / WorkbenchDialogs。
 *
 * 行为
 * - 行菜单与右键共用同一个 `Menu`：两种打开方式只在 anchorRect 上不同。
 * - 新建 / 改名共用一格输入框；改名只显示名字、不显示格式（格式由原文件保留）；
 *   名字不合法（shared/entryName）时在输入框下方说明并禁用提交，Host 的拒绝也落在同一行。
 * - 移动对话框只列出目录并按名过滤；删除永远要点一次确认。
 * - 关闭文档只在保存失败时弹窗：重试 / 放弃更改并关闭 / 取消，并说明冲突；默认关闭不弹确认。
 * - 真冲突（磁盘上是另一份正文）单独弹窗，二选一：用磁盘的 / 保留我的；取消什么都不做。
 * - 命令面板只接收行，不拥有命令。
 *
 * 边界
 * - 不拥有对话框状态、不执行操作（提交后由组合根跑事务）；不决定提示文案的时长。
 *
 * 相关文件
 * - 依赖：CommandPalette、primitives（Button / Input / Menu / Modal）、shared/paths、model 类型。
 * - 被依赖：MarkdownWorkbench.tsx。
 *
 * 改哪里
 * - 改文案：promptTitle / promptDescription 与各对话框正文。
 * - 改行的来源：由调用方给的 rowMenuRows / paletteEntries。
 */
import type { VaultDirectoriesResult } from '../../shared/protocol'
import { documentLabel } from '../../shared/documents'
import { entryNameProblem, platformOfUserAgent } from '../../shared/entryName'
import { basenameOf, dirnameOf, samePath } from '../../shared/paths'
import {
  Button,
  Checkbox,
  Input,
  Menu,
  Modal,
  type MenuEntry,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ReactElement } from 'react'
import { CommandPalette, type PaletteEntry } from '../CommandPalette'
import type {
  CloseRequest,
  ConflictState,
  LargeDocumentOpen,
  LargeOpenChoice,
  OpenFailure,
  PromptState,
  RowMenu,
  TreeTarget,
} from './model'
import { promptEntryName } from './promptName'
import { formatBytes } from '../largeDocument'
import styles from '../sidebar.module.css'

/**
 * The naming rules the dialog previews.
 *
 * The Host applies its own `process.platform` rules again before touching the filesystem; this
 * reading only decides which message can be shown before a request is sent.
 */
const NAME_PLATFORM = platformOfUserAgent(
  typeof navigator === 'undefined' ? '' : navigator.userAgent,
)

/**
 * @param prompt - the open prompt, if any.
 * @returns its dialog title.
 */
export function promptTitle(prompt: PromptState | null): string {
  if (prompt === null) return ''
  if (prompt.kind === 'rename') return '重命名'
  return prompt.kind === 'directory' ? '新建文件夹' : '新建文档'
}

/**
 * @param prompt - the open prompt, if any.
 * @returns the line under its title, when there is one.
 */
export function promptDescription(prompt: PromptState | null): string | undefined {
  if (prompt === null) return undefined
  if (prompt.kind !== 'rename') return `创建在 ${prompt.directory}`
  // A document is renamed by its label, so the context line must not spell the format either —
  // otherwise the dialog shows `.md` one line above a field that deliberately does not.
  return `原名称：${
    prompt.target.isDirectory ? prompt.target.name : documentLabel(prompt.target.name)
  }`
}

/** What the dialogs draw and report. */
export interface WorkbenchDialogsProps {
  /** The row menu's target and anchor, or `null`. */
  readonly rowMenu: RowMenu | null
  /** Rows for the entry menu, already filtered by the target kind. */
  readonly rowMenuRows: readonly MenuEntry[]
  onRowCommand(id: string, target: TreeTarget): void
  onCloseRowMenu(): void
  /** Which prompt dialog is open, if any. */
  readonly prompt: PromptState | null
  /** The prompt's input value. */
  readonly promptValue: string
  onPromptValue(value: string): void
  onClosePrompt(): void
  onSubmitPrompt(): void
  /** A refusal from the Host for the last submit, or `null`. */
  readonly promptError: string | null
  /** A write / directory operation is in flight. */
  readonly busy: boolean
  /** The entry the move dialog is about, if open. */
  readonly moveTarget: TreeTarget | null
  /** The move dialog's filter. */
  readonly moveFilter: string
  onMoveFilter(value: string): void
  /** Directories to choose from, or `null` while loading. */
  readonly moveChoices: VaultDirectoriesResult | null
  onCloseMove(): void
  onSubmitMove(directory: string): void
  /** The entry awaiting delete confirmation, if any. */
  readonly pendingDelete: TreeTarget | null
  onCloseDelete(): void
  onPerformDelete(): void
  /** The command palette. */
  readonly paletteOpen: boolean
  readonly paletteEntries: readonly PaletteEntry[]
  onClosePalette(): void
  /** The close question for a dirty tab, or the explanation of a refused close. */
  readonly closeRequest: CloseRequest | null
  /** 重试保存并关闭. */
  onCloseSave(): void
  /** 放弃更改并关闭. */
  onCloseDiscard(): void
  /** 取消关闭. */
  onCloseCancel(): void
  /**
   * A save refused because the disk holds a different text, or `null`.
   *
   * Kept apart from {@link closeRequest}: that one is about leaving a document, this one is about
   * two texts and which of them survives.
   */
  readonly conflict: ConflictState | null
  /** 用磁盘的: replace the editor's text with the file's. */
  onConflictUseDisk(): void
  /** 保留我的: overwrite the file, keeping a copy of what was there. */
  onConflictKeepMine(): void
  /** Dismiss the conflict question; both texts stay as they are. */
  onConflictCancel(): void
  /** A read that failed, or `null`. */
  readonly openError: OpenFailure | null
  onCloseOpenError(): void
  onRetryOpen(failure: OpenFailure): void
  /** A read document waiting for the "it is large" choice, or `null`. */
  readonly largeOpen: LargeDocumentOpen | null
  /** Whether "本次会话不再问" is ticked in that dialog. */
  readonly largeRemember: boolean
  onLargeRemember(next: boolean): void
  onLargeChoose(choice: LargeOpenChoice): void
  onLargeClose(): void
}

/**
 * Every floating layer the workbench owns.
 * @param props - the open dialogs, their data, and the actions they submit.
 * @returns the layers; closed ones render nothing.
 */
export function WorkbenchDialogs(props: WorkbenchDialogsProps): ReactElement {
  /**
   * What the prompt would actually create or rename to, checked before it is sent.
   *
   * The format is part of the answer even when the field does not show it — a new `会议` becomes
   * `会议.md`, and a renamed `会议.md` keeps its suffix — so the rule is applied to the complete
   * name rather than to the letters on screen.
   */
  const pendingName = props.prompt === null ? '' : promptEntryName(props.prompt, props.promptValue)
  const nameProblem = pendingName === '' ? null : entryNameProblem(pendingName, NAME_PLATFORM)
  const promptMessage = nameProblem ?? props.promptError
  const submitBlocked = props.promptValue.trim() === '' || props.busy || nameProblem !== null

  return (
    <>
      {/*
        The entry menu — the tree's only one.

        Its trigger is not rendered here: `Menu` renders its `anchor` in place, and this menu is
        opened from two places that are not this element — a row's ⋯ button and a right-click
        anywhere on a row — so the hidden span stays the wrapper and `getAnchorRect` answers where
        the card hangs. Which entry it acts on arrives in the same state, so both ways in show one
        list and run through one lookup; a second `Menu` per row would be the way those two drift
        apart.
      */}
      <Menu
        open={props.rowMenu !== null}
        portal
        side="bottom"
        align="start"
        autoFocus
        anchor={<span aria-hidden="true" style={{ display: 'none' }} />}
        items={props.rowMenuRows}
        // Asked on open, on every frame while the card is up, and on scroll/resize: a card opened
        // from a row's button is measured again each time and follows the tree, while one opened
        // by a right-click stays where the pointer was.
        getAnchorRect={() => props.rowMenu?.anchorRect() ?? null}
        onSelect={id => {
          const target = props.rowMenu?.target ?? null
          props.onCloseRowMenu()
          if (target === null) return
          // The menu only names a command; running it is the command's business, so this stays a
          // lookup rather than a switch that has to grow with it.
          props.onRowCommand(id, target)
        }}
        onClose={() => props.onCloseRowMenu()}
      />

      <Modal
        open={props.prompt !== null}
        title={promptTitle(props.prompt)}
        closeLabel="关闭"
        description={promptDescription(props.prompt)}
        onClose={() => props.onClosePrompt()}
        footer={
          <>
            <Button size="sm" variant="ghost" onClick={() => props.onClosePrompt()}>
              取消
            </Button>
            <Button
              size="sm"
              variant="primary"
              disabled={submitBlocked}
              onClick={() => props.onSubmitPrompt()}
            >
              {props.prompt?.kind === 'rename' ? '重命名' : '创建'}
            </Button>
          </>
        }
      >
        <Input
          value={props.promptValue}
          placeholder={props.prompt?.kind === 'rename' ? '新名称' : '名称，例如 会议记录'}
          aria-label="名称"
          aria-invalid={promptMessage !== null}
          aria-describedby={promptMessage !== null ? 'prompt-name-error' : undefined}
          data-modal-autofocus
          onChange={event => props.onPromptValue(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter' && !submitBlocked) props.onSubmitPrompt()
          }}
        />
        {promptMessage !== null && (
          <div id="prompt-name-error" className={styles.promptError} role="status">
            {promptMessage}
          </div>
        )}
      </Modal>

      {/*
        The move dialog: the directory, and nothing else.

        It does not ask "are you sure" and it cannot offer the destination's contents — the names
        already there are the host's to check, and a dialog that greyed out a target it guessed
        wrong about would be worse than one that reports the refusal afterwards.
      */}
      <Modal
        open={props.moveTarget !== null}
        title="移动到"
        closeLabel="关闭"
        description={
          props.moveTarget === null ? undefined : `原位置：${dirnameOf(props.moveTarget.path)}`
        }
        onClose={() => props.onCloseMove()}
        footer={
          <Button size="sm" variant="ghost" onClick={() => props.onCloseMove()}>
            取消
          </Button>
        }
      >
        <Input
          value={props.moveFilter}
          placeholder="筛选目录"
          aria-label="筛选目录"
          data-modal-autofocus
          onChange={event => props.onMoveFilter(event.target.value)}
        />
        <div style={{ marginTop: 8, maxHeight: 260, overflowY: 'auto' }}>
          {props.moveChoices === null ? (
            <div className={styles.status}>加载中…</div>
          ) : (
            (() => {
              const term = props.moveFilter.trim().toLowerCase()
              const rows = props.moveChoices.directories.filter(
                choice =>
                  term === '' ||
                  choice.relative.toLowerCase().includes(term) ||
                  choice.path.toLowerCase().includes(term),
              )
              if (rows.length === 0) return <div className={styles.status}>没有可选的目录</div>
              return (
                <>
                  {rows.map(choice => (
                    <Button
                      key={choice.path}
                      size="sm"
                      variant="ghost"
                      // The directory it is already in is the one destination that would do
                      // nothing, so it is offered greyed rather than hidden: the writer can see it
                      // is there and see why it is not a choice.
                      disabled={samePath(
                        choice.path,
                        dirnameOf(props.moveTarget?.path ?? ''),
                      )}
                      title={choice.path}
                      onClick={() => props.onSubmitMove(choice.path)}
                      style={{ display: 'flex', width: '100%', justifyContent: 'flex-start' }}
                    >
                      {choice.relative === '' ? '根目录' : choice.relative}
                    </Button>
                  ))}
                  {props.moveChoices.truncated && (
                    <div className={styles.status}>目录过多，只列出了前一部分</div>
                  )}
                </>
              )
            })()
          )}
        </div>
      </Modal>

      <Modal
        open={props.pendingDelete !== null}
        title={props.pendingDelete?.isDirectory === true ? '删除文件夹' : '删除文件'}
        closeLabel="关闭"
        description={
          props.pendingDelete === null ? undefined : `永久删除：${props.pendingDelete.path}`
        }
        onClose={() => props.onCloseDelete()}
        footer={
          <>
            <Button size="sm" variant="ghost" onClick={() => props.onCloseDelete()}>
              取消
            </Button>
            <Button
              size="sm"
              variant="primary"
              disabled={props.busy}
              onClick={() => props.onPerformDelete()}
            >
              删除
            </Button>
          </>
        }
      >
        <span style={{ fontSize: 13, lineHeight: 1.7 }}>
          {props.pendingDelete?.isDirectory === true
            ? '该文件夹及其全部内容都会被删除，无法从编辑器内撤销。'
            : '该文件会被删除，无法从编辑器内撤销。'}
        </span>
      </Modal>

      {/*
        The conflict question.

        Not a notice and not a third button on the save row: the writer has two texts and one of
        them is about to be thrown away, so the choice is made here, with both consequences said
        out loud. 取消 is the focused button — the one answer that costs nothing — and closing the
        card any other way means the same thing. The permanent notice behind it still says the save
        was refused, so dismissing this card leaves the fact on screen.
      */}
      <Modal
        open={props.conflict !== null}
        title="磁盘上的这一篇被改过"
        closeLabel="关闭"
        description={props.conflict?.title}
        onClose={() => props.onConflictCancel()}
        footer={
          <>
            <Button
              size="sm"
              variant="ghost"
              data-modal-autofocus
              onClick={() => props.onConflictCancel()}
            >
              取消
            </Button>
            <Button size="sm" variant="outline" onClick={() => props.onConflictUseDisk()}>
              用磁盘的
            </Button>
            <Button size="sm" variant="primary" onClick={() => props.onConflictKeepMine()}>
              保留我的
            </Button>
          </>
        }
      >
        <div
          style={{ display: 'flex', flexDirection: 'column', gap: 10, fontSize: 13, lineHeight: 1.7 }}
        >
          <div>保存的时候，磁盘上的这一篇已经是另一份内容，所以这次保存被拒绝了——没有覆盖它。</div>
          <div>用磁盘的：编辑器换成磁盘上的版本；你刚改的内容会丢掉，撤销也找不回来。</div>
          <div>
            保留我的：用编辑器里的版本覆盖磁盘。覆盖之前，磁盘上的那一版会先留在同一个目录里，
            文件名带「副本」。
          </div>
        </div>
      </Modal>

      <Modal
        open={props.closeRequest?.phase === 'failed'}
        title="无法保存并关闭"
        closeLabel="关闭"
        description={props.closeRequest?.title}
        onClose={() => props.onCloseCancel()}
        footer={
          <>
            <Button size="sm" variant="ghost" onClick={() => props.onCloseCancel()}>
              取消
            </Button>
            <Button size="sm" variant="ghost" onClick={() => props.onCloseDiscard()}>
              放弃更改并关闭
            </Button>
            {props.closeRequest?.conflict === true ? null : (
              <Button size="sm" variant="primary" onClick={() => props.onCloseSave()}>
                重试
              </Button>
            )}
          </>
        }
      >
        <span style={{ fontSize: 13, lineHeight: 1.7 }}>
          {`${props.closeRequest?.message ?? '保存失败。'}${
            props.closeRequest?.conflict === true
              ? ' 文件在磁盘上已被修改，保存会覆盖别人的内容，因此被拒绝。'
              : ''
          }`}
        </span>
      </Modal>

      {/*
        A failed read is a dialog rather than a notice: when nothing opened there is no band for a
        notice to sit on, and "I clicked a file and nothing happened" needs an answer.
      */}
      <Modal
        open={props.openError !== null}
        title="打开失败"
        closeLabel="关闭"
        description={props.openError === null ? undefined : basenameOf(props.openError.path)}
        onClose={() => props.onCloseOpenError()}
        footer={
          <>
            <Button size="sm" variant="ghost" onClick={() => props.onCloseOpenError()}>
              取消
            </Button>
            <Button
              size="sm"
              variant="primary"
              onClick={() => {
                if (props.openError !== null) props.onRetryOpen(props.openError)
              }}
            >
              重试
            </Button>
          </>
        }
      >
        <span style={{ fontSize: 13, lineHeight: 1.7 }}>{props.openError?.message}</span>
      </Modal>

      {/*
        The large-document question. It is a question, not a refusal: both ways of opening are
        offered. Rich text is the **focused default** because the source view is read-only (the
        product rule: it shows the file, it does not edit it); the source view is the light way to
        look at the document and does not freeze the page.
      */}
      <Modal
        open={props.largeOpen !== null}
        title="这篇文档比较大"
        closeLabel="关闭"
        onClose={() => props.onLargeClose()}
        footer={
          <>
            <Button size="sm" variant="ghost" onClick={() => props.onLargeClose()}>
              取消
            </Button>
            <Button size="sm" variant="outline" onClick={() => props.onLargeChoose('source')}>
              只读查看源码
            </Button>
            <Button
              size="sm"
              variant="primary"
              data-modal-autofocus
              onClick={() => props.onLargeChoose('rich')}
            >
              用富文本打开
            </Button>
          </>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, fontSize: 13, lineHeight: 1.7 }}>
          <div>
            {`${basenameOf(props.largeOpen?.file.path ?? '')} · ${formatBytes(
              props.largeOpen?.bytes ?? 0,
            )}`}
          </div>
          <div>
            富文本会先把整篇建成结构，打开可能卡住几秒到几十秒，之后每次编辑也会变慢；只有富文本能编辑。
            源码视图只读、打开很快，适合先看看内容。两者显示的是同一份 Markdown。
          </div>
          <Checkbox
            checked={props.largeRemember}
            onChange={next => props.onLargeRemember(next)}
            label="本次会话不再问"
          />
        </div>
      </Modal>

      <CommandPalette
        open={props.paletteOpen}
        entries={props.paletteEntries}
        onClose={() => props.onClosePalette()}
      />
    </>
  )
}
