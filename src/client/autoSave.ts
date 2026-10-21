/**
 * 什么时候写、哪一次写是当前的、以及节奏的代价。
 *
 * 内容
 * - AutoSaveState / AutoSaveLimits / LOCAL_LIMITS / nextWriteDelay。
 * - WriteTurn / beginWrite / currentWrite / isCurrent / endWrite / invalidate。
 * - enqueue / noteWrite / writeReport / forgetWrites。
 *
 * 行为
 * - nextWriteDelay 只在 dirty、未 blocked、未 writing 时给等待；idle 与 maxWait 取小。
 * - 每条路径最多一次在飞、一个等待；等待的那次运行时写最新文本。
 * - 落定的写不会自动再排一次。
 * - 每次写的统计只用于观测，不参与行为。
 *
 * 边界
 * - 不负责真正写文件（MarkdownWorkbench 的 writeActive）。
 *
 * 相关文件
 * - 被依赖：MarkdownWorkbench.tsx、savePlan.ts、scripts/probe-units.ts。
 *
 * 改哪里
 * - 改节奏：nextWriteDelay / LOCAL_LIMITS。
 * - 改 in-flight 记账：beginWrite / isCurrent / endWrite。
 */

/** What the scheduling rules see. */
export interface AutoSaveState {
  /** Something the *writer* changed is not on disk yet (`source !== saved`). */
  readonly dirty: boolean
  /** Milliseconds since the text last changed. */
  readonly idleMs: number
  /** Milliseconds since the last successful write of this document. */
  readonly sinceWriteMs: number
  /** A write for this document is in flight. */
  readonly writing: boolean
  /** Auto-save for this document is standing down after a failure or a conflict. */
  readonly blocked: boolean
}

/**
 * One cadence.
 *
 * A value, not code: "this vault is on a sync folder, be slower" becomes a second one of these
 * rather than a branch inside the rules (see `docs/方案-云同步.md`).
 */
export interface AutoSaveLimits {
  /** Write once the text has been still for this long. */
  readonly idleMs: number
  /** …and at the latest this long after the previous successful write, however busy the writer is. */
  readonly maxWaitMs: number
}

/**
 * The local cadence: two seconds of stillness, twenty seconds of patience.
 *
 * The two numbers answer different questions — "has the writer stopped?" and "how much may be
 * lost?" — and `maxWaitMs` is what keeps the second answer bounded while somebody types without
 * pause (see `docs/方案-自动保存.md` §4.4).
 */
export const LOCAL_LIMITS: AutoSaveLimits = { idleMs: 2000, maxWaitMs: 20000 }

/**
 * How long until this document should be written.
 * @param state - what the rules see.
 * @param limits - the cadence in force.
 * @returns `0` for "now", a positive wait, or `null` for "do not schedule".
 */
export function nextWriteDelay(state: AutoSaveState, limits: AutoSaveLimits): number | null {
  if (!state.dirty || state.blocked || state.writing) return null
  const untilIdle = limits.idleMs - state.idleMs
  const untilMax = limits.maxWaitMs - state.sinceWriteMs
  return Math.max(0, Math.min(untilIdle, untilMax))
}

/** One write in flight: which turn it is. */
export interface WriteTurn {
  /** Monotonic id, compared by {@link isCurrent}. */
  readonly token: number
}

const turns = new Map<string, WriteTurn>()
let nextToken = 1

/**
 * Record that a write for `path` has started.
 * @param path - absolute document path.
 * @returns the turn, whose token the result must be checked against.
 */
export function beginWrite(path: string): WriteTurn {
  const turn: WriteTurn = { token: nextToken }
  nextToken += 1
  turns.set(path, turn)
  return turn
}

/**
 * @param path - absolute document path.
 * @returns the write in flight for it, if any.
 */
export function currentWrite(path: string): WriteTurn | undefined {
  return turns.get(path)
}

/**
 * Whether a result still belongs to the newest write of that path.
 * @param path - absolute document path.
 * @param token - the token {@link beginWrite} handed out.
 * @returns `true` when nothing has invalidated or replaced it since.
 */
export function isCurrent(path: string, token: number): boolean {
  return turns.get(path)?.token === token
}

/**
 * Forget a finished write.
 * @param path - absolute document path.
 * @param token - the token it started with.
 */
export function endWrite(path: string, token: number): void {
  if (turns.get(path)?.token === token) turns.delete(path)
}

/**
 * Throw away whatever result is coming for this path.
 *
 * Called when the document is deleted, reloaded, renamed or moved: the write that is in flight
 * was aimed at a document that no longer exists in that form, so its outcome must not be applied
 * — `isCurrent` turns false for it and the result is dropped whole.
 * @param path - absolute document path.
 */
export function invalidate(path: string): void {
  turns.delete(path)
}

const chains = new Map<string, Promise<unknown>>()

/**
 * Run one task per path, in order.
 *
 * The shape that gives "at most one write in flight per path": a second request waits for the
 * first, and then runs — which matters because the task re-reads the buffer when it starts, so
 * the queued write sends the newest text rather than the text captured when it was requested.
 * @param path - the serialization key.
 * @param task - what to run.
 * @returns the task's own result.
 */
export function enqueue<T>(path: string, task: () => Promise<T>): Promise<T> {
  const previous = chains.get(path) ?? Promise.resolve()
  const run = previous.then(task, task)
  const tail = run.then(
    () => undefined,
    () => undefined,
  )
  chains.set(path, tail)
  // Keep the map bounded by the documents actually being written, not by the session's history.
  void tail.then(() => {
    if (chains.get(path) === tail) chains.delete(path)
  })
  return run
}

/** What one document's writes looked like. */
interface WriteTally {
  count: number
  firstAt: number
  lastAt: number
  bytes: number
}

const tallies = new Map<string, WriteTally>()

/**
 * Record one successful write, for the session's reading.
 * @param path - absolute document path.
 * @param bytes - size of the text written, in UTF-8 bytes.
 */
export function noteWrite(path: string, bytes: number): void {
  const now = Date.now()
  const tally = tallies.get(path)
  if (tally === undefined) {
    tallies.set(path, { count: 1, firstAt: now, lastAt: now, bytes })
    return
  }
  tally.count += 1
  tally.lastAt = now
  tally.bytes += bytes
}

/**
 * The session's write counts, one line per document.
 *
 * A reading, not behaviour: it is what says whether a cadence is doing what it was chosen for —
 * and it is the quantity a sync folder would be paying for (see `docs/方案-云同步.md` §3.5).
 * Printed by the workbench when a document leaves and when the panel unmounts.
 * @returns one `path — n 次，平均 x 秒` line per document written at least once.
 */
export function writeReport(): readonly string[] {
  return [...tallies.entries()].map(([path, tally]) => {
    const span = tally.lastAt - tally.firstAt
    const average = tally.count > 1 ? (span / (tally.count - 1) / 1000).toFixed(1) : '—'
    return `${path} — ${String(tally.count)} 次（平均间隔 ${average} 秒，合计 ${String(tally.bytes)} 字节）`
  })
}

/**
 * Drop one document's tally, after it has been reported.
 * @param path - absolute document path.
 */
export function forgetWrites(path: string): void {
  tallies.delete(path)
}
