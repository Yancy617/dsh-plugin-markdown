/**
 * 路径拼写规则，两半共用。
 *
 * 内容
 * - childPath / samePath / basenameOf / dirnameOf / isHiddenName / relativePath / chainTo。
 *
 * 行为
 * - childPath 沿用 parent 的分隔符；不以固定分隔符重拼。
 * - samePath 只统一分隔符；大小写、`.`/`..`、尾分隔符不归一。
 * - basenameOf / dirnameOf 两种分隔符都认；dirnameOf 不补尾分隔符。
 * - isHiddenName 只回答“名字以点开头”，与目录还是文件无关。
 * - relativePath 以 root 为基准，`''` 表示 root 本身；不在下面返回 null。
 * - chainTo 返回从 root 下一层到 path 的每一级路径。
 *
 * 边界
 * - 不访问文件系统、不判断路径是否存在。
 *
 * 相关文件
 * - 被依赖：src/client/*、src/host/*。
 *
 * 改哪里
 * - 改拼写：childPath。
 * - 改比较：samePath / relativePath。
 */

/**
 * Join a child name onto a directory path.
 *
 * The separator is the one the parent already uses, never a fixed one.
 * @param parent - absolute directory path, in whatever spelling it arrived.
 * @param name - child basename.
 * @returns the child's path, spelled like its parent.
 */
export function childPath(parent: string, name: string): string {
  if (parent.endsWith('/') || parent.endsWith('\\')) return `${parent}${name}`
  return parent.includes('\\') ? `${parent}\\${name}` : `${parent}/${name}`
}

/**
 * Whether two spellings name the same entry.
 *
 * Only the separator is reconciled. Case, `.`/`..` and trailing separators are left
 * alone: normalising those would be guessing at what the Host considers the same
 * file, and a wrong guess here reads as a missing document.
 * @param left - one path.
 * @param right - another.
 * @returns whether they are the same entry.
 */
export function samePath(left: string, right: string): boolean {
  return left === right || left.replace(/\\/g, '/') === right.replace(/\\/g, '/')
}

/**
 * The final segment of a path, in either separator.
 *
 * Beside {@link samePath} because it answers the other half of "which entry is this": the
 * directory a path sits in and the name it has there. Written once so the Host, the tree and the
 * image code cannot come to three different answers about the same spelling.
 * @param path - absolute path.
 * @returns its last segment.
 */
export function basenameOf(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return cut === -1 ? path : path.slice(cut + 1)
}

/**
 * The directory a path sits in, with no trailing separator.
 *
 * Deliberately not "the parent directory" in the `path.dirname` sense: no normalisation, no
 * resolution, no trailing separator added — the callers compare the result with paths they
 * already hold, and a normalised spelling would miss.
 * @param path - absolute path.
 * @returns its parent directory, spelled as the input.
 */
export function dirnameOf(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return cut <= 0 ? path : path.slice(0, cut)
}

/**
 * Whether a name starts with a dot.
 *
 * The one rule three walks had their own copy of (the Host's directory walk and search scan, and
 * the client's move walk). A leading dot is how this program hides its own material and how the
 * platform's default view already treats a name, so the answer is the same everywhere.
 * @param name - one directory entry's basename.
 * @returns whether it is a hidden name.
 */
export function isHiddenName(name: string): boolean {
  return name.startsWith('.')
}

/**
 * One path as it is spelled relative to a directory above it.
 *
 * This is the key the custom order document is filed under (`''` is the vault's
 * own root), so the two halves have to agree on it exactly — and they do by
 * construction: a root arrives from the provider as `displayPath`, and every path
 * below it was built with {@link childPath} from that same string. Case is
 * therefore **not** reconciled here, the way {@link samePath} deliberately does
 * not reconcile it: a case-insensitive match would guess at whether two spellings
 * are one directory, and a wrong guess files a level's order under a key nothing
 * reads.
 *
 * Only the separator and a trailing separator on `root` are reconciled, because
 * those are the two spellings the same directory legitimately arrives in.
 * @param root - absolute directory the result is relative to.
 * @param path - absolute path at or below `root`.
 * @returns the relative path in `/` spelling (`''` for `root` itself), or `null`
 *   when `path` is not below `root`.
 */
export function relativePath(root: string, path: string): string | null {
  const base = root.replace(/\\/g, '/').replace(/\/+$/, '')
  const full = path.replace(/\\/g, '/')
  if (full === base) return ''
  if (!full.startsWith(`${base}/`)) return null
  return full.slice(base.length + 1)
}

/**
 * Every path from a root down to one below it, the destination last.
 *
 * Beside {@link relativePath} because it is the same question one step further on: which
 * directories is this one made of. The walk is spelled from `root`'s own separator, so the chain
 * is made of paths this program can compare with the ones it already holds.
 *
 * The tree uses it to **open the way** to a folder something has just been moved into: a level
 * that is not open is not drawn, and the move dialog can name a folder three levels inside a
 * branch nobody has opened.
 * @param root - the directory the walk starts from; it is not part of the result.
 * @param path - the path to walk down to.
 * @returns the chain, empty when `path` is `root` or is not below it.
 */
export function chainTo(root: string, path: string): string[] {
  const rest = relativePath(root, path)
  if (rest === null || rest === '') return []
  const chain: string[] = []
  let current = root
  for (const segment of rest.split('/')) {
    current = childPath(current, segment)
    chain.push(current)
  }
  return chain
}
