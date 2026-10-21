/**
 * “上次选的仓库”在浏览器里的记忆。
 *
 * 内容
 * - VAULT_STORAGE_KEY / readStoredVault / storeVault / clearStoredVault。
 *
 * 行为
 * - 只记用户自己选过的路径；localStorage 不可用时读回 `null`、写入静默失败。
 * - Host 的授权在进程内存里，重启即清 —— 这里记的是“再授权哪一条”，不是授权本身。
 *
 * 边界
 * - 不发请求、不做权限判断；路径是否还有效由 Host 回答。
 *
 * 相关文件
 * - 被依赖：useVaultSession.ts（读 / 清）、MarkdownWorkbench.tsx（换目录时写）。
 *
 * 改哪里
 * - 改键：VAULT_STORAGE_KEY。
 * - 改失败策略：三个函数。
 */

/** Where the last picked vault is remembered. */
const VAULT_STORAGE_KEY = 'dsh-plugin-markdown.vault'

/** @returns the remembered vault, or `null` when absent or storage is unavailable. */
export function readStoredVault(): string | null {
  try {
    return window.localStorage.getItem(VAULT_STORAGE_KEY)
  } catch {
    // Storage can be unavailable (disabled, private mode); that is not an error.
    return null
  }
}

/**
 * Remember the picked vault.
 * @param path - absolute directory the user chose.
 */
export function storeVault(path: string): void {
  try {
    window.localStorage.setItem(VAULT_STORAGE_KEY, path)
  } catch {
    // Losing the convenience of auto-restore is acceptable; failing is not.
  }
}

/** Forget the remembered vault. */
export function clearStoredVault(): void {
  try {
    window.localStorage.removeItem(VAULT_STORAGE_KEY)
  } catch {
    // See {@link storeVault}.
  }
}
