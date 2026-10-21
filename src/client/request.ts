/**
 * 两个浏览器端客户端共用的 JSON 往返。
 *
 * 内容
 * - VaultRequestError。
 * - request<T>。
 *
 * 行为
 * - fetch 带 cache: no-store；传输失败 → VaultRequestError('transport', 0)。
 * - 非 2xx 或非 JSON → 按 host 的 error / message 或 bad-response 抛出。
 * - 空响应体按 {} 解析。
 *
 * 边界
 * - 不负责路由形状与业务错误（vaultClient / updateClient）。
 *
 * 相关文件
 * - 被依赖：vaultClient.ts、updateClient.ts。
 *
 * 改哪里
 * - 改往返：request。
 * - 改错误：VaultRequestError。
 */

/** A refusal from one of the plugin's own routes, carrying the protocol's stable code. */
export class VaultRequestError extends Error {
  /** Machine-readable code, either from the host or a transport-level one. */
  readonly code: string

  /** HTTP status, or `0` when the request never completed. */
  readonly status: number

  /**
   * @param code - stable code.
   * @param status - HTTP status; `0` for a transport failure.
   * @param message - human-readable detail.
   */
  constructor(code: string, status: number, message: string) {
    super(message)
    this.name = 'VaultRequestError'
    this.code = code
    this.status = status
  }
}

/**
 * Perform one JSON round trip, turning any refusal into a {@link VaultRequestError}.
 * @param url - route URL, query included.
 * @param init - fetch options.
 * @returns the parsed success payload.
 * @throws {VaultRequestError} on transport failure or a non-2xx answer.
 */
export async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(url, { cache: 'no-store', ...init })
  } catch (error) {
    throw new VaultRequestError(
      'transport',
      0,
      error instanceof Error ? error.message : String(error),
    )
  }

  const text = await response.text()
  let payload: unknown
  try {
    payload = text === '' ? {} : JSON.parse(text)
  } catch {
    throw new VaultRequestError('bad-response', response.status, text.slice(0, 200))
  }

  if (!response.ok) {
    const failure = payload as { readonly error?: unknown; readonly message?: unknown }
    throw new VaultRequestError(
      typeof failure.error === 'string' ? failure.error : 'http',
      response.status,
      typeof failure.message === 'string' ? failure.message : text.slice(0, 200),
    )
  }

  return payload as T
}
