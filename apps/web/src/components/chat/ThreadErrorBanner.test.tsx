import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  dismissThreadErrorBannerForSession,
  getActiveWriterRecovery,
  getThreadErrorBannerKey,
  getActiveWriterRecoveryMessageId,
  isThreadErrorBannerDismissedForSession,
  shouldShowThreadErrorBanner,
  ThreadErrorBanner,
} from "./ThreadErrorBanner";

describe("ThreadErrorBanner", () => {
  it("derives recovery only from the current active-writer error", () => {
    const activities = [
      {
        kind: "provider.thread.active-writer-conflict",
        payload: { messageId: "message-1", canFork: true },
      },
    ];

    expect(
      getActiveWriterRecoveryMessageId({
        sessionStatus: "error",
        error:
          "This Codex session is open in another client. Close it there and retry, or continue in a copy.",
        activities,
      }),
    ).toBe("message-1");
    expect(
      getActiveWriterRecoveryMessageId({
        sessionStatus: "starting",
        error: null,
        activities,
      }),
    ).toBeNull();
  });

  it("changes the recovery key when the same message conflicts again", () => {
    const input = {
      sessionStatus: "error",
      error:
        "This Codex session is open in another client. Close it there and retry, or continue in a copy.",
    };
    const first = getActiveWriterRecovery({
      ...input,
      activities: [
        {
          id: "conflict-1",
          kind: "provider.thread.active-writer-conflict",
          payload: { messageId: "message-1", canFork: true },
        },
      ],
    });
    const repeated = getActiveWriterRecovery({
      ...input,
      activities: [
        {
          id: "conflict-1",
          kind: "provider.thread.active-writer-conflict",
          payload: { messageId: "message-1", canFork: true },
        },
        {
          id: "conflict-2",
          kind: "provider.thread.active-writer-conflict",
          payload: { messageId: "message-1", canFork: true },
        },
      ],
    });

    expect(first).toEqual({ messageId: "message-1", conflictId: "conflict-1" });
    expect(repeated).toEqual({ messageId: "message-1", conflictId: "conflict-2" });
  });

  it("stays hidden after its current error is dismissed", () => {
    const bannerKey = getThreadErrorBannerKey("env:thread-a", "Aborted");
    dismissThreadErrorBannerForSession(bannerKey);

    expect(
      shouldShowThreadErrorBanner(
        "env:thread-a",
        "Aborted",
        isThreadErrorBannerDismissedForSession(bannerKey),
      ),
    ).toBe(false);
  });

  it("reappears when a new error arrives on the same thread", () => {
    dismissThreadErrorBannerForSession(getThreadErrorBannerKey("env:thread-b", "Turn failed"));
    const newErrorKey = getThreadErrorBannerKey("env:thread-b", "Provider crashed");

    expect(isThreadErrorBannerDismissedForSession(newErrorKey)).toBe(false);
    expect(
      shouldShowThreadErrorBanner(
        "env:thread-b",
        "Provider crashed",
        isThreadErrorBannerDismissedForSession(newErrorKey),
      ),
    ).toBe(true);
  });

  it("scopes dismissals to the thread that dismissed them", () => {
    dismissThreadErrorBannerForSession(getThreadErrorBannerKey("env:thread-c", "Aborted"));
    const otherThreadKey = getThreadErrorBannerKey("env:other-thread", "Aborted");

    expect(isThreadErrorBannerDismissedForSession(otherThreadKey)).toBe(false);
    expect(
      shouldShowThreadErrorBanner(
        "env:other-thread",
        "Aborted",
        isThreadErrorBannerDismissedForSession(otherThreadKey),
      ),
    ).toBe(true);
  });

  it("keeps a dismissal across visiting threads with no error", () => {
    const bannerKey = getThreadErrorBannerKey("env:thread-d", "Aborted");
    dismissThreadErrorBannerForSession(bannerKey);

    expect(shouldShowThreadErrorBanner("env:thread-d", null, false)).toBe(false);
    expect(isThreadErrorBannerDismissedForSession(bannerKey)).toBe(true);
    expect(
      shouldShowThreadErrorBanner(
        "env:thread-d",
        "Aborted",
        isThreadErrorBannerDismissedForSession(bannerKey),
      ),
    ).toBe(false);
  });

  it("never shows a null error", () => {
    expect(shouldShowThreadErrorBanner("env:thread-e", null, false)).toBe(false);
  });
  it("aligns the warning and dismiss icons with the first line of a multi-line error", () => {
    const markup = renderToStaticMarkup(
      <ThreadErrorBanner
        error={"The first error line\ncontinues on a second line"}
        onDismiss={() => {}}
      />,
    );

    expect(markup).toContain('role="alert"');
    expect(markup).toContain('aria-label="Dismiss error"');
    expect(markup).not.toContain("controlAlignment");
    expect(markup).toContain("flex gap-2 items-start");
    expect(markup).toContain("min-h-7 pt-1 sm:min-h-6 sm:pt-0.5");
    expect(markup).toContain("h-lh w-4");
    expect(markup).toContain("h-lh self-start");
  });

  it("explains how to release a Codex writer and offers retry or copy actions", () => {
    const markup = renderToStaticMarkup(
      <ThreadErrorBanner
        error="This Codex session is open in another client."
        activeWriterRecovery={{
          pending: false,
          onRetry: () => {},
          onFork: () => {},
        }}
      />,
    );

    expect(markup).toContain("Close the session in the Codex app or type /exit in its terminal");
    expect(markup).toContain("I&#x27;ve closed it — retry");
    expect(markup).toContain("Continue in a copy");
  });
});
