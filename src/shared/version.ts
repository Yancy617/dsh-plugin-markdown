/**
 * 版本比较：更新检查需要的那一点。
 *
 * 内容
 * - VERSION / ParsedVersion / parseVersion / comparePrerelease / compareVersions。
 *
 * 行为
 * - 解析 MAJOR.MINOR.PATCH[-pre][+build]，允许一个前导 v。
 * - 数字段按数值比；预发布按段比，数字段按数值、其余按文本。
 * - 同号正式版高于预发布版。
 * - 无法解析返回 null；null 不是 0。
 *
 * 边界
 * - 不是 semver range 解析器。
 *
 * 相关文件
 * - 被依赖：src/host/updateCheck.ts、scripts/probe-units.ts。
 *
 * 改哪里
 * - 改解析：parseVersion。
 * - 改比较：compareVersions / comparePrerelease。
 */

const VERSION = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

/** One parsed version: numbers, plus the optional prerelease segments. */
interface ParsedVersion {
  readonly parts: [number, number, number]
  /** Prerelease segments, empty for a release. */
  readonly pre: readonly string[]
}

/**
 * Parse `MAJOR.MINOR.PATCH[-pre][+build]`, allowing one leading `v`.
 * @param version - the string to parse.
 * @returns the parsed form, or `null` when it is not a version this module understands.
 */
function parseVersion(version: string): ParsedVersion | null {
  const match = VERSION.exec(version.trim())
  if (match === null) return null
  const [, major, minor, patch, pre] = match
  return {
    parts: [Number(major), Number(minor), Number(patch)],
    pre: pre === undefined ? [] : pre.split('.'),
  }
}

/**
 * Compare two prerelease segment lists.
 * @param left - one list.
 * @param right - the other.
 * @returns `-1`, `0` or `1`.
 */
function comparePrerelease(left: readonly string[], right: readonly string[]): number {
  // A release outranks any prerelease of the same numbers: `0.2.0` > `0.2.0-rc.1`.
  if (left.length === 0 && right.length === 0) return 0
  if (left.length === 0) return 1
  if (right.length === 0) return -1

  const length = Math.min(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const a = left[index] ?? ''
    const b = right[index] ?? ''
    if (a === b) continue
    const numeric = /^\d+$/.test(a) && /^\d+$/.test(b)
    // Numbers compare numerically (`rc.10` > `rc.9`); anything else compares as text.
    if (numeric) return Number(a) < Number(b) ? -1 : 1
    return a < b ? -1 : 1
  }
  // Every shared segment matched: the shorter list is the older one (`1.0.0-rc` < `1.0.0-rc.1`).
  if (left.length === right.length) return 0
  return left.length < right.length ? -1 : 1
}

/**
 * Compare two versions.
 *
 * @param left - one version, with or without a leading `v`.
 * @param right - the other.
 * @returns `-1` when `left` is older, `1` when newer, `0` when equal — and `null`
 * when either string is not a version this module understands. **`null` is not `0`**:
 * callers must not read "cannot tell" as "equal".
 */
export function compareVersions(left: string, right: string): number | null {
  const a = parseVersion(left)
  const b = parseVersion(right)
  if (a === null || b === null) return null

  for (let index = 0; index < 3; index += 1) {
    const x = a.parts[index] ?? 0
    const y = b.parts[index] ?? 0
    if (x !== y) return x < y ? -1 : 1
  }
  return comparePrerelease(a.pre, b.pre)
}
