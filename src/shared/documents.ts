/**
 * “什么算一篇文档”：树、搜索、示例三处共用的唯一判据。
 *
 * 内容
 * - DOCUMENT_SUFFIXES / DOCUMENT_INCLUDE_GLOB / isDocument / documentSuffix / documentLabel /
 *   createdDocumentName / renamedDocumentName / copyFamilyOf / nextCopyName / visibleEntries。
 *
 * 行为
 * - 后缀表是唯一来源：客户端树的显示名按它剥后缀，Host 搜索按它生成 include 通配，
 *   重命名按它把格式接回去。
 * - 大小写不敏感（`.MD` 也算），只按文件名后缀判断，不看路径。
 * - visibleEntries 保留目录，文件只留 isDocument 认的那几种。
 *
 * 边界
 * - 不访问文件系统、不判断文件是否存在。
 * - 不负责名字的显示排版（那是树 / 标签的事），只回答“叫什么、算不算”。
 *
 * 相关文件
 * - 依赖：shared/protocol（VaultEntry 类型）。
 * - 被依赖：src/client/workbench/*、src/host/search.ts、scripts/probe-units.ts。
 *
 * 改哪里
 * - 改认哪些文件：DOCUMENT_SUFFIXES。
 * - 改显示名 / 重命名后的名字：documentLabel / renamedDocumentName。
 * - 改副本命名：copyFamilyOf / nextCopyName。
 * - 改树里显示哪些：visibleEntries。
 */
import type { VaultEntry } from './protocol'

/** File-name suffixes this product opens as documents. */
export const DOCUMENT_SUFFIXES: readonly string[] = ['.md', '.markdown', '.txt', '.mdx']

/**
 * The one glob the harness's `grep` tool is asked for, derived from
 * {@link DOCUMENT_SUFFIXES} so search cannot fall behind the tree.
 *
 * Derived rather than written twice: the tool takes a single glob filter, so a list here and a
 * pattern there is exactly how `.txt` notes came to be visible in the tree but absent from search.
 * `{a,b}` alternation is globset syntax, which is what the tool parses.
 */
export const DOCUMENT_INCLUDE_GLOB = `*.{${DOCUMENT_SUFFIXES.map(suffix => suffix.slice(1)).join(',')}}`

/**
 * @param name - a file's basename.
 * @returns whether the tree offers it as a document.
 */
export function isDocument(name: string): boolean {
  const lower = name.toLowerCase()
  return DOCUMENT_SUFFIXES.some(suffix => lower.endsWith(suffix))
}

/**
 * The format a document's name carries.
 *
 * The one place the suffix is recognised, so the label that strips it and the rename that puts it
 * back cannot disagree about which spelling was the format.
 * @param name - a file's basename, extension and all.
 * @returns the suffix including its dot, or `null` when the name has none this product knows.
 */
export function documentSuffix(name: string): string | null {
  const lower = name.toLowerCase()
  return DOCUMENT_SUFFIXES.find(candidate => lower.endsWith(candidate)) ?? null
}

/**
 * A document's name as a reader sees it, without the format.
 *
 * The suffix is a fact about the file rather than part of what it is called: every row is a
 * document, so it is the same all the way down a column and is noise in the one place that already
 * has to ellipsise. Driven by {@link DOCUMENT_SUFFIXES} so the two cannot disagree.
 * @param name - a file's basename, extension and all.
 * @returns what to show for it.
 */
export function documentLabel(name: string): string {
  const suffix = documentSuffix(name)
  return suffix === null ? name : name.slice(0, -suffix.length)
}

/**
 * The parts a copy name is built from.
 *
 * A name is a copy when its stem ends in ` 副本` optionally followed by digits: `笔记 副本1`
 * carries number 1, `笔记 副本` carries 0 (the marker with no number yet), and `笔记` carries 0
 * because it has no marker at all. The extension is kept exactly as the file spells it, so
 * `.MD` stays `.MD` in the copy.
 */
export interface CopyFamily {
  /** The stem with any trailing ` 副本<digits>` removed. */
  readonly base: string
  /** The extension exactly as the name spells it (empty when the name has none). */
  readonly suffix: string
  /** The number the name carries; 0 when it carries none. */
  readonly number: number
}

/** A trailing ` 副本` plus optional digits, at the end of the stem. */
const COPY_MARKER = /^(.*) 副本(\d*)$/u

/**
 * Split a name into the parts a copy name is built from.
 * @param name - a file's basename.
 * @returns the base, the exact suffix, and the copy number the name already carries.
 */
export function copyFamilyOf(name: string): CopyFamily {
  const stem = documentLabel(name)
  const suffix = name.slice(stem.length)
  const marker = COPY_MARKER.exec(stem)
  if (marker === null) return { base: stem, suffix, number: 0 }
  const digits = marker[2] ?? ''
  const parsed = digits === '' ? 0 : Number.parseInt(digits, 10)
  return {
    base: marker[1] ?? '',
    suffix,
    number: Number.isSafeInteger(parsed) ? parsed : 0,
  }
}

/**
 * The first free copy name for one document.
 *
 * The number starts after the one the source already carries (1 for a source without a marker)
 * and walks upward until the name is free: a gap left by a deleted copy is filled rather than
 * skipped, and a number that is already taken is never reused. The caller passes every entry in
 * the directory, not only the visible documents, so a directory or a non-document file with the
 * candidate name still counts as taken.
 * @param name - the source document's basename.
 * @param taken - every name in the same directory (the source included).
 * @returns the basename the copy should get.
 */
export function nextCopyName(name: string, taken: ReadonlySet<string>): string {
  const { base, suffix, number } = copyFamilyOf(name)
  let next = number + 1
  let candidate = `${base} 副本${next}${suffix}`
  while (taken.has(candidate)) {
    next += 1
    candidate = `${base} 副本${next}${suffix}`
  }
  return candidate
}

/**
 * The file name a “new document” prompt creates from the name that was typed.
 *
 * A typed name that already carries an extension is used as it is, which is what lets the writer
 * create a `.txt` note by typing one; a name without one gets the default `.md`. Beside the other
 * name-shaping functions so the dialog's preview and the request it sends cannot disagree about
 * what will be created.
 * @param typedName - the name field's trimmed value.
 * @returns the basename to create.
 */
export function createdDocumentName(typedName: string): string {
  return /\.[A-Za-z0-9]+$/.test(typedName) ? typedName : `${typedName}.md`
}

/**
 * The file name a rename produces when the dialog edits only the name.
 *
 * Renaming a document shows its label, not its file name, so the format is not something the
 * writer types: it is taken from the file being renamed and put back here. A typed name that
 * already ends with that same suffix is left alone, which is what keeps a paste of the full name
 * from becoming `note.md.md`; any other trailing text — including another format-looking suffix —
 * is part of the name. Unchanged input returns the current name, so the caller can treat it as
 * "nothing to do" rather than asking the platform to rename a file onto itself.
 * @param currentName - the file's basename as it is on disk.
 * @param typedName - what the writer typed, already trimmed.
 * @returns the basename to rename to.
 */
export function renamedDocumentName(currentName: string, typedName: string): string {
  const suffix = documentSuffix(currentName)
  if (suffix === null) return typedName
  // Only the format was typed: there is no name in it, and accepting it would leave a document
  // the tree can no longer show. Treated as "nothing changed", like the untouched label.
  if (typedName === '' || typedName.toLowerCase() === suffix.toLowerCase()) return currentName
  if (typedName === documentLabel(currentName)) return currentName
  if (typedName.toLowerCase().endsWith(suffix.toLowerCase())) return typedName
  return `${typedName}${suffix}`
}

/**
 * The entries one level shows.
 *
 * One place decides what a row is, because two callers need the same answer from different
 * directions: the tree draws them, and a drag writes the level's order back as the names of
 * exactly these.
 * @param entries - one level's entries, as listed.
 * @returns the ones the tree draws.
 */
export function visibleEntries(entries: readonly VaultEntry[]): VaultEntry[] {
  return entries.filter(
    entry => entry.type === 'directory' || (entry.type === 'file' && isDocument(entry.name)),
  )
}
