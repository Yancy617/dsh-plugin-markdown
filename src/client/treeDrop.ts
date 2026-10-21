/**
 * 拖动的一行可以落在哪。
 *
 * 内容
 * - DropKind / DropRow / DropSource / DropRefusal。
 * - dropKind / refuseDrop。
 *
 * 行为
 * - 文档按中线分 before / after；文件夹按四分位分 before / into / after。
 * - 拒绝三种：自己、自己的子树、目标目录已有同名（仅真正移动时查）。
 * - siblings 为 null（未加载的层级）时不查重名，交给 host 拒绝。
 *
 * 边界
 * - 不负责拖动状态与渲染（MarkdownWorkbench.tsx）。
 *
 * 相关文件
 * - 依赖：shared/paths。
 * - 被依赖：MarkdownWorkbench.tsx、scripts/probe-units.ts。
 *
 * 改哪里
 * - 改分区：dropKind。
 * - 改拒绝：refuseDrop。
 */
import { relativePath, samePath } from '../shared/paths'

/** Which part of a row the pointer is over. */
export type DropKind = 'before' | 'into' | 'after'

/** One row of the tree, as much of it as a drop needs. */
export interface DropRow {
  /** Absolute path. */
  readonly path: string
  /** Basename, which is the name the order document files rows under. */
  readonly name: string
  /** Whether it is a directory. */
  readonly isDirectory: boolean
}

/** The row being carried, which also knows where it lives now. */
export interface DropSource extends DropRow {
  /** The directory the entry is in now. */
  readonly parent: string
}

/** Why a drop is refused. */
export type DropRefusal =
  /** The destination is the entry itself. */
  | 'itself'
  /** The destination is inside the entry — the cycle only a drag can ask for. */
  | 'inside'
  /** The destination already holds something with that name. */
  | 'same-name'

/**
 * Which band of a row a pointer position falls in.
 *
 * A document is split at its middle, exactly as the shell's list does it — a document has
 * no inside to offer. A folder is split into quarters, and the middle half means "into
 * it", so an empty folder and a collapsed folder are both reachable in one gesture.
 * @param rect - the row's box, in client coordinates.
 * @param clientY - the pointer's vertical position.
 * @param isDirectory - whether the row is a folder.
 * @returns the band.
 */
export function dropKind(
  rect: { readonly top: number; readonly height: number },
  clientY: number,
  isDirectory: boolean,
): DropKind {
  const offset = clientY - rect.top
  if (!isDirectory) return offset < rect.height / 2 ? 'before' : 'after'
  if (offset < rect.height / 4) return 'before'
  if (offset > (rect.height * 3) / 4) return 'after'
  return 'into'
}

/**
 * Whether the entry being carried may land in one directory.
 *
 * Three refusals, and each is a fact about the paths rather than about the tree's state:
 *
 * 1. the directory **is** the entry — dropping a folder onto its own row;
 * 2. the directory is **inside** the entry — one `relativePath` covers the whole subtree,
 *    so the test is the same one that files the order document under its keys;
 * 3. the directory **already holds that name** — but only when the entry is actually
 *    moving: reordering inside its own directory is not a move, the name is there by
 *    definition, and checking it there would refuse sorting itself.
 *
 * `siblings` is `null` for a directory whose level has not been loaded (a collapsed or
 * empty folder), where the name cannot be checked without a request; the host refuses
 * that one and the caller reports why.
 * @param source - the row being carried.
 * @param directory - absolute directory it would land in.
 * @param siblings - that directory's visible names, or `null` when unknown.
 * @returns the reason to refuse, or `null` when the drop is allowed.
 */
export function refuseDrop(
  source: DropSource,
  directory: string,
  siblings: readonly string[] | null,
): DropRefusal | null {
  if (samePath(source.path, directory)) return 'itself'
  if (relativePath(source.path, directory) !== null) return 'inside'
  if (samePath(source.parent, directory)) return null
  if (siblings !== null && siblings.includes(source.name)) return 'same-name'
  return null
}
