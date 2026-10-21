/**
 * 分割线节点。
 *
 * 内容
 * - RuleNode / $createRuleNode / $isRuleNode / SerializedRuleNode。
 *
 * 行为
 * - DOM 恒为 `<hr class="md-rule">`。
 * - 没有自己的字段：分割线在 Markdown 里只有一种语义（`thematicBreak`），源里的拼写
 *   （`---` / `* * *` / `_ _ _`）由块级保真保留——未改的块从原文切片，改过 / 新块写标准 `---`。
 *
 * 边界
 * - 不负责 Setext 下划线：mdast 已把 Setext 读成 heading。
 * - 不负责列表 / 段落判断：块的划分由 mdast 解析决定。
 *
 * 相关文件
 * - 被依赖：config.ts、mdastLower.ts、mdastLift.ts。
 *
 * 改哪里
 * - 改节点：RuleNode。
 */
import { DecoratorNode, type LexicalNode, type NodeKey, type SerializedLexicalNode } from 'lexical'
import type { JSX } from 'react'

/** Serialized form; a rule carries no fields of its own. */
export type SerializedRuleNode = SerializedLexicalNode

/** A thematic break, rendered as `<hr>`. */
export class RuleNode extends DecoratorNode<JSX.Element> {
  /**
   * @param key - Lexical node key.
   */
  constructor(key?: NodeKey) {
    super(key)
  }

  /** @returns the registry type name. */
  static getType(): string {
    return 'md-rule'
  }

  /**
   * @param node - node to copy.
   * @returns a clone.
   */
  static clone(node: RuleNode): RuleNode {
    return new RuleNode(node.__key)
  }

  /**
   * @param _json - serialized form.
   * @returns a rule.
   */
  static importJSON(_json: SerializedRuleNode): RuleNode {
    return $createRuleNode()
  }

  /** @returns the serialized form. */
  exportJSON(): SerializedRuleNode {
    return { ...super.exportJSON(), type: 'md-rule', version: 1 }
  }

  /** @returns the DOM host the decorated `<hr>` mounts into. */
  createDOM(): HTMLElement {
    const host = document.createElement('div')
    host.className = 'md-rule-host'
    return host
  }

  /** @returns false; a rule never changes its DOM. */
  updateDOM(): false {
    return false
  }

  /** @returns false; a thematic break is always its own block. */
  isInline(): false {
    return false
  }

  /** @returns the rendered rule. */
  decorate(): JSX.Element {
    return <hr className="md-rule" />
  }
}

/**
 * @returns a new rule node.
 */
export function $createRuleNode(): RuleNode {
  return new RuleNode()
}

/**
 * @param node - candidate node.
 * @returns whether the node is a {@link RuleNode}.
 */
export function $isRuleNode(node: LexicalNode | null | undefined): node is RuleNode {
  return node instanceof RuleNode
}
