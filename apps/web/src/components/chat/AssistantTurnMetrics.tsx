import type { OrchestrationV2ProviderTurn } from "@t3tools/contracts";
import { formatCount } from "@t3tools/shared/usageFormat";
import { DateTime } from "effect";
import { useGT, useLocale } from "gt-react";
import { useEffect, useEffectEvent, useState } from "react";
import { SharedTooltipTrigger } from "../ui/shared-tooltip";

const textEncoder = new TextEncoder();
const RATE_SAMPLE_MS = 1_500;
const UNAVAILABLE = "–";

type Timing = Pick<OrchestrationV2ProviderTurn, "startedAt" | "completedAt">;

function averageRate(tokens: number | undefined, timing: Timing | undefined) {
  if (tokens === undefined || !timing?.startedAt || !timing.completedAt) return null;
  const elapsed =
    DateTime.toEpochMillis(timing.completedAt) - DateTime.toEpochMillis(timing.startedAt);
  return elapsed > 0 ? (tokens * 1_000) / elapsed : null;
}

export function AssistantTurnMetrics({
  text,
  streaming,
  pending,
  item,
  providerTurn,
}: {
  text: string;
  streaming: boolean;
  pending: boolean;
  item: Timing | undefined;
  providerTurn: OrchestrationV2ProviderTurn | undefined;
}) {
  const gt = useGT();
  const locale = useLocale();
  const usage = providerTurn?.turnTokenUsage;
  const modelUsage =
    usage?.localCommand || usage?.usageStatus === "unavailable" ? undefined : usage;
  const total =
    modelUsage?.usageStatus === "complete"
      ? modelUsage.inputTokens + modelUsage.outputTokens
      : undefined;
  const reportedOutput = modelUsage?.outputTokens;
  const estimatedOutput =
    text.length > 0 && !usage?.localCommand && (streaming || reportedOutput === undefined)
      ? textEncoder.encode(text).length / 4
      : undefined;
  const outputCount =
    reportedOutput !== undefined
      ? formatCount(reportedOutput, locale)
      : estimatedOutput !== undefined
        ? `≈ ${formatCount(Math.ceil(estimatedOutput), locale)}`
        : null;
  const countLabel =
    total !== undefined
      ? gt("{count} tokens", { count: formatCount(total, locale) })
      : outputCount !== null
        ? gt("{count} output tokens", { count: outputCount })
        : gt("{count} tokens", { count: UNAVAILABLE });
  const countDescription =
    total !== undefined
      ? gt("Main agent input and output tokens for this provider turn")
      : reportedOutput !== undefined
        ? gt("Output tokens reported by the provider")
        : estimatedOutput !== undefined
          ? gt("Output tokens estimated from this reply's text")
          : undefined;
  const average = !pending
    ? reportedOutput !== undefined
      ? averageRate(reportedOutput, providerTurn)
      : averageRate(estimatedOutput, item)
    : null;
  const averageLabel =
    average === null ? null : average.toLocaleString(locale, { maximumFractionDigits: 1 });
  const showStreamingRate = streaming && !usage?.localCommand;
  const rateDescription = showStreamingRate
    ? gt("Estimated from text received during the latest sample")
    : averageLabel === null
      ? undefined
      : reportedOutput !== undefined
        ? gt(
            "Average output rate across the provider turn, including time spent waiting or using tools",
          )
        : gt("Estimated average output rate for this reply's text");

  return (
    <SharedTooltipTrigger
      align="end"
      disabled={!countDescription && !rateDescription}
      render={
        <span className="ms-auto inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap text-muted-foreground" />
      }
      label={
        <div className="flex flex-col gap-1">
          {countDescription ? <div>{countDescription}</div> : null}
          {rateDescription ? <div>{rateDescription}</div> : null}
        </div>
      }
    >
      <span>{countLabel}</span>
      <span aria-hidden="true">·</span>
      {showStreamingRate ? (
        <StreamingRate text={text} estimatedOutput={estimatedOutput ?? 0} />
      ) : (
        <span>
          {averageLabel === null
            ? gt("{rate} tok/s", { rate: UNAVAILABLE })
            : gt("{rate} tok/s avg", {
                rate: reportedOutput === undefined ? `≈ ${averageLabel}` : averageLabel,
              })}
        </span>
      )}
    </SharedTooltipTrigger>
  );
}

function StreamingRate({ text, estimatedOutput }: { text: string; estimatedOutput: number }) {
  const gt = useGT();
  const locale = useLocale();
  const [rate, setRate] = useState<number | null>(null);
  const readOutput = useEffectEvent(() => ({ text, estimatedOutput }));

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- samples arriving text on the local clock, only while the reply is streaming
  useEffect(() => {
    let previous = readOutput();
    let sampledAt = performance.now();
    const timer = window.setInterval(() => {
      const next = readOutput();
      const now = performance.now();
      const elapsed = now - sampledAt;
      const added = next.estimatedOutput - previous.estimatedOutput;
      setRate(
        elapsed > 0 && added >= 0 && next.text.startsWith(previous.text)
          ? (added * 1_000) / elapsed
          : null,
      );
      previous = next;
      sampledAt = now;
    }, RATE_SAMPLE_MS);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <span>
      {gt("{rate} tok/s", {
        rate:
          rate === null
            ? UNAVAILABLE
            : `≈ ${rate.toLocaleString(locale, { maximumFractionDigits: 1 })}`,
      })}
    </span>
  );
}
