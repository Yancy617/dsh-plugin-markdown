/**
 * 安静失败：写进控制台，不弹提示。
 *
 * 内容
 * - reportQuietly。
 *
 * 行为
 * - 一句 `[markdown] <操作>：<原因>`，原因取自 `messageOf`。
 *
 * 边界
 * - 不改状态、不重试、不判断该不该抛；调用方已经决定这次失败不值得占用屏幕。
 *
 * 相关文件
 * - 依赖：shared/errors 的 messageOf。
 * - 被依赖：MarkdownWorkbench.tsx、useVaultSession.ts 等。
 *
 * 改哪里
 * - 改格式：reportQuietly。
 */
import { messageOf } from '../shared/errors'

/**
 * Report a failure that is not worth a notice.
 * @param what - the operation, named for whoever reads the console.
 * @param error - whatever was thrown.
 */
export function reportQuietly(what: string, error: unknown): void {
  console.error(`[markdown] ${what}：${messageOf(error)}`)
}
