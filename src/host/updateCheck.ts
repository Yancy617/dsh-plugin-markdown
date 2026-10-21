/**
 * 本插件版本与 registry 的 latest。
 *
 * 内容
 * - REGISTRY_URL / TIMEOUT_MS / installedVersion / reasonOf / checkForUpdate。
 *
 * 行为
 * - 读自身 package.json 的 version。
 * - GET registry 的 dist-tags.latest，8 秒超时，no-store。
 * - compareVersions 判定 current / stale；无法比较时按“不同”处理。
 * - 永不抛：失败变成 outcome: 'failed' + reason。
 *
 * 边界
 * - 只读：不安装、不写磁盘、不碰 vault。
 * - 只由命令触发，不设定时器。
 *
 * 相关文件
 * - 依赖：shared/protocol、shared/version、host/packageRoot。
 * - 被依赖：src/index.ts（PluginRoute.updateCheck）。
 *
 * 改哪里
 * - 改请求：checkForUpdate。
 * - 改超时：TIMEOUT_MS。
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PACKAGE_NAME, type UpdateCheckResult } from '../shared/protocol'
import { compareVersions } from '../shared/version'
import { packageRoot } from './packageRoot'

/** Where this package's registry record lives. Scoped names need the slash escaped. */
const REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE_NAME.replace('/', '%2f')}`

/**
 * How long the registry may take before the check gives up.
 *
 * Short on purpose: this runs behind a button the writer is waiting on, and a check that
 * hangs for longer than this is indistinguishable from a broken panel.
 */
const TIMEOUT_MS = 8000

/**
 * Read the version out of this package's own `package.json`.
 * @returns the version, or `undefined` when the file cannot be read or has no version.
 */
async function installedVersion(): Promise<string | undefined> {
  try {
    const manifest = JSON.parse(await readFile(join(packageRoot(), 'package.json'), 'utf8')) as {
      readonly version?: unknown
    }
    return typeof manifest.version === 'string' && manifest.version !== '' ? manifest.version : undefined
  } catch {
    return undefined
  }
}

/**
 * One sentence for a failed lookup, fit for a notice.
 * @param error - whatever was thrown.
 * @returns the reason, already user-facing.
 */
function reasonOf(error: unknown): string {
  if (!(error instanceof Error)) return '未知错误'
  if (error.name === 'AbortError') return '请求超时'
  // Node reports a refused or unresolvable request as `TypeError: fetch failed`.
  if (error.name === 'TypeError') return '连不上 registry'
  return error.message === '' ? '未知错误' : error.message
}

/**
 * Ask the registry for this package's `dist-tags.latest` and compare it with the version
 * that is running.
 *
 * **Never throws.** Every failure becomes `outcome: 'failed'` with a reason, because the
 * route has exactly one useful answer for the panel and a 500 would make the panel invent
 * the sentence instead.
 * @returns the outcome, both versions when they are known, and a reason when not.
 */
export async function checkForUpdate(): Promise<UpdateCheckResult> {
  const current = await installedVersion()
  if (current === undefined) return { outcome: 'failed', reason: '读不到插件自身版本' }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const response = await fetch(REGISTRY_URL, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: controller.signal,
      // The registry's record is small and must be fresh; nothing may answer from a cache.
      cache: 'no-store',
    })
    if (!response.ok) return { outcome: 'failed', current, reason: `registry 返回 ${response.status}` }

    let record: unknown
    try {
      record = await response.json()
    } catch {
      return { outcome: 'failed', current, reason: 'registry 返回的不是 JSON' }
    }

    const tags = (record as { 'dist-tags'?: { latest?: unknown } })['dist-tags']
    const latest = typeof tags?.latest === 'string' ? tags.latest : undefined
    if (latest === undefined || latest === '') {
      return { outcome: 'failed', current, reason: 'registry 没有 latest 版本' }
    }

    const order = compareVersions(latest, current)
    // `null` means one of the two is not a version this build understands. Saying "there is
    // a different one" is the honest answer then: it shows both numbers and claims nothing.
    const outcome = order === null ? (latest === current ? 'current' : 'stale') : order > 0 ? 'stale' : 'current'
    return { outcome, current, latest }
  } catch (error) {
    return { outcome: 'failed', current, reason: reasonOf(error) }
  } finally {
    clearTimeout(timer)
  }
}
