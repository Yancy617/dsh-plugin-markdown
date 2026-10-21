/**
 * 客户端 bundle 内联样式表的类型声明。
 *
 * 内容
 * - *.module.css 模块：默认导出一个只读的“本地名 → 哈希类名”记录。
 *
 * 行为
 * - 键在打包后才确定，所以用 Record<string, string>，不逐键生成。
 *
 * 边界
 * - 不负责样式内容本身。
 *
 * 相关文件
 * - 被 tsconfig 引入；服务所有 CSS Module 导入。
 *
 * 改哪里
 * - 改形状：declare module '*.module.css'。
 */
declare module '*.module.css' {
  const classes: Readonly<Record<string, string>>
  export default classes
}
