/**
 * 富文本的兜底：把「这篇文档在富文本里打不开」接到统一说明卡上。
 *
 * 内容
 * - EditorBoundary：一个薄配置——卡片标题、那一句说明、主按钮「用源码视图打开」。
 *
 * 行为
 * - 渲染期抛错（富文本导入就在 composer 建立时，属于渲染期）⇒ 卡片：原因、文件没有被修改、
 *   用源码视图打开 / 再试一次；技术详情在那里，不在这层。
 * - 切换文档由调用方换 key（Band 用 path#revision）；边界自己不偷偷切模式、不写盘。
 *
 * 边界
 * - 兜底机制在 `client/ErrorBoundary.tsx`；这一层只决定编辑器的文案与那条退路。
 * - 只接渲染期的错；挂载之后事件回调 / update 监听里抛的错接不住（那是另一类 bug）。
 * - 不负责"怎么切到源码视图"（调用方给 onShowSource），也不判断时机。
 *
 * 相关文件
 * - 依赖：client/ErrorBoundary。
 * - 被依赖：workbench/Band.tsx。
 *
 * 改哪里
 * - 卡片文案与主按钮：本文件。
 * - 兜底行为（重试、技术详情、复制）：client/ErrorBoundary.tsx。
 */
import type { ReactNode } from 'react'
import { ErrorBoundary } from '../ErrorBoundary'

/** Props for {@link EditorBoundary}. */
export interface EditorBoundaryProps {
  /** Ask the workbench to show this document in the source view. */
  readonly onShowSource: () => void
  /** The editor subtree. */
  readonly children: ReactNode
}

/**
 * Render the editor, or the card that says why it could not be rendered.
 */
export function EditorBoundary({ onShowSource, children }: EditorBoundaryProps): ReactNode {
  return (
    <ErrorBoundary
      title="这篇在富文本里打不开"
      hint="文件没有被修改。可以用源码视图只读查看；再试一次会重新导入这篇文档。"
      retryLabel="再试一次"
      primary={{ label: '用源码视图打开', onClick: onShowSource }}
    >
      {children}
    </ErrorBoundary>
  )
}
