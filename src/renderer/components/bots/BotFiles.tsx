import { Children, createContext, isValidElement, useContext, useEffect, useState, type ReactElement, type ReactNode } from 'react'
import type { Components } from 'streamdown'
import { FileText, FolderOpen, Image as ImageIcon, X } from '../../lib/icons'
import { Markdown, type MarkdownImages } from '../../chat/components/agent-elements/markdown'
import { LinkLabel } from '../../chat/components/agent-elements/link-label-view'
import { classifyLink, routeLink } from '../../utils/chatLinks'
import { fileLocation, isAbsolutePath } from '../../utils/filesBrowse'
import { parseMousseFileLink } from '../../../shared/chatReferences'
import { BotMarkdownImage, useFileImage } from './BotImages'
import { botPathLabel, linkBotPaths, pathName } from './botPaths'
import { isKeyValueList } from './botChatShape'
import { MathInline } from '../../markdown/math/MathView'
import { readMathClass } from '../../markdown/math/math-markup'

/**
 * Files a bot names in its chat: each path is a chip with the file's name (its full path on hover). A click opens it
 * in the Files pane beside the chat; Show in folder opens its folder in the computer's file manager.
 */

/**
 * The chat a chip or picture is in: its bot (for short names in its files folder), how it opens a file, and how it
 * says that an action on a file failed (above the composer).
 */
interface BotFilesHost { botId: string; open(path: string): void; failed?(message: string): void }
const BotFilesContext = createContext<BotFilesHost | null>(null)

export function BotFilesProvider({ botId, open, failed, children }: BotFilesHost & { children: ReactNode }) {
  return <BotFilesContext.Provider value={{ botId, open, ...(failed ? { failed } : {}) }}>{children}</BotFilesContext.Provider>
}

/** The chat's files host, or null outside a bot's chat. */
export function useBotFiles(): BotFilesHost | null {
  return useContext(BotFilesContext)
}

const IMAGE_FILE = /\.(?:png|jpe?g|gif|webp)$/i
/** Inline code this long or shorter, without spaces, never breaks inside. */
const WHOLE_CODE = 40
const reason = (error: unknown) => String((error as { message?: string })?.message ?? error).replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, '')

/**
 * The actions on a file of this computer (localFiles in the preload): Show in folder selects it in File Explorer,
 * Finder or the Files app; Save as… copies it where the owner picks; Copy image puts a picture on the clipboard. A
 * refusal ("That file does not exist.") is said through `failed`.
 */
export const fileActions = {
  showInFolder: (path: string, failed?: (message: string) => void) => { void window.mousse.localFiles.showInFolder(path).catch((error) => failed?.(reason(error))) },
  saveAs: (path: string, failed?: (message: string) => void) => { void window.mousse.localFiles.saveCopy(path).catch((error) => failed?.(reason(error))) },
  copyImage: (path: string, failed?: (message: string) => void) => { void window.mousse.localFiles.copyImage(path).catch((error) => failed?.(reason(error))) }
}

/** One file the bot named: its name, a click to open it here, and Show in folder. A picture also shows above the reply. */
export function BotPathChip({ path }: { path: string }) {
  const host = useContext(BotFilesContext)
  const label = botPathLabel(path, host?.botId)
  const Icon = IMAGE_FILE.test(path) ? ImageIcon : FileText
  const open = () => (host ? host.open(path) : routeLink(`mousse-file://open?path=${encodeURIComponent(path)}`))
  return <span className="bot-path">
    <span className="bot-path-chip">
      <button type="button" className="bot-path-open" title={path} aria-label={`Open ${label}`} onClick={open}>
        <Icon size={13} aria-hidden /><span>{label}</span>
      </button>
      <button type="button" className="bot-path-folder" title="Show in folder" aria-label={`Show ${label} in folder`} onClick={() => fileActions.showInFolder(path, host?.failed)}>
        <FolderOpen size={13} aria-hidden />
      </button>
    </span>
  </span>
}

/** A list of bold keys and their values ("**CPU:** AMD Ryzen 9") as a small card; its items as they were drawn. */
function KeyValueCard({ children }: { children: ReactNode }) {
  const rows = Children.toArray(children).filter(isValidElement) as Array<ReactElement<{ children?: ReactNode }>>
  return <dl className="bot-kv">
    {rows.map((row, index) => {
      const parts = Children.toArray(row.props.children).filter((part) => typeof part !== 'string' || part.trim())
      const [key, ...rest] = parts
      const name = isValidElement<{ children?: ReactNode }>(key) ? Children.toArray(key.props.children).join('').replace(/:\s*$/, '') : ''
      // `**RAM**: 19.7 GB`: the colon after the key belongs to it, and the space before the value goes.
      const value = rest.map((part, at) => (at === 0 && typeof part === 'string' ? part.replace(/^\s*:?\s*/, '') : part))
      return <div key={index} className="bot-kv-row"><dt>{name}</dt><dd>{value}</dd></div>
    })}
  </dl>
}

/** The path a link opens, when it names a file of this computer by its full path. */
function linkedPath(href: string | undefined): string | undefined {
  if (!href) return undefined
  const restored = href.startsWith('/__mousse_file_open__?') ? `mousse-file://open?${href.slice('/__mousse_file_open__?'.length)}` : href
  const file = parseMousseFileLink(restored)
  if (file) return file.path
  const route = classifyLink(restored)
  return route.kind === 'relative-file' && isAbsolutePath(route.path) ? route.path : undefined
}

/**
 * The bot chat's image rule, on every Markdown of a bot's chat (the owner's messages included): a reply can be shaped by
 * what the bot read on the web, so a web picture is a link and never loads, SVG never shows, a `<picture>`'s sources are
 * dropped, and its blocks are cached apart from a thread's (`MarkdownImages`, `BotMarkdownImage`).
 */
export const BOT_IMAGES: MarkdownImages = { Image: BotMarkdownImage }

/**
 * A bot message's Markdown elements that differ from a thread's: a file link is the file's chip, a list of keys and
 * values a card, and short inline code stays whole. Its images follow `BOT_IMAGES`, which no element here replaces.
 * Kept for the module's life (see `Markdown`).
 */
const botMarkdownComponents: Partial<Components> = {
  a: ({ href, children, ...props }) => {
    const path = linkedPath(href)
    if (path) return <BotPathChip path={path} />
    if (!href || classifyLink(href).kind === 'reject') return <span>{children}</span>
    return <a {...props} href={href} className="an-md-link" onClick={(event) => { event.preventDefault(); routeLink(href) }}>
      <LinkLabel href={href}>{children}</LinkLabel>
    </a>
  },
  // Inline code stays inline, so the punctuation after it stays with it. A short piece without spaces never breaks
  // inside (a file name or a flag reads whole); a longer one wraps anywhere. Inline math is drawn as a thread draws it.
  inlineCode: ({ children, node: _node, ...props }) => {
    const math = readMathClass(props.className)
    const text = Children.toArray(children).join('')
    if (math) return <MathInline tex={text} display={math.display} delimiter={math.delimiter} />
    return <code {...props} className={`an-md-code${text.length <= WHOLE_CODE && !/\s/.test(text) ? ' is-whole' : ''}`}>{children}</code>
  },
  ul: ({ node, children, ...props }) => isKeyValueList(node as Parameters<typeof isKeyValueList>[0])
    ? <KeyValueCard>{children}</KeyValueCard>
    : <ul className="an-md-ul list-outside" {...props}>{children}</ul>
}

/** A bot message's text, drawn as a thread's reply is (headings, lists, tables, code), with its paths as chips. */
export function BotMarkdown({ text, className }: { text: string; className?: string }) {
  return <Markdown content={linkBotPaths(text)} className={className} images={BOT_IMAGES} components={botMarkdownComponents} />
}

/** The language a file's code block is highlighted as, from its name. */
const LANGUAGES: Record<string, string> = {
  py: 'python', ts: 'ts', tsx: 'tsx', js: 'js', mjs: 'js', cjs: 'js', jsx: 'jsx', json: 'json', svg: 'xml', xml: 'xml',
  html: 'html', css: 'css', sh: 'bash', ps1: 'powershell', yml: 'yaml', yaml: 'yaml', toml: 'toml', sql: 'sql', rs: 'rust', go: 'go'
}
/** What the pane reads of a long file. */
const MAX_TEXT = 200_000

/** A text file as the pane shows it: Markdown as a reply, anything else as one code block. */
export function filePreviewMarkdown(path: string, text: string): string {
  const extension = /\.([^.\\/]+)$/.exec(path)?.[1]?.toLowerCase() ?? ''
  if (extension === 'md' || extension === 'markdown') return text
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((run) => run[0].length))
  const fence = '`'.repeat(longest + 1)
  return `${fence}${LANGUAGES[extension] ?? 'text'}\n${text}\n${fence}`
}

type TextRead = { state: 'loading' } | { state: 'failed' } | { state: 'read'; text: string; cut: boolean }

function useFileText(path: string, enabled: boolean): TextRead {
  const [read, setRead] = useState<TextRead>({ state: 'loading' })
  useEffect(() => {
    if (!enabled) return
    let live = true
    setRead({ state: 'loading' })
    const at = fileLocation(path)
    window.mousse.fs.readFile(at.path, undefined, null, at.root)
      .then((text) => { if (live) setRead({ state: 'read', text: text.slice(0, MAX_TEXT), cut: text.length > MAX_TEXT }) })
      .catch(() => { if (live) setRead({ state: 'failed' }) })
    return () => { live = false }
  }, [path, enabled])
  return read
}

function ImagePreview({ path }: { path: string }) {
  const image = useFileImage(path)
  if (image?.failed) return <p className="bot-file-state">Can't show this picture.</p>
  if (!image?.url) return <p className="bot-file-state">Opening…</p>
  return <img className="bot-file-image" src={image.url} alt={pathName(path)} draggable={false} />
}

function TextPreview({ path }: { path: string }) {
  const read = useFileText(path, true)
  if (read.state === 'loading') return <p className="bot-file-state">Opening…</p>
  if (read.state === 'failed') return <p className="bot-file-state">Can't open this file.</p>
  return <>
    <BotMarkdown text={filePreviewMarkdown(path, read.text)} className="bot-markdown bot-file-text" />
    {read.cut && <p className="bot-file-state">Showing the start of this file.</p>}
  </>
}

/** The Files pane beside a bot's chat: the file a chip opened, with Show in folder and Close. */
export function BotFilePane({ botId, path, onClose }: { botId: string; path: string; onClose(): void }) {
  const label = botPathLabel(path, botId)
  const host = useContext(BotFilesContext)
  return <aside className="bot-file-pane" aria-label={`File ${label}`}>
    <header className="bot-file-head">
      <span className="bot-file-name" title={path}>{label}</span>
      <button type="button" className="bot-file-button" title="Show in folder" aria-label="Show in folder" onClick={() => fileActions.showInFolder(path, host?.failed)}><FolderOpen size={15} aria-hidden /></button>
      <button type="button" className="bot-file-button" title="Close" aria-label="Close file" onClick={onClose}><X size={15} aria-hidden /></button>
    </header>
    <div className="bot-file-body">{IMAGE_FILE.test(path) ? <ImagePreview path={path} /> : <TextPreview key={path} path={path} />}</div>
  </aside>
}
