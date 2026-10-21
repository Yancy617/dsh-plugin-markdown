/**
 * 图片写入端口：编辑器只表达“把这张图存进仓库”，实现在工作台。
 *
 * 内容
 * - AssetWriter：一个函数类型，接收目的路径与字节，回答落盘后的路径。
 *
 * 行为
 * - 只描述一次写入的契约；命名、地址拼写、失败文案都在 imageInsert.ts。
 * - 抛出的错误保留 `status` / `code` / `message` 三个形状，供 imageInsert 分类。
 *
 * 边界
 * - 不实现 HTTP、不决定仓库在哪、不做重名重试。
 *
 * 相关文件
 * - 被依赖：imageInsert.ts、imageView.tsx、MarkdownEditor.tsx、workbench/Band.tsx、
 *   MarkdownWorkbench.tsx（提供实现）。
 */

/**
 * Store one picture and answer where it landed.
 *
 * The error contract is structural rather than a class: this package's own route client throws
 * `VaultRequestError`, but the editor must not import that client just to recognise it. A
 * `status` and a `code` on the thrown value are all `imageInsert.ts` reads.
 */
export type AssetWriter = (path: string, bytes: Uint8Array) => Promise<{ readonly path: string }>
