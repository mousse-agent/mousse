import { Children, createContext, isValidElement, useContext, useEffect, useState, type ReactElement, type ReactNode } from 'react'
import type { Components } from 'streamdown'
import { FileText, FolderOpen, Image as ImageIcon, X } from '../../lib/icons'
import { Markdown } from '../../chat/components/agent-elements/markdown'
import { LinkLabel } from '../../chat/components/agent-elements/link-label-view'
import { classifyLink, routeLink } from '../../utils/chatLinks'
import { fileLocation, isAbsolutePath } from '../../utils/filesBrowse'
import { parseMousseFileLink } from '../../../shared/chatReferences'
import { BotMarkdownImage, useFileImage } from './BotImages'
import { botPathLabel, linkBotPaths, pathFolder, pathName } from './botPaths'
import { isKeyValueList } from './botChatShape'

/**
 * Files a bot names in its chat: each path is a chip with the file's name (its full path on hover). A click opens it
 * in the Files pane beside the chat; Show in folder opens its folder in the computer's file manager.
 */

/** The chat a chip is in: its bot (for short names in its files folder) and how it opens a file. */
interface BotFilesHost { botId: string; open(path: string): void }
const BotFilesContext = createContext<BotFilesHost | null>(null)

export function BotFilesProvider({ botId, open, children }: BotFilesHost & { children: ReactNode }) {
  return <BotFilesContext.Provider value={{ botId, open }}>{children}</BotFilesContext.Provider>
}

const IMAGE_FILE = /\.(?:png|jpe?g|gif|webp)$/i

/** Opens a file's folder in File Explorer, Finder or the Files app (the Files editor entry opens folders). */
export function showInFolder(path: string): void {
  const folder = pathFolder(path)
  if (folder) void window.mousse.editors.open('files', folder).catch(() => undefined)
}

/** A picture's preview above its chip, once it has been read; nothing while it is read or when it can't be. */
function PathPicture({ path, label, open }: { path: string; label: string; open(): void }) {
  const image = useFileImage(path)
  if (!image?.url) return null
  return <button type="button" className="bot-path-picture" aria-label={`Open ${label}`} onClick={open}>
    <img src={image.url} alt="" draggable={false} />
  </button>
}

/** One file the bot named: its name (a picture shows above it), a click to open it here, and Show in folder. */
export function BotPathChip({ path }: { path: string }) {
  const host = useContext(BotFilesContext)
  const label = botPathLabel(path, host?.botId)
  const picture = IMAGE_FILE.test(path)
  const Icon = picture ? ImageIcon : FileText
  const open = () => (host ? host.open(path) : routeLink(`mousse-file://open?path=${encodeURIComponent(path)}`))
  return <span className={`bot-path${picture ? ' is-picture' : ''}`}>
    {picture && <PathPicture path={path} label={label} open={open} />}
    <span className="bot-path-chip">
      <button type="button" className="bot-path-open" title={path} aria-label={`Open ${label}`} onClick={open}>
        <Icon size={13} aria-hidden /><span>{label}</span>
      </button>
      <button type="button" className="bot-path-folder" title="Show in folder" aria-label={`Show ${label} in folder`} onClick={() => showInFolder(path)}>
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
 * A bot message's Markdown elements that differ from a thread's: a file link is the file's chip, and images follow
 * the bot chat's rules (BotMarkdownImage: a web image is never loaded). Kept for the module's life (see `Markdown`).
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
  img: ({ src, alt }) => <BotMarkdownImage src={typeof src === 'string' ? src : undefined} alt={alt} />,
  ul: ({ node, children, ...props }) => isKeyValueList(node as Parameters<typeof isKeyValueList>[0])
    ? <KeyValueCard>{children}</KeyValueCard>
    : <ul className="an-md-ul list-outside" {...props}>{children}</ul>
}

/** A bot message's text, drawn as a thread's reply is (headings, lists, tables, code), with its paths as chips. */
export function BotMarkdown({ text, className }: { text: string; className?: string }) {
  return <Markdown content={linkBotPaths(text)} className={className} components={botMarkdownComponents} />
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
    <BotMarkdown text={filePreviewMarkdown(path, read.text)} className="bot-file-text chat-message-markdown chat-markdown" />
    {read.cut && <p className="bot-file-state">Showing the start of this file.</p>}
  </>
}

/** The Files pane beside a bot's chat: the file a chip opened, with Show in folder and Close. */
export function BotFilePane({ botId, path, onClose }: { botId: string; path: string; onClose(): void }) {
  const label = botPathLabel(path, botId)
  return <aside className="bot-file-pane" aria-label={`File ${label}`}>
    <header className="bot-file-head">
      <span className="bot-file-name" title={path}>{label}</span>
      <button type="button" className="bot-file-button" title="Show in folder" aria-label="Show in folder" onClick={() => showInFolder(path)}><FolderOpen size={15} aria-hidden /></button>
      <button type="button" className="bot-file-button" title="Close" aria-label="Close file" onClick={onClose}><X size={15} aria-hidden /></button>
    </header>
    <div className="bot-file-body">{IMAGE_FILE.test(path) ? <ImagePreview path={path} /> : <TextPreview key={path} path={path} />}</div>
  </aside>
}
