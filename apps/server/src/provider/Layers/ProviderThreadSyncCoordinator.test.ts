import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { makeProviderThreadSyncCoordinator } from "./ProviderThreadSyncCoordinator.ts";

it.effect("keeps a sync running independently and replays its terminal progress", () =>
  Effect.gen(function* () {
    const finish = yield* Deferred.make<void>();
    const coordinator = yield* makeProviderThreadSyncCoordinator((reportProgress) =>
      reportProgress({
        total: 2,
        completed: 1,
        organized: 1,
        updated: 0,
        unchanged: 0,
        failed: 0,
      }).pipe(
        Effect.andThen(Deferred.await(finish)),
        Effect.as({
          total: 2,
          completed: 2,
          organized: 1,
          updated: 0,
          unchanged: 1,
          failed: 0,
        }),
      ),
    );
    const observedFiber = yield* coordinator.changes.pipe(
      Stream.takeUntil((status) => status.status === "completed"),
      Stream.runCollect,
      Effect.forkChild,
    );

    const started = yield* coordinator.start;
    expect(started.status).toBe("running");
    expect(started.status === "running" ? started.phase : null).toBe("discovering");

    yield* Deferred.succeed(finish, undefined);
    const observed = Array.from(yield* Fiber.join(observedFiber));
    expect(
      observed.map((status) =>
        status.status === "running" ? `${status.status}:${status.phase}` : status.status,
      ),
    ).toEqual(["running:discovering", "running:reconciling", "completed"]);

    const replayed = Option.getOrThrow(yield* coordinator.changes.pipe(Stream.runHead));
    expect(replayed).toEqual(observed.at(-1));
  }),
);
