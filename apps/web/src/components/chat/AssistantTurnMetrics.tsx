import type { OrchestrationV2ProviderTurn, RunId, ScopedThreadRef } from "@t3tools/contracts";
import { formatCount } from "@t3tools/shared/usageFormat";
import { DateTime } from "effect";
import { useGT, useLocale } from "gt-react";
import { useEffect, useEffectEvent, useState } from "react";
import type { TimelineEntry } from "../../session-logic";
import { readLiveThreadTurnItems } from "../../state/entities";
import { SharedTooltipTrigger } from "../ui/shared-tooltip";
import { timelineEntryStartsResponse } from "./MessagesTimeline.logic";

const textEncoder = new TextEncoder();
const RATE_SAMPLE_MS = 1_500;
const UNAVAILABLE = "–";

type Timing = Pick<OrchestrationV2ProviderTurn, "startedAt" | "completedAt">;

interface LiveOutputSample {
  readonly estimatedOutput: number;
  readonly rate: number | null;
}

function averageRate(tokens: number | undefined, timing: Timing | undefined) {
  if (tokens === undefined || !timing?.startedAt || !timing.completedAt) return null;
  const elapsed =
    DateTime.toEpochMillis(timing.completedAt) - DateTime.toEpochMillis(timing.startedAt);
  return elapsed > 0 ? (tokens * 1_000) / elapsed : null;
}

export function AssistantTurnMetrics({
  text = "",
  pending = false,
  item,
  providerTurn,
  live,
}: {
  text?: string;
  pending?: boolean;
  item?: Timing | undefined;
  providerTurn?: OrchestrationV2ProviderTurn | undefined;
  live?: LiveOutputSample;
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
    live === undefined
      ? text.length > 0 && !usage?.localCommand && reportedOutput === undefined
        ? textEncoder.encode(text).length / 4
        : undefined
      : live.estimatedOutput || undefined;
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
  const average =
    live === undefined && !pending
      ? reportedOutput !== undefined
        ? averageRate(reportedOutput, providerTurn)
        : averageRate(estimatedOutput, item)
      : null;
  const rate = live === undefined ? average : live.rate;
  const formattedRate =
    rate === null ? UNAVAILABLE : rate.toLocaleString(locale, { maximumFractionDigits: 1 });
  const rateLabel =
    rate !== null && reportedOutput === undefined ? `≈ ${formattedRate}` : formattedRate;
  const rateDescription =
    live !== undefined
      ? gt("Estimated from text received during the latest sample")
      : average === null
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
      <span>
        {average === null
          ? gt("{rate} tok/s", { rate: rateLabel })
          : gt("{rate} tok/s avg", { rate: rateLabel })}
      </span>
    </SharedTooltipTrigger>
  );
}

export function LiveAssistantTurnMetrics({
  threadRef,
  runId,
  timelineEntries,
}: {
  threadRef: ScopedThreadRef | null;
  runId: RunId | null;
  timelineEntries: ReadonlyArray<TimelineEntry>;
}) {
  const [sample, setSample] = useState<LiveOutputSample>({ estimatedOutput: 0, rate: null });
  const first = runId === null ? timelineEntries.findLastIndex(timelineEntryStartsResponse) + 1 : 0;
  const replyTexts = new Map<string, string>();
  for (let index = first; index < timelineEntries.length; index++) {
    const entry = timelineEntries[index]!;
    if (
      entry.kind === "message" &&
      entry.message.role === "assistant" &&
      entry.message.runId === runId
    ) {
      replyTexts.set(entry.projectedItem?.item.id ?? entry.id, entry.message.text);
    }
  }
  const readOutput = useEffectEvent(() => {
    if (threadRef === null || replyTexts.size === 0) return [...replyTexts.values()].join("");

    const texts = new Map(replyTexts);
    for (const { item } of readLiveThreadTurnItems(threadRef)) {
      if (item.type === "assistant_message" && texts.has(item.id)) texts.set(item.id, item.text);
    }
    return [...texts.values()].join("");
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- samples the live projection without re-rendering on each text chunk
  useEffect(() => {
    let previous = readOutput();
    let previousCount = textEncoder.encode(previous).length / 4;
    let sampledAt = performance.now();
    const timer = window.setInterval(() => {
      const text = readOutput();
      const estimatedOutput =
        text === previous ? previousCount : textEncoder.encode(text).length / 4;
      const now = performance.now();
      const elapsed = now - sampledAt;
      const rate =
        elapsed > 0 && estimatedOutput > 0 && text.startsWith(previous)
          ? ((estimatedOutput - previousCount) * 1_000) / elapsed
          : null;
      setSample((old) =>
        old.estimatedOutput === estimatedOutput && old.rate === rate
          ? old
          : { estimatedOutput, rate },
      );
      previous = text;
      previousCount = estimatedOutput;
      sampledAt = now;
    }, RATE_SAMPLE_MS);
    return () => window.clearInterval(timer);
  }, []);

  if (replyTexts.size === 0) return null;
  const estimatedOutput =
    sample.estimatedOutput || textEncoder.encode([...replyTexts.values()].join("")).length / 4;
  return (
    <div className="messages-timeline-row-frame">
      <div className="chat-content-lane">
        <div className="flex items-center px-1 pt-1.5 pb-4 text-xs tabular-nums">
          <AssistantTurnMetrics live={{ estimatedOutput, rate: sample.rate }} />
        </div>
      </div>
    </div>
  );
}
