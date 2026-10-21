/**
 * 大文档保护的判据与文案：多大算大、多久算慢、字节怎么念。
 *
 * 内容
 * - 阈值：LARGE_BYTES（打开前问一句）、SLOW_IMPORT_MS（打开后按实测提示）、OUTLINE_AUTO_BYTES（源码视图不自动解析目录）。
 * - largeBand / formatBytes / slowOpenNotice。
 *
 * 行为
 * - 纯函数、无 React、无 DOM、不读时间：阈值只有这一处，界面与文案都从这里取。
 * - "大"只看字节；"慢"由调用方传入实测导入耗时 —— 大小不是好判据，节点密度才是。
 *
 * 边界
 * - 不决定弹窗长什么样（workbench/Dialogs.tsx）、不决定何时弹（MarkdownWorkbench.tsx）。
 * - 不改变保存、不拒绝打开。
 *
 * 相关文件
 * - 依赖：无。
 * - 被依赖：MarkdownWorkbench.tsx、workbench/Dialogs.tsx、workbench/Band.tsx、scripts/probe-units.ts。
 *
 * 改哪里
 * - 调阈值：下面三个常量（改完同步 README 与方案）。
 * - 改文案：slowOpenNotice。
 */

/** 打开前问一句的线：4 MiB。 */
export const LARGE_BYTES = 4 * 1024 * 1024

/** 导入超过这个毫秒数才提示"打开慢"。 */
export const SLOW_IMPORT_MS = 800

/** 源码视图超过这个大小就不自动解析目录（改为按钮点一次）。 */
export const OUTLINE_AUTO_BYTES = 2 * 1024 * 1024

/** Which side of {@link LARGE_BYTES} a document is on. */
export type LargeBand = 'normal' | 'large'

/**
 * @param bytes - document size in UTF-8 bytes.
 * @returns `large` at or above {@link LARGE_BYTES}; `normal` below it.
 */
export function largeBand(bytes: number): LargeBand {
  return bytes >= LARGE_BYTES ? 'large' : 'normal'
}

/**
 * A size a reader can say out loud: bytes, KB or MB.
 * @param bytes - size in UTF-8 bytes.
 * @returns the rounded label, e.g. `854 KB` or `4.2 MB`.
 */
export function formatBytes(bytes: number): string {
  const value = Number.isFinite(bytes) && bytes > 0 ? bytes : 0
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`
  if (value >= 1024) return `${String(Math.round(value / 1024))} KB`
  return `${String(Math.round(value))} B`
}

/**
 * The one-line notice shown after a slow rich-text import.
 *
 * It reports **measured** milliseconds rather than predicting from size: the same size can cost
 * three times more on a document with dense inline nodes, and "it took 1.4 seconds" is a fact the
 * reader just experienced, not a guess.
 * @param bytes - document size in UTF-8 bytes.
 * @param ms - measured import duration in milliseconds.
 * @returns the notice text.
 */
export function slowOpenNotice(bytes: number, ms: number): string {
  const seconds = (Math.max(0, ms) / 1000).toFixed(1)
  return (
    `这篇约 ${formatBytes(bytes)}，富文本打开用了 ${seconds} 秒。` +
    '每次保存都要把整篇文件写回一遍，输入可能变慢；可以用源码视图只读查看（更多 → 源码模式），编辑仍在富文本。'
  )
}
