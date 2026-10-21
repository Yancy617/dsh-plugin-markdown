/**
 * 点击链接：把地址交给打开器（由 webPage.ts 决定开在哪）。
 *
 * 内容
 * - OPENABLE_PROTOCOLS / ClickIntent。
 * - opensOnClick / externalDestination / intentOf / registerLinkClick。
 *
 * 行为
 * - 只接管不带修饰键的左键单击；正在选文字时不打开。
 * - 只认 http(s)；相对地址、锚点、mailto/tel/sms 都不打开。
 * - 挂在编辑器根元素上（registerRootListener）。
 * - 没打开时报地址与原因（console.info）；打开时的日志由打开器报。
 *
 * 边界
 * - 不决定打开通道（webPage.ts）。
 * - 不接外部应用协议。
 *
 * 相关文件
 * - 依赖：webPage.ts、@lexical/link、lexical。
 * - 被依赖：MarkdownEditor.tsx、scripts/probe-units.ts。
 *
 * 改哪里
 * - 改判据：opensOnClick / externalDestination。
 * - 改挂载：registerLinkClick。
 */

import { $findMatchingParent, $getNearestNodeFromDOMNode } from 'lexical'
import type { LexicalEditor } from 'lexical'
import { $isLinkNode } from '@lexical/link'
import type { OpenWebPage } from '../webPage'

/** 能开成网页的协议。官方 `MarkdownAnchor` 用的就是这两个。 */
const OPENABLE_PROTOCOLS = new Set(['http:', 'https:'])

/** 一次点击里用得上的那几位 —— 只取判据用得上的，所以是一个具名的小类型。 */
export interface ClickIntent {
  /** `MouseEvent.button`：0 是左键。 */
  readonly button: number
  readonly metaKey: boolean
  readonly ctrlKey: boolean
  readonly shiftKey: boolean
  readonly altKey: boolean
}

/**
 * 这次点击要不要由我们接管去打开。
 *
 * 纯函数：一次点击的形状 + "眼下是否正选着文字"，进出都是布尔 —— `probe:units` 直接钉住它。
 * @param intent - 点击的形状。
 * @param hasSelectedText - 点下去的那一刻选区是否非空（拖选链接文字时不能顺手开一个标签页）。
 * @returns 是否接管。
 */
export function opensOnClick(intent: ClickIntent, hasSelectedText: boolean): boolean {
  // 官方 `MarkdownAnchor` 的 `onClick` 第一句：只认不带修饰键的左键单击。
  if (intent.button !== 0) return false
  if (intent.metaKey || intent.ctrlKey || intent.shiftKey || intent.altKey) return false
  // Lexical 自己那条：`Allow user to select link text without following url`（非折叠选区直接返回）。
  return !hasSelectedText
}

/**
 * 地址能不能开成网页；能就给规范化的地址，不能给 `null`。
 *
 * 纯函数：一个字符串进出 —— `probe:units` 直接钉住它。
 * @param destination - 链节里写的目标，原样（可能带空白）。
 * @returns 可打开的绝对地址，或 `null`。
 */
export function externalDestination(destination: string): string | null {
  const text = destination.trim()
  if (text === '') return null
  let parsed: URL
  try {
    parsed = new URL(text)
  } catch {
    // 没有 scheme：相对路径、锚点以及写坏的地址都从这里出去。
    return null
  }
  return OPENABLE_PROTOCOLS.has(parsed.protocol) ? parsed.href : null
}

/**
 * 把点击事件压成判据要的那几位。
 * @param event - 点击事件。
 * @returns 点击的形状。
 */
function intentOf(event: MouseEvent): ClickIntent {
  return {
    button: event.button,
    metaKey: event.metaKey,
    ctrlKey: event.ctrlKey,
    shiftKey: event.shiftKey,
    altKey: event.altKey,
  }
}

/**
 * 让编辑区里点链接能打开。
 *
 * 挂在编辑器的根元素上（`registerRootListener`，Lexical 自己那份也是这么挂的），因为链接是根节点
 * 底下任意深度的东西，而根元素本身是稳定的。不是链接上的点击直接返回：那是绝大多数点击，不接管、
 * 也不打印日志。
 *
 * 日志走 `console.info`：**没打开**时这里报点到的地址与原因（不是链接 / 不是网页地址 / 改键 /
 * 正在选文字）；**打开**时的日志由打开器报（走了哪条通道、为什么没走官方那条）。
 * @param editor - 编辑器实例。
 * @param open - 打开器；官方标签优先、系统浏览器兜底，见 `../webPage.ts`。
 * @returns 撤销登记的函数。
 */
export function registerLinkClick(editor: LexicalEditor, open: OpenWebPage): () => void {
  const onClick = (event: MouseEvent): void => {
    const target = event.target
    if (!(target instanceof Node)) return
    const intent = intentOf(event)
    /*
      拖选链接文字时不该顺手开一个标签页。这里读的是**浏览器当下的选区** —— 判据问的正是"用户
      刚刚是不是在拖选"，而 DOM 里那一份就是浏览器此刻的答案。Lexical 那份 `$getSelection()` 由
      `selectionchange` 提交，**提交与这个 click 的先后没有量过**（不拿没量过的东西当依据），至少
      它答的不是"浏览器眼下认为选了什么"，所以不用它。
    */
    const domSelection = window.getSelection()
    const hasSelectedText = domSelection !== null && !domSelection.isCollapsed
    // 一次读里问一件事：点到的这个 DOM 节点往上，有没有一个链接节点。
    // `$findMatchingParent` 会把起点自己也算一遍，所以点在 `<a>` 那一层上同样认得出。
    const url = editor.read('latest', () => {
      const node = $getNearestNodeFromDOMNode(target)
      const link = node === null ? null : $findMatchingParent(node, $isLinkNode)
      return link?.getURL() ?? null
    })

    if (url === null) return
    const destination = externalDestination(url)
    if (destination === null) {
      console.info(`[markdown] 点击链接：地址=${url}，动作=不打开（不是 http/https 地址）`)
      return
    }
    if (!opensOnClick(intent, hasSelectedText)) {
      console.info(
        `[markdown] 点击链接：地址=${url}，动作=不打开（${
          hasSelectedText ? '正在选文字' : '带修饰键或不是左键单击'
        }）`,
      )
      return
    }
    // 打开这一步交给打开器：它决定开在 DSH 自己的浏览器标签里还是系统浏览器，并打出日志。
    event.preventDefault()
    open(destination)
  }

  return editor.registerRootListener(rootElement => {
    if (rootElement === null) return
    rootElement.addEventListener('click', onClick)
    return () => rootElement.removeEventListener('click', onClick)
  })
}
