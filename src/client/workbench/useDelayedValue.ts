/**
 * 晚半拍的值：内容停下 `delayMs` 之后才交出去。
 *
 * 内容
 * - useDelayedValue。
 *
 * 行为
 * - 第一次渲染立刻就是传入的值；之后每次变化重新计时，停手才更新。
 * - 只延后**交给下游**的时机，不改值本身；相等（`Object.is`）时不安排定时器。
 *
 * 边界
 * - 不做节流（不按固定间隔给出中间值）；不支持服务端渲染。
 * - 不拥有业务：谁该慢半拍、慢多少，由调用方决定。
 *
 * 相关文件
 * - 被依赖：MarkdownWorkbench.tsx（字数）、./useOutlineColumn.ts（源码视图的文档目录：一次结构解析
 *   约 16 ms，不能跟着每个键跑）。
 *
 * 改哪里
 * - 改行为：useDelayedValue。
 */
import { useEffect, useState } from 'react'

/**
 * @param value - 想要跟上的值。
 * @param delayMs - 停手多久之后交出去（毫秒）。
 * @returns 跟得上、但慢半拍的值。
 */
export function useDelayedValue<T>(value: T, delayMs: number): T {
  const [delayed, setDelayed] = useState(value)
  useEffect(() => {
    if (Object.is(delayed, value)) return undefined
    const handle = window.setTimeout(() => {
      setDelayed(value)
    }, delayMs)
    return () => {
      window.clearTimeout(handle)
    }
  }, [delayed, value, delayMs])
  return delayed
}
