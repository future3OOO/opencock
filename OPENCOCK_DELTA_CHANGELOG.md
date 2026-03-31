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

### External Custom Surfaces Still To Be Migrated

- The broader workspace-side delegation/orchestration layer is still partly owned by workspace Python under `skills/clawbot-autoresearch/scripts/*`.
- Workspace doctrine, memory, continuity export, and SkillOps/autoresearch policy remain workspace-owned by design.
- Managed hooks under the runtime state tree still exist as part of the live system and will be retired or thinned as source ownership expands.

## Entries

### 2026-03-31

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

#### Validation

- Focused tests:
  - `pnpm exec vitest run src/tasks/task-registry-mission-runtime.test.ts src/gateway/server.hooks.test.ts src/tasks/task-registry.test.ts`
- Build:
  - `pnpm build`
