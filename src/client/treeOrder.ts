/**
 * 树的显示顺序：一个文档，以及读 / 写 / 编辑它的规则。
 *
 * 内容
 * - CONFIG_FOLDER / ORDER_FILE / TreeOrders / EMPTY_ORDERS。
 * - parseOrders / serializeOrders / orderEntries。
 * - withOrder / renameInOrder / renameOrderKey / placeCopy / sameNames。
 *
 * 行为
 * - 存在 <vault>/.config/tree.json：每个目录一份名字顺序。
 * - 只存名字，不存 id / 大小 / 时间；名字能随云同步走。
 * - 未列出的名字排在最前（文件系统稳定顺序），列出的按文档顺序。
 * - 解析宽容：坏 JSON / 未知版本 / 非数组一律丢弃；不抛。
 * - 序列化键排序、两空格缩进，两台机器同样的安排写出同样字节。
 *
 * 边界
 * - 不读写文件：读 / 比较写 / 失败提示由调用方负责。
 *
 * 相关文件
 * - 被依赖：MarkdownWorkbench.tsx、scripts/probe-units.ts。
 *
 * 改哪里
 * - 改解析：parseOrders / serializeOrders。
 * - 改排序：orderEntries。
 * - 改名 / 移动 / 复制后的落点：withOrder / renameInOrder / renameOrderKey / placeCopy。
 */
import { copyFamilyOf } from '../shared/documents'

/**
 * The plugin's configuration folder, beside the vault's own `.img`.
 *
 * The tree leaves it out for the same reason it leaves out `.img` (see
 * `MarkdownWorkbench.tsx`, where a listing enters the app's state). The order document is
 * its first tenant; if a second appears, this pair of constants moves to a module of its
 * own rather than being borrowed from here.
 */
export const CONFIG_FOLDER = '.config'

/** The order document, inside {@link CONFIG_FOLDER}. */
export const ORDER_FILE = 'tree.json'

/** The document, in the shape this module reads and writes. */
export interface TreeOrders {
  /** Format version. A file carrying any other value is ignored whole. */
  readonly version: 1
  /** Directory key (`''` is the vault root) to the ordered names inside it. */
  readonly orders: Readonly<Record<string, readonly string[]>>
}

/** The document a vault with no arrangement has. */
export const EMPTY_ORDERS: TreeOrders = { version: 1, orders: {} }

/**
 * Read the document, tolerantly and without guessing.
 *
 * Anything unexpected — not JSON, not an object, another version, a value that is not an
 * array of names — is dropped, and a document with nothing usable left is
 * {@link EMPTY_ORDERS}. Nothing here throws and nothing here reports: a file the writer
 * hand-edited into nonsense costs them the arrangement and nothing else, and the tree
 * still shows every document.
 * @param text - the file's content.
 * @returns the order it describes, or the empty one.
 */
export function parseOrders(text: string): TreeOrders {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return EMPTY_ORDERS
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return EMPTY_ORDERS
  const document = parsed as { readonly version?: unknown; readonly orders?: unknown }
  // A version this build does not know is a file written by a later one: reading it with
  // these rules would be guessing at what it means.
  if (document.version !== 1) return EMPTY_ORDERS
  const raw = document.orders
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return EMPTY_ORDERS
  const orders: Record<string, readonly string[]> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue
    const names: string[] = []
    for (const name of value) {
      // One position per name: a duplicate has no meaning a renderer could honour, so it
      // is dropped rather than kept as a second, unreachable position.
      if (typeof name !== 'string' || name === '' || names.includes(name)) continue
      names.push(name)
    }
    if (names.length > 0) orders[key] = names
  }
  return { version: 1, orders }
}

/**
 * Write the document.
 *
 * Keys are sorted so that two machines arranging the same vault produce the same bytes,
 * and the indentation is two spaces because this file is meant to be readable — and
 * editable — by the person whose vault it is.
 * @param orders - the document.
 * @returns its text.
 */
export function serializeOrders(orders: TreeOrders): string {
  const sorted: Record<string, readonly string[]> = {}
  for (const key of Object.keys(orders.orders).sort()) {
    sorted[key] = orders.orders[key] ?? []
  }
  return `${JSON.stringify({ version: 1, orders: sorted }, null, 2)}\n`
}

/**
 * One level's entries in display order.
 *
 * Entries the document does not list come **first**, in the order the level arrived
 * (the filesystem's own stable name order); the listed ones follow, in the document's
 * order. So a new document — created here or dropped in from a file manager — appears at
 * the top of its folder, and a rename performed outside this plugin does the same.
 * @param entries - one level's entries, as listed.
 * @param order - that directory's names, when the document has any.
 * @returns a new array; the input is left alone.
 */
export function orderEntries<T extends { readonly name: string }>(
  entries: readonly T[],
  order: readonly string[] | undefined,
): T[] {
  if (order === undefined || order.length === 0) return [...entries]
  const position = new Map<string, number>()
  for (const [index, name] of order.entries()) {
    if (!position.has(name)) position.set(name, index)
  }
  const placed: T[] = []
  const unplaced: T[] = []
  for (const entry of entries) {
    if (position.has(entry.name)) placed.push(entry)
    else unplaced.push(entry)
  }
  placed.sort((left, right) => (position.get(left.name) ?? 0) - (position.get(right.name) ?? 0))
  return [...unplaced, ...placed]
}

/**
 * The document with one directory's order replaced.
 *
 * The names written are the whole visible order of that level at the moment of the drag,
 * so the document always says exactly what the writer saw. An empty list drops the key
 * instead of storing an empty array: a directory with nothing in it has no order to
 * remember, and a key that says so is one more line in a file meant to stay readable.
 * @param orders - the document.
 * @param key - the directory, spelled relative to the vault root (`''` is the root).
 * @param names - the level's names, in display order.
 * @returns a new document.
 */
export function withOrder(orders: TreeOrders, key: string, names: readonly string[]): TreeOrders {
  const next: Record<string, readonly string[]> = { ...orders.orders }
  if (names.length === 0) delete next[key]
  else next[key] = [...names]
  return { version: 1, orders: next }
}

/**
 * The level's names with a new copy inserted after the source and its copy family.
 *
 * The copy belongs below the row it was made from, and among the copies already there it belongs
 * in numeric order: a gap (1, 3) gets 2 between them rather than at the end. Only the **contiguous**
 * run of the same family counts; a different row ends the group, and the copy then goes directly
 * below the source. The base and the exact suffix are what makes two names one family — the same
 * rule {@link copyFamilyOf} uses to build the name.
 * @param names - the level's names, in display order.
 * @param sourceName - the row the copy was made from.
 * @param copyName - the new copy's basename.
 * @returns a new list; the input is left alone.
 */
export function placeCopy(
  names: readonly string[],
  sourceName: string,
  copyName: string,
): string[] {
  const source = names.indexOf(sourceName)
  if (source === -1) return [...names, copyName]
  const family = copyFamilyOf(sourceName)
  const copy = copyFamilyOf(copyName)
  if (copy.base !== family.base || copy.suffix !== family.suffix) {
    // Not the same family, which the caller's naming rule should have prevented: honour
    // "directly below the source" rather than guessing at a group.
    return [...names.slice(0, source + 1), copyName, ...names.slice(source + 1)]
  }
  let at = source + 1
  while (at < names.length) {
    const nextName = names[at]
    if (nextName === undefined) break
    const next = copyFamilyOf(nextName)
    if (next.base !== family.base || next.suffix !== family.suffix || next.number === 0) break
    if (next.number > copy.number) break
    at += 1
  }
  return [...names.slice(0, at), copyName, ...names.slice(at)]
}

/**
 * The same list with one name replaced.
 *
 * A rename inside a level does not move the row, so the array keeps its shape and only
 * the string changes. Without this the renamed entry would be unlisted, and being
 * unlisted means the top of the level.
 * @param names - the level's names, in display order.
 * @param from - the old basename.
 * @param to - the new one.
 * @returns a new array.
 */
export function renameInOrder(names: readonly string[], from: string, to: string): string[] {
  return names.map(name => (name === from ? to : name))
}

/**
 * The document with one directory key renamed, descendants included.
 *
 * Renaming or moving a **folder** moves every level under it at once, and those levels
 * are filed under keys that begin with its own. One pass rewrites the key itself and
 * every key below it; nothing else in the document refers to a path.
 * @param orders - the document.
 * @param from - the directory's old key.
 * @param to - its new key.
 * @returns a new document.
 */
export function renameOrderKey(orders: TreeOrders, from: string, to: string): TreeOrders {
  const next: Record<string, readonly string[]> = {}
  for (const [key, names] of Object.entries(orders.orders)) {
    if (key === from) next[to] = names
    else if (key.startsWith(`${from}/`)) next[`${to}${key.slice(from.length)}`] = names
    else next[key] = names
  }
  return { version: 1, orders: next }
}

/**
 * Whether two name lists say the same thing.
 *
 * The drag path uses it to recognise a drop that changed nothing — onto the gap it came
 * from, or onto its own row — and skip the write entirely.
 * @param left - one list.
 * @param right - another.
 * @returns whether they are equal, element by element.
 */
export function sameNames(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((name, index) => name === right[index])
}
