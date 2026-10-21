/**
 * 一个文件 / 文件夹名字是否合法（两半共用）。
 *
 * 内容
 * - EntryNamePlatform / entryNameProblem / platformOfUserAgent。
 *
 * 行为
 * - Windows：禁止 `< > : " / \ | ? *`、U+0000–U+001F、空名、`.` / `..`、
 *   以空格或句点结尾，以及 CON / PRN / AUX / NUL / COM1–9 / LPT1–9 这些保留设备名
 *   （带扩展名也算，`NUL.txt` 与 `NUL` 同义）。
 * - POSIX（macOS / Linux）：只禁止空名、`.` / `..`、`/` 与 NUL。
 * - 只回答“哪里不行、该怎么说”，不改名字、不裁剪、不判重名。
 *
 * 边界
 * - 不访问文件系统，不判断路径总长度，也不判断目标是否已经存在。
 * - 不决定提示出现在哪个界面；客户端用它做输入提示，Host 用它做落盘前的兜底。
 *
 * 相关文件
 * - 被依赖：src/client/workbench/Dialogs.tsx、src/host/vault.ts、scripts/probe-units.ts。
 *
 * 改哪里
 * - 改哪类平台、哪些字符：entryNameProblem。
 * - 改客户端怎么认平台：platformOfUserAgent。
 */

/** Which operating system's naming rules apply. */
export type EntryNamePlatform = 'windows' | 'posix'

/**
 * The characters Windows reserves for path syntax.
 *
 * Quoted from Microsoft Learn, “Naming Files, Paths, and Namespaces”:
 * the reserved characters are `< > : " / \ | ? *`, plus NUL and U+0001–U+001F.
 * @see https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-file
 */
const WINDOWS_RESERVED = /[<>:"/\\|?*]/g

/** Control characters Windows refuses in a name. */
const CONTROL = /[\u0000-\u001F]/

/**
 * Device names Windows keeps out of every directory, with or without an extension.
 *
 * `COM¹` / `COM²` / `COM³` and the LPT equivalents are in the official list because Windows
 * reads the ISO/IEC 8859-1 superscript digits as digits.
 */
const WINDOWS_DEVICE = /^(CON|PRN|AUX|NUL|COM[1-9\u00B9\u00B2\u00B3]|LPT[1-9\u00B9\u00B2\u00B3])$/i

/**
 * What is wrong with one entry's name, if anything.
 * @param name - the complete basename the entry would have (extension included).
 * @param platform - whose rules to apply.
 * @returns a sentence to show the writer, or `null` when the name is usable.
 */
export function entryNameProblem(
  name: string,
  platform: EntryNamePlatform,
): string | null {
  if (name.trim() === '') return '名称不能为空。'
  if (name === '.' || name === '..') return '名称不能是「.」或「..」。'
  if (name.includes('\u0000')) return '名称不能包含空字符。'

  if (platform === 'posix') {
    if (name.includes('/')) return '名称不能包含「/」。'
    return null
  }

  if (CONTROL.test(name)) return '名称不能包含换行、制表符等控制字符。'
  const found = [...new Set(name.match(WINDOWS_RESERVED) ?? [])]
  if (found.length > 0) return `名称不能包含这些符号：${found.join(' ')}。`
  if (/[ .]$/.test(name)) return '名称不能以空格或句点结尾。'

  // Windows compares the part before the first dot with its device list, so `NUL.tar.gz` is
  // reserved for the same reason `NUL` is.
  const stem = name.split('.')[0] ?? ''
  if (WINDOWS_DEVICE.test(stem)) {
    return `「${stem}」是系统保留名称，不能用作文件或文件夹名。`
  }
  return null
}

/**
 * Which naming rules a browser / Electron session should preview.
 *
 * The Host is the authority and checks its own `process.platform`; this only decides which
 * message the dialog can show before a request is sent.
 * @param userAgent - `navigator.userAgent`.
 * @returns `'windows'` on a Windows runtime, `'posix'` everywhere else.
 */
export function platformOfUserAgent(userAgent: string): EntryNamePlatform {
  return /Windows/i.test(userAgent) ? 'windows' : 'posix'
}
