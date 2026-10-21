/**
 * 行内原样载体（md-raw-inline）：一段源字节，原样留着、按 html 写回。
 *
 * 内容
 * - RawInlineNode：TextNode 子类，带 __raw。
 * - $createRawInlineNode / $isRawInlineNode / SerializedRawInlineNode。
 *
 * 行为
 * - 不解析、不渲染、不消毒；屏幕上就是那段文字。
 * - 未改的块由 blockSave 切片；改过的块由 mdastLift 按 html 原样写。
 *
 * 边界
 * - 不负责哪些构造走它（mdastLower.ts 的分派）。
 * - 不负责块级构造（rawBlocks.tsx）。
 *
 * 相关文件
 * - 依赖：lexical。
 * - 被依赖：config.ts、mdastLower.ts、mdastLift.ts。
 *
 * 改哪里
 * - 改节点：RawInlineNode。
 */
import { TextNode, type NodeKey, type SerializedTextNode, type Spread } from 'lexical'

/** Serialized form: the text a `TextNode` persists, plus the source bytes. */
export type SerializedRawInlineNode = Spread<{ readonly raw: string }, SerializedTextNode>

/**
 * 一段**原样保留**的行内源字节。
 *
 * `__text` 与 `__raw` 一开始相同。用户一编辑（或节点被切开），`__text` 就与 `__raw` 分家；
 * 从那一刻起写手（`mdastLift.ts` 的 `liftInline`）按 `__text` 写，不再回放 `__raw`：
 * **宁可改写，也不拿旧字节覆盖用户刚打的字，更不重复它。**
 */
export class RawInlineNode extends TextNode {
  /** 源里的那一串字节。 */
  private __raw: string

  /**
   * @param text - 屏幕上显示的文字（初始等于源字节）。
   * @param raw - 源里的那一段，逐字节。
   * @param key - Lexical 的节点 key。
   */
  constructor(text: string, raw: string, key?: NodeKey) {
    super(text, key)
    this.__raw = raw
  }

  /** @returns 注册表里的类型名。 */
  static getType(): string {
    return 'md-raw-inline'
  }

  /**
   * @param node - 要复制的节点。
   * @returns 带着同一段源字节的副本。
   */
  static clone(node: RawInlineNode): RawInlineNode {
    return new RawInlineNode(node.__text, node.__raw, node.__key)
  }

  /**
   * @param json - 序列化形式。
   * @returns 还原出来的节点。
   */
  static importJSON(json: SerializedRawInlineNode): RawInlineNode {
    const node = new RawInlineNode(json.text, json.raw)
    node.setFormat(json.format)
    node.setDetail(json.detail)
    node.setMode(json.mode)
    node.setStyle(json.style)
    return node
  }

  /**
   * 与 {@link importJSON} 并列存在：Lexical 0.49 的节点注册表在类没提供 `importJSON` 时用
   * `updateFromJSON` 建节点，而 `TextNode` 自己那一版会设置文字 —— 所以源字节必须在**它之后**写。
   * @param serialized - 序列化形式。
   * @returns 本节点。
   */
  updateFromJSON(serialized: SerializedRawInlineNode): this {
    super.updateFromJSON(serialized)
    this.__raw = serialized.raw ?? ''
    return this
  }

  /** @returns 与文本节点相同的字段，外加源字节。 */
  exportJSON(): SerializedRawInlineNode {
    return { ...super.exportJSON(), type: 'md-raw-inline', raw: this.__raw }
  }

  /** @returns 源字节。 */
  getRaw(): string {
    return this.__raw
  }
}

/**
 * @param raw - 源里的那一段，逐字节。
 * @returns 一个新的行内载体。
 */
export function $createRawInlineNode(raw: string): RawInlineNode {
  return new RawInlineNode(raw, raw)
}

/**
 * @param node - 候选节点。
 * @returns 它是不是行内载体。
 */
export function $isRawInlineNode(node: unknown): node is RawInlineNode {
  return node instanceof RawInlineNode
}

