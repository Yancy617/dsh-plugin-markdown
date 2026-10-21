/**
 * 让下划线格式不可达：它没有 Markdown 拼法，保存必丢。
 *
 * 内容
 * - registerUnderlineBlock(editor)：拦 FORMAT_TEXT_COMMAND + 清文本节点的下划线位。
 *
 * 行为
 * - 两条路都拦：命令（Ctrl+U）与节点 transform（HTML 粘贴直接设格式位）。
 * - 只在编辑器生命周期内有效，返回卸载函数。
 * - transform 在 live 与 headless 都跑；不用 registerMutationListener（headless 会抛）。
 *
 * 边界
 * - 不支持下划线，也不发明扩展语法。
 *
 * 相关文件
 * - 被依赖：MarkdownEditor.tsx、scripts/probe-block.ts。
 *
 * 改哪里
 * - 改拦截：registerUnderlineBlock。
 */
import { COMMAND_PRIORITY_HIGH, FORMAT_TEXT_COMMAND, IS_UNDERLINE, TextNode, type LexicalEditor } from 'lexical'
import { mergeRegister } from '@lexical/utils'

/**
 * Stop `underline` reaching a document, from either door.
 * @param editor - the editor to protect.
 * @returns a function that removes both listeners.
 */
export function registerUnderlineBlock(editor: LexicalEditor): () => void {
  return mergeRegister(
    editor.registerCommand(
      FORMAT_TEXT_COMMAND,
      format => format === 'underline',
      // Above `@lexical/rich-text`, which sits at `COMMAND_PRIORITY_EDITOR` and would otherwise apply it
      // through `$formatText`. Answering `true` is what stops `Ctrl+U` doing anything visible.
      COMMAND_PRIORITY_HIGH,
    ),
    editor.registerNodeTransform(TextNode, node => {
      const format = node.getFormat()
      if ((format & IS_UNDERLINE) !== 0) node.setFormat(format & ~IS_UNDERLINE)
    }),
  )
}
