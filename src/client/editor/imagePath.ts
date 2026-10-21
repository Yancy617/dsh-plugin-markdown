/**
 * 图片地址的两个方向：目的地 → 可加载地址，绝对路径 → 写进笔记的目的地。
 *
 * 内容
 * - IMAGE_FOLDER / MEDIA_SCHEME / OTHER_SCHEME / DRIVE。
 * - DestinationTarget / resolveDestination / imageDisplayUrl / fileUrl。
 * - 私有的 normalizePath / isAbsolutePath / directoryOf / unescapeDestination。
 * - bundledTarget / bundledImageUrl（示例仓库）。
 * - relativeDestination / assetPath。
 *
 * 行为
 * - 读：去 query / fragment → decode 一次 → drive letter 是路径、其他 scheme 是 scheme
 *   → 拒绝 UNC → 相对地址按文档目录解析。
 * - 写：绝对路径 → 相对文档的目的地；`.img` 在仓库根下。
 * - 示例仓库：不碰磁盘，相对目的地按包内资源表。
 * - 两方向共用同一套判据，只有这一份。
 *
 * 边界
 * - 不负责节点拼写（image.tsx）与显示（imageView.tsx）。
 * - 不负责写文件（imageInsert.ts / host）。
 *
 * 相关文件
 * - 依赖：shared/paths、shared/protocol。
 * - 被依赖：image、imageInsert、imageRelink、imageView、MarkdownWorkbench。
 *
 * 改哪里
 * - 改解析：resolveDestination。
 * - 改 URL：imageDisplayUrl / fileUrl。
 * - 改写回：relativeDestination / assetPath。
 */
import { childPath } from '../../shared/paths'
import { VaultRoute } from '../../shared/protocol'

/**
 * The one folder images are stored in, directly under the vault's own root.
 *
 * A writer decides where their vault is; this folder is the vault's, not a note's, so a note keeps
 * its pictures when it moves inside the vault and one place holds every image. It is **not** hidden
 * on disk — a writer who deletes it owns that decision — but the file tree leaves it out, because it
 * is material rather than notes.
 */
export const IMAGE_FOLDER = '.img'

/** Schemes an authored destination may name directly. */
const MEDIA_SCHEME = /^(?:https?|data|blob):/i

/** A scheme that is not a drive letter — the platform refuses these, so this does too. */
const OTHER_SCHEME = /^[a-z][a-z\d+.-]*:/i

/** A Windows drive letter, which is a path rather than a scheme. */
const DRIVE = /^[a-z]:[/\\]/i

/**
 * What one authored destination names, once the read rules have been applied.
 *
 * Three outcomes rather than a path-or-nothing pair, because the rules produce
 * three: a file this host can serve, an address that is its own target (`https:`,
 * `data:`, `blob:`), and a destination that cannot be shown at all. The caller that
 * only wants the file — re-spelling a document's own destinations when it moves —
 * reads the first case and ignores the rest, which is exactly what the type says.
 */
export type DestinationTarget =
  | { readonly kind: 'local'; readonly path: string }
  | { readonly kind: 'remote'; readonly url: string }
  | { readonly kind: 'refused' }

/**
 * Resolve one authored destination to the thing it names.
 *
 * Every rule the display side applies, and the only place they are written: a query
 * or fragment is not part of a filename and is dropped, the remainder is decoded
 * once, a drive letter is a path while any other scheme is a scheme, a relative
 * destination resolves beside the document being edited, and a UNC destination is
 * refused (the file route refuses those too).
 *
 * Split out of {@link imageDisplayUrl} when a second reader appeared — the move
 * operation has to know which absolute file a destination names so it can spell it
 * again from the new directory. Two callers, one rule.
 * @param documentPath - absolute path of the document being edited, when known.
 * @param destination - authored destination, exactly as written in the file.
 * @returns what it names, and why when it names nothing showable.
 */
export function resolveDestination(
  documentPath: string | null,
  destination: string,
): DestinationTarget {
  const cut = destination.search(/[?#]/)
  let path: string
  try {
    path = decodeURIComponent(cut === -1 ? destination : destination.slice(0, cut))
  } catch {
    // A stray `%` is not a filename component either; the platform returns here as well, and the
    // author sees their alt text.
    return { kind: 'refused' }
  }
  if (path === '') return { kind: 'refused' }
  if (MEDIA_SCHEME.test(path)) return { kind: 'remote', url: path }
  if (!DRIVE.test(path) && OTHER_SCHEME.test(path)) return { kind: 'refused' }
  if (path.startsWith('\\\\') || path.startsWith('//')) return { kind: 'refused' }

  if (!isAbsolutePath(path)) {
    if (documentPath === null) return { kind: 'refused' }
    path = directoryOf(documentPath) + path
  }
  return { kind: 'local', path: normalizePath(path) }
}

/**
 * The URL an `<img>` can load for one authored destination.
 *
 * The rules are the platform's, read out of its own client rather than invented, and they live in
 * {@link resolveDestination} — this function is the last step, which turns the file it names into a
 * URL the page can fetch.
 * @param documentPath - absolute path of the document being edited, when known.
 * @param destination - authored destination, exactly as written in the file.
 * @param baseUri - the page's base URI; `document.baseURI` in the browser.
 * @param bundled - whether the document is one of the plugin's own samples. Defaults to `false`,
 * which is what every caller editing a directory the writer authorized means.
 * @returns a displayable URL, or `null` when this destination cannot be shown.
 */
export function imageDisplayUrl(
  documentPath: string | null,
  destination: string,
  baseUri: string,
  bundled = false,
): string | null {
  if (bundled) return bundledImageUrl(destination, baseUri)
  const target = resolveDestination(documentPath, destination)
  if (target.kind === 'refused') return null
  if (target.kind === 'remote') return target.url
  return fileUrl(target.path, baseUri)
}

/**
 * What a bundled sample's destination names.
 *
 * Two cases, because the sample vault has no disk: an address the page loads on its own, and a
 * relative spelling of one of the package's own pictures. Absolute paths, UNC paths and other
 * schemes are refused rather than resolved — there is nothing behind `sample:示例` for them to
 * name, and refusing keeps this side from inventing a path the host would then look up in vain.
 */
type BundledTarget =
  | { readonly kind: 'remote'; readonly url: string }
  | { readonly kind: 'asset'; readonly name: string }
  | { readonly kind: 'refused' }

/**
 * Read one authored destination under the sample vault's rules.
 *
 * The cut, decode and scheme rules are {@link resolveDestination}'s, deliberately in the same
 * order: a writer's own vault and the samples are the same Markdown, so "what does this
 * destination say" may only be answered once. What differs is the last step — a relative
 * destination is not resolved beside the document, because the document is not on a disk.
 * @param destination - authored destination, exactly as written in the sample document.
 * @returns what it names.
 */
function bundledTarget(destination: string): BundledTarget {
  const cut = destination.search(/[?#]/)
  let name: string
  try {
    name = decodeURIComponent(cut === -1 ? destination : destination.slice(0, cut))
  } catch {
    return { kind: 'refused' }
  }
  if (name === '') return { kind: 'refused' }
  if (MEDIA_SCHEME.test(name)) return { kind: 'remote', url: name }
  if (!DRIVE.test(name) && OTHER_SCHEME.test(name)) return { kind: 'refused' }
  if (isAbsolutePath(name) || name.startsWith('\\\\') || name.startsWith('//')) {
    return { kind: 'refused' }
  }
  return { kind: 'asset', name }
}

/**
 * The URL one bundled picture is served from.
 * @param destination - authored destination, exactly as written in the sample document.
 * @param baseUri - the page's base URI.
 * @returns a displayable URL, or `null` when the samples cannot serve it.
 */
function bundledImageUrl(destination: string, baseUri: string): string | null {
  const target = bundledTarget(destination)
  if (target.kind === 'refused') return null
  if (target.kind === 'remote') return target.url
  if (!pageCanLoad(baseUri)) return null
  return new URL(`${VaultRoute.sampleAsset}?name=${encodeURIComponent(target.name)}`, baseUri).href
}

/**
 * The URL the platform's file route serves one absolute path from.
 * @param path - an absolute path this host can read.
 * @param baseUri - the page's base URI.
 * @returns a displayable URL, or `null` when the page cannot reach that route.
 */
function fileUrl(path: string, baseUri: string): string | null {
  if (!pageCanLoad(baseUri)) return null
  return new URL(`api/file?path=${encodeURIComponent(path)}`, baseUri).href
}

/**
 * Whether this page is served by something that also serves the plugin's routes.
 *
 * The route exists on the HTTP server and under the Desktop shell's own application scheme; the
 * same expression the platform's clients use produces the right one in both. Anything else (a
 * `file:` page, or a probe running without a server) has nowhere to fetch a picture from.
 * @param baseUri - the page's base URI.
 * @returns whether a picture URL can be built at all.
 */
function pageCanLoad(baseUri: string): boolean {
  return /^https?:/i.test(baseUri) || baseUri.startsWith('dsh-app://app/')
}

/**
 * A destination for one file inside the vault, spelled relative to the note.
 *
 * The result is what a writer would have typed: `.img/x.png` for a note at the vault's root,
 * `../.img/x.png` one level down. Returned with `/` separators, because that is what a Markdown
 * destination is — the host's own separator rules apply to paths it resolves, not to the text of a
 * note.
 * @param notePath - absolute path of the note the destination is written into.
 * @param target - absolute path of the file being referenced.
 * @returns the relative destination.
 */
export function relativeDestination(notePath: string, target: string): string {
  const parts = (path: string): string[] => path.split(/[/\\]+/).filter(part => part !== '')
  const noteDir = parts(notePath).slice(0, -1)
  const targetParts = parts(target)
  let shared = 0
  while (
    shared < noteDir.length &&
    shared < targetParts.length - 1 &&
    noteDir[shared]?.toLowerCase() === targetParts[shared]?.toLowerCase()
  ) {
    shared += 1
  }
  const up = noteDir.length - shared
  return [...Array<string>(up).fill('..'), ...targetParts.slice(shared)].join('/')
}

/**
 * Where a picture for this note is stored.
 * @param vaultRoot - the authorized vault root.
 * @param name - the file name from `./imageInsert.ts`'s `assetName`.
 * @returns the absolute path of the file to create.
 */
export function assetPath(vaultRoot: string, name: string): string {
  return childPath(childPath(vaultRoot, IMAGE_FOLDER), name)
}

/**
 * Resolve `.` and `..` segments without touching the filesystem.
 *
 * The platform's own client concatenates the document's directory and the authored path; a
 * vault-root folder makes `../.img/x.png` the ordinary spelling for a note in a subdirectory, so the
 * segments are resolved here rather than handed to the file route as-is.
 * @param path - an absolute path, either separator.
 * @returns the same path with `.` and `..` applied.
 */
function normalizePath(path: string): string {
  const drive = /^([a-z]:)[/\\]/i.exec(path)
  const root = drive === null ? '/' : `${drive[1]}${path.charAt(2)}`
  const rest = drive === null ? path.replace(/^[/\\]+/, '') : path.slice(3)
  const parts: string[] = []
  for (const part of rest.split(/[/\\]+/)) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      parts.pop()
      continue
    }
    parts.push(part)
  }
  const separator = drive === null ? '/' : root.charAt(root.length - 1)
  return root + parts.join(separator)
}

/**
 * Whether a destination addresses the filesystem rather than a scheme.
 * @param path - a decoded destination.
 * @returns whether it is absolute in either spelling the host accepts.
 */
function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || DRIVE.test(path)
}

/** @returns the directory part of a path, including its trailing separator. */
function directoryOf(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return cut <= 0 ? path : path.slice(0, cut + 1)
}

/**
 * Undo the backslash escapes CommonMark allows in a destination, for display.
 *
 * Lives here rather than with the node because it is the same question as
 * {@link imageDisplayUrl}'s: what path does this destination actually name.
 * @param text - the authored destination.
 * @returns the readable destination.
 */
export function unescapeDestination(text: string): string {
  return text.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, '$1')
}
