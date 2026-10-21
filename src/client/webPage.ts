/**
 * 一个网页该由谁显示：平台那条路能走就走，走不了交给本插件的网页标签。
 *
 * 内容
 * - BROWSER_KIND / SidebarRight / SidebarRightTabs。
 * - WebPageChannel / WebPageOutcome / OpenWebPage。
 * - WebPageGates / WebPageRoute / webPageRoute。
 * - openInSystemBrowser / webPageOpener。
 *
 * 行为
 * - 四道闸门：sidebarRight 服务、sidebarRightTabs 注册表、browser 种类、在屏会话。
 * - 四道都过 → ctx.sidebarRight.openTab('browser', { params: { url } })。
 * - 任一不过 → channel: 'panel'，由 WebTab.tsx 在本面板标签栏打开。
 * - 平台接口抛错 → 落到 panel，并带上原因。
 * - 不主动开系统浏览器；只有拿不到打开器时才用 openInSystemBrowser。
 *
 * 边界
 * - 不改平台右栏布局 / 宽度 / 展开状态。
 * - 不负责载体本身（webFrame.ts）与标签 UI（WebTab.tsx）。
 *
 * 相关文件
 * - 依赖：cordis Context、sidebar-right 类型、shared/errors。
 * - 被依赖：MarkdownWorkbench.tsx、MarkdownEditor.tsx、scripts/probe-units.ts。
 *
 * 改哪里
 * - 改判决：webPageRoute。
 * - 改平台调用：openBrowserTab。
 */
import type { Context } from '@deepseek-ai/cordis'
// 平台在客户端 Context 上声明了 `sidebarRight` 与 `sidebarRightTabs` 两个服务（类型只用于声明）。
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'

/** 官方浏览器标签的种类名。 */
const BROWSER_KIND = 'browser'

/** 右侧栏导航服务的类型（由那个包在 Context 上声明）。 */
type SidebarRight = Context['sidebarRight']

/** 右侧栏标签注册表的类型（同上）。 */
type SidebarRightTabs = Context['sidebarRightTabs']

/** 网页由谁显示。 */
export type WebPageChannel =
  /** DSH 自己的浏览器标签（右侧栏那一格）。 */
  | 'dshtab'
  /** 本插件面板标签栏里的一格网页标签（`./WebTab.tsx`）。 */
  | 'panel'

/** 一次打开的结果。 */
export interface WebPageOutcome {
  /** 该由谁显示。 */
  readonly channel: WebPageChannel
  /** 没走平台那条的原因（人话，会进控制台与界面）；走了就是 null。 */
  readonly reason: string | null
}

/**
 * 决定一个网页该由谁显示。
 *
 * @param url - 已经过 `./editor/linkClick.ts` 的 `externalDestination`，是 http(s) 绝对地址。
 * @returns 谁显示它、以及（没走平台那条时）原因。
 */
export type OpenWebPage = (url: string) => WebPageOutcome

/** 平台那条路能不能走，看这四件事。 */
export interface WebPageGates {
  /** `ctx.get('sidebarRight')` 在不在。 */
  readonly service: boolean
  /** `ctx.get('sidebarRightTabs')` 在不在。 */
  readonly registry: boolean
  /** 标签注册表里有没有 `browser` 这种标签。 */
  readonly kind: boolean
  /** 有没有在屏会话（平台那句 `openTab` 的前提）。 */
  readonly mounted: boolean
}

/** 判决。 */
export interface WebPageRoute {
  /** 走哪条。 */
  readonly channel: WebPageChannel
  /** 没走平台那条的原因（人话）；走了就是 `null`。 */
  readonly reason: string | null
}

/**
 * 这一次该由谁显示。
 *
 * 纯函数：四个布尔进出 —— `probe:units` 直接钉住它，**顺序**也是它钉的一部分（没有服务时不该报
 * "没有注册 browser 这种标签"）。
 * @param gates - 四道闸门的输入。
 * @returns 判决。
 */
export function webPageRoute(gates: WebPageGates): WebPageRoute {
  const panel = (reason: string): WebPageRoute => ({ channel: 'panel', reason })
  if (!gates.service) return panel('这个客户端里没有 DSH 的右侧栏服务')
  if (!gates.registry) return panel('这个客户端里没有 DSH 的右侧栏标签注册表')
  if (!gates.kind) return panel('这个客户端没有注册 browser 这种标签')
  if (!gates.mounted) return panel('DSH 的内置浏览器标签只在对话视图里可用，这里没有它的会话面')
  return { channel: 'dshtab', reason: null }
}

/**
 * 退路：交给系统浏览器（桌面版由主进程 `shell.openExternal` 接住）。
 *
 * 这一句与官方聊天壳的 `openExternalLink` 逐字相同。它只在**拿不到打开器**时用（`MarkdownEditor`
 * 的缺省，例如探针那种挂载）—— 有工作台时，归宿是网页标签（`WebTab.tsx` 里那个按钮也用它那句话）。
 * @param url - 要打开的绝对地址。
 * @returns 结果。
 */
export function openInSystemBrowser(url: string): WebPageOutcome {
  window.open(url, '_blank', 'noopener,noreferrer')
  return { channel: 'panel', reason: null }
}

/**
 * 造一个"该由谁显示"的打开器。
 *
 * 每次点击都重新问一遍两个服务：客户端包的加载顺序不归本插件管。
 * @param ctx - 客户端上下文。
 * @returns 打开器。
 */
export function webPageOpener(ctx: Context): OpenWebPage {
  return (url: string): WebPageOutcome => {
    const right = ctx.get('sidebarRight') as SidebarRight | undefined
    const tabs = ctx.get('sidebarRightTabs') as SidebarRightTabs | undefined
    const decision = webPageRoute({
      service: right !== undefined,
      registry: tabs !== undefined,
      kind: tabs?.get(BROWSER_KIND) !== undefined,
      mounted: right?.mounted.getSnapshot() !== undefined,
    })
    if (decision.channel === 'dshtab' && right !== undefined) {
      try {
        openBrowserTab(right, url)
        console.info(`[markdown] 打开网页：地址=${url}，通道=DSH 右侧栏浏览器标签`)
        return { channel: 'dshtab', reason: null }
      } catch (error) {
        const reason = `平台的标签接口拒绝了：${messageOf(error)}`
        console.info(`[markdown] 打开网页：地址=${url}，通道=本面板的网页标签（${reason}）`)
        return { channel: 'panel', reason }
      }
    }
    console.info(
      `[markdown] 打开网页：地址=${url}，通道=本面板的网页标签（${decision.reason ?? ''}）`,
    )
    return decision
  }
}

/**
 * 官方那一句：`ctx.sidebarRight.openTab('browser', { params: { url } })`。
 *
 * 那个包的参数类型由它自己声明在 `SidebarRightTabParamsMap` 里（`params.d.ts`：
 * "the Browser page adds `browser: { url?: string }`"），而它发布到本机的那一份**没有 `.d.ts`**
 * （`app.asar` 里只有 `lib/client.js` 与 `lib/index.js`），所以这一个字段的名字写在这里。
 * @param right - 右侧栏导航服务。
 * @param url - 要打开的绝对地址。
 */
function openBrowserTab(right: SidebarRight, url: string): void {
  const open = right.openTab as unknown as (
    kind: string,
    options: { params: { url: string } },
  ) => void
  open(BROWSER_KIND, { params: { url } })
}

/**
 * 一个错误的人话。
 * @param error - 抛出来的东西。
 * @returns 消息。
 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
