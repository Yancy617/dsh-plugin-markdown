/**
 * 打开着的标签条：文档标签与网页标签共用一行。
 *
 * 内容
 * - DocumentTab / WebTabItem / WorkbenchTabsProps / WorkbenchTabs。
 *
 * 行为
 * - 文档标签：图标 + 显示名 + 关闭；磁盘上有更新版本时带 ⟳，标题里写明原因。
 * - 网页标签：14px 地球图标（官方浏览器标签的默认尺寸）+ 页面标题 + 关闭；选中与文档标签同一套状态样式。
 * - 选中态只由 activePath / activeWebId 决定；关闭按钮报告路径与 disposition（Shift+点击 = 放弃更改）。
 *
 * 边界
 * - 不拥有标签状态，不关标签、不写盘（关闭的后果在组合根）。
 * - 不负责标签的样式值（tabs.module.css）。
 *
 * 相关文件
 * - 依赖：primitives（Button / FileTypeIcon / 图标）、tabs.module.css、shared/paths。
 * - 被依赖：MarkdownWorkbench.tsx。
 *
 * 改哪里
 * - 改标签外观：本文件与 tabs.module.css。
 * - 改显示名：DocumentTab 的来源（组合根），这里只画。
 */
import type { ReactElement } from 'react'
import {
  Button,
  FileTypeIcon,
  IconCloseOutlineRegular,
  IconGlobeOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { basenameOf } from '../../shared/paths'
import tabStyles from '../tabs.module.css'

/** One document tab, as drawn. */
export interface DocumentTab {
  /** Absolute document path. */
  readonly path: string
  /** The buffer's title (basename), used in the close button's accessible name. */
  readonly title: string
  /** What the tab shows: the title without its format. */
  readonly label: string
  /** The file moved on disk while the panel was hidden. */
  readonly stale: boolean
}

/** One web tab, as drawn. */
export interface WebTabItem {
  /** Stable tab id (currently derived from the URL). */
  readonly id: string
  /** Absolute address, shown on hover. */
  readonly url: string
  /** Page title, or the host until the page reports one. */
  readonly title: string
}

/** What the strip draws and reports. */
export interface WorkbenchTabsProps {
  /** Document tabs, in strip order. */
  readonly documents: readonly DocumentTab[]
  /** The showing document, or `null` while a web tab is in front. */
  readonly activePath: string | null
  /** Web tabs, in strip order. */
  readonly webTabs: readonly WebTabItem[]
  /** The showing web tab, or `null`. */
  readonly activeWebId: string | null
  /** A document tab was clicked. */
  onShowDocument(path: string): void
  /** A document tab's × was clicked. `discard` is the Shift+click alternative. */
  onCloseDocument(path: string, disposition: 'save' | 'discard'): void
  /** A web tab was clicked. */
  onSelectWeb(id: string): void
  /** A web tab's × was clicked. */
  onCloseWeb(id: string): void
}

/**
 * The panel's tab strip.
 * @param props - tabs and the four things they can ask for.
 * @returns the strip.
 */
export function WorkbenchTabs(props: WorkbenchTabsProps): ReactElement {
  return (
    <div className={tabStyles.strip} role="tablist" aria-label="打开的文档">
      <span className={tabStyles.tabs}>
        {props.documents.map(tab => {
          const isActive = tab.path === props.activePath
          return (
            <span key={tab.path} className={tabStyles.wrapper}>
              <span className={tabStyles.tab} data-active={isActive}>
                <button
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  className={tabStyles.label}
                  title={tab.stale ? `${tab.path}（磁盘上有更新的版本）` : tab.path}
                  onClick={() => props.onShowDocument(tab.path)}
                >
                  {/* The shell's own per-type glyph, the same component the tree uses. Its `path`
                      is a file name, which is what the classifier reads an extension from. */}
                  <FileTypeIcon path={basenameOf(tab.path)} size={16} />
                  <span className={tabStyles.text}>
                    {tab.label}
                    {/* The unsaved dot is gone: a mark whose meaning has to be explained carries
                        nothing. The ⟳ stays — it appears only when the file changed on disk under
                        the reader, which is not decoration but something they need to know. */}
                    {tab.stale ? ' ⟳' : ''}
                  </span>
                </button>
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<IconCloseOutlineRegular size={14} />}
                  aria-label={`关闭 ${tab.title}`}
                  title="关闭（Shift+点击放弃更改）"
                  className={tabStyles.close}
                  onClick={event =>
                    props.onCloseDocument(tab.path, event.shiftKey ? 'discard' : 'save')
                  }
                />
              </span>
            </span>
          )
        })}
        {/* 网页标签：同一行、同一种写法，只是图标与关闭的去处不同（`closeWebTab`）。 */}
        {props.webTabs.map(tab => (
          <span key={tab.id} className={tabStyles.wrapper}>
            <span className={tabStyles.tab} data-active={tab.id === props.activeWebId}>
              <button
                type="button"
                role="tab"
                aria-selected={tab.id === props.activeWebId}
                className={tabStyles.label}
                title={tab.url}
                onClick={() => props.onSelectWeb(tab.id)}
              >
                {/* 官方浏览器标签用 `IconGlobeOutlineRegular` 的默认尺寸 14px（那颗字形
                    `GlobeOutlineArtwork` 的 `size = 14`），并且带 4px 右外边距；照抄。 */}
                <IconGlobeOutlineRegular size={14} className={tabStyles.globe} />
                <span className={tabStyles.text}>{tab.title}</span>
              </button>
              <Button
                size="sm"
                variant="ghost"
                icon={<IconCloseOutlineRegular size={14} />}
                aria-label={`关闭 ${tab.title}`}
                className={tabStyles.close}
                onClick={() => props.onCloseWeb(tab.id)}
              />
            </span>
          </span>
        ))}
      </span>
    </div>
  )
}
