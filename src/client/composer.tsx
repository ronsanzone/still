import { useLayoutEffect, useRef, type KeyboardEvent } from "react";
import {
  ArrowUp,
  ChevronDown,
  FileText,
  Globe,
  Image,
  MessageSquare,
  ShieldAlert,
  Square,
  X,
} from "lucide-react";
import type { Grant, ModelChoice } from "../shared/contracts.ts";
import type { AttachmentUpload } from "../shared/attachments.ts";
import { AttachmentChooser } from "./attachments.tsx";
import { formatCost, kits, shortModel } from "./format.ts";

const kitIcons = { chat: MessageSquare, research: Globe, still: ShieldAlert };

export interface ComposerProps {
  readonly draft: string;
  readonly onDraft: (value: string) => void;
  readonly models: readonly ModelChoice[];
  readonly model: string;
  readonly onModel: (value: string) => void;
  readonly kit: Grant["kit"];
  readonly onKit: (value: Grant["kit"]) => void;
  /** New chats cannot request Still authority; the supervisor creates those. */
  readonly canChooseStill: boolean;
  readonly cost: number;
  readonly busy: boolean;
  readonly queued: number;
  readonly whenBusy: "followUp" | "steer";
  readonly onWhenBusy: (value: "followUp" | "steer") => void;
  readonly uploads: readonly AttachmentUpload[];
  readonly onUploads: (uploads: readonly AttachmentUpload[]) => void;
  readonly onPreparing: (busy: boolean) => void;
  readonly preparing: boolean;
  readonly locked: boolean;
  readonly pending: boolean;
  readonly sending: boolean;
  readonly reusing: boolean;
  readonly onSend: () => void;
  readonly onStop: () => void;
  readonly onError: (message: string) => void;
}

/** Enter sends with a keyboard; touch keyboards keep Enter for new lines. */
export function sendsOnEnter(
  event: Pick<KeyboardEvent, "key" | "shiftKey" | "metaKey" | "ctrlKey">,
  finePointer: boolean,
) {
  if (event.key !== "Enter") return false;

  if (event.metaKey || event.ctrlKey) return true;

  return finePointer && !event.shiftKey;
}

export function Composer(props: ComposerProps) {
  const field = useRef<HTMLTextAreaElement>(null);
  const KitIcon = kitIcons[props.kit];

  useLayoutEffect(() => {
    const node = field.current;

    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${Math.min(node.scrollHeight, 220)}px`;
  }, [props.draft]);

  const action = props.pending
    ? "Retry send"
    : props.busy
      ? props.whenBusy === "steer"
        ? "Steer"
        : "Queue"
      : "Send";

  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        props.onSend();
      }}
    >
      {props.busy && (
        <div className="busy-row">
          <div
            className="segmented"
            role="radiogroup"
            aria-label="While Still is answering"
          >
            {(["followUp", "steer"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                role="radio"
                aria-checked={props.whenBusy === mode}
                onClick={() => props.onWhenBusy(mode)}
              >
                {mode === "steer" ? "Steer" : "Queue"}
              </button>
            ))}
          </div>
          <span className="busy-hint">
            {props.whenBusy === "steer"
              ? "Joins the current answer at the next step"
              : "Sends after this answer"}
          </span>
          {props.queued > 0 && (
            <span className="badge">{props.queued} queued</span>
          )}
        </div>
      )}
      {props.uploads.length > 0 && (
        <ul className="pending-uploads" aria-label="Files to send">
          {props.uploads.map((file, index) => (
            <li key={`${file.name}-${index}`}>
              {file.mimeType.startsWith("image/") ? (
                <Image size={14} aria-hidden="true" />
              ) : (
                <FileText size={14} aria-hidden="true" />
              )}
              <span>{file.name}</span>
              <button
                type="button"
                aria-label={`Remove ${file.name}`}
                onClick={() =>
                  props.onUploads(props.uploads.filter((_, at) => at !== index))
                }
              >
                <X size={14} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {props.reusing && (
        <p className="composer-note">
          Original attachments are kept in this branch.
        </p>
      )}
      <div className="field">
        <AttachmentChooser
          disabled={props.locked || props.pending}
          onPreparing={props.onPreparing}
          onError={props.onError}
          onAdmission={async (files) =>
            props.onUploads([...props.uploads, ...files])
          }
        />
        <textarea
          ref={field}
          aria-label="Message Still"
          placeholder={props.busy ? "Queue or steer…" : "Ask anything…"}
          value={props.draft}
          readOnly={props.sending || props.pending}
          maxLength={16000}
          rows={1}
          onChange={(event) => props.onDraft(event.target.value)}
          onKeyDown={(event) => {
            if (
              !event.nativeEvent.isComposing &&
              sendsOnEnter(event, matchMedia("(pointer: fine)").matches)
            ) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
        />
        {props.busy && (
          <button
            type="button"
            className="icon-button stop"
            aria-label="Stop answer"
            title="Stop"
            onClick={props.onStop}
          >
            <Square size={14} fill="currentColor" aria-hidden="true" />
          </button>
        )}
        <button
          className="send"
          type="submit"
          aria-label={action}
          title={action}
          disabled={
            !props.draft.trim() ||
            !props.model ||
            props.sending ||
            props.preparing
          }
        >
          <ArrowUp size={20} aria-hidden="true" />
        </button>
      </div>
      <div className="context-bar">
        <label className={`chip ${props.model ? "" : "is-empty"}`}>
          <span className="chip-text" aria-hidden="true">
            {props.model ? shortModel(props.model) : "Choose a model"}
          </span>
          <select
            aria-label="Model"
            value={props.model}
            disabled={props.locked || props.pending}
            onChange={(event) => props.onModel(event.target.value)}
          >
            <option value="">Choose a model</option>
            {props.models.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
          <ChevronDown size={14} aria-hidden="true" />
        </label>
        <label className={`chip kit-${props.kit}`}>
          <KitIcon size={14} aria-hidden="true" />
          <span className="chip-text" aria-hidden="true">
            {kits[props.kit].label}
          </span>
          <select
            aria-label="Kit"
            value={props.kit}
            disabled={props.locked}
            onChange={(event) => {
              const value = event.target.value;

              if (value === "chat" || value === "research" || value === "still")
                props.onKit(value);
            }}
          >
            {(["chat", "research", "still"] as const).map((kit) => (
              <option
                key={kit}
                value={kit}
                disabled={kit === "still" && !props.canChooseStill}
              >
                {kits[kit].label} · {kits[kit].authority}
              </option>
            ))}
          </select>
          <ChevronDown size={14} aria-hidden="true" />
        </label>
        <span
          className="cost"
          title="Reported by the provider; not a billing guarantee"
        >
          {formatCost(props.cost)}
          <span className="visually-hidden"> reported cost</span>
        </span>
      </div>
    </form>
  );
}
