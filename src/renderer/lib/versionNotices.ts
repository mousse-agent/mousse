import type { NetEngineDevice } from '../../shared/netEngine/local'
import { needsUpdateNotice } from '../components/netEngine/engineRows'
import { showToast } from '../components/ui/Toast'
import { openDevice } from './settingsNavigation'

/**
 * The one notice for each device found cut off for its version (pair-with-IP design §5) that has not had it. The
 * daemon grants one window the right to show each refusal's notice (`netEngine.versionNotice.claim`, keyed by when
 * the refusal was recorded), so it shows once, in one window, until that refusal clears.
 */
export function tellCutOff(devices: readonly NetEngineDevice[]): void {
  for (const device of devices) {
    const cutOff = device.needsUpdate
    if (!cutOff || cutOff.told || device.state === 'removing') continue
    void window.mousse.platformRequest
      .request<{ show?: boolean }>('netEngine.versionNotice.claim', { node: device.node, since: cutOff.since })
      .then((answer) => {
        if (!answer?.show) return
        showToast({
          key: `needs-update-${device.node}`,
          tone: 'attention',
          message: needsUpdateNotice(device.name, cutOff.who),
          action: { label: 'Show', run: () => openDevice(device.node) }
        })
      })
      .catch(() => undefined)
  }
}
