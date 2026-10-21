/**
 * 图片在编辑器里怎么显示：占位、图片、以及什么时候开始加载。
 *
 * 内容
 * - ImageHost / ImageContext / ImageHostProvider / useImageHost。
 * - scheduleIdle / imageLabel / ImageDecorator。
 *
 * 行为
 * - 只提供文档路径、仓库根、bundled、图片写入端口四件事给装饰器与插入路径。
 * - 加载在空闲时开始，不在文档渲染期间；先文字后图片。
 * - 占位是一行；图片到达后那一行会变高。
 * - 加载失败显示 alt（没有 alt 就用文件名）。
 *
 * 边界
 * - 不负责节点拼写（image.tsx）与地址解析（imagePath.ts）。
 * - 不负责插入文件（imageInsert.ts / ImageDialog.tsx）。
 *
 * 相关文件
 * - 依赖：imagePath.ts、assetWriter.ts、react。
 * - 被依赖：image.tsx（装饰器）、MarkdownEditor.tsx、ImageDialog.tsx、PasteMarkdownPlugin.tsx。
 *
 * 改哪里
 * - 改调度：scheduleIdle。
 * - 改显示：ImageDecorator / imageLabel。
 * - 改上下文：ImageHostProvider。
 */
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type JSX,
  type ReactNode,
} from 'react'
import { imageDisplayUrl } from './imagePath'
import type { AssetWriter } from './assetWriter'

/** What a decorator and the insert paths need to know about where they are. */
export interface ImageHost {
  /** Absolute path of the document being edited, when known. */
  readonly documentPath: string | null
  /** The authorized vault root, when one is associated. */
  readonly vaultRoot: string | null
  /**
   * Whether the document is one of the plugin's own bundled samples.
   *
   * The samples are the package's material rather than a directory: their pictures are shipped
   * files served by this plugin's own route, so a relative destination is read under those rules
   * instead of being resolved beside a document (`./imagePath.ts`).
   */
  readonly bundled: boolean
  /**
   * How this panel stores a picture, or `null` when the mount has no writer (a probe).
   *
   * The editor never imports the route client: the workbench supplies this port, which is what
   * keeps "where a picture goes" a panel decision rather than an editor one.
   */
  readonly writeAsset: AssetWriter | null
}

/** Where the document is and where the vault is, for every image inside it. */
const ImageContext = createContext<ImageHost>({
  documentPath: null,
  vaultRoot: null,
  bundled: false,
  writeAsset: null,
})

/**
 * Publish the open document's path and the vault's root to every image.
 *
 * One context rather than two: both answers come from the same place (the panel that knows which
 * document is open and which directory is associated), and a decorator that had the path but not the
 * root could resolve a picture it is unable to store.
 * @param props - the two paths, whether the document is a bundled sample, and the subtree that
 * renders images.
 * @returns the provider element.
 */
export function ImageHostProvider({
  documentPath,
  vaultRoot,
  bundled = false,
  writeAsset = null,
  children,
}: {
  readonly documentPath: string | null
  readonly vaultRoot: string | null
  readonly bundled?: boolean
  readonly writeAsset?: AssetWriter | null
  readonly children: ReactNode
}): JSX.Element {
  const value = useMemo(
    () => ({ documentPath, vaultRoot, bundled, writeAsset }),
    [bundled, documentPath, vaultRoot, writeAsset],
  )
  return <ImageContext.Provider value={value}>{children}</ImageContext.Provider>
}

/**
 * Read the image host from React context.
 * @returns the document path and vault root in scope.
 */
export function useImageHost(): ImageHost {
  return useContext(ImageContext)
}

/** A scheduled callback that can be withdrawn before it runs. */
interface ScheduledHandle {
  /** Cancel the pending call. */
  cancel(): void
}

/**
 * Run a callback once the browser has nothing better to do.
 *
 * `requestIdleCallback` is the point of this function: it fires after the frame that drew the
 * document, which is what "the text first, the images after" means in practice. A host without it
 * falls back to a macrotask, which still lands after paint.
 * @param run - the callback.
 * @returns a handle that cancels it.
 */
function scheduleIdle(run: () => void): ScheduledHandle {
  const idle = (
    globalThis as {
      requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number
    }
  ).requestIdleCallback
  if (idle !== undefined) {
    const handle = idle(run, { timeout: 600 })
    const cancelIdle = (globalThis as { cancelIdleCallback?: (handle: number) => void })
      .cancelIdleCallback
    return { cancel: () => cancelIdle?.(handle) }
  }
  const handle = setTimeout(run, 0)
  return { cancel: () => clearTimeout(handle) }
}

/**
 * The one-line stand-in shown before an image loads, and in its place when it cannot.
 * @param alt - authored alt text.
 * @param source - authored destination.
 * @returns the label to show.
 */
function imageLabel(alt: string, source: string): string {
  if (alt !== '') return alt
  const name = source.replace(/^\/+/, '').split(/[/\\]/).pop() ?? ''
  return name === '' ? '图片' : name
}

/**
 * One image: a placeholder while the document settles, then the picture, or the alt text when it
 * cannot be shown.
 * @param props - the authored alt text and destination.
 * @returns the rendered image.
 */
export function ImageDecorator({
  alt,
  source,
}: {
  readonly alt: string
  readonly source: string
}): JSX.Element {
  const { documentPath, bundled } = useImageHost()
  const url = useMemo(
    () => imageDisplayUrl(documentPath, source, document.baseURI, bundled),
    [bundled, documentPath, source],
  )
  const [phase, setPhase] = useState<'waiting' | 'loading' | 'failed'>(
    url === null ? 'failed' : 'waiting',
  )

  useEffect(() => {
    if (url === null) {
      setPhase('failed')
      return
    }
    setPhase('waiting')
    let cancelled = false
    const handle = scheduleIdle(() => {
      if (!cancelled) setPhase('loading')
    })
    return () => {
      cancelled = true
      handle.cancel()
    }
  }, [url])

  const label = imageLabel(alt, source)
  if (phase === 'failed') {
    return (
      <span className="md-image-alt" title={source}>
        {label}
      </span>
    )
  }
  if (phase === 'waiting') {
    return (
      <span className="md-image-wait" title={source}>
        {label}
      </span>
    )
  }
  return (
    <img
      className="md-image"
      src={url ?? undefined}
      alt={alt}
      loading="lazy"
      decoding="async"
      onError={() => setPhase('failed')}
    />
  )
}
