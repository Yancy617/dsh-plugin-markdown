/**
 * 代码块横幅：语言与复制按钮，对齐官方 `CodeBlock` 的 card 头。
 *
 * 内容
 * - CodeChromePlugin / CopyCodeButton / PlacedBanner / sameBanners。
 * - COPY_LABEL / COPIED_LABEL / COPIED_MS。
 *
 * 行为
 * - 每个代码块一块横幅；位置＝节点元素的视口矩形减去横幅层自己的矩形，随正文一起滚动。
 * - 复制按钮走官方 `writeClipboard`；成功后图标换成勾、标签换成「复制成功」，1 秒后复原。
 * - 整层画在 contentEditable **之外**（`.md-root` 的绝对定位子元素）：不往 Lexical 的 DOM 里
 *   插任何节点，也不在编辑器更新回调里渲染。
 * - 编辑器更新 / 根尺寸变化 / 窗口 resize 之后在下一帧重量一次；量不出变化就不重渲染。
 *
 * 边界
 * - 不画代码本体、不做高亮（codeHighlight.tsx）、不改节点、不接管键盘。
 *
 * 相关文件
 * - 依赖：codeBlocks.ts（哪些块、横幅写什么）、primitives（Tooltip / writeClipboard / 两个图标）。
 * - 被依赖：MarkdownEditor.tsx。
 *
 * 改哪里
 * - 改文字：COPY_LABEL / COPIED_LABEL。
 * - 改几何：measure 与 EDITOR_CSS 里的 `.md-code-banner` / `.md-code-copy`。
 */
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import {
  IconCheckOutlineRegular,
  IconCopyOutlineRegular,
  Tooltip,
  writeClipboard,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { $isCodeNode } from '@lexical/code-core'
import { $getNodeByKey, $getRoot, type LexicalEditor } from 'lexical'
import { useEffect, useRef, useState, type ReactElement } from 'react'
import { codeBlockLabel, collectCodeBlocks, type CodeBlockInfo } from './codeBlocks'

/**
 * The two labels the official zh dictionary gives the copy control
 * (`common` namespace, read out of `app.asar`: `"copy": "复制"`, `"copied": "复制成功"`).
 */
const COPY_LABEL = '复制'
const COPIED_LABEL = '复制成功'

/** How long the confirmation shows, in ms — the official `CodeBlock`'s `1e3`. */
const COPIED_MS = 1000

/** One banner, already in the layer's coordinate space. */
interface PlacedBanner {
  /** The code node's key. */
  readonly key: string
  /** The language, or the fallback label. */
  readonly label: string
  /** Left edge, in px inside the layer. */
  readonly left: number
  /** Top edge, in px inside the layer. */
  readonly top: number
  /** The code element's own width, in px. */
  readonly width: number
}

/**
 * Whether two placements would draw the same thing.
 * @param a - current placements.
 * @param b - freshly measured ones.
 * @returns true when nothing moved, so the render can be skipped.
 */
function sameBanners(a: readonly PlacedBanner[], b: readonly PlacedBanner[]): boolean {
  if (a.length !== b.length) return false
  return a.every((banner, index) => {
    const other = b[index]
    return (
      other !== undefined &&
      banner.key === other.key &&
      banner.label === other.label &&
      banner.left === other.left &&
      banner.top === other.top &&
      banner.width === other.width
    )
  })
}

/**
 * The banner's copy control: the official icon button and its one-second
 * confirmation.
 * @param props - the owning editor and the code node to copy.
 * @returns the button, with its tooltip.
 */
function CopyCodeButton({
  editor,
  nodeKey,
}: {
  readonly editor: LexicalEditor
  readonly nodeKey: string
}): ReactElement {
  const [copied, setCopied] = useState(false)
  const timer = useRef<number | undefined>(undefined)

  useEffect(
    () => () => {
      if (timer.current !== undefined) window.clearTimeout(timer.current)
    },
    [],
  )

  const label = copied ? COPIED_LABEL : COPY_LABEL

  return (
    <Tooltip label={label} side="top" portal>
      <button
        type="button"
        className="md-code-copy"
        aria-label={label}
        onClick={() => {
          // The official control ignores a second click while the confirmation is up.
          if (copied) return
          const text = editor.getEditorState().read(() => {
            const node = $getNodeByKey(nodeKey)
            if (node === null || !$isCodeNode(node)) return ''
            const content = node.getTextContent()
            // The official `CodeBlock` trims exactly one trailing newline before copying.
            return content.endsWith('\n') ? content.slice(0, -1) : content
          })
          void writeClipboard(text).then(ok => {
            if (!ok) return
            setCopied(true)
            timer.current = window.setTimeout(() => {
              setCopied(false)
            }, COPIED_MS)
          })
        }}
      >
        {copied ? <IconCheckOutlineRegular size={14} /> : <IconCopyOutlineRegular size={14} />}
      </button>
    </Tooltip>
  )
}

/**
 * Draw one banner per code block, in a layer that sits beside the editable
 * surface rather than inside it.
 * @returns the layer; it is empty while the document has no code blocks.
 */
export function CodeChromePlugin(): ReactElement {
  const [editor] = useLexicalComposerContext()
  const layer = useRef<HTMLDivElement | null>(null)
  const [banners, setBanners] = useState<readonly PlacedBanner[]>([])

  useEffect(() => {
    let frame = 0

    const measure = (): void => {
      frame = 0
      const layerElement = layer.current
      if (layerElement === null) return
      const base = layerElement.getBoundingClientRect()
      const found: CodeBlockInfo[] = []
      editor.getEditorState().read(() => {
        collectCodeBlocks($getRoot(), found)
      })
      const next: PlacedBanner[] = []
      for (const info of found) {
        const element = editor.getElementByKey(info.key)
        if (element === null) continue
        const rect = element.getBoundingClientRect()
        next.push({
          key: info.key,
          label: codeBlockLabel(info.language),
          left: rect.left - base.left,
          top: rect.top - base.top,
          width: rect.width,
        })
      }
      setBanners(current => (sameBanners(current, next) ? current : next))
    }

    const schedule = (): void => {
      if (frame !== 0) return
      frame = window.requestAnimationFrame(measure)
    }

    measure()
    const unregister = editor.registerUpdateListener(schedule)
    const root = editor.getRootElement()
    const observer = new ResizeObserver(schedule)
    if (root !== null) observer.observe(root)
    window.addEventListener('resize', schedule)
    return () => {
      unregister()
      observer.disconnect()
      window.removeEventListener('resize', schedule)
      if (frame !== 0) window.cancelAnimationFrame(frame)
    }
  }, [editor])

  return (
    <div className="md-code-layer" ref={layer}>
      {banners.map(banner => (
        <div
          className="md-code-banner"
          key={banner.key}
          style={{ left: banner.left, top: banner.top, width: banner.width }}
        >
          <span className="md-code-lang">{banner.label}</span>
          <CopyCodeButton editor={editor} nodeKey={banner.key} />
        </div>
      ))}
    </div>
  )
}
