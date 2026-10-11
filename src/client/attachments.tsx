import { useRef, useState, type ChangeEvent } from "react";
import { Schema } from "effect";
import { FileText, Paperclip } from "lucide-react";
import {
  AttachmentUpload,
  type AttachmentMetadata,
} from "../shared/attachments.ts";

/** Browser/framework boundary; admission remains the server's responsibility. */
export async function prepareAttachment(file: File): Promise<AttachmentUpload> {
  let blob: Blob = file;
  let mimeType = file.type;

  if (["image/png", "image/jpeg", "image/webp"].includes(mimeType)) {
    const image = await createImageBitmap(file, {
      imageOrientation: "from-image",
    });

    try {
      const scale = Math.min(1, 1600 / Math.max(image.width, image.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(image.width * scale));
      canvas.height = Math.max(1, Math.round(image.height * scale));
      const context = canvas.getContext("2d");

      if (!context) throw new Error("Image conversion unavailable");
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      blob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob((result) => {
          if (result) resolve(result);
          else reject(new Error("Image conversion failed"));
        }, "image/png"),
      );
      mimeType = "image/png";
    } finally {
      image.close();
    }
  }

  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const result = Schema.decodeUnknownSync(Schema.String)(reader.result);
        resolve(result.slice(result.indexOf(",") + 1));
      } catch {
        reject(new Error("File read failed"));
      }
    };

    reader.onerror = () => reject(new Error("File read failed"));
    reader.readAsDataURL(blob);
  });

  return Schema.decodeUnknownSync(AttachmentUpload)({
    name: file.name,
    mimeType,
    data,
  });
}

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;

  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;

  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function AttachmentDisplay({
  attachments,
}: {
  readonly attachments: readonly AttachmentMetadata[];
}) {
  return (
    <ul className="file-list" aria-label="Attachments">
      {attachments.map((attachment, index) => (
        <li key={`${attachment.sha256}-${index}`}>
          <FileText size={16} aria-hidden="true" />
          <span>{attachment.name}</span>
          <small>{formatBytes(attachment.bytes)}</small>
        </li>
      ))}
    </ul>
  );
}

/** A real button opens a visually hidden input, so it stays in the tab order. */
export function AttachmentChooser({
  onAdmission,
  onPreparing,
  onError,
  disabled = false,
}: {
  readonly onAdmission: (uploads: readonly AttachmentUpload[]) => Promise<void>;
  readonly onPreparing: (busy: boolean) => void;
  readonly onError: (message: string) => void;
  readonly disabled?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  async function choose(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = "";
    setBusy(true);
    onPreparing(true);

    try {
      await onAdmission(await Promise.all(files.map(prepareAttachment)));
    } catch {
      onError(
        "Could not admit attachments. Choose a supported image, PDF, or UTF-8 text file.",
      );
    } finally {
      setBusy(false);
      onPreparing(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className={`icon-button attach ${busy ? "is-busy" : ""}`}
        aria-label={busy ? "Preparing attachments" : "Attach files"}
        title="Attach image, PDF or text"
        disabled={disabled || busy}
        onClick={() => input.current?.click()}
      >
        <Paperclip size={20} aria-hidden="true" />
      </button>
      <input
        ref={input}
        className="visually-hidden"
        type="file"
        multiple
        tabIndex={-1}
        aria-hidden="true"
        accept="image/png,image/jpeg,image/webp,application/pdf,text/plain"
        disabled={disabled || busy}
        onChange={choose}
      />
    </>
  );
}
