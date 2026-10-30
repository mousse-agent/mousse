import { AGENT_DEFINITION_SCHEMA_VERSION } from '../shared/agents/types'
import { BROWSER_CONTRACT_VERSION } from '../shared/browser/types'
import { EXECUTION_CONTRACT_VERSION } from '../shared/execution/types'
import { ENVELOPE_VERSION, NET_PROTO_MAJOR, NET_PROTO_MINOR } from '../shared/net/limits'
import { INSTALLATION_SCHEMA_VERSION, PROFILE_CONTRACT_VERSION } from '../shared/profiles/types'
import { RESOURCE_LIFECYCLE_VERSION } from '../shared/resourceLifecycle'
import { WORKFLOW_FORMAT_SCHEMA_VERSION } from '../shared/workflows/limits'
import { MOUSSE_CONF_VERSION } from './config/types'
import { MMS_OWNER_PROTOCOL_VERSION } from './ownership/MmsOwnerLease'
import { MMS_PROTOCOL_VERSION } from './protocol/types'
import { RUN_MIGRATIONS } from './run/db/migrations'

/**
 * The versions of what other processes, other machines and older or newer builds rely on: wire
 * protocols, saved formats and database schemas. The orchestrator and providers are
 * internal modules that ship together under the app version and have no version of their own.
 * Bump a contract only for an incompatible change; tests/contractVersions.test.ts lists these
 * values so a bump shows up in review. See docs/releases.md.
 */
export const CONTRACT_VERSIONS = {
  /** Local socket protocol between clients (GUI, CLI) and the daemon. */
  daemonProtocol: MMS_PROTOCOL_VERSION,
  /** The daemon's ownership lease file under MOUSSE_HOME. */
  daemonOwnerLease: MMS_OWNER_PROTOCOL_VERSION,
  /** Mousse Net wire protocol between installations, major.minor. */
  netProtocol: `${NET_PROTO_MAJOR}.${NET_PROTO_MINOR}`,
  netEnvelope: ENVELOPE_VERSION,
  /** Run Engine database schema: the newest migration. */
  runDatabase: RUN_MIGRATIONS[RUN_MIGRATIONS.length - 1]!.version,
  mousseConf: MOUSSE_CONF_VERSION,
  installation: INSTALLATION_SCHEMA_VERSION,
  profile: PROFILE_CONTRACT_VERSION,
  workflowFormat: WORKFLOW_FORMAT_SCHEMA_VERSION,
  agentDefinition: AGENT_DEFINITION_SCHEMA_VERSION,
  resourceLifecycle: RESOURCE_LIFECYCLE_VERSION,
  execution: EXECUTION_CONTRACT_VERSION,
  browserWorker: BROWSER_CONTRACT_VERSION
} as const
