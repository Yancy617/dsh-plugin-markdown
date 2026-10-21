/**
 * `/` 菜单的图片入口：先问目的地，再放图片。
 *
 * 内容
 * - IMAGE_COMMAND_ICON / ACCEPT / ImagePathDialog。
 *
 * 行为
 * - 按地址插入：校验 → authoredInside → parseImageInside → $createImageNode；
 *   没有选区就接在最后一个块后面。
 * - 选择文件：读字节 → insertImage（POST asset），失败留在弹窗里说明原因。
 * - 写 Markdown，不写字节；不需要 host 路由就能按地址插入。
 *
 * 边界
 * - 不负责节点 / 拼写（image.tsx）与写入（imageInsert.ts）。
 * - 不负责粘贴截图（PasteMarkdownPlugin.tsx）。
 *
 * 相关文件
 * - 依赖：image、imageView、imageInsert、primitives、errors。
 * - 被依赖：SlashMenu.tsx / MarkdownEditor.tsx。
 *
 * 改哪里
 * - 改地址插入：insert。
 * - 改文件选择：upload。
 */
import { Button, FileTypeIcon, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  $createParagraphNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  type LexicalEditor,
} from 'lexical'
import { useEffect, useRef, useState, type JSX, type ReactNode } from 'react'
import { $createImageNode } from './image'
import { authoredInside, parseImageInside } from './imageSyntax'
import { useImageHost } from './imageView'
import { insertImage } from './imageInsert'
import { messageOf } from '../../shared/errors'

/** The slash menu's row glyph: the product's own file-type artwork for an image. */
export const IMAGE_COMMAND_ICON: ReactNode = <FileTypeIcon kind="image" size={16} />

/** What the picker accepts — the same set {@link imageExtension} stores. */
const ACCEPT = 'image/png,image/jpeg,image/gif,image/webp,image/bmp,image/svg+xml,image/avif'

/**
 * Ask for a destination and place an image at the caret.
 * @param props - the editor, and the dialog's open state.
 * @returns the dialog.
 */
export function ImagePathDialog({
  editor,
  open,
  onClose,
}: {
  readonly editor: LexicalEditor
  readonly open: boolean
  readonly onClose: () => void
}): JSX.Element {
  const [value, setValue] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const picker = useRef<HTMLInputElement>(null)
  const host = useImageHost()

  useEffect(() => {
    if (open) {
      setValue('')
      setProblem(null)
      setBusy(false)
    }
  }, [open])

  /** Validate what was typed and write the image where the caret is. */
  const insert = (): void => {
    const destination = value.trim()
    if (destination === '') {
      setProblem('请填一个路径或网址')
      return
    }
    const inside = authoredInside(destination)
    if (inside === null) {
      setProblem('路径里不能有 < 或 >')
      return
    }
    const target = parseImageInside(inside)
    if (target === null) {
      setProblem('这个写法不是一个图片目标')
      return
    }
    editor.update(() => {
      const image = $createImageNode('', target.destination, target.title)
      const selection = $getSelection()
      if ($isRangeSelection(selection)) {
        selection.insertNodes([image])
        return
      }
      // No caret to insert at — a dialog can outlive one. Appending keeps the click meaningful instead
      // of dropping what the writer just typed.
      const root = $getRoot()
      const last = root.getLastChild()
      if (last === null) {
        const paragraph = $createParagraphNode()
        paragraph.append(image)
        root.append(paragraph)
        return
      }
      last.insertAfter(image)
    })
    onClose()
    editor.focus()
  }

  /**
   * Store a file the writer picked and place it at the caret.
   *
   * The dialog stays open on failure and says why: the common failure is a host that has not been
   * restarted yet, and closing the dialog on it would leave the writer with nothing to read.
   * @param file - the chosen file.
   */
  const upload = (file: File): void => {
    setBusy(true)
    setProblem(null)
    void file
      .arrayBuffer()
      .then(buffer =>
        insertImage(
          editor,
          host,
          { bytes: new Uint8Array(buffer), mediaType: file.type, fileName: file.name },
          host.writeAsset,
        ),
      )
      .then(result => {
        setBusy(false)
        if ('failure' in result) {
          setProblem(result.failure)
          return
        }
        onClose()
        editor.focus()
      })
      .catch((error: unknown) => {
        setBusy(false)
        setProblem(`写入失败：${messageOf(error)}`)
      })
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="插入图片"
      closeLabel="关闭"
      description="选一个磁盘上的图片文件（存进仓库根的 .img），或者填一个已经在仓库里、或在网上的地址。"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button variant="outline" disabled={busy} onClick={() => picker.current?.click()}>
            {busy ? '正在写入…' : '选择文件…'}
          </Button>
          <Button variant="primary" disabled={busy} onClick={insert}>
            按地址插入
          </Button>
        </>
      }
    >
      <input
        ref={picker}
        type="file"
        accept={ACCEPT}
        style={{ display: 'none' }}
        onChange={event => {
          const file = event.target.files?.[0]
          // Cleared so choosing the same file twice in a row still fires a change.
          event.target.value = ''
          if (file !== undefined) upload(file)
        }}
      />
      <Input
        data-modal-autofocus
        value={value}
        placeholder=".img/时间戳-哈希.png 或 https://…"
        onChange={event => setValue(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Enter') {
            event.preventDefault()
            insert()
          }
        }}
      />
      <p className="md-image-hint">
        相对路径按当前笔记所在目录解析（与 DSH 自己的预览一致），所以子目录里的笔记要写
        {' ../.img/… '}这样的形式。选择文件会把它写进仓库根的 .img 并自动填好路径。
      </p>
      {problem === null ? null : <p className="md-image-problem">{problem}</p>}
    </Modal>
  )
}
