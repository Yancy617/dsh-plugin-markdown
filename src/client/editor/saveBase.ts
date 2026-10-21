/**
 * 块级保存的基线形状：每个顶层块在上一次保存里的位置，以及它的“标准写法”。
 *
 * 内容
 * - BaseBlock：key + 原文 span + 标准写法 + 序号。
 * - SourceBase：一条基线（一组 BaseBlock）。
 * - createSourceBase：空基线。
 *
 * 行为
 * - `written` 是这个块由 `mdastLift.ts` 按标准写出来的那一串；判“改没改”只比它。
 *   “一块内容是什么”因此只有一个定义——写手自己。
 * - 位置存在会话里，不在 Lexical 节点 state 上：剪贴板与撤销历史带不走它。
 *
 * 边界
 * - 只有形状与工厂，不解析 Markdown、不读写编辑器树。
 * - 纯模块（零 Lexical、零 React）：`documentSessions.ts` 只需要这里的类型，不该因此拖进保存层。
 *
 * 相关文件
 * - 被依赖：blockSave.ts（生成与使用）、documentSessions.ts（按文档持有）、workbench/model 之外的保存判定。
 * - 依赖：无。
 *
 * 改哪里
 * - 加一个基线字段：BaseBlock。
 */

/** 一个顶层块在上一次保存里的位置与身份。 */
export interface BaseBlock {
  /** Lexical 节点 key；块没被拆 / 并没换过时保持不变。 */
  readonly key: string
  /** 原文里的第一个字符（正文坐标）。 */
  readonly start: number
  /** 原文里最后一个字符的下一个位置（正文坐标）。 */
  readonly end: number
  /**
   * 这个块由 `mdastLift.ts` 按标准写出来的那一串。
   *
   * 判“改没改”= 现在写出来的和它是否相同。新增节点类型或节点属性时，只要 lower / lift
   * 各自补一支，这里自动跟着变，不需要第二份清单。
   */
  readonly written: string
  /** 在上一次保存的块序列里的序号，用来判断两个块原本是否相邻。 */
  readonly index: number
}

/** 一篇文档的保存基线；可变对象，跨编辑器重挂存活（由 documentSessions 持有）。 */
export interface SourceBase {
  blocks: BaseBlock[]
  /**
   * 这组 span 描述的是**哪一份正文**（正文坐标的原文）。
   *
   * 它让“基线是否还描述当前正文”成为一次字符串比较，而不是一次推理：正文被编辑器之外
   * 的东西改写却没让视图重挂时，这两个字符串就会不相等（MarkdownEditor 挂载时据此丢弃基线）。
   */
  source: string
}

/**
 * @returns 一条空基线。
 */
export function createSourceBase(): SourceBase {
  return { blocks: [], source: '' }
}

/**
 * 这条基线是否已经不能描述这份正文。
 *
 * 空基线不算过期：它表示“还没有基线”，不是“基线错了”。
 * @param base - 会话里的基线。
 * @param body - 编辑器现在持有的正文。
 * @returns 是否必须丢掉基线（下一次保存整篇按标准重写）。
 */
export function isStaleBase(base: SourceBase, body: string): boolean {
  return base.blocks.length > 0 && base.source !== body
}
