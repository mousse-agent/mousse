import { useEffect, useState } from 'react'
import type { RemoteUpdateToast as Toast } from '../../../shared/remoteUpdates'
import { ToastView } from '../ui/Toast'

/** "Updating from Agigo in 10 s · Cancel", or, while more turns run than were confirmed, that it waits for them. */
export function remoteUpdateText(toast: Toast, now: number): string {
  if (toast.waiting) return `Updating from ${toast.from} when turns finish`
  const seconds = Math.max(0, Math.ceil((toast.installAt - now) / 1000))
  return seconds > 0 ? `Updating from ${toast.from} in ${seconds} s` : `Updating from ${toast.from}…`
}

export function RemoteUpdateToastView({ toast, now, onCancel }: { toast: Toast | null; now: number; onCancel: () => void }) {
  if (!toast) return null
  return (
    <ToastView
      message={remoteUpdateText(toast, now)}
      detail="Mousse stops here, with every turn and other Mousse homes sharing this install, and starts again on the new version."
      actions={[{ label: 'Cancel', dataAction: 'cancel', onClick: onCancel }]}
    />
  )
}

/** Another of the user's computers is updating this one: the countdown, in every window, with Cancel. */
export function RemoteUpdateToast() {
  const [toast, setToast] = useState<Toast | null>(null)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const updates = window.mousse?.updates
    if (!updates?.onRemoteToast) return
    let live = true
    void updates.remoteToast().then((current) => live && setToast(current), () => undefined)
    const off = updates.onRemoteToast((next) => setToast(next))
    return () => {
      live = false
      off()
    }
  }, [])
  useEffect(() => {
    if (!toast || toast.waiting) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(timer)
  }, [toast])
  return (
    <RemoteUpdateToastView
      toast={toast}
      now={now}
      onCancel={() => {
        if (!toast) return
        setToast(null)
        void window.mousse?.updates?.cancelRemote(toast.job)
      }}
    />
  )
}
