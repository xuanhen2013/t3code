import type {
  OrchestrationV2ProviderTurn,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { formatCount } from "@t3tools/shared/usageFormat";
import { useGT, useLocale } from "gt-react";
import { useEffect, useEffectEvent, useState } from "react";
import type { TimelineEntry } from "../../session-logic";
import { useAssistantMessageText } from "../../state/entities";
import { SharedTooltipTrigger } from "../ui/shared-tooltip";
import { timelineEntryStartsResponse } from "./MessagesTimeline.logic";

const UNAVAILABLE = "–";
const RATE_SAMPLE_MS = 500;

export function AssistantTurnMetrics({
  providerTurn,
  estimatedRate,
}: {
  providerTurn?: OrchestrationV2ProviderTurn | undefined;
  /** Null while the active stream has no sample. Omit it to show the recorded request rate. */
  estimatedRate?: number | null | undefined;
}) {
  const gt = useGT();
  const locale = useLocale();
  const reported = providerTurn?.turnTokenUsage;
  const usage =
    reported?.localCommand || reported?.usageStatus === "unavailable" ? undefined : reported;
  const recorded = providerTurn?.recordedModelUsage;
  const total = recorded
    ? recorded.inputTokens + recorded.outputTokens
    : usage?.usageStatus === "complete"
      ? usage.inputTokens + usage.outputTokens
      : undefined;
  const countLabel =
    total !== undefined
      ? gt("{count} tokens", { count: formatCount(total, locale) })
      : usage?.outputTokens !== undefined
        ? gt("{count} output tokens", { count: formatCount(usage.outputTokens, locale) })
        : gt("{count} tokens", { count: UNAVAILABLE });
  const countDescription = recorded
    ? gt("Input, cached input, and output tokens recorded so far for this turn")
    : total !== undefined
      ? gt("Main agent input and output tokens for this provider turn")
      : usage?.outputTokens !== undefined
        ? gt("Output tokens reported by the provider")
        : undefined;

  const rate = recorded?.latestRequestRate;
  const rateDescription =
    estimatedRate != null
      ? gt("Estimated from text received during the latest sample")
      : estimatedRate === undefined && rate
        ? rate.timing === "stream"
          ? gt("Latest measured request's output rate, excluding time to the first token")
          : gt("Latest measured request's output rate, including time to the first token")
        : undefined;
  const tokensPerSecond = estimatedRate === undefined ? rate?.tokensPerSecond : estimatedRate;
  const rateLabel =
    tokensPerSecond == null
      ? UNAVAILABLE
      : `${estimatedRate === undefined ? "" : "≈ "}${tokensPerSecond.toLocaleString(locale, {
          maximumFractionDigits: 1,
        })}`;

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
      <span>{gt("{rate} tok/s", { rate: rateLabel })}</span>
    </SharedTooltipTrigger>
  );
}

function estimateOutputTokens(text: string): number {
  // Use Agy PowerTools' text weights without rounding each short sample up.
  // https://github.com/WhiteBr1ck/agy-powertools/blob/e78501341b3158ac238ec2be9331d0a514028c16/lib/database.mjs#L61-L70
  const cjk = text.match(/[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uff00-\uffef]/g)?.length ?? 0;
  return cjk * 1.15 + (text.length - cjk) / 3.8;
}

function StreamingAssistantTurnMetrics({
  threadRef,
  itemId,
  text,
  providerTurn,
}: {
  threadRef: ScopedThreadRef | null;
  itemId: string | undefined;
  text: string;
  providerTurn: OrchestrationV2ProviderTurn | undefined;
}) {
  const liveText = useAssistantMessageText(threadRef, itemId);
  const readText = useEffectEvent(() => liveText ?? text);
  const [estimatedRate, setEstimatedRate] = useState<number | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- measure new stream text against the client clock at half-second intervals
  useEffect(() => {
    let previousText = readText();
    let sampledAt = performance.now();
    let previousSample: { tokens: number; elapsedMs: number } | undefined;
    const timer = window.setInterval(() => {
      const nextText = readText();
      const now = performance.now();
      const elapsedMs = now - sampledAt;
      const tokens = nextText.startsWith(previousText)
        ? estimateOutputTokens(nextText.slice(previousText.length))
        : 0;
      if (tokens > 0 && elapsedMs > 0) {
        const rate =
          ((tokens + (previousSample?.tokens ?? 0)) * 1_000) /
          (elapsedMs + (previousSample?.elapsedMs ?? 0));
        setEstimatedRate(Math.round(rate * 10) / 10);
        previousSample = { tokens, elapsedMs };
      } else {
        setEstimatedRate(null);
        previousSample = undefined;
      }
      previousText = nextText;
      sampledAt = now;
    }, RATE_SAMPLE_MS);
    return () => window.clearInterval(timer);
  }, []);

  return <AssistantTurnMetrics providerTurn={providerTurn} estimatedRate={estimatedRate} />;
}

export function LiveAssistantTurnMetrics({
  threadRef,
  runId,
  attemptId,
  timelineEntries,
  providerTurnsById,
}: {
  threadRef: ScopedThreadRef | null;
  runId: RunId | null;
  attemptId: RunAttemptId | null;
  timelineEntries: ReadonlyArray<TimelineEntry>;
  providerTurnsById: ReadonlyMap<ProviderTurnId, OrchestrationV2ProviderTurn>;
}) {
  const first = runId === null ? timelineEntries.findLastIndex(timelineEntryStartsResponse) + 1 : 0;
  const reply = timelineEntries.findLast(
    (entry, index): entry is Extract<TimelineEntry, { kind: "message" }> =>
      index >= first &&
      entry.kind === "message" &&
      entry.message.role === "assistant" &&
      entry.message.runId === runId,
  );
  const replyTurnId = reply?.projectedItem?.item.providerTurnId;
  let providerTurn =
    attemptId === null && replyTurnId != null ? providerTurnsById.get(replyTurnId) : undefined;
  if (attemptId !== null) {
    for (const turn of providerTurnsById.values()) {
      if (
        turn.runAttemptId === attemptId &&
        (!providerTurn || turn.ordinal > providerTurn.ordinal)
      ) {
        providerTurn = turn;
      }
    }
  }

  if (reply === undefined && providerTurn?.recordedModelUsage === undefined) return null;
  const streamingReply =
    reply?.message.streaming &&
    (providerTurn === undefined ||
      (providerTurn.id === replyTurnId && providerTurn.status === "running"))
      ? reply
      : undefined;
  return (
    <div className="messages-timeline-row-frame">
      <div className="chat-content-lane">
        <div className="flex items-center px-1 pt-1.5 pb-4 text-xs tabular-nums">
          {streamingReply ? (
            <StreamingAssistantTurnMetrics
              key={streamingReply.projectedItem?.item.id ?? streamingReply.id}
              threadRef={threadRef}
              itemId={streamingReply.projectedItem?.item.id}
              text={streamingReply.message.text}
              providerTurn={providerTurn}
            />
          ) : (
            <AssistantTurnMetrics providerTurn={providerTurn} />
          )}
        </div>
      </div>
    </div>
  );
}
