import { useCallback, useEffect, useRef, useState } from 'react'
import type { EditorSshProblemCode, EditorSshResult, EditorSshStatus } from '../../shared/net/local'
import type { PlatformRequestMethod } from '../../shared/platform'
import { EDITOR_PROXY_READY } from '../../shared/remoteEditor'

/**
 * Mousse's SSH settings for editors, as the window shows them: the one-time notice after the `Include`
 * line was added, and the Settings switch that undoes it. The daemon does the work (`net.editor.ssh.*`).
 */

/** The reason Mousse could not set up, in plain words, with the exact line to add by hand where that helps. */
export function editorSshProblemWords(
  problem: { code: EditorSshProblemCode | string; message: string },
  includeLine?: string,
  userConfig = '~/.ssh/config'
): string {
  const byHand = includeLine ? ` To add it yourself, put this line at the very top of ${userConfig}: ${includeLine}` : ''
  switch (problem.code) {
    case 'unwritable':
      return `${userConfig} is read-only for this account, so Mousse left it alone.${byHand}`
    case 'not_owner':
      return `${userConfig} belongs to another account, so Mousse left it alone.${byHand}`
    case 'ssh_check_failed':
      return `The ssh on this computer could not read the settings Mousse wrote, so Mousse left ${userConfig} as it was.${includeLine ? ` The line it would add is: ${includeLine}` : ''}`
    case 'no_ssh':
      return `Mousse could not find ssh on this computer, so it left ${userConfig} alone. Install an SSH client, then try again.`
    default:
      // Off, scoped and the rest already say what to do.
      return problem.message
  }
}

/**
 * Whether Settings shows the Editors group. Until editor connections exist (`EDITOR_PROXY_READY`) the line
 * serves nothing, so the group is there only while the line is installed or its notice is pending: it is
 * where Undo is, and Undo is final.
 */
export function editorSshVisible(status: EditorSshStatus | null): status is EditorSshStatus {
  return !!status?.available && (status.included || status.noticePending || EDITOR_PROXY_READY)
}

/** The state the Settings switch shows, and what the switch does. */
export function editorSshSwitch(status: EditorSshStatus): { on: boolean; disabled: boolean; description: string } {
  const where = status.userConfig || '~/.ssh/config'
  if (!status.available) return { on: false, disabled: true, description: 'Not available in this build.' }
  if (status.included) {
    const detail = status.edited
      ? ` You changed the line, so Mousse cannot remove it: delete it from ${where} yourself.`
      : status.scoped
        ? ` The line is below a Host or Match line, so ssh reads it for that block only: move it to the top of ${where}.`
        : ''
    return {
      on: status.enabled,
      disabled: false,
      description: `On · ${where} includes ${status.mousseConfig ? 'Mousse’s SSH settings' : 'Mousse’s file'}, so your editor can reach your other computers.${detail}`
    }
  }
  if (!status.enabled) {
    return { on: false, disabled: false, description: `Off · Mousse added nothing to ${where}. Turn it on to let your editor reach your other computers by name.` }
  }
  return { on: false, disabled: false, description: `Mousse adds one Include line to ${where} the first time you open a folder of another computer in your editor.` }
}

interface Calls {
  request: <T>(method: PlatformRequestMethod, params: unknown) => Promise<T>
}

/** `net.editor.ssh.status` and the actions on it. Failures to read count as unavailable. */
export function useEditorSsh(calls?: Calls) {
  const request: Calls['request'] = calls?.request ?? ((method, params) => window.mousse.platformRequest.request(method, params))
  const requestRef = useRef(request)
  requestRef.current = request
  const [status, setStatus] = useState<EditorSshStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])

  const reload = useCallback(async () => {
    try {
      const next = await requestRef.current<EditorSshStatus>('net.editor.ssh.status', {})
      if (alive.current) setStatus(next)
    } catch {
      /* Keep what is shown. */
    }
  }, [])
  useEffect(() => { void reload() }, [reload])
  // An open in the side card may have added the line; the window coming back to the front reads it again.
  useEffect(() => {
    const onFocus = () => { void reload() }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [reload])

  const act = useCallback(async (method: PlatformRequestMethod): Promise<EditorSshResult | undefined> => {
    setBusy(true)
    setError('')
    try {
      const result = await requestRef.current<EditorSshResult | EditorSshStatus>(method, {})
      if (!alive.current) return undefined
      const status = 'status' in result ? result.status : result
      setStatus(status)
      if ('ok' in result && !result.ok) setError(editorSshProblemWords(result, result.status.includeLine, result.status.userConfig))
      return 'ok' in result ? result : undefined
    } catch (cause) {
      if (alive.current) setError(String((cause as Error)?.message ?? cause))
      return undefined
    } finally {
      if (alive.current) setBusy(false)
    }
  }, [])

  return {
    status,
    busy,
    error,
    reload,
    /** Undo: removes Mousse's line from `~/.ssh/config` and turns the feature off. */
    disable: () => act('net.editor.ssh.disable'),
    /** Turns it on again and adds the line. */
    enable: () => act('net.editor.ssh.enable'),
    /** The notice was seen. */
    acknowledge: () => act('net.editor.ssh.ack')
  }
}
