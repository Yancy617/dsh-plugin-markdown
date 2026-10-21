/**
 * 浏览器端访问本插件 Host 的 vault 路由。
 *
 * 内容
 * - VaultRequestError 重导出、VaultState / SampleVaultResult。
 * - fetchVaultState / authorizeVault / revokeVault / searchVault。
 * - fetchSampleVault / readSampleDocument / listDirectory / readFile / statFile / writeFile。
 * - 资产：writeAsset 与 base64 编解码。
 *
 * 行为
 * - 路径参数统一 encodeURIComponent。
 * - 读 / 写 / 列目录 / 搜索 / 授权都走 request<T>。
 * - 示例仓库的路径是 host 的虚拟根，不对应磁盘目录。
 * - 写入带 expectedVersion（乐观并发）。
 *
 * 边界
 * - 不负责传输细节（request.ts）。
 * - 不负责 UI 状态（workbenchStore / MarkdownWorkbench）。
 *
 * 相关文件
 * - 依赖：shared/protocol、request.ts。
 * - 被依赖：MarkdownWorkbench.tsx、imageInsert.ts。
 *
 * 改哪里
 * - 改路由：各 fetch 函数。
 * - 改资产：writeAsset。
 */
import {
  VAULT_BASE,
  VaultRoute,
  type VaultDirectoriesResult,
  type VaultFailure,
  type VaultListResult,
  type VaultPathResult,
  type VaultReadResult,
  type VaultSearchResult,
  type VaultStatResult,
  type VaultStateResult,
  type VaultWriteResult,
} from '../shared/protocol'
import { request } from './request'

/**
 * Re-exported for the callers that catch it: the class moved to `./request.ts` when the
 * update check needed the same round trip, and those callers' import sites should not
 * have to change for that.
 */
export { VaultRequestError } from './request'

/**
 * @param path - absolute directory or file path.
 * @returns the path as a query value.
 */
function withPath(path: string): string {
  return `?path=${encodeURIComponent(path)}`
}

/** The authorized vault root, or `null`. */
export type VaultState = VaultStateResult & { readonly node?: string }

/** @returns the currently authorized vault root. */
export async function fetchVaultState(): Promise<VaultState> {
  return await request<VaultState>(VaultRoute.state, { method: 'GET' })
}

/**
 * Authorize one directory as the vault.
 * @param path - absolute directory the user picked.
 * @returns the new state.
 */
export async function authorizeVault(path: string): Promise<VaultStateResult> {
  return await request<VaultStateResult>(VaultRoute.authorize, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path }),
  })
}

/** @returns the state after dropping the authorization. */
export async function revokeVault(): Promise<VaultStateResult> {
  return await request<VaultStateResult>(VaultRoute.revoke, { method: 'POST' })
}

/**
 * Search the authorized root's Markdown files.
 * @param query - pattern as typed; the host searches whatever root is authorized.
 * @returns matches grouped by file, or the reason none could be produced.
 */
export async function searchVault(query: string): Promise<VaultSearchResult> {
  return await request<VaultSearchResult>(VaultRoute.search, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
  })
}

/**
 * Where the bundled samples are.
 *
 * The path is the Host's own spelling for them and nothing on disk answers to it: the
 * samples are the package's templates, held in memory (§6.143), so this is a name to
 * authorize rather than a directory to list.
 */
export interface SampleVaultResult {
  /** The root to authorize in order to see the samples. */
  readonly path: string
}

/**
 * Ask where the bundled samples are, and report it.
 *
 * Called when nothing is authorized yet. Authorizing the result cannot expose anything of
 * the writer's — there is no directory behind that path at all — and once they pick one of
 * their own, this is never called again.
 * @returns the sample vault's root.
 */
export async function fetchSampleVault(): Promise<SampleVaultResult> {
  return await request<SampleVaultResult>(VaultRoute.sample, { method: 'POST' })
}

/**
 * Read one of the package's documents by name, whatever root is authorized.
 *
 * The document is the plugin's own (it ships inside the package), so this is not a read of the
 * writer's vault and does not go through {@link readFile} — that route answers inside the
 * authorized root and would refuse these paths, correctly. The answer's `path` is where the
 * document sits in the sample vault, which is what makes an already-open copy of the same
 * document findable by path.
 * @param name - the file name as the package ships it (`功能介绍.md`).
 * @returns the content and its stable version label.
 */
export async function readSampleDocument(name: string): Promise<VaultReadResult> {
  return await request<VaultReadResult>(
    `${VaultRoute.sampleDocument}?name=${encodeURIComponent(name)}`,
    { method: 'GET' },
  )
}

/**
 * List one directory level.
 * @param path - absolute directory inside the vault.
 * @returns the children.
 */
export async function listDirectory(path: string): Promise<VaultListResult> {
  return await request<VaultListResult>(`${VaultRoute.list}${withPath(path)}`, { method: 'GET' })
}

/**
 * Read one file whole.
 * @param path - absolute file inside the vault.
 * @returns the content and its freshness token.
 */
export async function readFile(path: string): Promise<VaultReadResult> {
  return await request<VaultReadResult>(`${VaultRoute.read}${withPath(path)}`, { method: 'GET' })
}

/**
 * Ask for one entry's freshness token, without its text.
 *
 * The caller whose question is only "is this still the file I read" — the panel's mount check —
 * uses this instead of {@link readFile}: one token, not the whole document. A Host that predates
 * the route answers 404, and the caller falls back to a read (the page is reloaded far more often
 * than the Host is restarted).
 * @param path - absolute path inside the vault.
 * @returns the token, the type and the size when the backend reports it.
 */
export async function statFile(path: string): Promise<VaultStatResult> {
  return await request<VaultStatResult>(`${VaultRoute.stat}${withPath(path)}`, { method: 'GET' })
}

/**
 * Write one file whole.
 * @param path - absolute file inside the vault.
 * @param content - full replacement text.
 * @param expectedVersion - version last read, when the caller has one.
 * @returns the outcome, whose `version` is the token to use for the next write
 *   (absent when the Host half predates that field — see `VaultWriteResult`).
 */
export async function writeFile(
  path: string,
  content: string,
  expectedVersion?: string,
): Promise<VaultWriteResult> {
  return await request<VaultWriteResult>(VaultRoute.write, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path, content, expectedVersion }),
  })
}

/**
 * Encode bytes as standard base64, a chunk at a time.
 *
 * `String.fromCharCode(...bytes)` on a whole picture overflows the argument
 * limit and throws `RangeError: Maximum call stack size exceeded` — around a
 * hundred kilobytes in, which is smaller than most screenshots. The chunk size
 * is the usual 0x8000 for exactly that reason.
 * @param bytes - the file's content.
 * @returns base64 with padding.
 */
function base64Of(bytes: Uint8Array): string {
  const chunks: string[] = []
  const step = 0x8000
  for (let at = 0; at < bytes.length; at += step) {
    chunks.push(String.fromCharCode(...bytes.subarray(at, at + step)))
  }
  return btoa(chunks.join(''))
}

/**
 * Write one binary file into the vault.
 *
 * The host creates the parent directory when it is missing and refuses a path
 * that already exists (`409`), so a caller that collides renames and tries again
 * rather than losing the picture it was writing.
 * @param path - absolute file path inside the vault.
 * @param bytes - complete content.
 * @returns the path the host wrote.
 */
export async function writeAsset(path: string, bytes: Uint8Array): Promise<VaultPathResult> {
  return await request<VaultPathResult>(VaultRoute.asset, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path, base64: base64Of(bytes) }),
  })
}

/** The base path the routes live under, re-exported for diagnostics. */
export { VAULT_BASE }

/**
 * Rename one entry inside its own directory.
 * @param path - absolute path inside the vault.
 * @param name - the new basename.
 * @returns the new absolute path.
 */
export async function renameEntry(path: string, name: string): Promise<VaultPathResult> {
  return await request<VaultPathResult>(VaultRoute.rename, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path, name }),
  })
}

/**
 * Copy one file to a sibling name.
 *
 * The Host copies bytes, not text: this route is the one the copy command uses, and it never
 * parses or rewrites the document.
 * @param path - absolute path of the file to copy.
 * @param name - the copy's basename, in the same directory.
 * @returns the new absolute path.
 */
export async function copyEntry(path: string, name: string): Promise<VaultPathResult> {
  return await request<VaultPathResult>(VaultRoute.copy, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path, name }),
  })
}

/**
 * Move one entry into another directory of the same vault.
 *
 * Separate from {@link renameEntry} because a basename cannot name a new parent,
 * and because this is the one call that changes where a document lives.
 * @param path - absolute path inside the vault.
 * @param directory - absolute directory inside the vault to move it into.
 * @returns the entry's new absolute path.
 */
export async function moveEntry(path: string, directory: string): Promise<VaultPathResult> {
  return await request<VaultPathResult>(VaultRoute.move, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path, directory }),
  })
}

/**
 * Every directory of the authorized root, for the move picker.
 * @returns the directories in walk order, the root first.
 */
export async function listVaultDirectories(): Promise<VaultDirectoriesResult> {
  return await request<VaultDirectoriesResult>(VaultRoute.directories, { method: 'GET' })
}

/**
 * Delete one entry.
 * @param path - absolute path inside the vault.
 * @param recursive - whether a directory may be removed with its contents.
 */
export async function removeEntry(path: string, recursive: boolean): Promise<void> {
  await request<{ ok: true }>(VaultRoute.remove, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path, recursive }),
  })
}

/**
 * Create one directory.
 *
 * `recursive` means "make sure it is there": an existing directory is then a success rather
 * than a `409`. The order document's `.config` is created that way, because the first drag
 * and every drag after it ask for the same thing.
 * @param path - absolute parent directory inside the vault.
 * @param name - the new directory's basename.
 * @param recursive - whether an existing directory is acceptable.
 * @returns the created path.
 */
export async function makeDirectory(
  path: string,
  name: string,
  recursive?: boolean,
): Promise<VaultPathResult> {
  return await request<VaultPathResult>(VaultRoute.makeDirectory, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path, name, recursive }),
  })
}

/**
 * Show one entry in the platform's file manager.
 *
 * Only the Host can do this — the desktop shell is a main-process capability —
 * so it goes through the same route family as the rest of the vault operations
 * and is contained-checked there.
 * @param path - absolute path inside the vault.
 */
export async function revealEntry(path: string): Promise<void> {
  await request<{ ok: true }>(VaultRoute.reveal, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path }),
  })
}

/**
 * Keep one entry out of the platform file manager's default view.
 *
 * For the plugin's own two folders — the vault's `.img` and `.config` — so a writer who never
 * turns on "show hidden files" does not have to look at them. Only the Host can do it (it is
 * the OS's Hidden attribute), and **nothing in the plugin reads it**: the tree keeps those two
 * names out of the root listing by comparing names.
 *
 * A path that is not there is not an error — the two folders are created lazily, so the callers
 * ask on every mount without asking whether the folder exists first.
 * @param path - absolute path inside the vault.
 * @returns when the attribute is set, or immediately on a platform where a dot is already hidden.
 */
export async function hideEntry(path: string): Promise<void> {
  await request<{ ok: true }>(VaultRoute.hide, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path }),
  })
}
