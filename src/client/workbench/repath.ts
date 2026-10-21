/**
 * 条目移动之后，那些“按路径做键”的东西该怎么改写。
 *
 * 内容
 * - repathUnder / repathRecord / repathList。
 *
 * 行为
 * - 命中条目本身或它子树里的路径才改；其余原样返回。
 * - 分隔符跟随目标路径（`to` 用哪种就拼哪种）。
 * - 一处都没动时返回**原对象**，让调用方按引用判断“要不要重渲染”。
 *
 * 边界
 * - 不访问文件系统、不判断路径是否存在；不负责谁该被改写（缓存 / 标签 / 层级由调用方挑）。
 *
 * 相关文件
 * - 依赖：shared/paths（samePath / relativePath）。
 * - 被依赖：MarkdownWorkbench.tsx、scripts/probe-units.ts。
 *
 * 改哪里
 * - 改“哪些路径算受影响”：repathUnder。
 * - 改记录 / 列表的改写形状：repathRecord / repathList。
 */
import { relativePath, samePath } from '../../shared/paths'

/**
 * The path one key reads as after an entry moved, or `null` when it is untouched.
 *
 * The whole subtree, not just the entry: a folder's own row is one key, and everything filed
 * under it is spelled with its path as a prefix. Rewriting only the folder's own key leaves
 * every level below it — expanded ones, open tabs inside — pointing at a dead path.
 * @param path - an absolute path that may be the entry or something inside it.
 * @param from - the path the entry had.
 * @param to - the path it has now.
 * @returns the new spelling, or `null` when `path` is not affected.
 */
export function repathUnder(path: string, from: string, to: string): string | null {
  if (samePath(path, from)) return to
  const rest = relativePath(from, path)
  if (rest === null || rest === '') return null
  const separator = to.includes('\\') ? '\\' : '/'
  return `${to}${separator}${rest.split('/').join(separator)}`
}

/**
 * One record with every key at or under `from` re-spelled from `to`.
 *
 * Returns the input untouched when nothing moved, so a rename that affects no open tab and no
 * loaded level re-renders nothing.
 * @param record - keyed by absolute path.
 * @param from - the path the entry had.
 * @param to - the path it has now.
 * @param map - how a moved entry's value changes with its new key.
 * @returns the record to keep.
 */
export function repathRecord<T>(
  record: Record<string, T>,
  from: string,
  to: string,
  map: (key: string, value: T) => T,
): Record<string, T> {
  let changed = false
  const next: Record<string, T> = {}
  for (const [key, value] of Object.entries(record)) {
    const moved = repathUnder(key, from, to)
    if (moved === null) next[key] = value
    else {
      next[moved] = map(moved, value)
      changed = true
    }
  }
  return changed ? next : record
}

/**
 * One list of paths with every entry at or under `from` re-spelled from `to`.
 * @param paths - absolute paths.
 * @param from - the path the entry had.
 * @param to - the path it has now.
 * @returns the list to keep.
 */
export function repathList(paths: readonly string[], from: string, to: string): readonly string[] {
  let changed = false
  const next = paths.map(path => {
    const moved = repathUnder(path, from, to)
    if (moved === null) return path
    changed = true
    return moved
  })
  return changed ? next : paths
}
