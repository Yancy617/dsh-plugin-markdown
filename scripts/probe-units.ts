/**
 * 纯函数验收仪器：不建 Lexical 树、不读用户的文件。
 *
 * 内容
 * - check 与下面的分组断言：保存判定 / 冲突分类 / 说明卡的技术详情 / 粘贴形态 / 拖动落点 / 网页通道 /
 *   自动保存节奏 / frontmatter / 路径 / 版本比较。
 *
 * 行为
 * - 每条只报 ok / FAIL，失败时退出码 1；不写盘。
 * - 与 `probe-block.ts` 分开：那边验树与字节，这边验判据。
 *
 * 边界
 * - 不覆盖需要 Lexical 上下文或 DOM 的行为（那些在 probe-block 与人工验收里）。
 *
 * 相关文件
 * - 被依赖：package.json 的 test；tsdown.block.config.ts。
 */

import { hasUnsaved, planSaveSource, utf8Length } from '../src/client/savePlan'
import { classifyStaleWrite } from '../src/client/staleWrite'
import { pasteFlavor } from '../src/client/editor/pasteFlavor'
import { externalDestination } from '../src/client/editor/linkClick'
import { assetFailureLine } from '../src/client/editor/imageInsert'
import { deviceOf, matches, shortcutFor, type KeyEventLike } from '../src/client/shortcuts'
import { dropKind, refuseDrop } from '../src/client/treeDrop'
import { webPageRoute } from '../src/client/webPage'
import { LOCAL_LIMITS, nextWriteDelay } from '../src/client/autoSave'
import { joinFrontmatter, splitFrontmatter } from '../src/client/editor/frontmatter'
import {
  basenameOf,
  chainTo,
  childPath,
  dirnameOf,
  relativePath,
  samePath,
} from '../src/shared/paths'
import { compareVersions } from '../src/shared/version'
import { standardizeBody } from '../src/client/editor/core/standardize'
import {
  copyFamilyOf,
  createdDocumentName,
  documentLabel,
  documentSuffix,
  nextCopyName,
  renamedDocumentName,
} from '../src/shared/documents'
import { entryNameProblem, platformOfUserAgent } from '../src/shared/entryName'
import { stackOf } from '../src/shared/errors'
import { placeCopy } from '../src/client/treeOrder'
import {
  createWorkbenchCommands,
  menuRowsFor,
  type WorkbenchCommandActions,
} from '../src/client/workbench/commands'
import { closeTabs, patchBuffers, withBuffer, withoutBuffers } from '../src/client/workbench/buffers'
import { promptEntryName } from '../src/client/workbench/promptName'
import type { BufferState, PromptState } from '../src/client/workbench/model'
import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import { createSourceBase, isStaleBase } from '../src/client/editor/saveBase'
import {
  clampOutline,
  clampStoredWidth,
  outlineCeiling,
  OUTLINE_DEFAULT,
  OUTLINE_MAX,
  OUTLINE_MIN,
} from '../src/client/layout'

let failures = 0

/**
 * @param title - what is being asserted.
 * @param ok - the assertion.
 * @param detail - optional reading shown next to it.
 */
function check(title: string, ok: boolean, detail = ''): void {
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${title}${detail === '' ? '' : ` — ${detail}`}`)
}

// ── 保存判定 ────────────────────────────────────────────────────────────────
const same = planSaveSource({ saved: 'a', source: 'a' })
check('保存判定：文本相同 ⇒ none', same.kind === 'none')
const differs = planSaveSource({ saved: 'a', source: 'b' })
check('保存判定：文本不同 ⇒ 写 source', differs.kind === 'write' && differs.content === 'b')
check('hasUnsaved 与 planSaveSource 同口径（无改动）', !hasUnsaved({ saved: 'a', source: 'a' }))
check('hasUnsaved 与 planSaveSource 同口径（有改动）', hasUnsaved({ saved: 'a', source: 'b' }))
check('utf8Length：ASCII', utf8Length('A') === 1)
check('utf8Length：两字节', utf8Length('é') === 2)
check('utf8Length：三字节', utf8Length('中') === 3)
check('utf8Length：代理对算四字节', utf8Length('😀') === 4)
check('整篇 standardize：正常正文原样', (() => {
  const result = standardizeBody('a\n\nb\n')
  return result.standard && result.body === 'a\n\nb\n'
})())
check('整篇 standardize：空正文原样', (() => {
  const result = standardizeBody('')
  return result.standard && result.body === ''
})())

// ── 版本冲突分类 ────────────────────────────────────────────────────────────
check(
  '冲突：BOM + CRLF 只算表现 ⇒ same-as-saved',
  classifyStaleWrite('\uFEFFold\r\n', 'old\r\n', 'new') === 'same-as-saved',
)
check('冲突：文件已是目标 ⇒ same-as-target', classifyStaleWrite('new', 'old', 'new') === 'same-as-target')
check('冲突：内容真的不同 ⇒ different', classifyStaleWrite('other', 'old', 'new') === 'different')
check(
  '冲突：空行也是内容 ⇒ different',
  classifyStaleWrite('old\n\n', 'old', 'old') === 'different',
)

// ── 说明卡的技术详情 ────────────────────────────────────────────────────────
// The card has to be useful with no reader in front of it: whatever was thrown, 技术详情 is
// pastable. A value without a stack must not fall back to an empty box.
const thrown = new Error('炸了')
check(
  '技术详情：Error 取整个调用栈',
  stackOf(thrown).startsWith('Error: 炸了') && stackOf(thrown).includes('\n    at '),
  stackOf(thrown).split('\n')[0],
)
check('技术详情：抛出字符串退回原文', stackOf('只有一句话') === '只有一句话')
const bare = new Error('没有栈了')
bare.stack = ''
check('技术详情：没有栈就退回消息', stackOf(bare) === '没有栈了')

// ── 粘贴形态 ────────────────────────────────────────────────────────────────
check(
  '粘贴：没有 HTML ⇒ 按文本 Markdown',
  pasteFlavor({ html: '', text: 'hello', htmlAsMarkdown: '' }) === 'markdown',
)
check(
  '粘贴：纯文本为空 ⇒ 让给 HTML',
  pasteFlavor({ html: '<b>x</b>', text: '   ', htmlAsMarkdown: 'x' }) === 'html',
)
check(
  '粘贴：两种读法一致 ⇒ Markdown',
  pasteFlavor({ html: '<b>x</b>', text: 'x', htmlAsMarkdown: 'x' }) === 'markdown',
)
check(
  '粘贴：两种读法不同 ⇒ HTML',
  pasteFlavor({ html: '<b>x</b>', text: 'y', htmlAsMarkdown: 'x' }) === 'html',
)
check(
  '粘贴：HTML 读不出节点 ⇒ 退回 Markdown',
  pasteFlavor({ html: '<b></b>', text: 'y', htmlAsMarkdown: '' }) === 'markdown',
)
check(
  '粘贴：比较前只抹末尾空白',
  pasteFlavor({ html: '<b>x</b>', text: 'x', htmlAsMarkdown: 'x\n  ' }) === 'markdown',
)

// ── 链接点击判据 ────────────────────────────────────────────────────────────
check(
  '链接：http(s) 规范化后可打开',
  externalDestination(' https://example.com/a ') === 'https://example.com/a',
)
check('链接：相对地址不打开', externalDestination('./note.md') === null)
check('链接：锚点不打开', externalDestination('#section') === null)
check('链接：mailto 不打开', externalDestination('mailto:a@b.c') === null)
check('链接：没有 scheme 的主机名不打开', externalDestination('www.example.com') === null)

// ── 快捷键 ──────────────────────────────────────────────────────────────────
check(
  '快捷键：Electron + Windows 是桌面 Windows',
  deviceOf('Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Electron/30.0') ===
    'desktop:windows',
)
check('快捷键：普通浏览器 + Mac 是 web:macos', deviceOf('Mozilla/5.0 (Macintosh)') === 'web:macos')
const keyS = (overrides: Partial<KeyEventLike> = {}): KeyEventLike => ({
  code: 'KeyS',
  metaKey: false,
  ctrlKey: true,
  altKey: false,
  shiftKey: false,
  ...overrides,
})
check(
  '快捷键：Mod+S 命中 save',
  matches({ code: 'KeyS', mod: true, commandId: 'save' }, keyS()),
)
check(
  '快捷键：多了 Shift 就不是同一条',
  !matches({ code: 'KeyS', mod: true, commandId: 'save' }, keyS({ shiftKey: true })),
)
check('快捷键：按运行时解析到 save', shortcutFor(keyS(), 'web:windows')?.commandId === 'save')
check('快捷键：不认识的组合 ⇒ null', shortcutFor(keyS({ code: 'KeyQ' }), 'web:windows') === null)

// ── 图片写入失败 ────────────────────────────────────────────────────────────
check(
  '图片失败：404 ⇒ 说重启',
  assetFailureLine({ status: 404, message: 'not found' }).includes('重启'),
)
check(
  '图片失败：409 ⇒ 说同名',
  assetFailureLine({ status: 409, message: 'exists' }).includes('同名'),
)
check(
  '图片失败：其他 ⇒ 带上原因',
  assetFailureLine({ status: 500, message: '磁盘满了' }).includes('磁盘满了'),
)

// ── 拖动落点 ────────────────────────────────────────────────────────────────
const row = { top: 100, height: 40 }
check('落点：文档上半 ⇒ before', dropKind(row, 110, false) === 'before')
check('落点：文档下半 ⇒ after', dropKind(row, 130, false) === 'after')
check('落点：文件夹上四分位 ⇒ before', dropKind(row, 105, true) === 'before')
check('落点：文件夹中段 ⇒ into', dropKind(row, 120, true) === 'into')
check('落点：文件夹下四分位 ⇒ after', dropKind(row, 135, true) === 'after')

const source = { path: 'C:/vault/a', name: 'a', isDirectory: true, parent: 'C:/vault' }
check('拒绝：落到自己 ⇒ itself', refuseDrop(source, 'C:/vault/a', null) === 'itself')
check('拒绝：落到自己内部 ⇒ inside', refuseDrop(source, 'C:/vault/a/b', null) === 'inside')
check('拒绝：同层换位 ⇒ 放行', refuseDrop(source, 'C:/vault', null) === null)
check(
  '拒绝：目标已有同名 ⇒ same-name',
  refuseDrop(source, 'C:/vault/other', ['a']) === 'same-name',
)
check('拒绝：目标层级未加载 ⇒ 先放行给 Host', refuseDrop(source, 'C:/vault/other', null) === null)

// ── 网页通道 ────────────────────────────────────────────────────────────────
check(
  '网页：没有 sidebarRight ⇒ panel，原因说服务',
  webPageRoute({ service: false, registry: false, kind: false, mounted: false }).reason?.includes(
    '右侧栏服务',
  ) === true,
)
check(
  '网页：没有标签注册表 ⇒ panel，原因说注册表',
  webPageRoute({ service: true, registry: false, kind: false, mounted: false }).reason?.includes(
    '注册表',
  ) === true,
)
check(
  '网页：没有在屏会话 ⇒ panel，原因说浏览器标签',
  webPageRoute({ service: true, registry: true, kind: true, mounted: false }).reason?.includes(
    '浏览器标签',
  ) === true,
)
const platform = webPageRoute({ service: true, registry: true, kind: true, mounted: true })
check('网页：四道门全过 ⇒ dshtab', platform.channel === 'dshtab' && platform.reason === null)

// ── 自动保存节奏 ────────────────────────────────────────────────────────────
const ready = { dirty: true, idleMs: 0, sinceWriteMs: 0, writing: false, blocked: false }
check('节奏：不脏 ⇒ 不排', nextWriteDelay({ ...ready, dirty: false }, LOCAL_LIMITS) === null)
check('节奏：失败后站住 ⇒ 不排', nextWriteDelay({ ...ready, blocked: true }, LOCAL_LIMITS) === null)
check('节奏：写在飞 ⇒ 不排', nextWriteDelay({ ...ready, writing: true }, LOCAL_LIMITS) === null)
check(
  '节奏：刚改动 ⇒ 等 idle',
  nextWriteDelay(ready, LOCAL_LIMITS) === LOCAL_LIMITS.idleMs,
)
check(
  '节奏：已经停了很久 ⇒ 立刻写',
  nextWriteDelay({ ...ready, idleMs: 5000, sinceWriteMs: 19000 }, LOCAL_LIMITS) === 0,
)
check(
  '节奏：长期没写 ⇒ maxWait 先到',
  nextWriteDelay({ ...ready, idleMs: 0, sinceWriteMs: 19500 }, LOCAL_LIMITS) ===
    LOCAL_LIMITS.maxWaitMs - 19500,
)

// ── frontmatter ─────────────────────────────────────────────────────────────
const mapped = splitFrontmatter('---\ntitle: x\n---\nbody')
check('frontmatter：正常块切走，正文原样', mapped.frontmatter === '---\ntitle: x\n---' && mapped.body === 'body')
const emptyBlock = splitFrontmatter('---\n---\nbody')
check(
  'frontmatter：空块算 frontmatter',
  emptyBlock.frontmatter === '---\n---' && emptyBlock.body === 'body',
)
check('frontmatter：纯注释块不算', splitFrontmatter('---\n# c\n---\nbody').frontmatter === null)
check('frontmatter：key:value 没有空格不算', splitFrontmatter('---\na:1\n---\nbody').frontmatter === null)
check(
  'frontmatter：key 下的块序列算',
  splitFrontmatter('---\ntags:\n- a\n---\nbody').frontmatter !== null,
)
check('frontmatter：没有 frontmatter 时 join 原样', joinFrontmatter(null, 'body') === 'body')
check(
  'frontmatter：join 拼回一行换行',
  joinFrontmatter('---\ntitle: x\n---', 'body') === '---\ntitle: x\n---\nbody',
)
const crlf = '---\r\ntitle: x\r\n---\r\nbody'
const crlfSplit = splitFrontmatter(crlf)
check(
  'frontmatter：CRLF 文档切 / 拼逐字节相同',
  crlfSplit.frontmatter !== null &&
    crlfSplit.body === 'body' &&
    joinFrontmatter(crlfSplit.frontmatter, crlfSplit.body) === crlf,
)
check(
  'frontmatter：正文是 CRLF 时边界也用 CRLF',
  joinFrontmatter('---\ntitle: x\n---', 'a\r\nb') === '---\ntitle: x\n---\r\na\r\nb',
)

// ── 路径 ────────────────────────────────────────────────────────────────────
check('路径：childPath 跟父级反斜杠', childPath('C:\\vault', 'a') === 'C:\\vault\\a')
check('路径：childPath 跟父级正斜杠', childPath('C:/vault/', 'a') === 'C:/vault/a')
check('路径：samePath 只统一分隔符', samePath('C:\\vault\\a', 'C:/vault/a'))
check('路径：relativePath 取相对', relativePath('C:/vault', 'C:/vault/a/b') === 'a/b')
check('路径：relativePath 根是空串', relativePath('C:/vault/', 'C:/vault') === '')
check('路径：relativePath 根外是 null', relativePath('C:/vault', 'C:/other/a') === null)
check(
  '路径：chainTo 逐级',
  chainTo('C:/vault', 'C:/vault/a/b').join('|') === 'C:/vault/a|C:/vault/a/b',
)
check('路径：dirnameOf 不补尾分隔符', dirnameOf('C:/vault/a') === 'C:/vault')
check('路径：basenameOf', basenameOf('C:/vault/a.md') === 'a.md')

// ── 文档名与重命名 ──────────────────────────────────────────────────────────
check('文档名：去掉已知格式', documentLabel('会议.md') === '会议')
check('文档名：格式大小写不敏感', documentLabel('Note.MD') === 'Note')
check('文档名：只去掉最后一段格式', documentLabel('a.md.bak.md') === 'a.md.bak')
check('文档名：不是文档名就原样', documentLabel('README') === 'README')
check('文档格式：认出 .markdown', documentSuffix('a.markdown') === '.markdown')
check('文档格式：没有就答 null', documentSuffix('README') === null)
check('重命名：格式自动接回', renamedDocumentName('会议.md', '周会') === '周会.md')
check(
  '重命名：自己带了同一格式就不重复',
  renamedDocumentName('会议.md', '周会.md') === '周会.md',
)
check(
  '重命名：大小写不同的同一格式也不重复',
  renamedDocumentName('会议.md', '周会.MD') === '周会.MD',
)
check('重命名：名字没改就返回原名', renamedDocumentName('会议.md', '会议') === '会议.md')
check('重命名：只输入格式算没改', renamedDocumentName('会议.md', '.md') === '会议.md')
check('重命名：输入为空算没改', renamedDocumentName('会议.md', '') === '会议.md')
check(
  '重命名：另一个格式算名字的一部分',
  renamedDocumentName('会议.md', '周会.txt') === '周会.txt.md',
)
check('重命名：原文件没有已知格式就原样使用', renamedDocumentName('README', 'READ2') === 'READ2')
check('新建文档：没有扩展名补 .md', createdDocumentName('会议') === '会议.md')
check('新建文档：已有扩展名照用', createdDocumentName('会议.txt') === '会议.txt')

// ── 名字合法性 ──────────────────────────────────────────────────────────────
check('命名：Windows 普通名字放行', entryNameProblem('会议.md', 'windows') === null)
check('命名：Windows 允许空格与点开头的名字', entryNameProblem('我的 笔记.md', 'windows') === null)
for (const symbol of ['<', '>', ':', '"', '/', '\\', '|', '?', '*']) {
  check(
    `命名：Windows 拒绝「${symbol}」`,
    entryNameProblem(`a${symbol}b.md`, 'windows') !== null,
  )
}
const colonMessage = entryNameProblem('a:b.md', 'windows')
check('命名：提示里说出非法符号', colonMessage !== null && colonMessage.includes(':'))
check('命名：Windows 拒绝控制字符', entryNameProblem('a\nb.md', 'windows') !== null)
check('命名：Windows 拒绝制表符', entryNameProblem('a\tb.md', 'windows') !== null)
check('命名：Windows 拒绝结尾空格', entryNameProblem('笔记 ', 'windows') !== null)
check('命名：Windows 拒绝结尾句点', entryNameProblem('笔记.', 'windows') !== null)
for (const name of ['CON', 'con.md', 'NUL.tar.gz', 'COM1.md', 'LPT9', 'COM¹']) {
  check(`命名：Windows 保留名「${name}」`, entryNameProblem(name, 'windows') !== null)
}
const deviceMessage = entryNameProblem('CON', 'windows')
check('命名：保留名提示里带上名字', deviceMessage !== null && deviceMessage.includes('CON'))
check('命名：COM10 不是保留名', entryNameProblem('COM10.md', 'windows') === null)
check('命名：CONSOLE 不是保留名', entryNameProblem('CONSOLE.md', 'windows') === null)
check('命名：POSIX 放行冒号与问号', entryNameProblem('a:b?.md', 'posix') === null)
check('命名：POSIX 放行结尾空格', entryNameProblem('笔记 ', 'posix') === null)
check('命名：POSIX 拒绝斜杠', entryNameProblem('a/b.md', 'posix') !== null)
check('命名：POSIX 拒绝空字符', entryNameProblem('a\u0000b', 'posix') !== null)
check('命名：任何平台都拒绝 . 与 ..', entryNameProblem('.', 'posix') !== null)
check(
  '平台：Windows UA ⇒ windows',
  platformOfUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64)') === 'windows',
)
check(
  '平台：macOS UA ⇒ posix',
  platformOfUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)') === 'posix',
)

// ── 对话框最终会用的名字 ────────────────────────────────────────────────────
const renameFile: PromptState = {
  kind: 'rename',
  target: { path: 'C:/v/a.md', name: 'a.md', isDirectory: false },
}
const renameDirectory: PromptState = {
  kind: 'rename',
  target: { path: 'C:/v/d', name: 'd', isDirectory: true },
}
const newFile: PromptState = { kind: 'file', directory: 'C:/v' }
const newDirectory: PromptState = { kind: 'directory', directory: 'C:/v' }
check('对话框名：改名文档接回格式', promptEntryName(renameFile, '周会') === '周会.md')
check('对话框名：改名文件夹原样', promptEntryName(renameDirectory, '资料2') === '资料2')
check('对话框名：新建文档补 .md', promptEntryName(newFile, '会议') === '会议.md')
check('对话框名：新建文档已有格式照用', promptEntryName(newFile, '会议.txt') === '会议.txt')
check('对话框名：新建文件夹原样', promptEntryName(newDirectory, '资料') === '资料')
check('对话框名：输入为空 ⇒ 空串', promptEntryName(newFile, '   ') === '')
check(
  '对话框名：非法符号在校验前已经拼上格式',
  entryNameProblem(promptEntryName(newFile, 'a:b'), 'windows') !== null,
)

// ── 副本命名与落点 ──────────────────────────────────────────────────────────
check('副本：第一份是 副本1', nextCopyName('需求说明.md', new Set()) === '需求说明 副本1.md')
check(
  '副本：从 副本1 递增到 副本2',
  nextCopyName('需求说明 副本1.md', new Set(['需求说明 副本1.md'])) === '需求说明 副本2.md',
)
check(
  '副本：从 副本2 递增到 副本3',
  nextCopyName('需求说明 副本2.md', new Set(['需求说明 副本2.md'])) === '需求说明 副本3.md',
)
check(
  '副本：下一个号被占用就继续 +1',
  nextCopyName(
    '需求说明 副本1.md',
    new Set(['需求说明 副本1.md', '需求说明 副本2.md']),
  ) === '需求说明 副本3.md',
)
check(
  '副本：基础名有空号时填空号',
  nextCopyName(
    '需求说明.md',
    new Set(['需求说明.md', '需求说明 副本1.md', '需求说明 副本3.md']),
  ) === '需求说明 副本2.md',
)
check(
  '副本：只有 副本 没有数字 ⇒ 下一次 副本1',
  nextCopyName('需求说明 副本.md', new Set(['需求说明 副本.md'])) === '需求说明 副本1.md',
)
check(
  '副本：没有空格的 副本 不当作编号',
  nextCopyName('需求说明副本1.md', new Set(['需求说明副本1.md'])) ===
    '需求说明副本1 副本1.md',
)
check('副本：扩展名大小写保留', nextCopyName('需求说明.MD', new Set()) === '需求说明 副本1.MD')
check('副本：.txt 保留', nextCopyName('需求说明.txt', new Set()) === '需求说明 副本1.txt')
check(
  '副本：多段名字只在末尾加标记',
  nextCopyName('会议.v1.md', new Set()) === '会议.v1 副本1.md',
)
const family = copyFamilyOf('需求说明 副本2.md')
check(
  '副本：拆出基础名 / 格式 / 数字',
  family.base === '需求说明' && family.suffix === '.md' && family.number === 2,
)

const baseNames = ['需求说明.md', '需求说明 副本1.md', '需求说明 副本2.md']
check(
  '落点：接在同源副本组后面',
  placeCopy(baseNames, '需求说明.md', '需求说明 副本3.md').join('|') ===
    '需求说明.md|需求说明 副本1.md|需求说明 副本2.md|需求说明 副本3.md',
)
const gapNames = ['需求说明.md', '需求说明 副本1.md', '需求说明 副本3.md']
check(
  '落点：空号插在数字位置，不追加到末尾',
  placeCopy(gapNames, '需求说明.md', '需求说明 副本2.md').join('|') ===
    '需求说明.md|需求说明 副本1.md|需求说明 副本2.md|需求说明 副本3.md',
)
check(
  '落点：源是副本1 时接在副本2 后面',
  placeCopy(
    ['需求说明 副本1.md', '需求说明 副本2.md'],
    '需求说明 副本1.md',
    '需求说明 副本3.md',
  ).join('|') === '需求说明 副本1.md|需求说明 副本2.md|需求说明 副本3.md',
)
check(
  '落点：不同族直接贴源文件下方',
  placeCopy(['需求说明.md', '其他.md'], '需求说明.md', '需求说明 副本1.md').join('|') ===
    '需求说明.md|需求说明 副本1.md|其他.md',
)
check(
  '落点：源不在列表 ⇒ 追加到末尾',
  placeCopy(['其他.md'], '需求说明.md', '需求说明 副本1.md').join('|') ===
    '其他.md|需求说明 副本1.md',
)

// ── 菜单顺序 ────────────────────────────────────────────────────────────────
const noop = (): void => {}
const commandActions: WorkbenchCommandActions = {
  openCreatePrompt: noop,
  openRenamePrompt: noop,
  copyPath: noop,
  reveal: noop,
  duplicate: noop,
  openMoveDialog: noop,
  confirmDelete: noop,
  refreshAll: noop,
  openPalette: noop,
  showSource: noop,
  save: noop,
  reload: noop,
  closeDocument: noop,
  closeDocumentDiscard: noop,
  chooseVault: noop,
  revokeVault: noop,
  toggleOutline: noop,
  toggleFind: noop,
  openSample: noop,
  checkUpdate: noop,
}
const commandState = {
  busy: false,
  vaultKind: 'user' as const,
  open: null,
  dirty: false,
  sourceMode: false,
  outlineOpen: false,
  findOpen: false,
}
const menuIds = (rows: readonly MenuEntry[]): string[] =>
  rows.flatMap(row => ('type' in row ? [] : [row.id]))
const fileMenu = createWorkbenchCommands({ state: commandState, actions: commandActions })
check(
  '菜单：复制路径、文件位置、创建副本 | 重命名、移动到、删除',
  menuIds(menuRowsFor(fileMenu, false)).join('|') ===
    'copyPath|reveal|duplicate|rename|move|delete',
  menuIds(menuRowsFor(fileMenu, false)).join('|'),
)
check(
  '菜单：文件夹行没有创建副本',
  !menuIds(menuRowsFor(fileMenu, true)).includes('duplicate'),
  menuIds(menuRowsFor(fileMenu, true)).join('|'),
)
const duplicateRow = menuRowsFor(fileMenu, false).find(
  row => !('type' in row) && row.id === 'duplicate',
)
check(
  '菜单：创建副本文案',
  duplicateRow !== undefined && !('type' in duplicateRow) && duplicateRow.label === '创建副本',
)
const sampleMenu = createWorkbenchCommands({
  state: { ...commandState, vaultKind: 'sample' },
  actions: commandActions,
})
const sampleDuplicate = menuRowsFor(sampleMenu, false).find(
  row => !('type' in row) && row.id === 'duplicate',
)
check(
  '菜单：示例仓库里创建副本置灰',
  sampleDuplicate !== undefined &&
    !('type' in sampleDuplicate) &&
    sampleDuplicate.disabled === true,
)

// ── 打开的缓冲区与标签 ──────────────────────────────────────────────────────
/** @param path - absolute document path. @returns a buffer with equal text fields. */
function buffer(path: string, content = 'x'): BufferState {
  return {
    kind: 'file',
    path,
    title: path,
    bytes: content.length,
    content,
    saved: content,
    source: content,
    sample: false,
  }
}

const one = { 'C:/v/a.md': buffer('C:/v/a.md') }
check('缓冲区：路径不在 ⇒ 原对象', patchBuffers(one, 'C:/v/b.md', { content: 'y' }) === one)
check(
  '缓冲区：字段全等 ⇒ 原对象',
  patchBuffers(one, 'C:/v/a.md', { content: 'x' }) === one,
)
const patched = patchBuffers(one, 'C:/v/a.md', { content: 'y' })
check(
  '缓冲区：改了 ⇒ 新记录，原记录不动',
  patched !== one && patched['C:/v/a.md']?.content === 'y' && one['C:/v/a.md']?.content === 'x',
)
check(
  '缓冲区：withBuffer 同路径覆盖',
  withBuffer(one, buffer('C:/v/a.md', 'z'))['C:/v/a.md']?.content === 'z',
)
check(
  '缓冲区：withoutBuffers 丢掉一篇',
  Object.keys(withoutBuffers(one, ['C:/v/a.md'])).length === 0,
)
check('缓冲区：withoutBuffers 没命中 ⇒ 原对象', withoutBuffers(one, ['C:/v/b.md']) === one)

const strip = { tabs: ['a', 'b', 'c'], activePath: 'b' }
check('标签：关当前中间那一格 ⇒ 接班原来位置的那一格', closeTabs(strip, ['b']).activePath === 'c')
check('标签：关当前最后一格 ⇒ 退到前一格', closeTabs(strip, ['c']).activePath === 'b')
check('标签：关当前第一格 ⇒ 接班下一格', closeTabs(strip, ['a']).activePath === 'b')
check('标签：关的不是当前 ⇒ 当前不动', closeTabs(strip, ['a']).activePath === 'b')
check('标签：全关 ⇒ 没有当前', closeTabs(strip, ['a', 'b', 'c']).activePath === null)
check('标签：没有命中 ⇒ 原对象', closeTabs(strip, ['x']) === strip)

// ── 保存基线：它描述的是哪一份正文 ──────────────────────────────────────────
check('基线：空基线不算过期', !isStaleBase(createSourceBase(), 'anything'))
{
  const base = createSourceBase()
  base.blocks = [{ key: 'k', start: 0, end: 1, written: 'x', index: 0 }]
  base.source = 'x'
  check('基线：同一份正文 ⇒ 不过期', !isStaleBase(base, 'x'))
  check('基线：正文被换掉 ⇒ 过期', isStaleBase(base, 'y'))
}

// ── 版本比较 ────────────────────────────────────────────────────────────────
check('版本：后一位大 ⇒ 1', compareVersions('1.0.1', '1.0.0') === 1)
check('版本：前导 v 不算差异', compareVersions('v1.2.0', '1.2.0') === 0)
check('版本：正式版高于预发布', compareVersions('1.0.0', '1.0.0-rc.1') === 1)
check('版本：预发布数字按数值比', compareVersions('1.0.0-rc.10', '1.0.0-rc.9') === 1)
check('版本：认不出 ⇒ null', compareVersions('1.0', '1.0.0') === null)
check('版本：忽略 +build', compareVersions('1.0.0+build', '1.0.0') === 0)

// ── 文档目录宽度 ────────────────────────────────────────────────────────────
check(
  '目录宽度：默认就是最小（220）',
  OUTLINE_DEFAULT === OUTLINE_MIN && OUTLINE_DEFAULT === 220,
  String(OUTLINE_DEFAULT),
)
check('目录宽度：最大是默认的两倍（440）', OUTLINE_MAX === 440, String(OUTLINE_MAX))
check('目录宽度：太窄 ⇒ 抬到 220', clampStoredWidth(120) === OUTLINE_MIN)
check('目录宽度：太宽 ⇒ 压到 440', clampStoredWidth(999) === OUTLINE_MAX)
check('目录宽度：拖动上限不超过 440', clampOutline(9999, 1000) === OUTLINE_MAX)
check('目录宽度：拖动给编辑区留 360（700 − 360）', clampOutline(9999, 700) === 340)
check('目录宽度：拖动也抬到 220', clampOutline(10, 1000) === OUTLINE_MIN)
check('目录宽度：窗口再窄，拖动上限也不低于下限', outlineCeiling(300) === OUTLINE_MIN)
check('目录宽度：拖动到 260 也照写（260 不是一个特殊值）', clampStoredWidth(260) === 260)

console.log(`\n${failures === 0 ? '全部通过' : `${String(failures)} 项失败`}`)
if (failures > 0) process.exitCode = 1
