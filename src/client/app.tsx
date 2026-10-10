import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  Copy,
  Code2,
  Menu,
  MessageCircle,
  Plus,
  Search,
  ShieldCheck,
  GitBranch,
  Square,
  X,
} from "lucide-react";
import { Effect, Option, Result, Schema } from "effect";
import {
  Bootstrap,
  ChatSnapshot,
  ChatSummary,
  Group,
  LaunchGroup,
  type GroupAction,
  Receipt,
  SendMessage,
  type ModelChoice,
} from "../shared/contracts.ts";
import { apiPath, request, RequestFailure } from "./api.ts";
import { DelegationSheet, GroupCard } from "./delegation.tsx";
import { BuilderSheet } from "./builder.tsx";

function stored(key: string) {
  return localStorage.getItem(`still:${key}`) ?? "";
}

function pending(id: number) {
  return Schema.decodeUnknownOption(Schema.fromJsonString(SendMessage))(
    stored(`pending:${id}`),
  );
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
  const [ready, setReady] = useState(false);
  const [connected, setConnected] = useState(false);
  const [sending, setSending] = useState(false);
  const [menu, setMenu] = useState(false);
  const [search, setSearch] = useState("");
  const [modelPicker, setModelPicker] = useState(false);
  const [builder, setBuilder] = useState<string | null>(null);

  const [delegation, setDelegation] = useState<{
    count: number;
    task: string;
  } | null>(null);

  const [pendingLaunch, setPendingLaunch] = useState<LaunchGroup | null>(null);
  const [copied, setCopied] = useState("");
  const [atBottom, setAtBottom] = useState(true);
  const scroll = useRef<HTMLDivElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
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
        Effect.match({
          onSuccess: (data) => {
            setModels(data.models);
            setChats(data.chats);
            setReady(true);
            setModel(
              data.models.find((item) => item.id === "opencode-go/gpt-6-luna")
                ?.id ??
                data.models[0]?.id ??
                "",
            );
          },
          onFailure: () =>
            setError("Couldn’t connect to Still. Reload to try again."),
        }),
      ),
      { signal: controller.signal },
    ).catch(() => {});

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
    setAtBottom(true);

    if (!active) return;
    const events = new EventSource(apiPath(`/api/chats/${active}/events`));
    events.onmessage = (event) => {
      const decoded = Schema.decodeUnknownOption(
        Schema.fromJsonString(ChatSnapshot),
      )(event.data);

      if (Option.isNone(decoded)) {
        setError("An unreadable chat update arrived. Reload to reconnect.");

        return;
      }

      const value = decoded.value;
      setSnapshot(value);
      setConnected(true);
      setChats((items) => [
        value,
        ...items.filter((item) => item.id !== value.id),
      ]);
    };

    events.onerror = () => setConnected(false);

    return () => events.close();
  }, [active]);

  useEffect(() => {
    localStorage.setItem(`still:draft:${active ?? "new"}`, draft);

    if (textarea.current) {
      textarea.current.style.height = "auto";
      textarea.current.style.height = `${Math.min(textarea.current.scrollHeight, 160)}px`;
    }
  }, [draft, active]);

  useEffect(() => {
    if (stick.current && scroll.current)
      scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [snapshot]);

  useEffect(() => {
    if (modelPicker) dialog.current?.showModal();
  }, [modelPicker]);

  function selectChat(id: number | null) {
    if (sending) return;
    setActive(id);
    setDraft(stored(`draft:${id ?? "new"}`));
    setMenu(false);
    setError("");
  }

  function openDelegation(count: number, task: string) {
    setError("");

    const restored = Schema.decodeUnknownOption(
      Schema.fromJsonString(LaunchGroup),
    )(stored(`group-pending:${active ?? "new"}`));

    setPendingLaunch(Option.getOrNull(restored));
    setDelegation({ count, task });
  }

  async function launch(input: LaunchGroup) {
    let id = active;

    if (id === null) {
      const created = await Effect.runPromise(
        request("/api/chats", ChatSummary, { model }).pipe(Effect.result),
      );

      if (Result.isFailure(created)) {
        setError("Could not create the parent chat. Your setup is safe.");

        return;
      }

      id = created.success.id;
      setActive(id);
    }

    localStorage.setItem(`still:group-pending:${id}`, JSON.stringify(input));
    setPendingLaunch(input);
    await Effect.runPromise(
      request(`/api/chats/${id}/groups`, Group, input).pipe(
        Effect.match({
          onSuccess: () => {
            localStorage.removeItem(`still:group-pending:${id}`);
            setPendingLaunch(null);
            setDelegation(null);
            setDraft("");
          },
          onFailure: (failure) => {
            setError(failure.message);

            if (
              failure instanceof RequestFailure &&
              failure.status >= 400 &&
              failure.status < 500
            ) {
              localStorage.removeItem(`still:group-pending:${id}`);
              setPendingLaunch(null);
            }
          },
        }),
      ),
    );
  }

  function groupAction(input: GroupAction) {
    return Effect.runPromise(
      request(`/api/chats/${active}/group-action`, Receipt, input).pipe(
        Effect.tapError((failure) =>
          Effect.sync(() => setError(failure.message)),
        ),
        Effect.asVoid,
      ),
    );
  }

  async function send() {
    const coding = /^\/builder\b\s*([\s\S]*)$/.exec(draft.trim());

    if (coding && !location.pathname.startsWith("/builder-preview/")) {
      setBuilder(coding[1] ?? "");

      return;
    }

    const command = /^\/(delegate|arena)\b\s*([\s\S]*)$/.exec(draft.trim());

    if (command && !snapshot?.parent && !snapshot?.builder) {
      openDelegation(command[1] === "arena" ? 5 : 1, command[2] ?? "");

      return;
    }

    if (inFlight.current || !draft.trim() || !model) return;
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
          setError("Could not create this chat. Your draft is safe.");

          return;
        }

        id = created.success.id;
        setActive(id);
        setChats((items) => [created.success, ...items]);
        localStorage.removeItem("still:draft:new");
      }

      const existing = pending(id);

      const submission = Option.isSome(existing)
        ? existing.value
        : { text: draft.trim(), requestId: crypto.randomUUID() };

      localStorage.setItem(`still:pending:${id}`, JSON.stringify(submission));
      await run(
        request(`/api/chats/${id}/messages`, Receipt, submission),
        () => {
          localStorage.removeItem(`still:pending:${id}`);
          setDraft("");
          stick.current = true;
        },
      );
    } finally {
      inFlight.current = false;
      setSending(false);
    }
  }

  function stop() {
    if (active)
      void run(request(`/api/chats/${active}/stop`, Receipt, {}), () => {});
  }

  const selected = models.find(
    (item) => item.id === (snapshot?.model ?? model),
  );

  const messages = (snapshot?.messages ?? []).filter(
    (item) =>
      !snapshot?.builder ||
      item.role !== "assistant" ||
      item.text ||
      item.thinking ||
      item.failed ||
      item.interrupted ||
      item.id === "live",
  );

  const busy = snapshot?.busy ?? false;
  const hasPending = active !== null && Option.isSome(pending(active));

  const starter = (text: string) => {
    setDraft(text);
    textarea.current?.focus();
  };

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
          onClick={() => selectChat(null)}
          disabled={sending}
        >
          <Plus size={18} /> New conversation
        </button>
        <label className="search">
          <Search size={16} />
          <input
            aria-label="Search conversations"
            placeholder="Find a conversation"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <p className="eyebrow sidebar-label">CONVERSATIONS / {chats.length}</p>
        <nav className="chat-list">
          {chats.length === 0 && (
            <p className="empty-list">No conversations yet.</p>
          )}
          {chats.flatMap((chat) =>
            chat.title.toLowerCase().includes(search.toLowerCase())
              ? [
                  <button
                    key={chat.id}
                    className={chat.id === active ? "selected" : ""}
                    onClick={() => selectChat(chat.id)}
                    disabled={sending}
                  >
                    <MessageCircle size={16} />
                    <span>
                      {chat.title}
                      <small>{chat.model.split("/").at(-1)}</small>
                    </span>
                  </button>,
                ]
              : [],
          )}
        </nav>
        <div className="sidebar-footer">
          <div className="avatar">S</div>
          <div>
            <strong>Personal chat</strong>
            <small>Pi Durable · Effect v4</small>
          </div>
          <span className="prototype">α</span>
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
          {!location.pathname.startsWith("/builder-preview/") && (
            <button
              className="back-to-group"
              onClick={() => setBuilder(draft.replace(/^\/builder\b\s*/, ""))}
            >
              Builder
            </button>
          )}
          {snapshot?.parent && (
            <button
              className="back-to-group"
              onClick={() => selectChat(snapshot.parent ?? null)}
            >
              ← Back to arena
            </button>
          )}
          <button
            className="icon-button mobile-only"
            aria-label="Open conversations"
            onClick={() => setMenu(true)}
          >
            <Menu size={21} />
          </button>
          <div className="mode">
            <strong>
              {snapshot?.title ??
                (active ? "Loading conversation…" : "Still / New chat")}
            </strong>
            <span className="session-meta">
              <span className={`status-dot ${busy ? "is-busy" : ""}`} />
              {active
                ? connected
                  ? busy
                    ? "Generating"
                    : "Connected"
                  : "Reconnecting"
                : ready
                  ? "Ready"
                  : "Connecting"}{" "}
              · {messages.filter((item) => item.id !== "live").length} messages
            </span>
          </div>
          <button
            className="icon-button"
            aria-label="New conversation"
            onClick={() => selectChat(null)}
            disabled={sending}
          >
            <Plus size={21} />
          </button>
        </header>
        <div
          className="conversation"
          ref={scroll}
          onScroll={() => {
            const node = scroll.current;

            if (node) {
              const bottom =
                node.scrollHeight - node.scrollTop - node.clientHeight < 100;

              stick.current = bottom;
              setAtBottom(bottom);
            }
          }}
        >
          {snapshot?.builder && (
            <p className="builder-notice">
              TRUSTED BUILDER · Candidate {snapshot.builder}
              <br />
              Coding tools enabled. Live source is supervisor-owned. Activation
              needs separate owner approval.
            </p>
          )}
          {messages.length === 0 && !busy ? (
            <section className="welcome">
              <p className="eyebrow">CHAT / PI DURABLE</p>
              <h1>What are you working on?</h1>
              <p className="intro">
                Reason through a problem, review a snippet, or compare
                approaches.
              </p>
              <div className="starters">
                <button
                  onClick={() =>
                    starter(
                      "Help me debug a problem. Ask for the code, expected behavior, and actual result first.",
                    )
                  }
                >
                  <Code2 size={18} />
                  <span>
                    Debug a problem<small>Code · errors · edge cases</small>
                  </span>
                  <span className="starter-arrow">↗</span>
                </button>
                <button
                  onClick={() =>
                    starter(
                      "Help me compare two technical approaches. Ask about my requirements and constraints first.",
                    )
                  }
                >
                  <GitBranch size={18} />
                  <span>
                    Compare approaches
                    <small>Tradeoffs · constraints · design</small>
                  </span>
                  <span className="starter-arrow">↗</span>
                </button>
              </div>
              <div className="session-info">
                <div>
                  <span>Model</span>
                  <strong>{selected?.name ?? "Not configured"}</strong>
                </div>
                <div>
                  <span>Provider</span>
                  <strong>{selected?.provider ?? "—"}</strong>
                </div>
                <div>
                  <span>Access</span>
                  <strong>Chat only · no tools</strong>
                </div>
              </div>
              {chats.length > 0 && (
                <div className="recent-chats">
                  <p className="eyebrow">CONTINUE A CONVERSATION</p>
                  {chats.slice(0, 4).map((chat) => (
                    <button
                      key={chat.id}
                      onClick={() => selectChat(chat.id)}
                      disabled={sending}
                    >
                      <MessageCircle size={15} />
                      <span>
                        {chat.title}
                        <small>{chat.model.split("/").at(-1)}</small>
                      </span>
                      <span>↗</span>
                    </button>
                  ))}
                </div>
              )}
            </section>
          ) : (
            <section className="transcript" aria-label="Chat messages">
              {messages.map((item) =>
                item.groupId ? (
                  snapshot?.groups?.flatMap((group) =>
                    group.id === item.groupId
                      ? [
                          <GroupCard
                            key={item.id}
                            group={group}
                            models={models}
                            onOpen={selectChat}
                            onAction={groupAction}
                          />,
                        ]
                      : [],
                  )
                ) : (
                  <article key={item.id} className={`message ${item.role}`}>
                    <div className="assistant-label">
                      <span>{item.role === "user" ? "YOU" : "ASSISTANT"}</span>
                      <span className="muted">
                        {item.role === "assistant" ? selected?.name : "Prompt"}
                      </span>
                      {item.id === "live" && (
                        <span className="muted">streaming</span>
                      )}
                    </div>
                    {item.thinking && (
                      <details className="thinking">
                        <summary>Thought process</summary>
                        <p>{item.thinking}</p>
                      </details>
                    )}
                    <div className="message-body">
                      <Markdown>{item.text}</Markdown>
                    </div>
                    {item.failed && (
                      <p className="message-note error-note">
                        The model couldn’t finish this reply. Try again in a new
                        message or choose another model in a new chat.
                      </p>
                    )}
                    {item.interrupted && (
                      <p className="message-note">Response interrupted</p>
                    )}
                    {item.role === "assistant" &&
                      item.text &&
                      item.id !== "live" && (
                        <button
                          className="copy-button"
                          aria-label="Copy answer"
                          onClick={() => {
                            void navigator.clipboard.writeText(item.text).then(
                              () => setCopied(item.id),
                              () =>
                                setError(
                                  "Clipboard access was blocked by your browser.",
                                ),
                            );
                          }}
                        >
                          {copied === item.id ? (
                            <Check size={14} />
                          ) : (
                            <Copy size={14} />
                          )}
                          {copied === item.id ? "Copied" : "Copy"}
                        </button>
                      )}
                  </article>
                ),
              )}
              {busy && (
                <div className="working" role="status">
                  <span className="tiny-sun" />
                  <span>
                    Generating response<span className="dots">…</span>
                  </span>
                </div>
              )}
              {(snapshot?.tools?.length ?? 0) > 0 && (
                <details className="builder-tools">
                  <summary>
                    Durable coding tool results · {snapshot?.tools?.length}
                  </summary>
                  {snapshot?.tools?.map((tool) => (
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
        </div>
        <div className="composer-area">
          {!atBottom && (
            <button
              className="jump"
              onClick={() => {
                stick.current = true;
                scroll.current?.scrollTo({
                  top: scroll.current.scrollHeight,
                  behavior: "smooth",
                });
              }}
            >
              <ArrowDown size={14} /> Latest message
            </button>
          )}
          {error && (
            <div className="error-banner" role="alert">
              {error}
              <button aria-label="Dismiss error" onClick={() => setError("")}>
                <X size={15} />
              </button>
            </div>
          )}
          {ready && models.length === 0 && (
            <div className="error-banner" role="status">
              Connect a provider on the server to start chatting. No demo
              answers or hidden model calls.
            </div>
          )}
          {active && !connected && (
            <p className="connection" role="status">
              Reconnecting to your conversation…
            </p>
          )}
          {(snapshot?.queued ?? 0) > 0 && (
            <p className="connection">{snapshot?.queued} follow-up queued</p>
          )}
          <form
            className="composer"
            onSubmit={(event) => {
              event.preventDefault();
              void send();
            }}
          >
            <textarea
              ref={textarea}
              aria-label="Message Still"
              placeholder={
                busy ? "Queue a follow-up…" : "Ask a question or paste code…"
              }
              value={draft}
              readOnly={sending || hasPending}
              maxLength={16000}
              rows={1}
              onChange={(event) => setDraft(event.target.value)}
            />
            <div className="composer-bottom">
              <button
                type="button"
                className="model-trigger"
                disabled={!ready || models.length === 0 || active !== null}
                onClick={() => setModelPicker(true)}
                aria-label="Choose model"
              >
                <span className="model-indicator" />
                {selected?.name ?? "Choose a model"}
                {active === null && <ChevronDown size={13} />}
              </button>
              <div className="send-actions">
                {!snapshot?.parent && !snapshot?.builder && (
                  <button
                    type="button"
                    className="command-trigger"
                    aria-label="Open delegation commands"
                    disabled={!ready || models.length === 0}
                    onClick={() =>
                      openDelegation(
                        1,
                        draft.replace(/^\/(delegate|arena)\b\s*/, ""),
                      )
                    }
                  >
                    /
                  </button>
                )}
                {busy && (
                  <button
                    type="button"
                    className="stop"
                    aria-label="Stop response"
                    onClick={stop}
                  >
                    <Square size={15} fill="currentColor" />
                  </button>
                )}
                <button
                  className="send"
                  type="submit"
                  aria-label={hasPending ? "Retry send" : "Send message"}
                  disabled={!ready || !draft.trim() || !model || sending}
                >
                  {sending ? (
                    <span className="sending-dot" />
                  ) : (
                    <ArrowUp size={20} />
                  )}
                </button>
              </div>
            </div>
          </form>
          <p className="privacy">
            <ShieldCheck size={12} />{" "}
            {snapshot?.builder
              ? "Trusted coding · candidate workspace"
              : "Chat only · no workspace access"}{" "}
            <span className="desktop-only">· Prototype</span>
          </p>
        </div>
      </main>
      {builder !== null && (
        <BuilderSheet
          models={models}
          model={snapshot?.model ?? model}
          task={builder}
          onClose={() => setBuilder(null)}
          onOpen={(id) => {
            selectChat(id);
            setDraft("");
          }}
        />
      )}
      {delegation && (
        <DelegationSheet
          models={models}
          snapshot={snapshot}
          model={snapshot?.model ?? model}
          count={delegation.count}
          task={delegation.task}
          pending={pendingLaunch}
          error={error}
          onClose={() => setDelegation(null)}
          onLaunch={launch}
        />
      )}
      {modelPicker && (
        <dialog
          ref={dialog}
          className="modal-backdrop"
          aria-label="Choose a model"
          onCancel={() => setModelPicker(false)}
          onClick={() => setModelPicker(false)}
        >
          <section
            className="model-sheet"
            onClick={(event) => event.stopPropagation()}
          >
            <header>
              <div>
                <p className="eyebrow">PROVIDER / MODEL</p>
                <h2>Select model</h2>
              </div>
              <button
                className="icon-button"
                aria-label="Close model picker"
                onClick={() => setModelPicker(false)}
              >
                <X size={20} />
              </button>
            </header>
            <p className="sheet-note">
              Available through your server’s connected providers.
              <br />
              The model is fixed for each conversation in this prototype.
            </p>
            <div className="model-list">
              {models.map((item) => (
                <button
                  key={item.id}
                  onClick={() => {
                    setModel(item.id);
                    setModelPicker(false);
                  }}
                >
                  <span>
                    {item.name}
                    <small>{item.provider}</small>
                  </span>
                  {model === item.id && <Check size={17} />}
                </button>
              ))}
            </div>
          </section>
        </dialog>
      )}
    </div>
  );
}
