import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import type {
  ChatFileAttachment,
  EnvironmentId,
  UploadChatImageAttachment,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";

import { appAtomRegistry } from "../state/atom-registry";
import { attachmentEnvironment } from "../state/attachments";
import { environmentSession } from "../state/session";
import { toUploadChatImageAttachments, type DraftComposerAttachment } from "./composerImages";

export type UploadedMobileAttachment = UploadChatImageAttachment | ChatFileAttachment;

export async function deletePendingMobileAttachments(
  environmentId: EnvironmentId,
  attachmentIds: ReadonlyArray<string>,
): Promise<void> {
  await Promise.all(
    attachmentIds.map((attachmentId) =>
      runAtomCommand(
        appAtomRegistry,
        attachmentEnvironment.remove,
        { environmentId, input: { attachmentId } },
        { reportFailure: false, reportDefect: false },
      ),
    ),
  );
}

export async function uploadMobileAttachments(input: {
  readonly environmentId: EnvironmentId;
  readonly attachments: ReadonlyArray<DraftComposerAttachment>;
}): Promise<{
  readonly attachments: ReadonlyArray<UploadedMobileAttachment>;
  readonly pendingAttachmentIds: ReadonlyArray<string>;
}> {
  const files = input.attachments.filter((attachment) => attachment.type === "file");
  if (files.length === 0) {
    return {
      attachments: toUploadChatImageAttachments(
        input.attachments.filter((attachment) => attachment.type === "image"),
      ),
      pendingAttachmentIds: [],
    };
  }

  const connection = appAtomRegistry.get(
    environmentSession.preparedConnectionValueAtom(input.environmentId),
  );
  if (Option.isNone(connection)) {
    throw new Error("The environment is not connected.");
  }

  const { File, UploadType } = await import("expo-file-system");
  const uploadedAttachments: UploadedMobileAttachment[] = [];
  const pendingAttachmentIds: string[] = [];
  try {
    for (const attachment of input.attachments) {
      if (attachment.type === "image") {
        uploadedAttachments.push(...toUploadChatImageAttachments([attachment]));
        continue;
      }

      const issued = await runAtomCommand(
        appAtomRegistry,
        attachmentEnvironment.createUploadUrl,
        {
          environmentId: input.environmentId,
          input: {
            type: "file",
            name: attachment.name,
            mimeType: attachment.mimeType,
            sizeBytes: attachment.sizeBytes,
          },
        },
        { reportFailure: false },
      );
      if (issued._tag !== "Success") {
        throw Cause.squash(issued.cause);
      }
      pendingAttachmentIds.push(issued.value.attachmentId);

      const url = resolveAssetUrl(connection.value.httpBaseUrl, issued.value.relativeUrl);
      if (!url) {
        throw new Error(`Could not resolve the upload URL for '${attachment.name}'.`);
      }
      const result = await new File(attachment.fileUri).upload(url, {
        httpMethod: "POST",
        uploadType: UploadType.BINARY_CONTENT,
        headers: { "Content-Type": attachment.mimeType },
      });
      if (result.status < 200 || result.status >= 300) {
        throw new Error(`Upload failed for '${attachment.name}' (${result.status}).`);
      }

      uploadedAttachments.push({
        type: "file",
        id: issued.value.attachmentId,
        name: attachment.name,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
      });
    }
    return { attachments: uploadedAttachments, pendingAttachmentIds };
  } catch (error) {
    await deletePendingMobileAttachments(input.environmentId, pendingAttachmentIds);
    throw error;
  }
}
