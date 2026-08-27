import type { ProviderThreadSyncProgress, ProviderThreadSyncStatus } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { subscribeBeforeSnapshot } from "../../utils/subscribeBeforeSnapshot.ts";

const EMPTY_PROGRESS: ProviderThreadSyncProgress = {
  total: 0,
  completed: 0,
  organized: 0,
  updated: 0,
  unchanged: 0,
  failed: 0,
};

export interface ProviderThreadSyncCoordinator {
  readonly start: Effect.Effect<ProviderThreadSyncStatus>;
  readonly getStatus: Effect.Effect<ProviderThreadSyncStatus>;
  readonly changes: Stream.Stream<ProviderThreadSyncStatus>;
}

export const makeProviderThreadSyncCoordinator = Effect.fn("makeProviderThreadSyncCoordinator")(
  function* <E>(
    run: (
      reportProgress: (progress: ProviderThreadSyncProgress) => Effect.Effect<void>,
    ) => Effect.Effect<ProviderThreadSyncProgress, E>,
  ) {
    const lifetime = yield* Scope.Scope;
    const state = yield* Ref.make<ProviderThreadSyncStatus>({ status: "idle" });
    const changes = yield* PubSub.unbounded<ProviderThreadSyncStatus>();
    const mutex = yield* Semaphore.make(1);

    const publish = (status: ProviderThreadSyncStatus) =>
      mutex.withPermits(1)(
        Ref.set(state, status).pipe(Effect.andThen(PubSub.publish(changes, status)), Effect.asVoid),
      );

    const start = mutex.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* Ref.get(state);
        if (current.status === "running") return current;

        const startedAt = DateTime.formatIso(yield* DateTime.now);
        const started: ProviderThreadSyncStatus = {
          status: "running",
          phase: "discovering",
          startedAt,
          progress: EMPTY_PROGRESS,
        };
        yield* Ref.set(state, started);
        yield* PubSub.publish(changes, started);

        const operation = run((progress) =>
          publish({ status: "running", phase: "reconciling", startedAt, progress }),
        ).pipe(
          Effect.exit,
          Effect.flatMap((exit) =>
            DateTime.now.pipe(
              Effect.map(DateTime.formatIso),
              Effect.flatMap((finishedAt) =>
                Exit.match(exit, {
                  onSuccess: (progress) =>
                    publish({ status: "completed", startedAt, finishedAt, progress }),
                  onFailure: () =>
                    Ref.get(state).pipe(
                      Effect.flatMap((latest) =>
                        publish({
                          status: "failed",
                          startedAt,
                          finishedAt,
                          progress: latest.status === "idle" ? EMPTY_PROGRESS : latest.progress,
                          message: "Could not synchronize Codex sessions.",
                        }),
                      ),
                    ),
                }),
              ),
            ),
          ),
        );
        yield* Effect.forkIn(operation, lifetime);
        return started;
      }),
    );

    const stream = Stream.unwrap(
      subscribeBeforeSnapshot(changes, Ref.get(state), mutex).pipe(
        Effect.map(({ latest, changes }) => Stream.concat(Stream.succeed(latest), changes)),
      ),
    );

    return {
      start,
      getStatus: Ref.get(state),
      changes: stream,
    } satisfies ProviderThreadSyncCoordinator;
  },
);
