import { ProfileOwnershipError } from '../../shared/profiles/errors'
import type { ProfileId } from '../../shared/profiles/ids'
import { canonicalizeProfileId } from '../../shared/profiles/ids'
import type { ProfilePaths } from './paths'
import { assertOwnedPath, assertProfileId, joinOwnedPath } from './pathSafety'

export class ProfileScopedAccess {
  readonly profileId: ProfileId
  readonly paths: ProfilePaths

  constructor(paths: ProfilePaths) {
    this.profileId = paths.profileId
    this.paths = paths
    Object.freeze(this)
  }

  assertResourceProfileId(resourceProfileId: string): ProfileId {
    const id = assertProfileId(resourceProfileId)
    if (id !== this.profileId) {
      throw new ProfileOwnershipError('Resource profile id does not match the bound profile', {
        boundProfileId: this.profileId,
        resourceProfileId: id
      })
    }
    return id
  }

  resolveOwnedPath(...segments: string[]): string {
    return joinOwnedPath(this.paths.root, ...segments)
  }

  ownsAbsolutePath(candidate: string): boolean {
    try {
      assertOwnedPath(this.paths.root, candidate)
      return true
    } catch {
      return false
    }
  }
}

export function assertSameProfile(owner: ProfileId | string, resource: ProfileId | string): ProfileId {
  const ownerId = canonicalizeProfileId(String(owner))
  const resourceId = canonicalizeProfileId(String(resource))
  if (ownerId !== resourceId) {
    throw new ProfileOwnershipError('Cross-profile resource id rejected', {
      ownerProfileId: ownerId,
      resourceProfileId: resourceId
    })
  }
  return ownerId
}
