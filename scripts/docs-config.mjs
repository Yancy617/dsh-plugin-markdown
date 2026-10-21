/**
 * 公开文档的规则：哪几份公开、怎么脱敏、链接怎么改。
 *
 * 内容
 * - PUBLIC_FILES / KEEP_LINKS / SANITIZE / sanitize / rewriteLinks / rewriteCodePaths / documentName。
 *
 * 行为
 * - **白名单是唯一事实**：生成脚本与校验脚本都从这里读，所以"公开哪几份"只在一处改。
 * - SANITIZE 的顺序有意义：先具体（本机固定根），后笼统（任何盘符路径）。
 * - 链接改写只做三类：未公开的降级为文字、公开的收敛到同目录、仓库公共文件原样。
 *
 * 边界
 * - 纯函数与常量；不读文件、不写文件、不认识 git。
 *
 * 相关文件
 * - 被依赖：scripts/docs-public.mjs（生成）、scripts/docs-check.mjs（校验）。
 *
 * 改哪里
 * - 公开哪几份：PUBLIC_FILES。
 * - 还允许指向哪些公共文件：KEEP_LINKS。
 * - 脱敏规则：SANITIZE。
 */
import { fileURLToPath } from 'node:url'

const REPO = 'https://github.com/Yancy617/dsh-plugin-markdown/blob/main'

/** 生成到 `public-docs/` 的文档；数组顺序就是 README 里的推荐阅读顺序。 */
export const PUBLIC_FILES = ['架构.md', '文件职责.md', '方案-保真.md', '语法覆盖-对照表.md', '开发环境.md']

/** 仓库里本来就公开的文件：指向它们的链接不降级。 */
export const KEEP_LINKS = new Set(['AGENTS.md', 'README.md', 'LICENSE'])

/** 脱敏规则，先具体后笼统；顺序有意义。 */
export const SANITIZE = [
  // 用户目录：只换用户名，保留 `\.dsh\profiles\...` 这类公共后缀。
  [/[A-Za-z]:\\Users\\[A-Za-z0-9._-]+/g, '%USERPROFILE%'],
  // 这台机器的几个固定根，带空格也能整段吃掉；正斜杠写法（`link:D:/...`）同样处理。
  [/D:\\Program Files\\DeepSeek Harness[^`"'，。；）\]]*/g, '<DSH 安装目录>'],
  [/D:\\DevTools[^`"'，。；）\]]*/g, '<工具链目录>'],
  [/D:\\01DSH[^`"'，。；）\]]*/g, '<仓库目录>'],
  [/D:\\01YancyDoc[^`"'，。；）\]]*/g, '<笔记目录>'],
  [/D:\/01DSH[^`"'，。；）\]]*/g, '<仓库目录>'],
  [/D:\/01YancyDoc[^`"'，。；）\]]*/g, '<笔记目录>'],
  // 兜底：任何剩下的盘符路径。前面紧挨字母的不算（`https://` 里的 `s:/` 不是路径）。
  [/(?<![A-Za-z])[A-Za-z]:\\[^\s`"'，。；：、（）【】《》|*<>\[\]\u4e00-\u9fff)]*/g, '<本机路径>'],
  [/(?<![A-Za-z])[A-Za-z]:\/[^\s`"'，。；：、（）【】《》|*<>\[\]\u4e00-\u9fff)]*/g, '<本机路径>'],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<邮箱>'],
  [/\b(?:npm_[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,})/g, '<凭据>'],
  [/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer <凭据>'],
]

/** 校验脚本用的"不该出现在公开文档里"的样式（与 SANITIZE 一一对应）。 */
export const FORBIDDEN = [
  { label: '盘符路径', pattern: /(?<![A-Za-z])[A-Za-z]:[\\/]/ },
  { label: '邮箱', pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
  { label: '凭据样式', pattern: /\b(?:npm_[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,})/ },
  { label: 'Bearer 令牌', pattern: /Bearer\s+(?!<凭据>)[A-Za-z0-9._-]+/ },
]

/**
 * @param {string} text - 源文件内容。
 * @returns {string} 脱敏后的内容。
 */
export function sanitize(text) {
  let out = text
  for (const [pattern, replacement] of SANITIZE) out = out.replace(pattern, replacement)
  return out
}

/**
 * @param {string} target - 链接目标。
 * @returns {string | null} 目标里的文档文件名；不是文档链接时答 `null`。
 */
export function documentName(target) {
  const path = target.split('#')[0] ?? ''
  if (!path.endsWith('.md')) return null
  const name = path.slice(path.lastIndexOf('/') + 1)
  return name === '' ? null : name
}

/**
 * 链接改写：未公开的文档链接降级为纯文字，公开的收敛到同目录，仓库公共文件保持原样。
 * @param {string} text - 脱敏后的内容。
 * @returns {string} 改写后的内容。
 */
export function rewriteLinks(text) {
  const publicFiles = new Set(PUBLIC_FILES)
  return text.replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, (whole, label, target) => {
    if (target.startsWith('#')) return whole
    const absolute = /^https?:/i.test(target)
    const name = documentName(target)
    if (name === null) return whole
    if (KEEP_LINKS.has(name)) return whole
    if (!publicFiles.has(name)) return label
    return absolute ? `[${label}](${REPO}/public-docs/${name})` : `[${label}](${name})`
  })
}

/**
 * 代码段里的 `docs/<名字>`：公开的指向新位置，内部的原样保留（读者看到的是文件名，不是死链）。
 * @param {string} text - 内容。
 * @returns {string} 改写后的内容。
 */
export function rewriteCodePaths(text) {
  const publicFiles = new Set(PUBLIC_FILES)
  return text.replace(/`docs\/([^`]+\.md)`/g, (whole, name) =>
    publicFiles.has(name) ? `\`public-docs/${name}\`` : whole,
  )
}

/**
 * 去掉只在内部成立的小节：源文件里用 `<!-- internal:start -->` / `<!-- internal:end -->` 包起来。
 * @param {string} text - 内容。
 * @returns {string} 去掉内部小节后的内容。
 */
export function stripInternal(text) {
  return text.replace(/<!-- internal:start -->[\s\S]*?<!-- internal:end -->\n*/g, '').replace(/\n{3,}/g, '\n\n')
}

/**
 * @param {string} name - 文件名。
 * @param {string} source - 源内容。
 * @returns {string} 产物内容。
 */
export function render(name, source) {
  const header = `<!-- 自动生成，源文件是 docs/${name}。改源文件后跑 pnpm docs:public；不要改这里。 -->\n\n`
  return header + stripInternal(rewriteCodePaths(rewriteLinks(sanitize(source))))
}

/** 文档目录与产物目录的绝对路径。 */
export const DOCS_DIR = fileURLToPath(new URL('../docs', import.meta.url))
export const OUT_DIR = fileURLToPath(new URL('../public-docs', import.meta.url))
