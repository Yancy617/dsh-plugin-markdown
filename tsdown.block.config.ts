/**
 * 验收仪器的构建配置（不属于插件产物）：块级保存 + 纯函数判据。
 */
import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['scripts/probe-block.ts', 'scripts/probe-units.ts', 'scripts/probe-syntax.ts'],
  outDir: '_probe',
  format: ['esm'],
  platform: 'node',
  dts: false,
  clean: false,
  sourcemap: false,
  deps: { neverBundle: [/^@lexical\//, /^lexical$/, /^react/] },
})
