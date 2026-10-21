/**
 * 网页载体：把真实网页放进本面板，复用 DSH 自己的载体。
 *
 * 内容
 * - DesktopBrowserBridge / GuestReservation / DesktopCarrier / WEB_BROWSER_SANDBOX。
 * - WebGuest / WebCarrier / webCarrier / openWebGuest。
 * - fillFrame / openIframeGuest / openWebviewGuest（私有）。
 *
 * 行为
 * - 桌面（dshDesktop.browser 协议 1）：acquire 租约 → <webview> → dom-ready 后 loadURL → release。
 * - Web：sandbox iframe + no-referrer。
 * - 只给宽高 100% 与 inline-flex，容器尺寸由 WebTab.tsx 的 flex 链保证。
 * - 拿不到桌面桥就抛给调用方，由 WebTab 显示说明与系统浏览器按钮。
 *
 * 边界
 * - 不负责“该由谁显示”（webPage.ts）与标签 UI（WebTab.tsx）。
 *
 * 相关文件
 * - 被依赖：WebTab.tsx。
 *
 * 改哪里
 * - 改载体选择：webCarrier。
 * - 改挂载：openWebGuest。
 * - 改尺寸：fillFrame。
 */

/** 官方那个 `dshDesktop.browser` 面：只声明这里用到的两个动作。 */
interface DesktopBrowserBridge {
  /** 租一个 guest（存储分区 + 引导租约）。 */
  readonly acquire: (workspaceKey: string) => Promise<GuestReservation>
  /** 归还租约。 */
  readonly release: (lease: string) => Promise<unknown>
}

/** 主进程批下来的那份租约。 */
interface GuestReservation {
  readonly lease: string
  readonly partition: string
}

/** 桌面外壳挂在 window 上的那个全局（官方从这里取载体）。 */
interface DesktopCarrier {
  readonly protocolVersion?: number
  readonly browser?: DesktopBrowserBridge
}

/** 官方 Web 载体的沙箱位，逐字照抄（`WEB_BROWSER_SANDBOX`）。 */
const WEB_BROWSER_SANDBOX =
  'allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox'

/** 一个已经挂进容器的网页；`dispose` 把它连同租约一起收掉。 */
export interface WebGuest {
  /** 收掉这个 guest（移除元素 + 归还租约）。 */
  dispose(): void
}

/** 这一台机器上能用哪种载体。 */
export type WebCarrier = 'webview' | 'iframe'

/**
 * 这台机器上能用哪种载体。
 *
 * 与官方同一个判据：有桌面外壳（`dshDesktop.browser`，协议版本 1）就用 `<webview>`，否则用 iframe。
 * @returns 载体名，或 `null`（连 iframe 都没有的环境，例如 node 里的探针）。
 */
export function webCarrier(): WebCarrier | null {
  if (desktopBridge() !== undefined) return 'webview'
  return typeof document === 'undefined' ? null : 'iframe'
}

/**
 * 把一个网页挂进容器。
 *
 * @param container - 承载它的元素（我们的标签正文）。
 * @param url - http(s) 绝对地址（调用方已判过）。
 * @param storageKey - 存储分区的 key（本插件用仓库根目录）。
 * @param onTitle - 页面标题变化时的回调（官方观察 `page-title-updated`）。
 * @param onEvent - 诊断用：guest 的每个生命周期事件都报一个名字上来
 *   （`dom-ready` / `load` / `load-end` / `nav` / `fail` / `gone` …），用于界面角标。
 * @returns 这个 guest；`dispose` 收掉它。
 */
export async function openWebGuest(
  container: HTMLElement,
  url: string,
  storageKey: string,
  onTitle?: (title: string) => void,
  onEvent?: (name: string) => void,
): Promise<WebGuest> {
  const bridge = desktopBridge()
  if (bridge === undefined) return openIframeGuest(container, url, onTitle, onEvent)

  // 桌面那条：先租，再造元素，挂上之后 dom-ready 才导航（官方就是这个顺序 —— 挂载前导航会丢）。
  const reservation = await bridge.acquire(storageKey)
  const element = document.createElement('webview') as HTMLElement & {
    loadURL?: (url: string) => Promise<void>
  }
  fillFrame(element)
  element.setAttribute('name', reservation.lease)
  element.setAttribute('partition', reservation.partition)
  element.setAttribute('allowpopups', '')
  element.setAttribute('src', `about:blank#${reservation.lease}`)
  let disposed = false
  const release = (): void => {
    void bridge.release(reservation.lease).catch(() => undefined)
  }
  /*
   * 只导航一次：dom-ready 在每次文档就绪时都触发，重复 loadURL 会打断上一次加载（ERR_ABORTED），
   * 长页面表现为持续闪烁。官方同样只取一次待办；这里用一道 navigated 闸门表达同一件事。
   */
  let navigated = false
  element.addEventListener('dom-ready', () => {
    if (disposed || navigated) return
    navigated = true
    void element.loadURL?.(url).catch(() => undefined)
  })
  if (onTitle !== undefined) {
    element.addEventListener('page-title-updated', event => {
      const title = (event as Event & { title?: string }).title
      if (typeof title === 'string' && title !== '') onTitle(title)
    })
  }
  container.append(element)
  return {
    dispose: () => {
      disposed = true
      element.remove()
      release()
    },
  }
}

/**
 * Web 那条：沙箱 iframe（字段与官方一致）。
 * @param container - 承载它的元素。
 * @param url - 目的地址。
 * @param onTitle - 标题回调（跨域 iframe 读不到标题，只有 `load`；这里用主机名当标题）。
 * @returns 这个 guest。
 */
function openIframeGuest(
  container: HTMLElement,
  url: string,
  onTitle?: (title: string) => void,
  onEvent?: (name: string) => void,
): WebGuest {
  const element = document.createElement('iframe')
  fillFrame(element)
  element.src = url
  element.title = url
  element.referrerPolicy = 'no-referrer'
  element.dataset.dshWebFrame = 'iframe'
  element.setAttribute('sandbox', WEB_BROWSER_SANDBOX)
  element.addEventListener('load', () => {
    onEvent?.('load')
    onTitle?.(hostOf(url))
  })
  element.addEventListener('error', () => onEvent?.('fail'))
  container.append(element)
  return {
    dispose: () => {
      element.remove()
    },
  }
}

/**
 * 桌面外壳那把桥。
 * @returns 桥，或 `undefined`（Web / 探针 / 版本不符）。
 */
function desktopBridge(): DesktopBrowserBridge | undefined {
  const carrier = (globalThis as typeof globalThis & { dshDesktop?: DesktopCarrier }).dshDesktop
  if (carrier?.protocolVersion !== 1) return undefined
  return carrier.browser
}

/**
 * 给载体元素铺满容器 —— **逐字照抄官方那条规则**。
 *
 * 官方 `.webview` 的 CSS module（`dsh-client-ui-sidebar-browser/lib/client.js` 里就能读到）：
 *
 * ```css
 * .webview{ -webkit-app-region:no-drag; border:0; flex:auto; width:100%; min-width:0;
 *           height:100%; min-height:0; display:flex }
 * ```
 *
 * 三处与我原先写的不同，各自都可能是"闪 ＋ 鼠标点不动"的原因：
 *
 *   - `display` 是 **`flex`**（不是 `inline-flex`，也不是 `block`）；
 *   - 它是父 flex 容器里的**弹性项**（`flex: auto` ＋ `min-width/min-height: 0`），不是靠百分比硬撑 ——
 *     所以 `WebTab.tsx` 的承载块必须是 `display: flex`；
 *   - **`-webkit-app-region: no-drag`** —— 桌面外壳里这一块若落在窗口拖动区，点它会被当成拖窗口，
 *     表现正好是"鼠标点不动"。
 * @param element - `webview` 或 `iframe`。
 */
function fillFrame(element: HTMLElement): void {
  element.style.setProperty('-webkit-app-region', 'no-drag')
  element.style.border = '0'
  element.style.flex = 'auto'
  element.style.width = '100%'
  element.style.minWidth = '0'
  element.style.height = '100%'
  element.style.minHeight = '0'
  element.style.display = 'flex'
  element.style.background = 'var(--dsw-alias-bg-base, #fff)'
}

/**
 * 把容器的当前尺寸同步给载体元素 —— 当前没有调用。
 *
 * 容器尺寸由 WebTab.tsx 的 flex 链保证；逐帧写像素尺寸会触发 guest 重排（长页面尤其明显）。
 * 保留实现是因为“容器变化时 guest 停在旧尺寸”仍可能出现；启用前要先能区分“写尺寸”与“页面自己重排”。
 * @param container - 承载它的元素。
 * @param element - 载体元素。
 * @returns 停止观察的函数。
 */
export function followContainer(container: HTMLElement, element: HTMLElement): () => void {
  const sync = (): void => {
    const rect = container.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return
    element.style.width = `${String(Math.round(rect.width))}px`
    element.style.height = `${String(Math.round(rect.height))}px`
  }
  sync()
  if (typeof ResizeObserver === 'undefined') return () => undefined
  const observer = new ResizeObserver(sync)
  observer.observe(container)
  return () => {
    observer.disconnect()
  }
}

/**
 * 一个地址的主机名，用作占位标题。
 * @param url - 绝对地址。
 * @returns 主机名；解析不了就原样返回。
 */
export function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}
