/**
 * 自动保存的调度与“离开时写一次”：计时器、立即写标记、页面隐藏 / 卸载的兜底。
 *
 * 内容
 * - BEACON_MAX_BYTES / UseWriteSchedulerArgs / WriteScheduler / useWriteScheduler。
 * - 三个触发源：空闲计时器、窗口失焦 / 页面隐藏、页面销毁前的最后一把。
 *
 * 行为
 * - 每次内容变化重新计时；停手 `LOCAL_LIMITS.idleMs` 后写，最长等 `maxWaitMs`。
 * - `markImmediate` 去掉这一次的等待（粘贴 / 光标离开编辑面）；`bump` 让规则重新算一次。
 * - 失败后站住，直到 `noteChange(..., true)` 或一次成功的写把它解除。
 * - 卸载时把还没写的内容刷一遍，并打一行写次数读数。
 *
 * 边界
 * - 不实现写盘（`flushRef` 指向组合根的 writeActive），不决定关闭事务。
 * - 不拥有缓冲区文本，只读 `buffersRef` 做“哪些还要写”。
 *
 * 相关文件
 * - 被依赖：MarkdownWorkbench.tsx。
 * - 依赖：autoSave.ts、savePlan.ts、readOnly.ts、workbench/model 的类型。
 */
import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'
import { VaultRoute } from '../../shared/protocol'
import { LOCAL_LIMITS, currentWrite, nextWriteDelay, writeReport } from '../autoSave'
import { hasUnsaved, utf8Length } from '../savePlan'
import { readOnlyDocument } from '../readOnly'
import { reportQuietly } from '../reportQuietly'
import type { BufferState, WriteOutcome } from './model'

/**
 * Largest body a closing page may hand to `sendBeacon`.
 *
 * Around 64 KB across browsers, and an oversized beacon fails silently — so a bigger document is
 * left to the ordinary write that `visibilitychange` fires first, while the page is still alive.
 */
const BEACON_MAX_BYTES = 60 * 1024

/** What the scheduler reads from the panel. */
export interface UseWriteSchedulerArgs {
  /** The showing buffer, or `null`. */
  readonly open: BufferState | null
  /** Its source mirror; a change is what re-arms the idle timer. */
  readonly source: string
  /** Where the authorized root came from; a non-user root is read-only. */
  readonly vaultKind: 'sample' | 'user' | null
  /** The freshest buffers, readable when a timer fires. */
  readonly buffersRef: MutableRefObject<Record<string, BufferState>>
  /** The one write path, assigned below this hook in the caller. */
  readonly flushRef: MutableRefObject<(path: string) => Promise<WriteOutcome>>
}

/** What the panel may ask the scheduler to do. */
export interface WriteScheduler {
  /** Whether the panel is still mounted; a landed write patches the snapshot when it is not. */
  readonly mountedRef: MutableRefObject<boolean>
  /** Write every document that has something unwritten. */
  flushAll(): Promise<void>
  /** Cancel one document's armed timer. */
  cancelSchedule(path: string): void
  /** Record a change; `contentChanged` takes the document out of standing down. */
  noteChange(path: string, contentChanged: boolean): void
  /** Record a landed write: its time, and that it no longer stands down or waits. */
  noteLanded(path: string): void
  /** Stand this document down until its text changes again. */
  block(path: string): void
  /** Drop one document's scheduling state (it is closing). */
  forget(path: string): void
  /** Make the next scheduling decision write at once. */
  markImmediate(path: string): void
  /** Ask the rules again without changing the text (the caret left the editor). */
  bump(): void
}

/**
 * Own the auto-save cadence and the leave triggers.
 * @param args - the showing buffer, its mirror, and the panel's refs.
 * @returns the scheduler's controls.
 */
export function useWriteScheduler(args: UseWriteSchedulerArgs): WriteScheduler {
  const { open, source, vaultKind, buffersRef, flushRef } = args
  const mountedRef = useRef(true)
  const [writeEpoch, setWriteEpoch] = useState(0)

  /** When each document's text last changed, for the idle rule. */
  const lastChangeAtRef = useRef(new Map<string, number>())
  /** When each document was last written, for the max-wait rule. */
  const lastWriteAtRef = useRef(new Map<string, number>())
  /** The armed idle timer per document. */
  const timersRef = useRef(new Map<string, number>())
  /** Documents whose next write should happen now rather than after the idle wait. */
  const writeNowRef = useRef(new Set<string>())
  /** Documents whose auto-save is standing down after a refusal. */
  const blockedRef = useRef(new Set<string>())

  /** Read at the moment a page-hide runs, not captured when the listener was registered. */
  const vaultKindRef = useRef(vaultKind)
  vaultKindRef.current = vaultKind

  /** Cancel a document's scheduled write, if one is armed. */
  const cancelSchedule = useCallback((path: string): void => {
    const handle = timersRef.current.get(path)
    if (handle === undefined) return
    window.clearTimeout(handle)
    timersRef.current.delete(path)
  }, [])

  /**
   * Record one change. The timestamp arms the idle rule; a content change is also the retry
   * condition that takes a document out of standing down.
   * @param path - absolute document path.
   * @param contentChanged - whether the text changed (not just the selection).
   */
  const noteChange = useCallback((path: string, contentChanged: boolean): void => {
    lastChangeAtRef.current.set(path, Date.now())
    if (contentChanged) blockedRef.current.delete(path)
  }, [])

  /** Record a landed write: its time, and that it no longer stands down or waits. */
  const noteLanded = useCallback((path: string): void => {
    lastWriteAtRef.current.set(path, Date.now())
    writeNowRef.current.delete(path)
    blockedRef.current.delete(path)
  }, [])

  /** Stand this document down until its text changes again. */
  const block = useCallback((path: string): void => {
    blockedRef.current.add(path)
  }, [])

  /** Forget one document's scheduling state; it is closing or being discarded. */
  const forget = useCallback(
    (path: string): void => {
      lastChangeAtRef.current.delete(path)
      lastWriteAtRef.current.delete(path)
      blockedRef.current.delete(path)
      writeNowRef.current.delete(path)
      cancelSchedule(path)
    },
    [cancelSchedule],
  )

  /** Make this document's next decision immediate. */
  const markImmediate = useCallback((path: string): void => {
    writeNowRef.current.add(path)
  }, [])

  /** Re-ask the rules (the writer left the editing surface). */
  const bump = useCallback((): void => {
    setWriteEpoch(value => value + 1)
  }, [])

  /** Write every document that has something unwritten. */
  const flushAll = useCallback(async (): Promise<void> => {
    const unwritten = Object.values(buffersRef.current).filter(buffer => hasUnsaved(buffer))
    for (const buffer of unwritten) await flushRef.current(buffer.path)
  }, [buffersRef, flushRef])

  // ── Trigger A: the idle timer ───────────────────────────────────────────────
  //
  // Re-armed by every content change, which is what makes it measure stillness rather than
  // elapsed time: the effect's dependencies *are* the "has the text changed" signal. `writeEpoch`
  // is in there so a settled write asks the rules again — and the answer may be "now", because
  // the text has been still for longer than `T_idle` while the write was in flight.
  useEffect(() => {
    if (open === null || readOnlyDocument(open, vaultKind)) return undefined
    const path = open.path
    const now = Date.now()
    const immediately = writeNowRef.current.has(path)
    const delay = nextWriteDelay(
      {
        // The same rule every write goes through, asked once per scheduling decision.
        dirty: hasUnsaved({ saved: open.saved, source }),
        idleMs: immediately
          ? LOCAL_LIMITS.idleMs
          : now - (lastChangeAtRef.current.get(path) ?? now),
        sinceWriteMs: now - (lastWriteAtRef.current.get(path) ?? now),
        writing: currentWrite(path) !== undefined,
        blocked: blockedRef.current.has(path),
      },
      LOCAL_LIMITS,
    )
    // The mark is consumed only when there is something to write: a decision that finds nothing
    // to do must not spend it.
    if (delay !== null && immediately) writeNowRef.current.delete(path)
    if (delay === null) return undefined
    const timer = window.setTimeout(() => {
      timersRef.current.delete(path)
      void flushRef.current(path)
    }, delay)
    timersRef.current.set(path, timer)
    return () => {
      window.clearTimeout(timer)
      if (timersRef.current.get(path) === timer) timersRef.current.delete(path)
    }
  }, [open, source, vaultKind, writeEpoch, flushRef])

  // ── Trigger B: the way out of the editing state ─────────────────────────────
  useEffect(() => {
    const onBlur = (): void => {
      void flushAll()
    }
    window.addEventListener('blur', onBlur)
    return () => window.removeEventListener('blur', onBlur)
  }, [flushAll])

  useEffect(() => {
    const onHide = (): void => {
      if (document.visibilityState === 'hidden') void flushAll()
    }
    document.addEventListener('visibilitychange', onHide)
    return () => document.removeEventListener('visibilitychange', onHide)
  }, [flushAll])

  /**
   * The last resort for a page that is going away with text still unwritten.
   *
   * `navigator.sendBeacon` is the browser's own answer to this moment: `POST` only (the write route
   * accepts it), carry the version read (no response is ever seen), and skip documents over the
   * size cap because an oversized beacon fails silently.
   */
  useEffect(() => {
    const onPageHide = (): void => {
      for (const buffer of Object.values(buffersRef.current)) {
        if (readOnlyDocument(buffer, vaultKindRef.current)) continue
        if (!hasUnsaved(buffer)) continue
        if (utf8Length(buffer.source) > BEACON_MAX_BYTES) continue
        const body = JSON.stringify({
          path: buffer.path,
          content: buffer.source,
          expectedVersion: buffer.version,
        })
        try {
          navigator.sendBeacon(
            VaultRoute.write,
            new Blob([body], { type: 'application/json' }),
          )
        } catch (error) {
          reportQuietly('离开页面时的那次保存没能发出去', error)
        }
      }
    }
    window.addEventListener('pagehide', onPageHide)
    return () => window.removeEventListener('pagehide', onPageHide)
  }, [buffersRef])

  // The panel unmounting — a switch to the conversation, or the whole panel going away. There is
  // no React state left to patch when the result lands, so `writeActive` routes it to the panel
  // snapshot instead (see `mountedRef`), and the next mount consumes it before comparing versions.
  useEffect(() => {
    // Set on setup as well as cleared on teardown: React's development StrictMode mounts, tears
    // down and re-runs effects without recreating refs, and a ref left false would route every
    // later result to the snapshot while the panel is still on screen.
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      const unwritten = Object.values(buffersRef.current).filter(buffer => hasUnsaved(buffer))
      if (unwritten.length > 0) console.info(`[markdown] 离开时保存：${String(unwritten.length)} 篇`)
      for (const buffer of unwritten) void flushRef.current(buffer.path)
      const report = writeReport()
      if (report.length > 0) console.info(`[markdown] 写次数：\n  ${report.join('\n  ')}`)
    }
  }, [buffersRef, flushRef])

  return {
    mountedRef,
    flushAll,
    cancelSchedule,
    noteChange,
    noteLanded,
    block,
    forget,
    markImmediate,
    bump,
  }
}
