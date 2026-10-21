/**
 * 块级原样载体：一个编辑器不建模、但一个字都不许改的块。
 *
 * 内容
 * - RawBlockNode / $createRawBlockNode / $isRawBlockNode / SerializedRawBlockNode。
 *
 * 行为
 * - 屏幕上显示为预格式文字；不解析、不渲染、不消毒。
 * - 未改的块由 blockSave 从原文切片；因为没有编辑入口，它通常不会被改写。
 * - 新的 / 改过的原样块由 mdastLift 按 `html` 原样写出。
 *
 * 边界
 * - 不负责哪些构造走它（mdastLower.ts 的分派）。
 *
 * 相关文件
 * - 被依赖：config.ts、mdastLower.ts、mdastLift.ts。
 *
 * 改哪里
 * - 改节点：RawBlockNode。
 */
import {
  DecoratorNode,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread,
} from 'lexical'
import type { JSX } from 'react'

/** Serialized form of a raw block. */
export type SerializedRawBlockNode = Spread<
  { readonly raw: string; readonly kind: string },
  SerializedLexicalNode
>

/** One construct kept verbatim. */
export class RawBlockNode extends DecoratorNode<JSX.Element> {
  /** The source text, byte for byte. */
  private __raw: string

  /** Which construct this is. */
  private __kind: string

  /**
   * @param raw - the source text, byte for byte.
   * @param kind - which construct it is.
   * @param key - Lexical node key.
   */
  constructor(raw: string, kind: string, key?: NodeKey) {
    super(key)
    this.__raw = raw
    this.__kind = kind
  }

  /** @returns the registry type name. */
  static getType(): string {
    return 'md-raw-block'
  }

  /**
   * @param node - node to copy.
   * @returns a clone carrying the same text.
   */
  static clone(node: RawBlockNode): RawBlockNode {
    return new RawBlockNode(node.__raw, node.__kind, node.__key)
  }

  /**
   * @param json - serialized form.
   * @returns the restored node.
   */
  static importJSON(json: SerializedRawBlockNode): RawBlockNode {
    return new RawBlockNode(json.raw, json.kind)
  }

  /** @returns the source text. */
  getRaw(): string {
    return this.__raw
  }

  /** @returns which construct this is. */
  getKind(): string {
    return this.__kind
  }

  /** @returns the source text, persisted so a reload keeps the exact bytes. */
  exportJSON(): SerializedRawBlockNode {
    return { ...super.exportJSON(), type: 'md-raw-block', version: 1, raw: this.__raw, kind: this.__kind }
  }

  /** @returns the DOM host the decorated block mounts into. */
  createDOM(): HTMLElement {
    const host = document.createElement('div')
    host.className = 'md-raw-host'
    return host
  }

  /** @returns false; the text never affects the DOM. */
  updateDOM(): false {
    return false
  }

  /** @returns false; a raw block is always its own block. */
  isInline(): false {
    return false
  }

  /** @returns the verbatim source, shown as preformatted text. */
  decorate(): JSX.Element {
    return <pre className="md-raw-block">{this.__raw}</pre>
  }
}

/**
 * @param raw - the source text.
 * @param kind - which construct it is.
 * @returns a new raw block node.
 */
export function $createRawBlockNode(raw: string, kind: string): RawBlockNode {
  return new RawBlockNode(raw, kind)
}

/**
 * @param node - candidate node.
 * @returns whether the node is a {@link RawBlockNode}.
 */
export function $isRawBlockNode(node: LexicalNode | null | undefined): node is RawBlockNode {
  return node instanceof RawBlockNode
}
