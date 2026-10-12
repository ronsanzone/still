import { useEffect, useState } from "react";
import { Effect, Schema } from "effect";
import {
  Activity,
  Bell,
  BellOff,
  Globe,
  MessageSquare,
  Plus,
  Send,
  ShieldAlert,
} from "lucide-react";
import { Receipt, type ChatSummary, type Work } from "../shared/contracts.ts";
import { PushSubscription } from "../shared/push.ts";
import { FeedbackList, type FeedbackItem } from "../shared/feedback.ts";
import { request } from "./api.ts";
import { kits, shortModel } from "./format.ts";

const kitIcons = { chat: MessageSquare, research: Globe, still: ShieldAlert };

export function ChatList({
  chats,
  active,
  disabled,
  onSelect,
}: {
  readonly chats: readonly ChatSummary[];
  readonly active: number | null;
  readonly disabled: boolean;
  readonly onSelect: (id: number | null) => void;
}) {
  return (
    <div className="chat-list">
      <button
        type="button"
        className="new-chat"
        disabled={disabled}
        onClick={() => onSelect(null)}
      >
        <Plus size={18} aria-hidden="true" /> New chat
      </button>
      {chats.length === 0 ? (
        <p className="empty">No chats yet. Ask something to start one.</p>
      ) : (
        <ul aria-label="Chats">
          {chats.map((chat) => {
            const Icon = kitIcons[chat.grant.kit];

            return (
              <li key={chat.id}>
                <button
                  type="button"
                  aria-current={active === chat.id ? "page" : undefined}
                  disabled={disabled}
                  onClick={() => onSelect(chat.id)}
                >
                  <span className="chat-title">{chat.title}</span>
                  <span className={`chat-meta kit-${chat.grant.kit}`}>
                    <Icon size={12} aria-hidden="true" />
                    {kits[chat.grant.kit].label} · {shortModel(chat.model)}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export function humanizeTask(kind: string) {
  const name = kind.replace(/^(still|pi)\./, "").replaceAll("-", " ");

  return name.charAt(0).toUpperCase() + name.slice(1);
}

export function WorkView({
  work,
  chats,
  onOpen,
}: {
  readonly work: Schema.Schema.Type<typeof Work>;
  readonly chats: readonly ChatSummary[];
  readonly onOpen: (id: number) => void;
}) {
  return (
    <section className="page" aria-labelledby="work-title">
      <h1 id="work-title">Work</h1>
      <p className="lede">
        Durable tasks running now. Finished work leaves this list; answers stay
        in their chats.
      </p>
      <h2>Running</h2>
      {work.length === 0 ? (
        <div className="empty-card">
          <Activity size={20} aria-hidden="true" />
          <p>Nothing running. Background research and agents appear here.</p>
        </div>
      ) : (
        <ul className="rows">
          {work.map((task) => (
            <li key={task.id}>
              <button type="button" onClick={() => onOpen(task.conversationId)}>
                <span className="row-main">
                  <strong>{humanizeTask(task.kind)}</strong>
                  <small>
                    {chats.find((chat) => chat.id === task.conversationId)
                      ?.title ?? `Chat ${task.conversationId}`}
                    {task.background ? " · background" : ""}
                  </small>
                </span>
                <span className={`status status-${task.status}`}>
                  {task.status}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function SettingsView({ active }: { readonly active: number | null }) {
  const [status, setStatus] = useState("");

  const [feedback, setFeedback] = useState<readonly FeedbackItem[] | null>(
    null,
  );

  useEffect(() => {
    const controller = new AbortController();

    Effect.runPromise(request("/api/feedback", FeedbackList), {
      signal: controller.signal,
    })
      .then(setFeedback)
      .catch(() => {
        if (!controller.signal.aborted) setFeedback([]);
      });

    return () => controller.abort();
  }, []);

  async function enable() {
    try {
      const config = await Effect.runPromise(
        request("/api/push", Schema.Struct({ publicKey: Schema.String })),
      );

      if (!config.publicKey) {
        setStatus("Push needs operator VAPID configuration.");

        return;
      }

      if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
        setStatus("This browser does not support Web Push.");

        return;
      }

      const registration = await navigator.serviceWorker.register("/sw.js");

      await navigator.serviceWorker.ready;

      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: config.publicKey,
      });

      const decoded = Schema.decodeUnknownSync(PushSubscription)(
        subscription.toJSON(),
      );

      await Effect.runPromise(request("/api/push/subscribe", Receipt, decoded));
      setStatus("Subscribed. Send a test from a conversation.");
    } catch {
      setStatus(
        "Notification subscription failed. Check permissions and operator setup.",
      );
    }
  }

  async function disable() {
    try {
      const registration = await navigator.serviceWorker?.getRegistration();
      const subscription = await registration?.pushManager.getSubscription();

      if (subscription) {
        await Effect.runPromise(
          request("/api/push/unsubscribe", Receipt, {
            endpoint: subscription.endpoint,
          }),
        );
        await subscription.unsubscribe();
      }

      setStatus("Notifications disabled for this browser.");
    } catch {
      setStatus(
        "Could not revoke notifications. Try again before clearing browser storage.",
      );
    }
  }

  async function test(conversationId: number) {
    await Effect.runPromise(
      request("/api/push/test", Receipt, {
        eventId: crypto.randomUUID(),
        conversationId,
      }).pipe(
        Effect.match({
          onSuccess: () =>
            setStatus("Test event admitted; delivery is not guaranteed."),
          onFailure: (failure) => setStatus(failure.message),
        }),
      ),
    );
  }

  return (
    <section className="page" aria-labelledby="settings-title">
      <h1 id="settings-title">Settings</h1>
      <h2>Notifications</h2>
      <div className="card">
        <p>
          Notifications say only “An update is ready” and carry no chat content.
          Automatic notifications for background work arrive in a later phase;
          today you can send a test.
        </p>
        <div className="button-row">
          <button type="button" className="button primary" onClick={enable}>
            <Bell size={16} aria-hidden="true" /> Enable
          </button>
          <button type="button" className="button" onClick={disable}>
            <BellOff size={16} aria-hidden="true" /> Disable
          </button>
          <button
            type="button"
            className="button"
            disabled={active === null}
            title={active === null ? "Open a chat to send a test" : undefined}
            onClick={() => active !== null && void test(active)}
          >
            <Send size={16} aria-hidden="true" /> Send test
          </button>
        </div>
        <p className="status-text" role="status">
          {status}
        </p>
      </div>
      <h2>Feedback{feedback?.length ? ` · ${feedback.length}` : ""}</h2>
      {feedback?.length ? (
        <ul className="rows feedback-list">
          {feedback.map((item) => (
            <li key={item.id}>
              <p>{item.text}</p>
              <small>
                <time dateTime={new Date(item.createdAt).toISOString()}>
                  {new Date(item.createdAt).toLocaleString()}
                </time>{" "}
                · {item.context}
              </small>
            </li>
          ))}
        </ul>
      ) : (
        <div className="empty-card">
          <p>
            {feedback === null
              ? "Loading…"
              : "Type /feedback and a note in any chat to log it here."}
          </p>
        </div>
      )}
      <h2>About</h2>
      <div className="card">
        <dl>
          <dt>Runtime</dt>
          <dd>Pi Durable 1.0.2 · fresh-state v1</dd>
          <dt>Costs</dt>
          <dd>Reported by providers; not a billing guarantee.</dd>
          <dt>Appearance</dt>
          <dd>Follows the system light or dark setting.</dd>
        </dl>
      </div>
    </section>
  );
}

export function DecisionCard({
  url,
  onDecide,
}: {
  readonly url: string;
  readonly onDecide: (allow: boolean) => void;
}) {
  return (
    <section className="decision" aria-label="Decision needed">
      <p className="decision-title">
        <Globe size={16} aria-hidden="true" /> Allow Still to read this URL?
      </p>
      <code>{url}</code>
      <p className="decision-hint">
        Applies to this exact URL only, not the site. Then send Continue.
      </p>
      <div className="button-row">
        <button
          type="button"
          className="button primary"
          onClick={() => onDecide(true)}
        >
          Allow this URL
        </button>
        <button
          type="button"
          className="button"
          onClick={() => onDecide(false)}
        >
          Deny
        </button>
      </div>
    </section>
  );
}
