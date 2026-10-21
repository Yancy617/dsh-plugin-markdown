/**
 * 本面板标签栏里的网页标签：哪几格开着、停在哪一格、以及点链接时开到哪里去。
 *
 * 内容
 * - WebTabs / useWebTabs。
 *
 * 行为
 * - 同一地址复用同一格；新格站到最右边并成为当前那一格。
 * - 切回文档时清掉“当前网页”（两种状态互斥）。
 * - 点链接先问平台自己的标签（`openWebPage`）；那条路按设计拒绝时，退到本面板里开一格。
 * - 网页标签是临时界面状态：不进快照、不跨面板切换。
 *
 * 边界
 * - 不拥有页面内容（WebTab 的载体在 WebTab.tsx / webFrame.ts）。
 * - 不决定平台那条路通不通（webPage.ts）。
 *
 * 相关文件
 * - 依赖：webPage 的 OpenWebPage / WebPageOutcome、WebTab 的 webTabTitle、model 的 WebTabState。
 * - 被依赖：MarkdownWorkbench.tsx（组合根）。
 *
 * 改哪里
 * - 改开格规则：open / openPage。
 * - 改切换规则：select。
 */
import { useCallback, useState } from 'react'
import { webTabTitle } from '../WebTab'
import type { OpenWebPage, WebPageOutcome } from '../webPage'
import type { WebTabState } from './model'

/** The web tabs' public face. */
export interface WebTabs {
  readonly tabs: readonly WebTabState[]
  readonly activeId: string | null
  /** The showing web tab, or `null` while a document is in front. */
  readonly active: WebTabState | null
  /** Select a web tab, or `null` to give the document back. */
  select(id: string | null): void
  /** Open (or focus) one tab for a URL. */
  open(url: string): void
  /** Close one tab; the document comes back when it was the showing one. */
  close(id: string): void
  /** Replace one tab's title with what the page reported. */
  rename(id: string, title: string): void
  /** The editor's link opener: platform tab first, this panel's strip as the fallback. */
  openPage(url: string): WebPageOutcome
}

/**
 * Own this panel's web tabs.
 * @param openWebPage - the platform's own opener, from the registration face.
 * @returns the tabs and the four things that act on them.
 */
export function useWebTabs(openWebPage: OpenWebPage): WebTabs {
  /** 本面板标签栏里的网页标签（DSH 自己那条路走不通时的去处，见 `openPage`）。 */
  const [tabs, setTabs] = useState<WebTabState[]>([])
  /** 当前停在哪一格网页标签上；`null` 表示停在文档上。 */
  const [activeId, setActiveId] = useState<string | null>(null)
  /** 当前那一格（没有就是 `null`）。 */
  const active = tabs.find(tab => tab.id === activeId) ?? null

  /**
   * 在本面板的标签栏里开一个网页标签。
   *
   * 同一个地址复用同一格（与平台"同地址聚焦已有标签"的规矩一致）；新开的站到最右边，并且成为
   * 当前这一格。
   */
  const open = useCallback((url: string): void => {
    const id = `web:${url}`
    setTabs(current =>
      current.some(tab => tab.id === id) ? current : [...current, { id, url, title: webTabTitle(url) }],
    )
    setActiveId(id)
  }, [])

  /**
   * 编辑器点链接用的打开器：比 `./webPage.ts` 多一件事 —— **平台那条走不通时，在本面板的标签栏里
   * 开一个网页标签**。
   *
   * 为什么要有这一步：DSH 自己的浏览器标签是**右侧栏**的标签，只在主列显示对话时才有会话面
   * （判据与出处见 `./webPage.ts` 的文件头）。用户在 Markdown 面板里点链接时那条路按设计拒绝 ——
   * 于是退到**我们自己标签栏里的一格**，载体复用 DSH 自己那套（`./webFrame.ts`：桌面 `<webview>`
   * ＋ 主进程租约，Web 沙箱 iframe）。
   *
   * 用户看到的三条路都不静默：① 平台那条通了 ⇒ 开在右侧栏的 Browser 标签里；② 平台那条不通 ⇒
   * 这里新开一格并把网页画出来；③ 连载体都起不来 ⇒ 那一格自己说明白并给一个"用系统浏览器打开"
   * 的按钮（按钮是用户点的，不受弹窗拦截）。
   */
  const openPage = useCallback(
    (url: string): WebPageOutcome => {
      const outcome = openWebPage(url)
      if (outcome.channel === 'dshtab') return outcome
      open(url)
      return outcome
    },
    [openWebPage, open],
  )

  /**
   * 关掉一个网页标签。
   *
   * 关的是当前这一格就退回落到的那个文档标签（没有文档就空白）；`WebTabView` 会因为卸载而把
   * 网页视图连同租约一起收掉（`./webFrame.ts` 的 `dispose`）。
   */
  const close = useCallback((id: string): void => {
    setTabs(current => current.filter(tab => tab.id !== id))
    setActiveId(current => (current === id ? null : current))
  }, [])

  /** 页面自己报了标题就换掉占位那行字。 */
  const rename = useCallback((id: string, title: string): void => {
    setTabs(current => current.map(tab => (tab.id === id ? { ...tab, title } : tab)))
  }, [])

  return { tabs, activeId, active, select: setActiveId, open, close, rename, openPage }
}
