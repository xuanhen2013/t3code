// @effect-diagnostics nodeBuiltinImport:off -- Read the native SQLite conversation log.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import type { OrchestrationV2RecordedModelUsage } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { bytesAt, fields, nested, numberAt, textAt, type Fields } from "../antigravityProtobuf.ts";
import { antigravityManagedPath, antigravityProfileRoot } from "./AntigravityProfilePaths.ts";

const conversationSegments = ["antigravity-acp", "conversations"];

function durationMs(chat: Fields, field: number): number | null {
  const bytes = bytesAt(chat, field);
  if (bytes === undefined) return null;
  const duration = fields(bytes);
  return numberAt(duration, 1) * 1_000 + numberAt(duration, 2) / 1_000_000;
}

// Agy PowerTools' request rate: use the decode interval for genuine streams. Short
// replies and buffered responses need the whole model call, including the first-token wait.
// https://github.com/WhiteBr1ck/agy-powertools/blob/e78501341b3158ac238ec2be9331d0a514028c16/lib/dashboard.mjs#L214-L241
function requestRate(
  outputTokens: number,
  ttftMs: number | null,
  streamingMs: number | null,
): OrchestrationV2RecordedModelUsage["latestRequestRate"] {
  const requestMs = ttftMs === null || streamingMs === null ? null : ttftMs + streamingMs;
  const bufferedTail =
    requestMs !== null &&
    requestMs > 0 &&
    streamingMs !== null &&
    streamingMs < 1_500 &&
    streamingMs / requestMs < 0.06 &&
    outputTokens >= 500;
  const streamed =
    streamingMs !== null && streamingMs >= 500 && outputTokens >= 20 && !bufferedTail;
  const elapsedMs = streamed ? streamingMs : requestMs;
  return outputTokens > 0 && elapsedMs !== null && elapsedMs > 0
    ? {
        tokensPerSecond: Number(((outputTokens * 1_000) / elapsedMs).toFixed(1)),
        timing: streamed ? "stream" : "request",
      }
    : null;
}

function decodeRequest(bytes: Uint8Array) {
  const chat = nested(fields(bytes), 1);
  const usage = nested(chat, 4);
  const inputTokens = numberAt(usage, 2) + numberAt(usage, 5);
  const outputTokens = numberAt(usage, 3);
  if (inputTokens === 0 && outputTokens === 0) return undefined;

  let requestId = "";
  for (const attribute of chat.get(20) ?? []) {
    if (!(attribute instanceof Uint8Array)) continue;
    const entry = fields(attribute);
    if (textAt(entry, 1) === "request_id") {
      requestId = textAt(entry, 2);
      break;
    }
  }
  return {
    requestId,
    inputTokens,
    outputTokens,
    rate: requestRate(outputTokens, durationMs(chat, 11), durationMs(chat, 12)),
  };
}

function readGenerations<A>(
  path: string,
  read: (database: NodeSqlite.DatabaseSync) => A,
): A | undefined {
  const database = new NodeSqlite.DatabaseSync(path, { readOnly: true });
  try {
    return database
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'gen_metadata'")
      .get() === undefined
      ? undefined
      : read(database);
  } finally {
    database.close();
  }
}

/**
 * Snapshot the native session's generation index before the first prompt. Each poll
 * reads only newer rows in that account's session, without walking other conversations.
 */
export const watchAntigravityTurnUsage = (profileDirectory: string, sessionId: string) =>
  Effect.tryPromise({
    try: async () => {
      if (!/^[\w-]+$/.test(sessionId)) return undefined;
      const root = await antigravityProfileRoot(profileDirectory);
      if (root === undefined) return undefined;
      const segments = [...conversationSegments, `${sessionId}.db`];
      const original = await antigravityManagedPath(root, segments, "file");
      if (original === undefined) {
        // Allow the runtime to create a new file, but never baseline against an unverified one.
        const missing = await NodeFSP.lstat(NodePath.join(root, ...segments)).then(
          () => false,
          (error: NodeJS.ErrnoException) => error.code === "ENOENT",
        );
        if (!missing) return undefined;
      }
      let identity = original?.info;
      let lastIndex =
        original === undefined
          ? -1
          : (readGenerations(original.path, (db) => {
              const index = db.prepare("SELECT max(idx) AS idx FROM gen_metadata").get()?.idx;
              return typeof index === "number" ? index : -1;
            }) ?? -1);
      const seenRequests = new Set<string>();
      let latest: OrchestrationV2RecordedModelUsage | undefined;

      return Effect.tryPromise({
        try: async () => {
          const file = await antigravityManagedPath(root, segments, "file");
          if (
            file === undefined ||
            (identity !== undefined &&
              (file.info.dev !== identity.dev || file.info.ino !== identity.ino))
          ) {
            return latest;
          }
          identity ??= file.info;
          readGenerations(file.path, (db) => {
            const rows = db
              .prepare("SELECT idx, data FROM gen_metadata WHERE idx > ? ORDER BY idx")
              .iterate(lastIndex);
            for (const { idx, data } of rows) {
              if (typeof idx !== "number") continue;
              lastIndex = idx;
              if (!(data instanceof Uint8Array)) continue;
              let request: ReturnType<typeof decodeRequest>;
              try {
                request = decodeRequest(data);
              } catch {
                // A malformed record should not hide subsequent requests.
                continue;
              }
              if (request === undefined || seenRequests.has(request.requestId)) continue;
              if (request.requestId) seenRequests.add(request.requestId);
              latest = {
                inputTokens: (latest?.inputTokens ?? 0) + request.inputTokens,
                outputTokens: (latest?.outputTokens ?? 0) + request.outputTokens,
                latestRequestRate: request.rate ?? latest?.latestRequestRate ?? null,
              };
            }
          });
          return latest;
        },
        catch: () => undefined,
      }).pipe(Effect.orElseSucceed(() => latest));
    },
    catch: () => undefined,
  }).pipe(Effect.orElseSucceed(() => undefined));
