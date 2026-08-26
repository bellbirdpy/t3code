import { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

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
}

export class ProviderThreadContinuity extends Context.Service<
  ProviderThreadContinuity,
  ProviderThreadContinuityShape
>()("t3/provider/Services/ProviderThreadContinuity") {}
