import { expect, it } from "vite-plus/test";

import { visitElements } from "../../test/reactElementTree";
import { ThreadSyncStatusPill } from "./ThreadSyncStatusPill";

it("shows an accessible motion-safe activity indicator while messages synchronize", () => {
  const pill = ThreadSyncStatusPill({ phase: "syncing" });
  expect(pill.props.role).toBe("status");
  expect(pill.props["aria-live"]).toBe("polite");
  expect(pill.props["aria-label"]).toBe("Syncing messages...");

  const animatedIndicator = visitElements(
    pill,
    (element) =>
      typeof element.props.className === "string" &&
      element.props.className.includes("motion-safe:animate-spin"),
  );
  expect(animatedIndicator).not.toBeNull();
});
