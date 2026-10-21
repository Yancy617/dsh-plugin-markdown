/**
 * 点目录之后让落点闪一下：一次性的"我跳到这里了"回执。
 *
 * 内容
 * - flashHeading / clearFlash / afterScrollSettles、FLASH_MS / SETTLE_MAX_MS、FLASH_CLASS。
 *
 * 行为
 * - 给标题元素挂 `md-flash`（动画与颜色在 `./config.ts` 的 EDITOR_CSS 里），`animationend` 或超时摘掉；
 *   **同一时刻只闪一个**：新的一次先把旧的清掉（连类一起），不会两行同时亮。
 * - `afterScrollSettles`：在滚动容器上等 `scrollend`，`SETTLE_FALLBACK_MS` 兜底；两帧之后位置没动
 *   （目标本来就到线了、没有产生滚动）就地回调，不白等兜底。
 * - 只动视觉：不改文档、不改选区、不改滚动。
 *
 * 边界
 * - 不认识 Lexical，元素由调用方给。
 * - 不负责滚动本身（`workbench/useOutlineColumn.ts` 的 jumpTo）。
 * - 闪的颜色/时长是样式表的事，这里只管类名与时机；两边靠 `FLASH_CLASS` / `FLASH_ANIMATION` 对齐。
 *
 * 相关文件
 * - 样式：./config.ts 的 EDITOR_CSS（`.md-flash` / `@keyframes md-flash`）。
 * - 被依赖：workbench/useOutlineColumn.ts。
 *
 * 改哪里
 * - 改时长：FLASH_MS（样式表里那条 `animation` 的时长要一起改）。
 * - 改时机：afterScrollSettles。
 */
import { EDITOR_FLASH, EDITOR_FLASH_MS } from './config'

/** 挂上去的那个类，与 EDITOR_CSS 里的选择器必须同名。 */
const FLASH_CLASS = EDITOR_FLASH

/** 闪多久（毫秒）——与样式表里 `animation` 的时长同一个数，从 `./config.ts` 一处来。 */
export const FLASH_MS = EDITOR_FLASH_MS

/** 等滚动停下的兜底上限（毫秒）：`scrollend` 没来（被打断 / 浏览器不支持）时不能一直不闪。 */
export const SETTLE_MAX_MS = 1500

/** 兜底时多久看一次"还动不动"（毫秒）。连着两次没动就算停下。 */
const SETTLE_POLL_MS = 80

/** 动画结束之后再多留一点再清类，避免和 `animationend` 抢同一帧。 */
const CLEANUP_GRACE_MS = 120

let current: { readonly element: HTMLElement; cleanup(): void } | null = null

/**
 * 把一行标题闪一下。新的会先清掉旧的。
 * @param element - 要闪的那个标题元素。
 */
export function flashHeading(element: HTMLElement): void {
  clearFlash()
  const onEnd = (event: AnimationEvent): void => {
    if (event.animationName === FLASH_CLASS) clearFlash()
  }
  const timer = window.setTimeout(() => {
    clearFlash()
  }, FLASH_MS + CLEANUP_GRACE_MS)
  element.addEventListener('animationend', onEnd)
  element.classList.add(FLASH_CLASS)
  current = {
    element,
    cleanup: () => {
      window.clearTimeout(timer)
      element.removeEventListener('animationend', onEnd)
      element.classList.remove(FLASH_CLASS)
    },
  }
}

/** 清掉正在闪的那一个（只清自己挂上的类）。 */
export function clearFlash(): void {
  current?.cleanup()
  current = null
}

/**
 * 等滚动停下再做事：平滑滚动途中目标还在屏幕外，闪了也没人看见。
 *
 * 收尾有两条路，谁先到算谁、只回调一次：
 *   1. `scrollend`（Chromium 有）—— 停下的那一刻；
 *   2. 兜底：每 `SETTLE_POLL_MS` 看一次 `scrollTop`，**连着两次没动**就算停下；最多等
 *      `SETTLE_MAX_MS`。
 *
 * 不用"两帧没动就算停下"：平滑滚动不是下一帧就起步的（实测点了之后 30ms 内 `scrollTop` 仍是 0），
 * 那个判据会把"刚开始滚"误判成"不用滚"，于是闪在起跳点、跳完已经看不见了。
 * "这次到底要不要滚"由调用方在**滚动之前**用几何算（`MarkdownWorkbench`），不要在这里猜。
 * @param scrollport - 滚动容器；没有就立刻回调。
 * @param callback - 停稳之后要做的事。
 */
export function afterScrollSettles(scrollport: HTMLElement | null, callback: () => void): void {
  if (scrollport === null) {
    callback()
    return
  }
  let last = scrollport.scrollTop
  let quiet = 0
  let done = false
  let poll = 0
  let ceiling = 0

  const cleanup = (): void => {
    window.clearInterval(poll)
    window.clearTimeout(ceiling)
    scrollport.removeEventListener('scrollend', finish)
  }
  const finish = (): void => {
    if (done) return
    done = true
    cleanup()
    callback()
  }

  scrollport.addEventListener('scrollend', finish)
  ceiling = window.setTimeout(finish, SETTLE_MAX_MS)
  poll = window.setInterval(() => {
    if (scrollport.scrollTop === last) {
      quiet += 1
    } else {
      quiet = 0
      last = scrollport.scrollTop
    }
    if (quiet >= 2) finish()
  }, SETTLE_POLL_MS)
}
