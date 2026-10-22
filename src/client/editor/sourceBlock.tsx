/**
 * 可编辑的 source 块：一段 Markdown 源文本，按普通文本显示，不按 Markdown 渲染。
 *
 * 内容
 * - SourceBlockNode：块级、可编辑、多行的源文本载体。
 * - $createSourceBlockNode / $isSourceBlockNode / $setSourceText。
 * - SourceBlockEditor：节点在编辑器里的 textarea 视图。
 *
 * 行为
 * - 显示原文，保留换行；用户可以在 textarea 里改任何字，改动写回节点。
 * - 保存时由 mdastLift.ts 把源文本重新解析成 mdast 块；解析出来是标准 Markdown，
 *   由统一写手重写；解析不出来就退回纯文本段落。
 * - 不参与富文本格式、不进 Lexical 的 text selection；textarea 自带输入与撤销。
 *
 * 边界
 * - 不判断“这块该不该 source”（那是 projection 的事）。
 * - 不解析 Markdown、不写文件。
 *
 * 相关文件
 * - 被依赖：config.ts（注册）、documentMarkdown.ts（projection）、mdastLift.ts（写回）。
 * - 依赖：lexical 的 DecoratorNode、React。
 *
 * 改哪里
 * - 改节点：SourceBlockNode。
 * - 改编辑视图：SourceBlockEditor。
 */
import {
  $addUpdateTag,
  $getNodeByKey,
  DecoratorNode,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
} from 'lexical'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { useLexicalEditable } from '@lexical/react/useLexicalEditable'
import type { JSX } from 'react'

/** 序列化形状：一块源文本。 */
export type SerializedSourceBlockNode = {
  readonly type: 'md-source-block'
  readonly version: 1
  readonly raw: string
} & SerializedLexicalNode

/** 一次 source 文本改动的 update 标签；保存侧据此把整篇重新算一遍。 */
export const SOURCE_EDIT_TAG = 'md-source-edit'

/**
 * 一段可编辑的 Markdown 源文本。
 */
export class SourceBlockNode extends DecoratorNode<JSX.Element> {
  /** 源文本。 */
  private __raw: string

  /**
   * @param raw - Markdown 源文本。
   * @param key - Lexical 节点 key。
   */
  constructor(raw: string, key?: NodeKey) {
    super(key)
    this.__raw = raw
  }

  /** @returns 注册表里的类型名。 */
  static getType(): string {
    return 'md-source-block'
  }

  /**
   * @param node - 要复制的节点。
   * @returns 同 key 的副本。
   */
  static clone(node: SourceBlockNode): SourceBlockNode {
    return new SourceBlockNode(node.__raw, node.__key)
  }

  /**
   * @param json - 序列化形状。
   * @returns 新节点。
   */
  static importJSON(json: SerializedSourceBlockNode): SourceBlockNode {
    return new SourceBlockNode(json.raw)
  }

  /** @returns 序列化形状。 */
  exportJSON(): SerializedSourceBlockNode {
    return {
      ...super.exportJSON(),
      type: 'md-source-block',
      version: 1,
      raw: this.__raw,
    }
  }

  /** @returns 源文本。 */
  getRaw(): string {
    return this.getLatest().__raw
  }

  /** @returns 源文本；保存 / 复制的兜底读法。 */
  getTextContent(): string {
    return this.getRaw()
  }

  /**
   * @param raw - 新的源文本。
   */
  setRaw(raw: string): void {
    $addUpdateTag(SOURCE_EDIT_TAG)
    this.getWritable().__raw = raw
  }

  /** @returns 一个零高度的宿主。 */
  createDOM(): HTMLElement {
    const host = document.createElement('div')
    host.className = 'md-source-host'
    return host
  }

  /** @returns false；它没有会变的 DOM 属性。 */
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

  /** @returns 可编辑的 textarea。 */
  decorate(): JSX.Element {
    return <SourceBlockEditor nodeKey={this.getKey()} raw={this.__raw} />
  }
}

/**
 * 源文本的编辑视图。
 * @param props.nodeKey - 节点 key。
 * @param props.raw - 当前源文本。
 * @returns textarea。
 */
function SourceBlockEditor({ nodeKey, raw }: { readonly nodeKey: NodeKey; readonly raw: string }): JSX.Element {
  const [editor] = useLexicalComposerContext()
  const editable = useLexicalEditable()
  const lineCount = Math.max(3, raw.split('\n').length)
  return (
    <textarea
      className="md-source-input"
      aria-label="Markdown 源文本"
      spellCheck={false}
      rows={lineCount}
      value={raw}
      readOnly={!editable}
      onChange={event => {
        const value = event.target.value
        editor.update(
          () => {
            const node = $getNodeByKey(nodeKey)
            if ($isSourceBlockNode(node)) node.setRaw(value)
          },
          { discrete: true },
        )
      }}
      onMouseDown={event => {
        event.stopPropagation()
      }}
    />
  )
}

/**
 * @param raw - Markdown 源文本。
 * @returns 新的 source 块。
 */
export function $createSourceBlockNode(raw: string): SourceBlockNode {
  return new SourceBlockNode(raw)
}

/**
 * @param node - 候选节点。
 * @returns 是不是 source 块。
 */
export function $isSourceBlockNode(node: LexicalNode | null | undefined): node is SourceBlockNode {
  return node instanceof SourceBlockNode
}
