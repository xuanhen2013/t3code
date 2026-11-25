import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import * as ServerConfig from "../config.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as AnalyticsService from "./AnalyticsService.ts";

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))("AnalyticsService", (it) => {
  it.effect("discards analytics even with an enabled legacy configuration", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-analytics-disabled-" });
      const requests: Array<string> = [];
      const client = HttpClient.make((request) =>
        Effect.sync(() => {
          requests.push(request.url);
          return HttpClientResponse.fromWeb(request, new Response(null, { status: 204 }));
        }),
      );
      const analyticsLayer = AnalyticsService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            ServerConfig.ServerConfig.layerTest(home, { prefix: "t3-analytics-config-" }),
            Layer.succeed(HostProcess.HomeDirectory, home),
            Layer.succeed(HttpClient.HttpClient, client),
            ManagedPolicy.layerTest(),
          ),
        ),
        Layer.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({
              T3CODE_TELEMETRY_ENABLED: true,
              T3CODE_POSTHOG_KEY: "test-key",
              T3CODE_POSTHOG_HOST: "http://localhost",
            }),
          ),
        ),
      );

      yield* Effect.gen(function* () {
        const analytics = yield* AnalyticsService.AnalyticsService;
        assert.isFalse(yield* analytics.record("server.boot.heartbeat", { threadCount: 1 }));
        yield* analytics.flush;
      }).pipe(Effect.provide(analyticsLayer));

      assert.deepEqual(requests, []);
    }),
  );
});
