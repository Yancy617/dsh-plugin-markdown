/**
 * 两半共用的线协议。
 *
 * 内容
 * - VAULT_BASE / VaultRoute / PluginRoute。
 * - 请求 / 响应类型：Vault*Request / Vault*Result / UpdateCheckResult。
 * - 错误码：ERR_*、SAMPLE_READ_ONLY_MESSAGE、MAX_ASSET_BYTES。
 *
 * 行为
 * - 只有字符串常量与类型，无 import、无运行时依赖。
 * - 路由名只在这里写一次；两半都从这里取。
 *
 * 边界
 * - 不实现路由（src/index.ts、src/host/*）。
 *
 * 相关文件
 * - 被依赖：src/index.ts、src/host/*、src/client/*。
 *
 * 改哪里
 * - 改路由：VaultRoute / PluginRoute。
 * - 改载荷：对应 Vault* 类型。
 */

/** Path prefix every vault route sits under. */
export const VAULT_BASE = '/markdown-vault'

/**
 * Wire-protocol version.
 *
 * The page hot-reloads far more often than the Host process restarts, so a newer client can talk
 * to an older Host. `state` carries this number; a client that does not receive the number it
 * needs knows the Host half predates it and can say so instead of failing route by route.
 */
export const PROTOCOL_VERSION = 1

/** The routes, spelled once. */
export const VaultRoute = {
  /** `GET` — the currently authorized vault root, if any. */
  state: `${VAULT_BASE}/state`,
  /** `POST {path}` — authorize one directory as the vault. */
  authorize: `${VAULT_BASE}/authorize`,
  /** `POST` — drop the authorization. */
  revoke: `${VAULT_BASE}/authorize/revoke`,
  /** `GET ?path=` — direct children of one directory. */
  list: `${VAULT_BASE}/list`,
  /** `GET ?path=` — the full UTF-8 text of one file. */
  read: `${VAULT_BASE}/read`,
  /**
   * `GET ?path=` — one entry's freshness token, without its text.
   *
   * Its own route rather than a mode on `read`: the panel's mount check asks "did this change on
   * disk" once per open document, and reading the whole text to learn one token made every return
   * to the panel download everything that was open. `read` still answers the token when a caller
   * wants the text too — this one exists for the callers that do not.
   */
  stat: `${VAULT_BASE}/stat`,
  /** `PUT {path, content}` — write one file. */
  write: `${VAULT_BASE}/write`,
  /**
   * `POST {path, base64}` — write one binary file (an image), creating its parent
   * directory when it is missing.
   *
   * Its own route rather than a field on `write`, because the two are different
   * operations on the filesystem as well as on the wire: `write` goes through
   * `ctx.fs.writeText`, which is UTF-8 and carries a compare-and-set guard, while
   * a picture's bytes have to be written as bytes. The provider has `readBytes`
   * and no `writeBytes`, so this route is the one place the host reaches for
   * `node:fs` directly — the same move it already makes for mkdir, rename and
   * delete.
   *
   * A destination that already exists is **refused**, never overwritten, so a
   * name collision costs a retry instead of someone's picture.
   */
  asset: `${VAULT_BASE}/asset`,
  /** `POST {path, name}` — rename one entry inside its own directory. */
  rename: `${VAULT_BASE}/rename`,
  /**
   * `POST {path, name}` — copy one file to a sibling name.
   *
   * Its own route rather than a field on `write`, because a copy is byte-for-byte: it goes through
   * `node:fs.copyFile`, not through the UTF-8 text writer, so BOM, line endings and every other
   * byte reach the new file unchanged. The destination is a **name in the source's own directory**,
   * and an existing name is refused rather than overwritten.
   */
  copy: `${VAULT_BASE}/copy`,
  /**
   * `POST {path, directory}` — move one entry into another directory of the same
   * vault.
   *
   * Its own route rather than a field on `rename`: that route's contract is
   * "rename one entry **inside its own directory**", and a basename cannot name a
   * different parent. It is also the one operation here that changes where a
   * document lives, which is why the client treats it as a transaction rather
   * than a single write — see `docs/方案-拖动排序与移动.md`.
   */
  move: `${VAULT_BASE}/move`,
  /**
   * `GET` — every directory of the authorized root, for the move picker.
   *
   * `GET` with no path, like `search`: the caller names nothing and the host walks
   * whatever root is authorized, so "which directories may I move into" cannot be
   * pointed anywhere else. Dot-directories are left out — `.img` and `.config` are
   * the plugin's own material, and a note moved into them would leave the tree.
   */
  directories: `${VAULT_BASE}/directories`,
  /** `POST {path, recursive}` — delete one file, or one directory tree. */
  remove: `${VAULT_BASE}/delete`,
  /** `POST {path, name}` — create one directory. */
  makeDirectory: `${VAULT_BASE}/mkdir`,
  /**
   * `POST {path}` — show one entry in the platform's file manager.
   *
   * Not a filesystem operation: it asks the desktop host to reveal the path. It
   * lives under this prefix because it is scoped the same way — the path is
   * checked against the authorized root before anything is revealed.
   */
  reveal: `${VAULT_BASE}/reveal`,
  /**
   * `POST {path}` — keep one entry out of the platform file manager's default view.
   *
   * Not a filesystem operation either: it sets the OS's **Hidden attribute** (Windows) and
   * does nothing where a leading dot is already hidden (macOS, Linux). It exists for the
   * plugin's own two folders — the vault's `.img` and `.config` — which a writer who never
   * turns on "show hidden files" should not have to look at. A path that is not there is not
   * an error: both folders are created lazily, so "hide it if it exists" is the useful meaning.
   *
   * Nothing in the plugin reads the attribute: the tree keeps those two names out of the root
   * listing by comparing names, so this cannot change what the panel shows.
   */
  hide: `${VAULT_BASE}/hide`,
  /**
   * `POST` — report the plugin's own read-only sample vault, and where it is.
   *
   * `POST` rather than `GET` because it is a command rather than a resource: the
   * caller authorizes the path it answers with, and this route plus `authorize` is
   * the whole of "show me the samples". It writes **nothing** — the samples are the
   * package's own templates, read into memory (§6.143) — and it deliberately ignores
   * the authorized root, so it can be called when there is none.
   */
  sample: `${VAULT_BASE}/sample`,
  /**
   * `GET ?name=` — one picture the bundled samples show.
   *
   * The one route that answers with **bytes and their media type** instead of JSON, because an
   * `<img>` is what asks for it. `name` is the destination exactly as a sample document spells
   * it (`.img/示例照片.jpg`), and it is looked up in the host's own table of shipped pictures
   * rather than resolved against a directory — there is no directory behind the sample root
   * (§6.143), and that lookup is what makes an unknown name harmless.
   *
   * Separate from `sample` (which names the root) and from `asset` (which writes a picture into
   * a vault the writer authorized): this one only reads material out of this package.
   */
  sampleAsset: `${VAULT_BASE}/sample-asset`,
  /**
   * `GET ?name=` — one document the bundled samples consist of, as text.
   *
   * `name` is a file name out of this package's own table of templates (`关于.md`), and it is
   * looked up there rather than resolved against a directory — the same "the list is the check"
   * property `sampleAsset` has, and for the same reason: there is nothing behind the sample root
   * for a path to be resolved against.
   *
   * **Separate from `read`, and that is the point of it.** `sample` + `authorize` is how the
   * samples are *shown*: the writer has no directory of their own, the sample root is authorized,
   * and `read` answers from memory. This route is how one of them is opened **while the writer's
   * own directory is authorized** — the settings menu offers two of them whatever root is in use,
   * and `read` would refuse those paths as outside that root (correctly: they are not the
   * writer's). Like `sample` and `sampleAsset`, it ignores the authorized root entirely.
   */
  sampleDocument: `${VAULT_BASE}/sample-document`,
  /**
   * `POST {query}` — search the authorized root's Markdown files.
   *
   * Scoped to the root by construction: the caller supplies only the query, and
   * the host searches whatever directory is authorized. That makes "search my
   * directory" the whole of the contract, rather than a path the client could
   * point at anything.
   */
  search: `${VAULT_BASE}/search`,
} as const

/** How one directory child presents. */
export type VaultEntryType = 'file' | 'directory' | 'other'

/** One direct child of a listed directory. */
export interface VaultEntry {
  /** Basename inside the listed directory. */
  readonly name: string
  /** What the child is. */
  readonly type: VaultEntryType
  /** Byte size, present only when the backend reports it for a regular file. */
  readonly size?: number | undefined
}

/** `GET state` — the authorized root, and which kind of root it is. */
export interface VaultStateResult {
  /** Absolute directory currently in use, or `null` before anything is. */
  readonly root: string | null
  /**
   * Wire-protocol version of the Host that answered.
   *
   * Optional because a Host built before this field existed is exactly the case it exists to
   * report: absent means "older than any protocol that carried a number".
   */
  readonly protocol?: number
  /**
   * Where that root came from.
   *
   * `root` alone cannot answer this: the bundled samples are authorized under the same
   * slot as a directory the writer picked, precisely so that one set of routes serves
   * both. The sidebar needs the difference — it shows a picker and two flat documents for
   * `sample`, and a path, a toolbar and a tree for `user` — so the host, which owns the
   * sample root's spelling, reports it.
   */
  readonly kind: 'sample' | 'user' | null
}

/** `POST search` — one matched line. */
export interface VaultSearchHit {
  /** 1-based line number inside its file. */
  readonly line: number
  /** The matched line's text. */
  readonly text: string
}

/** `POST search` — one file's matches. */
export interface VaultSearchFile {
  /** Absolute path of the file. */
  readonly path: string
  /** Its matches, in the engine's order. */
  readonly matches: readonly VaultSearchHit[]
}

/** `POST search` — the normalized result, whatever engine produced it. */
export interface VaultSearchResult {
  /** Matches grouped by file. */
  readonly files: readonly VaultSearchFile[]
  /** Matches found before any cap. */
  /** Whether the engine capped the result it returned. */
  readonly truncated: boolean
  /**
   * Why the search could not run, when it could not.
   *
   * Absent on a search that simply found nothing, so the UI can tell "no matches"
   * apart from "the engine is unavailable".
   */
  readonly unavailable?: string
}

/** `GET list` — one directory level. */
export interface VaultListResult {
  /** Absolute directory that was listed. */
  readonly path: string
  /** Direct children in the backend's stable name order. */
  readonly entries: readonly VaultEntry[]
}

/** `GET read` — one file's text. */
export interface VaultReadResult {
  /** Absolute file path. */
  readonly path: string
  /** Complete UTF-8 content. */
  readonly content: string
  /**
   * Freshness token for the content just read. Echo it back on write for a
   * compare-and-set instead of an unconditional overwrite.
   */
  readonly version: string
}

/**
 * `GET stat` — one entry's identity, without its text.
 *
 * The same token {@link VaultReadResult.version} carries, for the callers whose whole question is
 * "is this still the file I read". `type` and `size` come from the same observation and cost
 * nothing extra; nothing in the panel branches on them yet, and they are here so a caller that
 * needs them does not have to ask for the text to get them.
 */
export interface VaultStatResult {
  /** Absolute path, as the Host spells it. */
  readonly path: string
  /** Freshness token, the same kind a read carries. */
  readonly version: string
  /** Whether it is a regular file, a directory, or something else. */
  readonly type: VaultEntryType
  /** Byte size, only for a regular file the backend can measure. */
  readonly size?: number | undefined
}

/** `PUT write` — the outcome of one write. */
export interface VaultWriteResult {
  /** Absolute file path. */
  readonly path: string
  /** Whether the file was created or replaced. */
  readonly operation: 'create' | 'update'
  /**
   * Freshness token of the file **after** the write — the same kind of token
   * {@link VaultReadResult.version} carries.
   *
   * It is here so a writer that has just written does not have to read the whole
   * file back to learn the token its next compare-and-set needs. `ctx.fs`'s
   * `FsWriteOutcome` already returns it (`@deepseek-ai/dsh-fs`'s types: *"Opaque
   * version of the file after the write"*), so this is a pass-through, not a new
   * fact.
   *
   * **Optional on purpose**: a client can be newer than the host it is talking to
   * (the page is reloaded far more often than the Host is restarted). Absent means
   * "this host does not report it yet" and the caller falls back to reading the
   * file — the behaviour that existed before this field.
   */
  readonly version?: string
}

/**
 * `POST authorize` body.
 */
export interface VaultAuthorizeRequest {
  /** Absolute directory the user picked. */
  readonly path: string
}

/**
 * `PUT write` body.
 */
export interface VaultWriteRequest {
  /** Absolute file path inside the authorized root. */
  readonly path: string
  /** Full replacement content. */
  readonly content: string
  /**
   * Version the writer last read, when it has one. Supplying it turns the write
   * into a compare-and-set, so an edit made outside the editor is refused
   * instead of silently overwritten.
   */
  readonly expectedVersion?: string | undefined
}

/** Every failure answers with this shape and a non-2xx status. */
export interface VaultFailure {
  /** Stable machine-readable code. */
  readonly error: string
  /** Human-readable detail. */
  readonly message: string
}

/** One resulting absolute path. */
export interface VaultPathResult {
  /** Absolute path the operation produced. */
  readonly path: string
}

/** `POST rename` body. */
export interface VaultRenameRequest {
  /** Absolute path of the entry to rename. */
  readonly path: string
  /** New basename; must not contain a path separator. */
  readonly name: string
}

/**
 * `POST copy` body.
 *
 * A sibling copy: the source's directory is kept and only the basename changes, so the copy's
 * relative image destinations still point at the same files.
 */
export interface VaultCopyRequest {
  /** Absolute path of the file to copy. */
  readonly path: string
  /** New basename inside the same directory; must not contain a path separator. */
  readonly name: string
}

/**
 * `POST move` body.
 *
 * The destination is a **directory**, and the name is kept: this is a move, not a
 * rename. Both halves check that the destination is inside the moved entry's own
 * subtree and refuse — a folder cannot be dropped into itself.
 */
export interface VaultMoveRequest {
  /** Absolute path of the entry to move. */
  readonly path: string
  /** Absolute directory inside the root to move it into. */
  readonly directory: string
}

/** One directory the move picker may offer. */
export interface VaultDirectoryEntry {
  /** Absolute path, which is what the move request takes. */
  readonly path: string
  /** The same directory spelled relative to the root; `''` is the root itself. */
  readonly relative: string
}

/** `GET directories` — every directory of the authorized root. */
export interface VaultDirectoriesResult {
  /** Absolute path of the authorized root. */
  readonly root: string
  /** Directories in walk order, the root first. */
  readonly directories: readonly VaultDirectoryEntry[]
  /** Whether the walk stopped at its cap. */
  readonly truncated: boolean
}

/** `POST delete` body. */
export interface VaultRemoveRequest {
  /** Absolute path of the entry to delete. */
  readonly path: string
  /**
   * Whether a directory may be removed with its contents. Absent means a
   * directory is refused, so an accidental delete cannot take a subtree.
   */
  readonly recursive?: boolean | undefined
}

/** `POST mkdir` body. */
export interface VaultMakeDirectoryRequest {
  /** Absolute path of the parent directory. */
  readonly path: string
  /** New directory basename; must not contain a path separator. */
  readonly name: string
  /**
   * Whether "it is already there" is success rather than a refusal.
   *
   * Added for the order document's `.config`, which is created by the first drag and by
   * every drag after it: the caller wants "make sure this directory exists", and asking it
   * to stat first would leave a window in which two writers both create it. Absent or
   * false keeps the command's own meaning — a name that is taken is refused.
   */
  readonly recursive?: boolean | undefined
}

/** `POST reveal` body. */
export interface VaultRevealRequest {
  /** Absolute path of the entry to show in the platform's file manager. */
  readonly path: string
}

/** `POST hide` body. */
export interface VaultHideRequest {
  /** Absolute path of the entry to keep out of the file manager's default view. */
  readonly path: string
}

/**
 * `POST asset` body.
 *
 * `base64` rather than a binary body: the plugin's routes all speak JSON, and
 * every write this plugin performs goes through one reading of the request. The
 * cost is a third more bytes on the wire for a file that is capped anyway.
 */
export interface VaultAssetRequest {
  /** Absolute path of the file to create. Its parent is created when missing. */
  readonly path: string
  /** Complete file content, standard base64 with padding. */
  readonly base64: string
}

/**
 * Largest asset the route accepts, in bytes.
 *
 * The platform's own file route serves at most `maxImageBytes` (20 MiB by
 * default, read from `dsh-attachment-local`), so a larger picture would be
 * written to disk and then never displayed by the editor — a file that only
 * exists to fail. The same number is the honest cap here.
 */
export const MAX_ASSET_BYTES = 20 * 1024 * 1024

/** Failure code: no vault has been authorized yet. */
export const ERR_NO_VAULT = 'no-vault'

/** Failure code: the requested path is outside the authorized root. */
export const ERR_OUTSIDE = 'outside-vault'

/** Failure code: the requested path is missing or the wrong kind. */
export const ERR_NOT_FOUND = 'not-found'

/** Failure code: the request itself was malformed. */
export const ERR_BAD_REQUEST = 'bad-request'

/** Failure code: anything the filesystem refused. */
export const ERR_FILESYSTEM = 'filesystem'

/**
 * Failure code: the write's version guard rejected it, so someone else changed
 * the file first.
 *
 * Its own code rather than `ERR_FILESYSTEM` because it is the one write failure
 * the writer can act on — keep mine, take theirs, or look at both. Folded into
 * the generic code it reached the UI indistinguishable from a permissions error,
 * leaving a message string as the only clue.
 */
export const ERR_STALE = 'stale-version'

/**
 * Failure code: the operation would change the plugin's own read-only samples.
 *
 * The samples are the package's templates, held in memory by the Host: there is no file
 * to change, nothing that could be changed even in principle, and every write aimed at
 * them is refused as such rather than as a filesystem error. Its own code because it is
 * not a failure of the filesystem and not something a retry can fix — see §6.143.
 */
export const ERR_SAMPLE_READ_ONLY = 'sample-read-only'

/**
 * What that refusal says, in the words both halves use.
 *
 * One sentence for one fact: the Host refuses a write with it, and the client answers a
 * save aimed at the samples with it and no round trip. Two copies would be two things to
 * keep in step, and the reader would be told different things about the same document.
 */
export const SAMPLE_READ_ONLY_MESSAGE = '这是插件自带的只读示例，改动不会保存'

/**
 * The package this plugin is published as.
 *
 * Both halves need it and neither may guess it: the Host asks the registry about it, and
 * the panel prints it inside the upgrade command. One constant so a rename cannot leave
 * the notice telling the writer to upgrade a different package.
 */
export const PACKAGE_NAME = '@yancy617/dsh-plugin-markdown'

/**
 * The plugin's **own** routes — the ones that are not about the vault.
 * Its own map rather than more entries in {@link VaultRoute}: that one's contract is
 * "one operation on the authorized directory", and every entry there is scoped to the
 * writer's root. These are about **this package** (its version, and the registry's idea
 * of the latest one), which is a different subject that happens to share the same HTTP
 * channel and the same path prefix.
 */
export const PluginRoute = {
  /**
   * `GET` — the installed version of this plugin and the registry's `latest`.
   *
   * The one route in this plugin that makes an **outbound** request: the Host asks
   * `registry.npmjs.org` for this package's `dist-tags.latest`. It is deliberately the
   * only one, it is only reached when the writer asks (命令面板的「检查更新」), and it
   * **reads nothing on disk and writes nothing anywhere**.
   */
  updateCheck: `${VAULT_BASE}/update-check`,
} as const

/**
 * What one update check concluded.
 *
 * Four outcomes for four things the writer can be told; the panel turns each into one
 * notice, so "no news" never looks like "failed".
 */
export type UpdateCheckOutcome =
  /** The registry's latest is strictly newer than the installed version. */
  | 'stale'
  /** Same version, or the installed one is newer (a local build). */
  | 'current'
  /** The check could not be completed; `reason` says why, in one sentence. */
  | 'failed'

/** `GET updateCheck` — see {@link UpdateCheckOutcome}. */
export interface UpdateCheckResult {
  /** Which of the three outcomes this is. */
  readonly outcome: UpdateCheckOutcome
  /** Version of the plugin that is running right now, when it could be read. */
  readonly current?: string | undefined
  /** The registry's `dist-tags.latest`, when the lookup succeeded. */
  readonly latest?: string | undefined
  /** Why the check failed; absent unless `outcome` is `failed`. */
  readonly reason?: string | undefined
}
