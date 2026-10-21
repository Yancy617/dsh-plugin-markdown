/**
 * 从抛出的值里读一条消息或一段栈，两半共用。
 *
 * 内容
 * - messageOf：一句话。
 * - stackOf：给诊断用的调用栈。
 *
 * 行为
 * - Error 取 message / stack，其他值 String()。
 * - 没有 stack 的值退回 message，所以两处显示永远有字。
 *
 * 边界
 * - 不解析错误码 / 不决定展示方式。
 *
 * 相关文件
 * - 被依赖：src/index.ts、src/host/*、src/client/*（含 ErrorBoundary）。
 *
 * 改哪里
 * - 改取法：messageOf / stackOf。
 */

/**
 * @param error - any thrown value.
 * @returns its message, or a string form.
 */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The part of a failure that is worth pasting into a conversation: the call stack, or the
 * message when the value carries none — a thrown string has no stack, and an empty card would
 * be worse than a short one.
 * @param error - any thrown value.
 * @returns the stack, or its message.
 */
export function stackOf(error: unknown): string {
  if (error instanceof Error && typeof error.stack === 'string' && error.stack !== '') {
    return error.stack
  }
  return messageOf(error)
}
