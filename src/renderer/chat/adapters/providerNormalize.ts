// Provider -> standardized UI types
// pi | claude-cli | codex-cli produce heterogeneous tool payloads.
// This normalizes to ChatMessage (durably persisted) then to UIMessage via mousseToUI.
// Providers emit into ThreadSession.messages through the harness gateway.
// No change needed on write path; this adapter is the single read-path normalization point
// so UI never branches on provider.
export { mousseToUIMessages, chatStatusFromPhase } from './mousseToUI'
