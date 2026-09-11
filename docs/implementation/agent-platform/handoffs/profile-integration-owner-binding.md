# Profile integration owner binding

Root composition on reviewed MCP `feac07c`, channel/control `088ba64`, and browser
artifacts `76dbd6a` (integrated core `27ea4e3`). This work does not close P04 or G5.

`MmsProfileServices.beginShutdown()` now closes MCP, channel and control admission
in the same synchronous fence as personal RPCs, orchestrator turns, schedules,
native agents and processes. MCP shutdown starts concurrently with its consumers:
the manager retains raw discovery/connect/list/call/auth/close promises, including
connections completed after cancellation, so teardown need not wait for a caller
that itself needs transport closure to finish.

`finishStop()` uses permanent channel/control `shutdown()` rather than reversible
`stopAll()`/`stop()`, awaits all owner results, and rechecks actual activity before
stopping configuration watches or releasing the runtime. `mcpWork`, `channelWork`
and `controlWork` appear in the retained profile-busy inventory. Counts describe
ownership layers and may overlap (a control RPC also belongs to the request barrier).

The residual activity check protects the profile boundary when a service excludes
its recursive shutdown caller to avoid self-deadlock. Such an exclusion is not
permission to remove the profile while the caller can still write or send. Failed
or timed-out disposal keeps the same runtime and supports a later retry.

## Evidence

- `tests/platformProfileDrain.test.ts`: 14 tests passed, including two new cases.
- The new composition fixture uses actual profile services with held raw MCP
  discovery, a channel adapter close, and the registered control executor/RPC path.
  A removal deadline preserves the profile/runtime; all three reject new work;
  the other profile remains active; both final writes exist in trash only after
  every owner settles. No live MCP/channel/provider is contacted.
- A residual-owner fixture models a shutdown callback that excludes its caller
  and verifies that the final inventory prevents removal until a retry is idle.
- Both node and web TypeScript projects passed.
- CLI build passed after the test suites completed.
- Combined profile/MCP/channel drain qualification: 3 files, 44 tests passed,
  including actual owned stdio/process-tree and loopback webhook fixtures.

## Follow-up review boundaries

Root found two additional defects while composing the previously reviewed channel
slice. The assigned Sol reviewer owns their fixes separately: failed adapter close
was swallowed after deleting its retry owner; control/relay callbacks were started
before registration in their AsyncLocalStorage ownership context. They must be
merged and qualified with this composition before claiming the complete guarantee.

Browser backend/command/guest drain, full activity inventory for release UX,
cross-platform child-process containment, live gateway shutdown, and visible app
profile isolation remain separately tracked. This candidate still needs independent
review; fixture success is not full profile-release acceptance.
