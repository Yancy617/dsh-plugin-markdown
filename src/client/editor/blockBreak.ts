/**
 * 块间分隔节点：只存在于编辑器树里，不写进文件。
 *
 * 内容
 * - MdBlockBreakNode：一个零输出的顶层节点；插在会被 Lexical 合并的相邻块之间。
 *
 * 行为
 * - 不渲染、不可选、不进剪贴板、不参与保存；`$saveBody` / `$captureBase` 显式跳过它。
 * - 存在的唯一理由：`@lexical/list` 的 `ListNode` 有一个 `$transform`，会把相邻同类列表
 *   合并成一个；中间隔一个非列表节点，这条合并不成立。它是模型里的分隔，不是磁盘哨兵。
 *
 * 边界
 * - 只在 block 级；不承载任何内容，不解析 Markdown。
 * - 不负责决定哪里需要分隔（那是 lower / projection 的事）。
 *
 * 相关文件
 * - 被依赖：config.ts（注册）、documentMarkdown.ts（插入）、blockSave.ts（跳过）。
 * - 依赖：lexical 的 DecoratorNode。
 *
 * 改哪里
 * - 改节点本身：MdBlockBreakNode。
 */
import { DecoratorNode, type LexicalNode, type NodeKey, type SerializedLexicalNode } from 'lexical'

/** 序列化形状：没有内容字段，只有 Lexical 的公共字段。 */
export type SerializedBlockBreakNode = SerializedLexicalNode

/** 一个零输出的块间分隔。 */
export class MdBlockBreakNode extends DecoratorNode<null> {
  /**
   * @param key - 节点 key。
   */
  constructor(key?: NodeKey) {
    super(key)
  }

  /** @returns 注册表里的类型名。 */
  static getType(): string {
    return 'md-block-break'
  }

  /**
   * @param _node - 要复制的节点。
   * @returns 同 key 的副本。
   */
  static clone(_node: MdBlockBreakNode): MdBlockBreakNode {
    return new MdBlockBreakNode(_node.getKey())
  }

  /**
   * @param _serialized - 序列化形状。
   * @returns 新节点。
   */
  static importJSON(_serialized: SerializedBlockBreakNode): MdBlockBreakNode {
    return new MdBlockBreakNode()
  }

  /** @returns 序列化形状。 */
  exportJSON(): SerializedBlockBreakNode {
    return { ...super.exportJSON(), type: 'md-block-break', version: 1 }
  }

  /** @returns 一个不占空间的宿主。 */
  createDOM(): HTMLElement {
    const host = document.createElement('div')
    host.className = 'md-block-break'
    host.setAttribute('aria-hidden', 'true')
    return host
  }

  /** @returns false；它没有会变的 DOM。 */
  updateDOM(): false {
    return false
  }

  /** @returns false；它是块级节点。 */
  isInline(): false {
    return false
  }

  /** @returns false；方向键不落在它上面。 */
  isKeyboardSelectable(): false {
    return false
  }

  /** @returns null；它不画东西。 */
  decorate(): null {
    return null
  }
}

/**
 * @returns 一个新的块间分隔节点。
 */
export function $createBlockBreakNode(): MdBlockBreakNode {
  return new MdBlockBreakNode()
}

/**
 * @param node - 候选节点。
 * @returns 是不是块间分隔节点。
 */
export function $isBlockBreakNode(node: LexicalNode | null | undefined): node is MdBlockBreakNode {
  return node instanceof MdBlockBreakNode
}
