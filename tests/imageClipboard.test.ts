/**
 * A picture the window draws reaches the clipboard through the window's `clipboard:writeImage` handler
 * (registerGuiIpc → writePngToClipboard in src/main/contextMenu.ts). Only PNG bytes the system can read are written;
 * anything else is refused and the clipboard is left alone. The real clipboard round trip, for every format and
 * address, is tests/renderer/image-clipboard-electron.test.ts.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

type Handler = (event: unknown, ...args: unknown[]) => unknown
const handlers = vi.hoisted(() => new Map<string, Handler>())
const electron = vi.hoisted(() => ({
  writeImage: vi.fn(),
  /** A picture the system reads, unless its bytes say otherwise. */
  createFromBuffer: vi.fn((bytes: Buffer) => ({ isEmpty: () => bytes.includes(0xee) }))
}))

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: Handler) => { handlers.set(channel, handler) }, removeHandler: () => undefined, on: () => undefined },
  BrowserWindow: { getAllWindows: () => [] },
  Notification: class {},
  app: { getPath: () => '', getVersion: () => '0.0.0', on: () => undefined },
  shell: {},
  dialog: {},
  clipboard: { writeImage: electron.writeImage },
  nativeImage: { createFromBuffer: electron.createFromBuffer },
  Menu: {},
  nativeTheme: { on: () => undefined },
  screen: { on: () => undefined, getAllDisplays: () => [], getPrimaryDisplay: () => ({}) },
  session: {},
  webContents: {}
}))

import { registerGuiIpc, type GuiIpcServices } from '../src/main/ipc/registerGuiIpc'
import { PresentationState } from '../src/main/mms/PresentationState'

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const png = (...rest: number[]) => new Uint8Array([...SIGNATURE, ...rest])
const writeImage = (bytes: unknown) => Promise.resolve().then(() => handlers.get('clipboard:writeImage')!({ sender: { id: 1 } }, bytes))

beforeAll(() => {
  const inert = (base: object = {}): object => new Proxy(base, { get: (target, key) => key in target ? (target as Record<PropertyKey, unknown>)[key] : () => undefined })
  const guiMms = { request: async () => ({}), runWithSender: (_sender: unknown, run: () => unknown) => run(), getCurrentSenderId: () => null, getWindowBindingForSender: () => undefined, getBaseBinding: () => undefined }
  registerGuiIpc({ guiMms: inert(guiMms), presentation: new PresentationState(), settings: inert(), browserView: inert(), repoRoot: '' } as unknown as GuiIpcServices, () => null)
})
beforeEach(() => { electron.writeImage.mockClear(); electron.createFromBuffer.mockClear() })

describe('clipboard:writeImage', () => {
  it('puts the PNG the window drew on the clipboard as a picture', async () => {
    await writeImage(png(1, 2, 3))
    expect([...electron.createFromBuffer.mock.calls[0][0]]).toEqual([...SIGNATURE, 1, 2, 3])
    expect(electron.writeImage).toHaveBeenCalledWith(electron.createFromBuffer.mock.results[0].value)
  })

  it('reads only the bytes the view covers, not the rest of its buffer', async () => {
    const buffer = new Uint8Array([9, 9, ...SIGNATURE, 4, 9])
    await writeImage(buffer.subarray(2, 11))
    expect([...electron.createFromBuffer.mock.calls[0][0]]).toEqual([...SIGNATURE, 4])
  })

  // Each is refused with the same words, and the clipboard keeps what it had.
  const refused: Array<[string, unknown]> = [
    ['nothing', undefined],
    ['a plain array of PNG bytes', [...SIGNATURE, 1]],
    ['no bytes', new Uint8Array()],
    ['bytes that are not a PNG (a GIF)', new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0])],
    ['a PNG the system cannot read', png(0xee)],
    ['a PNG over 64 MiB', (() => { const big = new Uint8Array(64 * 1024 * 1024 + 1); big.set(SIGNATURE); return big })()]
  ]
  it.each(refused)('refuses %s', async (_what, bytes) => {
    await expect(writeImage(bytes)).rejects.toThrow("This picture can't be copied.")
    expect(electron.writeImage).not.toHaveBeenCalled()
  })
})
