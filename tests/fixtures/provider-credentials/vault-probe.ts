// Plain Node: the vault written by Electron must refuse to open here, and leave the file as it was.
import { probe, vaultArguments } from './vault-probe-checks'

const { phase, root } = vaultArguments(['node-reject'])
void probe(phase, root).catch((error) => { console.error(error); process.exitCode = 1 })
