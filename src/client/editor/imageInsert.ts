/**
 * 把一张图片放进仓库：一个名字、一次写入、一个节点。
 *
 * 内容
 * - EXTENSIONS / imageExtension / contentHash / assetName / altFromName。
 * - ImageInsertContext / ImageInsertResult / assetFailureLine / insertImage。
 *
 * 行为
 * - 名字：本地时间戳 + 内容哈希，字符集 [0-9a-z-]；重名时主机拒绝，换后缀重试。
 * - 目的地相对文档；文件夹是仓库根的 .img。
 * - 写入走调用方给的 AssetWriter（工作台注入），编辑器自己不认路由。
 * - 失败映射成人话：路由未生效 / 同名 / 其他。
 *
 * 边界
 * - 不负责拼写与地址规则（image.tsx / imagePath.ts）。
 * - 不负责选择文件 / 弹窗（ImageDialog.tsx）。
 * - 不负责 HTTP（assetWriter.ts 的端口，实现由工作台给）。
 *
 * 相关文件
 * - 依赖：assetWriter.ts（端口）、image、imagePath、protocol、errors。
 * - 被依赖：ImageDialog.tsx、PasteMarkdownPlugin.tsx。
 *
 * 改哪里
 * - 改命名：assetName / contentHash / altFromName。
 * - 改写入：insertImage。
 * - 改失败文案：assetFailureLine。
 */
import { $getRoot, $getSelection, $isRangeSelection, type LexicalEditor } from 'lexical'
import { MAX_ASSET_BYTES } from '../../shared/protocol'
import { messageOf } from '../../shared/errors'
import type { AssetWriter } from './assetWriter'
import { $createImageNode } from './image'
import { assetPath, relativeDestination } from './imagePath'

/** Media types this plugin will store, and the extension each is written as. */
const EXTENSIONS: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
  'image/avif': 'avif',
}

/**
 * The extension for one media type.
 * @param mediaType - the browser's reported type, parameters included.
 * @returns the extension without its dot, or `null` when this is not a picture we store.
 */
export function imageExtension(mediaType: string): string | null {
  const bare = mediaType.split(';')[0]?.trim().toLowerCase() ?? ''
  return EXTENSIONS[bare] ?? null
}

/**
 * A short content hash, used only to keep names apart.
 *
 * `crypto.subtle` is preferred and is available on the Web GUI's loopback origin,
 * but a Desktop shell serving the page from `dsh-app://` has no such guarantee —
 * and a name is not a security boundary, so the fallback is a plain 64-bit
 * FNV-1a. A collision is **not** dangerous in either case: the host refuses a name
 * that exists, so the worst outcome is one retry.
 * @param bytes - the file's content.
 * @returns twelve hexadecimal characters.
 */
export async function contentHash(bytes: Uint8Array): Promise<string> {
  const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle
  if (subtle !== undefined) {
    try {
      const digest = await subtle.digest('SHA-256', bytes as unknown as ArrayBuffer)
      return [...new Uint8Array(digest)]
        .map(byte => byte.toString(16).padStart(2, '0'))
        .join('')
        .slice(0, 12)
    } catch {
      // Fall through: a digest that cannot be computed is not a reason to refuse
      // the picture.
    }
  }
  let hash = 0xcbf29ce484222325n
  for (const byte of bytes) {
    hash ^= BigInt(byte)
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn
  }
  return hash.toString(16).padStart(16, '0').slice(0, 12)
}

/**
 * The file name one picture is stored under.
 * @param bytes - the file's content.
 * @param extension - extension without its dot.
 * @param at - the moment to stamp; a parameter so the scheme can be read in a test.
 * @returns a name matching `[0-9]{8}-[0-9]{6}-[0-9a-f]{12}.<extension>`.
 */
export async function assetName(
  bytes: Uint8Array,
  extension: string,
  at: Date = new Date(),
): Promise<string> {
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0')
  const stamp =
    `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}` +
    `-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`
  return `${stamp}-${await contentHash(bytes)}.${extension}`
}

/**
 * A name to show and to write into `alt`.
 * @param file - the file the writer chose or pasted.
 * @returns the file's name without its extension, or `''` when it has none.
 */
export function altFromName(fileName: string): string {
  const base = fileName.replace(/^.*[/\\]/, '').replace(/\.[^.]*$/, '')
  // A bare `image` or `未命名` is what half the clipboard hands over and says
  // nothing; sanitizing keeps the alt a single line of Markdown-safe text without
  // inventing meaning that is not there.
  return base.replace(/[\s()<>[\]`*_~\\]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)
}

/** What the caller must know to place a picture in one document. */
export interface ImageInsertContext {
  /** Absolute path of the note being edited. */
  readonly documentPath: string | null
  /** The authorized vault root. */
  readonly vaultRoot: string | null
}

/** One finished insert: the destination written, and the name it was given. */
export interface ImageInsertResult {
  /** The Markdown destination written into the note. */
  readonly destination: string
  /** The file name the picture was stored under. */
  readonly name: string
}

/** The parts of a write failure this module classifies, read structurally. */
interface FailureShape {
  readonly status?: number
  readonly code?: string
  readonly message: string
}

/**
 * Read the failure shape a writer's rejection carries.
 *
 * Structural rather than `instanceof VaultRequestError`: the editor owns no route client, and the
 * only fields that decide the sentence below are `status` / `code` / `message`.
 * @param error - whatever the write threw.
 * @returns the fields that exist, plus a message.
 */
function failureShape(error: unknown): FailureShape {
  if (typeof error === 'object' && error !== null) {
    const record = error as { readonly status?: unknown; readonly code?: unknown; readonly message?: unknown }
    return {
      ...(typeof record.status === 'number' ? { status: record.status } : {}),
      ...(typeof record.code === 'string' ? { code: record.code } : {}),
      message: typeof record.message === 'string' ? record.message : messageOf(error),
    }
  }
  return { message: messageOf(error) }
}

/**
 * Turn a failure into the line the writer sees.
 *
 * The route is new, and Host code only takes effect after DSH restarts — so "the
 * route is not there yet" is the one failure that is certain to happen to
 * somebody, and it has an answer that no other message gives: restart once.
 * @param error - whatever the write threw.
 * @returns one line, ready for the status area.
 */
export function assetFailureLine(error: unknown): string {
  const failure = failureShape(error)
  // An unregistered route falls through to the harness's own fallback, which
  // answers 404 with an empty body — hence both shapes.
  if (failure.status === 404 || failure.code === 'bad-response') {
    return '这条路由还没生效：需要重启一次 DSH 才能写入图片'
  }
  if (failure.status === 409) return '同名文件已存在'
  return `写入失败：${failure.message}`
}

/**
 * Store one picture in the vault and place it at the caret.
 *
 * The name is retried rather than reused on a collision: the host refuses a path
 * that exists, and two pictures of the same content within the same second are
 * the only way to reach that, so a counter suffix is enough and stays inside the
 * same character set.
 * @param editor - the live editor.
 * @param context - the note and vault the picture belongs to.
 * @param input - the picture's bytes, media type, and original file name.
 * @param write - the panel's asset writer, or `null` when this mount has none (a probe).
 * @returns what was written, or the line explaining why nothing was.
 */
export async function insertImage(
  editor: LexicalEditor,
  context: ImageInsertContext,
  input: { readonly bytes: Uint8Array; readonly mediaType: string; readonly fileName: string },
  write: AssetWriter | null,
): Promise<ImageInsertResult | { readonly failure: string }> {
  const extension = imageExtension(input.mediaType)
  if (extension === null) {
    return { failure: `不支持的图片格式：${input.mediaType || '(未知)'}` }
  }
  if (input.bytes.byteLength === 0) return { failure: '这个文件是空的' }
  if (input.bytes.byteLength > MAX_ASSET_BYTES) {
    return { failure: `图片超过上限（${Math.round(MAX_ASSET_BYTES / 1024 / 1024)} MB）` }
  }
  if (context.vaultRoot === null || context.documentPath === null) {
    return { failure: '先打开一篇笔记并关联一个仓库' }
  }
  if (write === null) return { failure: '当前视图没有图片写入通道' }

  const name = await assetName(input.bytes, extension)
  let written: string | null = null
  for (let attempt = 0; attempt < 5 && written === null; attempt += 1) {
    const candidate = attempt === 0 ? name : name.replace(/(-[0-9a-f]{12})\./, `$1-${attempt + 1}.`)
    try {
      const result = await write(assetPath(context.vaultRoot, candidate), input.bytes)
      written = result.path
    } catch (error) {
      if (failureShape(error).status === 409) continue
      return { failure: assetFailureLine(error) }
    }
  }
  if (written === null) return { failure: '同名文件太多，换一次时间戳再试' }

  const inside = relativeDestination(context.documentPath, written)
  const alt = altFromName(input.fileName)
  editor.update(() => {
    const image = $createImageNode(alt, inside, null)
    const selection = $getSelection()
    if ($isRangeSelection(selection)) {
      selection.insertNodes([image])
      return
    }
    // A paste can arrive with no caret of its own — the writer may have been in
    // another panel. Appending keeps the picture instead of losing it.
    $getRoot().append(image)
  })
  return { destination: inside, name: written.split(/[/\\]+/).pop() ?? written }
}
