/**
 * 面板说出口的那几句话：保存状态、操作结果、协议偏斜提示。
 *
 * 内容
 * - UseNoticesArgs / Notices / useNotices、RECEIPT_MS（成功回执的时长）、saveNotice（内部）。
 *
 * 行为
 * - 保存一行：`id` 固定为 `saveState`，文字随状态变（正在保存… / 保存成功 / 保存未生效：…），
 *   所以一次慢保存读起来是一句话在变，而不是两条互不相干的消息。成功回执 3 秒；失败**不过期**，
 *   因为它是屏幕上唯一一句"文字还没到磁盘"。
 * - 操作一行：自己的 `id`（`operation`），所以一次拒绝的保存与一次失败的重排可以同时站着，层会堆叠。
 * - 协议偏斜：Host 答 `null`（旧 Host，没有该字段）时提示一次"重启 DSH"；每挂载一次只提示一次。
 *   `undefined` 是"还没答"，不是信号。
 * - 切到另一篇文档时清掉保存那一行：保存状态属于它开始时的那篇文档，不该留在下一篇头上。
 *
 * 边界
 * - 不写盘、不决定什么时候保存；`setSaveState` 由写路径 / 关闭事务调用。
 * - 不画界面（`NoticeStack`），不拥有操作本身（`report` 只收文字与语气）。
 *
 * 相关文件
 * - 依赖：../NoticeStack（NoticeItem / NoticeTone）、./model（SaveState）。
 * - 被依赖：MarkdownWorkbench.tsx。
 *
 * 改哪里
 * - 改保存那行的文案 / 语气 / 时长：saveNotice。
 * - 改两行的 id：SAVE_NOTICE_ID / OPERATION_NOTICE_ID。
 * - 改清理规则：本文件末尾两个 effect。
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react'
import type { NoticeItem, NoticeTone } from '../NoticeStack'
import type { SaveState } from './model'

/**
 * How long a receipt stays.
 *
 * Shorter than `DEFAULT_NOTICE_MS`, and written down rather than inherited: 保存成功 is
 * four characters whose whole job is to answer "did that go through?", and answering it
 * for six seconds is answering it long after the reader has looked away. Exported because
 * the other receipt — 「已是最新」 after a reload — is the same kind of sentence and should
 * leave on the same clock.
 */
export const RECEIPT_MS = 3000

/**
 * The notice layer's key for the save row.
 *
 * Deliberately **not** `save`: that is the id of a registered command, and two different
 * things sharing one id string makes a row and a command indistinguishable to anything that
 * looks them up by id.
 */
const SAVE_NOTICE_ID = 'saveState'

/**
 * The operation notice's own key.
 *
 * Its own id rather than the save's, so the two can stand together: a reorder refused while
 * a save is outstanding is two facts, and the layer stacks them — which is what its
 * "show N rows, count the rest" rule was written for and has never had a caller for.
 */
const OPERATION_NOTICE_ID = 'operation'

/**
 * The panel's one notice, as whichever of the three things a save is saying.
 *
 * The text changes and the notice does not: same `id`, same place on screen, so a slow
 * save reads as 正在保存… becoming 保存成功 rather than as two unrelated messages.
 * @param state - the save's state, which is never `null` here.
 * @param onDismiss - called by the row's close button.
 * @returns the item for the notice layer.
 */
function saveNotice(state: NonNullable<SaveState>, onDismiss: () => void): NoticeItem {
  if (state.kind === 'saving') {
    // The default tone, and the default (no) countdown. A write in flight is ended by the
    // write, not by a clock: a timer here would take 正在保存… off screen while the save
    // was still running — exactly the slow save the reader most needs to see, and the
    // case where the text becoming 保存成功 is the whole point.
    return { id: SAVE_NOTICE_ID, text: '正在保存…', autoMs: null, onDismiss }
  }
  if (state.kind === 'saved') {
    return {
      id: SAVE_NOTICE_ID,
      text: '保存成功',
      tone: 'success',
      autoMs: RECEIPT_MS,
      onDismiss,
    }
  }
  return {
    id: SAVE_NOTICE_ID,
    text: `保存未生效：${state.message}`,
    // `danger`, decided by eye rather than by argument: the reader put the pink against a
    // real refusal — including the local-conflict one — and kept it (§6.102). It is also
    // the palette's only constructed colour, so that is the `10%` being judged rather than
    // reasoned about. `warning` (yellow) is now free for a notice that is neither an
    // outcome nor a refusal.
    tone: 'danger',
    // **Permanent, and this is the one notice that is.** It is the only thing on screen
    // saying the text never reached the disk. The 未保存 tag says a save is owed; this
    // says a save was attempted and refused, and which refusal it was — `stale-version`
    // in particular will refuse every retry until the reader reloads. A message like that
    // leaving on a timer would be leaving while it was still true, and the reader would
    // have to reproduce the failure to read it again.
    autoMs: null,
    onDismiss,
  }
}

/** What the hook needs. */
export interface UseNoticesArgs {
  /** Host 答的协议号：`undefined` 还没答，`null` 旧 Host 没有该字段，数字是新 Host。 */
  readonly hostProtocol: number | null | undefined
  /** 正在显示的文档路径，或 `''`；换文档时把保存那一行清掉。 */
  readonly openPath: string
}

/** What the hook hands back. */
export interface Notices {
  /** The rows the layer is showing, in stacking order (save first). */
  readonly items: readonly NoticeItem[]
  /** Say what an operation could not do. */
  report(text: string, tone: NoticeTone, autoMs?: number | null): void
  /** The save row's state; the write path and the close transaction own when it changes. */
  readonly setSaveState: Dispatch<SetStateAction<SaveState>>
}

/**
 * @param args - the Host's protocol number and the showing document.
 * @returns the rows and the two ways to change them.
 */
export function useNotices(args: UseNoticesArgs): Notices {
  const { hostProtocol, openPath } = args
  /**
   * The one thing this panel says about saving.
   *
   * `saving` while a write is in flight, `failed` when one was refused, `null`
   * otherwise. A refused write is the only condition kept on screen because it is
   * the only one whose silence costs work: the text is still in the buffer and not
   * on disk, and every other signal the reader has — the tab, the 未保存 tag — says
   * "unsaved" without saying why or that a retry will be refused again.
   */
  const [saveState, setSaveState] = useState<SaveState>(null)
  /**
   * What the last operation could not do, or `null`.
   *
   * A whole item rather than a message, so its tone and its lifetime are decided where the
   * operation is: a reorder that failed is a warning that may leave on its own, a move that
   * failed is a refusal that stays until it is read.
   */
  const [operation, setOperation] = useState<NoticeItem | null>(null)

  const report = useCallback(
    (text: string, tone: NoticeTone, autoMs?: number | null): void => {
      setOperation({
        id: OPERATION_NOTICE_ID,
        text,
        tone,
        autoMs,
        onDismiss: () => setOperation(null),
      })
    },
    [],
  )

  /**
   * A page that hot-reloaded ahead of the Host.
   *
   * Only `null` is a signal: `undefined` means no answer has arrived yet, and a number means the
   * Host is new enough. One notice per mount — repeating it on every render would bury the notice
   * that explains why some routes are missing.
   */
  const protocolWarned = useRef(false)
  useEffect(() => {
    if (hostProtocol !== null || protocolWarned.current) return
    protocolWarned.current = true
    report('插件界面已更新，DSH 需要重启以加载新的 Host 部分。', 'warning', null)
  }, [hostProtocol, report])

  /**
   * A save in flight, or the last one's refusal — and nothing else.
   *
   * A save belongs to the document it was started for, so a switch clears it. Without
   * that, `saveState` survived: save one file, click another tab, and the first file's
   * failure was still sitting over the second one. Opening a file happened to clear the
   * old status — its load path ended with `setStatus(null)` — but **switching tabs did
   * not**, and that is the path a reader uses most. Keying on the path covers every
   * route into a different document at once, which is the point: the rule is "a new
   * document has nothing to say yet", not a clear to be remembered at each call site.
   */
  useEffect(() => {
    setSaveState(null)
  }, [openPath])

  /**
   * What the notice layer is showing.
   *
   * The save's own row, and the last operation's when it has something to say. Instruments
   * (the round-trip self-check, the code-block census), narration of something already visible
   * (the tab's ⟳, the 未保存 tag), and explanations of a construct the reader can see is
   * read-only are not shown here.
   *
   * Built fresh each render rather than memoised: `NoticeStack` keys on `id`, so a
   * rebuilt array neither remounts the row nor restarts its countdown. The one field
   * that *does* restart a countdown is `text` — which is what makes 正在保存… becoming
   * 保存成功 give the receipt its full time rather than the remainder of the write's.
   *
   * **Two rows are possible here for the first time.** A refused save and a refused
   * reorder are two facts about two different things, and the layer stacks them — which is
   * what its "show N rows and count the rest" rule was written for and has never had a
   * caller for until now.
   */
  const items: NoticeItem[] = [
    ...(saveState === null ? [] : [saveNotice(saveState, () => setSaveState(null))]),
    ...(operation === null ? [] : [operation]),
  ]

  return { items, report, setSaveState }
}
