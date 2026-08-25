import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import {
  executeAtomQuery,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  ChatFileAttachment,
  EnvironmentId,
  UploadChatImageAttachment,
} from "@t3tools/contracts";
import { AssetAttachmentNotFoundError } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { appAtomRegistry } from "../state/atom-registry";
import { assetEnvironment } from "../state/assets";
import { attachmentEnvironment } from "../state/attachments";
import { environmentSession } from "../state/session";
import { toUploadChatImageAttachments, type DraftComposerAttachment } from "./composerImages";

export type UploadedMobileAttachment = UploadChatImageAttachment | ChatFileAttachment;
const isAssetAttachmentNotFound = Schema.is(AssetAttachmentNotFoundError);

/** Keep uploaded file ids on durable drafts so a later send can reuse their bytes. */
export function withUploadedMobileAttachmentReferences(input: {
  readonly environmentId: EnvironmentId;
  readonly attachments: ReadonlyArray<DraftComposerAttachment>;
  readonly uploadedAttachments: ReadonlyArray<UploadedMobileAttachment>;
}): ReadonlyArray<DraftComposerAttachment> {
  return input.attachments.map((attachment, index) => {
    const uploaded = input.uploadedAttachments[index];
    if (
      attachment.type !== "file" ||
      uploaded?.type !== "file" ||
      (attachment.uploadedAttachmentId === uploaded.id &&
        attachment.uploadEnvironmentId === input.environmentId)
    ) {
      return attachment;
    }
    return {
      ...attachment,
      uploadedAttachmentId: uploaded.id,
      uploadEnvironmentId: input.environmentId,
    };
  });
}

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
  const createdAttachmentIds: string[] = [];
  try {
    for (const attachment of input.attachments) {
      if (attachment.type === "image") {
        uploadedAttachments.push(...toUploadChatImageAttachments([attachment]));
        continue;
      }

      if (
        attachment.uploadEnvironmentId === input.environmentId &&
        attachment.uploadedAttachmentId
      ) {
        const verified = await executeAtomQuery(
          appAtomRegistry,
          assetEnvironment.createUrl({
            environmentId: input.environmentId,
            input: {
              resource: { _tag: "attachment", attachmentId: attachment.uploadedAttachmentId },
            },
          }),
          { reportFailure: false, reportDefect: false },
        );
        if (verified._tag === "Success") {
          pendingAttachmentIds.push(attachment.uploadedAttachmentId);
          uploadedAttachments.push({
            type: "file",
            id: attachment.uploadedAttachmentId,
            name: attachment.name,
            mimeType: attachment.mimeType,
            sizeBytes: attachment.sizeBytes,
          });
          continue;
        }

        const error = squashAtomCommandFailure(verified);
        if (
          !isAssetAttachmentNotFound(error) &&
          !(
            typeof error === "object" &&
            error !== null &&
            "_tag" in error &&
            error._tag === "AssetAttachmentNotFoundError"
          )
        ) {
          throw error;
        }
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
      createdAttachmentIds.push(issued.value.attachmentId);

      const currentConnection = appAtomRegistry.get(
        environmentSession.preparedConnectionValueAtom(input.environmentId),
      );
      if (Option.isNone(currentConnection)) {
        throw new Error("The environment disconnected before the attachment could upload.");
      }
      const url = resolveAssetUrl(currentConnection.value.httpBaseUrl, issued.value.relativeUrl);
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
    await deletePendingMobileAttachments(input.environmentId, createdAttachmentIds);
    throw error;
  }
}
