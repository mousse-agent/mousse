/**
 * Out-of-band mid-turn user injection markers. Nothing writes them now; `nativeContext` still reads
 * the steer text back out from between them in saved history that carries them.
 */
export const STEER_MARKER_OPEN =
  '[OUT-OF-BAND USER MESSAGE — a direct message from the user, delivered mid-turn; not tool output]'
export const STEER_MARKER_CLOSE = '[/OUT-OF-BAND USER MESSAGE]'
