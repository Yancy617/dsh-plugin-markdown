/**
 * 链接引用定义在树里的载体：不显示任何东西，只把定义那一行的原文带到下一次保存。
 *
 * 内容
 * - DefinitionNode / $createDefinitionNode / $isDefinitionNode / DEFINITION_NODE。
 *
 * 行为
 * - 节点携带定义那一行的原文，`decorate()` 返回 `null`，`isInline()` 为 false。
 * - 未改的块由 blockSave 从原文切片；改过 / 新写的定义由 mdast 标准写。
 * - 不再做“删掉失去使用者的定义”这类拼装：定义是普通块，按块级规则走。
 *
 * 边界
 * - 不解析定义、不决定谁引用谁。
 *
 * 相关文件
 * - 被依赖：config.ts、mdastLower.ts、mdastLift.ts。
 *
 * 改哪里
 * - 改节点：DefinitionNode。
 */
import { DecoratorNode, type LexicalNode, type NodeKey, type SerializedLexicalNode, type Spread } from 'lexical'

/** 序列化形式：只多一个 `text`，就是那一行的原文。 */
export type SerializedDefinitionNode = Spread<
  {
    /** 定义那一行的**原文**，逐字节。 */
    readonly text: string
  },
  SerializedLexicalNode
>

/** 一条链接定义的载体。 */
export class DefinitionNode extends DecoratorNode<null> {
  /** 定义那一行的原文。 */
  private __text: string

  /**
   * @param text - 定义那一行的原文。
   * @param key - Lexical 节点键。
   */
  constructor(text: string, key?: NodeKey) {
    super(key)
    this.__text = text
  }

  /** @returns 节点表的类型名。 */
  static getType(): string {
    return 'md-definition'
  }

  /**
   * @param node - 要复制的节点。
   * @returns 同型节点，带着同一行原文。
   */
  static clone(node: DefinitionNode): DefinitionNode {
    return new DefinitionNode(node.__text, node.__key)
  }

  /**
   * @param serialized - 序列化形式。
   * @returns 还原出来的节点。
   */
  static importJSON(serialized: SerializedDefinitionNode): DefinitionNode {
    return new DefinitionNode(serialized.text)
  }

  /** @returns 序列化形式。 */
  exportJSON(): SerializedDefinitionNode {
    return { ...super.exportJSON(), type: 'md-definition', version: 1, text: this.__text }
  }

  /** @returns 那一行的原文。 */
  getText(): string {
    return this.getLatest().__text
  }

  /** @returns 承载用的元素：它不画东西，但必须是元素（`DecoratorNode` 的契约）。 */
  createDOM(): HTMLElement {
    return document.createElement('span')
  }

  /** @returns false；它没有会变的东西。 */
  updateDOM(): false {
    return false
  }

  /** @returns false；定义是块级的东西，不是行内片段。 */
  isInline(): false {
    return false
  }

  /** @returns null；**这个节点不该被看见**。 */
  decorate(): null {
    return null
  }
}

/**
 * @param text - 定义那一行的原文。
 * @returns 一个新的定义载体。
 */
export function $createDefinitionNode(text: string): DefinitionNode {
  return new DefinitionNode(text)
}

/**
 * @param node - 候选节点。
 * @returns 是不是定义载体。
 */
export function $isDefinitionNode(node: LexicalNode | null | undefined): node is DefinitionNode {
  return node instanceof DefinitionNode
}

/** 供 `./config.ts` 的节点表使用。 */
export const DEFINITION_NODE = DefinitionNode
