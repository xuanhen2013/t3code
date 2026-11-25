import { afterEach, expect, it, vi } from "@effect/vitest";
import { withRelayClientTracing } from "@t3tools/shared/relayTracing";
import * as Effect from "effect/Effect";
// Load the runtime's module graph once outside the test timeout.
import "./runtime";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it.each([
  { surface: "desktop", desktopBridge: { getRelayTelemetryEnabled: () => true } },
  { surface: "browser", desktopBridge: undefined },
])(
  "keeps $surface traces in memory even when a Relay exporter is configured",
  async ({ desktopBridge }) => {
    vi.resetModules();
    vi.stubEnv("VITE_RELAY_OTLP_TRACES_URL", "https://telemetry.example.test/v1/traces");
    vi.stubEnv("VITE_RELAY_OTLP_TRACES_DATASET", "relay-test");
    vi.stubEnv("VITE_RELAY_OTLP_TRACES_TOKEN", "test-token");
    vi.stubGlobal("window", { desktopBridge });
    const fetchFn = vi.fn<typeof fetch>(async () => new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchFn);
    const { runtime } = await import("./runtime");

    try {
      const span = await runtime.runPromise(
        Effect.currentSpan.pipe(Effect.withSpan("relay.first-operation"), withRelayClientTracing),
      );
      expect(span.name).toBe("relay.first-operation");
    } finally {
      await runtime.dispose();
    }

    expect(fetchFn).not.toHaveBeenCalled();
  },
);
