/**
 * 工作台命令表：一个操作只在这里定义一次，菜单 / 快捷键 / 命令面板都是它的界面。
 *
 * 内容
 * - CommandTarget / WorkbenchCommand / WorkbenchCommandDeps。
 * - createWorkbenchCommands（纯工厂：state + actions ⇒ 命令数组）。
 * - pickCommands / menuRowsFor（命令 ⇒ 菜单行）。
 *
 * 行为
 * - `enabled` / `active` 是命令自己的前置条件与选中态；界面不许另写一份。
 * - `run` 只调用注入的 action，不读组件状态、不 setState —— 所以这张表能在 Node 里构造。
 * - menuRowsFor 按 action 的 target（file / directory / both / workbench）过滤，并给分隔符造稳定 id。
 *
 * 边界
 * - 不拥有状态（谁是当前文档、忙不忙由组件给）。
 * - 不实现操作（保存 / 移动 / 换目录都在各自的 feature 里）。
 *
 * 相关文件
 * - 依赖：shared/paths（move 的兜底文档名）、primitives 的 MenuEntry 类型。
 * - 被依赖：MarkdownWorkbench.tsx。
 *
 * 改哪里
 * - 加 / 删命令：createWorkbenchCommands。
 * - 改菜单形状：pickCommands / menuRowsFor。
 * - 改前置条件：该命令的 `enabled`。
 */
import { basenameOf } from '../../shared/paths'
import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'

/** What a command may act on: a tree row, or the open document standing in for one. */
export interface CommandTarget {
  /** Absolute path of the entry. */
  readonly path: string
  /** Basename. */
  readonly name: string
  /** Whether the entry is a directory. */
  readonly isDirectory: boolean
}

/**
 * One thing the workbench can do.
 *
 * Commands are the single definition of an operation; the context menu is one way to reach them
 * rather than the place they live. That separation is what lets `refresh` exist as a command with
 * no menu row — it is invoked by code after a path changes — and it is what would let a keyboard
 * shortcut or a command palette reach the same operations without restating any of them.
 */
export interface WorkbenchCommand {
  /** Stable id, also the shortcut table's command id. */
  readonly id: string
  /** Row text and palette label. */
  readonly label: string
  /** What kind of entry it acts on. */
  readonly target: 'file' | 'directory' | 'both' | 'document' | 'workbench'
  /** Menu grouping; rows of one group are drawn together. */
  readonly group: 'create' | 'path' | 'edit' | 'document' | 'vault' | 'view' | 'help'
  /** Drawn as dangerous (delete, revoke). */
  readonly danger?: boolean
  /** Toggle commands only: is the thing currently on. */
  readonly active?: boolean
  /** Whether it may run now; absent means yes. */
  readonly enabled?: boolean
  /** Perform it. A null target is the palette case and the command itself decides. */
  readonly run: (target: CommandTarget | null) => void | Promise<void>
}

/** The state a command's precondition reads. */
export interface WorkbenchCommandState {
  /** A write / directory operation is in flight. */
  readonly busy: boolean
  /** Which kind of vault is showing; the sample vault refuses writes and moves. */
  readonly vaultKind: 'sample' | 'user' | null
  /** The showing document, when there is one. */
  readonly open: { readonly kind: 'file'; readonly path: string } | null
  /** The showing document has unsaved text. */
  readonly dirty: boolean
  /** The source view is showing. */
  readonly sourceMode: boolean
  /** The outline column is open. */
  readonly outlineOpen: boolean
  /** The find row is showing. */
  readonly findOpen: boolean
}

/**
 * What a command does.
 *
 * Named actions rather than setters: a command says *what* happens, and the component decides how
 * its state moves. That is what keeps this module free of React and of the component's internals.
 */
export interface WorkbenchCommandActions {
  openCreatePrompt(kind: 'file' | 'directory', directory: string): void
  openRenamePrompt(target: CommandTarget): void
  copyPath(path: string): void
  reveal(path: string): void
  /**
   * Copy one document to a sibling “ 副本<n>”.
   *
   * `null` is the command palette: there is no row, so the action falls back to the open document
   * — the same shape `openMoveDialog` uses.
   */
  duplicate(target: CommandTarget | null): void
  openMoveDialog(target: CommandTarget | null): void
  confirmDelete(target: CommandTarget): void
  refreshAll(): void
  openPalette(): void
  showSource(source: boolean): void
  save(): void
  reload(): void
  closeDocument(path: string): void
  closeDocumentDiscard(path: string): void
  chooseVault(): void
  revokeVault(): void
  toggleOutline(): void
  toggleFind(): void
  openSample(name: string): void
  checkUpdate(): void
}

/** Everything the table needs. */
export interface WorkbenchCommandDeps {
  readonly state: WorkbenchCommandState
  readonly actions: WorkbenchCommandActions
}

/**
 * Build the command table for the current state.
 * @param deps - state the preconditions read, and the actions the commands run.
 * @returns the commands, in menu order.
 */
export function createWorkbenchCommands(deps: WorkbenchCommandDeps): readonly WorkbenchCommand[] {
  const { busy, vaultKind, open, dirty, sourceMode, outlineOpen, findOpen } = deps.state
  const actions = deps.actions
  return [
    {
      id: 'newFile',
      label: '新建文档',
      target: 'directory',
      group: 'create',
      run: target => {
        if (target === null) return
        actions.openCreatePrompt('file', target.path)
      },
    },
    {
      id: 'newFolder',
      label: '新建文件夹',
      target: 'directory',
      group: 'create',
      run: target => {
        if (target === null) return
        actions.openCreatePrompt('directory', target.path)
      },
    },
    {
      id: 'copyPath',
      label: '复制路径',
      target: 'both',
      group: 'path',
      run: target => {
        if (target === null) return
        actions.copyPath(target.path)
      },
    },
    {
      id: 'reveal',
      label: '文件位置',
      target: 'both',
      group: 'path',
      run: target => {
        if (target === null) return
        actions.reveal(target.path)
      },
    },
    {
      // In the path group, between 文件位置 and the hairline: the writer asked for that exact
      // order, and the copy is a document action rather than a rename.
      id: 'duplicate',
      label: '创建副本',
      target: 'file',
      group: 'path',
      // The sample vault is read-only, so the Host would refuse; grey it out here instead of
      // letting the click fail. The palette reads the same `enabled`.
      enabled: !busy && vaultKind === 'user',
      run: target => {
        actions.duplicate(target)
      },
    },
    {
      id: 'rename',
      label: '重命名',
      target: 'both',
      group: 'edit',
      // The registry states it so every surface inherits it: the command palette already reads
      // `enabled`, and the F2 binding dispatches through `canRun`. The *other* half of this
      // command's precondition — whether there is a target at all — cannot live here, because it
      // is only known at dispatch; `run` refuses a null one itself.
      enabled: !busy,
      run: target => {
        if (target === null) return
        actions.openRenamePrompt(target)
      },
    },
    {
      /**
       * The move, as a command.
       *
       * The drag is the fast way and this is the deliberate one: same transaction, chosen from a
       * list instead of aimed at a row. Two things follow from being a command rather than a
       * dialog opened by a gesture — it reaches the row menu, and the command palette reaches it
       * too, where there is no entry to act on. The palette case falls back to the document that
       * is open, exactly as `closeDocument` does.
       */
      id: 'move',
      label: '移动到',
      target: 'both',
      group: 'edit',
      // The sample vault is the plugin's own material, and dragging is refused there — the same
      // operation reached through a menu has to be refused for the same reason. It also keeps
      // `.config` out of a vault the writer never arranged.
      enabled: !busy && vaultKind === 'user',
      run: target => {
        const moving =
          target ??
          (open !== null
            ? { path: open.path, name: basenameOf(open.path), isDirectory: false }
            : null)
        if (moving === null) return
        actions.openMoveDialog(moving)
      },
    },
    {
      id: 'delete',
      label: '删除',
      target: 'both',
      group: 'edit',
      danger: true,
      run: target => {
        if (target !== null) actions.confirmDelete(target)
      },
    },
    {
      id: 'refresh',
      label: '刷新',
      target: 'workbench',
      group: 'edit',
      run: () => actions.refreshAll(),
    },
    {
      // Not a toolbar-only action any more: the toolbar button called the setter directly and so
      // did the shortcut, which left nothing for a menu keyed by command id to find. One entry
      // now serves both, and the two cannot drift into disagreeing about what 命令 does.
      id: 'openPalette',
      label: '命令',
      target: 'workbench',
      group: 'view',
      run: () => actions.openPalette(),
    },
    {
      // Two commands, not the one flip the Pills shared. A flip belongs to a pair of buttons that
      // always shows which side you are on; in a menu, 编辑模式 would move you to source when you
      // are already editing. Each of these sets its mode, and each carries `active` so the menu
      // can mark the one in use.
      id: 'modeEdit',
      label: '编辑模式',
      target: 'workbench',
      group: 'view',
      active: !sourceMode,
      enabled: open !== null,
      run: () => actions.showSource(false),
    },
    {
      id: 'modeSource',
      label: '源码模式',
      target: 'workbench',
      group: 'view',
      active: sourceMode,
      enabled: open !== null,
      run: () => actions.showSource(true),
    },

    // Document commands. These already existed as toolbar buttons; they are commands now so that
    // a shortcut or a palette can reach them without the buttons being rewritten, and so their
    // preconditions live in one place.
    {
      id: 'save',
      label: '保存',
      target: 'document',
      group: 'document',
      enabled: open !== null && dirty && !busy,
      run: () => actions.save(),
    },
    {
      id: 'reloadDocument',
      label: '重新载入',
      target: 'document',
      group: 'document',
      enabled: open !== null && !busy,
      run: () => actions.reload(),
    },
    {
      id: 'closeDocument',
      label: '关闭当前文档',
      target: 'document',
      group: 'document',
      enabled: open !== null,
      // A tab's × closes *that* tab, which need not be the showing one, so the command takes an
      // optional explicit path. Called with nothing it closes the active document — which is what
      // a Cmd+W binding will want.
      run: entry => {
        const path = entry?.path ?? open?.path
        // Not awaited: the tab goes when its write has landed (see `closeTab`), and the command
        // has nothing to do with the answer.
        if (path !== undefined) actions.closeDocument(path)
      },
    },
    {
      id: 'closeDocumentDiscard',
      label: '放弃更改并关闭',
      target: 'document',
      group: 'document',
      danger: true,
      enabled: open !== null,
      run: entry => {
        const path = entry?.path ?? open?.path
        if (path !== undefined) actions.closeDocumentDiscard(path)
      },
    },

    // Panel commands.
    {
      id: 'chooseVault',
      label: '换目录',
      target: 'workbench',
      group: 'vault',
      enabled: !busy,
      run: () => actions.chooseVault(),
    },
    {
      id: 'revokeVault',
      label: '撤销授权',
      target: 'workbench',
      group: 'vault',
      danger: true,
      enabled: !busy,
      run: () => actions.revokeVault(),
    },

    // View toggles. They are commands, but deliberately a different group: a toggle changes what
    // is on screen, it does not do anything to the document, and mixing the two would make a
    // future palette misleading.
    {
      id: 'toggleOutline',
      label: '文档目录',
      target: 'workbench',
      group: 'view',
      active: outlineOpen,
      enabled: open !== null,
      run: () => actions.toggleOutline(),
    },
    {
      id: 'toggleFind',
      label: '查找替换',
      target: 'workbench',
      group: 'view',
      active: findOpen,
      enabled: open !== null && !sourceMode,
      run: () => actions.toggleFind(),
    },

    // The plugin's own two documents. They are commands like everything else, so the gear menu is
    // one more surface over a registry rather than the place the operation lives — and the palette
    // reaches them without the workbench naming them twice.
    {
      id: 'openFeatures',
      label: '功能介绍',
      target: 'workbench',
      group: 'help',
      enabled: !busy,
      run: () => actions.openSample('功能介绍.md'),
    },
    {
      id: 'openAbout',
      label: '关于',
      target: 'workbench',
      group: 'help',
      enabled: !busy,
      run: () => actions.openSample('关于.md'),
    },
    {
      // The plugin's one outbound request, behind a command rather than on a timer: it is never
      // sent unless the writer asks, which is the promise this command makes and the README
      // repeats. It installs nothing — the notice carries the command instead.
      id: 'checkUpdate',
      label: '检查更新',
      target: 'workbench',
      group: 'help',
      enabled: !busy,
      run: () => actions.checkUpdate(),
    },
  ]
}

/**
 * Menu rows for a fixed list of ids, in that order, with `|` as a separator.
 * @param byId - commands keyed by id.
 * @param ids - command ids; `|` inserts a separator.
 * @returns rows for the platform `Menu`.
 */
export function pickCommands(
  byId: ReadonlyMap<string, WorkbenchCommand>,
  ids: readonly string[],
): MenuEntry[] {
  const rows: MenuEntry[] = []
  for (const id of ids) {
    if (id === '|') {
      rows.push({ type: 'separator', id: `sep-${String(rows.length)}` })
      continue
    }
    const command = byId.get(id)
    if (command !== undefined) {
      rows.push({
        id,
        label: command.label,
        danger: command.danger,
        disabled: command.enabled === false,
      })
    }
  }
  return rows
}

/**
 * Build the menu rows for one entry.
 *
 * Sections come from `group`, so a separator is a consequence of the grouping rather than something
 * each menu has to remember to insert — a command added to an existing group can never land on the
 * wrong side of one.
 *
 * **This is the whole of what the entry menu lists, for both ways in.** A row's ⋯ button and a
 * right-click on that row open the same single `Menu`, so the two can never drift into showing
 * different rows. It is also never empty: 复制路径 and 文件位置 are `target: 'both'` and carry no
 * precondition, so every folder and every document has at least those two.
 * @param commands - the registry, in display order.
 * @param isDirectory - whether the row's entry is a directory.
 * @returns the menu rows; empty when nothing applies.
 */
export function menuRowsFor(
  commands: readonly WorkbenchCommand[],
  isDirectory: boolean,
): MenuEntry[] {
  const kind = isDirectory ? 'directory' : 'file'
  const rows: MenuEntry[] = []
  let lastGroup: string | null = null
  for (const command of commands) {
    if (command.target !== 'both' && command.target !== kind) continue
    if (lastGroup !== null && command.group !== lastGroup) {
      rows.push({ type: 'separator', id: `sep-${lastGroup}-${command.group}` })
    }
    rows.push({
      id: command.id,
      label: command.label,
      danger: command.danger,
      // The registry's precondition, restated as a row state instead of being ignored — which is
      // what this list did until the row grew a ⋯ button. `Menu` refuses to activate a disabled
      // row, so 重命名 is greyed while a write is in flight rather than opening its dialog in the
      // middle of one. `pickCommands`, the sidebar's builder, has always done this.
      disabled: command.enabled === false,
    })
    lastGroup = command.group
  }
  return rows
}
