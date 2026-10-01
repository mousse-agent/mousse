export type ProfileErrorCode =
  | 'PROFILE_IDENTITY_INVALID'
  | 'PROFILE_NOT_FOUND'
  | 'PROFILE_REVISION_CONFLICT'
  | 'PROFILE_SLUG_CONFLICT'
  | 'PROFILE_PATH_INVALID'
  | 'PROFILE_OWNERSHIP'
  | 'PROFILE_STATE'
  | 'INSTALLATION_UNINITIALIZED'
  | 'MIGRATION_AMBIGUOUS'
  | 'MIGRATION_VALIDATION'
  | 'MIGRATION_FAULT'
  | 'MIGRATION_LEASE'

export class ProfileError extends Error {
  readonly code: ProfileErrorCode
  readonly details: Record<string, unknown>

  constructor(code: ProfileErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message)
    this.name = 'ProfileError'
    this.code = code
    this.details = details
  }
}

export class ProfileIdentityError extends ProfileError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super('PROFILE_IDENTITY_INVALID', message, details)
    this.name = 'ProfileIdentityError'
  }
}

export class ProfileNotFoundError extends ProfileError {
  constructor(profileRef: string, details: Record<string, unknown> = {}) {
    super('PROFILE_NOT_FOUND', `Profile not found: ${profileRef}`, { profileRef, ...details })
    this.name = 'ProfileNotFoundError'
  }
}

export class ProfileRevisionConflictError extends ProfileError {
  constructor(profileId: string, expectedRevision: number, actualRevision: number) {
    super('PROFILE_REVISION_CONFLICT', `Profile ${profileId} revision ${expectedRevision} is stale`, {
      profileId,
      expectedRevision,
      actualRevision
    })
    this.name = 'ProfileRevisionConflictError'
  }
}

export class ProfilePathError extends ProfileError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super('PROFILE_PATH_INVALID', message, details)
    this.name = 'ProfilePathError'
  }
}

export class ProfileOwnershipError extends ProfileError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super('PROFILE_OWNERSHIP', message, details)
    this.name = 'ProfileOwnershipError'
  }
}

export class MigrationAmbiguityError extends ProfileError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super('MIGRATION_AMBIGUOUS', message, details)
    this.name = 'MigrationAmbiguityError'
  }
}

export class MigrationValidationError extends ProfileError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super('MIGRATION_VALIDATION', message, details)
    this.name = 'MigrationValidationError'
  }
}
