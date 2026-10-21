/**
 * 包内模板文档 / 图片，以及它们呈现的样例仓库。
 *
 * 内容
 * - TEMPLATE_FILES / SAMPLE_ASSET_FILES / SAMPLE_ROOT。
 * - SampleDocument / sampleDocuments / findSampleDocument / readSampleAsset。
 *
 * 行为
 * - 模板从 _vault-test/ 读，只读，随包发布。
 * - 样例文档在内存里；每次读从同一份缓存答；失败不缓存。
 * - 样例根是 scheme 拼写，不对应磁盘目录。
 * - 图片按拼写表查找，不拼路径。
 *
 * 边界
 * - 不写任何文件。
 * - 不碰用户授权的目录。
 *
 * 相关文件
 * - 依赖：shared/paths、host/packageRoot。
 * - 被依赖：src/index.ts、host/vault.ts。
 *
 * 改哪里
 * - 改清单：TEMPLATE_FILES / SAMPLE_ASSET_FILES。
 * - 改读取：sampleDocuments / readSampleAsset。
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { samePath } from '../shared/paths'
import { packageRoot } from './packageRoot'

/**
 * The template documents this package ships, by filename, in listing order.
 *
 * A rename here is the whole change: the sample vault lists whatever this table names and
 * reads each file out of `_vault-test/`, so nothing else in the package is keyed by the name.
 */
export const TEMPLATE_FILES: readonly string[] = ['关于.md', '功能介绍.md']

/**
 * The pictures the template documents show, **spelled the way those documents spell them**.
 *
 * The samples are one flat folder at the sample root, so a document's relative destination is
 * read from that root: `.img/示例照片.jpg` here is `<package>/_vault-test/.img/示例照片.jpg` on
 * disk. That mapping is deliberately a **table rather than a path join** — a request naming an
 * asset is looked up in this list, so no caller's string is ever resolved, joined or stat-ed,
 * which is the same property `SAMPLE_ROOT` has and the reason the sample mode needs no
 * containment check.
 *
 * The files are served by {@link readSampleAsset} through the plugin's own route
 * (`VaultRoute.sampleAsset`) rather than the platform's file route: there is no directory behind
 * `sample:示例` for that route to read, and the picture genuinely lives inside this package.
 */
export const SAMPLE_ASSET_FILES: readonly string[] = ['.img/示例图片.jpg']

/**
 * The path the sample vault is authorized under.
 *
 * A **spelling**, not a location: the samples are memory, so this names nothing and is
 * never resolved, stat-ed or opened. It is written as a scheme precisely because it
 * cannot be a real path — on Windows a drive is a single letter and `:` may not appear
 * in a name, and a machine that reads `/` as its root reads anything else as relative.
 * Both halves carry it around as the root they already carry a directory in, which is
 * what lets one set of routes serve both.
 */
export const SAMPLE_ROOT = 'sample:示例'

/** One bundled template, as the sample vault serves it. */
export interface SampleDocument {
  /** Filename, which is also the name the tree lists. */
  readonly name: string
  /** Complete text, exactly as it is shipped. */
  readonly content: string
}

/** The templates, once read. Assigned only while a read is in flight or has succeeded. */
let cachedDocuments: Promise<readonly SampleDocument[]> | undefined

/**
 * The bundled templates, read once per host process.
 *
 * Memoized because every listing and every open answers from here, and these files
 * cannot change while the process runs: they are inside the installed package. A
 * **failed** read is deliberately not memoized, because a rejection parked in the
 * cache would make one unreadable file permanent for the life of the process.
 * @returns the documents, in listing order.
 * @throws {Error} when a template cannot be read.
 */
export function sampleDocuments(): Promise<readonly SampleDocument[]> {
  cachedDocuments ??= (async () => {
    const documents: SampleDocument[] = []
    for (const name of TEMPLATE_FILES) {
      const content = await readFile(join(packageRoot(), '_vault-test', name), 'utf8')
      documents.push({ name, content })
    }
    return documents
  })().catch((error: unknown) => {
    cachedDocuments = undefined
    throw error
  })
  return cachedDocuments
}

/**
 * One bundled template, by the name the sample vault lists it under.
 *
 * A lookup rather than a path, exactly like {@link readSampleAsset}: a name that is not in
 * {@link TEMPLATE_FILES} answers `null`, so `../`, a drive letter, an absolute path or any other
 * invented name never reaches the filesystem.
 * @param name - the file name as the package ships it.
 * @returns the document, or `null` when no such template ships.
 */
export async function findSampleDocument(name: string): Promise<SampleDocument | null> {
  return (await sampleDocuments()).find(entry => entry.name === name) ?? null
}

/**
 * One bundled picture, as the route hands it to the page.
 *
 * The content type travels with the bytes because both come from the same fact — which file
 * this is — and the route that answers with them has no business deciding either.
 */
export interface SampleAsset {
  /** The bytes, exactly as they ship. */
  readonly bytes: Buffer
  /** Media type for the file's extension. */
  readonly contentType: string
}

/**
 * Media type per extension.
 *
 * Only the formats a picture can be shipped in, which are the ones `./client/editor/imageInsert.ts`
 * stores. An extension outside this table is answered as `application/octet-stream` rather than
 * refused: it is still the bytes that were asked for, and the samples are ours to get right.
 */
const ASSET_TYPES: Readonly<Record<string, string>> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
}

/** The pictures, once read. Assigned only while a read is in flight or has succeeded. */
let cachedAssets: Promise<ReadonlyMap<string, SampleAsset>> | undefined

/**
 * The bundled pictures, read once per host process, keyed by the spelling the documents use.
 *
 * Memoized for the same reason {@link sampleDocuments} is, and with the same rule about failures:
 * a rejection parked in the cache would make one unreadable picture permanent for the life of the
 * process.
 * @returns the asset table, keyed by spelling.
 * @throws {Error} when a listed asset cannot be read.
 */
export function sampleAssets(): Promise<ReadonlyMap<string, SampleAsset>> {
  cachedAssets ??= (async () => {
    const assets = new Map<string, SampleAsset>()
    for (const spelling of SAMPLE_ASSET_FILES) {
      const bytes = await readFile(join(packageRoot(), '_vault-test', ...spelling.split('/')))
      const extension = spelling.slice(spelling.lastIndexOf('.')).toLowerCase()
      assets.set(spelling, { bytes, contentType: ASSET_TYPES[extension] ?? 'application/octet-stream' })
    }
    return assets
  })().catch((error: unknown) => {
    cachedAssets = undefined
    throw error
  })
  return cachedAssets
}

/**
 * One bundled picture, by the spelling a sample document used.
 *
 * A lookup rather than a path: a name that is not in {@link SAMPLE_ASSET_FILES} answers `null`,
 * so `../`, a drive letter, an absolute path or any other invented name never reaches the
 * filesystem. That is what lets the route be reached by a page without a containment check.
 * @param name - the relative destination, exactly as the document spells it.
 * @returns the bytes and their media type, or `null` when no such picture ships.
 */
export async function readSampleAsset(name: string): Promise<SampleAsset | null> {
  return (await sampleAssets()).get(name) ?? null
}

/**
 * Classify an authorized root as the bundled samples or the writer's own choice.
 *
 * By comparison against {@link SAMPLE_ROOT} rather than by resolving both sides: the
 * sample root is a spelling this plugin made up, so there is nothing to resolve it
 * against — and nothing on disk for a real directory to be confused with, which is
 * what the old comparison had to guard against.
 * @param root - the authorized root path, or `null`.
 * @returns the kind, or `null` when nothing is authorized.
 */
export function classifyRoot(root: string | null): 'sample' | 'user' | null {
  if (root === null) return null
  return samePath(root, SAMPLE_ROOT) ? 'sample' : 'user'
}
