import { userAction, withUserRequest } from '../../src/mms/git/gitPolicy'

/**
 * Runs `work` as the button `label` runs it in the app: the protocol handler carries the person's request
 * (`USER_REQUEST_LABELS`), so the Git changes Undo, Redo, Revert, Publish and Discard changes make in their checkout are allowed.
 * Tests that call those services directly use this instead of the handler.
 */
export function pressed<T>(label: 'Undo' | 'Redo' | 'Revert' | 'Publish' | 'Discard changes', work: () => T): T {
  return withUserRequest(userAction('button', label), work)
}
