/**
 * 浏览器端访问本插件的更新检查。
 *
 * 内容
 * - fetchUpdateCheck。
 *
 * 行为
 * - 一条 GET 路由，返回已安装版本与 registry 最新版。
 * - 安装不在插件里：面板只显示版本与命令。
 * - 路由自身拒绝时抛 VaultRequestError；registry 失败是 outcome: 'failed'。
 *
 * 边界
 * - 不负责安装 / 升级。
 *
 * 相关文件
 * - 依赖：shared/protocol、request.ts。
 * - 被依赖：MarkdownWorkbench.tsx、CommandPalette.tsx。
 *
 * 改哪里
 * - 改请求：fetchUpdateCheck。
 */
import { PluginRoute, type UpdateCheckResult } from '../shared/protocol'
import { request } from './request'

/**
 * Ask this plugin's Host half whether a newer release exists.
 * @returns the outcome and both versions when they are known.
 * @throws {import('./request').VaultRequestError} when the route itself refuses — a
 * failure of *our* channel, not of the registry (that one is an `outcome: 'failed'`).
 */
export async function fetchUpdateCheck(): Promise<UpdateCheckResult> {
  return await request<UpdateCheckResult>(PluginRoute.updateCheck, { method: 'GET' })
}
