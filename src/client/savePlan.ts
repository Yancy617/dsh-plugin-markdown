/**
 * 该不该保存（纯函数）。
 *
 * 内容
 * - SavePlan / planSaveSource / hasUnsaved / utf8Length。
 *
 * 行为
 * - `source !== saved` 才写整篇 `source`；相等就是 `none`。
 * - hasUnsaved 是同一个判据的布尔说法，给“要不要在离开时写一次”这类调用方用。
 * - `utf8Length` 只用于读数（字节数），不参与判定。
 *
 * 边界
 * - 不负责什么时候问、失败怎么办（MarkdownWorkbench.tsx）。
 * - 不判断内容是否标准（mdastLift.ts）。
 *
 * 相关文件
 * - 被依赖：MarkdownWorkbench.tsx、editor/MarkdownEditor.tsx。
 *
 * 改哪里
 * - 改判定：planSaveSource。
 * - 改字节读数：utf8Length。
 */

/** 对一篇打开文档的保存决定。 */
export type SavePlan =
  /** 没有要写的东西：不碰磁盘。 */
  | { readonly kind: 'none' }
  /** 写整篇文本。 */
  | {
      readonly kind: 'write'
      readonly content: string
    }

/**
 * 决定这份 source 镜像是否需要写盘。
 *
 * 写的是 `source`（块级保存后的正文），不是编辑器的临时导出；相等即无事可做。
 * @param inputs - 磁盘文本与当前 source。
 * @returns 写 / 不写。
 */
export function planSaveSource(inputs: {
  readonly saved: string
  readonly source: string
}): SavePlan {
  if (inputs.source === inputs.saved) return { kind: 'none' }
  return { kind: 'write', content: inputs.source }
}

/**
 * 这份缓冲区有没有还没写盘的内容。
 *
 * 与 {@link planSaveSource} 是同一个判据的两种说法：写盘问“写什么”，离开时问“要不要写”。
 * 两处各写一遍 `source !== saved` 的那天，就是它们开始给出不同答案的那天。
 * @param inputs - 磁盘文本与当前 source。
 * @returns 是否需要写盘。
 */
export function hasUnsaved(inputs: {
  readonly saved: string
  readonly source: string
}): boolean {
  return planSaveSource(inputs).kind !== 'none'
}

/**
 * 一个字符串的 UTF-8 字节数。
 *
 * 手写而不是 `TextEncoder`：这是读数路径，每次调用都分配一个编码器不划算。
 * @param text - 要量的文本。
 * @returns UTF-8 字节数。
 */
export function utf8Length(text: string): number {
  let bytes = 0
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code < 0x80) {
      bytes += 1
    } else if (code < 0x800) {
      bytes += 2
    } else if (
      code >= 0xd800 &&
      code <= 0xdbff &&
      index + 1 < text.length &&
      text.charCodeAt(index + 1) >= 0xdc00 &&
      text.charCodeAt(index + 1) <= 0xdfff
    ) {
      bytes += 4
      index += 1
    } else {
      bytes += 3
    }
  }
  return bytes
}
