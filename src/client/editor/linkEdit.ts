/**
 * 链接的读、写、插、删：地址与**显示文字**的判据，以及"值没变就不动字节"。
 *
 * 内容
 * - LinkReading：一处链接读出来的样子（地址、显示文字、悬停提示）。
 * - linkDestination：输入框里的一串 ⇒ 要写进链接的目的地。
 * - $readLink / $writeLink / $insertLink / removeLink。
 *
 * 行为
 * - 链接在读取时已解析成普通链接；这里读的是它的真实地址、显示文字与悬停提示。
 * - 选区在链接文字里或整行选中，两条路都能找到链接。
 * - **只改显示文字时原地改**：不换节点，引用式身份（`referenceForm.ts`）与悬停提示都留着。
 * - **改地址时换成内联链接**：地址的真相在定义行里，改这一处不该连带去改别的块；
 *   悬停提示原样搬过去。
 * - 显示文字留空 ⇒ 用地址当显示文字（网址形态写出来就是 `<地址>`，不会重复两遍）。
 * - 值没变就不动字节；没改就点应用不会改写法。
 * - 选区里没有链接时 $insertLink 就是"插入"：文字选中就包住它，光标就插入一处新链接。
 * - 地址可以只写主机名：没有 scheme 的补 https://（linkDestination）。
 * - removeLink 把这一处变回普通文字。
 *
 * 边界
 * - 不管定义的存废（definitions.ts / documentMarkdown.ts）。
 * - 不管弹窗外观（LinkDialog.tsx）。
 * - 链接里若有非文字子节点（例如徽章图片），显示文字不生效（只改地址），不删用户的图片。
 *
 * 相关文件
 * - 依赖：@lexical/link 的 $toggleLink。
 * - 被依赖：FloatingToolbar.tsx、SlashMenu.tsx（插入）、scripts/probe-block.ts。
 *
 * 改哪里
 * - 改读：$readLink。
 * - 改写：$writeLink / $insertLink / removeLink。
 * - 改地址补全：linkDestination。
 */
import {
  $createTextNode,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  $isTextNode,
  type LexicalEditor,
  type LexicalNode,
} from 'lexical'
import {
  $createLinkNode,
  $isLinkNode,
  $toggleLink,
  TOGGLE_LINK_COMMAND,
  type LinkNode,
} from '@lexical/link'
import { $referenceFormOf, $setReferenceForm } from './referenceForm'

/** 一处链接读出来的样子。 */
export interface LinkReading {
  /** 真实地址。 */
  readonly url: string
  /** 屏幕上显示的文字（链接自己的子节点读出来的那串）。 */
  readonly text: string
  /** 悬停提示（title），没有就是空串。 */
  readonly title: string
}

/**
 * 选区内那一处链接所在的节点。
 *
 * 两条路都要走，因为"选区在链接里"有两种落法：
 *
 *   - 锚点在链接**文字**里（点进去、拖几个字）⇒ 往上走一层就到链接；
 *   - 选区整个盖住链接（三击选中整行）⇒ 锚点会落在链接所在的那个段落上，而链接是它的孩子
 *     之外的兄弟 —— 这时要按“锚点所在的子树”去找覆盖选区的那一个链接；只往上走会读不到。
 * @returns 链接节点，或 `null`。
 */
function $activeLink(): LinkNode | null {
  const selection = $getSelection()
  if (!$isRangeSelection(selection)) return null

  const anchor = selection.anchor.getNode()
  for (let node: LexicalNode | null = anchor; node !== null; node = node.getParent()) {
    if ($isLinkNode(node)) return node
  }

  // 整行选中那一支：在锚点所在的块里找**覆盖了选区**的链接。
  const block = $findBlock(anchor)
  if (block === null || !$isElementNode(block)) return null
  const anchorKey = selection.anchor.key
  const focusKey = selection.focus.key
  for (const child of block.getChildren()) {
    if (!$isLinkNode(child)) continue
    const keys = $descendantKeys(child)
    if (keys.has(anchorKey) || keys.has(focusKey)) return child
  }
  return null
}

/**
 * 从某个节点往上找到第一个块级祖先（段落、标题这类）。
 * @param node - 起点。
 * @returns 块级祖先，或 `null`。
 */
function $findBlock(node: LexicalNode): LexicalNode | null {
  for (let current: LexicalNode | null = node; current !== null; current = current.getParent()) {
    if ($isElementNode(current) && current.getType() !== 'root') return current
  }
  return null
}

/**
 * 一个节点子树里所有节点（含文字节点）的键。
 * @param node - 子树的根。
 * @returns 键的集合。
 */
function $descendantKeys(node: LexicalNode): Set<string> {
  const keys = new Set<string>([node.getKey()])
  if (!$isElementNode(node)) return keys
  for (const child of node.getChildren()) {
    for (const key of $descendantKeys(child)) keys.add(key)
  }
  return keys
}

/**
 * 读当前选区内那一处链接。
 *
 * 必须在 Lexical 的编辑器上下文里调用。
 * @returns 地址、显示文字与悬停提示；选区不在链接里时是 `null`。
 */
export function $readLink(): LinkReading | null {
  const active = $activeLink()
  if (active === null) return null
  return {
    url: active.getURL(),
    text: active.getTextContent(),
    title: active.getTitle() ?? '',
  }
}

/**
 * 弹窗里输入的一串，变成要写进链接的目的地。
 *
 * 作者只写 `example.com` 或 `www.example.com` 时补上 `https://` —— 补的是协议，`www.` 原样留着。
 * 已经有 scheme 的（`https://`、`mailto:`、`tel:`、`sms:`）原样；`//cdn…` 只补协议；
 * `./note.md`、`/abs/path`、`#anchor` 这类明显是相对地址 / 锚点的也原样 —— 它们不是网页地址，
 * 补协议只会把作者写的东西写坏。
 *
 * **中文句号当点。** 中文输入法下 `example。com` 是最常见的误输入，而它在 URL 里没有别的意思，
 * 所以先换成 `.` 再判。大写原样保留（scheme 与主机都是大小写不敏感的，写回去仍是作者写的样子）。
 * @param input - 输入框里的值（允许首尾空白）。
 * @returns 链接节点的目的地；空输入给空串。
 */
export function linkDestination(input: string): string {
  const value = input.trim().replace(/。/g, '.')
  if (value === '') return ''
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return value
  if (/^(mailto|tel|sms):/i.test(value)) return value
  if (value.startsWith('//')) return `https:${value}`
  if (/^[./#]/.test(value)) return value
  return `https://${value}`
}

/**
 * 用一个新的链接节点替换掉 `active`，新节点**一出生就带着**它的显示文字。
 *
 * 为什么不原地删孩子再补一个：链接一旦短暂变空，`emptyLink.ts` 的清理就可能把壳收掉，
 * 于是"改文字"变成"链接消失"。先造好新节点、再一次性替换，中间没有空链接这个状态。
 *
 * 文字沿用原第一个文字节点的格式与样式；原链接里若有非文字子节点（徽章图片），保留它们、
 * 不改文字（`replaceText` 传 `false` 时也走这一支）。
 * @param active - 要被替换的链接。
 * @param destination - 新地址。
 * @param visible - 新的显示文字。
 * @param replaceText - 是否换掉文字。
 * @param keepForm - 是否把引用式身份搬过去。
 * @returns 是否改了文字（`false` ＝ 文字原样沿用）。
 */
function $rewriteLink(
  active: LinkNode,
  destination: string,
  visible: string,
  replaceText: boolean,
  keepForm: boolean,
): boolean {
  const children = active.getChildren()
  const form = keepForm ? $referenceFormOf(active) : null
  const link = $createLinkNode(destination, { title: active.getTitle() ?? null })
  const canReplaceText = children.every(child => $isTextNode(child))
  let textChanged = false
  if (replaceText && canReplaceText) {
    const first = children[0]
    const node = $createTextNode(visible)
    if (first !== undefined) {
      if (first.getFormat() !== 0) node.setFormat(first.getFormat())
      if (first.getStyle() !== '') node.setStyle(first.getStyle())
    }
    link.append(node)
    active.replace(link)
    /*
     * 旧的文字节点被换掉了，而选区还指着它 —— 不把选区搬走，Lexical 会在提交时拒绝这次更新
     * （"selection has been lost"）。选中新文字：既解决了合法性，也让读者可以直接接着改。
     */
    node.select(0, node.getTextContentSize())
    textChanged = true
  } else {
    for (const child of children) link.append(child)
    active.replace(link)
  }
  if (form !== null) $setReferenceForm(link, form)
  return textChanged
}

/**
 * 把当前选区内那一处链接写成新的地址与显示文字。
 *
 * **值没变就什么都不做**：用户点开弹窗看一眼、直接点应用，这一处必须原样留着。
 * 显示文字留空 ⇒ 用地址。
 *
 * 必须在 Lexical 的编辑器上下文里调用。
 * @param url - 新地址（可以没有 scheme，见 {@link linkDestination}）。
 * @param text - 新的显示文字；空串表示用地址。
 * @returns 是否改动了（`false` ＝ 值没变，字节不动）。
 */
export function $writeLink(url: string, text: string): boolean {
  const active = $activeLink()
  if (active === null) return false
  const destination = linkDestination(url)
  if (destination === '') return false
  const visible = text.trim() === '' ? destination : text.trim()
  const urlChanged = active.getURL() !== destination
  const textChanged = active.getTextContent() !== visible
  if (!urlChanged && !textChanged) return false
  /*
   * 只改文字时保留引用式身份（地址的真相在定义行里，这一处不该换写法）；
   * 改地址时不保留 —— 写回内联链接，不连带去改别的块。
   */
  $rewriteLink(active, destination, visible, textChanged, !urlChanged)
  return true
}

/**
 * 把当前选区变成一处链接 —— 选区里**还没有**链接时才该走这里（有链接就走 {@link $writeLink}）。
 *
 * 两条路：
 *
 * - **选中了文字**：交给官方的 `$toggleLink`。它负责在选区两端切分文本节点、合并相邻同地址的链接、
 *   保留选区里的行内格式；显示文字若与选中的文字不同，再在链接里换一次文字。
 * - **光标（折叠选区）**：插入一处新链接，显示文字用 `text`；留空就用地址，于是导出时"文字等于
 *   目的地"正好落回 `<地址>` 的尖括号形态。
 *
 * 必须在 Lexical 的编辑器上下文里调用。
 * @param url - 输入框里的地址（可以没有 scheme）。
 * @param text - 显示文字；空串表示用地址。
 * @returns 是否插入了（选区不是 RangeSelection，或地址是空的，就答 `false`）。
 */
export function $insertLink(url: string, text: string): boolean {
  const selection = $getSelection()
  if (!$isRangeSelection(selection)) return false
  const destination = linkDestination(url)
  if (destination === '') return false
  const visible = text.trim() === '' ? destination : text.trim()
  if (selection.isCollapsed()) {
    const link = $createLinkNode(destination)
    link.append($createTextNode(visible))
    selection.insertNodes([link])
    return true
  }
  $toggleLink(destination)
  const active = $activeLink()
  if (active !== null && active.getTextContent() !== visible) {
    $rewriteLink(active, destination, visible, true, false)
  }
  return true
}

/**
 * 把当前选区内那一处链接变回普通文字。
 *
 * 复用 `@lexical/link` 自己的命令（传 `null`），它已经把"拆开链接、保留文字"这件事做对了；
 * 这里只是把调用的入口收在一处，免得弹窗直接对着第三方命令写。
 * @param editor - 编辑器。
 * @returns 命令是否被处理。
 */
export function removeLink(editor: LexicalEditor): boolean {
  return editor.dispatchCommand(TOGGLE_LINK_COMMAND, null)
}
