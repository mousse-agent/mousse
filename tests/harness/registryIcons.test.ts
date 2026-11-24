/**
 * ACP registry icons: every icon the registry serves today is kept and drawn in the text colour;
 * a mark of several colours (a tile with a cut-out) is kept as an image, never flattened to a
 * square; anything that could run, load, link, animate or restyle is refused; icon URLs off the
 * registry's host are dropped; and the cache never reads or writes outside its folder.
 */
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { decodeAgent } from '../../src/mms/harness/agents/registry'
import { ICON_MAX_BYTES, RegistryIconCache, registryIconUrl, sanitizeRegistrySvg, svgDataUrl } from '../../src/mms/harness/agents/registryIcons'

/** The icons the registry served on 2026-11-24, byte for byte. */
const today = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'acp-registry-icons-2026-11-24.json'), 'utf8')) as { icons: Record<string, string> }

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const svg = (body: string, attrs = 'viewBox="0 0 16 16"') => `<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${body}</svg>`

describe('registry icon cleaning', () => {
  it("keeps every icon of today's registry as one ink, including ones with an XML declaration or a DOCTYPE", () => {
    const ids = Object.keys(today.icons)
    expect(ids.length).toBeGreaterThanOrEqual(46)
    for (const id of ids) expect(sanitizeRegistrySvg(Buffer.from(today.icons[id]!, 'utf8')), id).toMatchObject({ monochrome: true })
    // qoder starts with an XML declaration and an external DOCTYPE; both go, the mark stays.
    const qoder = sanitizeRegistrySvg(today.icons.qoder!)!
    expect(qoder.svg).toMatch(/^<svg /)
    expect(qoder.svg).not.toMatch(/DOCTYPE|<\?xml/)
  })

  // Rows: the icon, and whether it is one ink (drawn in the text colour) or several (an image).
  const inks: Array<[string, string, boolean]> = [
    ['currentColor fill', svg('<path fill="currentColor" d="M1 1h14v14H1z"/>'), true],
    ['currentColor stroke under fill="none"', svg('<circle cx="8" cy="8" r="7" stroke="currentColor"/>', 'viewBox="0 0 16 16" fill="none"'), true],
    ['no fill at all (default black)', svg('<path d="M1 1h14v14H1z"/>'), true],
    ['black and currentColor', svg('<path fill="#000" d="M1 1h4v4H1z"/><path fill="currentColor" d="M9 9h4v4H9z"/>'), true],
    ['one white mark', svg('<path fill="#fff" d="M1 1h14v14H1z"/>'), true],
    ['fill in a style attribute', svg('<path style="fill: currentColor" d="M1 1h14v14H1z"/>'), true],
    ['one brand colour', svg('<path fill="#4285F4" d="M1 1h14v14H1z"/>'), false],
    ['currentColor tile with a white cut-out', svg('<rect width="16" height="16" fill="currentColor"/><path fill="white" d="M4 4h8v8H4z"/>'), false],
    ['default-black tile with a white cut-out', svg('<rect width="16" height="16"/><path fill="#ffffff" d="M4 4h8v8H4z"/>'), false],
    ['two brand colours', svg('<path fill="#f00" d="M1 1h4v4H1z"/><path fill="rgb(0, 128, 0)" d="M9 9h4v4H9z"/>'), false]
  ]
  it.each(inks)('tells one ink from several: %s', (_name, icon, monochrome) => {
    expect(sanitizeRegistrySvg(icon)?.monochrome).toBe(monochrome)
  })

  // Rows: what an icon must never carry.
  const refused: Array<[string, string | Uint8Array]> = [
    ['larger than 32 KiB', svg(`<path d="M0 0${' L1 1'.repeat(ICON_MAX_BYTES / 5)}"/>`)],
    ['not UTF-8', Uint8Array.from([...Buffer.from('<svg xmlns="http://www.w3.org/2000/svg">'), 0xff, 0xfe, ...Buffer.from('</svg>')])],
    ['not an SVG', '<html><body><svg></svg></body></html>'],
    ['a script', svg('<script>alert(1)</script><path d="M0 0h1"/>')],
    ['a prefixed script', svg('<x:script xmlns:x="http://www.w3.org/2000/svg">alert(1)</x:script>')],
    ['an event handler', svg('<path d="M0 0h1"/>', 'viewBox="0 0 16 16" onload="alert(1)"')],
    ['an event handler on a shape', svg('<path onclick ="x()" d="M0 0h1"/>')],
    ['foreignObject', svg('<foreignObject><div>hi</div></foreignObject>')],
    ['an internal reference with use', svg('<path id="a" d="M0 0h1"/><use href="#a"/>')],
    ['an image', svg('<image href="https://example.com/x.png"/>')],
    ['a link', svg('<a href="#x"><path d="M0 0h1"/></a>')],
    ['a style sheet', svg('<style>path{fill:red}</style><path d="M0 0h1"/>')],
    ['animation', svg('<path d="M0 0h1"><animate attributeName="d" to="M1 1"/></path>')],
    ['set', svg('<path d="M0 0h1"><set attributeName="fill" to="red"/></path>')],
    ['a javascript: URL', svg('<path d="M0 0h1"/><title>javascript:alert(1)</title>')],
    ['a data: URL', svg('<path fill="red" d="M0 0h1"/><linearGradient href="data:image/svg+xml,x"/>')],
    ['url(…) paint', svg('<linearGradient id="g"><stop offset="0"/></linearGradient><path fill="url(#g)" d="M0 0h1"/>')],
    ['@import', svg('<path d="M0 0h1"/><title>@import "x"</title>')],
    ['an entity declaration', '<!DOCTYPE svg [<!ENTITY x "y">]><svg xmlns="http://www.w3.org/2000/svg"><text>&x;</text></svg>'],
    ['a character reference', svg('<text>&#106;avascript</text>')],
    ['a style sheet instruction', '<?xml-stylesheet href="https://example.com/x.css"?><svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1"/></svg>'],
    ['an external URL', svg('<path d="M0 0h1"/>', 'viewBox="0 0 16 16" xmlns:x="https://example.com/ns"')],
    ['an external href on an allowed element', svg('<linearGradient href="https://example.com/g.svg#a"/>')],
    ['CDATA', svg('<text><![CDATA[x]]></text>')]
  ]
  it.each(refused)('refuses %s', (_name, icon) => {
    expect(sanitizeRegistrySvg(icon)).toBeUndefined()
  })

  it('adds the SVG namespace an image needs, and makes a base64 data URL', () => {
    const icon = sanitizeRegistrySvg('<svg viewBox="0 0 16 16"><path d="M0 0h1"/></svg>')!
    expect(icon.svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox/)
    expect(svgDataUrl(icon.svg)).toMatch(/^data:image\/svg\+xml;base64,[A-Za-z0-9+/]+=*$/)
  })
})

describe('registry icon URLs', () => {
  const host = 'cdn.agentclientprotocol.com'
  const entry = (icon: unknown) => ({ id: 'demo', name: 'Demo', version: '1.0.0', icon, distribution: { npx: { package: 'demo@1.0.0' } } })

  it('keeps an HTTPS .svg on the registry host, and drops any other icon without dropping the agent', () => {
    expect(decodeAgent(entry(`https://${host}/registry/v1/latest/demo.svg`))?.icon).toBe(`https://${host}/registry/v1/latest/demo.svg`)
    for (const icon of [
      `http://${host}/registry/v1/latest/demo.svg`,
      'https://example.com/demo.svg',
      `https://user:pass@${host}/demo.svg`,
      `https://${host}/demo.png`,
      `https://${host}/demo.svg.png`,
      `https://${host}.example.com/demo.svg`,
      `https://${host}/${'a'.repeat(2_048)}.svg`,
      'data:image/svg+xml;base64,PHN2Zy8+',
      42
    ]) {
      const agent = decodeAgent(entry(icon))
      expect(agent?.id, String(icon)).toBe('demo')
      expect(agent?.icon, String(icon)).toBeUndefined()
    }
  })

  it('follows the host of a registry read from elsewhere', () => {
    expect(registryIconUrl('https://mirror.example/x.svg', 'mirror.example')).toBe('https://mirror.example/x.svg')
    expect(registryIconUrl(`https://${host}/x.svg`, 'mirror.example')).toBeUndefined()
  })
})

describe('the icon cache', () => {
  const cache = () => {
    const dir = mkdtempSync(join(tmpdir(), 'mousse-icons-'))
    dirs.push(dir)
    return { dir, icons: new RegistryIconCache(join(dir, 'icons')) }
  }

  it('stores a cleaned icon and reads it back as a data URL; a file changed on disk is checked again', () => {
    const { dir, icons } = cache()
    const icon = sanitizeRegistrySvg(today.icons.goose!)!
    expect(icons.write('goose', icon)).toBe(true)
    expect(icons.read('goose')).toEqual({ iconDataUrl: svgDataUrl(icon.svg), iconMonochrome: true })
    // Someone edits the cached file: what it now holds is checked like a download.
    writeFileSync(join(dir, 'icons', 'goose.svg'), svg('<script>alert(1)</script>'))
    expect(icons.read('goose')).toBeUndefined()
  })

  it('refuses ids that could leave the folder or name a device', () => {
    const { icons } = cache()
    for (const id of ['../x', 'a/b', 'a\\b', '.hidden', 'x..y', 'trailing.', 'con', 'NUL', 'Upper']) expect(icons.pathOf(id), id).toBeUndefined()
  })

  it('never reads or writes through a link in the icon folder', (context) => {
    const { dir, icons } = cache()
    const outside = join(dir, 'outside.svg')
    writeFileSync(outside, today.icons.goose!)
    mkdirSync(join(dir, 'icons'))
    try {
      symlinkSync(outside, join(dir, 'icons', 'goose.svg'), 'file')
    } catch {
      context.skip()
    }
    expect(icons.read('goose')).toBeUndefined()
    expect(icons.write('goose', sanitizeRegistrySvg(today.icons.kilo!)!)).toBe(false)
    // The file the link points at is untouched.
    expect(readFileSync(outside, 'utf8')).toBe(today.icons.goose)
    expect(lstatSync(join(dir, 'icons', 'goose.svg')).isSymbolicLink()).toBe(true)
  })
})
