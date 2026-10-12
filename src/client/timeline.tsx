import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Download,
  FileText,
  GitBranch,
  Pencil,
  RotateCcw,
  TriangleAlert,
  Wrench,
} from "lucide-react";
import type { ChatSnapshot, Message } from "../shared/contracts.ts";
import { apiPath } from "./api.ts";
import { AttachmentDisplay } from "./attachments.tsx";
import { formatCost, shortModel } from "./format.ts";

type Tool = ChatSnapshot["tools"][number];

/** Tables, task lists, strikethrough and autolinks in answers. */
const gfm = [remarkGfm];

export type TimelineItem =
  | {
      readonly kind: "message";
      readonly key: string;
      readonly message: Message;
    }
  | {
      readonly kind: "work";
      readonly key: string;
      readonly tools: readonly Tool[];
    }
  | { readonly kind: "change"; readonly key: string; readonly text: string };

/**
 * Interleaves messages, tool results and kit/model changes by Pi entry id so
 * work appears beside the turn that produced it. The live message has no
 * entry yet and always sorts last.
 */
export function timeline(snapshot: ChatSnapshot): readonly TimelineItem[] {
  const visible = snapshot.messages.filter(
    (item) =>
      item.role !== "assistant" ||
      item.text ||
      item.thinking ||
      item.failed ||
      item.interrupted,
  );

  const ordered = [
    ...visible.map((message) => ({
      at: message.entry ?? Number.POSITIVE_INFINITY,
      item: { kind: "message", key: message.id, message } as const,
    })),
    ...snapshot.tools.map((tool, index) => ({
      at: Number(tool.id),
      item: {
        kind: "work",
        key: `${tool.id}-${index}`,
        tools: [tool],
      } as const,
    })),
    ...effectiveChanges(snapshot.changes).map((change) => ({
      at: change.id,
      item: {
        kind: "change",
        key: `change-${change.id}`,
        text: describeChange(change.text),
      } as const,
    })),
  ].sort((left, right) => left.at - right.at);

  const items: TimelineItem[] = [];

  for (const { item } of ordered) {
    const last = items.at(-1);

    if (item.kind === "work" && last?.kind === "work")
      items[items.length - 1] = {
        ...last,
        tools: [...last.tools, ...item.tools],
      };
    else items.push(item);
  }

  return items;
}

/**
 * Forks and new chats record a reset to Chat; showing it again when nothing
 * changed is noise. Keeps only changes that differ from the value in force.
 */
function effectiveChanges(changes: ChatSnapshot["changes"]) {
  const current = new Map([["Kit", "chat"]]);

  return changes.filter((change) => {
    const [field = "", ...rest] = change.text.split(": ");
    const value = rest.join(": ");

    if (current.get(field) === value) return false;
    current.set(field, value);

    return true;
  });
}

export function describeChange(text: string) {
  const [field, ...rest] = text.split(": ");
  const value = rest.join(": ");

  if (field === "Kit") return `Switched to ${kitLabel(value)} kit`;

  if (field === "Model") return `Model set to ${shortModel(value)}`;

  return text;
}

function kitLabel(kit: string) {
  return kit.charAt(0).toUpperCase() + kit.slice(1);
}

const toolVerbs = new Map<string, readonly [string, string]>([
  ["web_search", ["Searched", "time"]],
  ["web_fetch", ["Read", "page"]],
  ["read", ["Read", "file"]],
  ["edit", ["Edited", "file"]],
  ["write", ["Wrote", "file"]],
  ["bash", ["Ran", "command"]],
]);

/** One calm line for a run of tool calls, e.g. "Searched 1 time · read 2 pages". */
export function summarizeWork(tools: readonly Tool[]) {
  const counts = new Map<string, number>();

  for (const tool of tools)
    counts.set(tool.name, (counts.get(tool.name) ?? 0) + 1);

  const parts = [...counts].map(([name, count]) => {
    const verb = toolVerbs.get(name);

    return verb
      ? `${verb[0]} ${count} ${verb[1]}${count === 1 ? "" : "s"}`
      : `${name} ×${count}`;
  });

  const summary = parts
    .map((part, index) => (index === 0 ? part : part.toLowerCase()))
    .join(" · ");

  const failed = tools.filter((tool) => tool.failed).length;

  return { summary, failed };
}

function WorkSummary({ tools }: { readonly tools: readonly Tool[] }) {
  const { summary, failed } = summarizeWork(tools);

  return (
    <details className="work-summary">
      <summary>
        <Wrench size={14} aria-hidden="true" />
        <span>{summary}</span>
        {failed > 0 && (
          <span className="work-failed">{failed} blocked or failed</span>
        )}
      </summary>
      <ul>
        {tools.map((tool, index) => (
          <li
            key={`${tool.id}-${index}`}
            className={tool.failed ? "failed" : ""}
          >
            <strong>{tool.name}</strong>
            <span>{tool.failed ? "failed" : "done"}</span>
            {tool.text && <pre>{tool.text}</pre>}
          </li>
        ))}
      </ul>
    </details>
  );
}

function UserTurn({
  item,
  locked,
  onFork,
}: {
  readonly item: Message;
  readonly locked: boolean;
  readonly onFork: (item: Message, retry: boolean) => void;
}) {
  return (
    <article className="turn user" aria-label="You">
      <div className="bubble">
        <Markdown remarkPlugins={gfm}>{item.text}</Markdown>
        {item.images?.map((image, index) => (
          <img
            className="attachment-image"
            key={index}
            src={`data:${image.mimeType};base64,${image.data}`}
            alt={`Attached image ${index + 1}`}
          />
        ))}
        {item.attachmentText && (
          <details className="attached-text">
            <summary>
              <FileText size={14} aria-hidden="true" /> Attached text
            </summary>
            <pre>{item.attachmentText}</pre>
          </details>
        )}
      </div>
      {item.before && (
        <div className="turn-actions">
          <button
            type="button"
            disabled={locked}
            onClick={() => onFork(item, false)}
          >
            <Pencil size={14} aria-hidden="true" /> Edit
          </button>
          <button
            type="button"
            disabled={locked}
            onClick={() => onFork(item, true)}
          >
            <RotateCcw size={14} aria-hidden="true" /> Retry
          </button>
        </div>
      )}
    </article>
  );
}

function AssistantTurn({
  item,
  live,
  retry,
  locked,
}: {
  readonly item: Message;
  readonly live: boolean;
  readonly retry: (() => void) | null;
  readonly locked: boolean;
}) {
  return (
    <article
      className={`turn assistant ${live ? "is-live" : ""}`}
      aria-label="Still"
      aria-busy={live}
    >
      {item.thinking && (
        <details className="thinking">
          <summary>Thought process</summary>
          <p>{item.thinking}</p>
        </details>
      )}
      {item.text && (
        <div className="answer">
          <Markdown remarkPlugins={gfm}>{item.text}</Markdown>
        </div>
      )}
      {item.failed && (
        <div className="failure" role="group" aria-label="Response failed">
          <p>
            <TriangleAlert size={16} aria-hidden="true" /> The response failed.
            Nothing was lost; retrying starts a new branch.
          </p>
          {retry && (
            <button type="button" disabled={locked} onClick={retry}>
              <RotateCcw size={14} aria-hidden="true" /> Retry in a new branch
            </button>
          )}
        </div>
      )}
      {(item.model || item.interrupted) && !live && (
        <p className="meta">
          {item.interrupted && <span className="tag">Stopped</span>}
          {item.model && <span>{shortModel(item.model)}</span>}
          {item.cost !== undefined && <span>{formatCost(item.cost)}</span>}
        </p>
      )}
    </article>
  );
}

export function Timeline({
  snapshot,
  parentTitle,
  locked,
  onFork,
  onOpenParent,
}: {
  readonly snapshot: ChatSnapshot;
  readonly parentTitle: string | null;
  readonly locked: boolean;
  readonly onFork: (item: Message, retry: boolean) => void;
  readonly onOpenParent: () => void;
}) {
  const items = timeline(snapshot);
  const last = items.at(-1);

  const streaming =
    snapshot.busy &&
    last?.kind === "message" &&
    last.message.role === "assistant" &&
    Boolean(last.message.text);

  return (
    <div className="timeline">
      {snapshot.parent && (
        <p className="branch-banner">
          <GitBranch size={14} aria-hidden="true" />
          <span>
            Branch of{" "}
            <button type="button" onClick={onOpenParent}>
              {parentTitle ?? "the original chat"}
            </button>
            . The original is unchanged.
          </span>
        </p>
      )}
      {items.map((item, index) => {
        if (item.kind === "work")
          return <WorkSummary key={item.key} tools={item.tools} />;

        if (item.kind === "change")
          return (
            <p key={item.key} className="system-line">
              {item.text}
            </p>
          );

        const message = item.message;

        if (message.role === "user")
          return (
            <UserTurn
              key={item.key}
              item={message}
              locked={locked}
              onFork={onFork}
            />
          );

        const prompt = items
          .slice(0, index)
          .findLast(
            (previous) =>
              previous.kind === "message" && previous.message.role === "user",
          );

        return (
          <AssistantTurn
            key={item.key}
            item={message}
            live={snapshot.busy && message.entry === null}
            locked={locked}
            retry={
              prompt?.kind === "message" && prompt.message.before
                ? () => onFork(prompt.message, true)
                : null
            }
          />
        );
      })}
      {snapshot.busy && !streaming && (
        <p className="thinking-pill" role="status">
          <span className="pulse" aria-hidden="true" /> Thinking…
        </p>
      )}
      <Sources snapshot={snapshot} />
    </div>
  );
}

function host(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function Sources({ snapshot }: { readonly snapshot: ChatSnapshot }) {
  if (!snapshot.citations.length && !snapshot.attachments.length) return null;

  return (
    <section className="sources" aria-label="Sources and files">
      {snapshot.citations.length > 0 && (
        <>
          <h2>Sources</h2>
          <ol>
            {snapshot.citations.map((source) => {
              const hash = source.url.startsWith("attachment:")
                ? source.url.slice(11)
                : null;

              const pdf =
                hash !== null &&
                snapshot.attachments.some(
                  (file) =>
                    file.sha256 === hash && file.mimeType === "application/pdf",
                );

              return (
                <li key={`${source.number}-${source.url}`}>
                  <span className="source-number">{source.number}</span>
                  <span className="source-body">
                    {hash === null ? (
                      <a href={source.url} target="_blank" rel="noreferrer">
                        {source.title}
                      </a>
                    ) : (
                      <strong>{source.title}</strong>
                    )}
                    <small>
                      {hash === null ? host(source.url) : "Uploaded file"} ·{" "}
                      <time dateTime={source.fetchedAt}>
                        {source.fetchedAt.slice(0, 16).replace("T", " ")}
                      </time>
                    </small>
                    {pdf && (
                      <a
                        className="download"
                        href={apiPath(
                          `/api/chats/${snapshot.id}/attachments/${hash}`,
                        )}
                      >
                        <Download size={14} aria-hidden="true" /> Original PDF
                      </a>
                    )}
                  </span>
                </li>
              );
            })}
          </ol>
          <p className="caption">
            Recorded sources, not verification of the answer.
          </p>
        </>
      )}
      {snapshot.attachments.length > 0 && (
        <>
          <h2>Files</h2>
          <AttachmentDisplay attachments={snapshot.attachments} />
        </>
      )}
    </section>
  );
}
