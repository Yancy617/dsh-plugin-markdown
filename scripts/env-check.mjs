#!/usr/bin/env node
/**
 * 只读环境报告，对应 docs/开发环境.md §0。
 *
 * 内容
 * - DEFAULT_ASAR / DSH_PACKAGE / PLUGIN；asarPathFrom / readFully / readAsarJson / 主报告。
 *
 * 行为
 * - 读仓库 / Node / npm / pnpm / git / DSH 安装版本 / profile / 链接 / junction / bundles。
 * - 不写文件、不安装、不读凭据。
 * - 任一核心事实读不到就打印 unknown 并 exit 1。
 *
 * 边界
 * - 不修复环境；不猜版本。
 *
 * 相关文件
 * - docs/开发环境.md；package.json 的 env:check。
 *
 * 改哪里
 * - 改读取：readAsarJson。
 * - 改报告项：主流程。
 */
import { closeSync, openSync, readFileSync, readSync, realpathSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Default install path; override with --asar or DSH_ASAR. */
const DEFAULT_ASAR = 'D:\\Program Files\\DeepSeek Harness\\resources\\app.asar'
/** Package name looked up inside the asar. */
const DSH_PACKAGE = 'dsh/package.json'
/** Plugin package name; used for finding the profile's link target. */
const PLUGIN = '@yancy617/dsh-plugin-markdown'

/**
 * @param {string[]} argv - process.argv.slice(2).
 * @returns {string} asar path.
 */
function asarPathFrom(argv) {
  const flag = argv.indexOf('--asar')
  if (flag !== -1 && argv[flag + 1]) return argv[flag + 1]
  return process.env.DSH_ASAR ?? DEFAULT_ASAR
}

/**
 * Read exactly `length` bytes, retrying short reads.
 *
 * @param {number} fd - open file descriptor.
 * @param {Buffer} buffer - destination.
 * @param {number} offset - destination offset.
 * @param {number} length - bytes wanted.
 * @param {number} position - file position.
 */
function readFully(fd, buffer, offset, length, position) {
  let done = 0
  while (done < length) {
    const n = readSync(fd, buffer, offset + done, length - done, position + done)
    if (n <= 0) throw new Error('short read')
    done += n
  }
}

/**
 * Read one JSON file out of an Electron asar archive without unpacking it.
 *
 * The archive starts with a 16-byte preamble; the last uint32 is the byte
 * length of the JSON header that follows. File offsets in that header are
 * relative to the end of the header. The three size candidates are a fallback
 * for format drift: a wrong one fails JSON.parse and the next is tried.
 *
 * @param {string} asar - archive path.
 * @param {string} packagePath - slash-separated path inside the archive.
 * @returns {any | null} parsed JSON, or null when it cannot be read.
 */
function readAsarJson(asar, packagePath) {
  let fd
  try {
    fd = openSync(asar, 'r')
  } catch {
    return null
  }
  try {
    const preamble = Buffer.alloc(16)
    readFully(fd, preamble, 0, 16, 0)
    for (const headerSize of [preamble.readUInt32LE(12), preamble.readUInt32LE(8), preamble.readUInt32LE(4)]) {
      if (!headerSize || headerSize > 64 * 1024 * 1024) continue
      try {
        const headerBuffer = Buffer.alloc(headerSize)
        readFully(fd, headerBuffer, 0, headerSize, 16)
        const header = JSON.parse(headerBuffer.toString('utf8'))
        let node = header
        for (const segment of packagePath.split('/')) {
          node = node?.files?.[segment]
          if (!node) break
        }
        if (!node || node.offset === undefined) continue
        const content = Buffer.alloc(node.size)
        readFully(fd, content, 0, node.size, 16 + headerSize + Number(node.offset))
        return JSON.parse(content.toString('utf8'))
      } catch {
        // Wrong candidate or a corrupt entry: try the next one.
      }
    }
    return null
  } finally {
    closeSync(fd)
  }
}

/**
 * @param {string} file - JSON file path.
 * @returns {any | null} parsed JSON, or null.
 */
function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/**
 * @param {string} command - shell command.
 * @returns {string} trimmed stdout, or `unknown`.
 */
function run(command) {
  try {
    return execSync(command, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      timeout: 15_000,
    }).trim()
  } catch {
    return 'unknown'
  }
}

const asar = asarPathFrom(process.argv.slice(2))
const profileDir = join(process.env.USERPROFILE ?? homedir(), '.dsh', 'profiles', 'desktop')
const profile = readJson(join(profileDir, 'package.json'))
const dependencies = profile?.dependencies ?? {}
const linkEntry = Object.entries(dependencies).find(
  ([, value]) => typeof value === 'string' && value.startsWith('link:'),
)
const linkTarget = linkEntry ? linkEntry[1].slice('link:'.length) : null
const bundles = profile?.dsh?.profile?.bundles ?? []
const dshPackage = readAsarJson(asar, DSH_PACKAGE)

let junction = null
if (linkEntry) {
  try {
    junction = realpathSync(join(profileDir, 'node_modules', ...linkEntry[0].split('/')))
  } catch {
    junction = null
  }
}

const repoRaw = run('git rev-parse --show-toplevel')
const repo = process.platform === 'win32' ? repoRaw.replace(/\//g, '\\') : repoRaw
const npmVersion = run('npm -v')
const pnpmVersion = run('pnpm -v')
const gitVersion = run('git --version').replace(/^git version\s+/, '')
const failures = []
if (repo === 'unknown') failures.push('repo')
if ([npmVersion, pnpmVersion, gitVersion].includes('unknown')) failures.push('tool versions')
if (!dshPackage?.version) failures.push('dsh version')
if (!profile) failures.push('profile package.json')
if (!linkEntry) failures.push('profile link')
if (linkEntry && !junction) failures.push('profile junction')
if (linkEntry && !bundles.includes(linkEntry[0])) failures.push('profile bundles')

const rows = [
  ['repo', repo],
  ['node', `${process.version}  ${process.execPath}`],
  ['npm', npmVersion],
  ['pnpm', pnpmVersion],
  ['git', gitVersion],
  ['dsh', `${dshPackage?.version ?? 'unknown'}  ${asar}`],
  ['profile', profileDir],
  ['link', linkEntry ? `${linkEntry[0]} -> ${linkTarget}` : 'missing'],
  ['junction', junction ?? 'missing'],
  ['bundles', linkEntry && bundles.includes(linkEntry[0]) ? 'ok' : 'missing'],
]

const width = Math.max(...rows.map(([label]) => label.length))
for (const [label, value] of rows) console.log(`${label.padEnd(width)}  ${value}`)

if (failures.length > 0) {
  console.error(`\nCHECK FAILED: ${failures.join('; ')} — report this instead of guessing.`)
  process.exitCode = 1
}
