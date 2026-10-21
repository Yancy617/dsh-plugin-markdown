/**
 * 关闭一篇文档的协议：保存并关闭、失败对话框、放弃更改并关闭、取消。
 *
 * 内容
 * - UseCloseProtocolArgs / CloseProtocol / useCloseProtocol。
 *
 * 行为
 * - 默认关闭是“立即保存并关闭”，保存期间显示 saving 并冻结视图；成功静默关闭。
 * - 只有保存被拒才变成 failed 对话框，标签留着、文字还在缓冲区里。
 * - 放弃更改走 discard：不写盘、丢弃在飞的写结果。
 * - 请求指向的文档已经不在了（被删除 / 换仓库）时自动收起对话框。
 *
 * 边界
 * - 不实现关闭本身（`closeTab` 由组合根给：写盘 / 丢弃 / 销毁缓冲区）。
 * - 不拥有缓冲区文本、不写盘、不决定历史何时丢弃。
 *
 * 相关文件
 * - 被依赖：MarkdownWorkbench.tsx。
 * - 依赖：workbench/model 的类型、readOnly.ts、shared/protocol 的 ERR_STALE。
 */
import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from 'react'
import type { MutableRefObject } from 'react'
import { ERR_STALE } from '../../shared/protocol'
import { readOnlyDocument } from '../readOnly'
import type { BufferState, CloseRequest, CloseResult, SaveState } from './model'

/** What the protocol reads from the panel. */
export interface UseCloseProtocolArgs {
  /** The showing document's path, or `null`. */
  readonly activePath: string | null
  /** The buffers **as React state**, so the "document went away" effect re-runs. */
  readonly buffers: Record<string, BufferState>
  /** The freshest buffers, readable when a request arrives. */
  readonly buffersRef: MutableRefObject<Record<string, BufferState>>
  /** Where the authorized root came from; a non-user root is read-only. */
  readonly vaultKind: 'sample' | 'user' | null
  /** Close one tab: write first or discard, then destroy. */
  readonly closeTab: (path: string, disposition?: 'save' | 'discard') => Promise<CloseResult>
  /** The panel's one save notice. */
  readonly setSaveState: Dispatch<SetStateAction<SaveState>>
}

/** What the panel may ask the close protocol to do. */
export interface CloseProtocol {
  /** The close question on screen, if one is. */
  readonly closeRequest: CloseRequest | null
  /** Whether the showing document is waiting on a close decision or write. */
  readonly closeFrozen: boolean
  /** Ask to close one document; `save` is the default disposition. */
  requestClose(path: string, disposition?: 'save' | 'discard'): void
  /** Retry a refused save-and-close. */
  retryClose(): void
  /** The writer chose 放弃更改并关闭. */
  confirmCloseDiscard(): void
  /** The writer dismissed the failure explanation; the tab stays. */
  cancelClose(): void
}

/**
 * Own the close question and the three answers to it.
 * @param args - the panel's tabs, buffers and the one close transaction.
 * @returns the protocol's state and controls.
 */
export function useCloseProtocol(args: UseCloseProtocolArgs): CloseProtocol {
  const { activePath, buffers, buffersRef, vaultKind, closeTab, setSaveState } = args
  const [closeRequest, setCloseRequest] = useState<CloseRequest | null>(null)

  /** The showing document is waiting on a close decision or a close write. */
  const closeFrozen =
    closeRequest !== null && activePath !== null && closeRequest.path === activePath

  /**
   * Start one save-and-close. `saving` freezes the view; success closes silently, a refusal
   * becomes the failure dialog and leaves the tab open.
   */
  const startClose = useCallback(
    async (path: string, title: string): Promise<void> => {
      setCloseRequest({ path, title, phase: 'saving' })
      setSaveState({ kind: 'saving' })
      const result = await closeTab(path, 'save')
      if (result.kind === 'closed') {
        setCloseRequest(null)
        setSaveState(null)
        return
      }
      // The write path also put a red notice on screen; the dialog is the close-specific answer,
      // so keep one explanation rather than two.
      setSaveState(current =>
        current?.kind === 'saving' || (current?.kind === 'failed' && current.path === path)
          ? null
          : current,
      )
      setCloseRequest({
        path,
        title,
        phase: 'failed',
        message: result.message,
        conflict: result.code === ERR_STALE,
      })
    },
    [closeTab, setSaveState],
  )

  /**
   * Ask to close one document.
   *
   * The default is save-and-close, immediately: there is no "are you sure?" step for a dirty
   * document. The explicit alternative is 放弃更改并关闭 — reached from the tab's Shift+close and
   * from the command palette. Read-only documents have nothing to save and take the discard path.
   */
  const requestClose = useCallback(
    (path: string, disposition: 'save' | 'discard' = 'save'): void => {
      const buffer = buffersRef.current[path]
      if (buffer === undefined) return
      if (disposition === 'discard' || readOnlyDocument(buffer, vaultKind)) {
        setCloseRequest(null)
        void closeTab(path, 'discard')
        return
      }
      if (closeRequest !== null) return
      void startClose(path, buffer.title)
    },
    [buffersRef, closeRequest, closeTab, startClose, vaultKind],
  )

  /** Retry a refused save-and-close. */
  const retryClose = useCallback((): void => {
    if (closeRequest === null || closeRequest.phase === 'saving') return
    void startClose(closeRequest.path, closeRequest.title)
  }, [closeRequest, startClose])

  /** The writer chose 放弃更改并关闭. */
  const confirmCloseDiscard = useCallback((): void => {
    if (closeRequest === null || closeRequest.phase === 'saving') return
    setCloseRequest(null)
    void closeTab(closeRequest.path, 'discard')
  }, [closeRequest, closeTab])

  /** The writer dismissed the failure explanation; the tab stays and becomes editable again. */
  const cancelClose = useCallback((): void => {
    setCloseRequest(current => (current?.phase === 'saving' ? current : null))
  }, [])

  // A close question is about a document that may have gone away underneath it.
  useEffect(() => {
    if (closeRequest !== null && buffers[closeRequest.path] === undefined) {
      setCloseRequest(null)
    }
  }, [buffers, closeRequest])

  return {
    closeRequest,
    closeFrozen,
    requestClose,
    retryClose,
    confirmCloseDiscard,
    cancelClose,
  }
}
