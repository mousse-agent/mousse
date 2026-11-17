import { expect, it, vi } from 'vitest'
import { appPresence } from '../src/main/mms/appPresence'
it('only reports negotiated focused non-idle windows, once a minute per profile and service', () => {
  let now = 100_000, focused = false, idle = 0, audience: string | undefined
  const send = vi.fn(async () => {})
  const tick = appPresence({ windows: () => [1, 2].map(id => ({ isDestroyed: () => false, isFocused: () => focused, webContents: { id } })),
    idleSeconds: () => idle, audience: () => audience, send, clock: () => now, zone: () => 'Asia/Kolkata' })
  tick(); focused = true; tick(); expect(send).not.toHaveBeenCalled()
  audience = 'service:profile'; idle = 60; tick(); expect(send).not.toHaveBeenCalled()
  idle = 0; tick(); tick(); expect(send).toHaveBeenCalledExactlyOnceWith(1, { activeAt: now, timeZone: 'Asia/Kolkata' })
  now += 60_000; focused = false; tick(); expect(send).toHaveBeenCalledTimes(1)
  focused = true; tick(); expect(send).toHaveBeenCalledTimes(2)
  audience = 'new-service:profile'; tick(); expect(send).toHaveBeenCalledTimes(3)
})
