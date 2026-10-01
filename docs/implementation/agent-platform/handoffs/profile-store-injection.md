# Explicit storage roots (P01 continuation)

Root implementation; this is a prerequisite to production profile composition, not activation of the profile switcher.

Config loading no longer changes process environment. Project, thread, active selection, channel, scheduled job/runtime/lock/heartbeat, provider authentication and line edit stores capture explicit roots. Config preserves unknown top-level keys. Channel environment credentials are captured at construction and can be disabled for new profiles. Legacy repository transcript discovery is explicitly suppressible; profile composition must set `allowLegacyProjectData: false` after Default migration. Thread/repository path identities reject traversal and Windows reserved names.

The existing MMS constructor passes its installation root explicitly, preserving current behavior. It still uses one owner lease. Personal service composition, config section split, profile protocol binding, renderer state partitioning, remaining ambient services, and migration activation are pending; no second MMS owner or mutable active-profile environment has been introduced.

Validation: 60 tests in profile store injection, thread storage migration/mutation, channels and scheduled jobs passed. Type checks passed. The subsequent captured-environment regression is included in the focused follow-up run. All tests use temporary roots and fixture credentials, without live accounts/channels.
