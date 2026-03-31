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

#### Validation

- Focused tests:
  - `pnpm exec vitest run src/orchestration/control-plane.test.ts src/orchestration/service.test.ts src/cli/program/register.orchestrator.test.ts src/tasks/task-registry-mission-runtime.test.ts`
- Build:
  - `pnpm build`
