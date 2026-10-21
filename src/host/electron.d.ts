/**
 * 本插件唯一一处 Electron 主进程调用的环境声明。
 *
 * 内容
 * - declare module 'electron'：shell.showItemInFolder。
 *
 * 行为
 * - 只声明用到的 surface；运行时由桌面外壳注入。
 *
 * 边界
 * - 不声明 Electron 的其他 API；不引入 @types/electron。
 *
 * 相关文件
 * - 被 src/host/vault.ts 动态 import 使用。
 *
 * 改哪里
 * - 改 surface：declare module 'electron'。
 */
declare module 'electron' {
  export const shell: {
    /**
     * Open the containing folder and select the item.
     * @param path - absolute path to reveal.
     */
    showItemInFolder(path: string): void
  }
}
