// Canonical adapter lives in chat/adapters/mousseToUI.ts.
// This module re-exports it so legacy imports keep working without diverging.
export { mousseToUIMessages, chatStatusFromPhase, normalizeToolName } from '../../chat/adapters/mousseToUI'
