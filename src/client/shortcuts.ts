/**
 * 面板的键盘快捷键：一张表。
 *
 * 内容
 * - Device / deviceOf / currentDevice。
 * - Shortcut / SHORTCUTS / KeyEventLike / matches / shortcutFor。
 *
 * 行为
 * - 每条 = 物理 code + 修饰键 + commandId（+ 可选 target / only）。
 * - 匹配 KeyboardEvent.code，不按字符。
 * - 命令的标签 / 前置条件 / 行为都来自工作台注册表。
 * - 只有 F2 需要 target: 'hovered'；devices 省略表示所有运行时。
 *
 * 边界
 * - 不负责命令实现（MarkdownWorkbench.tsx）。
 * - 不负责平台保留键；表只声明本插件自己的绑定。
 *
 * 相关文件
 * - 被依赖：MarkdownWorkbench.tsx、CommandPalette.tsx。
 *
 * 改哪里
 * - 改绑定：SHORTCUTS。
 * - 改匹配：matches / shortcutFor / deviceOf。
 */

/**
 * One runtime, in the platform's own vocabulary: how it is delivered, and on what.
 *
 * The six values are the platform's — a shortcut command there declares a default for
 * each of `desktop:macos`, `desktop:windows`, `desktop:linux`, `web:macos`,
 * `web:windows` and `web:linux`, and 「省略的配置不绑定按键」. This table borrows both
 * the vocabulary and that rule.
 */
export type Device =
  | 'desktop:windows'
  | 'desktop:macos'
  | 'desktop:linux'
  | 'web:windows'
  | 'web:macos'
  | 'web:linux'

/**
 * Which runtime a user agent string is.
 *
 * Detected from the user agent because the platform exposes no flag for it: the client
 * context this plugin is composed with carries `slots` and `uiWorkspace` and nothing
 * that answers "am I the desktop app". `Electron` in the string is the marker, and it is
 * there to be found — `app.asar` never calls `setUserAgent`, so Electron's default (which
 * carries the token) is what the renderer sees.
 * @param userAgent - `navigator.userAgent`.
 * @returns the runtime, in the platform's vocabulary.
 */
export function deviceOf(userAgent: string): Device {
  const delivered = userAgent.includes('Electron') ? 'desktop' : 'web'
  const host = /Windows/i.test(userAgent)
    ? 'windows'
    : /Macintosh|Mac OS X/i.test(userAgent)
      ? 'macos'
      : 'linux'
  return `${delivered}:${host}` as Device
}

/** One binding: a key, the command it reaches, and where it applies. */
export interface Shortcut {
  /** Physical key, matched against `KeyboardEvent.code` — `KeyS`, `F2`, `Digit7`. */
  readonly code: string
  /** The primary modifier: Command on macOS, Control elsewhere. */
  readonly mod?: boolean
  /** Alt. */
  readonly alt?: boolean
  /** Shift. */
  readonly shift?: boolean
  /** The command this reaches, by the id the registry knows it by. */
  readonly commandId: string
  /**
   * Where the command's argument comes from, for the commands that take one.
   *
   * `hovered` means "the tree row under the pointer" — the only argument any binding
   * needs so far, and the reason `F2` is not a plain command: `rename` does nothing
   * without a target. Omitting this field means the command takes no argument.
   */
  readonly target?: 'hovered'
  /**
   * 这条绑定适用的运行时。省略表示全部。
   *
   * 目前没有行设置它；它是“这条 chord 只在某些运行时安全”的表达，shortcutFor 会按它过滤。
   */
  readonly only?: readonly Device[]
}

/**
 * Every binding, in match order.
 *
 * Order matters only in that the first match wins, and the chords are disjoint.
 */
export const SHORTCUTS: readonly Shortcut[] = [
  // The panel's own K action, beside the platform's `Mod+K` for session search. Kept
  // here rather than as a special case in the listener, so every binding this panel owns
  // is a row in this one table — which is what lets a check look for collisions.
  { code: 'KeyK', mod: true, shift: true, commandId: 'openPalette' },
  { code: 'KeyS', mod: true, commandId: 'save' },
  { code: 'KeyF', mod: true, commandId: 'toggleFind' },
  { code: 'KeyW', mod: true, alt: true, commandId: 'closeDocument' },
  { code: 'F2', commandId: 'rename', target: 'hovered' },
]

/**
 * The runtime this page is, read once.
 *
 * **Called by the listener, not at import.** Everything above is pure — a table and the
 * rules for matching against it — and this module is imported by `scripts/probe-units.ts`,
 * which runs in node and has no `navigator`. Reading the browser at module scope would
 * make importing the table a browser-only act for no gain: the answer cannot change while
 * the page is loaded, so the listener asks once and keeps it.
 * @returns the runtime, in the platform's vocabulary.
 */
export function currentDevice(): Device {
  return deviceOf(window.navigator.userAgent)
}

/**
 * What a key event has to offer for matching, so this can be tested without a DOM.
 *
 * A structural subset of `KeyboardEvent` rather than the event itself.
 */
export interface KeyEventLike {
  /** Physical key. */
  readonly code: string
  /** Command on macOS. */
  readonly metaKey: boolean
  /** Control elsewhere. */
  readonly ctrlKey: boolean
  /** Alt. */
  readonly altKey: boolean
  /** Shift. */
  readonly shiftKey: boolean
}

/**
 * Whether an event is exactly this shortcut.
 *
 * **Exact**, not "at least": `Mod+Shift+S` is not `Mod+S`, so a modification the table
 * did not ask for means no match. Without that, a future `Mod+Shift+S` would fire the
 * plain save as well.
 * @param shortcut - the binding.
 * @param event - the key event.
 * @returns whether they are the same chord.
 */
export function matches(shortcut: Shortcut, event: KeyEventLike): boolean {
  return (
    event.code === shortcut.code &&
    (event.metaKey || event.ctrlKey) === (shortcut.mod === true) &&
    event.altKey === (shortcut.alt === true) &&
    event.shiftKey === (shortcut.shift === true)
  )
}

/**
 * The binding an event is, if the table has one for this runtime.
 * @param event - the key event.
 * @param device - which runtime to resolve against.
 * @returns the binding, or `null`.
 */
export function shortcutFor(event: KeyEventLike, device: Device): Shortcut | null {
  for (const shortcut of SHORTCUTS) {
    if (shortcut.only !== undefined && !shortcut.only.includes(device)) continue
    if (matches(shortcut, event)) return shortcut
  }
  return null
}
