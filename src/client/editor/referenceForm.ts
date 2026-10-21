/**
 * 引用式链接 / 图片的“写法身份”：这一处是 `[文字][ref]` 还是 `[文字](url)`。
 *
 * 内容
 * - ReferenceForm / ReferenceType：标识符与三种引用式写法。
 * - referenceFormState / $referenceFormOf / $setReferenceForm。
 *
 * 行为
 * - 只在**解析得到定义**时设置；解析不到时读侧仍退回文字（与改造前一致）。
 * - 有身份 ⇒ 写侧写 `linkReference` / `imageReference`（保住作者写的引用式风格、定义行不被孤立）；
 *   没有身份 ⇒ 照旧写 `link` / `image`。
 * - 身份是语义，不是拼写：`[文字][ref]` 与 `[文字][ref]  ` 的尾随空白不进这里。
 *
 * 边界
 * - 不收集定义（那是 mdastLower.ts 的 `definitionsOf`）、不判断定义还在不在。
 *   用户删掉定义块时，引用块不会被跨块改写——这是块级保真的边界（见 docs/文件职责.md）。
 * - 复制一整块时保住的也是引用式写法：粘到**没有那份定义**的地方（另一篇文档、或只粘一段），
 *   按 CommonMark 的含义它就是一串文字，链接会退化成可见文字。这是“按作者写的形式写回”的代价；
 *   部分选择走 HTML 读法，那一条仍然是内联链接。
 * - 不渲染、不解析。
 *
 * 相关文件
 * - 被依赖：mdastLower.ts（设置）、mdastLift.ts（读取）。
 * - 依赖：lexical 的节点状态。
 *
 * 改哪里
 * - 加一种引用式写法：ReferenceType。
 */
import { $getState, $setState, createState, type LexicalNode } from 'lexical'

/** CommonMark §4.7 的三种引用式写法。 */
export type ReferenceType = 'full' | 'collapsed' | 'shortcut'

/** 一处引用式链接 / 图片在源里的身份。 */
export interface ReferenceForm {
  /** 定义行的标识符（大小写与空白按 CommonMark 归一）。 */
  readonly identifier: string
  /** 完整 `[文字][ref]` / 折叠 `[文字][]` / 简写 `[文字]`。 */
  readonly referenceType: ReferenceType
}

/**
 * 一处引用式的身份；没有就是普通链接 / 图片。
 *
 * 值按字段比较：同一个身份重复设置不会把节点标脏（与表格对齐那条状态同一套规矩）。
 */
export const referenceFormState = createState('mdReferenceForm', {
  parse: (value: unknown): ReferenceForm | null => (isReferenceForm(value) ? value : null),
  isEqual: (left, right) =>
    left?.identifier === right?.identifier && left?.referenceType === right?.referenceType,
})

/**
 * @param node - 链接或图片节点。
 * @returns 它的引用式身份，或 `null`。
 */
export function $referenceFormOf(node: LexicalNode): ReferenceForm | null {
  return $getState(node, referenceFormState)
}

/**
 * @param node - 链接或图片节点。
 * @param form - 引用式身份；`null` 表示这是普通链接 / 图片。
 */
export function $setReferenceForm(node: LexicalNode, form: ReferenceForm | null): void {
  $setState(node, referenceFormState, form)
}

/**
 * @param value - 候选值。
 * @returns 它是不是一个引用式身份。
 */
function isReferenceForm(value: unknown): value is ReferenceForm {
  if (typeof value !== 'object' || value === null) return false
  const record = value as { identifier?: unknown; referenceType?: unknown }
  if (typeof record.identifier !== 'string') return false
  return (
    record.referenceType === 'full' ||
    record.referenceType === 'collapsed' ||
    record.referenceType === 'shortcut'
  )
}
