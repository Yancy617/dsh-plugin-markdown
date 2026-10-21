# dsh-plugin-markdown

> DeepSeek Harness 的 Markdown 编辑器插件：指定一个目录，用所见即所得的富文本编辑里面的 `.md`，随时切到源码视图核对磁盘原文。

[![npm](https://img.shields.io/npm/v/@yancy617/dsh-plugin-markdown)](https://www.npmjs.com/package/@yancy617/dsh-plugin-markdown)
[![license](https://img.shields.io/npm/l/@yancy617/dsh-plugin-markdown)](https://github.com/Yancy617/dsh-plugin-markdown/blob/main/LICENSE)

本文讲安装、架构、开发与发布。功能与写法见插件自带的《关于》《功能介绍》；设计取舍见 [`public-docs/`](https://github.com/Yancy617/dsh-plugin-markdown/tree/main/public-docs)。

---

## 它是什么

- **一个 DSH 插件**，不是独立应用：它在 DSH 里注册一个工作台面板，以及一个宿主侧的 HTTP 服务。
- **编辑的是磁盘上的 `.md`**：你选一个目录，插件读它、写它；文件始终是标准 Markdown（CommonMark 0.31.2 ＋ GFM），别的软件打开一样。
- **不做平台级文件操作**：只碰你授权的那一个目录，每次操作前做包含性校验。

## 要求

| 项 | 要求 |
|---|---|
| DSH | `0.2.x` 系列（确切范围以 `package.json` 的 `dsh.compatibility.dsh` 为准） |
| Profile | `desktop`（桌面应用）或 `web`（浏览器） |
| 平台 | Windows / macOS / Linux |
| 开发 | Node、pnpm；版本与路径见[开发环境](https://github.com/Yancy617/dsh-plugin-markdown/blob/main/public-docs/开发环境.md) |

## 安装

```sh
dsh plugin --profile desktop add @yancy617/dsh-plugin-markdown
```

装完**完全退出并重新打开 DSH**（不是刷新页面），然后点左侧栏的 Markdown 图标。

- 固定版本：命令尾部加 `@<version>`。
- Web profile：把 `--profile desktop` 换成 `--profile web`。
- **开发态**：profile 的 `dependencies` 用 `link:` 指向本仓库，`node_modules` 里会是一个 junction；步骤见[开发环境 §4](https://github.com/Yancy617/dsh-plugin-markdown/blob/main/public-docs/开发环境.md)。

## 快速上手

1. 左侧「选择笔记目录」，选一个放 `.md` 的目录。
2. 点文件打开：富文本里直接改；工具条「更多 → 源码模式」看磁盘原文（只读）。
3. 不用按保存：停手 **2 秒**写一次，连续编辑最多 **20 秒**写一次；切文档 / 关标签 / 切面板 / 窗口失焦立刻写。
4. 没授权目录时，面板里是插件自带的两份只读示例——内存里的模板，磁盘上没有。

## ⚠️ 它会动你的文件

- **范围**：只在你授权的那个目录内。任何路径在动到磁盘之前先做包含性校验，`../` 之类越权一律 403。
- **文本写**走 `ctx.fs`，带版本比较；版本冲突交给使用者二选一，不自动覆盖。
- **结构操作**（图片落盘、建目录、改名、移动、复制、删除）走 `node:fs`，因此**不经过 DSH 的沙箱审批**。
- 「文件位置」会调用系统文件管理器。
- 授权目录的路径记在浏览器 `localStorage` 的一个键里（`dsh-plugin-markdown.vault`），这是唯一的持久化；「撤销授权」随时可清。
- **不主动联网**。唯一的出站请求是命令面板里的「检查更新」：一次只读 `GET`，不下载、不上传。笔记里的远程图片由浏览器按标准去取。

## 架构

由两部分组成，分别构建：

| 部分 | 源码 | 产物 | 运行位置 |
|---|---|---|---|
| **Host** | `src/index.ts`、`src/host/**` | `lib/index.js`（ESM） | DSH 宿主进程，Cordis 插件 |
| **Client** | `src/client/**` | `lib/client.js`（CJS） | 浏览器里的面板：React ＋ Lexical（版本见 `package.json`） |

- **通信走自建路由**：客户端是静态插件，拿不到 `host.call`，所以在 DSH 的 web server 上挂自己的路由。接口只有一份定义：`src/shared/protocol.ts`（`/markdown-vault/*` 共 20 条，另加一条 `update-check`）。
- **客户端注册**：`package.json` 的 `dsh.client`（`platform: web`）＋ `cordis.patch.yml` 的 bundle patch。
- **依赖边界**：运行时只有 Lexical 一家第三方；DSH 官方客户端原语（`dsh-client-ui-primitives`）是 **peer 依赖**，由平台提供，不打进包里。

## 读写与保真

```
读：文件 ──splitFrontmatter──▶ 正文 ──parseBody（mdast）──▶ mdastLower ──▶ Lexical
写：Lexical ──mdastLift──▶ mdast ──blockSave──▶ 文件
```

三条不变量（背景与依据见[方案-保真](https://github.com/Yancy617/dsh-plugin-markdown/blob/main/public-docs/方案-保真.md)）：

1. **零编辑保存逐字节相等**：打开不改就保存，文件一个字节都不变。
2. **块级切片**：只有被编辑过的顶层块（和新加的块）按标准重写，其余块从原文按字节搬。
3. **新内容必须是标准**：CommonMark 0.31.2 ＋ GFM，无私有哨兵；标准写交给 `mdast-util-to-markdown`。

边界是“块”而不是“字符”：改列表里的一项 → 整个列表块重写；改表格一格 → 整张表重写。实现落点：`mdastLower.ts`（读）、`mdastLift.ts`（写）、`blockSave.ts`（保存规则）。

## 仓库结构

```
src/index.ts           Host 入口：挂路由、校验请求、失败映射
src/host/              目录文件操作、模板（示例文档）、搜索
src/client/editor/     语法层（mdast ↔ Lexical）、节点、块级保存、编辑区
src/client/workbench/  面板：文件树、标签、工具条、文档目录、提示
src/shared/            两端共用的接口定义（protocol）与纯规则
scripts/               验收脚本：probe-block / probe-units / probe-vault / verify-map / env-check
_vault-test/           随包示例（只读、内存里；含一张示例图）
public-docs/           公开文档（由 docs/ 生成；GitHub 上能看到的只有这几份）
```

## 开发

工具链与机器环境以[开发环境](https://github.com/Yancy617/dsh-plugin-markdown/blob/main/public-docs/开发环境.md)为准；动手前先跑 `pnpm env:check` 核对，结果不一致就先查清楚再改。

| 命令 | 做什么 |
|---|---|
| `pnpm install` | 装依赖 |
| `pnpm build` | 构建两部分到 `lib/` |
| `pnpm watch` | 监听重建（客户端改动仍要重启 DSH 才生效） |
| `pnpm typecheck` | 三份 `tsc --noEmit`：客户端 / Host / scripts |
| `pnpm test` | 构建 ＋ 跑两套脚本（`probe-block`、`probe-units`） |
| `pnpm verify:map` | `docs/文件职责.md` 与仓库文件是否对齐 |
| `pnpm env:check` | 只读自检：工具链、DSH 安装、profile |

**改完怎么验**：改代码 → `pnpm build` → **完全退出 DSH 再打开** → 在界面里验收。DSH 不热重载插件，所以不能靠刷新页面；Host 侧的路由与 compatibility 也只在启动时读一次。

## 测试

- **`probe-block`**：真编辑器（headless Lexical）跑整条读写链路——零编辑逐字节、改一个字只那段变、末尾插块、表格改一格、复制 / 粘贴往返、保存语义矩阵。测试文档是 `scripts/fixtures/综合样张.md`，专供测试、**不随包发布**；改示例文档不影响它。
- **`probe-units`**：纯函数用例（保存判定、版本冲突、命名合法性、副本命名、路径、快捷键解析……）。
- **`probe-vault`**：真 HTTP 面（需要 DSH 在跑；它会改授权根，别在正用的实例上跑）。
- 另有两项只读检查：随包示例能否打开（在 `pnpm test` 里）、文档覆盖是否齐全（`pnpm verify:map`）。

合入要求是 `pnpm typecheck && pnpm test` 全绿；界面行为需要人工验收。

## 扩展点

- **加一种语法**：`mdastParse.ts` 的语法集（如需要）＋ `mdastLower.ts` 一个分支 ＋ `mdastLift.ts` 一个分支。标准写法统一交给 `mdast-util-to-markdown`，不要为某一种语法另写正则或序列化代码。
- **加一个块操作**：`editor/operations.ts` 的 `BLOCK_OPERATIONS`——浮栏、斜杠菜单、命令面板都从这张表读。
- **加一个工作台命令**：`workbench/commands.ts`；快捷键在 `client/shortcuts.ts` 声明。
- **加一条路由**：`shared/protocol.ts` 加键 → `src/index.ts` 挂载 → 客户端 `vaultClient.ts` 调用。
- **改样式**：优先用平台 token；面板样式在 `sidebar.module.css`，编辑器注入样式在 `editor/config.ts`。

## 已知限制

> 逐条证据见[语法覆盖-对照表](https://github.com/Yancy617/dsh-plugin-markdown/blob/main/public-docs/语法覆盖-对照表.md)；更细的需求清单在仓库内部维护，不公开。

| 限制 | 说明 |
|---|---|
| HTML 块 | 按原文保留、只读；不渲染 HTML |
| 表格结构 | 行列可增删、列对齐可改；表头行不可删，至少留一行一列；非矩形表与合并格不支持结构编辑 |
| 表格是“一个块” | 改任何一格、增删行列、改对齐 → 整张表按标准 GFM 重写 |
| 列表是“一个块” | 改列表里任何一项 → 整个列表块重写（记号、缩进、空行规范化） |
| 缩进列宽 | 改过的列表块按标准列宽写：无序 / 任务项 2 空格，有序按记号宽度 |
| 下划线 | 规范里没有写法，不提供；`Ctrl+U` 与 HTML 的 `<u>` 会被摘掉 |
| 反缩进 | 被反缩进的项是父列表的唯一子项时拒绝执行（不静默删内容） |
| 尚未支持的写法 | 少数写法在富文本里是纯文字或只读；含数字字符引用的段落整段只读 |
| 裸链接 | `www.` / 裸 `http(s)://` / 裸邮箱按 GFM 读成链接；裸 `ftp://` 不是；裸邮箱点了不打开 |
| 链接写法 | 裸写的 `https://…` 会写成 `<https://…>`（同一链接，一轮后字节稳定） |
| 引用式图片 | 能打开、能原样保存，但不是图片节点，页面里不显示成图 |
| 图片目的地 | `![alt](my file.png)` 按规范不是图片；`/` 开头的地址按操作系统绝对路径处理 |
| 远程图片 | 含 `https://` 图片的笔记打开时，浏览器会去取那张图 |
| 图片上限 | 单张 20 MB |
| 删除图片 | 只删节点，`.img/` 里的文件不自动清理 |
| 新增路由未生效 | 图片落盘、拖动排序、移动、创建副本依赖新增路由；Host 没重启时会明确提示 |
| 排序存储 | 顺序在仓库根的 `.config/tree.json`，只记名字；资源管理器里看不到 |
| 外部改名 | 在编辑器外改名，该条目会排到目录最前，拖一次归位 |
| 删除后重建 | 同名文件回原位；目录名单整段重写后不再记得 |
| 移动改写图片 | 深度变化的移动会改写笔记里的图片相对地址；移动文件夹时逐篇改写（上限 500 篇） |
| 手写相对链接 | 指向被移动文件的相对链接不会跟着改 |
| 链接点击 | 只对 `http(s)`、且不带修饰键的左键单击生效；相对地址 / 锚点 / `mailto:` 不打开 |
| 打开位置 | 优先平台右侧栏；不行则在本面板开「网页」标签；都不行才用系统浏览器 |
| 网页标签 | 没有前进 / 后退 / 刷新 / 地址栏；Web profile 受站点 `frame-ancestors` 限制 |
| 内置浏览器 | 需要右侧栏处于展开且可见的状态 |
| 排序范围 | 自定义顺序只在插件里生效 |
| 树的刷新 | 不监听磁盘：窗口重新获得焦点、面板重挂、点刷新、改名 / 移动时才重读 |
| 私有目录 | `.img` / `.config` 带隐藏属性；插件按名字过滤，不读这个属性 |
| 私有目录何时出现 | `.img` 在第一张图落盘时建；`.config` 在第一次拖动 / 移动 / 副本时建；关联仓库不创建任何东西 |
| 拖动滚动 | 指针停在树的上 / 下边缘 28px 内自动滚动；拖动期间滚轮不生效 |
| 拖动的边界 | 没有键盘排序、没有撤销、不能跨仓库；拖到别的应用只得到相对路径文本 |
| 创建副本 | 只复制内容；时间戳、权限、Windows 备用数据流不克隆；不做文件夹 / 多选 / 跨目录复制 |
| CRLF | `\r` 保留在文本节点里 |
| 只有空白的空行 | 归一成空行（那几个字符本身存不下来），此后字节稳定 |
| 引用里的 tab 代码 | 未改动时原文照搬；一旦编辑这一段引用，按标准写法重写 |
| 列表旁的多余空行 | `- a` ＋ 两个空行 ＋ `- b` 会存成一个空行（项之间少一个空行，其余不变） |
| 空行后的列表项 | 列表项后跟空行再接文字，那段文字仍被读成该条的续行 |
| 大文档 | 不设打开上限；富文本且超过 4 MB 时先问；导入超过 0.8 秒提示一次；源码视图超过 2 MB 不自动解析目录 |
| 界面语言 | 只有中文 |

## 发布

- 版本号只在 `package.json` 一处；Git tag 与 npm 版本同一个号。
- `pnpm build` → `pnpm pack` 核对内容（`files` 里有 `lib/`、`cordis.patch.yml`、README、LICENSE、`_vault-test/`）→ 发布。
- 发 npm 与推 GitHub 是两件事；发布流程在仓库内部维护，不进公开文档。

## 贡献与反馈

- 报问题时附上能复现的最小 Markdown 原文（文字即可，不必截图）。
- 提 PR 前跑：`pnpm typecheck`、`pnpm test`、`pnpm verify:map`。

## License

MIT

---

## English

**A Markdown editor plugin for DeepSeek Harness.** Point it at a directory and edit the `.md` files inside it — rich text by default, a read-only source view on demand — while the bytes on disk stay standard CommonMark 0.31.2 + GFM.

- **Two halves**: a Cordis host plugin (`lib/index.js`) serving `/markdown-vault/*` routes, and a browser-side React + Lexical panel (`lib/client.js`).
- **Block-level fidelity**: untouched top-level blocks are copied byte-for-byte; only edited blocks are rewritten by a standard writer. Open a file, change nothing, save — the bytes are identical.
- **No platform-level file access**: every operation is containment-checked against the single directory you authorized. Structural operations (rename, move, delete, mkdir, image writes) go through `node:fs`, so DSH shows no sandbox prompt for them.
- **Requirements**: DSH `0.2.x` (see `dsh.compatibility.dsh` in `package.json`), a `desktop` or `web` profile, Windows / macOS / Linux.
- **Install**: `dsh plugin --profile desktop add @yancy617/dsh-plugin-markdown`, then fully quit and reopen DSH (a page refresh is not enough).
- **Develop**: `pnpm install` → `pnpm build` → restart DSH → verify in the GUI. `pnpm typecheck && pnpm test` is the check.
- **Docs**: architecture, requirements and decision records live in `docs/` (Chinese). License: MIT.
