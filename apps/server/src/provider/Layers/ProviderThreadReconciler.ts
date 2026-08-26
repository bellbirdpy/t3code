// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import {
  CommandId,
  DEFAULT_MODEL_BY_PROVIDER,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { forkParked } from "../../serverActivation.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { ProviderInstance } from "../ProviderDriver.ts";
import { ProviderInstanceRegistry } from "../Services/ProviderInstanceRegistry.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import {
  ProviderThreadContinuity,
  ProviderThreadContinuityError,
} from "../Services/ProviderThreadContinuity.ts";
import type { ProviderPersistedThread } from "../Services/ProviderAdapter.ts";

const CODEX = ProviderDriverKind.make("codex");
const ACTIVE_RECONCILE_INTERVAL = Duration.seconds(30);
const IDLE_RECONCILE_INTERVAL = Duration.minutes(2);
const ResumeCursor = Schema.Struct({ threadId: Schema.String });
const isResumeCursor = Schema.is(ResumeCursor);
const ImportedRuntimePayload = Schema.Struct({
  continuationKey: Schema.optional(Schema.String),
  providerUpdatedAt: Schema.optional(Schema.String),
  providerDiscoveryCursor: Schema.optional(Schema.String),
});
const isImportedRuntimePayload = Schema.is(ImportedRuntimePayload);

export function continuationIdentityDigest(continuationKey: string): string {
  return NodeCrypto.createHash("sha256").update(continuationKey).digest("hex").slice(0, 24);
}

function diagnosticErrorType(cause: unknown): string {
  if (cause instanceof Error) return cause.name;
  if (typeof cause === "object" && cause !== null && "_tag" in cause) {
    return String(cause._tag);
  }
  return typeof cause;
}

export function recoverReconciliationCause<A, E>(
  cause: Cause.Cause<E>,
  message: string,
  annotations: Record<string, unknown>,
  fallback: A,
): Effect.Effect<A, E> {
  return Cause.hasInterrupts(cause)
    ? Effect.failCause(cause)
    : Effect.logWarning(message, annotations).pipe(Effect.as(fallback));
}

export function resolvePersistedContinuationKey(
  providerInstanceId: string,
  runtimePayload: unknown,
  continuationKeyByInstanceId: ReadonlyMap<string, string>,
): string | undefined {
  return (
    (isImportedRuntimePayload(runtimePayload) ? runtimePayload.continuationKey : undefined) ??
    continuationKeyByInstanceId.get(providerInstanceId)
  );
}

export function providerThreadDiscoveryExclusions(
  unresolvedNativeProviderThreadIds: ReadonlySet<string>,
): ReadonlySet<string> {
  // Threads whose Codex home cannot be resolved are the only unsafe reads.
  // Resolved native bindings must be discovered so external turns can flow
  // back into their original T3 thread.
  return new Set(unresolvedNativeProviderThreadIds);
}

function providerIdentityKey(continuationKey: string, providerThreadId: string): string {
  return `${continuationKey.length}:${continuationKey}${providerThreadId}`;
}

function importedThreadIdFor(continuationKey: string, providerThreadId: string): ThreadId {
  return ThreadId.make(
    `imported:${continuationIdentityDigest(continuationKey)}:${providerThreadId}`,
  );
}

function importedThreadId(instance: ProviderInstance, providerThreadId: string): ThreadId {
  return importedThreadIdFor(instance.continuationIdentity.continuationKey, providerThreadId);
}

function workspaceProjectId(workspaceRoot: string): ProjectId {
  return ProjectId.make(`provider-workspace:${continuationIdentityDigest(workspaceRoot)}`);
}

function workspaceProjectTitle(workspaceRoot: string): string {
  const withoutTrailingSeparators = workspaceRoot.replace(/[\\/]+$/, "");
  return withoutTrailingSeparators.split(/[\\/]/).at(-1) || workspaceRoot;
}

function importCommandId(...parts: ReadonlyArray<string>): CommandId {
  return CommandId.make(`provider-import:${parts.join(":")}`);
}

function importedMessageId(
  continuationKey: string,
  providerThreadId: string,
  providerMessageId: string,
  sourceOrdinal: number,
): MessageId {
  const orderedOrdinal = String(sourceOrdinal).padStart(10, "0");
  return MessageId.make(
    `provider:${continuationIdentityDigest(continuationKey)}:${providerThreadId}:message:${orderedOrdinal}:${providerMessageId}`,
  );
}

function projectedAttachmentMessageKey(message: {
  readonly role: string;
  readonly text: string;
  readonly attachments?:
    | ReadonlyArray<{ readonly type: string; readonly name: string }>
    | undefined;
}): string | undefined {
  if (message.role !== "user" || !message.attachments || message.attachments.length === 0) {
    return undefined;
  }
  return JSON.stringify([
    message.text,
    message.attachments.map((attachment) => [attachment.type, attachment.name]),
  ]);
}

function persistedAttachmentMessageKey(message: {
  readonly role: string;
  readonly text: string;
}): string | undefined {
  if (message.role !== "user") return undefined;
  const lines = message.text.split("\n");
  const attachments: Array<readonly [string, string]> = [];
  while (lines.length > 0) {
    const line = lines.at(-1)!;
    const match = /^\[Attached (\S+) "(.*)" is saved at: .+\]$/.exec(line);
    if (!match) break;
    attachments.unshift([match[1]!, match[2]!]);
    lines.pop();
  }
  if (attachments.length === 0) return undefined;
  if (lines.length === 0) return JSON.stringify(["", attachments]);
  if (lines.at(-1) !== "") return undefined;
  lines.pop();
  return JSON.stringify([lines.join("\n"), attachments]);
}

export function groupPersistedThreadDiscoveryCandidates(
  instances: ReadonlyArray<ProviderInstance>,
): ReadonlyArray<ReadonlyArray<ProviderInstance>> {
  const candidatesByContinuationKey = new Map<string, ProviderInstance[]>();
  const discoverable = instances
    .filter(
      (instance) =>
        instance.enabled &&
        instance.driverKind === CODEX &&
        instance.adapter.discoverPersistedThreads !== undefined,
    )
    .sort((left, right) => left.instanceId.localeCompare(right.instanceId));
  for (const instance of discoverable) {
    const continuationKey = instance.continuationIdentity.continuationKey;
    const candidates = candidatesByContinuationKey.get(continuationKey) ?? [];
    candidates.push(instance);
    candidatesByContinuationKey.set(continuationKey, candidates);
  }
  return Array.from(candidatesByContinuationKey.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, candidates]) => candidates);
}

export const reconcilePersistedProviderThreads = Effect.fn("reconcilePersistedProviderThreads")(
  function* () {
    const registry = yield* ProviderInstanceRegistry;
    const directory = yield* ProviderSessionDirectory;
    const snapshots = yield* ProjectionSnapshotQuery;
    const engine = yield* OrchestrationEngineService;
    const instances = yield* registry.listInstances;
    const bindings = yield* directory.listBindings();
    const discoveryCandidateGroups = groupPersistedThreadDiscoveryCandidates(instances);
    const continuationKeyByInstanceId = new Map(
      instances
        .filter((instance) => instance.driverKind === CODEX)
        .map(
          (instance) =>
            [instance.instanceId, instance.continuationIdentity.continuationKey] as const,
        ),
    );
    const threadByProviderIdentity = new Map<string, ThreadId>();
    const cursorByThreadIdByContinuation = new Map<string, Map<string, string>>();
    const importedOwnerInstanceIdsByContinuation = new Map<string, Set<string>>();
    const unresolvedNativeProviderThreadIds = new Set<string>();

    for (const binding of bindings) {
      if (
        binding.provider !== CODEX ||
        !binding.providerInstanceId ||
        !isResumeCursor(binding.resumeCursor)
      ) {
        continue;
      }
      const continuationKey = resolvePersistedContinuationKey(
        binding.providerInstanceId,
        binding.runtimePayload,
        continuationKeyByInstanceId,
      );
      if (!continuationKey) {
        unresolvedNativeProviderThreadIds.add(binding.resumeCursor.threadId);
        continue;
      }
      threadByProviderIdentity.set(
        providerIdentityKey(continuationKey, binding.resumeCursor.threadId),
        binding.threadId,
      );
      const expectedImportedId = importedThreadIdFor(
        continuationKey,
        binding.resumeCursor.threadId,
      );
      if (binding.threadId === expectedImportedId) {
        const importedOwners =
          importedOwnerInstanceIdsByContinuation.get(continuationKey) ?? new Set();
        importedOwners.add(binding.providerInstanceId);
        importedOwnerInstanceIdsByContinuation.set(continuationKey, importedOwners);
      }
      // Native T3 threads participate in discovery too. Their provider cursor
      // is persisted after reconciliation just like an imported thread, so a
      // periodic pass does not re-read unchanged transcripts.
      if (isImportedRuntimePayload(binding.runtimePayload)) {
        const providerCursor =
          binding.runtimePayload.providerDiscoveryCursor ??
          binding.runtimePayload.providerUpdatedAt;
        if (providerCursor) {
          const cursors = cursorByThreadIdByContinuation.get(continuationKey) ?? new Map();
          cursors.set(binding.resumeCursor.threadId, providerCursor);
          cursorByThreadIdByContinuation.set(continuationKey, cursors);
        }
      }
    }

    const discoveredCounts = yield* Effect.forEach(
      discoveryCandidateGroups,
      (candidates) =>
        Effect.gen(function* () {
          let selected:
            | {
                readonly instance: ProviderInstance;
                readonly model: string;
                readonly discovered: ReadonlyArray<ProviderPersistedThread>;
              }
            | undefined;
          for (const instance of candidates) {
            const attempt = yield* Effect.gen(function* () {
              const discover = instance.adapter.discoverPersistedThreads;
              if (!discover) return undefined;
              const providerSnapshot = yield* instance.snapshot.getSnapshot;
              const model =
                providerSnapshot.models.find((entry) => entry.isDefault)?.slug ??
                providerSnapshot.models[0]?.slug ??
                DEFAULT_MODEL_BY_PROVIDER[CODEX] ??
                "default";
              const continuationKey = instance.continuationIdentity.continuationKey;
              const importedOwners = importedOwnerInstanceIdsByContinuation.get(continuationKey);
              const ownerChanged =
                importedOwners !== undefined &&
                Array.from(importedOwners).some(
                  (ownerInstanceId) => ownerInstanceId !== instance.instanceId,
                );
              const discovered = yield* discover({
                excludeProviderThreadIds: providerThreadDiscoveryExclusions(
                  unresolvedNativeProviderThreadIds,
                ),
                cursorByProviderThreadId: ownerChanged
                  ? new Map()
                  : (cursorByThreadIdByContinuation.get(continuationKey) ?? new Map()),
              });
              return { instance, model, discovered } as const;
            }).pipe(
              Effect.catch((cause) =>
                Effect.logWarning("persisted provider thread discovery candidate failed", {
                  provider: instance.driverKind,
                  providerInstanceId: instance.instanceId,
                  continuationIdentity: continuationIdentityDigest(
                    instance.continuationIdentity.continuationKey,
                  ),
                  errorType: diagnosticErrorType(cause),
                }).pipe(Effect.as(undefined)),
              ),
            );
            if (attempt) {
              selected = attempt;
              break;
            }
          }
          if (!selected) return 0;
          const { instance, model, discovered } = selected;

          yield* Effect.forEach(
            discovered,
            (thread) =>
              reconcilePersistedThread({
                instance,
                thread,
                model,
                threadByProviderIdentity,
                directory,
                snapshots,
                engine,
              }).pipe(
                Effect.catchCause((cause) =>
                  recoverReconciliationCause(
                    cause,
                    "skipped persisted provider thread during reconciliation",
                    {
                      provider: instance.driverKind,
                      providerInstanceId: instance.instanceId,
                      providerThreadId: thread.providerThreadId,
                    },
                    undefined,
                  ),
                ),
              ),
            { concurrency: 1, discard: true },
          );
          return discovered.length;
        }).pipe(
          Effect.catchCause((cause) =>
            recoverReconciliationCause(
              cause,
              "persisted provider thread discovery failed",
              {
                provider: CODEX,
                continuationIdentity: candidates[0]
                  ? continuationIdentityDigest(candidates[0].continuationIdentity.continuationKey)
                  : undefined,
              },
              0,
            ),
          ),
        ),
      { concurrency: "unbounded" },
    );
    return discoveredCounts.reduce((total, count) => total + count, 0);
  },
);

export const reconcilePersistedThread = Effect.fn("reconcilePersistedProviderThread")(
  function* (input: {
    readonly instance: ProviderInstance;
    readonly thread: ProviderPersistedThread;
    readonly model: string;
    readonly threadByProviderIdentity: Map<string, ThreadId>;
    readonly directory: ProviderSessionDirectory["Service"];
    readonly snapshots: ProjectionSnapshotQuery["Service"];
    readonly engine: OrchestrationEngineService["Service"];
  }) {
    const continuationKey = input.instance.continuationIdentity.continuationKey;
    const continuationIdentity = continuationIdentityDigest(continuationKey);
    const identity = providerIdentityKey(continuationKey, input.thread.providerThreadId);
    const expectedThreadId = importedThreadId(input.instance, input.thread.providerThreadId);
    const boundThreadId = input.threadByProviderIdentity.get(identity);
    const targetThreadId = boundThreadId ?? expectedThreadId;
    const importsNewThread = boundThreadId === undefined;
    const managesImportedThread = targetThreadId === expectedThreadId;

    const existingThread = yield* input.snapshots.getThreadShellById(targetThreadId);
    // A binding whose T3 thread is archived or deleted acts as a tombstone and
    // must never be recreated as a deterministic import. Archived threads can
    // reconcile after restoration; deleted threads remain tombstoned.
    if (!importsNewThread && Option.isNone(existingThread)) {
      yield* input.directory.upsert({
        threadId: targetThreadId,
        provider: CODEX,
        resumeCursor: { threadId: input.thread.providerThreadId },
        runtimePayload: {
          continuationKey,
          providerUpdatedAt: input.thread.updatedAt,
          providerDiscoveryCursor: input.thread.discoveryCursor,
          sourceMetadata: input.thread.sourceMetadata,
        },
      });
      return;
    }

    const matchingProject = managesImportedThread
      ? yield* input.snapshots.getActiveProjectByWorkspaceRoot(input.thread.cwd)
      : Option.none();
    const projectId = Option.isSome(matchingProject)
      ? matchingProject.value.id
      : managesImportedThread
        ? workspaceProjectId(input.thread.cwd)
        : Option.getOrThrow(existingThread).projectId;

    if (managesImportedThread && Option.isNone(matchingProject)) {
      const existingWorkspaceProject = yield* input.snapshots.getProjectShellById(projectId);
      if (Option.isNone(existingWorkspaceProject)) {
        yield* input.engine.dispatch({
          type: "project.create",
          commandId: importCommandId("workspace", continuationIdentityDigest(input.thread.cwd)),
          projectId,
          title: workspaceProjectTitle(input.thread.cwd),
          workspaceRoot: input.thread.cwd,
          defaultModelSelection: { instanceId: input.instance.instanceId, model: input.model },
          createdAt: input.thread.createdAt,
        });
      }
    }

    if (importsNewThread && Option.isNone(existingThread)) {
      yield* input.engine.dispatch({
        type: "thread.create",
        commandId: importCommandId(continuationIdentity, input.thread.providerThreadId, "create"),
        threadId: targetThreadId,
        projectId,
        title: input.thread.title,
        modelSelection: { instanceId: input.instance.instanceId, model: input.model },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt: input.thread.createdAt,
      });
    } else if (targetThreadId === expectedThreadId && Option.isSome(existingThread)) {
      const ownerChanged =
        existingThread.value.modelSelection.instanceId !== input.instance.instanceId ||
        existingThread.value.modelSelection.model !== input.model;
      const projectChanged = existingThread.value.projectId !== projectId;
      if (ownerChanged || projectChanged) {
        yield* input.engine.dispatch({
          type: "thread.meta.update",
          commandId: importCommandId(
            continuationIdentity,
            input.thread.providerThreadId,
            "metadata",
            projectId,
            input.instance.instanceId,
            input.model,
          ),
          threadId: targetThreadId,
          ...(projectChanged ? { projectId, worktreePath: null } : {}),
          ...(ownerChanged
            ? { modelSelection: { instanceId: input.instance.instanceId, model: input.model } }
            : {}),
        });
      }
    }

    const existingDetail = Option.isSome(existingThread)
      ? yield* input.snapshots.getThreadDetailById(targetThreadId)
      : Option.none();
    const projectedMessages = Option.isSome(existingDetail) ? existingDetail.value.messages : [];
    const projectedIndexById = new Map(
      projectedMessages.map((message, index) => [message.id, index]),
    );
    const projectedIndexesByContent = new Map<string, Map<string, number[]>>();
    const projectedIndexesByAttachmentContent = new Map<string, number[]>();
    for (const [index, message] of projectedMessages.entries()) {
      const indexesByText = projectedIndexesByContent.get(message.role) ?? new Map();
      const indexes = indexesByText.get(message.text) ?? [];
      indexes.push(index);
      indexesByText.set(message.text, indexes);
      projectedIndexesByContent.set(message.role, indexesByText);
      const attachmentKey = projectedAttachmentMessageKey(message);
      if (attachmentKey !== undefined) {
        const attachmentIndexes = projectedIndexesByAttachmentContent.get(attachmentKey) ?? [];
        attachmentIndexes.push(index);
        projectedIndexesByAttachmentContent.set(attachmentKey, attachmentIndexes);
      }
    }
    const nextContentPosition = new Map<string, Map<string, number>>();
    const nextAttachmentPosition = new Map<string, number>();
    let projectedIndex = 0;
    const missingMessages = input.thread.messages.filter((message) => {
      const deterministicId = importedMessageId(
        continuationKey,
        input.thread.providerThreadId,
        message.id,
        message.sourceOrdinal,
      );
      const exactIndex = projectedIndexById.get(deterministicId);
      if (exactIndex !== undefined && exactIndex >= projectedIndex) {
        projectedIndex = exactIndex + 1;
        return false;
      }

      const indexes = projectedIndexesByContent.get(message.role)?.get(message.text) ?? [];
      const positionsByText = nextContentPosition.get(message.role) ?? new Map();
      let contentPosition = positionsByText.get(message.text) ?? 0;
      while (contentPosition < indexes.length && indexes[contentPosition]! < projectedIndex) {
        contentPosition += 1;
      }
      positionsByText.set(message.text, contentPosition + 1);
      nextContentPosition.set(message.role, positionsByText);
      const matchingIndex = indexes[contentPosition];
      if (matchingIndex !== undefined) {
        projectedIndex = matchingIndex + 1;
        return false;
      }
      const attachmentKey = persistedAttachmentMessageKey(message);
      if (attachmentKey !== undefined) {
        const attachmentIndexes = projectedIndexesByAttachmentContent.get(attachmentKey) ?? [];
        let attachmentPosition = nextAttachmentPosition.get(attachmentKey) ?? 0;
        while (
          attachmentPosition < attachmentIndexes.length &&
          attachmentIndexes[attachmentPosition]! < projectedIndex
        ) {
          attachmentPosition += 1;
        }
        nextAttachmentPosition.set(attachmentKey, attachmentPosition + 1);
        const attachmentMatchingIndex = attachmentIndexes[attachmentPosition];
        if (attachmentMatchingIndex !== undefined) {
          projectedIndex = attachmentMatchingIndex + 1;
          return false;
        }
      }
      return true;
    });

    yield* Effect.forEach(
      missingMessages,
      (message) =>
        input.engine.dispatch({
          type: "thread.message.import",
          commandId: importCommandId(
            continuationIdentity,
            input.thread.providerThreadId,
            "message",
            message.id,
          ),
          threadId: targetThreadId,
          messageId: importedMessageId(
            continuationKey,
            input.thread.providerThreadId,
            message.id,
            message.sourceOrdinal,
          ),
          role: message.role,
          text: message.text,
          turnId: TurnId.make(message.turnId),
          createdAt: message.createdAt,
        }),
      { concurrency: 1, discard: true },
    );

    // Advance the discovery watermark only after every deterministic message
    // command has landed. A crash mid-import then retries safely on the next
    // pass instead of permanently hiding the remaining history.
    const ownerModelSelection =
      targetThreadId === expectedThreadId || Option.isNone(existingThread)
        ? { instanceId: input.instance.instanceId, model: input.model }
        : existingThread.value.modelSelection;
    yield* input.directory.upsert({
      threadId: targetThreadId,
      provider: CODEX,
      providerInstanceId: ownerModelSelection.instanceId,
      ...(boundThreadId === undefined
        ? { runtimeMode: "full-access" as const, status: "stopped" as const }
        : {}),
      resumeCursor: { threadId: input.thread.providerThreadId },
      runtimePayload: {
        ...(targetThreadId === expectedThreadId ? { imported: true } : {}),
        continuationKey,
        providerUpdatedAt: input.thread.updatedAt,
        providerDiscoveryCursor: input.thread.discoveryCursor,
        sourceMetadata: input.thread.sourceMetadata,
        modelSelection: ownerModelSelection,
      },
    });
    input.threadByProviderIdentity.set(identity, targetThreadId);
  },
);

export const reconcilePersistedProviderThreadById = Effect.fn(
  "reconcilePersistedProviderThreadById",
)(function* (threadId: ThreadId) {
  const registry = yield* ProviderInstanceRegistry;
  const directory = yield* ProviderSessionDirectory;
  const snapshots = yield* ProjectionSnapshotQuery;
  const engine = yield* OrchestrationEngineService;
  const bindingOption = yield* directory.getBinding(threadId);
  if (Option.isNone(bindingOption)) return false;
  const binding = bindingOption.value;
  if (
    binding.provider !== CODEX ||
    binding.providerInstanceId === undefined ||
    !isResumeCursor(binding.resumeCursor)
  ) {
    return false;
  }

  const instances = yield* registry.listInstances;
  const continuationKeyByInstanceId = new Map(
    instances
      .filter((instance) => instance.driverKind === CODEX)
      .map(
        (instance) => [instance.instanceId, instance.continuationIdentity.continuationKey] as const,
      ),
  );
  const continuationKey = resolvePersistedContinuationKey(
    binding.providerInstanceId,
    binding.runtimePayload,
    continuationKeyByInstanceId,
  );
  if (continuationKey === undefined) return false;

  const candidates = instances
    .filter(
      (instance) =>
        instance.enabled &&
        instance.driverKind === CODEX &&
        instance.continuationIdentity.continuationKey === continuationKey &&
        instance.adapter.readPersistedThread !== undefined,
    )
    .toSorted((left, right) => {
      const leftOwns = left.instanceId === binding.providerInstanceId ? 0 : 1;
      const rightOwns = right.instanceId === binding.providerInstanceId ? 0 : 1;
      return leftOwns - rightOwns || left.instanceId.localeCompare(right.instanceId);
    });
  const instance = candidates[0];
  if (instance === undefined || instance.adapter.readPersistedThread === undefined) return false;

  const [persistedThread, existingThread, providerSnapshot] = yield* Effect.all([
    instance.adapter.readPersistedThread(binding.resumeCursor.threadId),
    snapshots.getThreadShellById(threadId),
    instance.snapshot.getSnapshot,
  ]);
  const model = Option.isSome(existingThread)
    ? existingThread.value.modelSelection.model
    : (providerSnapshot.models.find((entry) => entry.isDefault)?.slug ??
      providerSnapshot.models[0]?.slug ??
      DEFAULT_MODEL_BY_PROVIDER[CODEX] ??
      "default");

  yield* reconcilePersistedThread({
    instance,
    thread: persistedThread,
    model,
    threadByProviderIdentity: new Map([
      [providerIdentityKey(continuationKey, persistedThread.providerThreadId), threadId],
    ]),
    directory,
    snapshots,
    engine,
  });
  return true;
});

export const ProviderThreadReconcilerLive = Layer.effect(
  ProviderThreadContinuity,
  Effect.gen(function* () {
    const continuityContext = yield* Effect.context<
      | OrchestrationEngineService
      | ProjectionSnapshotQuery
      | ProviderInstanceRegistry
      | ProviderSessionDirectory
    >();
    const registry = yield* ProviderInstanceRegistry;
    const changes = yield* registry.subscribeChanges;
    const reconcileSemaphore = yield* Semaphore.make(1);
    const reconcileAll = reconcileSemaphore.withPermits(1)(
      reconcilePersistedProviderThreads().pipe(
        Effect.provideContext(continuityContext),
        Effect.catchCause((cause) =>
          recoverReconciliationCause(
            cause,
            "persisted provider thread reconciliation failed",
            {},
            0,
          ),
        ),
      ),
    );
    const reconcileThread = Effect.fn("ProviderThreadContinuity.reconcileThread")(function* (
      threadId: ThreadId,
    ) {
      return yield* reconcileSemaphore
        .withPermits(1)(reconcilePersistedProviderThreadById(threadId))
        .pipe(
          Effect.provideContext(continuityContext),
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.interrupt
              : Effect.fail(
                  new ProviderThreadContinuityError({
                    threadId,
                    operation: "reconcile",
                    message: Cause.pretty(cause),
                    cause,
                  }),
                ),
          ),
        );
    });

    yield* forkParked(
      Effect.forever(
        reconcileAll.pipe(
          Effect.flatMap((discoveredCount) =>
            Effect.sleep(discoveredCount > 0 ? ACTIVE_RECONCILE_INTERVAL : IDLE_RECONCILE_INTERVAL),
          ),
        ),
      ),
    );
    yield* forkParked(Effect.forever(PubSub.take(changes).pipe(Effect.andThen(reconcileAll))));

    return ProviderThreadContinuity.of({ reconcileThread });
  }),
);
