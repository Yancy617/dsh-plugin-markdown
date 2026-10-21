/**
 * 仓库范围的文本搜索。
 *
 * 内容
 * - MAX_MATCHES / MAX_FILE_BYTES / MAX_FILES。
 * - ToolRegistry / fromToolPayload / searchVault。
 *
 * 行为
 * - 先试 ctx.tools 的 grep；失败一次后本进程不再试（toolRouteFailed）。
 * - 认哪些文件由 shared/documents 决定 —— 与树、示例同一套后缀，搜索不会比树少。
 * - 退路：遍历授权根，跳过点目录，整文件读，JavaScript 正则匹配。
 * - 最多 500 条、2MB/文件、5000 个文件。
 * - 返回按文件分组的结果与 truncated。
 *
 * 边界
 * - 不是 ripgrep：正则方言、.gitignore、流式读都不同。
 *
 * 相关文件
 * - 依赖：cordis、dsh-fs 类型、shared/protocol、shared/errors、shared/documents、shared/paths。
 * - 被依赖：src/index.ts。
 *
 * 改哪里
 * - 改上限：MAX_*。
 * - 改扫描：searchVault。
 * - 改工具路：fromToolPayload。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { FileSystem, FsTarget } from '@deepseek-ai/dsh-fs'
import type { VaultSearchFile, VaultSearchHit, VaultSearchResult } from '../shared/protocol'
import { messageOf } from '../shared/errors'
import { DOCUMENT_INCLUDE_GLOB, isDocument } from '../shared/documents'
import { isHiddenName } from '../shared/paths'

/** Most matches returned before the result is reported as truncated. */
const MAX_MATCHES = 500

/** Files larger than this are skipped rather than read whole. */
const MAX_FILE_BYTES = 2 * 1024 * 1024

/** Files visited before the walk gives up. */
const MAX_FILES = 5000

/**
 * The slice of the tool registry this module tries first.
 *
 * Structural, and looked up optionally: the published tool types are not among
 * this package's dependencies, and injecting the registry would make the plugin
 * fail to load in a composition that has no tools.
 */
interface ToolRegistry {
  execute(input: {
    readonly callId: string
    readonly name: string
    readonly arguments: unknown
    readonly signal: AbortSignal
  }): Promise<{
    readonly isError: boolean
    readonly value?: unknown
    readonly error?: { readonly message: string }
  }>
}

/**
 * Whether the tool route has already proved unusable in this process.
 *
 * Cached on failure only. A negative result cannot change within one process
 * lifetime, so re-asking on every search would be pure waste — but a fresh
 * process asks again, which is what keeps the official engine a live option.
 */
let toolRouteFailed = false

/** Correlates one plugin-initiated call; the registry mints its own token on top. */
let callSequence = 0

/**
 * Read the tool's payload into the normalized shape.
 * @param payload - the tool call's structured value.
 * @returns the normalized outcome, or `null` when the payload is not a search result.
 */
function fromToolPayload(payload: unknown): VaultSearchResult | null {
  const shape = payload as
    | {
        files?: readonly {
          path?: unknown
          matches?: readonly { lineNumber?: unknown; line?: unknown }[]
        }[]
        truncated?: unknown
      }
    | null
    | undefined
  if (!Array.isArray(shape?.files)) return null

  const files: VaultSearchFile[] = []
  for (const group of shape.files) {
    if (typeof group?.path !== 'string') continue
    const matches: VaultSearchHit[] = []
    for (const match of group.matches ?? []) {
      matches.push({
        line: typeof match?.lineNumber === 'number' ? match.lineNumber : 0,
        text: typeof match?.line === 'string' ? match.line : '',
      })
    }
    files.push({ path: group.path, matches })
  }
  return {
    files,
    truncated: shape.truncated === true,
  }
}

/**
 * Try the harness's own `grep` tool.
 * @param ctx - host context; the registry is read from it optionally.
 * @param root - directory to search.
 * @param query - pattern as typed.
 * @returns the result, or `null` when the tool route is unavailable.
 */
async function searchWithTool(
  ctx: Context,
  root: string,
  query: string,
): Promise<VaultSearchResult | null> {
  if (toolRouteFailed) return null
  const tools = ctx.get('tools') as ToolRegistry | undefined
  if (tools === undefined) {
    toolRouteFailed = true
    return null
  }
  callSequence += 1
  try {
    const result = await tools.execute({
      callId: `dsh-plugin-markdown-search-${callSequence}`,
      name: 'grep',
      arguments: { pattern: query, path: root, include: DOCUMENT_INCLUDE_GLOB },
      signal: new AbortController().signal,
    })
    const normalized = result.isError ? null : fromToolPayload(result.value)
    if (normalized === null) {
      toolRouteFailed = true
      return null
    }
    return normalized
  } catch {
    // Whatever the reason — an unknown tool name, a guard, a policy refusal — it
    // will not differ next time in this process.
    toolRouteFailed = true
    return null
  }
}

/**
 * Walk the root and collect matching lines.
 * @param fs - the composed filesystem service.
 * @param pattern - compiled matcher.
 * @param rootTarget - resolved authorized root.
 * @returns the normalized outcome.
 */
async function searchWithScan(
  fs: FileSystem,
  pattern: RegExp,
  rootTarget: FsTarget,
): Promise<VaultSearchResult> {
  const files: VaultSearchFile[] = []
  let counted = 0
  let truncated = false
  let visited = 0

  const queue: FsTarget[] = [rootTarget]
  while (queue.length > 0 && !truncated) {
    const directory = queue.shift()
    if (directory === undefined) break
    let entries
    try {
      entries = await fs.listDir(directory)
    } catch {
      // A directory that cannot be listed is skipped, not fatal: one unreadable
      // subdirectory should not fail the whole search.
      continue
    }
    for (const entry of entries) {
      // Dot-directories are skipped rather than parsed for ignore rules. `.git`
      // and `.obsidian` are the common cases and neither holds prose.
      if (isHiddenName(entry.name)) continue
      if (entry.type === 'directory') {
        queue.push(entry.target)
        continue
      }
      if (entry.type !== 'file' || !isDocument(entry.name)) continue
      if (entry.size !== undefined && entry.size > MAX_FILE_BYTES) continue
      visited += 1
      if (visited > MAX_FILES) {
        truncated = true
        break
      }

      let content: string
      try {
        content = await fs.readText(entry.target)
      } catch {
        continue
      }
      const matches: VaultSearchHit[] = []
      const lines = content.split('\n')
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? ''
        if (!pattern.test(line)) continue
        matches.push({ line: index + 1, text: line })
        counted += 1
        if (counted >= MAX_MATCHES) {
          truncated = true
          break
        }
      }
      if (matches.length > 0) files.push({ path: entry.target.displayPath, matches })
      if (truncated) break
    }
  }

  return { files, truncated }
}

/**
 * Search one authorized root's Markdown files.
 *
 * Prefers the harness's own search tool and falls back to the local scan, so the
 * caller never has to know which one ran.
 * @param ctx - host context.
 * @param fs - the composed filesystem service, used by the scan.
 * @param root - absolute directory to search, always the authorized root.
 * @param query - pattern as typed by the writer.
 * @returns the normalized outcome, never a throw.
 */
export async function searchVault(
  ctx: Context,
  fs: FileSystem,
  root: string,
  query: string,
): Promise<VaultSearchResult> {
  const viaTool = await searchWithTool(ctx, root, query)
  if (viaTool !== null) return viaTool

  // Compiled once for the whole walk; case-insensitive because a notes search is
  // about finding a phrase, not about matching its capitalisation.
  let pattern: RegExp
  try {
    pattern = new RegExp(query, 'iu')
  } catch (error) {
    return { files: [], truncated: false, unavailable: `正则无效：${messageOf(error)}` }
  }

  try {
    return await searchWithScan(fs, pattern, await fs.resolve(root))
  } catch (error) {
    return { files: [], truncated: false, unavailable: messageOf(error) }
  }
}
