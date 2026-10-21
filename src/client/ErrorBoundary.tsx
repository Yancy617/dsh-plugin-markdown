/**
 * 渲染期抛错的兜底：一张说明卡，代替炸掉的那块界面。
 *
 * 内容
 * - ErrorBoundary：React 错误边界（唯一一种需要用 class 写的组件）。
 * - 卡片：标题、原因、一句「文件没有被改动」的说明、动作行（主按钮 / 重试 / 复制详情）、
 *   折叠的技术详情（调用栈）。
 *
 * 行为
 * - 子树在渲染期抛错 ⇒ 不渲染子树，改渲染卡片；子树之外的东西（面板其余部分）不受影响。
 * - 技术详情同时收两样：错误自己的 `stack`，以及 React 的组件栈；**复制详情**把这段文本放进
 *   剪贴板，方便直接贴给下一轮排查。
 * - 重试把 `attempt` 加一并换一个 Fragment key，**让子树真正重挂**，而不是让失败过的树再渲染一次。
 * - 样式由本组件自己注入（`ensureEditorStyles` 是幂等的）：子树在建立时抛错，它的 effect 不会跑。
 *
 * 边界
 * - **只接渲染期**。挂载之后的事件回调 / effect / update 监听里抛的错接不住，那是另一类 bug；
 *   卡片上说清这一条，不假装已经兜住。
 * - 不决定重试之后该切到哪个视图、也不写盘：主按钮的语义由调用方给（`primary`）。
 * - 不捕获自己的渲染错误（卡片本身抛错仍会向上冒）。
 *
 * 相关文件
 * - 依赖：shared/errors 的 messageOf / stackOf、client/reportQuietly、primitives 的 Button /
 *   writeClipboard、editor/config 的 ensureEditorStyles。
 * - 被依赖：editor/EditorBoundary.tsx（富文本）、MarkdownPanel.tsx（整块面板）。
 *
 * 改哪里
 * - 改卡片结构与文案位置：render。
 * - 改重试语义：retry。
 * - 改技术详情的内容：getDerivedStateFromError / componentDidCatch。
 */
import { Component, Fragment, type ErrorInfo, type ReactNode } from 'react'
import { Button, writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import { messageOf, stackOf } from '../shared/errors'
import { reportQuietly } from './reportQuietly'
import { ensureEditorStyles } from './editor/config'

/** Props for {@link ErrorBoundary}. */
export interface ErrorBoundaryProps {
  /** What could not be shown, as the card's heading. */
  readonly title: string
  /** One sentence saying what is still safe and what the reader can do. */
  readonly hint: string
  /** The always-present retry button's label. */
  readonly retryLabel: string
  /**
   * A second way out, when the caller has one.
   *
   * The boundary does not know what "switch to the source view" means; it only knows that some
   * failures have a better answer than trying again.
   */
  readonly primary?: { readonly label: string; readonly onClick: () => void } | undefined
  /** The subtree. */
  readonly children: ReactNode
}

interface ErrorBoundaryState {
  /** Whether the current subtree failed to render. */
  readonly failed: boolean
  /** The failure's own message, for the card. */
  readonly message: string
  /** What goes in 技术详情: the stack, plus React's component stack once it is known. */
  readonly detail: string
  /** Bumped by the retry button so the subtree is rebuilt rather than reused. */
  readonly attempt: number
  /** Whether the last 复制详情 succeeded, so the button can say so. */
  readonly copied: boolean
}

/** How long 已复制 stays before the button offers the copy again. */
const COPIED_MS = 1500

/**
 * Render the subtree, or the card that says why it could not be rendered.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = {
    failed: false,
    message: '',
    detail: '',
    attempt: 0,
    copied: false,
  }

  /** The 已复制 timer, so unmounting does not leave one behind. */
  private copyTimer: number | undefined

  /**
   * @param error - what the subtree threw.
   * @returns the failed state, with the message and the stack the card shows.
   */
  static getDerivedStateFromError(error: unknown): Partial<ErrorBoundaryState> {
    return { failed: true, message: messageOf(error), detail: stackOf(error), copied: false }
  }

  /**
   * The stylesheet is normally injected by an effect of the subtree — which never runs when that
   * subtree throws during render. The card is rendered here, so the boundary injects it too;
   * without this the failure card would show up unstyled.
   */
  override componentDidMount(): void {
    ensureEditorStyles()
  }

  override componentWillUnmount(): void {
    if (this.copyTimer !== undefined) window.clearTimeout(this.copyTimer)
  }

  /**
   * Keep a line in the console, and add React's component stack to 技术详情.
   *
   * The two stacks answer different questions — "where in my code" and "where in the tree" — so
   * the card carries both rather than one of them.
   * @param error - what the subtree threw.
   * @param info - React's component stack.
   */
  override componentDidCatch(error: Error, info: ErrorInfo): void {
    reportQuietly(this.props.title, error)
    const componentStack = info.componentStack ?? ''
    if (componentStack.trim() === '') return
    this.setState(current =>
      current.failed && !current.detail.includes(componentStack)
        ? { detail: `${current.detail}\n\n组件栈：${componentStack}` }
        : null,
    )
  }

  /** Rebuild the subtree from scratch. */
  private readonly retry = (): void => {
    if (this.copyTimer !== undefined) window.clearTimeout(this.copyTimer)
    this.setState(current => ({
      failed: false,
      message: '',
      detail: '',
      attempt: current.attempt + 1,
      copied: false,
    }))
  }

  /** Put the diagnostic text on the clipboard, and say so on the button. */
  private readonly copy = (): void => {
    void writeClipboard(this.state.detail)
      .then(ok => {
        if (!ok) return
        this.setState({ copied: true })
        if (this.copyTimer !== undefined) window.clearTimeout(this.copyTimer)
        this.copyTimer = window.setTimeout(() => {
          this.copyTimer = undefined
          this.setState({ copied: false })
        }, COPIED_MS)
      })
      .catch(() => undefined)
  }

  override render(): ReactNode {
    if (!this.state.failed) {
      // The attempt keys the Fragment, so 重试 unmounts the failed subtree instead of asking it to
      // render again. Without it the same broken tree is retried in place.
      return <Fragment key={this.state.attempt}>{this.props.children}</Fragment>
    }
    const primary = this.props.primary
    return (
      <div className="md-failure" role="alert">
        <div className="md-failure-title">{this.props.title}</div>
        {this.state.message === '' ? null : (
          <div className="md-failure-reason">原因：{this.state.message}</div>
        )}
        <div className="md-failure-hint">{this.props.hint}</div>
        <div className="md-failure-actions">
          {primary === undefined ? null : (
            <Button size="sm" variant="primary" onClick={primary.onClick}>
              {primary.label}
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={this.retry}>
            {this.props.retryLabel}
          </Button>
          <Button size="sm" variant="ghost" onClick={this.copy}>
            {this.state.copied ? '已复制' : '复制详情'}
          </Button>
        </div>
        <details className="md-failure-tech">
          <summary>技术详情</summary>
          <pre>{this.state.detail}</pre>
        </details>
      </div>
    )
  }
}
