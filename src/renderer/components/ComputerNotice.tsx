import { outdatedComputerName } from '../../shared/bridge/computerErrors'
import { openSettingsSection } from '../lib/settingsNavigation'
import { useComposerNotice, type ComposerNoticeProps } from './ComposerNotice'

/**
 * Why something did not go out, as the composer's notice. When the computer that runs the thread is too
 * old to do the action, it offers to open Devices, where its update steps are.
 */
export function computerNotice(message: string, onDismiss?: () => void): ComposerNoticeProps {
  const outdated = outdatedComputerName({ message })
  return {
    tone: 'error',
    title: message,
    ...(outdated ? { actions: [{ label: `Update ${outdated}…`, onClick: () => openSettingsSection('connections') }] } : {}),
    ...(onDismiss ? { onDismiss } : {})
  }
}

export function ComputerNotice({ message, onDismiss }: { message: string; onDismiss?: () => void }) {
  useComposerNotice(computerNotice(message, onDismiss))
  return null
}
