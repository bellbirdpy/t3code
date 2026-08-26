import { type ProviderThreadSyncStatus, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Stream from "effect/Stream";

export class ProviderThreadContinuityError extends Schema.TaggedErrorClass<ProviderThreadContinuityError>()(
  "ProviderThreadContinuityError",
  {
    threadId: ThreadId,
    operation: Schema.Literals(["read", "reconcile"]),
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export interface ProviderThreadContinuityShape {
  /**
   * Converge one already-bound T3 thread with its durable provider transcript.
   * Returns false for providers or bindings without a continuity capability.
   */
  readonly reconcileThread: (
    threadId: ThreadId,
  ) => Effect.Effect<boolean, ProviderThreadContinuityError>;
  readonly startSyncAll: Effect.Effect<ProviderThreadSyncStatus>;
  readonly getSyncStatus: Effect.Effect<ProviderThreadSyncStatus>;
  readonly streamSyncStatus: Stream.Stream<ProviderThreadSyncStatus>;
}

export class ProviderThreadContinuity extends Context.Service<
  ProviderThreadContinuity,
  ProviderThreadContinuityShape
>()("t3/provider/Services/ProviderThreadContinuity") {}
