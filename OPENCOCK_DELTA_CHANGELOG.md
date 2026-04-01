# OpenCock Delta Changelog

This file tracks intentional OpenCock divergence from upstream OpenClaw.

It is not the upstream release changelog. Use it to answer two questions quickly:

1. What behavior in this fork is intentionally different from OpenClaw?
2. Which source files own that divergence today?

## Baseline

- Upstream source of truth: `https://github.com/openclaw/openclaw`
- Fork source of truth: `https://github.com/future3OOO/opencock`
- Recommended local remotes:
  - `origin` -> `future3OOO/opencock`
  - `upstream` -> `openclaw/openclaw`

## Maintenance Rules

- Update this file in every PR that introduces or retires fork-only behavior.
- Reference the exact source files that now own the behavior.
- If behavior still lives outside fork source, record it under `External custom surfaces`.
- When a fork-only behavior is upstreamed or deleted, add a retirement entry instead of silently removing history.

## Useful Comparison Commands

```bash
git fetch upstream
git log --left-right --cherry-pick --oneline upstream/main...HEAD
git diff --stat upstream/main...HEAD
```

## Current Delta Areas

### Engine / Runtime

- Mission/delegation completion state is projected into canonical session state in source instead of relying on patched dist-only runtime behavior.
- Mission wake dispatch is handled in source gateway hooks instead of via heartbeat fallbacks.
- Session records now carry mission-awareness fields used by orchestration follow-up flows.
- The native runtime now owns the generic orchestration bridge lifecycle for `prepare`, `commit`, `complete`, `heartbeat`, and canonical mission-status queries.

### External Custom Surfaces Still To Be Migrated

- The broader workspace-side delegation/orchestration layer is still partly owned by workspace Python under `skills/clawbot-autoresearch/scripts/*`.
- Workspace doctrine, memory, continuity export, and SkillOps/autoresearch policy remain workspace-owned by design.
- Managed hooks under the runtime state tree still exist as part of the live system and will be retired or thinned as source ownership expands.

## Entries

### 2026-04-01

#### Source-owned mission-wake bundled hook promotion

Promoted mission wake from a managed state-tree hook into bundled OpenCock source hook infrastructure.

- Added source-owned mission-wake runtime/global seam in:
  - `src/gateway/mission-wake-runtime.ts`
- Added bundled hook metadata and handler in:
  - `src/hooks/bundled/mission-wake/HOOK.md`
  - `src/hooks/bundled/mission-wake/handler.ts`
  - `src/hooks/bundled/mission-wake/handler.test.ts`
- Rebased source gateway hook runtime registration in:
  - `src/gateway/server/hooks.ts`
  - `src/hooks/bundled/README.md`

Behavior change:

- `agent:mission:completed` and `gateway:startup` are now handled by a bundled source hook instead of depending on `~/.openclaw/hooks/mission-wake/*`
- source gateway runtime exposes the mission-wake dispatcher/recovery seam once, and the bundled hook invokes it through source-owned runtime registration
- restart recovery and pending mission replay now remain part of maintained fork source instead of a managed-hook-only deployment detail

Why this fork-only:

- the live system had critical orchestration behavior trapped in managed hook state outside the fork source tree
- this slice makes mission wake part of the engine/runtime product instead of local state glue

#### Source-owned direct-session context and Claude project memory sync

Promoted the remaining direct-session continuity/mission-context injection seam out of patched `reply` dist and into OpenCock source.

- Added source-owned direct-session bootstrap context in:
  - `src/orchestration/direct-session-context.ts`
  - `src/orchestration/direct-session-context.test.ts`
- Threaded direct-session mission-context clearing through the CLI runner in:
  - `src/agents/cli-runner/prepare.ts`
  - `src/agents/cli-runner.ts`
  - `src/agents/cli-runner/types.ts`
  - `src/agents/cli-runner.test-support.ts`
  - `src/agents/cli-runner.direct-session-context.test.ts`
- Added source-owned Claude project `MEMORY.md` sync for resumed Claude Code sessions in:
  - `src/agents/cli-runner/claude-project-memory.ts`
  - `src/agents/cli-runner/claude-project-memory.test.ts`

Behavior change:

- direct-session CLI runs now inject a runtime-built bootstrap context containing:
  - continuity summary
  - active mission state
  - unread mission results
  - recent recovered direct conversation
- unread mission events are marked seen in source when that runtime context is injected
- pending mission notifications are cleared in source after a successful direct-session reply that consumed the context
- Claude Code sessions now get the same runtime direct-session context synced into the Claude project `MEMORY.md` path from maintained source, so resumed sessions do not depend on dist-only memory mirror hacks
- the source runtime path contains no hardcoded legacy `Daddy` direct-session doctrine

Why this fork-only:

- the live system’s direct-session continuity and mission-context behavior had been trapped in patched `reply` dist logic
- this slice rehomes the necessary mechanics into maintained fork source without carrying forward the stale doctrine text or worker-registry dependency

#### Source-owned external task registration for quarantined workspace work

Promoted the session-separation quarantine registration seam into OpenCock source so externally parked work can be tracked in the canonical task ledger instead of the legacy Python worker registry.

- Added source-owned external task registration in:
  - `src/orchestration/external-runtime.ts`
  - `src/orchestration/external-runtime.test.ts`
- Extended the native orchestrator CLI in:
  - `src/cli/program/register.orchestrator.ts`
  - `src/cli/program/register.orchestrator.test.ts`

Behavior change:

- `openclaw orchestrator register-external` now registers parked/quarantined work as a native `cli` task record owned by the requester session
- externally parked work is marked `lost` in the canonical task ledger immediately, with worktree/branch/artifact context preserved in the runtime task metadata
- this creates a native runtime seam for `session_separation.py` and similar tooling to stop calling `worker_registry.upsert_worker(...)` for generic quarantined work

Why this fork-only:

- the live system currently parks dirty workspace work by synthesizing legacy worker-registry records from workspace Python
- this slice moves that generic lifecycle truth into maintained runtime source so the remaining Python layer can shrink to a compatibility adapter

#### Source-owned orchestration runtime config and continuity freshness slice

Promoted the remaining generic orchestration config/defaults and direct-session continuity thresholds out of workspace Python and into OpenCock source.

- Added source-owned orchestration runtime config in:
  - `src/orchestration/runtime-config.ts`
  - `src/orchestration/runtime-config.test.ts`
- Threaded the source-owned config into the native control plane in:
  - `src/orchestration/control-plane.prepare.ts`
  - `src/orchestration/control-plane.shared.ts`
  - `src/orchestration/control-plane.lifecycle.ts`
  - `src/orchestration/service.ts`
- Extended runtime session schema and coverage in:
  - `src/config/sessions/types.ts`
  - `src/orchestration/control-plane.test.ts`
  - `src/orchestration/service.test.ts`

Behavior change:

- native orchestration now owns the default config for:
  - enabled channels
  - direct-session orchestrator mode
  - spawn-suppression cooldown
  - direct-session continuity thresholds
  - cleanup / heartbeat / retry defaults
- source runtime now reads the legacy workspace `skills/clawbot-autoresearch/runtime.json` only as a temporary compatibility overlay instead of leaving those defaults authoritative in Python
- `prepare` now evaluates direct-session continuity freshness in source and resets stale continuity state without relying on `mission_router.py`
- `delegate`, `delegate-explicit`, and `commit` suppression now use the source-owned cooldown config instead of a hardcoded Python default
- session records now carry explicit continuity freshness reset metadata:
  - `freshnessResetAt`
  - `freshnessResetReasons`

Why this fork-only:

- the live system’s orchestration enablement and direct-session freshness policy were still trapped in workspace Python under `mission_router.py` / `common.py`
- this slice keeps the compatibility overlay for now, but moves the engine-owned defaults and reset behavior into maintained fork source

### 2026-03-31

#### Source-owned orchestration command and session lifecycle slice

Moved the first real delegation/control-plane slice out of workspace Python and patched dist into OpenCock source.

- Added native orchestration service and session-binding helpers in:
  - `src/orchestration/service.ts`
  - `src/orchestration/session-state.ts`
  - `src/orchestration/service.test.ts`
- Added source-owned CLI entrypoints in:
  - `src/cli/program/register.orchestrator.ts`
  - `src/cli/program/register.orchestrator.test.ts`
  - `src/cli/program/command-registry.ts`
  - `src/cli/program/command-registry.test.ts`
  - `src/cli/program/core-command-descriptors.ts`
- Added orchestration metadata persistence in:
  - `src/tasks/task-registry.types.ts`
  - `src/tasks/task-registry.ts`
  - `src/tasks/task-registry.store.sqlite.ts`
  - `src/tasks/task-executor.ts`
  - `src/agents/subagent-spawn.ts`
  - `src/agents/subagent-registry.ts`
  - `src/agents/subagent-registry-run-manager.ts`

Behavior change:

- `openclaw orchestrator delegate|delegate-many|status|list|cancel` now has a source-owned implementation
- direct delegation now uses the native subagent spawn path instead of the patched `dist` bridge
- canonical task records now carry orchestration mission metadata:
  - mission/source id
  - worker id
  - routing class
  - originating surface
  - status summary
- requester session state now binds active mission / focused worker in source-owned session helpers
- terminal mission projection now clears that active binding from source task lifecycle transitions

Why this fork-only:

- the live system has a custom delegation/orchestration loop that upstream OpenClaw does not currently own
- this slice starts moving that truth into maintained fork source instead of leaving core control flow split across workspace Python and patched runtime output

#### Source-owned mission-router engine primitives and duplicate suppression slice

Promoted the first engine-owned `mission_router.py` behavior into OpenCock source instead of leaving it in workspace Python.

- Added source-owned orchestration primitives in:
  - `src/orchestration/runtime-primitives.ts`
  - `src/orchestration/runtime-primitives.test.ts`
- Extended native orchestration delegation in:
  - `src/orchestration/service.ts`
  - `src/orchestration/service.test.ts`
- Extended canonical task persistence for duplicate suppression in:
  - `src/tasks/task-registry.types.ts`
  - `src/tasks/task-registry.ts`
  - `src/tasks/task-registry.store.sqlite.ts`
  - `src/tasks/task-registry.store.test.ts`
  - `src/tasks/task-executor.ts`
  - `src/agents/subagent-spawn.ts`
  - `src/agents/subagent-registry.ts`
  - `src/agents/subagent-registry-run-manager.ts`

Behavior change:

- direct orchestration now computes deterministic mission labels and suppression keys in source
- native delegation suppresses duplicate worker spawns against matching active or recent cooldown-bound tasks using canonical task state
- orchestrator status/list flows now continue to rely on source-owned task mission metadata instead of workspace Python worker records for this slice
- canonical task storage now persists orchestration duplicate-suppression metadata across sqlite restore cycles

Why this fork-only:

- the live system’s duplicate delegation protection was still trapped in workspace Python under `mission_router.py` / `dispatch.py`
- this slice starts retiring that split authority from the engine path by moving generic orchestration lifecycle semantics into maintained fork source

#### Source-owned mission completion projection

Moved the first orchestration slice from patched runtime output into OpenCock source.

- Added canonical mission/session projection in:
  - `src/tasks/task-registry-mission-runtime.ts`
  - `src/tasks/task-registry-mission-runtime.test.ts`
- Added session-owned mission awareness fields in:
  - `src/config/sessions/types.ts`
- Added runtime installation of the task-registry mission hooks in:
  - `src/gateway/server-runtime-state.ts`

Behavior change:

- terminal delegated task completions for requester-visible sessions now persist:
  - `lastDeliveredMission`
  - `recentMissionEvents`
  - `pendingMissionNotifications`
  - `continuitySummary`
- the canonical task lifecycle now emits `agent:mission:completed` from source

Why this fork-only:

- the live OpenCock deployment had been depending on local patched `dist` behavior for mission awareness and completion follow-up
- this change promotes that behavior into maintained fork source

#### Source-owned mission wake dispatch path

Moved mission-wake dispatch semantics into source gateway hooks.

- Extended hook dispatch payload in:
  - `src/gateway/hooks.ts`
- Added mission-wake dispatch/recovery logic in:
  - `src/gateway/server/hooks.ts`
- Added gateway coverage in:
  - `src/gateway/server.hooks.test.ts`

Behavior change:

- mission wakes now dispatch through source-owned gateway hook flow
- mission-wake runs carry the requester `sessionKey` through to delivery resolution
- pending mission notifications are only cleared after a successful delivered wake run
- undelivered mission wakes no longer enqueue fallback hook spam into the main session

Why this fork-only:

- the live system required source-owned orchestration semantics that upstream OpenClaw does not currently provide

#### Source-owned orchestration bridge lifecycle slice

Promoted the remaining generic `dispatch.py` bridge lifecycle into OpenCock source so the runtime, not workspace Python, owns the core mission control plane.

- Added source-owned orchestration control-plane modules in:
  - `src/orchestration/control-plane.ts`
  - `src/orchestration/control-plane.test.ts`
  - `src/orchestration/policy.ts`
  - `src/orchestration/format.ts`
- Extended source CLI entrypoints in:
  - `src/cli/program/register.orchestrator.ts`
  - `src/cli/program/register.orchestrator.test.ts`
- Slimmed native orchestration service duplication by reusing source formatting helpers in:
  - `src/orchestration/service.ts`

Behavior change:

- `openclaw orchestrator` now owns source implementations for:
  - `prepare`
  - `delegate-explicit`
  - `commit`
  - `complete`
  - `heartbeat`
  - `query-status`
- native orchestration `prepare` now classifies direct-session requests, handles continuation binding, and produces canonical delegate plans in source
- native orchestration `commit` now persists externally spawned delegated workers into the canonical task registry and session binding model
- native orchestration `heartbeat` and `complete` now update canonical task/session state directly instead of depending on workspace Python worker-registry truth
- canonical mission-status queries now resolve against source task records for this generic lifecycle slice

Why this fork-only:

- the live system’s broader orchestration bridge was still authoritative in workspace Python under `dispatch.py` / `dispatch_bridge.py`
- this slice moves the generic engine lifecycle into maintained fork source while leaving tenant-specific autoresearch and Instagram policy in the workspace for now

#### Reconciled orchestration task view and runtime continuity capsule slice

Moved another chunk of generic worker-registry/session-store authority out of workspace Python and into OpenCock source.

- Added source-owned continuity capsule builder in:
  - `src/orchestration/continuity-capsule.ts`
- Extended runtime session schema and mission-binding logic in:
  - `src/config/sessions/types.ts`
  - `src/orchestration/session-state.ts`
  - `src/tasks/task-registry-mission-runtime.ts`
  - `src/tasks/task-registry-mission-runtime.test.ts`
- Switched orchestration read paths onto the reconciled native task view in:
  - `src/orchestration/control-plane.shared.ts`
  - `src/orchestration/control-plane.lifecycle.ts`
  - `src/orchestration/service.ts`
  - `src/orchestration/service.test.ts`
  - `src/orchestration/control-plane.test.ts`

Behavior change:

- session records now carry a source-owned `continuityCapsule` alongside:
  - `continuitySummary`
  - `activeMissionId`
  - `focusedWorkerId`
  - `lastDeliveredMission`
  - `recentMissionEvents`
- mission binding and terminal mission projection update that continuity capsule in source instead of leaving it to the Python session-store adapter
- native orchestration `status`, `list`, duplicate suppression, and mission lookup now read through the reconciled task view
- missing child sessions now degrade to `lost` in orchestration status/list flows without relying on the old Python `worker_registry.py` cleanup loop

Why this fork-only:

- the live system still depended on workspace Python to reconcile missing child sessions and to build one of the key continuity fields used by the direct-session orchestration layer
- this slice moves those generic engine responsibilities into maintained fork source and shrinks the remaining Python layer toward policy/compatibility only

#### Native orchestration bridge CLI slice

Added a source-owned compatibility bridge so legacy JSON-over-stdin callers can hit the native OpenCock orchestration runtime instead of reimplementing generic lifecycle logic in workspace Python.

- Added source-owned bridge command dispatch in:
  - `src/orchestration/bridge.ts`
- Extended the CLI registration layer in:
  - `src/cli/program/register.orchestrator.ts`
  - `src/cli/program/register.orchestrator.test.ts`

Behavior change:

- `openclaw orchestrator bridge` now accepts the legacy bridge actions:
  - `prepare`
  - `delegate`
  - `commit`
  - `complete`
  - `heartbeat`
  - `status`
  - `query-status`
  - `list`
  - `cancel`
- those bridge actions speak JSON-over-stdin or `--payload-json` / `--payload-file`
- the bridge delegates directly into the native orchestration control-plane and service modules
- this creates the runtime-owned seam that lets `dispatch_bridge.py` shrink into a compatibility subprocess shim instead of remaining generic engine authority

Why this fork-only:

- the live system still relies on a workspace Python bridge shape, but the generic lifecycle behind that shape now belongs in the OpenCock runtime
- this slice moves the live compatibility seam into maintained fork source so the remaining Python layer can become a thin adapter

#### Source-owned orchestration maintenance slice

Moved another generic `worker_registry.py` / `mission_router.py` cleanup responsibility into OpenCock source by extending the native task maintenance pass with orchestrator heartbeat staleness.

- Added source-owned maintenance policy in:
  - `src/orchestration/maintenance.ts`
  - `src/orchestration/maintenance.test.ts`
- Extended the native task sweeper in:
  - `src/tasks/task-registry.maintenance.ts`
  - `src/tasks/task-registry.test.ts`

Behavior change:

- the existing native task-registry maintenance pass now evaluates orchestrated active tasks against source-owned heartbeat policy
- orchestrated tasks whose heartbeat window has expired are reclassified as `lost` with an explicit runtime-owned reason:
  - `orchestration heartbeat stale: <routingClass>`
- this happens inside the existing task sweeper instead of relying on the old Python cleanup loop to detect stale delegated work
- task-registry tests now pin orchestration runtime config to a temp workspace/config, so maintenance semantics no longer depend on the machine’s live OpenClaw config during test runs

Why this fork-only:

- the live system still relied on workspace Python cleanup semantics to decide when delegated work had gone stale
- this slice moves the generic heartbeat-staleness decision into maintained fork source while leaving tenant-specific routing policy in the workspace

#### Source-owned session binding reconciliation and mission overview slice

Moved another chunk of generic `dispatch.py` session repair/read-model logic into OpenCock source so stale bindings are cleared natively before continuation, status, and list flows.

- Added source-owned binding reconciliation in:
  - `src/orchestration/session-binding-reconcile.ts`
- Extended native orchestration read paths in:
  - `src/orchestration/control-plane.prepare.ts`
  - `src/orchestration/service.ts`
  - `src/orchestration/control-plane.test.ts`
  - `src/orchestration/service.test.ts`

Behavior change:

- native orchestration now clears stale `activeMissionId` / `focusedWorkerId` bindings before evaluating continuation intent
- session `status` and `list` now rebase on the reconciled task view instead of trusting possibly stale bindings first
- explicit mission-id lookups still return terminal/lost mission state, but ordinary session-status lookups now clear dead bindings and fall back to recent mission results

Why this fork-only:

- the live system still relied on workspace Python `cleanup_stale_bindings()` and related session-status shaping in `dispatch.py`
- this slice moves the generic binding repair semantics into maintained fork source and shrinks the remaining Python layer toward a thinner compatibility adapter

#### Source-owned dispatch ingress slice

Moved the generic `dispatch_request()` ingress path out of workspace Python and into the native OpenCock orchestration runtime.

- Added dedicated delegate-execution runtime helpers in:
  - `src/orchestration/delegate-runtime.ts`
- Extended native orchestration service and shared plan typing in:
  - `src/orchestration/service.ts`
  - `src/orchestration/control-plane.shared.ts`
- Extended the runtime bridge / CLI coverage in:
  - `src/orchestration/bridge.ts`
  - `src/orchestration/service.test.ts`
  - `src/cli/program/register.orchestrator.test.ts`

Behavior change:

- `openclaw orchestrator bridge dispatch` now exists as a native runtime action
- raw ingress can now enter the native runtime as one source-owned flow:
  - classify
  - prepare continuation / inline / delegate decision
  - execute delegated spawn when warranted
- prepared delegate execution and suppressed-mission rebinding now live in a focused runtime module instead of being duplicated inside `service.ts`
- the bridge no longer has to force callers through separate prepare + delegate orchestration steps just to reproduce the old Python `dispatch_request()` semantics

Why this fork-only:

- the live system still relied on workspace Python `dispatch_request()` as the combined ingress authority for ordinary delegated requests
- this slice moves that generic engine behavior into maintained fork source so the remaining Python layer can shrink toward tenant policy and compatibility only

#### Source-owned mutation-target-aware delegate lifecycle slice

Moved explicit mutation-target carriage into the native delegate/commit lifecycle so self-improvement validation can remain workspace policy without owning task execution state.

- Extended canonical task metadata in:
  - `src/tasks/task-registry.types.ts`
  - `src/tasks/task-registry.ts`
  - `src/tasks/task-registry.store.sqlite.ts`
  - `src/tasks/task-registry.store.test.ts`
- Extended native delegate / commit execution in:
  - `src/orchestration/control-plane.shared.ts`
  - `src/orchestration/control-plane.prepare.ts`
  - `src/orchestration/control-plane.lifecycle.ts`
  - `src/orchestration/delegate-runtime.ts`
  - `src/orchestration/format.ts`
  - `src/orchestration/bridge.ts`
  - `src/cli/program/register.orchestrator.ts`
  - `src/cli/program/register.orchestrator.test.ts`
- Extended subagent task registration in:
  - `src/agents/subagent-spawn.ts`
  - `src/agents/subagent-registry.ts`
  - `src/agents/subagent-registry-run-manager.ts`

Behavior change:

- explicit delegate plans can now carry normalized `mutationTargets`
- worker task text includes a `Mutation targets:` line when the caller supplied explicit targets
- native delegated worker commits persist those mutation targets on canonical task records
- sqlite persistence round-trips the mutation-target list through `orchestration_mutation_targets_json`
- duplicate mutation targets are deduped at the runtime boundary instead of leaving normalization to the workspace Python layer

Why this fork-only:

- the live system still relied on workspace Python self-improvement delegation paths to carry mutation-target intent through to worker execution
- this slice moves that generic lifecycle/data-shape responsibility into maintained fork source so the workspace can keep only self-improvement policy and validation

#### Validation

- Focused tests:
  - `pnpm exec vitest run src/orchestration/control-plane.test.ts src/orchestration/service.test.ts src/cli/program/register.orchestrator.test.ts src/tasks/task-registry-mission-runtime.test.ts`
  - `pnpm exec vitest run src/orchestration/service.test.ts src/orchestration/control-plane.test.ts src/tasks/task-registry-mission-runtime.test.ts src/cli/program/register.orchestrator.test.ts src/tasks/task-registry.test.ts`
  - `pnpm exec vitest run src/orchestration/service.test.ts src/orchestration/control-plane.test.ts src/cli/program/register.orchestrator.test.ts src/tasks/task-registry.test.ts`
- Build:
  - `pnpm build`
