import * as NodeSqlite from "node:sqlite";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { watchAntigravityTurnUsage } from "./AntigravityTurnUsage.ts";

function varint(value: number) {
  const bytes: number[] = [];
  while (value >= 128) {
    bytes.push((value % 128) + 128);
    value = Math.floor(value / 128);
  }
  return [...bytes, value];
}

const number = (field: number, value: number) => [...varint(field * 8), ...varint(value)];
const message = (field: number, bytes: ReadonlyArray<number>) => [
  ...varint(field * 8 + 2),
  ...varint(bytes.length),
  ...bytes,
];
const duration = (field: number, ms: number | undefined) =>
  ms === undefined
    ? []
    : message(field, [...number(1, Math.floor(ms / 1_000)), ...number(2, (ms % 1_000) * 1e6)]);

function generation(id: string, output: number, ttftMs?: number, streamMs?: number) {
  return new Uint8Array(
    message(1, [
      ...message(4, [...number(2, 400), ...number(3, output), ...number(5, 600), ...number(9, 15)]),
      ...duration(11, ttftMs),
      ...duration(12, streamMs),
      ...message(20, [
        ...message(1, [...Buffer.from("request_id")]),
        ...message(2, [...Buffer.from(id)]),
      ]),
    ]),
  );
}

const makeProfile = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const profile = yield* fs.makeTempDirectoryScoped();
  const conversations = path.join(profile, "antigravity-acp", "conversations");
  yield* fs.makeDirectory(conversations, { recursive: true });
  const insert = (session: string, idx: number, data: Uint8Array) => {
    const db = new NodeSqlite.DatabaseSync(path.join(conversations, `${session}.db`));
    try {
      db.exec("CREATE TABLE IF NOT EXISTS gen_metadata (idx INTEGER PRIMARY KEY, data BLOB)");
      db.prepare("INSERT INTO gen_metadata (idx, data) VALUES (?, ?)").run(idx, data);
    } finally {
      db.close();
    }
  };
  return { fs, path, profile, conversations, insert };
});

describe("watchAntigravityTurnUsage", () => {
  it.effect("counts native requests for the current turn and updates measured speed", () =>
    Effect.gen(function* () {
      const { profile, insert } = yield* makeProfile;
      insert("session", 0, generation("previous-turn", 100, 800, 1000));
      insert("child", 0, generation("child-request", 100, 800, 1000));

      const read = yield* watchAntigravityTurnUsage(profile, "session");
      assert.isDefined(read);
      assert.isUndefined(yield* read!);

      insert("session", 1, generation("request-one", 120, 8_000, 2_000));
      const first = yield* read!;
      assert.deepEqual(first, {
        inputTokens: 1_000,
        outputTokens: 120,
        latestRequestRate: { tokensPerSecond: 60, timing: "stream" },
      });
      assert.strictEqual(yield* read!, first);
      insert("session", 2, generation("request-one", 120, 8_000, 2_000));
      assert.strictEqual(yield* read!, first);

      insert("session", 3, generation("request-two", 600, 29_000, 1_000));
      assert.deepEqual(yield* read!, {
        inputTokens: 2_000,
        outputTokens: 720,
        latestRequestRate: { tokensPerSecond: 20, timing: "request" },
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "reads a new conversation and leaves speed blank when there is no measured duration",
    () =>
      Effect.gen(function* () {
        const { fs, profile, conversations, insert } = yield* makeProfile;
        yield* fs.remove(conversations, { recursive: true });
        const read = yield* watchAntigravityTurnUsage(profile, "new-session");
        assert.isDefined(read);
        assert.isUndefined(yield* read!);
        yield* fs.makeDirectory(conversations);
        insert("new-session", 0, generation("first", 24));
        assert.deepEqual(yield* read!, {
          inputTokens: 1_000,
          outputTokens: 24,
          latestRequestRate: null,
        });

        // A short response uses the whole measured request, including the wait for the first token.
        insert("new-session", 1, generation("short", 10, 1_500, 500));
        assert.deepEqual(yield* read!, {
          inputTokens: 2_000,
          outputTokens: 34,
          latestRequestRate: { tokensPerSecond: 5, timing: "request" },
        });
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects a session file linked to another conversation", () =>
    Effect.gen(function* () {
      const { fs, path, profile, conversations, insert } = yield* makeProfile;
      insert("other", 0, generation("other-request", 120, 500, 1_000));
      yield* fs.symlink(
        path.join(conversations, "other.db"),
        path.join(conversations, "session.db"),
      );
      assert.isUndefined(yield* watchAntigravityTurnUsage(profile, "session"));
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
