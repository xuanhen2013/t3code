import type {
  OrchestrationV2ProviderTurn,
  ProviderTurnId,
  RunAttemptId,
  RunId,
} from "@t3tools/contracts";
import { formatCount } from "@t3tools/shared/usageFormat";
import { useGT, useLocale } from "gt-react";
import type { TimelineEntry } from "../../session-logic";
import { SharedTooltipTrigger } from "../ui/shared-tooltip";
import { timelineEntryStartsResponse } from "./MessagesTimeline.logic";

const UNAVAILABLE = "–";

export function AssistantTurnMetrics({
  providerTurn,
}: {
  providerTurn?: OrchestrationV2ProviderTurn | undefined;
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
  const rateDescription = rate
    ? rate.timing === "stream"
      ? gt("Latest measured request's output rate, excluding time to the first token")
      : gt("Latest measured request's output rate, including time to the first token")
    : undefined;
  const rateLabel = rate
    ? rate.tokensPerSecond.toLocaleString(locale, { maximumFractionDigits: 1 })
    : UNAVAILABLE;

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

export function LiveAssistantTurnMetrics({
  runId,
  attemptId,
  timelineEntries,
  providerTurnsById,
}: {
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
  return (
    <div className="messages-timeline-row-frame">
      <div className="chat-content-lane">
        <div className="flex items-center px-1 pt-1.5 pb-4 text-xs tabular-nums">
          <AssistantTurnMetrics providerTurn={providerTurn} />
        </div>
      </div>
    </div>
  );
}
