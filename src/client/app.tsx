import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import {
  Activity,
  ChevronLeft,
  Globe,
  MessageSquare,
  Settings,
  ShieldAlert,
  SquarePen,
  X,
} from "lucide-react";
import { Effect, Option, Result, Schema } from "effect";
import {
  Bootstrap,
  ChatSnapshot,
  ChatSummary,
  Receipt,
  SendMessage,
  Work,
  type Grant,
  type Message,
  type ModelChoice,
} from "../shared/contracts.ts";
import { apiPath, request, RequestFailure } from "./api.ts";
import type { AttachmentUpload } from "../shared/attachments.ts";
import { Composer } from "./composer.tsx";
import { kits } from "./format.ts";
import { Timeline } from "./timeline.tsx";
import { ChatList, DecisionCard, SettingsView, WorkView } from "./views.tsx";

type View = "chat" | "chats" | "work" | "settings";

function stored(key: string) {
  return localStorage.getItem(`still:v1:${key}`) ?? "";
}

function initialView(): View {
  const view = new URLSearchParams(location.search).get("view");

  return view === "chats" || view === "work" || view === "settings"
    ? view
    : "chat";
}

function useWide() {
  const query = "(min-width: 900px)";
  const [wide, setWide] = useState(() => matchMedia(query).matches);

  useEffect(() => {
    const media = matchMedia(query);
    const update = () => setWide(media.matches);
    media.addEventListener("change", update);

    return () => media.removeEventListener("change", update);
  }, []);

  return wide;
}

/** Sizes the shell to the visual viewport so the composer rides above the iOS keyboard. */
function useVisualViewport() {
  useEffect(() => {
    const viewport = window.visualViewport;

    if (!viewport) return;
    const root = document.documentElement;

    const update = () => {
      root.style.setProperty("--app-height", `${viewport.height}px`);
      root.style.setProperty("--app-top", `${viewport.offsetTop}px`);
      root.classList.toggle(
        "keyboard-open",
        window.innerHeight - viewport.height > 120,
      );
    };

    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);

    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
    };
  }, []);
}

/**
 * Answer-first scrolling: open a chat at its latest exchange, bring a new
 * prompt to the top once, then leave the view still while the answer streams
 * below it. Nothing scrolls on its own during streaming.
 */
function useTurnScroll(
  scroll: RefObject<HTMLDivElement | null>,
  snapshot: ChatSnapshot | null,
  page: View,
) {
  const shown = useRef<{ id: number; prompts: number } | null>(null);

  useLayoutEffect(() => {
    const node = scroll.current;

    if (!node || !snapshot || page !== "chat") {
      shown.current = null;

      return;
    }

    const prompts = snapshot.messages.filter(
      (item) => item.role === "user",
    ).length;

    const previous = shown.current;
    shown.current = { id: snapshot.id, prompts };

    if (previous?.id !== snapshot.id) {
      node.scrollTop = node.scrollHeight;

      return;
    }

    const turns = node.querySelectorAll(".turn.user");
    const latest = turns[turns.length - 1];

    if (prompts > previous.prompts && latest)
      node.scrollTo({
        top:
          node.scrollTop +
          latest.getBoundingClientRect().top -
          node.getBoundingClientRect().top -
          8,
        behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "auto"
          : "smooth",
      });
  }, [scroll, snapshot, page]);

  // The latest exchange is at least one viewport tall (see .current-turn).
  // When the keyboard shrinks the view, keep the bottom in place if it was showing.
  useEffect(() => {
    const node = scroll.current;

    if (!node || page !== "chat") return;
    let height = node.clientHeight;

    const observer = new ResizeObserver(() => {
      const before = height;
      height = node.clientHeight;
      node.style.setProperty("--scroller-height", `${height}px`);

      if (height < before && node.scrollHeight - node.scrollTop - before < 8)
        node.scrollTop = node.scrollHeight;
    });

    observer.observe(node);

    return () => observer.disconnect();
  }, [scroll, page]);
}

const kitIcons = { chat: MessageSquare, research: Globe, still: ShieldAlert };

export function App() {
  const [models, setModels] = useState<readonly ModelChoice[]>([]);
  const [chats, setChats] = useState<readonly ChatSummary[]>([]);
  const [model, setModel] = useState("");

  const [active, setActive] = useState<number | null>(() => {
    const id = Number(new URLSearchParams(location.search).get("chat"));

    return Number.isSafeInteger(id) && id > 0 ? id : null;
  });

  const [view, setView] = useState<View>(initialView);
  const [snapshot, setSnapshot] = useState<ChatSnapshot | null>(null);
  const [draft, setDraft] = useState(() => stored(`draft:${active ?? "new"}`));
  const [error, setError] = useState("");
  const [connected, setConnected] = useState(false);
  const [sending, setSending] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [work, setWork] = useState<Schema.Schema.Type<typeof Work>>([]);
  const [whenBusy, setWhenBusy] = useState<"followUp" | "steer">("followUp");
  const [uploads, setUploads] = useState<readonly AttachmentUpload[]>([]);
  const [reuseEntry, setReuseEntry] = useState<number | undefined>(undefined);
  const [newKit, setNewKit] = useState<"chat" | "research">("chat");
  const scroll = useRef<HTMLDivElement>(null);
  const inFlight = useRef(false);
  const wide = useWide();
  const page = wide && view === "chats" ? "chat" : view;

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

  useVisualViewport();
  useTurnScroll(scroll, snapshot, page);

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

    if (view === "chat") url.searchParams.delete("view");
    else url.searchParams.set("view", view);
    history.replaceState(null, "", url);
  }, [view]);
  useEffect(() => {
    const url = new URL(location.href);

    if (active) url.searchParams.set("chat", String(active));
    else url.searchParams.delete("chat");
    history.replaceState(null, "", url);
    setSnapshot(null);
    setConnected(false);

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

      setChats((items) => {
        const known = items[0];

        // Streaming sends many snapshots; the list only changes with the summary.
        if (
          known?.id === value.id &&
          known.title === value.title &&
          known.model === value.model &&
          known.grant.kit === value.grant.kit &&
          known.grant.target === value.grant.target
        )
          return items;

        return [
          {
            id: value.id,
            title: value.title,
            model: value.model,
            grant: value.grant,
          },
          ...items.filter((item) => item.id !== value.id),
        ];
      });
    };

    events.onerror = () => setConnected(false);

    return () => events.close();
  }, [active]);
  useEffect(() => {
    if (view !== "work") return;
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
  }, [view]);
  useEffect(() => {
    localStorage.setItem(`still:v1:draft:${active ?? "new"}`, draft);
  }, [draft, active]);

  function selectChat(id: number | null) {
    if (preparing) return;
    setActive(id);
    setDraft(stored(`draft:${id ?? "new"}`));
    setError("");
    setView("chat");
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

  // A stable callback lets unchanged turns skip re-rendering while an answer streams.
  const latestFork = useRef(forkPrompt);
  latestFork.current = forkPrompt;

  const onFork = useCallback(
    (item: Message, retry: boolean) => void latestFork.current(item, retry),
    [],
  );

  function changeKit(kit: Grant["kit"]) {
    if (!active) {
      if (kit === "chat" || kit === "research") setNewKit(kit);
      else setError("Still requires supervisor authorization.");

      return;
    }

    void run(
      request(`/api/chats/${active}/kit`, Receipt, { kit, target: null }),
      () => {},
    );
  }

  const busy = snapshot?.busy ?? false;
  const pending = active !== null && Boolean(stored(`pending:${active}`));
  const locked = busy || Boolean(snapshot?.queued) || sending || preparing;
  const kit = snapshot?.grant.kit ?? newKit;
  const KitIcon = kitIcons[kit];

  const empty =
    !snapshot || (snapshot.messages.length === 0 && !snapshot.parent);

  const status = busy
    ? "Answering…"
    : active && !connected
      ? "Reconnecting…"
      : null;

  const nav: readonly {
    readonly id: View;
    readonly label: string;
    readonly icon: ReactNode;
  }[] = [
    {
      id: "chats",
      label: "Chats",
      icon: <MessageSquare size={20} aria-hidden="true" />,
    },
    {
      id: "work",
      label: "Work",
      icon: <Activity size={20} aria-hidden="true" />,
    },
    {
      id: "settings",
      label: "Settings",
      icon: <Settings size={20} aria-hidden="true" />,
    },
  ];

  const navLinks = (className: string) => (
    <nav className={className} aria-label="Primary">
      {nav.map((item) => (
        <a
          key={item.id}
          href={`?view=${item.id}`}
          aria-current={
            page === item.id || (item.id === "chats" && page === "chat")
              ? "page"
              : undefined
          }
          onClick={(event) => {
            event.preventDefault();
            setView(item.id);
          }}
        >
          {item.icon}
          <span>{item.label}</span>
        </a>
      ))}
    </nav>
  );

  const newChatButton = (
    <button
      type="button"
      className="icon-button"
      aria-label="New chat"
      title="New chat"
      disabled={sending || preparing}
      onClick={() => selectChat(null)}
    >
      <SquarePen size={20} aria-hidden="true" />
    </button>
  );

  return (
    <div className={`app-shell view-${page}`}>
      <aside className="sidebar" aria-label="Still">
        <div className="sidebar-top">
          <span className="wordmark">Still</span>
          {newChatButton}
        </div>
        {navLinks("side-nav")}
        <ChatList
          chats={chats}
          active={page === "chat" ? active : null}
          disabled={sending || preparing}
          onSelect={selectChat}
        />
      </aside>
      <main className="main">
        {page === "chat" ? (
          <>
            <header className="topbar">
              <button
                type="button"
                className="icon-button back"
                aria-label="All chats"
                onClick={() => setView("chats")}
              >
                <ChevronLeft size={22} aria-hidden="true" />
              </button>
              <div className="title">
                <h1>{snapshot?.title ?? (active ? "Loading…" : "New chat")}</h1>
                <p className={`subtitle kit-${kit}`} aria-live="polite">
                  <KitIcon size={12} aria-hidden="true" />
                  <span>
                    {kits[kit].label} · {kits[kit].authority}
                  </span>
                  {status && <span className="status-dot">{status}</span>}
                </p>
              </div>
              {newChatButton}
            </header>
            <div className="scroller" ref={scroll}>
              {empty ? (
                <section className="welcome">
                  <h2>Ask anything.</h2>
                  <p>
                    Your machine, your keys. Work keeps going if you lock the
                    phone.
                  </p>
                  <ul className="kit-guide">
                    {(["chat", "research", "still"] as const).map((item) => {
                      const Icon = kitIcons[item];

                      return (
                        <li key={item} className={`kit-${item}`}>
                          <Icon size={16} aria-hidden="true" />
                          <strong>{kits[item].label}</strong>
                          <span>{kits[item].authority}</span>
                        </li>
                      );
                    })}
                  </ul>
                  {!model && (
                    <p className="hint">Choose a model below to start.</p>
                  )}
                </section>
              ) : (
                <Timeline
                  snapshot={snapshot}
                  parentTitle={
                    chats.find((chat) => chat.id === snapshot.parent)?.title ??
                    null
                  }
                  locked={locked}
                  onFork={onFork}
                  onOpenParent={() => selectChat(snapshot.parent ?? null)}
                />
              )}
            </div>
            <div className="dock">
              {snapshot?.confirmations.map((url) => (
                <DecisionCard
                  key={url}
                  url={url}
                  onDecide={(allow) =>
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
                />
              ))}
              {error && (
                <div className="error-banner" role="alert">
                  <p>{error}</p>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label="Dismiss error"
                    onClick={() => setError("")}
                  >
                    <X size={16} aria-hidden="true" />
                  </button>
                </div>
              )}
              <Composer
                draft={draft}
                onDraft={setDraft}
                models={models}
                model={model}
                onModel={setModel}
                kit={kit}
                onKit={changeKit}
                canChooseStill={active !== null}
                cost={snapshot?.cost ?? 0}
                busy={busy}
                queued={snapshot?.queued ?? 0}
                whenBusy={whenBusy}
                onWhenBusy={setWhenBusy}
                uploads={uploads}
                onUploads={setUploads}
                onPreparing={setPreparing}
                preparing={preparing}
                locked={locked}
                pending={pending}
                sending={sending}
                reusing={reuseEntry !== undefined}
                onSend={() => void send()}
                onStop={() =>
                  void run(
                    request(`/api/chats/${active}/stop`, Receipt, {}),
                    () => {},
                  )
                }
                onError={setError}
              />
            </div>
          </>
        ) : (
          <div className="scroller page-scroller">
            {page === "chats" && (
              <section className="page" aria-labelledby="chats-title">
                <h1 id="chats-title">Chats</h1>
                <ChatList
                  chats={chats}
                  active={active}
                  disabled={sending || preparing}
                  onSelect={selectChat}
                />
              </section>
            )}
            {page === "work" && (
              <WorkView work={work} chats={chats} onOpen={selectChat} />
            )}
            {page === "settings" && <SettingsView active={active} />}
            {error && (
              <div className="error-banner page-error" role="alert">
                <p>{error}</p>
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Dismiss error"
                  onClick={() => setError("")}
                >
                  <X size={16} aria-hidden="true" />
                </button>
              </div>
            )}
          </div>
        )}
        {page !== "chat" && navLinks("tabbar")}
      </main>
    </div>
  );
}
