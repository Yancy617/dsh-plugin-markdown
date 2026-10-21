/**
 * 行内图片节点：一个节点、它的字段、以及显示入口。
 *
 * 内容
 * - ImageNode / $createImageNode / $isImageNode / SerializedImageNode。
 *
 * 行为
 * - 节点存 alt、目的地（解码后，供显示与写回）、标题，以及引用式身份（若来自 `![a][ref]`）。
 * - 写出交给 mdastLift（标准 `image`，或 `imageReference`）；显示交给 imageView。
 *
 * 边界
 * - 不负责源语法（`parseImageInside` / `authoredInside` / `IMAGE_PATTERN` 在 imageSyntax.ts）。
 * - 不负责地址解析（imagePath.ts）与显示组件（imageView.tsx）。
 * - 不负责插入 / 选择文件（imageInsert.ts / ImageDialog.tsx）。
 *
 * 相关文件
 * - 依赖：imageSyntax（只为类型）、imagePath（目的地解码）、imageView（渲染）。
 * - 被依赖：config、mdastLower、mdastLift、ImageDialog。
 *
 * 改哪里
 * - 改节点：ImageNode。
 */
import {
  DecoratorNode,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread,
} from 'lexical'
import type { JSX } from 'react'
import { unescapeDestination } from './imagePath'
import { ImageDecorator } from './imageView'

/** Serialized form; `alt` and the destination are what make the round trip exact. */
export type SerializedImageNode = Spread<
  {
    /** Alt text, as written. */
    readonly alt: string
    /** Destination with `<>` and escapes removed, for display and writing. */
    readonly source: string
    /** Title without its quotes, or `null`. */
    readonly title: string | null
  },
  SerializedLexicalNode
>

/** An inline image. */
export class ImageNode extends DecoratorNode<JSX.Element> {
  private __alt: string

  private __source: string

  private __title: string | null

  /**
   * @param alt - alt text, as written.
   * @param source - destination with `<>` removed, for display and writing.
   * @param title - title without its quotes, or `null`.
   * @param key - Lexical node key.
   */
  constructor(alt: string, source: string, title: string | null, key?: NodeKey) {
    super(key)
    this.__alt = alt
    this.__source = source
    this.__title = title
  }

  /** @returns the registry type name. */
  static getType(): string {
    return 'md-image'
  }

  /**
   * @param node - node to copy.
   * @returns a clone carrying the same authored spelling.
   */
  static clone(node: ImageNode): ImageNode {
    return new ImageNode(node.__alt, node.__source, node.__title, node.__key)
  }

  /**
   * @param json - serialized form.
   * @returns the restored node.
   */
  static importJSON(json: SerializedImageNode): ImageNode {
    return new ImageNode(json.alt, json.source, json.title)
  }

  /** @returns the authored alt text. */
  getAlt(): string {
    return this.__alt
  }

  /** @returns the destination with `<>` and escapes removed, for display. */
  getSource(): string {
    return this.__source
  }

  /** @returns the authored title without its quotes, or `null`. */
  getTitle(): string | null {
    return this.__title
  }

  /**
   * @returns the alt text, so the image is findable by what it says.
   */
  getTextContent(): string {
    return this.__alt
  }

  /** @returns the authored fields, persisted so a reload keeps the exact spelling. */
  exportJSON(): SerializedImageNode {
    return {
      ...super.exportJSON(),
      type: 'md-image',
      version: 1,
      alt: this.__alt,
      source: this.__source,
      title: this.__title,
    }
  }

  /** @returns the DOM host the picture mounts into. */
  createDOM(): HTMLElement {
    const host = document.createElement('span')
    host.className = 'md-image-host'
    return host
  }

  /** @returns false; the authored spelling never affects the DOM. */
  updateDOM(): false {
    return false
  }

  /** @returns true; an image sits inside the line it was written on. */
  isInline(): true {
    return true
  }

  /** @returns the deferred picture or its stand-in. */
  decorate(): JSX.Element {
    return <ImageDecorator alt={this.__alt} source={this.__source} />
  }
}

/**
 * @param alt - alt text, as written.
 * @param destination - destination with `<>` removed.
 * @param title - title without its quotes, or `null`.
 * @returns a new image node.
 */
export function $createImageNode(
  alt: string,
  destination: string,
  title: string | null,
): ImageNode {
  return new ImageNode(alt, unescapeDestination(destination), title)
}

/**
 * @param node - candidate node.
 * @returns whether the node is an {@link ImageNode}.
 */
export function $isImageNode(node: LexicalNode | null | undefined): node is ImageNode {
  return node instanceof ImageNode
}
