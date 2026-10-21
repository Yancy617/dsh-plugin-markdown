/**
 * Host vault 路由的端到端检查。
 *
 * 内容
 * - origin / BASE / ROOT / OUTSIDE；check / call / json 与各段断言。
 *
 * 行为
 * - 驱动真实 HTTP 接口，用一次性目录做 fixture。
 * - 断言授权、列目录、读、写、版本冲突拒绝、越界路径拒绝、stat 与 read / write 的版本一致。
 * - 结束时清理 fixture。
 *
 * 边界
 * - 需要 Host 已运行；会删除并重建自己的 _vault-probe / _outside-probe。
 *
 * 相关文件
 * - src/index.ts 的 vault 路由；docs/发布与同步.md。
 *
 * 改哪里
 * - 改 fixture：ROOT / OUTSIDE。
 * - 改断言：各段 check。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const origin = process.argv[2] ?? 'http://127.0.0.1:19387'
const BASE = `${origin}/markdown-vault`
// Kept away from `_vault-test`, which is a hand-written demo vault for
// acceptance runs: this script deletes and recreates its own fixture.
const ROOT = 'D:\\01DSH\\plugins\\markdown\\_vault-probe'
const OUTSIDE = 'D:\\01DSH\\plugins\\markdown\\_outside-probe'

let failures = 0

/**
 * @param {boolean} condition - assertion result.
 * @param {string} label - what was asserted.
 * @param {unknown} [detail] - context printed on failure.
 */
function check(condition, label, detail) {
  if (condition) {
    console.log(`  ok   ${label}`)
    return
  }
  failures += 1
  console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
}

/**
 * @param {string} url - absolute URL.
 * @param {RequestInit} [init] - fetch options.
 * @returns the status and parsed body.
 */
async function call(url, init) {
  const response = await fetch(url, { cache: 'no-store', ...init })
  const text = await response.text()
  let body
  try {
    body = text === '' ? {} : JSON.parse(text)
  } catch {
    body = text
  }
  return { status: response.status, body }
}

/**
 * @param {unknown} body - request payload.
 * @param {string} method - HTTP method.
 * @returns fetch init with a JSON body.
 */
function json(method, body) {
  return {
    method,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  }
}

// Fixture: a vault directory and one file that must stay untouched.
rmSync(ROOT, { recursive: true, force: true })
rmSync(OUTSIDE, { recursive: true, force: true })
mkdirSync(join(ROOT, 'notes'), { recursive: true })
mkdirSync(OUTSIDE, { recursive: true })
writeFileSync(join(ROOT, 'hello.md'), '# 你好\n\n原始内容。\n', 'utf8')
writeFileSync(join(ROOT, 'notes', 'nested.md'), '嵌套文件\n', 'utf8')
writeFileSync(join(OUTSIDE, 'secret.md'), '不该被读到\n', 'utf8')

console.log(`origin: ${origin}`)
console.log(`vault:  ${ROOT}\n`)

console.log('1. state before authorization')
const before = await call(`${BASE}/state`, { method: 'GET' })
check(before.status === 200, 'state answers 200', before)
check(before.body.root === null || typeof before.body.root === 'string', 'root is null or a path', before.body)

console.log('\n2. authorize')
const authorized = await call(`${BASE}/authorize`, json('POST', { path: ROOT }))
check(authorized.status === 200, 'authorize answers 200', authorized)
check(authorized.body.root === ROOT, 'root echoes the chosen directory', authorized.body)

console.log('\n3. list')
const listed = await call(`${BASE}/list?path=${encodeURIComponent(ROOT)}`, { method: 'GET' })
check(listed.status === 200, 'list answers 200', listed)
const names = Array.isArray(listed.body.entries) ? listed.body.entries.map(e => `${e.type[0]}:${e.name}`) : []
check(names.includes('f:hello.md'), 'hello.md listed as a file', names)
check(names.includes('d:notes'), 'notes listed as a directory', names)

console.log('\n4. nested list')
const nested = await call(`${BASE}/list?path=${encodeURIComponent(join(ROOT, 'notes'))}`, { method: 'GET' })
check(nested.status === 200, 'nested list answers 200', nested)
check(
  Array.isArray(nested.body.entries) && nested.body.entries.some(e => e.name === 'nested.md'),
  'nested.md listed',
  nested.body,
)

// A duplicated row in the UI could come from the host repeating entries or from
// the renderer mis-keying them. Pinning the host side here keeps that question
// answered without a browser.
console.log('\n4b. a wide level lists each child exactly once')
for (let index = 0; index < 24; index += 1) {
  mkdirSync(join(ROOT, 'wide', `dir-${String(index).padStart(2, '0')}`), { recursive: true })
}
const wide = await call(`${BASE}/list?path=${encodeURIComponent(join(ROOT, 'wide'))}`, { method: 'GET' })
check(wide.status === 200, 'wide list answers 200', wide)
const wideNames = Array.isArray(wide.body.entries) ? wide.body.entries.map(e => e.name) : []
check(wideNames.length === 24, 'all 24 children returned', wideNames.length)
check(new Set(wideNames).size === wideNames.length, 'no name appears twice', wideNames)

console.log('\n5. read')
const file = join(ROOT, 'hello.md')
const read = await call(`${BASE}/read?path=${encodeURIComponent(file)}`, { method: 'GET' })
check(read.status === 200, 'read answers 200', read)
check(read.body.content === '# 你好\n\n原始内容。\n', 'content matches byte for byte', read.body.content)
check(typeof read.body.version === 'string' && read.body.version !== '', 'a version came back', read.body.version)

// The mount check asks this route once per open document, so its answer has to be the read's own
// token — a second derivation would make every return to the panel look like a disk change.
console.log('\n5b. stat (GET /stat)')
const stat = await call(`${BASE}/stat?path=${encodeURIComponent(file)}`, { method: 'GET' })
check(stat.status === 200, 'stat answers 200', stat)
check(stat.body.version === read.body.version, 'stat version equals read version', {
  stat: stat.body.version,
  read: read.body.version,
})
check(stat.body.type === 'file', 'stat says file', stat.body.type)
check(stat.body.size === readFileSync(file).length, 'stat size matches the bytes on disk', stat.body.size)
check(stat.body.content === undefined, 'stat carries no content', Object.keys(stat.body))
const statMissing = await call(`${BASE}/stat?path=${encodeURIComponent(join(ROOT, 'nope.md'))}`, {
  method: 'GET',
})
check(statMissing.status === 404, 'stat on a missing file is 404', statMissing.body)
const statFolder = await call(`${BASE}/stat?path=${encodeURIComponent(ROOT)}`, { method: 'GET' })
check(statFolder.body.type === 'directory', 'stat answers for a directory too', statFolder.body)
const statOutside = await call(
  `${BASE}/stat?path=${encodeURIComponent(join(OUTSIDE, 'secret.md'))}`,
  { method: 'GET' },
)
check(statOutside.status === 403, 'stat outside the vault is 403', statOutside.body)

console.log('\n6. write (compare-and-set with the version just read)')
const updated = '# 你好\n\n改写后的内容。\n'
const wrote = await call(
  `${BASE}/write`,
  json('PUT', { path: file, content: updated, expectedVersion: read.body.version }),
)
check(wrote.status === 200, 'write answers 200', wrote)
check(wrote.body.operation === 'update', 'operation is update', wrote.body)
check(existsSync(file) && readFileSync(file, 'utf8') === updated, 'file on disk holds the new text')
const statAfterWrite = await call(`${BASE}/stat?path=${encodeURIComponent(file)}`, { method: 'GET' })
// The token a write returns is what the next compare-and-set (and the mount check) uses; a stat
// that disagreed would make a document the writer just saved look changed on disk.
check(
  statAfterWrite.body.version === wrote.body.version,
  'stat agrees with the version the write returned',
  { stat: statAfterWrite.body.version, write: wrote.body.version },
)

console.log('\n7. stale compare-and-set must be refused')
const stale = await call(
  `${BASE}/write`,
  json('PUT', { path: file, content: '不应写入\n', expectedVersion: read.body.version }),
)
check(stale.status >= 400, 'stale write refused', stale)
check(readFileSync(file, 'utf8') === updated, 'file unchanged after the refusal')

console.log('\n8. containment: a path outside the authorized root')
const escapeRead = await call(`${BASE}/read?path=${encodeURIComponent(join(OUTSIDE, 'secret.md'))}`, {
  method: 'GET',
})
check(escapeRead.status === 403, 'read outside the vault is 403', escapeRead)
check(escapeRead.body.error === 'outside-vault', 'code is outside-vault', escapeRead.body)

const escapeWrite = await call(
  `${BASE}/write`,
  json('PUT', { path: join(OUTSIDE, 'planted.md'), content: 'x' }),
)
check(escapeWrite.status === 403, 'write outside the vault is 403', escapeWrite)
check(!existsSync(join(OUTSIDE, 'planted.md')), 'nothing was written outside')

const traversal = await call(`${BASE}/read?path=${encodeURIComponent(`${ROOT}\\..\\_outside-probe\\secret.md`)}`, {
  method: 'GET',
})
check(traversal.status === 403, 'traversal via .. is 403', traversal)

// The browser builds child paths by appending `/`, so a Windows root produces
// mixed separators. If the host refused those, the directory tree would fail on
// its first expansion — worth pinning down independently of the UI.
console.log('\n8b. forward-slash child paths (what the browser builds)')
const slashRoot = ROOT.replaceAll('\\', '/')
const slashNested = `${slashRoot}/notes`
const slashList = await call(`${BASE}/list?path=${encodeURIComponent(slashNested)}`, { method: 'GET' })
check(slashList.status === 200, 'listing a `/`-joined child path works', slashList)
check(
  Array.isArray(slashList.body.entries) && slashList.body.entries.some(e => e.name === 'nested.md'),
  'the nested file is listed',
  slashList.body,
)

const slashRead = await call(`${BASE}/read?path=${encodeURIComponent(`${slashNested}/nested.md`)}`, {
  method: 'GET',
})
check(slashRead.status === 200, 'reading a `/`-joined path works', slashRead)
check(slashRead.body.content === '嵌套文件\n', 'content matches', slashRead.body.content)

console.log('\n8c. structural operations (mkdir / rename / delete)')
const madeDir = await call(`${BASE}/mkdir`, json('POST', { path: ROOT, name: 'created' }))
check(madeDir.status === 200, 'mkdir answers 200', madeDir)
check(existsSync(join(ROOT, 'created')), 'the directory exists on disk')

const dupDir = await call(`${BASE}/mkdir`, json('POST', { path: ROOT, name: 'created' }))
check(dupDir.status === 409, 'creating it again is refused', dupDir)

const badName = await call(`${BASE}/mkdir`, json('POST', { path: ROOT, name: '../escape' }))
check(badName.status === 400, 'a name containing a separator is refused', badName)

const renamed = await call(
  `${BASE}/rename`,
  json('POST', { path: join(ROOT, 'hello.md'), name: 'renamed.md' }),
)
check(renamed.status === 200, 'rename answers 200', renamed)
check(!existsSync(join(ROOT, 'hello.md')) && existsSync(join(ROOT, 'renamed.md')), 'the file moved')

const renameOnto = await call(
  `${BASE}/rename`,
  json('POST', { path: join(ROOT, 'renamed.md'), name: 'notes' }),
)
check(renameOnto.status === 409, 'renaming onto an existing entry is refused', renameOnto)

const refuseDir = await call(`${BASE}/delete`, json('POST', { path: join(ROOT, 'created') }))
check(refuseDir.status === 400, 'deleting a directory without recursive is refused', refuseDir)

const deleteDir = await call(
  `${BASE}/delete`,
  json('POST', { path: join(ROOT, 'created'), recursive: true }),
)
check(deleteDir.status === 200, 'recursive delete answers 200', deleteDir)
check(!existsSync(join(ROOT, 'created')), 'the directory was removed')

const deleteFile = await call(`${BASE}/delete`, json('POST', { path: join(ROOT, 'renamed.md') }))
check(deleteFile.status === 200, 'deleting a file answers 200', deleteFile)
check(!existsSync(join(ROOT, 'renamed.md')), 'the file was removed')

// The containment check must guard every new verb too, not just read and write.
const escapeDelete = await call(`${BASE}/delete`, json('POST', { path: join(OUTSIDE, 'secret.md') }))
check(escapeDelete.status === 403, 'deleting outside the vault is 403', escapeDelete)
check(existsSync(join(OUTSIDE, 'secret.md')), 'the outside file survived')

const rootDelete = await call(`${BASE}/delete`, json('POST', { path: ROOT, recursive: true }))
check(rootDelete.status === 400, 'deleting the vault root is refused', rootDelete)
check(existsSync(ROOT), 'the vault root survived')

console.log('\n8d. binary asset (POST /asset)')
// The smallest possible PNG signature, not a decodable picture: this route moves bytes and never looks
// inside them, and a fixture that is obviously not an image says so.
const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
const assetFile = join(ROOT, '.img', 'probe-asset.png')
const asset = await call(`${BASE}/asset`, json('POST', { path: assetFile, base64: png.toString('base64') }))
check(asset.status === 200, 'asset answers 200', asset)
check(existsSync(join(ROOT, '.img')), 'the parent directory was created', asset.body)
check(existsSync(assetFile), 'the file exists on disk')
check(existsSync(assetFile) && readFileSync(assetFile).equals(png), 'the bytes on disk are the bytes sent')

// The name is content-addressed and timestamped, so a collision means two different pictures would share
// one name. It has to cost a retry, not a picture.
const assetAgain = await call(
  `${BASE}/asset`,
  json('POST', { path: assetFile, base64: Buffer.from('different').toString('base64') }),
)
check(assetAgain.status === 409, 'writing the same path again is refused', assetAgain)
check(readFileSync(assetFile).equals(png), 'the first file survived the refusal')

const notBase64 = await call(
  `${BASE}/asset`,
  json('POST', { path: join(ROOT, '.img', 'bad.png'), base64: 'not base64!!' }),
)
check(notBase64.status === 400, 'a body that is not base64 is refused', notBase64)
check(!existsSync(join(ROOT, '.img', 'bad.png')), 'nothing was written for it')

const escapeAsset = await call(
  `${BASE}/asset`,
  json('POST', { path: join(OUTSIDE, 'planted.png'), base64: png.toString('base64') }),
)
check(escapeAsset.status === 403, 'writing an asset outside the vault is 403', escapeAsset)
check(!existsSync(join(OUTSIDE, 'planted.png')), 'nothing was written outside')

// The client leaves `.img` out of the tree; the route must still report what is on disk. Hiding it in the
// listing would make "the tree is what exists" false, and a writer who put a folder there by hand would
// have no way to see it.
const withImages = await call(`${BASE}/list?path=${encodeURIComponent(ROOT)}`, { method: 'GET' })
check(
  Array.isArray(withImages.body.entries) && withImages.body.entries.some(e => e.name === '.img'),
  'the route still lists .img',
  withImages.body,
)

console.log('\n8e. move (POST /move)')
// A move is a rename with the basename kept: the caller names the **directory** that receives the
// entry, never the path it should end up at. Two of these assertions exist because getting that
// wrong was a real bug — the client once passed the entry's future path, and every cross-directory
// move failed with a "destination" that was really `<target>/<the entry's own name>`.
mkdirSync(join(ROOT, 'inbox'), { recursive: true })
writeFileSync(join(ROOT, 'inbox', 'carried.md'), '跟着文件夹走\n', 'utf8')
writeFileSync(join(ROOT, 'notes', 'taken.md'), '目标层已经有这个名字\n', 'utf8')
writeFileSync(join(ROOT, 'taken.md'), '要移过去的那个\n', 'utf8')

const moved = await call(
  `${BASE}/move`,
  json('POST', { path: join(ROOT, 'taken.md'), directory: join(ROOT, 'inbox') }),
)
check(moved.status === 200, 'move answers 200', moved)
check(moved.body.path === join(ROOT, 'inbox', 'taken.md'), 'and reports where it landed', moved.body)
check(
  existsSync(join(ROOT, 'inbox', 'taken.md')) && !existsSync(join(ROOT, 'taken.md')),
  'the file is in its new place and gone from the old one',
)
const movedRead = await call(
  `${BASE}/read?path=${encodeURIComponent(join(ROOT, 'inbox', 'taken.md'))}`,
  { method: 'GET' },
)
check(
  movedRead.status === 200 && movedRead.body.content === '要移过去的那个\n',
  'and its bytes came along',
  movedRead.body,
)

const movedFolder = await call(
  `${BASE}/move`,
  json('POST', { path: join(ROOT, 'inbox'), directory: join(ROOT, 'notes') }),
)
check(
  movedFolder.status === 200 && existsSync(join(ROOT, 'notes', 'inbox', 'carried.md')),
  'a moved folder brings what is inside it',
  movedFolder.body,
)
check(!existsSync(join(ROOT, 'inbox')), 'and the folder is gone from where it was')

const intoItself = await call(
  `${BASE}/move`,
  json('POST', { path: join(ROOT, 'notes'), directory: join(ROOT, 'notes') }),
)
check(
  intoItself.status === 400 && /不能移动到它自己或它的子目录里/.test(intoItself.body.message),
  'a folder cannot move into itself',
  intoItself.body,
)

const intoOwnSubtree = await call(
  `${BASE}/move`,
  json('POST', { path: join(ROOT, 'notes'), directory: join(ROOT, 'notes', 'inbox') }),
)
check(
  intoOwnSubtree.status === 400 && /不能移动到它自己或它的子目录里/.test(intoOwnSubtree.body.message),
  'nor into its own subtree',
  intoOwnSubtree.body,
)

const alreadyThere = await call(
  `${BASE}/move`,
  json('POST', { path: join(ROOT, 'notes', 'taken.md'), directory: join(ROOT, 'notes') }),
)
check(
  alreadyThere.status === 400 && /已经在目标目录里/.test(alreadyThere.body.message),
  'moving into the directory it already sits in is refused as the no-op it is',
  alreadyThere.body,
)

const nameTaken = await call(
  `${BASE}/move`,
  json('POST', { path: join(ROOT, 'notes', 'taken.md'), directory: join(ROOT, 'notes', 'inbox') }),
)
check(
  nameTaken.status === 409 && /目标已存在/.test(nameTaken.body.message),
  'a name already taken in the destination is refused',
  nameTaken.body,
)
check(existsSync(join(ROOT, 'notes', 'taken.md')), 'and what was there did not move')

const rootMove = await call(
  `${BASE}/move`,
  json('POST', { path: ROOT, directory: join(ROOT, 'notes') }),
)
check(
  rootMove.status === 400 && /不能移动 vault 根目录/.test(rootMove.body.message),
  'the vault root cannot be moved',
  rootMove.body,
)

const ontoFile = await call(
  `${BASE}/move`,
  json('POST', {
    path: join(ROOT, 'notes', 'taken.md'),
    directory: join(ROOT, 'notes', 'inbox', 'taken.md'),
  }),
)
check(
  ontoFile.status === 400 && /不是目录/.test(ontoFile.body.message),
  'a destination that is a file is refused',
  ontoFile.body,
)

const outsideMove = await call(
  `${BASE}/move`,
  json('POST', { path: join(ROOT, 'notes', 'taken.md'), directory: OUTSIDE }),
)
check(outsideMove.status === 403, 'a destination outside the vault is 403', outsideMove.body)
check(existsSync(join(ROOT, 'notes', 'taken.md')), 'and the file is still where it was')

// A destination that is not there says **what the directory above actually showed** — the two
// failures behind that sentence are different (a stale listing the writer is looking at, versus a
// directory that exists and cannot be read), and telling them apart cost three rounds of
// diagnosis once. Asserted, so the distinction cannot quietly go away.
const missingTarget = await call(
  `${BASE}/move`,
  json('POST', { path: join(ROOT, 'notes', 'taken.md'), directory: join(ROOT, 'nowhere') }),
)
check(
  missingTarget.status === 404 && /目标目录不存在：/.test(missingTarget.body.message),
  'a destination that is not there is 404',
  missingTarget.body,
)
check(
  /（上一层里没有这个名字）/.test(missingTarget.body.message),
  'and says what the level above it held',
  missingTarget.body,
)

console.log('\n8e2. copy (POST /copy)')
// A copy is a byte copy: the fixture carries a BOM and CRLF so a text round-trip would be visible
// as a changed byte, which is exactly what this route must not do.
const copySource = join(ROOT, 'copy-source.md')
const copyBytes = Buffer.from('\uFEFF# 副本\r\n\r\n第一行\r\n第二行\r\n', 'utf8')
writeFileSync(copySource, copyBytes)
const copied = await call(
  `${BASE}/copy`,
  json('POST', { path: copySource, name: 'copy-source 副本1.md' }),
)
check(copied.status === 200, 'copy answers 200', copied)
check(
  copied.body.path === join(ROOT, 'copy-source 副本1.md'),
  'and reports the new path',
  copied.body,
)
const copiedPath = join(ROOT, 'copy-source 副本1.md')
check(existsSync(copiedPath), 'the copy exists on disk')
check(
  existsSync(copiedPath) && readFileSync(copiedPath).equals(copyBytes),
  'the copy is byte-for-byte the source (BOM and CRLF included)',
)
check(
  readFileSync(copySource).equals(copyBytes),
  'and the source was not modified',
)
const copiedAgain = await call(
  `${BASE}/copy`,
  json('POST', { path: copySource, name: 'copy-source 副本1.md' }),
)
check(
  copiedAgain.status === 409 && /目标已存在/.test(copiedAgain.body.message),
  'copying onto an existing name is refused',
  copiedAgain.body,
)
check(
  readFileSync(copiedPath).equals(copyBytes),
  'and the existing copy survived the refusal',
)
const copyMissing = await call(
  `${BASE}/copy`,
  json('POST', { path: join(ROOT, 'nowhere.md'), name: 'x.md' }),
)
check(copyMissing.status === 404, 'copying a missing source is 404', copyMissing.body)
const copyFolder = await call(
  `${BASE}/copy`,
  json('POST', { path: join(ROOT, 'notes'), name: 'notes 副本1' }),
)
check(copyFolder.status === 400, 'copying a directory is refused', copyFolder.body)
const copyOutside = await call(
  `${BASE}/copy`,
  json('POST', { path: join(OUTSIDE, 'secret.md'), name: 'secret 副本1.md' }),
)
check(copyOutside.status === 403, 'copying from outside the vault is 403', copyOutside.body)
const copyBadName = await call(
  `${BASE}/copy`,
  json('POST', { path: copySource, name: 'bad/name.md' }),
)
check(copyBadName.status === 400, 'a copy name with a separator is refused', copyBadName.body)
check(!existsSync(join(ROOT, 'bad', 'name.md')), 'and nothing was written for it')

console.log('\n8f. directory list for the move picker (GET /directories)')
mkdirSync(join(ROOT, '.config'), { recursive: true })
const directories = await call(`${BASE}/directories`, { method: 'GET' })
// Guarded once, so a route that is not there reports as failed checks rather than a stack trace.
const dirList = Array.isArray(directories.body.directories) ? directories.body.directories : []
check(
  directories.status === 200 && directories.body.root === ROOT,
  'directories answers with the authorized root',
  directories.body,
)
check(
  dirList.some(entry => entry.relative === ''),
  'and starts at the root itself',
  directories.body,
)
check(
  dirList.some(entry => entry.relative === 'notes/inbox'),
  'and walks down to a nested directory',
  dirList,
)
check(directories.body.truncated === false, 'with nothing left out at this size')
// `.img` and `.config` are the plugin's own material: offering them as move targets would offer a
// place a note disappears into, since the tree never draws them.
check(
  !dirList.some(entry => /(^|\/)\./.test(entry.relative)),
  'and leaves dot-directories out',
  dirList,
)

console.log('\n8g. hiding the plugin’s own folders (POST /hide)')
const hid = await call(`${BASE}/hide`, json('POST', { path: join(ROOT, '.img') }))
check(hid.status === 200, 'hide answers 200', hid)
// The whole reason this cannot affect the panel: **nothing in the plugin reads the attribute.** The
// tree keeps those two names out of the root listing by comparing names.
const afterHide = await call(`${BASE}/list?path=${encodeURIComponent(ROOT)}`, { method: 'GET' })
check(
  Array.isArray(afterHide.body.entries) && afterHide.body.entries.some(entry => entry.name === '.img'),
  'a hidden folder is still listed — nothing in the plugin reads the attribute',
  afterHide.body,
)
if (process.platform === 'win32') {
  const flagLine = (run) => (spawnSync(run[0], run.slice(1), { encoding: 'utf8' }).stdout ?? '').trim().split('\n')[0] ?? ''
  check(
    /^[A-Z ]*H/.test(flagLine(['attrib', join(ROOT, '.img')])),
    'the Hidden flag is really set on disk',
    flagLine(['attrib', join(ROOT, '.img')]),
  )
  spawnSync('attrib', ['-h', join(ROOT, '.img')])
  check(
    !/^[A-Z ]*H/.test(flagLine(['attrib', join(ROOT, '.img')])),
    'and it can be taken off again — the fixture is left as it was found',
    flagLine(['attrib', join(ROOT, '.img')]),
  )
}
const nothingToHide = await call(`${BASE}/hide`, json('POST', { path: join(ROOT, 'not-there') }))
check(
  nothingToHide.status === 200,
  'a path that is not there is not an error — both folders appear lazily',
  nothingToHide,
)
const outsideHide = await call(`${BASE}/hide`, json('POST', { path: join(OUTSIDE, 'secret.md') }))
check(outsideHide.status === 403, 'and a path outside the vault is still 403', outsideHide.body)

console.log('\n9. revoke')
const revoked = await call(`${BASE}/authorize/revoke`, { method: 'POST' })
check(revoked.status === 200, 'revoke answers 200', revoked)
check(revoked.body.root === null, 'root cleared', revoked.body)
const afterRevoke = await call(`${BASE}/read?path=${encodeURIComponent(file)}`, { method: 'GET' })
check(afterRevoke.status === 409, 'read after revoke is 409', afterRevoke)
check(afterRevoke.body.error === 'no-vault', 'code is no-vault', afterRevoke.body)

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
