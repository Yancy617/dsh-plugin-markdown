/**
 * 文档目录宽度与它的上下界。
 *
 * 内容
 * - OUTLINE_MIN / SIDEBAR_WIDTH / OUTLINE_DEFAULT / OUTLINE_MAX / EDITOR_MIN。
 * - outlineCeiling / clampOutline / clampStoredWidth。
 *
 * 行为
 * - 文档目录最小 220，默认 220（固定，不量左栏也不跟窗口），上限 = 默认 ×2（440）。
 * - 编辑区地板 360；只限制拖动，不限制已存储宽度。
 * - outlineCeiling 不低于 OUTLINE_MIN，窄窗口也不会出现上界低于下界。
 * - clampStoredWidth 只按文档目录自身上下界，窗口宽度不参与。
 *
 * 边界
 * - 不负责渲染与测量（MarkdownWorkbench.tsx）。
 *
 * 相关文件
 * - 被依赖：workbench/useOutlineColumn.ts、workbench/Band.tsx。
 *
 * 改哪里
 * - 改常量：OUTLINE_* / SIDEBAR_WIDTH / EDITOR_MIN。
 * - 改边界规则：outlineCeiling / clampOutline / clampStoredWidth。
 */

/** The narrowest the outline may be dragged. */
export const OUTLINE_MIN = 220

/**
 * The left sidebar's width, in pixels.
 *
 * The only place *this* number is written — the panel's grid is built from it. The outline does not
 * read it: the sidebar's width and the outline's are two decisions, so the outline opens at
 * {@link OUTLINE_DEFAULT} and neither moves the other.
 *
 * The panel's grid is built from it rather than repeating `'260px 1fr'`, because a literal here
 * and a literal there agreed while being applied to different boxes — a grid track sizes a border
 * box, and the outline's `flex-basis` sizes a content box. The same 260 rendered 16.5px wider on
 * one side, and no comparison of the two numbers could have shown it.
 */
export const SIDEBAR_WIDTH = 260

/**
 * The width the outline opens at.
 *
 * A fixed number: the outline is its own column and opens where its own default says. It is not
 * observed from the sidebar and not derived from the window — either would move a panel the writer
 * never touched.
 */
export const OUTLINE_DEFAULT = 220

/** Twice the default, so the two move together. */
export const OUTLINE_MAX = OUTLINE_DEFAULT * 2

/** What the editor is guaranteed before the outline stops growing. */
export const EDITOR_MIN = 360

/**
 * The widest the outline may be at this workspace width.
 *
 * `Math.max(OUTLINE_MIN, …)` is the load-bearing part. Without it a narrow workspace
 * puts the ceiling *below* the floor — `workspace - EDITOR_MIN` can be smaller than 220
 * — and a ceiling under a floor is not a constraint, it is a lie: CSS lets `min-width`
 * beat `max-width`, so the outline would sit at 220 while the handle appeared to allow
 * less. Flooring the result means the two can never cross.
 * @param workspaceWidth - the lower band's measured width, or 0 before it is measured.
 * @returns a width that is never below `OUTLINE_MIN`.
 */
export function outlineCeiling(workspaceWidth: number): number {
  if (!Number.isFinite(workspaceWidth) || workspaceWidth <= 0) return OUTLINE_MAX
  return Math.max(OUTLINE_MIN, Math.min(OUTLINE_MAX, workspaceWidth - EDITOR_MIN))
}

/**
 * How far the writer may drag, right now.
 *
 * The outline's own bounds, and then the editor's floor on top: this is the only place the band
 * width is allowed to bite, because dragging is the only moment the writer is asking for a new
 * width and the editor's floor is a statement about what a *new* width may cost.
 * @param width - what the drag or the keyboard asked for.
 * @param workspaceWidth - the lower band's measured width, or 0 before it is measured.
 * @returns the width to actually use.
 */
export function clampOutline(width: number, workspaceWidth: number): number {
  if (!Number.isFinite(width)) return OUTLINE_DEFAULT
  return Math.max(OUTLINE_MIN, Math.min(width, outlineCeiling(workspaceWidth)))
}

/**
 * What actually gets rendered.
 *
 * The outline's own bounds and nothing else. The band width is deliberately absent: a width the
 * writer chose must not shrink because a window was resized, and a default must not turn into a
 * different number on a narrow screen. The band width bounds *dragging* ({@link clampOutline}), and
 * that is the only moment a new width is being asked for.
 *
 * A stored width is an answer the writer already gave. Only the writer changes it.
 * @param width - the stored width.
 * @returns the width to render.
 */
export function clampStoredWidth(width: number): number {
  if (!Number.isFinite(width)) return OUTLINE_DEFAULT
  return Math.max(OUTLINE_MIN, Math.min(width, OUTLINE_MAX))
}
