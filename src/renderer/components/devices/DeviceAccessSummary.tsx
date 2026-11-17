import { useEffect, useState } from 'react'
import { SettingsRow } from '../settings/SettingsRow'
import { accessHere, accessWords, isComputer, readAccessThere, type Device } from '../../lib/netDevices'
import { formatAgo } from '../../lib/formatAgo'
import type { BridgeAccessMine, BridgeAccessThere } from '../../../shared/net/local'

/** How often an open detail asks the other computer again. */
const RECHECK_MS = 30_000
/** The last answer each computer gave, kept for this window only: an offline one shows when it was last checked. */
const lastAnswers = new Map<string, { access: BridgeAccessMine; at: number }>()

const hereLine = (device: Device, switches: { workOnThreads: boolean; shareBots: boolean }) => {
  const here = accessHere(device, switches)
  if (here === undefined) return undefined
  if (here === 'not_connected') return <span title={`Connect ${device.name} here to let it do anything on this computer.`}>Nothing · not connected here</span>
  if (here === 'blocked') return <span title={`Every call from ${device.name} is refused here.`}>Nothing · blocked here</span>
  const words = accessWords(here, { phone: !isComputer(device) })
  return <span title={words.detail}>{words.line}</span>
}

const knownLine = (access: BridgeAccessMine, name: string) => {
  if (access.blocked) return <span title={`${name} refuses every call from this computer.`}>Nothing · blocked there</span>
  const words = accessWords(access)
  return <span title={words.detail}>{words.line}</span>
}

function thereLine(device: Device, answer: BridgeAccessThere | undefined, now: number) {
  if (!answer) return 'Checking…'
  if (answer.state === 'known') return knownLine(answer.access, device.name)
  if (answer.state === 'not_connected') return <span title={`${device.name} hasn't connected this computer.`}>Nothing · not connected there</span>
  if (answer.state === 'refused') return <span title={`${device.name} refused this computer the question: its grant there covers nothing.`}>Nothing</span>
  const last = lastAnswers.get(device.node)
  const why = answer.reason === 'older' ? `${device.name} runs an older version that can't tell.` : `${device.name} can't be reached now.`
  const before = last ? `\nLast answer: ${accessWords(last.access).line}` : ''
  return <span title={why + before}>{last ? `Unknown · last checked ${formatAgo(last.at, now)}` : 'Unknown'}</span>
}

/**
 * Two short rows in another device's detail: what this computer lets it do here (from this computer's own records),
 * and what that computer lets this one do there (its own answer to `bridge.access.mine`, asked while it is online).
 */
export function DeviceAccessSummary({ device, workOnThreads, shareBots }: { device: Device; workOnThreads: boolean; shareBots: boolean }) {
  const online = device.state === 'open'
  // A phone answers no call: only a computer can say what this one may do there.
  const asks = isComputer(device)
  const [answer, setAnswer] = useState<BridgeAccessThere>()
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!asks) return
    if (!online) { setNow(Date.now()); setAnswer({ state: 'unknown', reason: 'offline' }); return }
    let active = true
    const ask = () => {
      void window.mousse.platformRequest.request<BridgeAccessThere>('bridge.access.there', { node: device.node }).then(
        (value) => {
          if (!active) return
          const read = readAccessThere(value) ?? { state: 'unknown', reason: 'older' }
          if (read.state === 'known') lastAnswers.set(device.node, { access: read.access, at: Date.now() })
          setNow(Date.now())
          setAnswer(read)
        },
        () => { if (active) { setNow(Date.now()); setAnswer({ state: 'unknown', reason: 'offline' }) } }
      )
    }
    ask()
    const timer = setInterval(ask, RECHECK_MS)
    return () => { active = false; clearInterval(timer) }
  }, [asks, online, device.node])
  const here = hereLine(device, { workOnThreads, shareBots })
  return <>
    {here && <SettingsRow indent title="May do here" description={here} />}
    {asks && <SettingsRow indent title="This computer may do there" description={thereLine(device, answer, now)} />}
  </>
}
