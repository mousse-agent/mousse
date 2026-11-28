import type { NetEngineDevice } from '../../shared/netEngine/local'
import { needsUpdateNotice } from '../components/netEngine/engineRows'
import { showToast, type ToastInput } from '../components/ui/Toast'
import { openDevice } from './settingsNavigation'

export interface VersionNoticeDeps {
  show: (input: ToastInput) => void
  /** Records that the notice showed, so no window shows it again until the refusal clears. */
  shown: (node: string) => Promise<unknown>
  open: (node: string) => void
}

const DEPS: VersionNoticeDeps = {
  show: (input) => void showToast(input),
  shown: (node) => window.mousse.platformRequest.request('netEngine.versionNotice.shown', { node }),
  open: openDevice
}

/** The refusals this window has told, so a read before the record comes back does not tell one twice. */
const toldHere = new Set<string>()

/**
 * The one notice for each device found cut off for its version (pair-with-IP design §5) that has not had it: the
 * daemon keeps that it showed until the refusal clears. Answers how many it showed.
 */
export function tellCutOff(
  devices: readonly NetEngineDevice[],
  deps: VersionNoticeDeps = DEPS,
  told: Set<string> = toldHere
): number {
  let shown = 0
  for (const device of devices) {
    const cutOff = device.needsUpdate
    if (!cutOff || cutOff.told || device.state === 'removing') continue
    const key = `${device.node} ${cutOff.since}`
    if (told.has(key)) continue
    told.add(key)
    deps.show({
      key: `needs-update-${device.node}`,
      tone: 'attention',
      message: needsUpdateNotice(device.name, cutOff.who),
      action: { label: 'Show', run: () => deps.open(device.node) }
    })
    void deps.shown(device.node).catch(() => undefined)
    shown++
  }
  return shown
}
