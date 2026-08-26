import { memo } from "react";
import { CODEX_ACTIVE_WRITER_CONFLICT_MESSAGE } from "@t3tools/contracts";
import { Alert, AlertAction, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { CircleAlertIcon, LoaderCircleIcon, XIcon } from "lucide-react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function getActiveWriterRecoveryMessageId(input: {
  sessionStatus: string | null | undefined;
  error: string | null | undefined;
  activities: ReadonlyArray<{ readonly kind: string; readonly payload: unknown }>;
}): string | null {
  if (input.sessionStatus !== "error" || input.error !== CODEX_ACTIVE_WRITER_CONFLICT_MESSAGE) {
    return null;
  }
  const conflict = input.activities.findLast(
    (activity) => activity.kind === "provider.thread.active-writer-conflict",
  );
  if (typeof conflict?.payload !== "object" || conflict.payload === null) {
    return null;
  }
  const payload = conflict.payload as Record<string, unknown>;
  return payload.canFork === true && typeof payload.messageId === "string"
    ? payload.messageId
    : null;
}

export function getThreadErrorBannerKey(threadKey: string, error: string | null): string | null {
  return error === null ? null : `${threadKey}\u0000${error}`;
}

export function shouldShowThreadErrorBanner(
  threadKey: string,
  error: string | null,
  isDismissed: boolean,
): boolean {
  return getThreadErrorBannerKey(threadKey, error) !== null && !isDismissed;
}

// Session-scoped (module-level so it survives ChatView remounts, e.g. route
// changes between threads). Mirrors the branch-mismatch banner: a dismissal
// is remembered per thread key plus message, so navigating away to a thread
// with no error cannot resurrect the banner, while a different error message
// on the same thread still appears.
const sessionDismissedThreadErrorBannerKeys = new Set<string>();

export function dismissThreadErrorBannerForSession(bannerKey: string | null): void {
  if (bannerKey !== null) {
    sessionDismissedThreadErrorBannerKeys.add(bannerKey);
  }
}

export function isThreadErrorBannerDismissedForSession(bannerKey: string | null): boolean {
  return bannerKey !== null && sessionDismissedThreadErrorBannerKeys.has(bannerKey);
}

export const ThreadErrorBanner = memo(function ThreadErrorBanner({
  error,
  onDismiss,
  activeWriterRecovery,
}: {
  error: string | null;
  onDismiss?: () => void;
  activeWriterRecovery?: {
    pending: boolean;
    onRetry: () => void;
    onFork: () => void;
  };
}) {
  if (!error) return null;
  return (
    <div className="mx-auto w-fit max-w-[min(48rem,calc(100%-2rem))] pt-3">
      <Alert variant="error" controlAlignment="first-line">
        <CircleAlertIcon />
        <AlertDescription>
          {activeWriterRecovery ? (
            <div className="space-y-2.5">
              <div>
                <div className="font-medium text-error-foreground">{error}</div>
                <div className="mt-1">
                  Close the session in the Codex app or type /exit in its terminal, then retry.
                  Continuing in a copy keeps the original session open and creates a separate Codex
                  thread.
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={activeWriterRecovery.pending}
                  onClick={activeWriterRecovery.onRetry}
                >
                  {activeWriterRecovery.pending ? (
                    <LoaderCircleIcon className="motion-safe:animate-spin" />
                  ) : null}
                  I've closed it — retry
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={activeWriterRecovery.pending}
                  onClick={activeWriterRecovery.onFork}
                >
                  Continue in a copy
                </Button>
              </div>
            </div>
          ) : (
            <Tooltip>
              <TooltipTrigger render={<div className="line-clamp-3" />}>{error}</TooltipTrigger>
              <TooltipPopup side="top" className="max-w-96 whitespace-pre-wrap">
                {error}
              </TooltipPopup>
            </Tooltip>
          )}
        </AlertDescription>
        {onDismiss && (
          <AlertAction>
            <Button variant="ghost" size="icon-xs" aria-label="Dismiss error" onClick={onDismiss}>
              <XIcon className="text-destructive" />
            </Button>
          </AlertAction>
        )}
      </Alert>
    </div>
  );
});
