/**
 * Markdown 工作台的侧栏图标。
 *
 * 内容
 * - MarkdownPanelIcon。
 *
 * 行为
 * - 注册进 sidebar.panellist，id 同时是 main 面板 key。
 * - 用产品图标集的 IconListPenOutlineRegular；active 只改 opacity。
 *
 * 边界
 * - 不负责面板注册与选中状态（侧栏自己的事）。
 *
 * 相关文件
 * - 依赖：primitives、sidebar/client。
 * - 被依赖：index.tsx。
 *
 * 改哪里
 * - 改图标：MarkdownPanelIcon。
 */
import { IconListPenOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SidebarPanelIconOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'

/**
 * Render the Markdown panel icon.
 * @param props - the sidebar's icon presentation.
 * @returns the product-set glyph.
 */
export function MarkdownPanelIcon({ size, active }: SidebarPanelIconOwnerProps) {
  // `active` is folded into opacity only because the sidebar owns the selected
  // chrome (background, ring); the glyph itself must stay a plain currentColor
  // drawing so it inherits whatever foreground that chrome sets.
  return (
    <span style={{ display: 'inline-flex', opacity: active ? 1 : 0.8 }}>
      <IconListPenOutlineRegular size={size} />
    </span>
  )
}
