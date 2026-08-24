import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  pickFile: vi.fn(),
  copy: vi.fn(),
  delete: vi.fn(),
}));

vi.mock("expo-file-system", () => {
  class Directory {
    readonly uri: string;

    constructor(root: string, name: string) {
      this.uri = `${root}/${name}`;
    }

    create(): void {}
  }

  class File {
    static pickFileAsync = mocks.pickFile;

    readonly uri: string;

    constructor(source: string | Directory, name?: string) {
      this.uri = source instanceof Directory ? `${source.uri}/${name}` : source;
    }

    get exists(): boolean {
      return true;
    }

    async copy(destination: File): Promise<void> {
      mocks.copy(this.uri, destination.uri);
    }

    delete(): void {
      mocks.delete(this.uri);
    }
  }

  return { Directory, File, Paths: { document: "file:///documents" } };
});

vi.mock("./uuid", () => ({ uuidv4: () => "attachment-id" }));

import { pickComposerFiles, removePersistedComposerAttachmentFile } from "./composerImages";

describe("pickComposerFiles", () => {
  beforeEach(() => {
    mocks.pickFile.mockReset();
    mocks.copy.mockReset();
    mocks.delete.mockReset();
  });

  it("copies picked files into app-owned storage without loading their contents", async () => {
    mocks.pickFile.mockResolvedValue({
      canceled: false,
      result: [
        {
          uri: "file:///downloads/report.pdf",
          name: "report.pdf",
          type: "application/pdf",
          size: 42,
        },
      ],
    });

    await expect(pickComposerFiles({ existingCount: 0 })).resolves.toEqual({
      files: [
        {
          id: "attachment-id",
          type: "file",
          name: "report.pdf",
          mimeType: "application/pdf",
          sizeBytes: 42,
          fileUri: "file:///documents/t3-composer-attachments/attachment-id-report.pdf",
        },
      ],
      error: null,
    });
    expect(mocks.copy).toHaveBeenCalledWith(
      "file:///downloads/report.pdf",
      "file:///documents/t3-composer-attachments/attachment-id-report.pdf",
    );
  });

  it("rejects files that exceed the environment's advertised upload limit", async () => {
    mocks.pickFile.mockResolvedValue({
      canceled: false,
      result: [
        {
          uri: "file:///downloads/archive.zip",
          name: "archive.zip",
          type: "application/zip",
          size: 2 * 1024 * 1024,
        },
      ],
    });

    await expect(pickComposerFiles({ existingCount: 0, maxBytes: 1024 * 1024 })).resolves.toEqual({
      files: [],
      error: "'archive.zip' exceeds the 1 MB attachment limit.",
    });
    expect(mocks.copy).not.toHaveBeenCalled();
  });

  it("reports an empty file without calling it oversized", async () => {
    mocks.pickFile.mockResolvedValue({
      canceled: false,
      result: [
        {
          uri: "file:///downloads/empty.txt",
          name: "empty.txt",
          type: "text/plain",
          size: 0,
        },
      ],
    });

    await expect(pickComposerFiles({ existingCount: 0 })).resolves.toEqual({
      files: [],
      error: "'empty.txt' is empty or could not be read.",
    });
  });

  it("uses the remaining slot for the first valid file after an oversized selection", async () => {
    mocks.pickFile.mockResolvedValue({
      canceled: false,
      result: [
        {
          uri: "file:///downloads/huge.zip",
          name: "huge.zip",
          type: "application/zip",
          size: 2 * 1024 * 1024,
        },
        {
          uri: "file:///downloads/report.pdf",
          name: "report.pdf",
          type: "application/pdf",
          size: 42,
        },
      ],
    });

    const result = await pickComposerFiles({ existingCount: 7, maxBytes: 1024 * 1024 });

    expect(result.files.map((file) => file.name)).toEqual(["report.pdf"]);
  });

  it("deletes app-owned attachments without touching user-owned files", async () => {
    await removePersistedComposerAttachmentFile(
      "file:///documents/t3-composer-attachments/report.pdf",
    );
    await removePersistedComposerAttachmentFile("file:///downloads/report.pdf");

    expect(mocks.delete).toHaveBeenCalledOnce();
    expect(mocks.delete).toHaveBeenCalledWith(
      "file:///documents/t3-composer-attachments/report.pdf",
    );
  });
});
