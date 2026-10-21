/**
 * 粘贴：自有 Markdown 优先，其次图片 / HTML / 纯文本。
 *
 * 内容
 * - PasteMarkdownPlugin / pictureFromClipboard / $selectionFromDom。
 * - __BUILD_STAMP__（构建时间戳）。
 *
 * 行为
 * - PASTE_COMMAND 高优先级：图片文件走 insertImage。
 * - 剪贴板带 `application/x-dsh-markdown`（本插件自己复制的）时，只按它解析，忽略 HTML。
 * - 否则文本走 documentMarkdown 的 $pastedMarkdownNodes（mdastLower），与打开文档同一条映射。
 * - 同时有 HTML 时，只在 HTML 导出的 Markdown 与 text/plain 不同才让给内置；判据在 pasteFlavor.ts。
 * - 没有 Lexical 选区时从 DOM 重建，避免内置处理器把原文直接插进 contenteditable。
 * - onReport 每次粘贴报一行发生了什么。
 *
 * 边界
 * - 不负责 HTML 比较规则（pasteFlavor.ts）、复制（clipboardMarkdown.ts）与图片写入（imageInsert.ts）。
 *
 * 相关文件
 * - 依赖：documentMarkdown、pasteFlavor、clipboardMarkdown（MIME）、imageView、imageInsert、errors。
 * - 被依赖：MarkdownEditor.tsx。
 *
 * 改哪里
 * - 改分派：PASTE_COMMAND 处理。
 * - 改图片：pictureFromClipboard。
 * - 改选区恢复：$selectionFromDom。
 */
import { $insertGeneratedNodes } from '@lexical/clipboard'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import {
  $createRangeSelection,
  $getSelection,
  $isRangeSelection,
  $setSelection,
  COMMAND_PRIORITY_HIGH,
  PASTE_COMMAND,
  type LexicalEditor,
  type RangeSelection,
} from 'lexical'
import { useEffect } from 'react'
import { $pastedMarkdownNodes } from './documentMarkdown'
import { useImageHost } from './imageView'
import { insertImage } from './imageInsert'
import { $htmlFlavorAsMarkdown } from './htmlMarkdown'
import { pasteFlavor } from './pasteFlavor'
import { MARKDOWN_MIME } from './clipboardMarkdown'
import { messageOf } from '../../shared/errors'

/**
 * Build timestamp, injected by `tsdown.config.ts`.
 *
 * Reported with every paste so a running page can state which bundle it
 * loaded. Without it a stale bundle and a broken handler look exactly alike,
 * which is a distinction that has already cost several rounds here.
 */
declare const __BUILD_STAMP__: string

/** One picture read out of a clipboard event, before its bytes are read. */
interface ClipboardPicture {
  /** The file the clipboard handed over; its bytes are read asynchronously. */
  readonly blob: Blob
  /** The browser's media type for it. */
  readonly mediaType: string
  /** The name the clipboard carried, which is often empty. */
  readonly name: string
}

/**
 * The picture a clipboard event carries, when it carries one.
 *
 * `files` is checked before `items` because a file entry carries its name, and the name is what the
 * alt text is made from when there is one. Synchronous by necessity: the paste command's answer
 * decides whether the browser's own handler runs, and that answer cannot wait for a promise.
 * @param data - the clipboard payload.
 * @returns the picture, or `null` for a clipboard with no image in it.
 */
function pictureFromClipboard(data: DataTransfer): ClipboardPicture | null {
  for (const file of Array.from(data.files)) {
    if (file.type.startsWith('image/')) {
      return { blob: file, mediaType: file.type, name: file.name }
    }
  }
  for (const item of Array.from(data.items)) {
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const file = item.getAsFile()
      if (file !== null) return { blob: file, mediaType: file.type, name: file.name }
    }
  }
  return null
}

/**
 * Rebuild a selection from the DOM when Lexical is holding none.
 *
 * Lexical only learns about a caret by observing `selectionchange`. After this
 * panel is remounted — which the keyed `main` slot does on every switch to the
 * conversation and back — the browser restores the caret without Lexical
 * noticing, so its editor state has no selection while the DOM plainly has one.
 *
 * Both this handler and Lexical's built-in paste handler require a
 * `RangeSelection`, so both decline, and the browser's own paste then drops the
 * raw Markdown straight into the contenteditable — which is why a copied answer
 * arrived as literal `#` and `|` characters.
 * @param editor - the editor whose root bounds the range.
 * @returns a selection, or `null` when the DOM caret is not inside the editor.
 */
function $selectionFromDom(editor: LexicalEditor): RangeSelection | null {
  const dom = window.getSelection()
  if (dom === null || dom.rangeCount === 0) return null
  const root = editor.getRootElement()
  if (root === null) return null
  const range = dom.getRangeAt(0)
  if (!root.contains(range.startContainer)) return null
  const selection = $createRangeSelection()
  selection.applyDOMRange(range)
  return selection
}

/**
 * Install the Markdown-aware paste handler.
 * @param props - `onReport` receives one line describing what the handler saw.
 * @returns nothing; the plugin renders no DOM.
 */
export function PasteMarkdownPlugin({
  onReport,
}: {
  /**
   * Called once per paste with what actually happened. Pasting is otherwise
   * invisible — the handler either runs or silently defers to the built-in —
   * and "the table looks like the source" cannot distinguish a stale bundle
   * from a clipboard that also carried HTML.
   */
  onReport?: (message: string) => void
} = {}): null {
  const [editor] = useLexicalComposerContext()
  // Read outside the command listener so the listener's dependency list stays the two names it had; the
  // host is a value per render, and a paste handler that captured a stale one would write a picture into
  // the previous note.
  const host = useImageHost()

  useEffect(
    () =>
      editor.registerCommand(
        PASTE_COMMAND,
        event => {
          /** Report and decline, so the built-in handler keeps the paste. */
          const defer = (reason: string): false => {
            onReport?.(`粘贴：交给默认处理（${reason}）`)
            return false
          }

          // The command carries a union: a paste can also arrive as an
          // `InputEvent` or a `KeyboardEvent`, and only a clipboard event
          // carries data. `in` narrows without relying on `instanceof`, which
          // is realm-sensitive.
          if (!('clipboardData' in event)) return defer('事件不带剪贴板')
          const data = event.clipboardData
          if (data === null) return defer('剪贴板为空')

          // Our own copy writes Markdown under a private type and deliberately writes no Lexical
          // JSON. When it is present it wins over HTML and text/plain: it is the only form that
          // keeps definitions, hard breaks and table alignment across a copy.
          const own = data.getData(MARKDOWN_MIME)
          const html = own === '' ? data.getData('text/html') : ''
          const raw = own === '' ? data.getData('text/plain') : own
          const kinds = Array.from(data.types).join('+') || '(无类型)'

          // **An image, before anything else.** This has to be asked first, and the reason is not
          // ordering taste: a picture copied from a web page arrives with `text/html` (an `<img>` tag)
          // as well as the file, and a screenshot from a capture tool arrives with only `Files` and no
          // text at all. The two branches below decline in exactly those two cases, so an image paste
          // would fall through to the browser's own handler, which drops an image without a word.
          //
          // The write is asynchronous and a command handler is not, so the paste is claimed here and
          // the picture appears when the bytes land. A failure reports the reason rather than
          // pretending the paste never happened.
          const picture = pictureFromClipboard(data)
          if (picture !== null) {
            event.preventDefault()
            const { documentPath, vaultRoot, writeAsset } = host
            onReport?.(
              `粘贴：图片 ${picture.name === '' ? '(无名)' : picture.name}（${picture.mediaType}），正在写入…`,
            )
            void picture.blob
              .arrayBuffer()
              .then(buffer =>
                insertImage(
                  editor,
                  { documentPath, vaultRoot },
                  {
                    bytes: new Uint8Array(buffer),
                    mediaType: picture.mediaType,
                    fileName: picture.name,
                  },
                  writeAsset,
                ),
              )
              .then(
                result => {
                  onReport?.(
                    'failure' in result
                      ? `粘贴：图片未写入（${result.failure}）`
                      : `粘贴：图片已写入 ${result.name}，正文写 ${result.destination}`,
                  )
                },
                error => {
                  onReport?.(`粘贴：图片未写入（${messageOf(error)}）`)
                },
              )
            return true
          }

          // 只有纯文本时（DSH 对话的复制按钮就写这一种）没有第二种说法要问，直接用。两种都在
          // 时才要问"哪一种说了算"，而那个问题要 Lexical 上下文才量得出来（见下面的 `apply`）。
          if (raw.trim() === '') return defer(`text/plain 为空，类型=${kinds}`)

          // Normalize line endings.
          //
          // The source was written with `\n`, but the Windows clipboard hands it
          // back with `\r\n` — and Lexical's `normalizeMarkdown` splits on `\n`
          // alone, so each line keeps a trailing `\r`. That silently broke every
          // table (see `TABLE_ROW`) and left a `\r` inside paragraph text.
          // Undoing the clipboard's conversion here is exact, because the
          // conversion is the only thing that happened.
          const text = raw.replace(/\r\n?/g, '\n')

          // The work runs **directly**, not inside `editor.update`.
          //
          // A command listener is dispatched from inside an update context, and
          // `updateEditor` only queues when that is so:
          //
          //     if (editor._updating) editor._updates.push([updateFn, options])
          //
          // Wrapping this in `editor.update()` would make the callback
          // was queued and never ran before the handler returned, and so the
          // handler reported its own default message and inserted nothing. The
          // selection this needs is already on the active editor state, which is
          // exactly why Lexical's own paste handler reads `$getSelection()` with
          // no `update` around it either.
          //
          // The fallback covers a dispatch that arrives outside any update.
          // Measurements, and separately the one sentence a writer is shown when the
          // paste does not land. Two variables rather than one array, because the two
          // answer different questions and have different readers: `notes` explains a
          // paste to whoever is debugging it, `reason` tells the person who pasted
          // what went wrong.
          const notes: string[] = []
          let reason: string | null = null
          let thrown: string | null = null
          let inserted = false
          // 让给内置的理由。**与 `reason` 分开**：`reason` 是"这篇没插进去、为什么"（要说给粘贴的人
          // 听），这一条是"这一次本来就不该由我们插"（正常结果，不是失败）。它只能在 `apply` 里定，
          // 因为两种形态谁说了算要 Lexical 上下文才量得出来。
          let handOff: string | null = null

          const apply = (): void => {
            let selection = $getSelection()
            if (!$isRangeSelection(selection)) {
              const recovered = $selectionFromDom(editor)
              if (recovered === null) {
                // Name exactly what was found: a null selection, a
                // NodeSelection, and a caret outside this editor have
                // different fixes.
                const dom = window.getSelection()
                const domState =
                  dom === null || dom.rangeCount === 0
                    ? 'DOM无选区'
                    : dom.isCollapsed
                      ? 'DOM有折叠光标'
                      : 'DOM有非折叠选区'
                const active = document.activeElement
                const editable = (active as HTMLElement | null)?.isContentEditable === true
                const where =
                  active === null ? '无' : `${active.tagName}${editable ? '(可编辑)' : ''}`
                const kind =
                  selection === null
                    ? 'null'
                    : ((selection as unknown as { constructor?: { name?: string } }).constructor
                        ?.name ?? '未知')
                notes.push(`无可用选区（选区=${kind}，${domState}，活动元素=${where}）`)
                reason = '编辑器里没有可插入的位置'
                return
              }
              // Publish it so the rest of the update sees one selection.
              $setSelection(recovered)
              selection = recovered
              notes.push('已从 DOM 恢复选区')
            }
            // 两种形态都在时才问谁说了算：HTML 要**读出来**才能回答（`$generateNodesFromDOM`
            // 要 Lexical 上下文，所以这一段在 `apply` 里而不在命令处理的前半段）。
            if (html.trim() !== '') {
              let htmlAsMarkdown: string | null = null
              try {
                htmlAsMarkdown = $htmlFlavorAsMarkdown(html)
              } catch (error) {
                // 读不出来就让给内置：宁可粘成原样，也不许在这里抛。
                // 不能把空串当成结果交给判据 —— 判据把“HTML 什么都没说”读作“按纯文本解析”，
                // 那正好是这次读失败的反面。
                notes.push(`HTML 形态读不出来（${messageOf(error)}），照老规则让给内置`)
              }
              if (htmlAsMarkdown === null) {
                handOff = `含 text/html(${html.length} 字符)，读不出它说了什么`
                return
              }
              const flavor = pasteFlavor({ html, text, htmlAsMarkdown })
              notes.push(
                `HTML 形态导成 Markdown=${JSON.stringify(htmlAsMarkdown)}，判据=${flavor}`,
              )
              if (flavor === 'html') {
                handOff = `含 text/html(${html.length} 字符)，它说了纯文本没说的东西`
                return
              }
            }
            // 与打开文档同一条读法（`./documentMarkdown.ts` 的第三个入口），只是节点交给选区。
            const nodes = $pastedMarkdownNodes(text)
            if (nodes.length === 0) {
              notes.push('解析出 0 个节点')
              reason = '这段内容解析不出可插入的结构'
              return
            }
            $insertGeneratedNodes(editor, nodes, selection)
            inserted = true
            notes.push(
              `解析出 ${nodes.length} 个节点：${nodes.map(node => node.getType()).join(', ')}`,
            )
          }

          try {
            apply()
          } catch (error) {
            // No active editor context — run it inside an explicit update. Keep
            // whatever the first attempt recorded as the cause.
            thrown = error instanceof Error ? error.message : String(error)
            try {
              editor.update(() => {
                thrown = null
                notes.length = 0
                reason = null
                handOff = null
                apply()
              })
            } catch (fallbackError) {
              thrown = `${thrown} → ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`
            }
          }

          // What did the clipboard actually carry?
          //
          // Counted after normalization; testing the raw text
          // with a `$`-anchored pattern while the clipboard was still CRLF, and
          // reported "0 table rows" for a clipboard that was full of them — a
          // fault in the diagnostic that sent this investigation the wrong way
          // for several rounds. Diagnostics have to be as carefully built as the
          // thing they measure.
          const textLines = text.split('\n')
          const tableish = textLines.filter(line => /^[ \t]*\|.*\|[ \t]*$/.test(line)).length
          notes.push(
            `剪贴板 ${raw.length} 字符 / ${textLines.length} 行，表格形状的行 ${tableish} 行`,
          )

          const outcome = notes.join('；')

          // The notice says what happened; the measurements go to the console.
          //
          // They are worth keeping — the transformer census and the clipboard census
          // are what explain a paste that produced paragraphs where a table was
          // expected, and neither is visible from the outside — but they are not
          // something a writer should have to read past to find out whether their
          // paste landed. The build stamp goes with them: it answers "is this page
          // running the bundle I just built", which is a question about the build and
          // not about the paste, and in the middle of a receipt it was noise to
          // everyone who was not already chasing a stale one.
          console.info(
            `[markdown] 粘贴：inserted=${String(inserted)} 类型=${kinds} text/plain=${String(text.length)} 字符 构建=${__BUILD_STAMP__}\n${outcome}`,
          )

          // 让给内置：**不是失败**，内置那条路（`text/html` 优先）接着处理这次粘贴。
          if (handOff !== null) return defer(handOff)

          // Returning true stops the built-in handler, but it also called
          // `preventDefault` itself — so the browser's own paste must be
          // suppressed here or the text lands twice.
          if (!inserted) {
            onReport?.(`粘贴：未插入（${thrown ?? reason ?? '原因未知'}）`)
            return false
          }
          event.preventDefault()
          onReport?.('粘贴：已按 Markdown 解析为正文')
          return true
        },
        // The built-in handler sits at `COMMAND_PRIORITY_EDITOR` (0), so this
        // outranks it regardless of which plugin mounted first.
        COMMAND_PRIORITY_HIGH,
      ),
    [editor, host, onReport],
  )

  return null
}
