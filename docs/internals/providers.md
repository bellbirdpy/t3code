# Provider architecture

> For maintainers. Using T3 Code? See [docs/user](../user/).

A provider is the agent runtime that does the actual work. T3 Code supports several, and the
orchestration layer does not know which one is behind a thread.

## Built-in drivers

[`builtInDrivers.ts`][drivers] exports `BUILT_IN_DRIVERS` with five entries:

| Driver kind   | Driver source                           |
| ------------- | --------------------------------------- |
| `codex`       | [`Drivers/CodexDriver.ts`][codex]       |
| `claudeAgent` | [`Drivers/ClaudeDriver.ts`][claude]     |
| `cursor`      | [`Drivers/CursorDriver.ts`][cursor]     |
| `grok`        | [`Drivers/GrokDriver.ts`][grok]         |
| `opencode`    | [`Drivers/OpenCodeDriver.ts`][opencode] |

Each driver declares its `driverKind`, a `configSchema`, and a `create` function that builds an
adapter in a child scope. Adapter implementations live beside them in
`apps/server/src/provider/Layers/` (`CodexAdapter.ts`, `ClaudeAdapter.ts`, and so on) and conform to
[`ProviderAdapter.ts`][adapter]. Read the driver plus its adapter to see how a specific agent's
transport, config, and event shapes are mapped.

## Registry and routing

Two registries separate configuration from live processes:

- [`ProviderInstanceRegistry`][instances] keys configured instances by `ProviderInstanceId`. Creating
  one looks up the driver by `driverKind`, decodes `entry.config` with that driver's schema, opens a
  child scope, and calls `driver.create`.
- [`ProviderAdapterRegistry`][registry] resolves an instance ID to its live adapter via
  `getByInstance`.

[`ProviderService`][service] sits on top. It combines the adapter registry with the provider session
directory to route session and turn operations for a thread, so callers name a thread, not an agent.

Adapters can optionally expose `discoverPersistedThreads` and `readPersistedThread`. Codex
implements both through [`CodexThreadDiscovery.ts`][codex-discovery] using app-server
`thread/list` and `thread/read`; it never parses `CODEX_HOME` session files directly. Discovery does
one complete scan after adapter creation, then later passes stop after the first fully known page.
Exact reads keep a thread current even when an update shares a coarse discovery timestamp.

Adding a driver means writing the driver plus adapter and adding it to `BUILT_IN_DRIVERS`. No
orchestration, contract, or client change is required for the common case.

## How provider work is requested

Clients never call a provider directly. They dispatch orchestration commands over the RPC method
`orchestration.dispatchCommand`, defined with the rest of the orchestration surface in
[`orchestration.ts`][contracts]. The client-dispatchable provider-facing commands are
`thread.turn.start`, `thread.turn.interrupt`, `thread.approval.respond`,
`thread.user-input.respond`, `thread.turn.recover`, `thread.checkpoint.revert`, and
`thread.session.stop`, plus the mode setters `thread.runtime-mode.set` and
`thread.interaction-mode.set`. `thread.turn.recover` references an already-persisted user message;
it never creates another message event.

The engine persists an event for the command, and a server-side reactor performs the provider call.
Provider output comes back as internal commands such as `thread.message.assistant.delta` and
`thread.session.set`, which clients observe through `orchestration.subscribeThread`. See
[overview.md](./overview.md) for the command/event loop.

## Server-side workers

Provider work flows through three queue-backed workers. All three are built with
`makeDrainableWorker` from [`DrainableWorker.ts`][worker] and expose `drain` for deterministic test
synchronization.

1. [`ProviderRuntimeIngestion`][ingest] consumes provider runtime streams and emits orchestration
   commands.
2. [`ProviderCommandReactor`][cmd] reacts to orchestration intent events and dispatches provider
   calls.
3. [`CheckpointReactor`][checkpoint] captures workspace checkpoints on turn start and completion, and
   performs reverts.

Persisted conversation convergence is separate from those workers.
[`ProviderThreadReconciler`][reconciler] groups compatible Codex instances by continuation identity
and serializes background discovery with exact per-thread reconciliation. The durable identity is
the continuation key plus the provider thread ID. An external conversation is assigned to the
project matching its Git repository root, with its working directory as fallback; the reconciler
creates the deterministic project when it does not exist. A Codex identity already bound to a native
T3 thread always reconciles into that original thread and preserves its provider instance and model
ownership.

Periodic reconciliation and exact thread reads stay incremental. The explicit Settings operation
requests a complete `thread/list` scan, including unchanged visible sessions as metadata-only
records; only new or changed conversations require `thread/read`. A server-owned single-flight
coordinator publishes replayable `discovering`, `reconciling`, `completed`, and `failed` status over
`subscribeProviderThreadSync`, so the operation survives navigation and client reconnects.

Missing messages enter through the internal `thread.message.import` command with deterministic
command and message IDs. Imported message events are marked historical, so projections create
completed turns without pending provider work or retroactive checkpoints. The discovery cursor is
advanced only after every import command lands, making a crash retry safe.

HTTP and WebSocket thread reads attempt exact reconciliation before loading the projection. Those
reads remain available if Codex is temporarily unavailable. `thread.turn.start` is stricter: exact
reconciliation must finish before the local user command is persisted, preventing a stale local
prompt from overtaking externally appended turns. Background loops start only after server
activation, and all clients observe the resulting ordinary orchestration projections.

### Codex active-writer recovery

Codex rejects `thread/resume` while another Codex process owns the conversation writer. The adapter
does not delete the lock and does not auto-fork. `ProviderCommandReactor` replaces the provider's raw
error with a stable user-safe message and appends a
`provider.thread.active-writer-conflict` activity containing the pending message ID.

The web client and its desktop wrapper expose **Retry** and **Continue in a copy**. Retry re-emits
`thread.turn-start-requested` for the same message and resumes the same provider thread. Copy passes
an explicit fork continuation mode to the Codex adapter, which calls `thread/fork`, persists the new
resume cursor, and then sends that same message. The command is authorized only while the thread is
in the matching recoverable error state. Mobile receives the sanitized projected error and shares
the typed recovery command through `packages/client-runtime`; this change deliberately does not add
a new native mobile chat banner because mobile currently has no thread-detail error action surface.

### Buffered assistant delivery

A thread in `buffered` assistant delivery mode accumulates assistant text instead of streaming each
delta. The buffer is not held until turn completion. In [`ProviderRuntimeIngestion`][ingest],
`MAX_BUFFERED_ASSISTANT_CHARS` is 24,000: the append that would exceed it invalidates the buffer and
spills the whole accumulated text as one delta. The buffer also flushes at interaction boundaries,
when a request opens (approval) or user input is requested, via
`flushBufferedAssistantMessagesForTurn`.

[drivers]: ../../apps/server/src/provider/builtInDrivers.ts
[codex]: ../../apps/server/src/provider/Drivers/CodexDriver.ts
[claude]: ../../apps/server/src/provider/Drivers/ClaudeDriver.ts
[cursor]: ../../apps/server/src/provider/Drivers/CursorDriver.ts
[grok]: ../../apps/server/src/provider/Drivers/GrokDriver.ts
[opencode]: ../../apps/server/src/provider/Drivers/OpenCodeDriver.ts
[adapter]: ../../apps/server/src/provider/Services/ProviderAdapter.ts
[instances]: ../../apps/server/src/provider/Services/ProviderInstanceRegistry.ts
[registry]: ../../apps/server/src/provider/Services/ProviderAdapterRegistry.ts
[service]: ../../apps/server/src/provider/Layers/ProviderService.ts
[codex-discovery]: ../../apps/server/src/provider/Layers/CodexThreadDiscovery.ts
[reconciler]: ../../apps/server/src/provider/Layers/ProviderThreadReconciler.ts
[contracts]: ../../packages/contracts/src/orchestration.ts
[worker]: ../../packages/shared/src/DrainableWorker.ts
[ingest]: ../../apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts
[cmd]: ../../apps/server/src/orchestration/Layers/ProviderCommandReactor.ts
[checkpoint]: ../../apps/server/src/orchestration/Layers/CheckpointReactor.ts
