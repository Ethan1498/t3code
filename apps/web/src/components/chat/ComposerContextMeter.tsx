import type { ContextWindowSnapshot } from "@t3tools/client-runtime/state/context-window";
import { useGT, useLocale, useMessages } from "gt-react";

import { formatContextWindowTokens } from "../../lib/contextWindow";
import { cn } from "../../lib/utils";
import { ComposerContextLabel } from "../ComposerContextLabel";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { formatContextWindowCompactionMessage } from "./compaction.logic";

const RING_RADIUS = 5;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/** The thread's context window in the strip under the composer: a ring, the tokens used, and details on hover. */
export function ComposerContextMeter({ usage }: { readonly usage: ContextWindowSnapshot }) {
  const gt = useGT();
  const m = useMessages();
  const locale = useLocale();
  const maxTokens = usage.maxTokens != null && usage.maxTokens > 0 ? usage.maxTokens : null;
  const used =
    maxTokens !== null && usage.usedPercentage !== null
      ? Math.round(Math.max(0, Math.min(100, usage.usedPercentage)))
      : null;
  const tone = used === null ? null : used >= 90 ? "error" : used >= 80 ? "warning" : null;
  const threshold = usage.autoCompactThreshold ?? null;
  const usedTokens = formatContextWindowTokens(usage.usedTokens);
  const label =
    maxTokens !== null ? `${usedTokens} / ${formatContextWindowTokens(maxTokens)}` : usedTokens;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            tabIndex={0}
            data-composer-context-control
            aria-label={
              used !== null
                ? gt("Context: {used}% used", { used })
                : gt("Context: {usedTokens} tokens used", { usedTokens })
            }
            className={cn(
              "inline-flex h-7 min-w-0 shrink-0 cursor-default items-center gap-1.5 rounded-md border border-transparent px-1.75 font-normal text-sm tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring sm:h-6 sm:text-xs",
              tone === "error"
                ? "text-error-foreground"
                : tone === "warning"
                  ? "text-warning-foreground"
                  : "text-muted-foreground/70",
            )}
          />
        }
      >
        <svg viewBox="0 0 14 14" className="size-3 -rotate-90" aria-hidden>
          <circle
            cx="7"
            cy="7"
            r={RING_RADIUS}
            fill="none"
            strokeWidth="2"
            className="stroke-current opacity-25"
          />
          {used !== null && used > 0 ? (
            <circle
              cx="7"
              cy="7"
              r={RING_RADIUS}
              fill="none"
              strokeWidth="2"
              strokeLinecap="round"
              strokeDasharray={RING_CIRCUMFERENCE}
              strokeDashoffset={RING_CIRCUMFERENCE * (1 - used / 100)}
              className="stroke-current"
            />
          ) : null}
        </svg>
        <ComposerContextLabel>{used !== null ? `${used}%` : label}</ComposerContextLabel>
      </TooltipTrigger>
      <TooltipPopup>
        <span className="flex flex-col gap-0.5">
          <span className="text-foreground">
            {used !== null
              ? gt("Context: {used}% used", { used })
              : gt("Context: {usedTokens} tokens used", { usedTokens })}
          </span>
          {maxTokens !== null ? (
            <span className="text-muted-foreground">
              {gt("{used} of {max} tokens", {
                used: usage.usedTokens.toLocaleString(locale),
                max: maxTokens.toLocaleString(locale),
              })}
            </span>
          ) : null}
          {threshold !== null && threshold > 0 ? (
            <span className="text-muted-foreground">
              {formatContextWindowCompactionMessage(threshold, m)}
            </span>
          ) : null}
        </span>
      </TooltipPopup>
    </Tooltip>
  );
}
