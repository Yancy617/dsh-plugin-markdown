/**
 * dsh-plugin-markdown 的 Host 半边。
 *
 * 内容
 * - name / inject。
 * - HostLogger / readBody / readJson / 路由处理器 / apply。
 *
 * 行为
 * - 在 ctx.webServer 上注册 VaultRoute 与 PluginRoute 的精确 HTTP 路由。
 * - 根由用户在客户端选一次，Vault 持有；请求体从不带根。
 * - 每个处理器读 JSON / 查询参数，调 host/*，把 VaultError 映射成状态码与错误码。
 * - GET 只读；写路由校验方法与载荷。
 *
 * 边界
 * - 不实现文件系统细节（host/vault.ts）与搜索（host/search.ts）。
 * - Host 代码不热重载；改动在下次 DSH 启动生效。
 *
 * 相关文件
 * - 依赖：host/search、host/templates、host/updateCheck、host/vault、
 *   shared/protocol、shared/errors。
 * - 被依赖：package.json 的 dsh.bundle。
 *
 * 改哪里
 * - 改路由：apply 里的 register。
 * - 改请求解析：readJson / 各处理器。
 * - 改错误映射：VaultError 处理。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { searchVault } from './host/search'
import { classifyRoot, readSampleAsset, SAMPLE_ROOT } from './host/templates'
import { checkForUpdate } from './host/updateCheck'
import { Vault, VaultError } from './host/vault'
import {
  ERR_BAD_REQUEST,
  ERR_FILESYSTEM,
  ERR_NOT_FOUND,
  ERR_NO_VAULT,
  PluginRoute,
  PROTOCOL_VERSION,
  VaultRoute,
  type VaultAssetRequest,
  type VaultAuthorizeRequest,
  type VaultCopyRequest,
  type VaultFailure,
  type VaultMakeDirectoryRequest,
  type VaultMoveRequest,
  type VaultHideRequest,
  type VaultRevealRequest,
  type VaultRemoveRequest,
  type VaultRenameRequest,
  type VaultWriteRequest,
} from './shared/protocol'
import { messageOf } from './shared/errors'

/** Plugin id; matches the `cordis.patch.yml` row id and the diagnostics label. */
export const name = 'markdown-editor'

/** Hard dependencies: the HTTP carrier and the composed filesystem. */
export const inject = ['webServer', 'fs']

/** Sink used for unexpected failures; narrowed from the Cordis logger. */
interface HostLogger {
  info(message: string): void
  error(message: string): void
}

/**
 * Largest request body the routes accept, in bytes.
 *
 * The largest legitimate body is a 20 MiB picture as base64 (~27 MiB) or a large document; 64 MiB
 * leaves room for both without letting a malformed request grow the process without bound.
 */
const MAX_BODY_BYTES = 64 * 1024 * 1024

/**
 * Read a request body as UTF-8 text.
 * @param req - the incoming request.
 * @returns the accumulated body, or `''` when there is none.
 * @throws {VaultError} when the body is larger than {@link MAX_BODY_BYTES}.
 */
function readBody(req: IncomingMessage): Promise<string> {
  const tooLarge = (): VaultError =>
    new VaultError(
      ERR_BAD_REQUEST,
      413,
      `请求体超过上限（${String(MAX_BODY_BYTES / 1024 / 1024)} MB）`,
    )
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] ?? Number.NaN)
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      // Drain instead of destroying: the refusal still has to travel back as a response.
      req.resume()
      reject(tooLarge())
      return
    }
    let body = ''
    let size = 0
    let oversized = false
    req.on('data', chunk => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        // Stop accumulating but keep consuming, so the socket can finish and answer 413.
        oversized = true
        body = ''
        return
      }
      if (!oversized) body += chunk.toString('utf8')
    })
    req.on('end', () => {
      if (oversized) reject(tooLarge())
      else resolve(body)
    })
    req.on('error', () => {
      if (oversized) reject(tooLarge())
      else resolve(body)
    })
  })
}

/**
 * Parse a request body as a JSON object.
 * @param req - the incoming request.
 * @returns the parsed object; an empty body reads as `{}`.
 * @throws {VaultError} when the body is not a JSON object.
 */
async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(req)
  if (raw.trim() === '') return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new VaultError(ERR_BAD_REQUEST, 400, '请求体不是合法 JSON')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new VaultError(ERR_BAD_REQUEST, 400, '请求体必须是 JSON 对象')
  }
  return parsed as Record<string, unknown>
}

/**
 * Read one string field from a parsed body.
 * @param body - parsed request body.
 * @param key - field name.
 * @param required - whether absence is an error.
 * @returns the value, or `undefined` when absent and not required.
 * @throws {VaultError} when present but not a string, or absent and required.
 */
function field(body: Record<string, unknown>, key: string, required: boolean): string | undefined {
  const value = body[key]
  if (value === undefined) {
    if (required) throw new VaultError(ERR_BAD_REQUEST, 400, `缺少字段：${key}`)
    return undefined
  }
  if (typeof value !== 'string') throw new VaultError(ERR_BAD_REQUEST, 400, `字段不是字符串：${key}`)
  return value
}

/**
 * Answer one JSON payload.
 * @param res - the response to write.
 * @param status - HTTP status code.
 * @param payload - JSON-serializable body.
 */
function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

/**
 * Turn any thrown value into the protocol's failure shape.
 * @param res - the response to write.
 * @param error - the thrown value.
 * @param logger - sink for unexpected failures.
 */
function sendFailure(res: ServerResponse, error: unknown, logger: HostLogger): void {
  if (error instanceof VaultError) {
    const payload: VaultFailure = { error: error.code, message: error.message }
    sendJson(res, error.status, payload)
    return
  }
  const message = messageOf(error)
  logger.error(`unexpected failure: ${message}`)
  const payload: VaultFailure = { error: ERR_FILESYSTEM, message }
  sendJson(res, 500, payload)
}

/**
 * Activate the Host half: build the vault and mount its routes.
 * @param ctx - Host context for this plugin's fiber.
 */
export function apply(ctx: Context): void {
  const logger = ctx.logger('markdown-editor') as unknown as HostLogger
  // `ctx.fs` and `ctx.webServer` are the official `FileSystem` and `WebServer`
  // services: importing their packages augments the Cordis Context, so both are typed directly.
  const vault = new Vault(ctx.fs)

  /**
   * Mount one exact route with uniform failure handling.
   * @param path - exact path.
   * @param handler - the route body; refusals throw {@link VaultError}.
   */
  const mount = (
    path: string,
    handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
  ): void => {
    ctx.webServer.register({
      kind: 'exact',
      path,
      handler: async (req, res) => {
        try {
          await handler(req, res)
        } catch (error) {
          sendFailure(res, error, logger)
        }
      },
    })
  }

  /**
   * Refuse any method outside the route's contract.
   * @param req - the incoming request.
   * @param res - the response to write.
   * @param allowed - accepted methods.
   * @returns whether the request was refused.
   */
  const rejectMethod = (req: IncomingMessage, res: ServerResponse, allowed: readonly string[]): boolean => {
    if (req.method !== undefined && allowed.includes(req.method)) return false
    const payload: VaultFailure = { error: ERR_BAD_REQUEST, message: `仅支持 ${allowed.join(' / ')}` }
    sendJson(res, 405, payload)
    return true
  }

  /**
   * @param req - the incoming request.
   * @param key - query parameter name.
   * @returns the parameter's value, or `''`.
   */
  const queryParam = (req: IncomingMessage, key: string): string =>
    new URL(req.url ?? '/', 'http://localhost').searchParams.get(key) ?? ''

  mount(VaultRoute.state, async (req, res) => {
    if (rejectMethod(req, res, ['GET'])) return
    const state = vault.state()
    sendJson(res, 200, {
      ...state,
      kind: classifyRoot(state.root),
      protocol: PROTOCOL_VERSION,
    })
  })

  mount(VaultRoute.authorize, async (req, res) => {
    if (rejectMethod(req, res, ['POST'])) return
    const body = await readJson(req)
    const request: VaultAuthorizeRequest = { path: field(body, 'path', true) ?? '' }
    const state = await vault.authorize(request.path)
    logger.info(`vault authorized: ${state.root ?? '(none)'}`)
    sendJson(res, 200, { ...state, kind: classifyRoot(state.root) })
  })

  mount(VaultRoute.revoke, async (req, res) => {
    if (rejectMethod(req, res, ['POST'])) return
    const state = vault.revoke()
    logger.info('vault authorization revoked')
    sendJson(res, 200, { ...state, kind: null })
  })

  mount(VaultRoute.list, async (req, res) => {
    if (rejectMethod(req, res, ['GET'])) return
    sendJson(res, 200, await vault.list(queryParam(req, 'path')))
  })

  mount(VaultRoute.directories, async (req, res) => {
    if (rejectMethod(req, res, ['GET'])) return
    sendJson(res, 200, await vault.listDirectories())
  })

  mount(VaultRoute.read, async (req, res) => {
    if (rejectMethod(req, res, ['GET'])) return
    sendJson(res, 200, await vault.read(queryParam(req, 'path')))
  })

  mount(VaultRoute.stat, async (req, res) => {
    if (rejectMethod(req, res, ['GET'])) return
    sendJson(res, 200, await vault.stat(queryParam(req, 'path')))
  })

  mount(VaultRoute.write, async (req, res) => {
    if (rejectMethod(req, res, ['PUT', 'POST'])) return
    const body = await readJson(req)
    const request: VaultWriteRequest = {
      path: field(body, 'path', true) ?? '',
      content: field(body, 'content', true) ?? '',
      expectedVersion: field(body, 'expectedVersion', false),
    }
    sendJson(res, 200, await vault.write(request.path, request.content, request.expectedVersion))
  })

  mount(VaultRoute.asset, async (req, res) => {
    if (rejectMethod(req, res, ['POST'])) return
    const body = await readJson(req)
    const request: VaultAssetRequest = {
      path: field(body, 'path', true) ?? '',
      base64: field(body, 'base64', true) ?? '',
    }
    sendJson(res, 200, await vault.writeAsset(request.path, request.base64))
  })

  mount(VaultRoute.rename, async (req, res) => {    if (rejectMethod(req, res, ['POST'])) return
    const body = await readJson(req)
    const request: VaultRenameRequest = {
      path: field(body, 'path', true) ?? '',
      name: field(body, 'name', true) ?? '',
    }
    sendJson(res, 200, await vault.renameEntry(request.path, request.name))
  })

  mount(VaultRoute.copy, async (req, res) => {
    if (rejectMethod(req, res, ['POST'])) return
    const body = await readJson(req)
    const request: VaultCopyRequest = {
      path: field(body, 'path', true) ?? '',
      name: field(body, 'name', true) ?? '',
    }
    sendJson(res, 200, await vault.copyEntry(request.path, request.name))
  })

  mount(VaultRoute.move, async (req, res) => {
    if (rejectMethod(req, res, ['POST'])) return
    const body = await readJson(req)
    const request: VaultMoveRequest = {
      path: field(body, 'path', true) ?? '',
      directory: field(body, 'directory', true) ?? '',
    }
    sendJson(res, 200, await vault.moveEntry(request.path, request.directory))
  })

  mount(VaultRoute.remove, async (req, res) => {
    if (rejectMethod(req, res, ['POST'])) return
    const body = await readJson(req)
    const recursive = body['recursive']
    if (recursive !== undefined && typeof recursive !== 'boolean') {
      throw new VaultError(ERR_BAD_REQUEST, 400, 'recursive 必须是布尔值')
    }
    const request: VaultRemoveRequest = {
      path: field(body, 'path', true) ?? '',
      recursive,
    }
    await vault.removeEntry(request.path, request.recursive === true)
    sendJson(res, 200, { ok: true })
  })

  mount(VaultRoute.makeDirectory, async (req, res) => {
    if (rejectMethod(req, res, ['POST'])) return
    const body = await readJson(req)
    const recursive = body['recursive']
    if (recursive !== undefined && typeof recursive !== 'boolean') {
      throw new VaultError(ERR_BAD_REQUEST, 400, 'recursive 必须是布尔值')
    }
    const request: VaultMakeDirectoryRequest = {
      path: field(body, 'path', true) ?? '',
      name: field(body, 'name', true) ?? '',
      recursive,
    }
    sendJson(res, 200, await vault.makeDirectory(request.path, request.name, request.recursive === true))
  })

  mount(VaultRoute.reveal, async (req, res) => {
    if (rejectMethod(req, res, ['POST'])) return
    const body = await readJson(req)
    const request: VaultRevealRequest = { path: field(body, 'path', true) ?? '' }
    await vault.reveal(request.path)
    sendJson(res, 200, { ok: true })
  })

  mount(VaultRoute.hide, async (req, res) => {
    if (rejectMethod(req, res, ['POST'])) return
    const body = await readJson(req)
    const request: VaultHideRequest = { path: field(body, 'path', true) ?? '' }
    await vault.hideEntry(request.path)
    sendJson(res, 200, { ok: true })
  })

  mount(VaultRoute.sample, async (req, res) => {
    if (rejectMethod(req, res, ['POST'])) return
    // Nothing to prepare and nothing to write: the samples are the package's own templates,
    // held in memory, so this route only names the root the caller authorizes next.
    // Independent of the authorized root on purpose: the client calls this when there is no
    // vault yet, and authorizing the result is the caller's move.
    sendJson(res, 200, { path: SAMPLE_ROOT })
  })

  mount(VaultRoute.sampleAsset, async (req, res) => {
    if (rejectMethod(req, res, ['GET'])) return
    const name = queryParam(req, 'name')
    const asset = await readSampleAsset(name)
    // **A name that ships nothing is a 404, not a path error**: the answer comes from a table,
    // so `../` and an absolute path are indistinguishable from a typo — which is the point.
    if (asset === null) throw new VaultError(ERR_NOT_FOUND, 404, `示例里没有这张图：${name}`)
    res.statusCode = 200
    res.setHeader('content-type', asset.contentType)
    // Same choice as `sendJson`: a package that was upgraded must not keep serving the old
    // picture out of a cache.
    res.setHeader('cache-control', 'no-store')
    res.end(asset.bytes)
  })

  mount(VaultRoute.sampleDocument, async (req, res) => {
    if (rejectMethod(req, res, ['GET'])) return
    // The same contract as `sampleAsset`, for text: a **name** out of the package's own table of
    // templates, so nothing the caller sends is ever resolved, joined or stat-ed — and the
    // authorized root is deliberately not consulted, because this is how one of the plugin's own
    // documents is read while the writer's own directory is the authorized one.
    sendJson(res, 200, await vault.readSampleDocument(queryParam(req, 'name')))
  })

  mount(VaultRoute.search, async (req, res) => {
    if (rejectMethod(req, res, ['POST'])) return
    const body = await readJson(req)
    const query = (field(body, 'query', true) ?? '').trim()
    const root = vault.state().root
    if (root === null) throw new VaultError(ERR_NO_VAULT, 409, '尚未授权任何目录')
    // An empty pattern matches every line of every file, which is never what an
    // empty search box means.
    if (query === '') {
      sendJson(res, 200, { files: [], truncated: false })
      return
    }
    sendJson(res, 200, await searchVault(ctx, ctx.fs, root, query))
  })

  /**
   * The plugin's own version check — **not** a vault route.
   *
   * It never touches the authorized root (there need not be one), it writes nothing, and
   * it makes the plugin's only outbound request. Mounted here because this is where the
   * one HTTP channel is set up, not because it is a vault operation: the route lives in
   * `PluginRoute`, and the work in `./host/updateCheck.ts`.
   */
  mount(PluginRoute.updateCheck, async (req, res) => {
    if (rejectMethod(req, res, ['GET'])) return
    sendJson(res, 200, await checkForUpdate())
  })

  logger.info('host half loaded; vault routes mounted')
}
