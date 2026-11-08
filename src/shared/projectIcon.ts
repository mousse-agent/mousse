/** A project's icon as the sidebar shows it: the image as a data URL, read and checked by the daemon. */
export interface ProjectIconImage {
  dataUrl: string
  /** `custom`: the file the user chose; `auto`: one found at a standard place in the project folder. */
  source: 'custom' | 'auto'
  /** The file, relative to the project folder when it is inside it, else absolute. */
  path: string
}

/** What a project shows: a found icon (`auto`), the user's file (`custom`), or always the folder glyph (`off`). */
export type ProjectIconChoice = { mode: 'auto' } | { mode: 'off' } | { mode: 'custom'; path: string }

/** The largest icon file read. */
export const PROJECT_ICON_MAX_BYTES = 512 * 1024

/** The image types the icon picker offers. */
export const PROJECT_ICON_EXTENSIONS = ['svg', 'png', 'ico', 'jpg', 'jpeg', 'webp', 'gif'] as const
