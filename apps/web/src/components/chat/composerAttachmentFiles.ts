import { isProviderSendTurnSupportedImageMimeType } from "@t3tools/contracts";

import { isHeicImageFile } from "../../lib/imageCompression";

type ComposerAttachmentFileKind = "image" | "file" | "unsupported-image";

export function classifyComposerAttachmentFile(
  file: Pick<File, "name" | "type">,
): ComposerAttachmentFileKind {
  if (isHeicImageFile(file)) {
    return "image";
  }
  if (!file.type.toLowerCase().startsWith("image/")) {
    return "file";
  }
  return isProviderSendTurnSupportedImageMimeType(file.type) ? "image" : "unsupported-image";
}

export function shouldHandleComposerAttachmentPaste(input: {
  readonly files: ReadonlyArray<File>;
  readonly plainText: string;
  readonly maxFileAttachmentBytes: number | null;
  readonly remainingAttachmentSlots: number;
}): boolean {
  if (input.remainingAttachmentSlots <= 0) {
    return false;
  }

  if (input.files.some((file) => classifyComposerAttachmentFile(file) === "image")) {
    return true;
  }

  const maxFileAttachmentBytes = input.maxFileAttachmentBytes;
  if (input.plainText.length > 0 || maxFileAttachmentBytes === null) {
    return false;
  }

  return input.files.some(
    (file) =>
      classifyComposerAttachmentFile(file) === "file" &&
      file.size > 0 &&
      file.size <= maxFileAttachmentBytes,
  );
}
