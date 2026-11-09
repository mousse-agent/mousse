/**
 * A provider's own settings file, as Settings → Providers shows and edits it (Claude Code's
 * `settings.json` today). Secret values never leave the daemon: an entry holding one carries only
 * `masked` ("•••• 1a2b"), never `value`.
 */

/** Why an edit is refused when the file changed on disk after the page read it. */
export const VENDOR_SETTINGS_CHANGED = 'File changed, reload.'

export interface VendorSettingEntry {
  /** `model`, or `env.<NAME>` for a variable of the file's `env`. */
  key: string
  label: string
  secret: boolean
  /** The value, for a setting that is not secret. */
  value?: string
  /** "•••• 1a2b" (the last four characters at most), for a secret. */
  masked?: string
}

export interface VendorSettingsView {
  /** The file the provider reads, which edits are written to. */
  path: string
  /** The file is the user's own (shared with the terminal): an edit changes the CLI there too. */
  shared: boolean
  /**
   * A shared file only: the user already agreed, once for this file, that edits change their
   * terminal's Claude too. The service keeps that answer; until then it refuses an edit without it.
   */
  confirmed?: boolean
  exists: boolean
  /**
   * The file's contents as read, as an opaque tag (it says nothing about the values). An edit names
   * it, and the service refuses one made on a file that changed since.
   */
  revision?: string
  /** The settings found in the file that Mousse shows, in a fixed order. */
  entries: VendorSettingEntry[]
  /** Common settings the file does not have yet ("Add setting"). */
  addable: Array<{ key: string; label: string; secret: boolean }>
  /** The file is there but cannot be read as settings: nothing is shown or written. */
  error?: string
}

export interface SetVendorSettingInput {
  instanceId: string
  key: string
  /** Null removes the setting. */
  value: string | null
  /** The `revision` of the view the edit was made on. */
  expectedRevision: string
  /**
   * The user agreed, in this request, that edits of this shared file also change the CLI in their
   * terminal. The service remembers it for the file.
   */
  confirmShared?: boolean
}
