import { homedir } from 'os'
import { join } from 'path'

export function resolveMousseHome(homeFlag?: string): string {
  if (homeFlag) {
    process.env.MOUSSE_HOME = homeFlag
    return homeFlag
  }
  return process.env.MOUSSE_HOME ?? join(homedir(), '.mousse')
}

export function getMousseConfPath(homeDir: string): string {
  return join(homeDir, 'mousse.conf')
}

export function getMmsPidPath(homeDir: string): string {
  return join(homeDir, 'mms.pid')
}

export function getAuthPath(homeDir: string): string {
  return join(homeDir, 'auth.json')
}
