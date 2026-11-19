import { useState, type FormEvent } from 'react'
import { useDaemonCall } from '../devices/useDaemonCall'

interface Resolved {
  routeId: string
  user: string
  hostname: string
  port: number
  pinned: boolean
}
interface Probe {
  keyType: string
  sha256: string
  inUserKnownHosts: boolean
}
interface Profiles {
  computer: string
  os: string
  profiles: Array<{ selector: string; label: string; networking: boolean; identity?: string }>
}

type Step =
  | { kind: 'target' }
  | { kind: 'key'; resolved: Resolved; probe: Probe }
  | { kind: 'profile'; resolved: Resolved; list: Profiles }
  | { kind: 'connecting'; resolved: Resolved }

/** What `newLabel` holds when the owner picks "New profile". */
const NEW = ''

/**
 * Add over SSH (1b §3.4): `user@host` or an alias, the host key's fingerprint to trust when the route has none,
 * the profile on the other computer (every one is listed, or a new one), then Connect. One way: this computer uses
 * the other one.
 */
export function SshAddSteps({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState<Step>({ kind: 'target' })
  const [target, setTarget] = useState('')
  const [choice, setChoice] = useState<string>()
  const [label, setLabel] = useState('')
  const { busy, error, call } = useDaemonCall()
  const host = (resolved: Resolved) => resolved.hostname

  const profiles = async (resolved: Resolved) => {
    const answer = await call<Profiles>('netEngine.ssh.profiles', {
      routeId: resolved.routeId,
      host: host(resolved),
      user: resolved.user
    })
    if (!answer) return
    setChoice(answer.value.profiles[0]?.selector ?? NEW)
    setStep({ kind: 'profile', resolved, list: answer.value })
  }

  const resolve = async (event: FormEvent) => {
    event.preventDefault()
    const answer = await call<Resolved>('netEngine.ssh.resolve', { target: target.trim() })
    if (!answer) return
    const resolved = answer.value
    if (resolved.pinned) return profiles(resolved)
    const probe = await call<Probe>('netEngine.ssh.probe', { routeId: resolved.routeId, host: host(resolved) })
    if (probe) setStep({ kind: 'key', resolved, probe: probe.value })
  }

  const trust = async (resolved: Resolved, probe: Probe) => {
    const done = await call('netEngine.ssh.trust', {
      routeId: resolved.routeId,
      sha256: probe.sha256,
      host: host(resolved)
    })
    if (done) await profiles(resolved)
  }

  const connect = async (resolved: Resolved) => {
    setStep({ kind: 'connecting', resolved })
    const done = await call('netEngine.ssh.connect', {
      routeId: resolved.routeId,
      target: target.trim(),
      host: host(resolved),
      user: resolved.user,
      ...(choice ? { selector: choice } : { newLabel: label.trim() || 'Mousse' })
    })
    if (done) onDone()
    else void profiles(resolved)
  }

  return (
    <div className="engine-ssh" data-step={step.kind}>
      {step.kind === 'target' && (
        <form className="engine-paste" onSubmit={(event) => void resolve(event)}>
          <input
            className="settings-input"
            value={target}
            autoFocus
            placeholder="user@host"
            aria-label="SSH address"
            title="Uses your SSH keys or agent, never a password."
            onChange={(event) => setTarget(event.target.value)}
          />
          <button type="submit" className="settings-btn" disabled={busy || !target.trim()}>
            Continue
          </button>
        </form>
      )}

      {step.kind === 'key' && (
        <div className="engine-confirm">
          <p>Trust {host(step.resolved)}?</p>
          <p
            className="settings-muted engine-fingerprint"
            title={
              step.probe.inUserKnownHosts
                ? 'Your known_hosts lists the same key. Check it on the other computer anyway.'
                : 'Check this matches the other computer’s SSH key.'
            }
          >
            {step.probe.keyType} {step.probe.sha256}
          </p>
          <div className="devices-dialog-actions">
            <button
              type="button"
              className="settings-btn primary"
              disabled={busy}
              onClick={() => void trust(step.resolved, step.probe)}
            >
              Trust
            </button>
          </div>
        </div>
      )}

      {step.kind === 'profile' && (
        <div className="engine-confirm">
          <fieldset className="engine-share" aria-label="Profile">
            <legend title={`This computer will use the profile you pick on ${step.list.computer}.`}>
              Profile on {step.list.computer}
            </legend>
            {step.list.profiles.map((profile) => (
              <label key={profile.selector} className="engine-share-item">
                <input
                  type="radio"
                  name="ssh-profile"
                  checked={choice === profile.selector}
                  onChange={() => setChoice(profile.selector)}
                />
                {profile.label}
              </label>
            ))}
            <label className="engine-share-item">
              <input
                type="radio"
                name="ssh-profile"
                checked={choice === NEW}
                onChange={() => setChoice(NEW)}
              />
              New profile
            </label>
            {choice === NEW && (
              <input
                className="settings-input"
                value={label}
                placeholder="Name"
                aria-label="New profile name"
                onChange={(event) => setLabel(event.target.value)}
              />
            )}
          </fieldset>
          <div className="devices-dialog-actions">
            <button
              type="button"
              className="settings-btn primary"
              disabled={busy}
              title={`${step.list.computer} won’t use this computer unless you add it there too.`}
              onClick={() => void connect(step.resolved)}
            >
              Connect
            </button>
          </div>
        </div>
      )}

      {step.kind === 'connecting' && (
        <p role="status" className="settings-muted">
          Adding {host(step.resolved)}…
        </p>
      )}

      {error && (
        <p role="alert" className="chat-error">
          {error}
        </p>
      )}
    </div>
  )
}
