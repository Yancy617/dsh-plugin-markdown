/**
 * 按平台自带的 client preset 方式编译 *.module.css。
 *
 * 内容
 * - VIRTUAL_PREFIX / VIRTUAL_SUFFIX。
 * - hashOf / scopeCss / minifyCss / cssModulesInline。
 *
 * 行为
 * - 虚拟模块 id 不以 .css 结尾；CSS 内联进 bundle 并安装 <style data-plugin-css>。
 * - 只改选择器位置的类名；一串复合选择器整体改写。
 * - 注释先剥掉再扫，避免把注释里的类名算进导出表。
 * - 哈希前缀保证以字母或下划线开头；非法类名在构建期抛错。
 * - minifyCss 只去注释与多余空白。
 *
 * 边界
 * - 不用 lightningcss；不做其 transform / minifier。
 *
 * 相关文件
 * - tsdown.config.ts；src/client 下的 *.module.css。
 *
 * 改哪里
 * - 改写名：scopeCss。
 * - 改注入模块：cssModulesInline。
 */
import { readFileSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'

const VIRTUAL_PREFIX = '\0dsh-css:'
const VIRTUAL_SUFFIX = '.mjs'

/**
 * A short, stable hash of one stylesheet.
 * @param source - the stylesheet's text.
 * @returns six base-36 characters.
 */
function hashOf(source: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(36).padStart(6, '0').slice(0, 6)
}

/**
 * Scope every class selector in one stylesheet.
 *
 * Only selector-position classes are rewritten: a dot is a class when the character
 * before it is neither a word character nor another dot, and the name after it starts
 * with a letter. That is what keeps `.5px` in a `border` value and the dot inside a
 * `var()` out of it. There is no `:global` escape here because nothing needs one — a
 * global rule belongs in a plain `.css` sheet, not in a module.
 *
 * **A run of classes is one compound selector**, so the match is a run and not a single
 * class: `.rowWrap.rowDropInto` names two classes, and matching only the first left the
 * second spelled as written — a rule for a name no element can carry, which is invisible
 * in the browser (the rule simply never matches) and surfaces only as a build whose sheet
 * and map disagree. `.a.b:hover`, `.a.b[data-x='y']` and `.a.b.c` are all one run here;
 * the run ends at the first character that cannot continue an identifier.
 *
 * What that rule still cannot see: a dot inside a **quoted string or a URL in a
 * declaration value** — `content: ".a"` would be scoped. Nothing in this project's sheets
 * has one, and the agreement check in `scripts/verify-features.mjs` is what would report
 * it: the invented name would appear as an exported class with no rule of its own.
 *
 * The prefix is forced to start with a letter or an underscore. A base-36 hash can
 * begin with a digit, and `.1bazce_x` is not a selector — a browser drops the
 * whole rule, so the failure is not a wrong colour but an entirely unstyled panel.
 * lightningcss reaches the same guard from the other side: its own hashes surface
 * as `_0Fr0Ha_row` when they would otherwise start with a digit.
 * @param css - stylesheet text.
 * @param hash - the file's hash.
 * @returns the scoped CSS and its local-to-hashed map.
 */
function scopeCss(css: string, hash: string): { code: string; map: Record<string, string> } {
  // Comments go first, and this is not tidiness.
  //
  // A stylesheet's comments are where the rule it quotes is recorded — the shell's
  // conversation-list fill, the segmented tab's indicator — and those quotations name
  // real classes. Scoping before stripping them rewrites the class names *inside the
  // prose* too, and adds them to the exported map: entries no element can carry, for
  // names that were only ever references. The map is what the agreement check compares
  // against the sheet, so the symptom was a build reporting classes with no rules.
  const body = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const prefix = /^[0-9]/.test(hash) ? `_${hash}` : hash
  const map: Record<string, string> = {}
  const code = body.replace(
    /(^|[^\w.-])((?:\.[A-Za-z_][\w-]*)+)/g,
    (_whole, lead: string, run: string) =>
      lead +
      run.replace(/\.([A-Za-z_][\w-]*)/g, (_dot, local: string) => {
        map[local] = `${prefix}_${local}`
        return `.${prefix}_${local}`
      }),
  )
  for (const name of Object.values(map)) {
    // The guard that matters: a name this produces has to be a legal class
    // selector, and the only way to be sure is to say so at build time. Nothing
    // downstream catches it — the bundle is valid JavaScript either way.
    if (!/^[A-Za-z_][\w-]*$/.test(name)) {
      throw new Error(`css modules: produced an illegal class name "${name}"`)
    }
  }
  return { code, map }
}

/**
 * Collapse a stylesheet to the form that crosses the wire.
 *
 * Conservative on purpose: comments and insignificant whitespace go, and nothing
 * else does. A shared-quoted value would still be safe because only runs of
 * whitespace and the spacing around punctuation are touched.
 * @param css - stylesheet text.
 * @returns the minified text.
 */
function minifyCss(css: string): string {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*([{};,])\s*/g, '$1')
    .replace(/:\s+/g, ':')
    .trim()
}

/**
 * Build the module a stylesheet compiles to.
 *
 * Byte-for-byte the shape the official preset emits, including the tag identity:
 * `<plugin id>/<basename>` keeps two sheets of the same name in different packages
 * apart, and the `querySelector` guard is what makes a hot reload replace the sheet
 * instead of stacking a second copy of it.
 * @param id - plugin id, stamped onto the injected style tag.
 * @param file - absolute stylesheet path, used for the tag identity.
 * @param css - already-scoped, minified CSS.
 * @param map - local-to-hashed class map.
 * @returns the JavaScript module source.
 */
function injectionModule(
  id: string,
  file: string,
  css: string,
  map: Record<string, string>,
): string {
  const tagId = `${id}/${basename(file)}`
  return [
    `const css = ${JSON.stringify(css)};`,
    `const tagId = ${JSON.stringify(tagId)};`,
    "if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {",
    "  const tag = document.createElement('style');",
    `  tag.dataset.plugin = ${JSON.stringify(id)};`,
    '  tag.dataset.pluginCss = tagId;',
    '  tag.textContent = css;',
    '  document.head.appendChild(tag);',
    '}',
    `export default ${JSON.stringify(map)};`,
  ].join('\n')
}

/** The slice of the rolldown plugin context this plugin uses. */
interface CssPluginContext {
  addWatchFile(file: string): void
}

/**
 * Build the tsdown plugin that inlines CSS modules.
 * @param id - plugin id, stamped onto the injected style tags.
 * @returns the plugin to append to a client config's `plugins`.
 */
export function cssModulesInline(id: string) {
  return {
    name: 'dsh-css-modules-inline',
    resolveId: {
      // `pre` so tsdown's own stylesheet guard never sees the id; that guard
      // matches a `.css` suffix and would claim the file for a pipeline that
      // emits assets, which a closure-factory bundle cannot carry.
      order: 'pre' as const,
      handler(source: string, importer: string | undefined) {
        if (!source.endsWith('.module.css')) return null
        const file = importer === undefined ? source : resolve(dirname(importer), source)
        return VIRTUAL_PREFIX + file + VIRTUAL_SUFFIX
      },
    },
    load(this: CssPluginContext, virtualId: string) {
      if (!virtualId.startsWith(VIRTUAL_PREFIX)) return null
      const file = virtualId.slice(VIRTUAL_PREFIX.length, -VIRTUAL_SUFFIX.length)
      // The virtual id hides the physical sheet from the watcher otherwise, and a
      // dev build would then not rebuild when the CSS changed.
      this.addWatchFile(file)
      const source = readFileSync(file, 'utf8')
      const { code, map } = scopeCss(source, hashOf(`${file}:${source}`))
      return {
        code: injectionModule(id, file, minifyCss(code), map),
        // Installing the sheet is the module's whole purpose; a tree-shaker that
        // dropped it would drop the styles with it.
        moduleSideEffects: true,
      }
    },
  }
}
