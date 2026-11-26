import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { makeAntigravityUsageProbe } from "./antigravityUsageLimits.ts";

const quotaOutput = (remaining: number, turns = 0) =>
  JSON.stringify({
    status: "SUCCESS",
    num_turns: turns,
    command: {
      name: "usage",
      data: {
        groups: [
          {
            name: "Gemini models",
            buckets: [
              {
                id: "gemini-5h",
                name: "5-hour",
                window: "5h",
                remaining_fraction: remaining,
                reset_time: "2026-11-26T14:00:00Z",
              },
              {
                id: "gemini-weekly",
                name: "Weekly",
                window: "weekly",
                remaining_fraction: 0.75,
              },
            ],
          },
        ],
      },
    },
  });

const prepareProfile = Effect.fn("AntigravityUsageTest.prepareProfile")(function* (
  signedIn: boolean,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const profile = yield* fs.makeTempDirectoryScoped({ prefix: "t3-antigravity-quota-" });
  if (signedIn) {
    const appData = path.join(profile, "antigravity-acp");
    yield* fs.makeDirectory(appData);
    yield* fs.writeFileString(path.join(appData, "antigravity-oauth-token"), "test marker");
  }
  return profile;
});

it.layer(NodeServices.layer)("Antigravity CLI quotas", (it) => {
  it.effect("reads each profile's independent quota windows", () =>
    Effect.gen(function* () {
      const first = yield* makeAntigravityUsageProbe({
        profileDirectory: yield* prepareProfile(true),
        authMethod: "oauth-personal",
        readQuota: Effect.succeed(quotaOutput(0.25)),
      });
      const second = yield* makeAntigravityUsageProbe({
        profileDirectory: yield* prepareProfile(true),
        authMethod: "oauth-personal",
        readQuota: Effect.succeed(quotaOutput(0.5)),
      });

      assert.deepEqual((yield* first.probe).windows, [
        {
          id: "gemini-5h",
          kind: "session",
          label: "Gemini models · 5-hour",
          usedPercent: 75,
          resetsAt: "2026-11-26T14:00:00.000Z",
          windowDurationMins: 300,
        },
        {
          id: "gemini-weekly",
          kind: "weekly",
          label: "Gemini models · Weekly",
          usedPercent: 25,
          windowDurationMins: 10080,
        },
      ]);
      assert.equal((yield* second.probe).windows[0]?.usedPercent, 50);
    }),
  );

  it.effect("does not launch the CLI for an unsigned profile", () =>
    Effect.gen(function* () {
      const usage = yield* makeAntigravityUsageProbe({
        profileDirectory: yield* prepareProfile(false),
        authMethod: "oauth-personal",
        readQuota: Effect.die("A signed-out profile cannot fall back to the system account."),
      });
      assert.equal((yield* usage.probe).unavailable?.reason, "unsupported");
    }),
  );

  it.effect("rejects a model response even if it contains a quota-shaped payload", () =>
    Effect.gen(function* () {
      const usage = yield* makeAntigravityUsageProbe({
        profileDirectory: yield* prepareProfile(true),
        authMethod: "oauth-personal",
        readQuota: Effect.succeed(quotaOutput(0.5, 1)),
      });
      assert.equal((yield* usage.probe).unavailable?.reason, "probeFailed");
    }),
  );
});
