/**
 * 打开的缓冲区与标签的纯变换：改、加、删、关。
 *
 * 内容
 * - patchBuffers / withBuffer / withoutBuffers。
 * - closeTabs：一组路径关掉之后，标签条与当前标签是什么。
 *
 * 行为
 * - 一次都没动时返回**原对象 / 原数组**，调用方可以按引用判断“要不要重渲染”。
 * - 关掉当前标签时，接班的是它原来位置上的那一个；关的是最后一个就退到前一个。
 * - 只做状态变换：不清定时器、不写盘、不碰会话与选中态。
 *
 * 边界
 * - 不拥有 React 状态，不执行关闭事务（写盘 / 丢弃在 closeTab）。
 * - 不判断路径是否存在、是不是文档。
 *
 * 相关文件
 * - 被依赖：MarkdownWorkbench.tsx、scripts/probe-units.ts。
 * - 依赖：workbench/model 的 BufferState 类型。
 */
import type { BufferState } from './model'

/** 一个标签条，加上它当前显示的那一格。 */
export interface TabState {
  readonly tabs: readonly string[]
  readonly activePath: string | null
}

/**
 * 把一处改动并进一个缓冲区。
 * @param buffers - 按绝对路径索引的缓冲区。
 * @param path - 要改的那一篇。
 * @param patch - 要替换的字段。
 * @returns 新的记录；路径不在或字段全等时返回原对象。
 */
export function patchBuffers(
  buffers: Record<string, BufferState>,
  path: string,
  patch: Partial<BufferState>,
): Record<string, BufferState> {
  const existing = buffers[path]
  if (existing === undefined) return buffers
  const next = { ...existing, ...patch }
  const unchanged = (Object.keys(patch) as (keyof BufferState)[]).every(
    key => existing[key] === next[key],
  )
  return unchanged ? buffers : { ...buffers, [path]: next }
}

/**
 * 放进一篇打开好的文档（同路径覆盖）。
 * @param buffers - 按绝对路径索引的缓冲区。
 * @param buffer - 新的缓冲区。
 * @returns 新的记录。
 */
export function withBuffer(
  buffers: Record<string, BufferState>,
  buffer: BufferState,
): Record<string, BufferState> {
  return { ...buffers, [buffer.path]: buffer }
}

/**
 * 丢掉若干篇文档的缓冲区。
 * @param buffers - 按绝对路径索引的缓冲区。
 * @param paths - 要丢的路径；不存在的忽略。
 * @returns 新的记录；一条都没命中时返回原对象。
 */
export function withoutBuffers(
  buffers: Record<string, BufferState>,
  paths: readonly string[],
): Record<string, BufferState> {
  let changed = false
  const next = { ...buffers }
  for (const path of paths) {
    if (next[path] !== undefined) {
      delete next[path]
      changed = true
    }
  }
  return changed ? next : buffers
}

/**
 * 一组标签关掉之后，标签条与当前标签。
 *
 * 当前标签被关掉时，接班的是它**原来位置**上的那一个：读的是收缩前的列表，所以看到的是
 * 读者当时看到的那一格，而不是按新列表算出来的另一格。
 * @param state - 收缩前的标签条与当前标签。
 * @param closed - 要关掉的路径。
 * @returns 新的标签条与当前标签；没有标签被关掉时返回原对象。
 */
export function closeTabs(state: TabState, closed: readonly string[]): TabState {
  const gone = new Set(closed)
  const remaining = state.tabs.filter(path => !gone.has(path))
  if (remaining.length === state.tabs.length) return state
  const active = state.activePath
  if (active === null || !gone.has(active)) {
    return { tabs: remaining, activePath: active }
  }
  const index = state.tabs.indexOf(active)
  const fallback = Math.min(Math.max(index, 0), Math.max(remaining.length - 1, 0))
  return { tabs: remaining, activePath: remaining[fallback] ?? null }
}
