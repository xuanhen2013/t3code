import type {
  OrchestrationV2ProviderTurn,
  OrchestrationV2TurnItem,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { formatCount } from "@t3tools/shared/usageFormat";
import * as DateTime from "effect/DateTime";
import { useGT, useLocale } from "gt-react";
import { useEffect, useRef, useState } from "react";
import type { TimelineEntry } from "../../session-logic";
import { useAssistantMessageText } from "../../state/entities";
import { SharedTooltipTrigger } from "../ui/shared-tooltip";
import { timelineEntryStartsResponse } from "./MessagesTimeline.logic";

const UNAVAILABLE = "–";
const RATE_WINDOW_MS = 4_000;
const MIN_SAMPLE_MS = 250;
const RATE_IDLE_MS = 1_500;
const MIN_REPLY_TOKENS = 20;
const MIN_REPLY_DURATION_MS = 500;

export function AssistantTurnMetrics({
  providerTurn,
  reply,
  estimatedRate,
}: {
  providerTurn?: OrchestrationV2ProviderTurn | undefined;
  reply?: OrchestrationV2TurnItem | undefined;
  /** Null before an active stream has a sample. Omit it to show the settled reply's rate. */
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

  const rate = estimatedRate === undefined ? recorded?.latestRequestRate : undefined;
  const replyRate =
    estimatedRate === undefined && !rate && !reported?.localCommand
      ? estimateCodexReplyRate(reply)
      : undefined;
  const measuredRateDescription = !rate
    ? undefined
    : rate.timing === "stream"
      ? gt("Latest measured request's output rate, excluding time to the first token")
      : gt("Latest measured request's output rate, including time to the first token");
  const rateDescription =
    estimatedRate != null
      ? gt("Estimated from text received during the latest sample")
      : replyRate !== undefined
        ? gt("Estimated average output rate for this reply's text")
        : measuredRateDescription;
  const approximateRate = estimatedRate ?? replyRate;
  const tokensPerSecond = approximateRate ?? rate?.tokensPerSecond;
  const rateLabel =
    tokensPerSecond == null
      ? UNAVAILABLE
      : `${approximateRate === undefined ? "" : "≈ "}${tokensPerSecond.toLocaleString(locale, {
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

function estimateCodexReplyRate(reply: OrchestrationV2TurnItem | undefined): number | undefined {
  if (
    reply?.type !== "assistant_message" ||
    reply.nativeItemRef?.driver !== "codex" ||
    reply.status !== "completed" ||
    reply.delivery === "async" ||
    reply.startedAt === null ||
    reply.completedAt === null
  ) {
    return undefined;
  }
  const elapsedMs =
    DateTime.toEpochMillis(reply.completedAt) - DateTime.toEpochMillis(reply.startedAt);
  if (elapsedMs < MIN_REPLY_DURATION_MS) return undefined;
  const tokens = estimateOutputTokens(reply.text);
  return tokens >= MIN_REPLY_TOKENS ? (tokens * 1_000) / elapsedMs : undefined;
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
  const currentText = liveText ?? text;
  const stream = useRef({
    text: "",
    tokens: 0,
    samples: [] as Array<{ at: number; tokens: number }>,
  });
  const [estimatedRate, setEstimatedRate] = useState<number | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- timestamp each visible text update and expire the rate when output goes quiet
  useEffect(() => {
    const state = stream.current;
    const previousText = state.text;
    if (previousText === currentText) return;
    state.text = currentText;
    const now = performance.now();
    const last = state.samples.at(-1);
    if (!currentText.startsWith(previousText) || (last && now - last.at >= RATE_IDLE_MS)) {
      state.samples = [];
      state.tokens = 0;
      setEstimatedRate(null);
    } else {
      state.tokens += estimateOutputTokens(currentText.slice(previousText.length));
    }

    state.samples = state.samples.filter((sample) => now - sample.at <= RATE_WINDOW_MS);
    if (state.samples.at(-1)?.at === now) state.samples.pop();
    const first = state.samples[0];
    if (first && now - first.at >= MIN_SAMPLE_MS) {
      setEstimatedRate(Math.round(((state.tokens - first.tokens) * 1_000) / (now - first.at)));
    }
    state.samples.push({ at: now, tokens: state.tokens });
    const timer = window.setTimeout(() => {
      state.samples = [];
      state.tokens = 0;
      setEstimatedRate(null);
    }, RATE_IDLE_MS);
    return () => window.clearTimeout(timer);
  }, [currentText]);

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
  const replyItem = reply?.projectedItem?.item;
  const replyTurnId = replyItem?.providerTurnId;
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
            <AssistantTurnMetrics providerTurn={providerTurn} reply={replyItem} />
          )}
        </div>
      </div>
    </div>
  );
}
