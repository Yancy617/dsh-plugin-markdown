/**
 * 面板作为平台挂载的那一个组件：工作台 ＋ 整块兜底。
 *
 * 内容
 * - MarkdownPanel：ErrorBoundary 包住 MarkdownWorkbench。
 *
 * 行为
 * - 工作台外壳（侧栏、标签条、工具条、浮层、目录列）任何渲染期抛错 ⇒ 一张卡，而不是整块面板消失。
 * - 「重新加载面板」重挂工作台；快照还在 store 里，标签、缓冲区与滚动位置按上次恢复。
 * - 技术详情可展开、可复制（见 client/ErrorBoundary.tsx）。
 *
 * 边界
 * - 不拥有工作台状态，也不改写它的 props——只做一次包裹。
 * - 只接渲染期；挂载之后的异步失败由工作台自己的对话框 / 提示层说。
 *
 * 相关文件
 * - 依赖：ErrorBoundary、MarkdownWorkbench。
 * - 被依赖：index.tsx（注册进 main 槽）。
 *
 * 改哪里
 * - 面板级卡片的文案：本文件。
 * - 兜底行为：client/ErrorBoundary.tsx。
 * - 工作台本身：MarkdownWorkbench.tsx。
 */
import type { ReactElement } from 'react'
import { ErrorBoundary } from './ErrorBoundary'
import { MarkdownWorkbench, type MarkdownWorkbenchProps } from './MarkdownWorkbench'

/**
 * Render this plugin's panel, with one card standing between a render failure and a blank area.
 * @param props - the panel's injected picker, store, sessions and web-page opener.
 * @returns the workbench, or the failure card.
 */
export function MarkdownPanel(props: MarkdownWorkbenchProps): ReactElement {
  return (
    <ErrorBoundary
      title="这个面板出错了"
      hint="你的文件没有被改动。重新加载面板会从上次的状态恢复；如果再次出错，把技术详情复制给我。"
      retryLabel="重新加载面板"
    >
      <MarkdownWorkbench {...props} />
    </ErrorBoundary>
  )
}
