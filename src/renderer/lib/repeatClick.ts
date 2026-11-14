/**
 * Whether a click is the second (or later) click of a double click. A decision that opens under the pointer (the
 * browser's access bar opened by its switch, the permission menu opened by its chip) ignores it: the person aimed the
 * double click at whatever was drawn there before, which a theme may have placed as a decoy. A single click, the
 * keyboard and a scripted click are never repeats.
 */
export function isRepeatClick(event: { detail: number }): boolean {
  return event.detail > 1
}
