/**
 * 语法层第一半：正文 → mdast 树（纯函数，不认识 Lexical）。
 *
 * 内容
 * - parseBody(body)：CommonMark + 四样 GFM（表格 / 删除线 / 任务项 / 裸自动链接）。
 *
 * 行为
 * - 整篇一次解析；不做按块切片再解析。
 * - 位置信息（`position`）由 mdast 给出，保存基线直接用它切原文。
 *
 * 边界
 * - 不建节点、不记拼写；只回答“这棵树长什么样”。
 * - 不负责容器标记的剥离（映射在 mdastLower.ts）、不负责源切片（blockSave.ts 用 position 切）。
 *
 * 相关文件
 * - 被依赖：mdastLower.ts、mdastLift.ts、blockSave.ts、documentMarkdown.ts、outline.ts。
 *
 * 改哪里
 * - 改语法集：GRAMMAR。
 */
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmAutolinkLiteralFromMarkdown } from 'mdast-util-gfm-autolink-literal'
import { gfmStrikethroughFromMarkdown } from 'mdast-util-gfm-strikethrough'
import { gfmTableFromMarkdown } from 'mdast-util-gfm-table'
import { gfmTaskListItemFromMarkdown } from 'mdast-util-gfm-task-list-item'
import { gfmAutolinkLiteral } from 'micromark-extension-gfm-autolink-literal'
import { gfmStrikethrough } from 'micromark-extension-gfm-strikethrough'
import { gfmTable } from 'micromark-extension-gfm-table'
import { gfmTaskListItem } from 'micromark-extension-gfm-task-list-item'
import type { Root } from 'mdast'

/**
 * 打开的语法：CommonMark（micromark 的默认集）＋ **四样 GFM**：表格、删除线、任务项、
 * 裸自动链接（GFM §6.9）。四样**都启用**，裸 URL 会被读成链接。
 *
 * 打开裸自动链接不会碰到别的构造：mdast 侧的 `transformGfmAutolinkLiterals` 明确跳过
 * `link` / `linkReference` **里面**已有的文字（`mdast-util-gfm-autolink-literal` 的
 * `notInConstruct`），所以手写的 `[文字](地址)`、图片、引用式链接一个都不受影响。
 * **裸 `ftp://` 不在其中**：GFM 只认 http/https。
 */
const GRAMMAR = {
  extensions: [gfmTable(), gfmStrikethrough(), gfmTaskListItem(), gfmAutolinkLiteral()],
  mdastExtensions: [
    gfmTableFromMarkdown(),
    gfmStrikethroughFromMarkdown(),
    gfmTaskListItemFromMarkdown(),
    gfmAutolinkLiteralFromMarkdown(),
  ],
}

/**
 * 解析一份正文。
 *
 * **整篇一次**（方案 §3 的不变量 1）：不做"按块切片再解析"—— 块级判定依赖上下文（setext vs 分割线、
 * 缩进代码不打断段落、懒续行、列表松紧），切片会把那份上下文丢掉。
 * @param body - 正文；frontmatter 已切走。
 * @returns mdast 树，`type` 是 `'root'`。
 */
export function parseBody(body: string): Root {
  return fromMarkdown(body, GRAMMAR)
}
