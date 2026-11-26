import type { AntigravitySettings, ServerProviderUsageWindow } from "@t3tools/contracts";
import {
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "@t3tools/provider-core/server/usageLimits";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

const QuotaBucket = Schema.Struct({
  id: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
  window: Schema.optional(Schema.String),
  remaining_fraction: Schema.optional(Schema.NullOr(Schema.Number)),
  reset_time: Schema.optional(Schema.NullOr(Schema.String)),
  disabled: Schema.optional(Schema.Boolean),
});
const CliUsage = Schema.Struct({
  status: Schema.Literal("SUCCESS"),
  num_turns: Schema.Literal(0),
  command: Schema.Struct({
    name: Schema.Literal("usage"),
    data: Schema.Struct({
      groups: Schema.Array(
        Schema.Struct({ name: Schema.NonEmptyString, buckets: Schema.Array(QuotaBucket) }),
      ),
    }),
  }),
});
const decodeCliUsage = Schema.decodeEffect(Schema.fromJsonString(CliUsage));

const quotaWindows = new Map<
  string,
  { readonly kind: ServerProviderUsageWindow["kind"]; readonly duration: number }
>([
  ["5h", { kind: "session", duration: 300 }],
  ["weekly", { kind: "weekly", duration: 10080 }],
]);

export const makeAntigravityUsageProbe = Effect.fn("makeAntigravityUsageProbe")(function* <
  E,
>(input: {
  readonly profileDirectory: string;
  readonly authMethod: AntigravitySettings["authMethod"];
  readonly readQuota: Effect.Effect<string | undefined, E>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const tokenPath = path.join(input.profileDirectory, "antigravity-acp", "antigravity-oauth-token");

  const read = Effect.fn("AntigravityUsageProbe.read")(function* () {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    if (input.authMethod !== "oauth-personal" && input.authMethod !== "oauth-business") {
      return makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
    }
    if (!(yield* fs.exists(tokenPath))) {
      return makeUnavailableUsageLimits({
        checkedAt,
        reason: "unsupported",
        message: "Sign in to this Antigravity instance to see its limits.",
      });
    }

    const output = yield* input.readQuota;
    if (output === undefined) {
      return makeUnavailableUsageLimits({
        checkedAt,
        reason: "unsupported",
        message: "Update Antigravity to see its usage limits.",
      });
    }
    const { command } = yield* decodeCliUsage(output);
    const windows = new Map<string, ServerProviderUsageWindow>();
    for (const group of command.data.groups) {
      for (const bucket of group.buckets) {
        const remaining = bucket.remaining_fraction;
        if (bucket.disabled || remaining == null || remaining < 0 || remaining > 1) continue;
        const window = quotaWindows.get(bucket.window ?? "");
        const reset = bucket.reset_time ? DateTime.make(bucket.reset_time) : Option.none();
        const resetsAt =
          Option.isSome(reset) && DateTime.toEpochMillis(reset.value) > 0
            ? DateTime.formatIso(reset.value)
            : undefined;
        windows.set(bucket.id, {
          id: bucket.id,
          label: `${group.name} · ${bucket.name}`,
          kind: window?.kind ?? "other",
          usedPercent: (1 - remaining) * 100,
          ...(window && { windowDurationMins: window.duration }),
          ...(resetsAt && { resetsAt }),
        });
      }
    }

    return windows.size
      ? makeUsageLimits({ checkedAt, windows: [...windows.values()] })
      : makeUnavailableUsageLimits({
          checkedAt,
          reason: "probeFailed",
          message: "Antigravity CLI did not report any usable quota windows.",
        });
  });

  const [probe, clear] = yield* Effect.cachedInvalidateWithTTL(
    read().pipe(
      Effect.timeout("20 seconds"),
      Effect.catch(() =>
        DateTime.now.pipe(
          Effect.map((now) =>
            makeUnavailableUsageLimits({
              checkedAt: DateTime.formatIso(now),
              reason: "probeFailed",
              message: "Could not read limits from the Antigravity CLI.",
            }),
          ),
        ),
      ),
    ),
    "1 minute",
  );
  return { probe, clear };
});
