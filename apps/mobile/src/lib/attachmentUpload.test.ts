import { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  createUploadUrl: Symbol("create-upload-url"),
  removeUpload: Symbol("remove-upload"),
  preparedConnection: Symbol("prepared-connection"),
  runAtomCommand: vi.fn(),
  readAtom: vi.fn(),
  upload: vi.fn(),
}));

vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  runAtomCommand: mocks.runAtomCommand,
}));

vi.mock("../state/atom-registry", () => ({
  appAtomRegistry: { get: mocks.readAtom },
}));

vi.mock("../state/attachments", () => ({
  attachmentEnvironment: {
    createUploadUrl: mocks.createUploadUrl,
    remove: mocks.removeUpload,
  },
}));

vi.mock("../state/session", () => ({
  environmentSession: {
    preparedConnectionValueAtom: () => mocks.preparedConnection,
  },
}));

vi.mock("expo-file-system", () => ({
  File: class {
    constructor(readonly uri: string) {}

    upload(url: string, options: unknown) {
      return mocks.upload(this.uri, url, options);
    }
  },
  UploadType: { BINARY_CONTENT: 0 },
}));

vi.mock("./uuid", () => ({
  uuidv4: () => "attachment-id",
}));

import { uploadMobileAttachments } from "./attachmentUpload";
import type { DraftComposerAttachment } from "./composerImages";

const environmentId = EnvironmentId.make("environment-1");

const image = {
  id: "image-1",
  type: "image",
  name: "screenshot.png",
  mimeType: "image/png",
  sizeBytes: 3,
  dataUrl: "data:image/png;base64,YWJj",
  previewUri: "file:///images/screenshot.png",
} as const satisfies DraftComposerAttachment;

const file = {
  id: "file-1",
  type: "file",
  name: "report.pdf",
  mimeType: "application/pdf",
  sizeBytes: 42,
  fileUri: "file:///documents/report.pdf",
} as const satisfies DraftComposerAttachment;

describe("uploadMobileAttachments", () => {
  beforeEach(() => {
    mocks.runAtomCommand.mockReset();
    mocks.readAtom.mockReset();
    mocks.upload.mockReset();
    mocks.readAtom.mockReturnValue(Option.some({ httpBaseUrl: "https://environment.example/" }));
    mocks.runAtomCommand.mockImplementation(async (_registry: unknown, command: unknown) =>
      command === mocks.createUploadUrl
        ? {
            _tag: "Success",
            value: {
              attachmentId: "pending-00000000-0000-4000-8000-000000000001-pdf",
              relativeUrl: "/api/attachments/upload/signed",
              expiresAt: 1,
            },
          }
        : { _tag: "Success", value: undefined },
    );
    mocks.upload.mockResolvedValue({ status: 204, body: "", headers: {} });
  });

  it("keeps existing image attachments on the legacy wire path", async () => {
    await expect(uploadMobileAttachments({ environmentId, attachments: [image] })).resolves.toEqual(
      {
        attachments: [
          {
            type: "image",
            name: "screenshot.png",
            mimeType: "image/png",
            sizeBytes: 3,
            dataUrl: "data:image/png;base64,YWJj",
          },
        ],
        pendingAttachmentIds: [],
      },
    );
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it("uploads generic file bytes directly and keeps mixed attachment order", async () => {
    const result = await uploadMobileAttachments({
      environmentId,
      attachments: [file, image],
    });

    expect(mocks.upload).toHaveBeenCalledWith(
      "file:///documents/report.pdf",
      "https://environment.example/api/attachments/upload/signed",
      {
        httpMethod: "POST",
        uploadType: 0,
        headers: { "Content-Type": "application/pdf" },
      },
    );
    expect(result.attachments[0]).toEqual({
      type: "file",
      id: "pending-00000000-0000-4000-8000-000000000001-pdf",
      name: "report.pdf",
      mimeType: "application/pdf",
      sizeBytes: 42,
    });
    expect(result.attachments[1]?.type).toBe("image");
    expect(result.pendingAttachmentIds).toEqual([
      "pending-00000000-0000-4000-8000-000000000001-pdf",
    ]);
  });

  it("removes pending uploads when the native HTTP request fails", async () => {
    mocks.upload.mockResolvedValue({ status: 500, body: "failed", headers: {} });

    await expect(uploadMobileAttachments({ environmentId, attachments: [file] })).rejects.toThrow(
      "Upload failed for 'report.pdf' (500).",
    );
    expect(mocks.runAtomCommand).toHaveBeenCalledWith(
      expect.anything(),
      mocks.removeUpload,
      {
        environmentId,
        input: { attachmentId: "pending-00000000-0000-4000-8000-000000000001-pdf" },
      },
      expect.anything(),
    );
  });
});
