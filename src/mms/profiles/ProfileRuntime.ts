import type { ProfileBinding, ProfileRecord } from '../../shared/profiles/types'
import { ProfileScopedAccess } from './ownership'
import type { InstallationPaths, ProfilePaths } from './paths'

export class ProfileRuntime {
  readonly binding: ProfileBinding
  readonly record: ProfileRecord
  readonly paths: ProfilePaths
  readonly installation: InstallationPaths
  readonly access: ProfileScopedAccess

  constructor(args: {
    binding: ProfileBinding
    record: ProfileRecord
    paths: ProfilePaths
    installation: InstallationPaths
  }) {
    this.binding = Object.freeze({ ...args.binding })
    this.record = Object.freeze({
      ...args.record,
      ...(args.record.appearanceSeed
        ? { appearanceSeed: Object.freeze({ ...args.record.appearanceSeed }) }
        : {})
    })
    this.paths = args.paths
    this.installation = args.installation
    this.access = new ProfileScopedAccess(args.paths)
    Object.freeze(this)
  }
}
