import { useEffect, useId, useRef, useState } from 'react'
import { keyNameOf } from '../../../shared/automationKeys'
import { Modal } from '../ui/Modal'
import { errorText } from '../scheduled/scheduledLabels'

/**
 * Add key: a name and a masked value, sent once to the daemon, which keeps it in the profile's secret store. The value
 * is never shown again, never put in a prompt or a thread, and is dropped from this dialog when it closes. A name an
 * automation already asks for comes filled in (Needs you: "Add key GITHUB_TOKEN").
 */
export function KeyDialog({ name: fixedName, stored, onSave, onClose }: {
  /** The key a run asked for; its name cannot be changed here. */
  name?: string
  /** Names already in the store, to say that saving replaces one. */
  stored: readonly string[]
  onSave: (name: string, value: string) => Promise<void>
  onClose: () => void
}) {
  const [nameText, setNameText] = useState(fixedName ?? '')
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const valueRef = useRef<HTMLInputElement>(null)
  const ids = useId()
  const name = fixedName ?? keyNameOf(nameText)
  useEffect(() => { if (fixedName) valueRef.current?.focus() }, [fixedName])

  const save = async () => {
    if (!name || !value) return
    setBusy(true)
    setError(null)
    try {
      await onSave(name, value)
      setValue('')
      onClose()
    } catch (cause) {
      setError(errorText(cause))
      setBusy(false)
    }
  }

  return (
    <Modal
      open
      title={fixedName ? `Add key ${fixedName}` : 'Add key'}
      onClose={() => { if (!busy) { setValue(''); onClose() } }}
      closeDisabled={busy}
      footer={
        <>
          <button type="button" className="settings-btn" disabled={busy} onClick={() => { setValue(''); onClose() }}>Cancel</button>
          <button type="button" className="settings-btn primary" data-testid="key-save" disabled={busy || !name || !value} onClick={() => void save()}>Save key</button>
        </>
      }
    >
      <form className="automation-key-form" data-testid="key-dialog" onSubmit={(event) => { event.preventDefault(); void save() }}>
        {fixedName ? null : (
          <label className="automation-key-field" htmlFor={`${ids}-name`}>
            <span>Name</span>
            <input id={`${ids}-name`} className="scheduled-input mono" data-testid="key-name" placeholder="GITHUB_TOKEN" autoFocus value={nameText} onChange={(event) => setNameText(event.target.value)} />
          </label>
        )}
        <label className="automation-key-field" htmlFor={`${ids}-value`}>
          <span>Value</span>
          <input
            ref={valueRef}
            id={`${ids}-value`}
            className="scheduled-input mono"
            data-testid="key-value"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
        </label>
        <p className="scheduled-note">{name && stored.includes(name) ? `Replaces the stored ${name}.` : 'Kept in this profile’s secret store. Tools read it as ${secret:NAME}; it never goes in a prompt.'}</p>
        {nameText && !fixedName && !name ? <p className="scheduled-field-error" role="alert">A name is letters, digits and _, like GITHUB_TOKEN.</p> : null}
        {error ? <p className="scheduled-item-error" role="alert">{error}</p> : null}
      </form>
    </Modal>
  )
}
