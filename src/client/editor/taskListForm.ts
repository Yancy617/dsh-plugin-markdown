/**
 * 任务列表里“有序”的那一半：GFM 的任务项可以长在有序列表里（`1. [x] …`）。
 *
 * 内容
 * - TaskListForm / taskListFormState / $taskListFormOf / $setTaskListForm。
 *
 * 行为
 * - Lexical 的列表类型只有 `bullet` / `number` / `check` 三种，`check` 不带“有没有序号”。
 *   源里是 `1. [x]` 时，列表建成 `check`（勾选框照常显示），序号记在这条节点状态上，
 *   写出时再由 mdastLift 取回来 —— 用户写的序号因此不会因为改一个字而丢。
 * - 只有“任务列表且有序”才有这条状态；普通列表 / 无序任务列表读出来是 `null`。
 * - 列表被 @lexical/list 换成另一种时是新建节点，状态自然丢掉（不需要额外清理）。
 *
 * 边界
 * - 不负责渲染勾选框（@lexical/list）、不负责列表命令（operations.ts）。
 *
 * 相关文件
 * - 被依赖：mdastLower.ts（设置）、mdastLift.ts（读取）。
 *
 * 改哪里
 * - 改载体：taskListFormState。
 */
import { $getState, $setState, createState, type LexicalNode } from 'lexical'

/** 一个任务列表在源里的序号形式。 */
export interface TaskListForm {
  /** 源里是有序列表（`1.` / `1)`）还是无序（`-` / `*` / `+`）。 */
  readonly ordered: boolean
  /** 起始号；无序或没写时是 `null`。 */
  readonly start: number | null
}

/**
 * 有序任务列表的序号形式；普通任务列表读出来是 `null`。
 *
 * 值按字段比较：同一份形式重复设置不会把节点标脏。
 */
export const taskListFormState = createState('mdTaskListForm', {
  parse: (value: unknown): TaskListForm | null => (isTaskListForm(value) ? value : null),
  isEqual: (left, right) => left?.ordered === right?.ordered && left?.start === right?.start,
})

/**
 * @param node - 列表节点。
 * @returns 它的序号形式，或 `null`。
 */
export function $taskListFormOf(node: LexicalNode): TaskListForm | null {
  return $getState(node, taskListFormState)
}

/**
 * @param node - 列表节点。
 * @param form - 序号形式；`null` 表示这是普通任务列表。
 */
export function $setTaskListForm(node: LexicalNode, form: TaskListForm | null): void {
  $setState(node, taskListFormState, form)
}

/**
 * @param value - 候选值。
 * @returns 它是不是一个序号形式。
 */
function isTaskListForm(value: unknown): value is TaskListForm {
  if (typeof value !== 'object' || value === null) return false
  const record = value as { ordered?: unknown; start?: unknown }
  if (typeof record.ordered !== 'boolean') return false
  return record.start === null || typeof record.start === 'number'
}
