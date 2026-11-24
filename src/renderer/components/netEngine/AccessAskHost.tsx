import { useState } from 'react'
import type { AccessPresetFields } from '../../../shared/net/accessPresets'
import { errorText } from '../devices/useDaemonCall'
import { Modal } from '../ui/Modal'
import { AllowPrompt } from './AllowPrompt'
import { engineWay } from './engineRows'
import { useEngineStatus } from './useEngineStatus'
import '../../styles/settings.css'
import '../../styles/devices.css'
import './engine.css'

/**
 * A computer this one uses asks to use this one too (the other direction of a one-way pairing): the Allow prompt,
 * wherever this window is. Closed without an answer, it is set aside here and the request ends there on its own.
 */
export function AccessAskHost() {
  const { status, read } = useEngineStatus()
  const [setAside, setSetAside] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const ask = status?.on ? status.accessAsks?.find((item) => !setAside.includes(item.request)) : undefined
  const device = ask && status?.devices.find((item) => item.node === ask.node)
  if (!ask || !device) return null
  const close = () => {
    setError('')
    setSetAside((list) => [...list, ask.request])
  }
  const answer = async (yes: boolean, access?: AccessPresetFields) => {
    setBusy(true)
    setError('')
    try {
      await window.mousse.platformRequest.request('netEngine.access.answer', {
        node: device.node,
        request: ask.request,
        yes,
        ...(yes ? { access } : {})
      })
      close()
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      setBusy(false)
      read()
    }
  }
  return (
    <Modal open hideTitle className="access-ask-prompt" title={`Let ${device.name} use this computer?`} onClose={close}>
      {/* Outside Settings: its spacing and controls, as in Devices. */}
      <div className="settings-scope">
        <AllowPrompt
          key={ask.request}
          approval={device}
          busy={busy}
          line={`Connects over ${engineWay(device)}, already in use.`}
          onAnswer={(yes, access) => void answer(yes, access)}
        />
        {error && (
          <p role="alert" className="chat-error">
            {error}
          </p>
        )}
      </div>
    </Modal>
  )
}
