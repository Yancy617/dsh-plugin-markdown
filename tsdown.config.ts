/**
 * dsh-plugin-markdown 的构建配置。
 *
 * 内容
 * - ID / PLATFORM_MODULES / NODE_ENV。
 * - hostHalf（lib/index.js，ESM，node）。
 * - clientHalf（lib/client.js，CJS 闭包工厂，browser）。
 * - cssModulesInline 插件。
 *
 * 行为
 * - Host：src/index.ts → lib/index.js；electron 保持外部。
 * - Client：src/client/index.tsx → lib/client.js；平台模块外部，其余内联；压缩；sourcemap。
 * - 客户端 banner/footer 注册到 window.__ModuleLoader__。
 * - CSS Module 在 bundle 内安装 <style data-plugin-css>。
 *
 * 边界
 * - 不负责探针 / 审计构建（tsdown.*.config.ts）。
 *
 * 相关文件
 * - css-modules.ts、src/index.ts、src/client/index.tsx。
 *
 * 改哪里
 * - 改产物：hostHalf / clientHalf。
 * - 改平台外部表：PLATFORM_MODULES。
 */
import { defineConfig, type UserConfig } from 'tsdown'
// The extension is required: tsdown loads this file with a native ESM import, and
// Node resolves an extensionless relative specifier to nothing.
import { cssModulesInline } from './css-modules.ts'

/** Package name; stamped into the module-table handoff and used as the plugin id. */
const ID = '@yancy617/dsh-plugin-markdown'

/**
 * The shell's frozen module table. Mirrors `PLATFORM_MODULES` in
 * `packages/client/web/src/platform.ts` of the harness checkout.
 *
 * Requesting anything outside this list through `dsh.client.external` only
 * works for other DSH client plugin packages — a plain npm package such as
 * `lexical` cannot be requested and must be inlined.
 */
const PLATFORM_MODULES = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
] as const

const isPlatformModule = (specifier: string): boolean =>
  (PLATFORM_MODULES as readonly string[]).includes(specifier)

const NODE_ENV = process.env.NODE_ENV ?? 'production'

/** Host half: the Node-side plugin entry the Loader imports. */
const hostHalf: UserConfig = {
  name: ID,
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  sourcemap: false,
  // `electron` is provided by the desktop main process at run time and is not an
  // installable package, so it must be left as an import. It is reached through
  // a guarded dynamic import in the source, which degrades to a clear message
  // when the same Host half runs under the plain CLI instead.
  deps: { neverBundle: [/^electron$/] },
}

/** Client half: the browser bundle the shell loads as a module-table row. */
const clientHalf: UserConfig = {
  name: `${ID}/client`,
  entry: { client: 'src/client/index.tsx' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  sourcemap: true,
  // Shipped minified: this bundle is served to the page, so the size that crosses the wire is
  // the one that matters (the official packages are loaded once from the app's own bundle).
  // `sourcemap: true` above keeps every frame readable in DevTools.
  minify: true,
  deps: {
    neverBundle: isPlatformModule,
    alwaysBundle: (specifier: string) => !isPlatformModule(specifier),
    // Lexical and friends are intentionally inlined; silence tsdown's advisory
    // hint about bundling declared dependencies.
    onlyBundle: false,
  },
  inputOptions: {
    resolve: {
      // Dual-mode libraries pick their flavor through export conditions; a CJS
      // bundle cannot carry the top-level await the `node` condition implies.
      conditionNames: [NODE_ENV === 'development' ? 'development' : 'production', 'browser', 'import', 'module', 'default'],
    },
  },
  // `*.module.css` compiles into the bundle as a hashed class map plus a
  // plugin-owned `<style data-plugin-css>` installation — the same artifact
  // contract the platform's own client preset produces, so a stylesheet travels
  // inside the closure factory rather than as a file the shell has to serve.
  plugins: [cssModulesInline(ID)],
  define: {
    'process.env.NODE_ENV': JSON.stringify(NODE_ENV),
    'import.meta.env.MODE': JSON.stringify(NODE_ENV),
    'import.meta.env': JSON.stringify({ MODE: NODE_ENV }),
    // Stamped into the client bundle so a running page can state which build it
    // loaded. Without this there is no way to tell a stale bundle from a bug,
    // and both look identical from the outside.
    __BUILD_STAMP__: JSON.stringify(new Date().toISOString()),
  },
  outputOptions: {
    entryFileNames: 'client.js',
    chunkFileNames: 'client.[name].js',
    sourcemapExcludeSources: false,
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}

export default defineConfig([hostHalf, clientHalf])
