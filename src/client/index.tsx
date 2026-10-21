/**
 * dsh-plugin-markdown 的客户端半边。
 *
 * 内容
 * - inject / WORKBENCH_PANEL / apply。
 *
 * 行为
 * - 向 main 注册 MarkdownPanel（工作台 ＋ 整块兜底；key = dsh-plugin-markdown）。
 * - 向 sidebar.panellist 注册 MarkdownPanelIcon（id 与 main key 相同）。
 * - 通过 inject 面提供 pickDirectory / store / sessions / openWebPage。
 * - 不在 Settings 里注册任何东西。
 *
 * 边界
 * - 不调用 ctx.layout.selectPanel；按钮与选中态归侧栏。
 * - 不 import 其他功能插件的运行时值（bundle 纯度门）。
 *
 * 相关文件
 * - 依赖：MarkdownPanel、MarkdownPanelIcon、webPage、workbenchStore。
 * - 被依赖：package.json 的 dsh.client 行。
 *
 * 改哪里
 * - 改注册：apply。
 * - 改面板 key：WORKBENCH_PANEL。
 */
import type { Context } from '@deepseek-ai/cordis'
// Declares `main` (and the rest of the frame's slots) on the SlotMap.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
// Declares the `slots` service on the Client Context and the SlotMap rows this
// package registers into. Type-only: erased before the client bundle purity gate.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
// Declares the `sidebar.panellist` row on the SlotMap. The owning package, now
// a dependency: this file carries no hand-copied augmentation of that slot
// in `./declarations`, which is exactly the kind of copy that diverges silently.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { MarkdownPanelIcon } from './MarkdownPanelIcon'
import { MarkdownPanel } from './MarkdownPanel'
import { createDocumentSessions } from './documentSessions'
import type { WorkbenchSnapshot } from './workbench/model'
import { webPageOpener } from './webPage'
import { createWorkbenchStore, type WorkbenchStore } from './workbenchStore'

/**
 * Cordis services `apply` requires before it may run.
 *
 * `uiWorkspace` carries the host's native directory picker — the one part of
 * the vault flow the plugin does not implement itself.
 */
export const inject = ['slots', 'uiWorkspace']

/**
 * Panel identity. One string serves both halves of the pair: the `main` slot
 * key and the `sidebar.panellist` registration id, which the sidebar matches
 * against each other.
 *
 * Namespaced rather than the bare word `markdown`: this key occupies a slot in a
 * shared map, and a generic name would collide the day another package claims
 * it. The user never sees it — the sidebar button's name comes from `label`.
 */
const WORKBENCH_PANEL = 'dsh-plugin-markdown'

/**
 * Register the workbench and its sidebar entry point.
 * @param ctx - Client context carrying the `slots` and `uiWorkspace` services.
 */
export function apply(ctx: Context): void {
  // Created once, outside the registration: the `main` slot is keyed, so its
  // declaration lifetime can restart, and a store made inside the inject
  // factory would be replaced right when it is needed.
  const workbench: WorkbenchStore<WorkbenchSnapshot> = createWorkbenchStore<WorkbenchSnapshot>()
  // Same lifetime reason: undo/redo belongs to the open documents, not to one mount of the panel.
  const sessions = createDocumentSessions()

  ctx.slots.inject('main', () =>
    ctx.slots.register(
      {
        name: 'main',
        key: WORKBENCH_PANEL,
        // A slot component never sees `ctx`, so the client capabilities the
        // workbench needs arrive through its inject face.
        inject: () => ({
          pickDirectory: () => ctx.uiWorkspace.pickDirectory(),
          store: workbench,
          sessions,
          // 外链开到哪儿去：先问平台自己的右侧栏浏览器标签，问不通退系统浏览器。判据与出处
          // （含"本面板里通常问不通"的那条平台规则）写在 `./webPage.ts` 的文件头。
          openWebPage: webPageOpener(ctx),
        }),
      },
      MarkdownPanel,
    ),
  )

  ctx.slots.inject('sidebar.panellist', () =>
    ctx.slots.register(
      {
        name: 'sidebar.panellist',
        id: WORKBENCH_PANEL,
        // The shipped panel (`plugins`) registers at order 0; sit after it.
        order: 20,
        // The accessible name of the sidebar's own button.
        label: 'Markdown',
      },
      MarkdownPanelIcon,
    ),
  )
}
