import { describe, expect, it } from "vite-plus/test";

import {
  classifyComposerAttachmentFile,
  shouldHandleComposerAttachmentPaste,
} from "./composerAttachmentFiles";

describe("composer attachment files", () => {
  it("keeps supported images and HEIC photos on the image path", () => {
    expect(classifyComposerAttachmentFile({ name: "photo.png", type: "image/png" })).toBe("image");
    expect(classifyComposerAttachmentFile({ name: "photo.heic", type: "" })).toBe("image");
  });

  it("rejects unsupported image types instead of attaching them as generic files", () => {
    expect(classifyComposerAttachmentFile({ name: "diagram.svg", type: "image/svg+xml" })).toBe(
      "unsupported-image",
    );
    expect(classifyComposerAttachmentFile({ name: "photo.tiff", type: "image/tiff" })).toBe(
      "unsupported-image",
    );
    expect(classifyComposerAttachmentFile({ name: "report.pdf", type: "application/pdf" })).toBe(
      "file",
    );
  });

  it("preserves text paste when an application adds a synthetic generic file", () => {
    const file = new File(["clipboard"], "clipboard.rtf", { type: "application/rtf" });

    expect(
      shouldHandleComposerAttachmentPaste({
        files: [file],
        plainText: "Copied text",
        maxFileAttachmentBytes: 50 * 1024 * 1024,
        remainingAttachmentSlots: 1,
      }),
    ).toBe(false);
  });

  it("only claims generic file pastes accepted by the current server", () => {
    const file = new File(["report"], "report.pdf", { type: "application/pdf" });
    const input = {
      files: [file],
      plainText: "",
      remainingAttachmentSlots: 1,
    };

    expect(shouldHandleComposerAttachmentPaste({ ...input, maxFileAttachmentBytes: null })).toBe(
      false,
    );
    expect(shouldHandleComposerAttachmentPaste({ ...input, maxFileAttachmentBytes: 1 })).toBe(
      false,
    );
    expect(shouldHandleComposerAttachmentPaste({ ...input, maxFileAttachmentBytes: 10 })).toBe(
      true,
    );
  });

  it("claims image pastes even when clipboard text is present", () => {
    const image = new File(["image"], "photo.heic", { type: "image/heic" });

    expect(
      shouldHandleComposerAttachmentPaste({
        files: [image],
        plainText: "Image caption",
        maxFileAttachmentBytes: null,
        remainingAttachmentSlots: 1,
      }),
    ).toBe(true);
  });
});
