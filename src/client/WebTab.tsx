/**
 * 本面板网页标签的正文：把一块地方交给 webFrame.ts 的载体。
 *
 * 内容
 * - WebTabViewProps / WebTabView / webTabTitle。
 * - area / host / notice / line（内联样式）。
 *
 * 行为
 * - 挂载时 openWebGuest(host, url, storageKey)；卸载时 dispose + 清空容器。
 * - storageKey 走 ref、不进依赖表，避免仓库根变化时重建 guest。
 * - 三种状态：loading / ready / failed；failed 显示说明与“用系统浏览器打开”。
 * - 标题回调走 ref，避免父组件重渲染导致 effect 重跑。
 *
 * 边界
 * - 不负责载体选择（webFrame.ts）与“该由谁显示”（webPage.ts）。
 *
 * 相关文件
 * - 依赖：webFrame.ts、primitives。
 * - 被依赖：MarkdownWorkbench.tsx。
 *
 * 改哪里
 * - 改挂载：useEffect。
 * - 改失败文案：failed 分支。
 * - 改标题：webTabTitle。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { openWebGuest, webCarrier, type WebGuest } from './webFrame'

/** Props for {@link WebTabView}. */
export interface WebTabViewProps {
  /** 要显示的 http(s) 地址。 */
  readonly url: string
  /** 存储分区的 key（本插件用仓库根目录）。 */
  readonly storageKey: string
  /** 页面标题变了就报上来（标签上那行字跟着它）。 */
  readonly onTitle?: (title: string) => void
}

/**
 * 一个网页标签的正文。
 * @param props - 地址、存储 key、标题回调。
 * @returns the frame area, its placeholder, or the failure notice.
 */
export function WebTabView({ url, storageKey, onTitle }: WebTabViewProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const titleRef = useRef(onTitle)
  titleRef.current = onTitle
  /*
    租约的 key 走 ref、**不进依赖表**：它一旦变化（仓库根在挂载早期会从 `null` 变成路径），effect
    就会重跑，而重跑意味着**重新租一个 guest、重建元素** —— 表现为“一直闪、鼠标点不动”，
    正是“guest 被反复重建”的样子。所以这里只跟地址走。
  */
  const keyRef = useRef(storageKey)
  keyRef.current = storageKey
  const [phase, setPhase] = useState<'loading' | 'ready' | 'failed'>('loading')

  useEffect(() => {
    const host = hostRef.current
    if (host === null) return undefined
    // 先要一个"取消"令牌：这一块可能在租约还没批下来时就没了（切标签、关标签）。
    let live = true
    let guest: WebGuest | undefined
    setPhase('loading')
    void openWebGuest(host, url, keyRef.current, title => titleRef.current?.(title)).then(
      opened => {
        if (!live) {
          opened.dispose()
          return
        }
        guest = opened
        setPhase('ready')
      },
      () => {
        if (live) setPhase('failed')
      },
    )
    return () => {
      live = false
      guest?.dispose()
      host.replaceChildren()
    }
  }, [url])

  /** 把这一页交给系统浏览器 —— 这是**用户自己点**的，所以不会被弹窗拦截。 */
  const openOutside = useCallback((): void => {
    window.open(url, '_blank', 'noopener,noreferrer')
  }, [url])

  return (
    <div style={area}>
      <div ref={hostRef} style={host} hidden={phase === 'failed'} />
      {phase === 'failed' ? (
        <div style={notice}>
          <p style={line}>
            {webCarrier() === 'iframe'
              ? '这个网页不允许被嵌进别的页面显示（站点自己的安全策略），所以在这里显示不出来。'
              : '没能在这个面板里挂上网页视图（DSH 的桌面外壳没有批下浏览器租约）。'}
          </p>
          <Button size="sm" onClick={openOutside}>
            用系统浏览器打开
          </Button>
        </div>
      ) : null}
    </div>
  )
}

/**
 * 网页标签那一格显示什么名字。
 * @param url - 这一格的地址。
 * @returns 主机名；解析不了就退回原样。
 */
export function webTabTitle(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/* 这一层只有三块几何：整块、承载载体的那一块、以及出错时的说明。
   载体元素自己在里面铺满（`webFrame.ts` 的 `fillFrame`），所以这里的容器只要**确定尺寸**。 */
const area: React.CSSProperties = {
  flex: 1,
  minHeight: 0,
  minWidth: 0,
  display: 'flex',
  position: 'relative',
}
/** 载体元素的定位祖先与尺寸来源；官方那条规则要求父元素是 **flex 容器**（元素自己是 `flex: auto`）。 */
const host: React.CSSProperties = {
  position: 'relative',
  flex: 1,
  minWidth: 0,
  minHeight: 0,
  display: 'flex',
}
const notice: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 12,
  padding: 24,
  textAlign: 'center',
}
const line: React.CSSProperties = { margin: 0, maxWidth: 360 }
