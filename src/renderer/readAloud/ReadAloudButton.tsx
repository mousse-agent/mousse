import { Loader2, Stop, VolumeHigh } from '../lib/icons'
import { cn } from '../chat/components/agent-elements/utils/cn'
import { useReadAloudStore } from './readAloudStore'

/** True while the message with this key is loading or playing. */
export function useIsReadingAloud(speechKey: string | undefined): boolean {
  return useReadAloudStore((state) => speechKey !== undefined && state.activeKey === speechKey && state.status !== 'idle')
}

export function ReadAloudButton({ speechKey, markdown }: { speechKey: string; markdown: string }) {
  const status = useReadAloudStore((state) => (state.activeKey === speechKey ? state.status : 'idle'))
  const error = useReadAloudStore((state) => (state.error?.key === speechKey ? state.error.message : null))
  const toggle = useReadAloudStore((state) => state.toggle)
  const active = status !== 'idle'
  const label = active ? 'Stop reading' : 'Read aloud'
  const iconClass = 'w-3.5 h-3.5 text-an-foreground-muted'

  return (
    <button
      type="button"
      tabIndex={-1}
      title={error ?? (status === 'loading' ? 'Loading voice, click to stop' : label)}
      aria-label={label}
      aria-busy={status === 'loading' || undefined}
      data-read-aloud={status}
      onClick={() => toggle(speechKey, markdown)}
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      className={cn(
        'size-6 flex items-center justify-center rounded-md active:scale-[0.97] transition-[background-color,opacity,transform] duration-150 ease-out',
        'opacity-50 bg-transparent hover:opacity-100 hover:bg-an-foreground/10',
        (active || error) && 'opacity-100'
      )}
    >
      {status === 'loading' ? (
        <Loader2 className={cn(iconClass, 'animate-spin')} />
      ) : status === 'playing' || status === 'paused' ? (
        <Stop className={iconClass} />
      ) : (
        <VolumeHigh className={iconClass} />
      )}
    </button>
  )
}
