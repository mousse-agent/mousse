/**
 * Dependency-free scripts that speak the daemon protocol keep their own copy of its version: the
 * dev restart probe and the Linux and Windows package-qualification clients. Each must say the
 * version the daemon speaks, or the dev runner never restarts the daemon and qualification fails
 * at the hello.
 */
import { describe, expect, it } from 'vitest'
import { MMS_PROTOCOL_VERSION } from '../src/mms/protocol/types'
import { DAEMON_PROTOCOL_VERSION } from '../scripts/mms-dev-probe.mjs'
import { MMS_PROTOCOL_VERSION as LINUX_QUALIFICATION_VERSION } from '../scripts/qualification/linux/protocol-client.mjs'
import { PROTOCOL_VERSION as WINDOWS_QUALIFICATION_VERSION } from '../scripts/qualification/windows/windowsPackageQualification.mjs'

describe('protocol version copies in scripts', () => {
  it('match the daemon protocol', () => {
    expect(DAEMON_PROTOCOL_VERSION).toBe(MMS_PROTOCOL_VERSION)
    expect(LINUX_QUALIFICATION_VERSION).toBe(MMS_PROTOCOL_VERSION)
    expect(WINDOWS_QUALIFICATION_VERSION).toBe(MMS_PROTOCOL_VERSION)
  })
})
