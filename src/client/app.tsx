import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import { ArrowUp, Menu, Plus, Square, X } from "lucide-react";
import { Effect, Match, Option, Result, Schema } from "effect";
import {
  Bootstrap,
  ChatSnapshot,
  ChatSummary,
  Receipt,
  SendMessage,
  Work,
  type Message,
  type ModelChoice,
} from "../shared/contracts.ts";
import { apiPath, request, RequestFailure } from "./api.ts";
import { AttachmentChooser, AttachmentDisplay } from "./attachments.tsx";
import type { AttachmentUpload } from "../shared/attachments.ts";
import { PushSubscription } from "../shared/push.ts";

function stored(key: string) {
  return localStorage.getItem(`still:v1:${key}`) ?? "";
}

export function App() {
  const [models, setModels] = useState<readonly ModelChoice[]>([]);
  const [chats, setChats] = useState<readonly ChatSummary[]>([]);
  const [model, setModel] = useState("");

  const [active, setActive] = useState<number | null>(() => {
    const id = Number(new URLSearchParams(location.search).get("chat"));

    return Number.isSafeInteger(id) && id > 0 ? id : null;
  });

  const [snapshot, setSnapshot] = useState<ChatSnapshot | null>(null);
  const [draft, setDraft] = useState(() => stored(`draft:${active ?? "new"}`));
  const [error, setError] = useState("");
  const [connected, setConnected] = useState(false);
  const [sending, setSending] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [menu, setMenu] = useState(false);
  const [tab, setTab] = useState<"chats" | "work">("chats");
  const [work, setWork] = useState<Schema.Schema.Type<typeof Work>>([]);
  const [whenBusy, setWhenBusy] = useState<"followUp" | "steer">("followUp");
  const [uploads, setUploads] = useState<readonly AttachmentUpload[]>([]);
  const [reuseEntry, setReuseEntry] = useState<number | undefined>(undefined);
  const [pushStatus, setPushStatus] = useState("");
  const [newKit, setNewKit] = useState<"chat" | "research">("chat");
  const scroll = useRef<HTMLDivElement>(null);
  const inFlight = useRef(false);
  const stick = useRef(true);

  function run<A>(
    effect: Effect.Effect<A, RequestFailure | Schema.SchemaError>,
    onSuccess: (value: A) => void,
  ) {
    return Effect.runPromise(
      effect.pipe(
        Effect.match({
          onSuccess,
          onFailure: (failure) => setError(failure.message),
        }),
      ),
    );
  }

  useEffect(() => {
    const controller = new AbortController();
    void Effect.runPromise(
      request("/api/bootstrap", Bootstrap).pipe(
        Effect.tap((data) =>
          Effect.sync(() => {
            setModels(data.models);
            setChats(data.chats);
            // Never silently choose a paid model. The owner explicitly chooses on a new chat.
          }),
        ),
      ),
      { signal: controller.signal },
    ).catch(() => {
      if (!controller.signal.aborted)
        setError("Could not connect. Reload to retry.");
    });

    return () => controller.abort();
  }, []);
  useEffect(() => {
    const url = new URL(location.href);

    if (active) url.searchParams.set("chat", String(active));
    else url.searchParams.delete("chat");
    history.replaceState(null, "", url);
    setSnapshot(null);
    setConnected(false);
    stick.current = true;

    if (!active) return;
    let first = true;
    const events = new EventSource(apiPath(`/api/chats/${active}/events`));
    events.onmessage = (event) => {
      const decoded = Schema.decodeUnknownOption(
        Schema.fromJsonString(ChatSnapshot),
      )(event.data);

      if (Option.isNone(decoded)) {
        setError("Unreadable chat update. Reload to reconnect.");

        return;
      }

      const value = decoded.value;
      setSnapshot(value);
      setConnected(true);

      if (first) {
        setModel(value.model);
        first = false;
      }

      setChats((items) => [
        value,
        ...items.filter((item) => item.id !== value.id),
      ]);
    };

    events.onerror = () => setConnected(false);

    return () => events.close();
  }, [active]);
  useEffect(() => {
    if (tab !== "work") return;
    const controller = new AbortController();

    const refresh = () => {
      void Effect.runPromise(request("/api/work", Work), {
        signal: controller.signal,
      })
        .then(setWork)
        .catch(() => {
          if (!controller.signal.aborted) setError("Work status unavailable.");
        });
    };

    refresh();
    const timer = setInterval(refresh, 2000);

    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, [tab]);
  useEffect(() => {
    localStorage.setItem(`still:v1:draft:${active ?? "new"}`, draft);
  }, [draft, active]);
  useEffect(() => {
    if (stick.current && scroll.current)
      scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [snapshot]);

  function selectChat(id: number | null) {
    if (preparing) return;
    setActive(id);
    setDraft(stored(`draft:${id ?? "new"}`));
    setMenu(false);
    setError("");
    setTab("chats");
    setUploads([]);
    setReuseEntry(undefined);

    if (id === null) {
      setModel("");
      setNewKit("chat");
    }
  }

  async function send() {
    if (inFlight.current || preparing || !draft.trim() || !model) return;
    inFlight.current = true;
    setSending(true);
    setError("");

    try {
      let id = active;

      if (id === null) {
        const created = await Effect.runPromise(
          request("/api/chats", ChatSummary, { model }).pipe(Effect.result),
        );

        if (Result.isFailure(created)) {
          setError("Could not create chat. Your draft is safe.");

          return;
        }

        id = created.success.id;
        setActive(id);
        setChats((items) => [created.success, ...items]);
        localStorage.removeItem("still:v1:draft:new");

        if (newKit === "research")
          await Effect.runPromise(
            request(`/api/chats/${id}/kit`, Receipt, {
              kit: "research",
              target: null,
            }),
          );
      }

      const saved = Schema.decodeUnknownOption(
        Schema.fromJsonString(SendMessage),
      )(stored(`pending:${id}`));

      const input = Option.isSome(saved)
        ? saved.value
        : {
            text: draft.trim(),
            model,
            whenBusy,
            attachments: uploads,
            reuseEntry: reuseEntry ?? null,
            requestId: crypto.randomUUID(),
          };

      localStorage.setItem(`still:v1:pending:${id}`, JSON.stringify(input));

      const result = await Effect.runPromise(
        request(`/api/chats/${id}/messages`, Receipt, input).pipe(
          Effect.result,
        ),
      );

      if (Result.isSuccess(result)) {
        localStorage.removeItem(`still:v1:pending:${id}`);
        setDraft("");
        setUploads([]);
        setReuseEntry(undefined);
        stick.current = true;
      } else {
        setError(result.failure.message);

        if (
          result.failure instanceof RequestFailure &&
          result.failure.status >= 400 &&
          result.failure.status < 500
        )
          localStorage.removeItem(`still:v1:pending:${id}`);
      }
    } catch {
      setError(
        "Could not safely save or send this input. Keep your files and retry; no paid fallback is used.",
      );
    } finally {
      inFlight.current = false;
      setSending(false);
    }
  }

  async function forkPrompt(item: Message, retry: boolean) {
    if (!active || !item.before || inFlight.current) return;
    inFlight.current = true;
    setSending(true);

    try {
      const fork = await Effect.runPromise(
        request(`/api/chats/${active}/branch`, Receipt, {
          entry: item.before,
          model,
        }).pipe(Effect.result),
      );

      if (Result.isFailure(fork)) {
        setError(fork.failure.message);

        return;
      }

      selectChat(fork.success.id);
      setDraft(item.text);
      setReuseEntry(item.entry ?? undefined);

      if (retry) {
        const input = {
          text: item.text,
          model,
          reuseEntry: item.entry,
          requestId: crypto.randomUUID(),
        };

        localStorage.setItem(
          `still:v1:pending:${fork.success.id}`,
          JSON.stringify(input),
        );
        await run(
          request(`/api/chats/${fork.success.id}/messages`, Receipt, input),
          () => {
            localStorage.removeItem(`still:v1:pending:${fork.success.id}`);
            setDraft("");
            setReuseEntry(undefined);
          },
        );
      }
    } finally {
      inFlight.current = false;
      setSending(false);
    }
  }

  const busy = snapshot?.busy ?? false;
  const pending = active !== null && Boolean(stored(`pending:${active}`));

  const messages = (snapshot?.messages ?? []).filter(
    (item) =>
      item.role !== "assistant" ||
      item.text ||
      item.thinking ||
      item.failed ||
      item.interrupted,
  );

  const locked = busy || Boolean(snapshot?.queued) || sending || preparing;

  const access = Match.value(snapshot?.grant.kit).pipe(
    Match.when(
      "still",
      () => "Candidate tools share app permissions · not sandboxed",
    ),
    Match.when(
      "research",
      () => "Research · read-only public web · no workspace tools",
    ),
    Match.orElse(() => "Chat · no workspace access"),
  );

  return (
    <div className="app-shell">
      <aside
        className={`sidebar ${menu ? "is-open" : ""}`}
        aria-label="Conversations"
      >
        <div className="sidebar-top">
          <span className="wordmark">
            Still<span>.</span>
          </span>
          <button
            className="icon-button mobile-only"
            aria-label="Close conversations"
            onClick={() => setMenu(false)}
          >
            <X size={20} />
          </button>
        </div>
        <button
          className="new-chat"
          disabled={sending || preparing}
          onClick={() => selectChat(null)}
        >
          <Plus size={18} /> New conversation
        </button>
        <div className="kit-tabs">
          <button
            aria-pressed={tab === "chats"}
            onClick={() => setTab("chats")}
          >
            Chats
          </button>
          <button
            aria-pressed={tab === "work"}
            onClick={() => {
              setTab("work");
              setMenu(false);
            }}
          >
            Work
          </button>
        </div>
        <nav className="chat-list">
          {chats.map((chat) => (
            <button
              key={chat.id}
              className={active === chat.id ? "selected" : ""}
              disabled={sending || preparing}
              onClick={() => selectChat(chat.id)}
            >
              <span>
                {chat.title}
                <small>
                  {chat.grant.kit} · {chat.model.split("/").at(-1)}
                </small>
              </span>
            </button>
          ))}
        </nav>
        <div className="sidebar-footer">
          <button
            onClick={async () => {
              try {
                const config = await Effect.runPromise(
                  request(
                    "/api/push",
                    Schema.Struct({ publicKey: Schema.String }),
                  ),
                );

                if (!config.publicKey) {
                  setPushStatus("Push needs operator VAPID configuration.");

                  return;
                }

                if (
                  !("serviceWorker" in navigator) ||
                  !("PushManager" in window)
                ) {
                  setPushStatus("This browser does not support Web Push.");

                  return;
                }

                const registration =
                  await navigator.serviceWorker.register("/sw.js");

                await navigator.serviceWorker.ready;

                const subscription = await registration.pushManager.subscribe({
                  userVisibleOnly: true,
                  applicationServerKey: config.publicKey,
                });

                const decoded = Schema.decodeUnknownSync(PushSubscription)(
                  subscription.toJSON(),
                );

                await Effect.runPromise(
                  request("/api/push/subscribe", Receipt, decoded),
                );
                setPushStatus("Subscribed. Test delivery from a conversation.");
              } catch {
                setPushStatus(
                  "Notification subscription failed. Check permissions and operator setup.",
                );
              }
            }}
          >
            Enable notifications
          </button>
          <button
            onClick={async () => {
              try {
                const registration =
                  await navigator.serviceWorker?.getRegistration();

                const subscription =
                  await registration?.pushManager.getSubscription();

                if (subscription) {
                  await Effect.runPromise(
                    request("/api/push/unsubscribe", Receipt, {
                      endpoint: subscription.endpoint,
                    }),
                  );
                  await subscription.unsubscribe();
                }

                setPushStatus("Notifications disabled for this browser.");
              } catch {
                setPushStatus(
                  "Could not revoke notifications. Try again before clearing browser storage.",
                );
              }
            }}
          >
            Disable notifications
          </button>
          {active && (
            <button
              onClick={() =>
                void run(
                  request("/api/push/test", Receipt, {
                    eventId: crypto.randomUUID(),
                    conversationId: active,
                  }),
                  () =>
                    setPushStatus(
                      "Test event admitted; delivery status is not guaranteed.",
                    ),
                )
              }
            >
              Test notification
            </button>
          )}
          {pushStatus && <p role="status">{pushStatus}</p>}
          <span>Pi Durable 1.0.2 · fresh-state v1</span>
        </div>
      </aside>
      {menu && (
        <button
          className="scrim"
          aria-label="Dismiss conversations"
          onClick={() => setMenu(false)}
        />
      )}
      <main className="main">
        <header className="topbar">
          <button
            className="icon-button mobile-only"
            aria-label="Open conversations"
            onClick={() => setMenu(true)}
          >
            <Menu size={21} />
          </button>
          <div className="mode">
            <strong>
              {tab === "work"
                ? "Work / live tasks"
                : (snapshot?.title ?? "Still / New chat")}
            </strong>
            <span className="session-meta">
              {busy
                ? "Generating"
                : active
                  ? connected
                    ? "Connected"
                    : "Reconnecting"
                  : "Ready"}{" "}
              · ${snapshot?.cost.toFixed(5) ?? "0.00000"} reported
            </span>
          </div>
          <button
            className="icon-button"
            aria-label="New conversation"
            disabled={sending || preparing}
            onClick={() => selectChat(null)}
          >
            <Plus size={21} />
          </button>
        </header>
        {tab === "work" ? (
          <section className="conversation">
            <div className="transcript">
              <h1>Work</h1>
              <p>
                Pi’s live task graph. Completed tasks leave this view; answers
                stay in Chats.
              </p>
              {work.length === 0 && <p>No active tasks.</p>}
              {work.map((task) => (
                <button
                  className="work-row"
                  key={task.id}
                  onClick={() => selectChat(task.conversationId)}
                >
                  <strong>{task.kind}</strong>
                  <span>
                    {task.status} · chat {task.conversationId}
                    {task.background ? " · background" : ""}
                  </span>
                </button>
              ))}
            </div>
          </section>
        ) : (
          <>
            <div className="kit-bar">
              <label>
                Kit{" "}
                <select
                  aria-label="Conversation kit"
                  value={snapshot?.grant.kit ?? newKit}
                  disabled={locked}
                  onChange={(event) => {
                    const kit = event.target.value;

                    if (!active) {
                      if (kit === "chat" || kit === "research") setNewKit(kit);
                      else setError("Still requires supervisor authorization.");

                      return;
                    }

                    if (kit === "chat" || kit === "research" || kit === "still")
                      void run(
                        request(`/api/chats/${active}/kit`, Receipt, {
                          kit,
                          target: null,
                        }),
                        () => {},
                      );
                  }}
                >
                  <option value="chat">Chat</option>
                  <option value="research">Research · read-only web</option>
                  <option value="still">Still · supervisor required</option>
                </select>
              </label>
              {snapshot?.parent && (
                <button onClick={() => selectChat(snapshot.parent ?? null)}>
                  ← Parent chat
                </button>
              )}
            </div>
            <div
              className="conversation"
              ref={scroll}
              onScroll={() => {
                const node = scroll.current;

                if (node)
                  stick.current =
                    node.scrollHeight - node.scrollTop - node.clientHeight <
                    100;
              }}
            >
              {messages.length === 0 ? (
                <section className="welcome">
                  <p className="eyebrow">CHAT / PI DURABLE</p>
                  <h1>What are you working on?</h1>
                  <p className="intro">
                    A focused place to reason, research, and improve your tools.
                  </p>
                  <div className="session-info">
                    <div>
                      <span>Chat</span>
                      <strong>Reason without tools</strong>
                    </div>
                    <div>
                      <span>Research</span>
                      <strong>Search, read, cite</strong>
                    </div>
                    <div>
                      <span>Still</span>
                      <strong>Protected candidate work</strong>
                    </div>
                  </div>
                </section>
              ) : (
                <section className="transcript" aria-label="Chat messages">
                  {messages.map((item) => (
                    <article key={item.id} className={`message ${item.role}`}>
                      <div className="assistant-label">
                        <span>
                          {item.role === "user" ? "YOU" : "ASSISTANT"}
                        </span>
                        <span className="muted">
                          {item.model?.split("/").at(-1)}
                          {item.cost !== undefined
                            ? ` · $${item.cost.toFixed(5)}`
                            : ""}
                        </span>
                      </div>
                      {item.thinking && (
                        <details className="thinking">
                          <summary>Thought process</summary>
                          <p>{item.thinking}</p>
                        </details>
                      )}
                      <div className="message-body">
                        <Markdown>{item.text}</Markdown>
                        {item.images?.map((image, index) => (
                          <img
                            className="attachment-image"
                            key={index}
                            src={`data:${image.mimeType};base64,${image.data}`}
                            alt="Uploaded attachment"
                          />
                        ))}
                        {item.attachmentText && (
                          <details>
                            <summary>Attached source text</summary>
                            <pre>{item.attachmentText}</pre>
                          </details>
                        )}
                      </div>
                      {item.failed && (
                        <p className="error-note">
                          Response failed. Retry in a new branch.
                        </p>
                      )}
                      {item.interrupted && <p>Interrupted</p>}
                      {item.role === "user" && item.before && (
                        <div className="turn-actions">
                          <button
                            disabled={locked}
                            onClick={() => void forkPrompt(item, false)}
                          >
                            Edit & resend
                          </button>
                          <button
                            disabled={locked}
                            onClick={() => void forkPrompt(item, true)}
                          >
                            Retry in Chat branch
                          </button>
                        </div>
                      )}
                    </article>
                  ))}
                  {busy && <p role="status">Generating…</p>}
                  {Boolean(snapshot?.tools.length) && (
                    <details>
                      <summary>Tool results · {snapshot?.tools.length}</summary>
                      {snapshot?.tools.map((tool) => (
                        <details key={tool.id}>
                          <summary>
                            {tool.name} · {tool.failed ? "failed" : "completed"}
                          </summary>
                          <pre>{tool.text}</pre>
                        </details>
                      ))}
                    </details>
                  )}
                </section>
              )}
              {Boolean(snapshot?.changes.length) && (
                <details className="change-log">
                  <summary>Kit & model history</summary>
                  {snapshot?.changes.map((change) => (
                    <p key={change.id}>{change.text}</p>
                  ))}
                </details>
              )}
              {Boolean(snapshot?.attachments.length) && (
                <section className="source-panel">
                  <AttachmentDisplay
                    attachments={snapshot?.attachments ?? []}
                  />
                </section>
              )}
              {Boolean(snapshot?.citations.length) && (
                <section className="source-panel" aria-label="Recorded sources">
                  <h2>Sources</h2>
                  <p>
                    Recorded source metadata; not verification of the model’s
                    claims.
                  </p>
                  {snapshot?.citations.map((source) => (
                    <div key={`${source.number}-${source.url}`}>
                      {source.url.startsWith("attachment:") ? (
                        <span>
                          [{source.number}] {source.title} · uploaded source
                        </span>
                      ) : (
                        <a href={source.url} target="_blank" rel="noreferrer">
                          [{source.number}] {source.title}
                        </a>
                      )}
                      <small>
                        {source.url} · {source.fetchedAt}
                      </small>
                      {source.url.startsWith("attachment:") &&
                        snapshot.attachments.some(
                          (file) =>
                            file.sha256 === source.url.slice(11) &&
                            file.mimeType === "application/pdf",
                        ) && (
                          <a
                            href={apiPath(
                              `/api/chats/${active}/attachments/${source.url.slice(11)}`,
                            )}
                          >
                            Download original PDF
                          </a>
                        )}
                    </div>
                  ))}
                </section>
              )}
              {snapshot?.confirmations.map((url) => (
                <section className="source-panel confirmation" key={url}>
                  <strong>Confirm an outbound URL</strong>
                  <p>
                    The model proposed this URL. Approval applies only to this
                    exact URL, not its entire origin.
                  </p>
                  <code>{url}</code>
                  <div>
                    {[true, false].map((allow) => (
                      <button
                        key={String(allow)}
                        onClick={() =>
                          void run(
                            request(`/api/chats/${active}/confirm`, Receipt, {
                              url,
                              allow,
                              requestId: crypto.randomUUID(),
                            }),
                            () =>
                              setDraft(
                                allow
                                  ? `Continue with the approved URL: ${url}`
                                  : "Continue without that source.",
                              ),
                          )
                        }
                      >
                        {allow ? "Allow URL" : "Deny"}
                      </button>
                    ))}
                  </div>
                  <small>
                    Confirmation does not start another model turn; send
                    Continue when ready.
                  </small>
                </section>
              ))}
            </div>
            <div className="composer-area">
              {error && (
                <div className="error-banner" role="alert">
                  {error}
                  <button
                    aria-label="Dismiss error"
                    onClick={() => setError("")}
                  >
                    <X size={15} />
                  </button>
                </div>
              )}
              {Boolean(snapshot?.queued) && (
                <p>{snapshot?.queued} input queued</p>
              )}
              <form
                className="composer"
                onSubmit={(event) => {
                  event.preventDefault();
                  void send();
                }}
              >
                <AttachmentChooser
                  disabled={locked || pending}
                  onPreparing={setPreparing}
                  onAdmission={async (files) =>
                    setUploads((items) => [...items, ...files])
                  }
                />
                {uploads.length > 0 && (
                  <div className="pending-attachments">
                    {uploads.map((file, index) => (
                      <button
                        type="button"
                        key={index}
                        onClick={() =>
                          setUploads((items) =>
                            items.filter((_, at) => at !== index),
                          )
                        }
                      >
                        {file.name} ×
                      </button>
                    ))}
                  </div>
                )}
                {reuseEntry && (
                  <small>
                    Original attachment content will be preserved in this
                    branch.
                  </small>
                )}
                <textarea
                  aria-label="Message Still"
                  placeholder={
                    busy
                      ? "Steer or queue a follow-up…"
                      : "Ask a question or paste code…"
                  }
                  value={draft}
                  readOnly={sending || pending}
                  maxLength={16000}
                  rows={3}
                  onChange={(event) => setDraft(event.target.value)}
                />
                <div className="composer-bottom">
                  <select
                    aria-label="Choose model"
                    value={model}
                    disabled={locked || pending}
                    onChange={(event) => setModel(event.target.value)}
                  >
                    <option value="">Choose a model</option>
                    {models.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                  <div className="send-actions">
                    {busy && (
                      <>
                        <select
                          aria-label="Input delivery"
                          value={whenBusy}
                          onChange={(event) =>
                            setWhenBusy(
                              event.target.value === "steer"
                                ? "steer"
                                : "followUp",
                            )
                          }
                        >
                          <option value="followUp">Queue</option>
                          <option value="steer">Steer</option>
                        </select>
                        <button
                          type="button"
                          className="stop"
                          aria-label="Stop response"
                          onClick={() =>
                            void run(
                              request(`/api/chats/${active}/stop`, Receipt, {}),
                              () => {},
                            )
                          }
                        >
                          <Square size={14} />
                        </button>
                      </>
                    )}
                    <button
                      className="send"
                      type="submit"
                      aria-label={pending ? "Retry send" : "Send message"}
                      disabled={!draft.trim() || !model || sending || preparing}
                    >
                      <ArrowUp size={20} />
                    </button>
                  </div>
                </div>
              </form>
              <p className="privacy">
                {access} · reported costs, not a billing guarantee
              </p>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
