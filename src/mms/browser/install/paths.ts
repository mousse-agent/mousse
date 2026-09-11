import { join } from 'node:path'

export function versionsRoot(root: string): string { return join(root, 'versions') }
export function versionDir(root: string, platform: string, version: string): string { return join(versionsRoot(root), `${platform}-${version}`) }
export function activePointer(root: string): string { return join(root, 'active.json') }
export function lockDir(root: string): string { return join(root, '.mousse-install-lock') }
export function stagingRoot(root: string): string { return join(root, '.mousse-staging') }
export function metadataPath(root: string, platform: string, version: string): string { return join(versionDir(root, platform, version), 'mousse-browser.json') }
