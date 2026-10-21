/**
 * 链接弹窗：地址与显示文字两个字段，以及"回车 = 应用"。
 *
 * 内容
 * - LinkDialogSeed / LinkDialog。
 *
 * 行为
 * - 打开时用 `seed` 预填：地址、显示文字、是不是在编辑一处已有链接。
 * - 两个字段各带一个子标题（链接 / 文字），**在输入框左侧**、同一行；两行之间留 14px
 *   （弹窗 body 自己是不带间隙的列）。
 * - **「应用」只在地址为空时置灰**；显示文字留空表示"用地址当显示文字"。
 * - 回车只执行「应用」；置灰时回车什么都不做（不换行、不关窗），并一律 `preventDefault` ——
 *   否则这次回车的默认动作会落到随即拿到焦点的编辑区上，文档里多出一个空段落。
 * - 编辑已有链接时，次按钮是「取消链接」；插入时是「取消」。
 * - 输入法组字中的回车是"上屏"，不拦。
 *
 * 边界
 * - 不碰编辑器树：写入 / 插入 / 删除由调用方（FloatingToolbar、SlashMenu）用 `linkEdit.ts` 做，
 *   因为它们各自知道"选区在哪里"。
 * - 不管地址补全（`linkDestination` 在写入时做）。
 *
 * 相关文件
 * - 被依赖：FloatingToolbar.tsx（选区上加 / 改链接）、SlashMenu.tsx（`/` 菜单插入链接）。
 * - 依赖：primitives 的 Modal / Input / Button。
 *
 * 改哪里
 * - 改字段与文案：LinkDialog 的渲染。
 * - 改提交判据：submit。
 */
import { useCallback, useEffect, useRef, useState, type JSX, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'

/** 打开弹窗时要预填的东西。 */
export interface LinkDialogSeed {
  /** 地址；插入时是空串。 */
  readonly url: string
  /** 显示文字；插入时是选中的文字，或空串。 */
  readonly text: string
  /** 打开时选区内已经有一处链接（次按钮因此是「取消链接」）。 */
  readonly editing: boolean
}

/** 没有预填值的那一份（`/` 菜单插入用）。 */
export const EMPTY_LINK_SEED: LinkDialogSeed = { url: '', text: '', editing: false }

/**
 * Render one link dialog.
 * @param props.open - whether it is showing.
 * @param props.seed - what to prefill when it opens.
 * @param props.onSubmit - called with the trimmed address and display text.
 * @param props.onRemove - removes the link; only offered while editing one.
 * @param props.onClose - called by 取消 / 关闭.
 * @returns the dialog.
 */
export function LinkDialog({
  open,
  seed,
  onSubmit,
  onRemove,
  onClose,
}: {
  readonly open: boolean
  readonly seed: LinkDialogSeed
  onSubmit(url: string, text: string): void
  readonly onRemove?: (() => void) | undefined
  onClose(): void
}): JSX.Element {
  const [url, setUrl] = useState(seed.url)
  const [text, setText] = useState(seed.text)
  /*
   * 只在"打开"这一刻预填。`seed` 是每次渲染新建的对象，若把它列进依赖，用户每打一个字都会被
   * 重新预填一次；这里用 ref 取最新的一份，依赖只留 `open`。
   */
  const seedRef = useRef(seed)
  seedRef.current = seed
  useEffect(() => {
    if (!open) return
    setUrl(seedRef.current.url)
    setText(seedRef.current.text)
  }, [open])

  /** 地址是否可应用：唯一的置灰条件。 */
  const canApply = url.trim() !== ''

  /**
   * 回车 = 按「应用」；不能应用时什么都不做（但照样挡掉默认动作）。
   * @param event - 两个输入框上的按键。
   */
  const submit = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>): void => {
      if (event.key !== 'Enter') return
      if (event.nativeEvent.isComposing) return
      event.preventDefault()
      event.stopPropagation()
      if (!canApply) return
      onSubmit(url.trim(), text.trim())
    },
    [canApply, onSubmit, text, url],
  )

  return (
    <Modal
      open={open}
      title={seed.editing ? '编辑链接' : '插入链接'}
      closeLabel="关闭"
      onClose={onClose}
      footer={
        <>
          {/*
            编辑时：次按钮就是「取消链接」；插入时：普通「取消」。一个按钮两种含义，各自按它做的事命名。
          */}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              if (seed.editing) onRemove?.()
              else onClose()
            }}
          >
            {seed.editing ? '取消链接' : '取消'}
          </Button>
          <Button
            size="sm"
            variant="primary"
            disabled={!canApply}
            onClick={() => {
              if (!canApply) return
              onSubmit(url.trim(), text.trim())
            }}
          >
            应用
          </Button>
        </>
      }
    >
      <div className="md-link-form">
        <label className="md-link-field">
          <span className="md-link-label">链接</span>
          <Input
            className="md-link-input"
            value={url}
            placeholder="example.com（https:// 可省略）"
            aria-label="链接"
            data-modal-autofocus
            onChange={event => setUrl(event.target.value)}
            onKeyDown={submit}
          />
        </label>
        <label className="md-link-field">
          <span className="md-link-label">文字</span>
          <Input
            className="md-link-input"
            value={text}
            placeholder="链接显示的文字（留空则显示地址）"
            aria-label="文字"
            onChange={event => setText(event.target.value)}
            onKeyDown={submit}
          />
        </label>
      </div>
    </Modal>
  )
}
