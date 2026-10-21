/**
 * 仓库：一个用户授权的目录，以及插件在它里面做的所有文件操作。
 *
 * 内容
 * - FsFace / VaultError / refuseFrom / decodeAsset。
 * - Vault 类：授权、状态、列目录、读、stat、写、资产、重命名、移动、删除、建目录、
 *   在文件管理器里显示、隐藏。
 * - 路径辅助：withoutTrailingSeparator / requireSimpleName；拼写类（基名 / 父目录 / 隐藏名）
 *   在 shared/paths，名字合法性在 shared/entryName。
 *
 * 行为
 * - 根只在用户选择时授权一次，存在 Vault 内存里；请求体从不带根。
 * - 每个操作先解析目标，再按根做包含检查。
 * - 文本写走 ctx.fs（带版本比较）；图片 / mkdir / rename / delete 走 node:fs。
 * - 样例根是虚拟拼写，所有写操作拒绝（只读）。
 * - FsErrorCode 映射成 HTTP 状态与协议错误码。
 *
 * 边界
 * - 不是安全边界；真正的判据是包含检查。
 * - 不实现 HTTP 路由（src/index.ts）。
 *
 * 相关文件
 * - 依赖：shared/protocol、shared/paths、shared/errors、host/templates。
 * - 被依赖：src/index.ts。
 *
 * 改哪里
 * - 改授权：authorize / revoke。
 * - 改写：write / writeAsset。
 * - 改包含检查：resolve / contain。
 */
import { constants as fsConstants } from 'node:fs'
import { copyFile, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import type {
  FileSystem,
  FsErrorCode,
  FsTarget,
  FsVersion,
  FsWriteIntent,
} from '@deepseek-ai/dsh-fs'
import {
  ERR_BAD_REQUEST,
  ERR_FILESYSTEM,
  ERR_NOT_FOUND,
  ERR_NO_VAULT,
  ERR_OUTSIDE,
  ERR_SAMPLE_READ_ONLY,
  ERR_STALE,
  MAX_ASSET_BYTES,
  SAMPLE_READ_ONLY_MESSAGE,
  type VaultDirectoriesResult,
  type VaultDirectoryEntry,
  type VaultEntry,
  type VaultListResult,
  type VaultReadResult,
  type VaultStatResult,
  type VaultWriteResult,
} from '../shared/protocol'
import { basenameOf, childPath, dirnameOf, isHiddenName, relativePath, samePath } from '../shared/paths'
import { entryNameProblem, type EntryNamePlatform } from '../shared/entryName'
import { messageOf } from '../shared/errors'
import { SAMPLE_ROOT, findSampleDocument, sampleDocuments, type SampleDocument } from './templates'

/** Most directories the move picker will list before it says it stopped. */
const MAX_DIRECTORIES = 2000

/**
 * The naming rules this Host enforces.
 *
 * The dialog's preview uses the browser's reading of the platform; this one is the gate, because
 * `process.platform` is the machine that will actually create or rename the entry.
 */
const NAME_PLATFORM: EntryNamePlatform = process.platform === 'win32' ? 'windows' : 'posix'

/**
 * The slice of `ctx.fs` this plugin uses.
 *
 * The real `FileSystem` service, not a structural copy: an upstream contract change then
 * produces a compile error here instead of a runtime surprise, and `processPath` is
 * available for the two OS hand-offs — node:fs and the file manager.
 */
export type FsFace = FileSystem

/** A refusal carrying the HTTP status the route should answer with. */
export class VaultError extends Error {
  /** Stable machine-readable code from the shared protocol. */
  readonly code: string

  /** HTTP status to answer with. */
  readonly status: number

  /**
   * @param code - stable code.
   * @param status - HTTP status.
   * @param message - human-readable detail.
   */
  constructor(code: string, status: number, message: string) {
    super(message)
    this.name = 'VaultError'
    this.code = code
    this.status = status
  }
}

/**
 * Turn a filesystem failure into the refusal the route should answer with.
 *
 * `FsError` carries a stable `FsErrorCode` precisely so that layers above can
 * branch without parsing messages — the contract says so in as many words. A
 * stale-version rejection, the one write failure a writer can actually resolve,
 * is mapped separately instead of arriving at the UI looking like a permissions error.
 *
 * The code is read structurally rather than with `instanceof FsError`, because
 * importing that class as a value would pull the service into the host bundle
 * for one comparison. The vocabulary still comes from the published type.
 * @param error - whatever the provider threw.
 * @returns the refusal to raise.
 */
function refuseFrom(error: unknown): VaultError {
  const code = (error as { code?: FsErrorCode } | null | undefined)?.code
  if (code === 'FS_STALE_VERSION') {
    // One fact, no echo of the surface it lands on: the save notice already says 保存未生效, and a
    // sentence that repeated it read as two failures in a row.
    return new VaultError(ERR_STALE, 409, '磁盘上的版本已更新')
  }
  if (code === 'FS_PERMISSION_DENIED' || code === 'FS_SANDBOX_DENIED') {
    return new VaultError(ERR_FILESYSTEM, 403, messageOf(error))
  }
  return new VaultError(ERR_FILESYSTEM, 500, messageOf(error))
}

/**
 * Decode a base64 asset body, refusing anything that is not exactly one.
 *
 * `Buffer.from(text, 'base64')` is deliberately forgiving — it skips characters
 * it does not recognise and accepts unpadded input — which would turn a
 * truncated or corrupted upload into a silently shorter picture. So the text is
 * checked against the alphabet and the decoded bytes are re-encoded and compared:
 * a body this route accepts is one it can produce again, byte for byte.
 * @param base64 - the request's `base64` field.
 * @returns the decoded bytes.
 * @throws {VaultError} when the text is not canonical base64, is empty, or is too large.
 */
function decodeAsset(base64: string): Buffer {
  // Refuse on the encoded length before allocating the bytes: base64 is 4/3 of the payload, so
  // this is the same cap `writeAsset` enforces, just checked before the allocation instead of after.
  const encodedLimit = Math.ceil((MAX_ASSET_BYTES * 4) / 3) + 4
  if (base64.length > encodedLimit) {
    throw new VaultError(
      ERR_BAD_REQUEST,
      413,
      `图片超过上限（${Math.round(MAX_ASSET_BYTES / 1024 / 1024)} MB）`,
    )
  }
  if (base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) {
    throw new VaultError(ERR_BAD_REQUEST, 400, '内容不是合法的 base64')
  }
  const bytes = Buffer.from(base64, 'base64')
  if (bytes.toString('base64') !== base64) {
    throw new VaultError(ERR_BAD_REQUEST, 400, '内容不是合法的 base64')
  }
  if (bytes.byteLength === 0) throw new VaultError(ERR_BAD_REQUEST, 400, '内容为空')
  return bytes
}

/**
 * @param path - a directory path.
 * @returns the same path without a trailing separator.
 */
function withoutTrailingSeparator(path: string): string {
  return path.length > 1 ? path.replace(/[\\/]+$/, '') : path
}

/**
 * Validate a user-supplied single path segment.
 *
 * The same shared rule the dialog previews, applied to the platform this process runs on: a
 * browser cannot be the last word on what the filesystem accepts.
 * @param name - the raw name.
 * @returns the trimmed name.
 * @throws {VaultError} when the name is empty, names a path, or is illegal on this platform.
 */
function requireSimpleName(name: string): string {
  const trimmed = name.trim()
  const problem = entryNameProblem(trimmed, NAME_PLATFORM)
  if (problem !== null) throw new VaultError(ERR_BAD_REQUEST, 400, problem)
  return trimmed
}

/**
 * The authorized root: a directory the writer picked, or the plugin's own samples.
 *
 * A union rather than a path plus a flag, because the samples have **no target**:
 * there is nothing on disk behind them, so no `FsTarget` can describe them, and
 * every method that would need one answers from memory before it asks. The writer's
 * own choice keeps its target, so the ordinary case is unchanged.
 */
type VaultRoot =
  | { readonly kind: 'user'; readonly path: string; readonly target: FsTarget }
  | { readonly kind: 'sample'; readonly path: string }

/** The authorized vault root plus every operation scoped to it. */
export class Vault {
  private readonly fs: FsFace

  private root: VaultRoot | null = null

  /**
   * @param fs - the composed filesystem service.
   */
  constructor(fs: FsFace) {
    this.fs = fs
  }

  /**
   * The authorized root alone.
   *
   * Deliberately not the wire shape: `VaultStateResult` also carries `kind`, and the
   * route joins the two. The kind is decided by `./templates.ts`'s `classifyRoot`,
   * which owns the one spelling that makes a root the samples — the same spelling
   * this class authorizes and answers from, so the two cannot disagree about which
   * mode is in force.
   * @returns the currently authorized root, or `null`.
   */
  state(): { readonly root: string | null } {
    return { root: this.root?.path ?? null }
  }

  /**
   * Authorize one root as the vault, replacing any previous choice.
   * @param path - absolute directory the user picked, or the sample vault's own root.
   * @returns the new state.
   * @throws {VaultError} when the path is empty, missing, or not a directory.
   */
  async authorize(path: string): Promise<{ readonly root: string | null }> {
    const trimmed = path.trim()
    if (trimmed === '') throw new VaultError(ERR_BAD_REQUEST, 400, '路径为空')
    // The samples have no directory to resolve, so they are authorized by name instead
    // of by `stat`. This is the one way into sample mode, and the name is spelled once.
    if (samePath(trimmed, SAMPLE_ROOT)) return this.authorizeSample()
    const target = await this.fs.resolve(trimmed)
    const info = await this.fs.stat(target)
    if (info === undefined) throw new VaultError(ERR_NOT_FOUND, 404, `目录不存在：${trimmed}`)
    if (info.type !== 'directory') {
      throw new VaultError(ERR_BAD_REQUEST, 400, `不是目录：${trimmed}`)
    }
    this.root = { kind: 'user', path: target.displayPath, target }
    return this.state()
  }

  /**
   * Authorize the bundled samples.
   *
   * Nothing is resolved and nothing is stat-ed, because there is nothing there: the
   * templates are read from the package, into memory, by {@link sampleDocuments} — on
   * the first listing or open rather than here, so that "show me the samples" cannot
   * fail for a reason the writer has no way to act on.
   * @returns the new state.
   */
  private authorizeSample(): { readonly root: string | null } {
    this.root = { kind: 'sample', path: SAMPLE_ROOT }
    return this.state()
  }

  /** @returns the state after dropping the authorization. */
  revoke(): { readonly root: string | null } {
    this.root = null
    return this.state()
  }

  /**
   * The path an OS-level consumer can open.
   *
   * `displayPath` is the form shown to the writer; `processPath` is the one the
   * provider guarantees a subprocess can open, and the contract keeps them
   * separate on purpose because the harness host and the backend's execution
   * world need not be the same machine. Every place this file hands a path to
   * `node:fs` or to a file manager goes through here; every place it hands one
   * back to `this.fs.resolve` uses `displayPath`, because that is a round trip
   * inside the provider's own world.
   * @param target - a target from this provider.
   * @returns the process-visible absolute path.
   */
  private osPath(target: FsTarget): string {
    return this.fs.processPath(target)
  }

  /**
   * The authorized root, which has to be a real directory.
   *
   * The guard for every operation that would change something, and it is the **first**
   * statement of each of them: a sample root has no target to resolve against and no
   * file to change, so the refusal has to land before any path is looked at. Both
   * refusals are here rather than at the call sites so that one sentence answers for
   * all of them.
   * @returns the authorized directory.
   * @throws {VaultError} when nothing is authorized, or when the samples are.
   */
  private requireDirectory(): { readonly path: string; readonly target: FsTarget } {
    const root = this.root
    if (root === null) throw new VaultError(ERR_NO_VAULT, 409, '尚未授权任何目录')
    if (root.kind !== 'user') {
      throw new VaultError(ERR_SAMPLE_READ_ONLY, 403, SAMPLE_READ_ONLY_MESSAGE)
    }
    return root
  }

  /**
   * Resolve a path and prove it lies inside the authorized root.
   *
   * Reaches a real directory only: the samples answer their three reads before calling
   * this, and everything else is refused by {@link requireDirectory} first.
   * @param path - absolute path from the request.
   * @returns the resolved target.
   * @throws {VaultError} when nothing is authorized, the path is empty, or it escapes the root.
   */
  private async requireInside(path: string): Promise<FsTarget> {
    const root = this.requireDirectory()
    const trimmed = path.trim()
    if (trimmed === '') throw new VaultError(ERR_BAD_REQUEST, 400, '路径为空')
    const target = await this.fs.resolve(trimmed)
    if (!this.fs.contains(root.target, target)) {
      throw new VaultError(ERR_OUTSIDE, 403, `超出已授权的目录：${trimmed}`)
    }
    return target
  }

  /**
   * List one directory level.
   * @param path - absolute directory inside the root.
   * @returns the children.
   * @throws {VaultError} on any refusal.
   */
  async list(path: string): Promise<VaultListResult> {
    if (this.root?.kind === 'sample') return await this.listSamples(path)
    const target = await this.requireInside(path)
    const info = await this.fs.stat(target)
    if (info === undefined) throw new VaultError(ERR_NOT_FOUND, 404, `目录不存在：${path}`)
    if (info.type !== 'directory') throw new VaultError(ERR_BAD_REQUEST, 400, `不是目录：${path}`)

    const children = await this.fs.listDir(target)
    const entries: VaultEntry[] = children.map(child => ({
      name: child.name,
      type: child.type,
      ...(typeof child.size === 'number' ? { size: child.size } : {}),
    }))
    return { path: target.displayPath, entries }
  }

  /**
   * List the sample vault's one level.
   *
   * The samples are two documents in memory, so the root is the only directory there is
   * and the answer is the template list, in the order the package ships them. Anything
   * below the root is a directory that does not exist rather than a refusal: the request
   * is well-formed and there is simply nothing at that name.
   *
   * No sizes: they are files on disk that a listing reports, and these are not files.
   * @param path - absolute directory from the request.
   * @returns the samples, or a refusal when the path is not the sample root.
   * @throws {VaultError} when the path is not the sample root.
   */
  private async listSamples(path: string): Promise<VaultListResult> {
    if (!samePath(path.trim(), SAMPLE_ROOT)) {
      throw new VaultError(ERR_NOT_FOUND, 404, `目录不存在：${path}`)
    }
    const documents = await sampleDocuments()
    return {
      path: SAMPLE_ROOT,
      entries: documents.map(document => ({ name: document.name, type: 'file' as const })),
    }
  }

  /**
   * Every directory of the authorized root, the root first.
   *
   * Breadth-first over the provider's own listing, so it sees exactly what the tree
   * sees and nothing the tree cannot show. Dot-directories are skipped rather than
   * descended into: `.img` and `.config` are the plugin's own material, and a
   * document moved into either would leave the tree with no way to reach it again.
   *
   * The cap is a guard rather than a feature — a vault with more directories than
   * this is one where a list is the wrong tool — so the answer says it stopped
   * instead of returning a list that quietly ends.
   * @returns the directories, in walk order.
   * @throws {VaultError} when nothing is authorized.
   */
  async listDirectories(): Promise<VaultDirectoriesResult> {
    // One directory exists — the root — so the walk is over before it starts. Answered
    // rather than refused because the question is legitimate; nothing can be moved into
    // it (`moveEntry` refuses), so the picker has nothing else to offer there.
    if (this.root?.kind === 'sample') {
      return {
        root: SAMPLE_ROOT,
        directories: [{ path: SAMPLE_ROOT, relative: '' }],
        truncated: false,
      }
    }
    const root = this.requireDirectory()
    const directories: VaultDirectoryEntry[] = [{ path: root.path, relative: '' }]
    const queue: FsTarget[] = [root.target]
    let truncated = false
    while (queue.length > 0 && !truncated) {
      const current = queue.shift()
      if (current === undefined) break
      let children
      try {
        children = await this.fs.listDir(current)
      } catch {
        // One unreadable subdirectory is skipped rather than failing the walk, the
        // same way the search treats a directory it cannot list.
        continue
      }
      for (const child of children) {
        if (child.type !== 'directory' || isHiddenName(child.name)) continue
        if (directories.length >= MAX_DIRECTORIES) {
          truncated = true
          break
        }
        const relative = relativePath(root.path, child.target.displayPath)
        // A child of the root is always below it; the check is here so the key and
        // the path can never disagree about which level a directory is.
        if (relative === null) continue
        directories.push({ path: child.target.displayPath, relative })
        queue.push(child.target)
      }
    }
    return { root: root.path, directories, truncated }
  }

  /**
   * Read one file whole.
   * @param path - absolute file inside the root.
   * @returns the content and its freshness token.
   * @throws {VaultError} on any refusal.
   */
  async read(path: string): Promise<VaultReadResult> {
    if (this.root?.kind === 'sample') return await this.readSample(path)
    const target = await this.requireInside(path)
    const info = await this.fs.stat(target)
    if (info === undefined) throw new VaultError(ERR_NOT_FOUND, 404, `文件不存在：${path}`)
    if (info.type !== 'file') throw new VaultError(ERR_BAD_REQUEST, 400, `不是普通文件：${path}`)
    const content = await this.fs.readText(target)
    return { path: target.displayPath, content, version: String(info.version) }
  }

  /**
   * Read one of the package's documents **by name**, whatever root is authorized.
   *
   * The answer is the same one {@link readSample} gives — the identity it reports is that
   * document's place in the sample vault (`sample:示例/关于.md`) and its version is the stable
   * label `sample:<name>` — because it is the same document: open `关于.md` from the sample vault's
   * listing and from the settings menu, and the panel sees one document, so the second one
   * activates the first one's tab instead of opening a copy. Both routes build that answer through
   * {@link readOf}, so the identity is spelled once.
   *
   * Nothing is resolved or stat-ed: the name is looked up in the package's own table, so an
   * unknown name — or `../`, or a drive letter — is a miss rather than a path. The authorized root
   * is deliberately ignored (like `sample` and `sampleAsset`), because the caller is usually the
   * writer reading their own directory when this is asked for.
   * @param name - the file name as the package ships it.
   * @returns the template's text, as it ships.
   * @throws {VaultError} when the name is not one of the shipped templates.
   */
  async readSampleDocument(name: string): Promise<VaultReadResult> {
    const document = await findSampleDocument(name.trim())
    if (document === null) throw new VaultError(ERR_NOT_FOUND, 404, `文件不存在：${name}`)
    return this.readOf(document)
  }

  /**
   * Read one of the samples.
   *
   * By name, and only directly under the sample root: the path has to name one of these
   * two documents, so a path that names anything else is a miss rather than an
   * invitation to answer with a template — a file the writer may well have, at a path
   * that is none of this plugin's business.
   *
   * The version is a stable label, not a freshness token. Nothing can write these
   * documents, so there is nothing to compare-and-set; a caller that echoed this token
   * back for a write would find the write refused on the same grounds as any other.
   * @param path - absolute file path from the request.
   * @returns the template's text, as it ships.
   * @throws {VaultError} when the path names no sample.
   */
  private async readSample(path: string): Promise<VaultReadResult> {
    return this.readOf(await this.sampleAt(path))
  }

  /**
   * One sample's text as a read answer.
   *
   * The one definition of that wire shape: the identity is the document's place in the sample
   * vault and the version is the stable label, whoever asked — the `read` route by path or the
   * `sampleDocument` route by name.
   * @param document - the template.
   * @returns the read answer.
   */
  private readOf(document: SampleDocument): VaultReadResult {
    return {
      path: childPath(SAMPLE_ROOT, document.name),
      content: document.content,
      version: `sample:${document.name}`,
    }
  }

  /**
   * The sample a path names, whatever the caller wants from it.
   *
   * One definition of "that path is this sample", shared by the two answers that can be asked
   * about one: its text and its identity. Neither the read nor the stat route may reach a
   * template the other would refuse.
   * @param path - absolute file path from the request.
   * @returns the template.
   * @throws {VaultError} when the path is not directly under the sample root, or names no sample.
   */
  private async sampleAt(path: string): Promise<SampleDocument> {
    const trimmed = path.trim()
    if (!samePath(dirnameOf(trimmed), SAMPLE_ROOT)) {
      throw new VaultError(ERR_NOT_FOUND, 404, `文件不存在：${path}`)
    }
    const document = await findSampleDocument(basenameOf(trimmed))
    if (document === null) throw new VaultError(ERR_NOT_FOUND, 404, `文件不存在：${path}`)
    return document
  }

  /**
   * Answer one entry's identity without its text.
   *
   * The mount check asks this once per open document, so the answer has to cost one observation
   * and no content. Containment and the "is it there" refusal are the ones {@link read} makes, in
   * the same order, so a path this route refuses is never a path a read would answer.
   * @param path - absolute path inside the root.
   * @returns its freshness token, type and size.
   * @throws {VaultError} on any refusal.
   */
  async stat(path: string): Promise<VaultStatResult> {
    if (this.root?.kind === 'sample') return await this.statSample(path)
    const target = await this.requireInside(path)
    const info = await this.fs.stat(target)
    if (info === undefined) throw new VaultError(ERR_NOT_FOUND, 404, `文件不存在：${path}`)
    return {
      path: target.displayPath,
      version: String(info.version),
      type: info.type,
      ...(typeof info.size === 'number' ? { size: info.size } : {}),
    }
  }

  /**
   * The same answer for one of the samples.
   *
   * The version is the label a read would give it — `sample:<name>` — because it is one document
   * with one identity. Nothing can change these, so the label never moves.
   * @param path - absolute file path from the request.
   * @returns the identity of that sample.
   * @throws {VaultError} when the path names no sample.
   */
  private async statSample(path: string): Promise<VaultStatResult> {
    const document = await this.sampleAt(path)
    return {
      path: childPath(SAMPLE_ROOT, document.name),
      version: `sample:${document.name}`,
      type: 'file',
    }
  }

  /**
   * Write one file whole, optionally as a compare-and-set.
   * @param path - absolute file inside the root.
   * @param content - full replacement text.
   * @param expectedVersion - version the caller last read, when it has one.
   * @returns the outcome.
   * @throws {VaultError} on any refusal.
   */
  async write(path: string, content: string, expectedVersion?: string): Promise<VaultWriteResult> {
    const root = this.requireDirectory()
    const target = await this.requireInside(path)

    // An omitted guard writes unconditionally; `createIfAbsent` is used for a
    // path that does not exist yet so two first-time saves cannot silently race.
    const existing = await this.fs.stat(target)
    // A save of an existing document is not a naming act; a first save creates the name, and the
    // creation route has to obey the same rule as `rename` and `makeDirectory`. Checked only when
    // the target is new, so a file that already exists on disk is never refused for its spelling.
    if (existing === undefined) {
      const problem = entryNameProblem(basenameOf(target.displayPath), NAME_PLATFORM)
      if (problem !== null) throw new VaultError(ERR_BAD_REQUEST, 400, problem)
    }
    const expected: FsWriteIntent | undefined =
      expectedVersion === undefined
        ? existing === undefined
          ? { kind: 'createIfAbsent' }
          : undefined
        : {
            kind: 'replaceIfVersion',
            // The version is opaque and only ever echoed back, but the protocol
            // carries it as JSON, so it arrives here as a plain string. Rebranding
            // is the whole of this cast: the value the client returns is the one
            // the provider handed out, and the provider re-checks it regardless.
            version: expectedVersion as FsVersion,
          }

    try {
      const outcome = await this.fs.writeText(target, content, expected, undefined, {
        mode: 'workspace-write',
        workspaceRoot: root.path,
      })
      // `version` travels back so the writer does not have to read the whole file
      // again just to learn the token its next compare-and-set needs (see
      // `VaultWriteResult.version`).
      return { path: target.displayPath, operation: outcome.operation, version: outcome.version }
    } catch (error) {
      throw refuseFrom(error)
    }
  }

  /**
   * Write one binary file, creating its parent directory when it is missing.
   *
   * ## Why this is not `writeText`
   *
   * A picture is not text: `ctx.fs.writeText` decodes and re-encodes UTF-8, so
   * bytes that are not valid UTF-8 would come back changed. The provider offers
   * `readBytes` and no `writeBytes`, so the bytes go to `node:fs` — the same
   * route mkdir, rename and delete already take, and for the same reason: the
   * provider has no operation for this.
   *
   * ## What keeps it inside the vault
   *
   * The same containment check every other operation passes, applied to the file
   * **and** to its parent directory before anything is created. The parent is
   * made with `recursive: true` because the client names the layout (the vault's
   * own `.img` folder) and the first picture is what creates it.
   *
   * ## Why an existing file is refused
   *
   * Names are content-addressed and timestamped, so a collision means two
   * different pictures would share one name. Overwriting would destroy the first
   * one silently; refusing lets the caller pick another name. `wx` makes that
   * atomic rather than a check followed by a write.
   * @param path - absolute file inside the root.
   * @param base64 - complete content, standard base64 with padding.
   * @returns the written path and its size.
   * @throws {VaultError} on any refusal.
   */
  async writeAsset(path: string, base64: string): Promise<{ readonly path: string; readonly bytes: number }> {
    const root = this.requireDirectory()
    const bytes = decodeAsset(base64)
    const target = await this.requireInside(path)

    if (bytes.byteLength > MAX_ASSET_BYTES) {
      throw new VaultError(
        ERR_BAD_REQUEST,
        413,
        `图片超过上限（${Math.round(MAX_ASSET_BYTES / 1024 / 1024)} MB）`,
      )
    }
    if ((await this.fs.stat(target)) !== undefined) {
      throw new VaultError(ERR_BAD_REQUEST, 409, `目标已存在：${path}`)
    }

    const parent = await this.fs.resolve(dirnameOf(target.displayPath))
    if (!this.fs.contains(root.target, parent)) {
      throw new VaultError(ERR_OUTSIDE, 403, `超出已授权的目录：${parent.displayPath}`)
    }
    try {
      await mkdir(this.osPath(parent), { recursive: true })
      // The folder this route writes into is the plugin's own image storage, so it is kept out
      // of the file manager's default view — every time, not only when it was created, because
      // that is also how an existing `.img` picks the attribute up. A failure here is not a
      // failure to save the picture: the attribute is presentation, and the caller asked for an
      // image, not for a hidden folder.
      try {
        await setHidden(this.osPath(parent))
      } catch {
        // Deliberately ignored; see above.
      }
      await writeFile(this.osPath(target), bytes, { flag: 'wx' })
    } catch (error) {
      // `wx` on an existing file is the race the check above cannot close; it
      // arrives here as a plain fs error, so it is named rather than folded into
      // the generic filesystem failure.
      if ((error as { code?: string }).code === 'EEXIST') {
        throw new VaultError(ERR_BAD_REQUEST, 409, `目标已存在：${path}`)
      }
      throw refuseFrom(error)
    }
    return { path: target.displayPath, bytes: bytes.byteLength }
  }

  /**
   * Rename one entry inside its own directory.
   *
   * The destination is validated against the root as well as the source: a new
   * name can only ever produce a sibling, but the check is the same one every
   * other operation passes, so no path reaches the filesystem unverified.
   * @param path - absolute path inside the root.
   * @param newName - the new basename.
   * @returns the new absolute path.
   * @throws {VaultError} on any refusal.
   */
  async renameEntry(path: string, newName: string): Promise<{ readonly path: string }> {
    const root = this.requireDirectory()
    const name = requireSimpleName(newName)
    const target = await this.requireInside(path)
    if (target.displayPath === root.path) {
      throw new VaultError(ERR_BAD_REQUEST, 400, '不能重命名 vault 根目录')
    }
    const nextPath = childPath(dirnameOf(target.displayPath), name)
    const nextTarget = await this.fs.resolve(nextPath)
    if (!this.fs.contains(root.target, nextTarget)) {
      throw new VaultError(ERR_OUTSIDE, 403, `超出已授权的目录：${nextPath}`)
    }
    if ((await this.fs.stat(nextTarget)) !== undefined) {
      throw new VaultError(ERR_BAD_REQUEST, 409, `目标已存在：${name}`)
    }
    try {
      await rename(this.osPath(target), this.osPath(nextTarget))
    } catch (error) {
      throw refuseFrom(error)
    }
    return { path: nextTarget.displayPath }
  }

  /**
   * Copy one file to a sibling name.
   *
   * A byte copy, not a text copy: `copyFile` hands the bytes to the filesystem, so BOM, line
   * endings, frontmatter and every other byte survive. The destination is built from the source's
   * own directory, which keeps relative image destinations valid; an existing name is refused with
   * `COPYFILE_EXCL` instead of overwritten.
   * @param path - absolute file path inside the root.
   * @param newName - the copy's basename.
   * @returns the new absolute path.
   * @throws {VaultError} on any refusal.
   */
  async copyEntry(path: string, newName: string): Promise<{ readonly path: string }> {
    const root = this.requireDirectory()
    const name = requireSimpleName(newName)
    const target = await this.requireInside(path)
    const info = await this.fs.stat(target)
    if (info === undefined) throw new VaultError(ERR_NOT_FOUND, 404, `不存在：${path}`)
    if (info.type !== 'file') throw new VaultError(ERR_BAD_REQUEST, 400, '只能复制文件')
    const nextPath = childPath(dirnameOf(target.displayPath), name)
    const nextTarget = await this.fs.resolve(nextPath)
    if (!this.fs.contains(root.target, nextTarget)) {
      throw new VaultError(ERR_OUTSIDE, 403, `超出已授权的目录：${nextPath}`)
    }
    if ((await this.fs.stat(nextTarget)) !== undefined) {
      throw new VaultError(ERR_BAD_REQUEST, 409, `目标已存在：${name}`)
    }
    try {
      await copyFile(this.osPath(target), this.osPath(nextTarget), fsConstants.COPYFILE_EXCL)
    } catch (error) {
      // The stat above cannot close the race between two copies; `COPYFILE_EXCL` is the real
      // guard, and its `EEXIST` is the same refusal the check would have produced.
      if ((error as { code?: string }).code === 'EEXIST') {
        throw new VaultError(ERR_BAD_REQUEST, 409, `目标已存在：${name}`)
      }
      throw refuseFrom(error)
    }
    return { path: nextTarget.displayPath }
  }

  /**
   * Move one entry into another directory of the same vault.
   *
   * A move, not a rename: the basename is kept and only the parent changes — which
   * is why it needs a route of its own rather than a field on `renameEntry`.
   *
   * Three refusals belong to this operation specifically, and all three exist
   * because its caller is a **drag**, a gesture that can land anywhere, including
   * on the thing it is carrying:
   *
   * 1. the destination may not be the entry itself nor anything inside it, or the
   *    subtree would be lifted into its own hole (`contains` is reflexive, so one
   *    test covers both);
   * 2. the destination may not already hold that name — `rename(2)` replaces the
   *    target silently on POSIX and fails on Windows, so leaving it to the platform
   *    would make the same gesture destroy a file on one OS and refuse on the other;
   * 3. the destination may not be the entry's current directory: the client already
   *    refuses that drop, and accepting it here would report a move that moved
   *    nothing.
   * @param path - absolute path of the entry to move.
   * @param directory - absolute directory inside the root to move it into.
   * @returns the entry's new absolute path.
   * @throws {VaultError} on any refusal.
   */
  async moveEntry(path: string, directory: string): Promise<{ readonly path: string }> {
    const root = this.requireDirectory()
    const target = await this.requireInside(path)
    if (target.displayPath === root.path) {
      throw new VaultError(ERR_BAD_REQUEST, 400, '不能移动 vault 根目录')
    }
    const parent = await this.requireInside(directory)
    const parentInfo = await this.fs.stat(parent)
    if (parentInfo === undefined) {
      /**
       * A destination that will not stat gets one more question before it is refused: does the
       * directory above even list that name?
       *
       * The two answers are different failures. "There is no such folder" means the listing
       * the writer is looking at is stale — the tree is a cache and nothing watches the disk.
       * "The folder is there and cannot be read" is a real fault, and it is the one nobody
       * believes from the bare message, because they can see the folder in another window:
       * 「我实际看了 windows 目录是有这个文件夹的」 Saying which of the two it is costs one
       * listing on the failure path and settles the question.
       *
       * The spelling is reported too, but only when it differs from what arrived: a resolved
       * path that disagrees with the request is the other way this check can fail honestly.
       */
      const parentPath = dirnameOf(parent.displayPath)
      const name = basenameOf(parent.displayPath)
      let observable = '上一层读不到'
      try {
        const siblings = await this.fs.listDir(await this.requireInside(parentPath))
        observable = siblings.some(sibling => sibling.name === name)
          ? '上一层能看到它，但它 stat 不到'
          : '上一层里没有这个名字'
      } catch {
        // Left as the third answer: the question itself could not be asked.
      }
      const spelling = samePath(parent.displayPath, directory.trim())
        ? ''
        : `；服务端解析为 ${parent.displayPath}`
      throw new VaultError(ERR_NOT_FOUND, 404, `目标目录不存在：${directory}（${observable}）${spelling}`)
    }
    if (parentInfo.type !== 'directory') {
      throw new VaultError(ERR_BAD_REQUEST, 400, `不是目录：${directory}`)
    }
    if (this.fs.contains(target, parent)) {
      throw new VaultError(ERR_BAD_REQUEST, 400, '不能移动到它自己或它的子目录里')
    }
    if (
      samePath(
        withoutTrailingSeparator(dirnameOf(target.displayPath)),
        withoutTrailingSeparator(parent.displayPath),
      )
    ) {
      throw new VaultError(ERR_BAD_REQUEST, 400, '已经在目标目录里')
    }
    const name = basenameOf(target.displayPath)
    const nextPath = childPath(parent.displayPath, name)
    const nextTarget = await this.fs.resolve(nextPath)
    if (!this.fs.contains(root.target, nextTarget)) {
      throw new VaultError(ERR_OUTSIDE, 403, `超出已授权的目录：${nextPath}`)
    }
    if ((await this.fs.stat(nextTarget)) !== undefined) {
      throw new VaultError(ERR_BAD_REQUEST, 409, `目标已存在：${name}`)
    }
    try {
      await rename(this.osPath(target), this.osPath(nextTarget))
    } catch (error) {
      throw refuseFrom(error)
    }
    return { path: nextTarget.displayPath }
  }

  /**
   * Delete one entry.
   * @param path - absolute path inside the root.
   * @param recursive - whether a directory may be removed together with its contents.
   * @throws {VaultError} on any refusal.
   */
  async removeEntry(path: string, recursive: boolean): Promise<void> {
    const root = this.requireDirectory()
    const target = await this.requireInside(path)
    if (target.displayPath === root.path) {
      throw new VaultError(ERR_BAD_REQUEST, 400, '不能删除 vault 根目录')
    }
    const info = await this.fs.stat(target)
    if (info === undefined) throw new VaultError(ERR_NOT_FOUND, 404, `不存在：${path}`)
    // A directory needs an explicit recursive choice, so a slip cannot take a
    // whole subtree with it.
    if (info.type === 'directory' && !recursive) {
      throw new VaultError(ERR_BAD_REQUEST, 400, '删除目录需要显式确认递归删除')
    }
    try {
      await rm(this.osPath(target), { recursive, force: false })
    } catch (error) {
      throw refuseFrom(error)
    }
  }

  /**
   * Create one directory.
   *
   * `recursive` says "make sure it is there": an existing directory is then success rather
   * than a refusal, which is what the order document's `.config` needs — the first drag
   * creates it and every drag after it asks for the same thing. The flag is part of the
   * request rather than a second route because everything else about the operation is
   * identical.
   * @param parentPath - absolute directory inside the root.
   * @param name - the new directory's basename.
   * @param recursive - whether an existing directory is acceptable.
   * @returns the created path.
   * @throws {VaultError} on any refusal.
   */
  async makeDirectory(
    parentPath: string,
    name: string,
    recursive = false,
  ): Promise<{ readonly path: string }> {
    const root = this.requireDirectory()
    const parent = await this.requireInside(parentPath)
    const info = await this.fs.stat(parent)
    if (info === undefined) throw new VaultError(ERR_NOT_FOUND, 404, `目录不存在：${parentPath}`)
    if (info.type !== 'directory') {
      throw new VaultError(ERR_BAD_REQUEST, 400, `不是目录：${parentPath}`)
    }
    const nextPath = childPath(parent.displayPath, requireSimpleName(name))
    const nextTarget = await this.fs.resolve(nextPath)
    if (!this.fs.contains(root.target, nextTarget)) {
      throw new VaultError(ERR_OUTSIDE, 403, `超出已授权的目录：${nextPath}`)
    }
    if (!recursive && (await this.fs.stat(nextTarget)) !== undefined) {
      throw new VaultError(ERR_BAD_REQUEST, 409, `目标已存在：${name}`)
    }
    try {
      // `recursive: true` also means a name taken by a **file** is still refused — the call
      // fails with `EEXIST`/`ENOTDIR`, which `refuseFrom` turns into a refusal rather than
      // into a silent success.
      await mkdir(this.osPath(nextTarget), recursive ? { recursive: true } : undefined)
    } catch (error) {
      throw refuseFrom(error)
    }
    return { path: nextTarget.displayPath }
  }

  /**
   * Show one entry in the platform's file manager.
   *
   * Nothing here touches the filesystem: it asks the desktop host to reveal the
   * path, which is an OS action rather than an `ctx.fs` one — no such operation
   * exists on that interface, and the harness exposes no shell service either
   * (`ctx.shell` is bash execution, not the operating system's shell).
   *
   * The path is contained-checked first, on the same rule as every other
   * operation, so a reveal can only ever point inside the authorized root.
   * @param path - absolute path inside the root.
   * @throws {VaultError} when nothing is authorized, the samples are, the path escapes
   *   the root, or the running host cannot reach the platform shell.
   */
  async reveal(path: string): Promise<void> {
    // Its own sentence rather than the write refusal: the samples cannot be revealed for
    // the reason they cannot be written — there is no file — and "改动不会保存" would be
    // answering a question the writer did not ask.
    if (this.root?.kind === 'sample') {
      throw new VaultError(ERR_SAMPLE_READ_ONLY, 403, '这是插件自带的只读示例，磁盘上没有这个文件')
    }
    const target = await this.requireInside(path)

    const shell = await loadElectronShell()
    if (shell !== null) {
      try {
        shell.showItemInFolder(this.osPath(target))
        return
      } catch {
        // Fall through: the platform command is the path that always works.
      }
    }

    if (revealWithPlatformCommand(this.osPath(target))) return

    const platform =
      (globalThis as { process?: { platform?: string } }).process?.platform ?? 'unknown'
    throw new VaultError(ERR_FILESYSTEM, 501, `当前宿主无法打开文件位置（平台：${platform}）`)
  }
  /**
   * Keep one of the plugin's own folders out of the file manager's default view.
   *
   * The plugin keeps its material in two folders of its own — the vault's `.img` and `.config` —
   * and a writer who never turns on "show hidden files" should not have to look at them. On
   * Windows that is the **Hidden attribute**; on macOS and Linux a leading dot already *is*
   * hidden, so there is nothing to do and this returns without touching anything.
   *
   * Like {@link reveal}, this is not a filesystem operation: nothing about the path's contents
   * changes, and `ctx.fs` has no notion of attributes (`node:fs` cannot set them either —
   * `chmod` on Windows toggles read-only and nothing else). So it is a platform command, and it
   * is contained-checked first, on the same rule as every other operation.
   *
   * **Nothing in this plugin reads the attribute**, which is what makes it safe: the tree keeps
   * those two names out of the root listing by comparing names, and every other operation
   * addresses a path directly. Turning the attribute off again (`attrib -h`) changes nothing but
   * what the file manager shows.
   *
   * A path that is not there is **not** an error: both folders are created lazily, so "make it
   * hidden if it exists" is the only useful meaning, and it lets the caller ask on every mount
   * without first asking whether the folder exists.
   * @param path - absolute path inside the root.
   * @throws {VaultError} when nothing is authorized, the samples are, the path escapes the
   *   root, or the platform command fails.
   */
  async hideEntry(path: string): Promise<void> {
    // The root first, so the samples are refused on the same grounds as every other
    // operation — and before containment, which needs a directory that exists.
    this.requireDirectory()
    // Containment next, on the same rule as every other operation, so "outside the root" is
    // refused the same way on a platform where there is nothing to set.
    const target = await this.requireInside(path)

    const platform = (globalThis as { process?: { platform?: string } }).process?.platform
    if (platform !== 'win32') return

    if ((await this.fs.stat(target)) === undefined) return

    try {
      await setHidden(this.osPath(target))
    } catch (error) {
      throw refuseFrom(error)
    }
  }
}

/** The one Electron main-process call this plugin would prefer to use. */
interface ElectronShell {
  /**
   * Open the containing folder and select the item.
   * @param path - absolute path to reveal.
   */
  showItemInFolder(path: string): void
}

/** Cached so a host without Electron pays for the failed import only once. */
let shellProbe: Promise<ElectronShell | null> | null = null

/**
 * Reach the desktop shell, when this host is the Electron main process.
 *
 * Guarded and cached, because on the target app it does not resolve at all:
 * measured, `import('electron')` fails in the Host half, which means the Host
 * does not run in the Electron main process. It stays first anyway — it is the
 * API the platform intends for this — but the platform command below is the one
 * that actually works.
 * @returns the shell, or `null` when this host has none.
 */
async function loadElectronShell(): Promise<ElectronShell | null> {
  shellProbe ??= (async () => {
    try {
      const module = (await import('electron')) as unknown as { shell?: ElectronShell }
      return module.shell ?? null
    } catch {
      return null
    }
  })()
  return await shellProbe
}

/**
 * Set the file manager's Hidden attribute on one path.
 *
 * A platform command for the same reason {@link revealWithPlatformCommand} is one: the attribute
 * is not something `ctx.fs` or `node:fs` can express. Measured on this machine — `attrib +h
 * <directory>` turns the attribute set from `Directory` into `Hidden, Directory`, and `attrib -h`
 * turns it back — and unlike `explorer.exe`, whose exit status says nothing, `attrib` reports
 * success honestly, so a failure is raised rather than swallowed.
 * @param path - absolute path to mark hidden.
 * @returns when the attribute is set.
 * @throws when the command cannot be started or reports a failure.
 */
function setHidden(path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('attrib', ['+h', path], { stdio: 'ignore', windowsHide: true })
    child.on('error', reject)
    child.on('exit', code => {
      if (code === 0) resolve()
      else reject(new Error(`attrib +h 退出码 ${String(code)}`))
    })
  })
}

/**
 * Reveal a path with the platform's own file manager.
 *
 * Fire and forget on purpose: on Windows `explorer.exe /select,` exits 1 even
 * when it succeeds, so the exit status carries no information and waiting for it
 * would only add a delay.
 * @param path - absolute path to reveal.
 * @returns whether a command was started.
 */
function revealWithPlatformCommand(path: string): boolean {
  const platform = (globalThis as { process?: { platform?: string } }).process?.platform
  try {
    if (platform === 'win32') {
      /*
       * One argument: `/select,` then the path, quoted on its own — with `windowsVerbatimArguments` so Node
       * does not add quoting of its own around the whole thing. `explorer.exe` cannot parse a quoted switch, and
       * a path is whatever the operating system allows it to be, so this is written the way a shell would write
       * it for any path rather than for the one that happened to be reported.
       */
      spawn('explorer.exe', [`/select,"${path}"`], {
        detached: true,
        stdio: 'ignore',
        windowsVerbatimArguments: true,
      }).unref()
      return true
    }
    if (platform === 'darwin') {
      spawn('open', ['-R', path], { detached: true, stdio: 'ignore' }).unref()
      return true
    }
    if (platform === 'linux') {
      // Linux has no portable "select this item", so open the containing folder.
      spawn('xdg-open', [dirnameOf(path)], { detached: true, stdio: 'ignore' }).unref()
      return true
    }
  } catch {
    return false
  }
  return false
}
