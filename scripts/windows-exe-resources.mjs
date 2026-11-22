// Windows names a program by the version resources in its exe (FileDescription in the firewall prompt and Task
// Manager; ProductName and CompanyName in its details) and shows the exe's first icon. A Rust exe has neither, and
// rcedit cannot add a version resource that is not there, so this writes both with resedit (plain JavaScript, so it
// also works for a helper built for Windows on another OS). Run it before anything signs the exe.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as ResEdit from 'resedit'

const ENGLISH_US = 1033
const UNICODE = 1200

/** The names the app's own exe carries, from package.json: `{ CompanyName, LegalCopyright, version }`. */
export function appIdentity(project) {
  const pkg = JSON.parse(readFileSync(join(project, 'package.json'), 'utf8'))
  const author = typeof pkg.author === 'string' ? pkg.author : pkg.author?.name
  return { CompanyName: author, LegalCopyright: pkg.build?.copyright, version: pkg.version }
}

/** The four numbers of a Windows file version: 0.1.4-nightly.20261120.128 gives [0, 1, 4, 0]. */
export function windowsVersionNumbers(version) {
  const numbers = /^(\d+)\.(\d+)\.(\d+)/.exec(version ?? '')
  return numbers ? [Number(numbers[1]), Number(numbers[2]), Number(numbers[3]), 0] : undefined
}

/**
 * Replaces `executable`'s icon with `icon` (an .ico) and its version resource with `strings` (empty values are left
 * out) and `version` as file and product version.
 */
export function stampWindowsExe(executable, { icon, strings = {}, version }) {
  const exe = ResEdit.NtExecutable.from(readFileSync(executable))
  const resources = ResEdit.NtExecutableResource.from(exe)
  const iconFile = ResEdit.Data.IconFile.from(readFileSync(icon))
  const groups = ResEdit.Resource.IconGroupEntry.fromEntries(resources.entries)
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(
    resources.entries,
    groups[0]?.id ?? 1,
    groups[0]?.lang ?? ENGLISH_US,
    iconFile.icons.map((item) => item.data)
  )
  const info = ResEdit.Resource.VersionInfo.createEmpty()
  info.lang = ENGLISH_US
  const numbers = windowsVersionNumbers(version)
  if (numbers) {
    info.setFileVersion(...numbers, ENGLISH_US)
    info.setProductVersion(...numbers, ENGLISH_US)
  }
  const values = Object.fromEntries(Object.entries(strings).filter(([, value]) => value))
  if (numbers) values.ProductVersion = version
  info.setStringValues({ lang: ENGLISH_US, codepage: UNICODE }, values)
  // Any earlier version resource (type 16) goes, whatever its language, so Windows reads this one.
  resources.entries = resources.entries.filter((entry) => entry.type !== 16)
  info.outputToResourceEntries(resources.entries)
  resources.outputResource(exe)
  writeFileSync(executable, Buffer.from(exe.generate()))
}
