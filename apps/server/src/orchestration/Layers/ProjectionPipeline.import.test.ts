import {
  CommandId,
  CorrelationId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerConfig } from "../../config.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";

const TestLayer = OrchestrationProjectionPipelineLive.pipe(
  Layer.provideMerge(OrchestrationEventStoreLive),
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-projection-import-test-" }),
  ),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(NodeServices.layer),
);

it.layer(TestLayer)("historical provider message projection", (it) => {
  it.effect("projects an imported turn as completed without runtime or checkpoint state", () =>
    Effect.gen(function* () {
      const pipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const projectId = ProjectId.make("project-import");
      const threadId = ThreadId.make("thread-import");
      const turnId = TurnId.make("provider-turn-import");
      const createdAt = "2026-08-26T10:00:00.000Z";

      yield* eventStore.append({
        type: "project.created",
        eventId: EventId.make("event-import-project"),
        aggregateKind: "project",
        aggregateId: projectId,
        occurredAt: createdAt,
        commandId: CommandId.make("command-import-project"),
        causationEventId: null,
        correlationId: CorrelationId.make("command-import-project"),
        metadata: {},
        payload: {
          projectId,
          title: "Imported project",
          workspaceRoot: "/tmp/imported-project",
          defaultModelSelection: null,
          scripts: [],
          createdAt,
          updatedAt: createdAt,
        },
      });
      yield* eventStore.append({
        type: "thread.created",
        eventId: EventId.make("event-import-thread"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: createdAt,
        commandId: CommandId.make("command-import-thread"),
        causationEventId: null,
        correlationId: CorrelationId.make("command-import-thread"),
        metadata: {},
        payload: {
          threadId,
          projectId,
          title: "Imported Codex thread",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.6-sol",
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt,
          updatedAt: createdAt,
        },
      });

      for (const [ordinal, role, text] of [
        [1, "user", "External prompt"],
        [2, "assistant", "External response"],
      ] as const) {
        const occurredAt = `2026-08-26T10:00:0${ordinal}.000Z`;
        yield* eventStore.append({
          type: "thread.message-sent",
          eventId: EventId.make(`event-import-message-${ordinal}`),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt,
          commandId: CommandId.make(`provider-import:message-${ordinal}`),
          causationEventId: null,
          correlationId: CorrelationId.make(`provider-import:message-${ordinal}`),
          metadata: {},
          payload: {
            threadId,
            messageId: MessageId.make(`message-import-${ordinal}`),
            role,
            text,
            turnId,
            streaming: false,
            historical: true,
            createdAt: occurredAt,
            updatedAt: occurredAt,
          },
        });
      }

      yield* pipeline.bootstrap;

      const turns = yield* sql<{
        readonly state: string;
        readonly pendingMessageId: string | null;
        readonly assistantMessageId: string | null;
      }>`
        SELECT
          state,
          pending_message_id AS "pendingMessageId",
          assistant_message_id AS "assistantMessageId"
        FROM projection_turns
        WHERE thread_id = ${threadId} AND turn_id = ${turnId}
      `;
      assert.deepEqual(turns, [
        {
          state: "completed",
          pendingMessageId: null,
          assistantMessageId: "message-import-2",
        },
      ]);

      const threads = yield* sql<{ readonly latestTurnId: string | null }>`
        SELECT latest_turn_id AS "latestTurnId"
        FROM projection_threads
        WHERE thread_id = ${threadId}
      `;
      assert.deepEqual(threads, [{ latestTurnId: turnId }]);

      const checkpoints = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM projection_turns
        WHERE thread_id = ${threadId} AND checkpoint_turn_count IS NOT NULL
      `;
      assert.deepEqual(checkpoints, [{ count: 0 }]);
    }),
  );
});
