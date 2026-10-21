/**
 * 图片的选中态与键盘行为：蓝框、Delete、左右键贴到图片两侧。
 *
 * 内容
 * - ImageSelectionPlugin：把整个功能挂到编辑器上。
 * - registerImageSelection(editor)：选中属性同步 ＋ 点击 ＋ 按键，一个入口。
 * - registerImageClick(editor)：点一下图片（不在链接里）选成 NodeSelection。
 * - registerImageKeys(editor)：只注册按键（仪器用：headless 没有 DOM，不能同步属性）。
 * - $selectedImageKeys()：当前选区里的图片节点键。
 *
 * 行为
 * - **选中属性**：每次更新把“选区里的图片”写到宿主 DOM 的 `data-md-image-selected` 上；蓝框由
 *   `EDITOR_CSS` 画。它是纯显示：不进节点状态、不进快照、不进剪贴板、不触发保存。
 *   RangeSelection 取 `getNodes()` 里真正落在选区内的 `md-image`（图片前后紧挨着的文字不会把它
 *   带进来，实测：起点在图片后面的选区只有 text）；NodeSelection 取选中的节点。折叠选区不算选中。
 * - **Delete / Backspace**：范围选区里有图片时，先把这些图片删掉：
 *   - 选区里**只有图片**（`getTextContent()` 等于这些图片 alt 的拼接）⇒ 自己把光标放回图片原来的
 *     位置，命令算已处理；
 *   - 还选着文字 ⇒ 接着调 `selection.deleteCharacter`（rich-text 的 Delete 处理做的也是这一句），
 *     图片与文字落在同一次 update、同一条撤销记录里。
 *   这样“整段选中一张独占的图片”（元素点选区，rich-text 自己删不动）也能删掉。
 * - **点一下图片**（不在链接里）：把它选成 NodeSelection —— 蓝框、Delete、左右键走同一条选中。
 *   带链接的图片（徽章）单击仍然打开链接，要选中它请拖选。返回 true 是为了压住 rich-text 的点击处理，
 *   它会在点击时清掉 NodeSelection。
 * - **左 / 右**：选区**只有图片**时，左键把光标贴到第一张图之前、右键贴到最后一张图之后；
 *   带 Shift / Alt / Cmd / Ctrl 时一律放行。NodeSelection 的删除与左右退出由 rich-text 负责。
 * - 只读（`editor.isEditable()` 为假）时按键不接管。
 *
 * 边界
 * - 带链接的图片单击仍打开链接；选中它请拖选（或拖过它）。
 * - 不删磁盘上的图片文件；不改 markdown 的读写（删图是普通树编辑，保存仍按块级规则）。
 * - 不是节点状态：撤销/重做恢复的是树，属性由本插件按新选区重新同步。
 *
 * 相关文件
 * - 依赖：image.tsx（$isImageNode）、config.ts（IMAGE_SELECTED_ATTRIBUTE / EDITOR_CSS）。
 * - 被依赖：MarkdownEditor.tsx、scripts/probe-block.ts。
 *
 * 改哪里
 * - 选中属性的写法：syncSelected。
 * - Delete / 左右键的判据：registerImageKeys。
 * - 落点规则：$caretBefore / $caretAfter。
 */
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import {
  $createNodeSelection,
  $getNearestNodeFromDOMNode,
  $getSelection,
  $isNodeSelection,
  $isRangeSelection,
  $isTextNode,
  $setSelection,
  CLICK_COMMAND,
  COMMAND_PRIORITY_HIGH,
  DELETE_CHARACTER_COMMAND,
  KEY_ARROW_LEFT_COMMAND,
  KEY_ARROW_RIGHT_COMMAND,
  type EditorState,
  type ElementNode,
  type LexicalEditor,
  type LexicalNode,
  type NodeKey,
  type NodeSelection,
  type RangeSelection,
} from 'lexical'
import { useEffect } from 'react'
import { IMAGE_SELECTED_ATTRIBUTE } from './config'
import { $isImageNode, type ImageNode } from './image'

/**
 * 选区里真正被选中的图片，按文档顺序。
 * @param selection - 当前选区。
 * @returns 图片节点。
 */
function $imagesInSelection(selection: RangeSelection | NodeSelection): ImageNode[] {
  const images = selection.getNodes().filter($isImageNode)
  return [...images].sort((left, right) => (left.isBefore(right) ? -1 : 1))
}

/**
 * 当前选区里的图片节点键。
 *
 * 折叠选区不算选中（光标贴着图片不等于选中它）。RangeSelection 用 `getNodes()`，它只包含真正
 * 落在选区里的节点；图片前后紧挨着的文字节点不会把图片带进来。
 * 必须在 Lexical 的编辑器上下文里调用。
 * @returns 节点键，按文档顺序。
 */
export function $selectedImageKeys(): NodeKey[] {
  const selection = $getSelection()
  if (selection === null) return []
  if ($isRangeSelection(selection)) {
    if (selection.isCollapsed()) return []
    return $imagesInSelection(selection).map(image => image.getKey())
  }
  if ($isNodeSelection(selection)) {
    return $imagesInSelection(selection).map(image => image.getKey())
  }
  return []
}

/**
 * 把选中属性写到图片宿主 DOM 上，并摘掉不再选中的。
 *
 * 只碰属性：不调用 `editor.update`，所以不会让文档变脏、不会触发自动保存。
 * @param editor - 编辑器。
 * @param editorState - 这次要读的编辑器状态。
 * @param applied - 上一次写过的节点键（本次会删掉不再选中的）。
 */
function syncSelected(editor: LexicalEditor, editorState: EditorState, applied: Set<NodeKey>): void {
  const next = new Set(editorState.read(() => $selectedImageKeys()))
  for (const key of [...applied]) {
    if (next.has(key)) continue
    editor.getElementByKey(key)?.removeAttribute(IMAGE_SELECTED_ATTRIBUTE)
    applied.delete(key)
  }
  for (const key of next) {
    const element = editor.getElementByKey(key)
    if (element === null) continue
    if (element.getAttribute(IMAGE_SELECTED_ATTRIBUTE) !== 'true') {
      element.setAttribute(IMAGE_SELECTED_ATTRIBUTE, 'true')
    }
    applied.add(key)
  }
}

/**
 * 节点在块里的位置：往外走到第一个不是 inline 的父元素（链接里的图片算链接的位置）。
 *
 * 图片可以套在链接里（徽章）。删掉这种图片后，空链接会被现有清理收掉，所以“图片原来的位置”要按
 * **块里的那个 inline 祖先**来算，而不是按会消失的链接内部偏移算。
 * @param node - 图片节点。
 * @returns 块与它在块里的下标；走不到块时答 null。
 */
function $blockPosition(node: LexicalNode): { block: ElementNode; offset: number } | null {
  let current: LexicalNode = node
  for (;;) {
    const parent = current.getParent()
    if (parent === null) return null
    if (!parent.isInline()) return { block: parent, offset: current.getIndexWithinParent() }
    current = parent
  }
}

/**
 * 把光标放到节点之前：优先落在前一个文字节点的末尾，否则落在块里节点（或它所在的链接）的下标上。
 * 必须在 Lexical 的编辑器上下文里调用。
 * @param node - 目标节点（图片）。
 */
function $caretBefore(node: LexicalNode): void {
  const previous = node.getPreviousSibling()
  if (previous !== null && $isTextNode(previous)) {
    const size = previous.getTextContentSize()
    previous.select(size, size)
    return
  }
  const position = $blockPosition(node)
  if (position === null) return
  position.block.select(position.offset, position.offset)
}

/**
 * 把光标放到节点之后：优先落在后一个文字节点的开头，否则落在块里节点（或它所在的链接）下标 +1。
 * 必须在 Lexical 的编辑器上下文里调用。
 * @param node - 目标节点（图片）。
 */
function $caretAfter(node: LexicalNode): void {
  const next = node.getNextSibling()
  if (next !== null && $isTextNode(next)) {
    next.select(0, 0)
    return
  }
  const position = $blockPosition(node)
  if (position === null) return
  position.block.select(position.offset + 1, position.offset + 1)
}

/**
 * 选区里是不是只有图片：把图片的 alt 拼起来与选区文字比。
 *
 * 实测：文字点跨过图片时选区文字正好等于图片 alt；前后紧挨的文字不会进选区；图片 alt 为空时两边
 * 都是空串。还选着文字时两边不等 —— 那种情况由本命令接着调 `deleteCharacter`。
 * @param selection - 当前范围选区。
 * @param images - 选区里的图片。
 * @returns 是否只选中了图片。
 */
function $onlyImages(selection: RangeSelection, images: readonly ImageNode[]): boolean {
  return selection.getTextContent() === images.map(image => image.getTextContent()).join('')
}

/**
 * 选中的图片：Delete 删掉，左右键把光标贴到两侧。
 *
 * Delete 的两种结局都只在这个命令里发生一次：图片由这里删，文字也由这里调 `deleteCharacter`；
 * 同一次按键、同一条撤销记录。
 * @param editor - 编辑器。
 * @returns 取消注册的函数。
 */
export function registerImageKeys(editor: LexicalEditor): () => void {
  const unregisterDelete = editor.registerCommand(
    DELETE_CHARACTER_COMMAND,
    isBackward => {
      if (!editor.isEditable()) return false
      const selection = $getSelection()
      if (!$isRangeSelection(selection) || selection.isCollapsed()) return false
      const images = $imagesInSelection(selection)
      if (images.length === 0) return false

      const only = $onlyImages(selection, images)
      const first = images[0]
      if (first === undefined) return false
      const previous = first.getPreviousSibling()
      const previousText = previous !== null && $isTextNode(previous) ? previous : null
      const position = $blockPosition(first)
      for (const image of images) image.remove()

      if (only) {
        if (previousText !== null && previousText.isAttached()) {
          const size = previousText.getTextContentSize()
          previousText.select(size, size)
        } else if (position !== null && position.block.isAttached()) {
          const offset = Math.min(position.offset, position.block.getChildrenSize())
          position.block.select(offset, offset)
        }
        return true
      }
      /*
       * 文字仍由同一次命令删：rich-text 的 Delete 处理做的也是这一句。放在这里而不是返回 false，
       * 是为了让“删图 + 删文字”落在同一个 update（一条撤销记录）里。
       */
      selection.deleteCharacter(isBackward)
      return true
    },
    COMMAND_PRIORITY_HIGH,
  )

  const unregisterLeft = editor.registerCommand(
    KEY_ARROW_LEFT_COMMAND,
    event => {
      if (!editor.isEditable()) return false
      if (event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) return false
      const selection = $getSelection()
      if (!$isRangeSelection(selection) || selection.isCollapsed()) return false
      const images = $imagesInSelection(selection)
      if (images.length === 0 || !$onlyImages(selection, images)) return false
      const first = images[0]
      if (first === undefined) return false
      event.preventDefault()
      $caretBefore(first)
      return true
    },
    COMMAND_PRIORITY_HIGH,
  )

  const unregisterRight = editor.registerCommand(
    KEY_ARROW_RIGHT_COMMAND,
    event => {
      if (!editor.isEditable()) return false
      if (event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) return false
      const selection = $getSelection()
      if (!$isRangeSelection(selection) || selection.isCollapsed()) return false
      const images = $imagesInSelection(selection)
      if (images.length === 0 || !$onlyImages(selection, images)) return false
      const last = images[images.length - 1]
      if (last === undefined) return false
      event.preventDefault()
      $caretAfter(last)
      return true
    },
    COMMAND_PRIORITY_HIGH,
  )

  return () => {
    unregisterDelete()
    unregisterLeft()
    unregisterRight()
  }
}

/**
 * 点一下图片就选中它（NodeSelection）。
 *
 * 只接管**不在链接里**的图片：带链接的图片（徽章）单击仍然走“打开链接”，要选中它请拖选。
 * 返回 true 是为了压住 rich-text 的 CLICK 处理 —— 它会在点击时清掉 NodeSelection。
 * @param editor - 编辑器。
 * @returns 取消注册的函数。
 */
export function registerImageClick(editor: LexicalEditor): () => void {
  return editor.registerCommand(
    CLICK_COMMAND,
    event => {
      if (event.button !== 0) return false
      if (event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) return false
      const target = event.target
      if (!(target instanceof Element)) return false
      const host = target.closest('.md-image-host')
      if (host === null) return false
      // A linked image keeps its existing click behaviour (open the link).
      if (host.closest('a') !== null) return false
      const node = $getNearestNodeFromDOMNode(host)
      if (node === null || !$isImageNode(node)) return false
      event.preventDefault()
      const selection = $createNodeSelection()
      selection.add(node.getKey())
      $setSelection(selection)
      return true
    },
    COMMAND_PRIORITY_HIGH,
  )
}

/**
 * 挂上选中属性、点击与按键：选中变化时同步 DOM，点图选中，按键删图 / 贴光标。
 * @param editor - 编辑器。
 * @returns 取消注册的函数。
 */
export function registerImageSelection(editor: LexicalEditor): () => void {
  const applied = new Set<NodeKey>()
  syncSelected(editor, editor.getEditorState(), applied)
  const unregisterSync = editor.registerUpdateListener(({ editorState }) => {
    syncSelected(editor, editorState, applied)
  })
  const unregisterClick = registerImageClick(editor)
  const unregisterKeys = registerImageKeys(editor)
  return () => {
    unregisterSync()
    unregisterClick()
    unregisterKeys()
  }
}

/**
 * Mount the image selection feature for as long as the editor lives.
 * @returns nothing rendered.
 */
export function ImageSelectionPlugin(): null {
  const [editor] = useLexicalComposerContext()
  useEffect(() => registerImageSelection(editor), [editor])
  return null
}
