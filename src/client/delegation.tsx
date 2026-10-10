import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import { X } from "lucide-react";
import type {
  ChatSnapshot,
  Group,
  GroupAction,
  LaunchGroup,
  ModelChoice,
} from "../shared/contracts.ts";

export function DelegationSheet(props: {
  models: readonly ModelChoice[];
  snapshot: ChatSnapshot | null;
  model: string;
  count: number;
  task: string;
  pending: LaunchGroup | null;
  error: string;
  onClose: () => void;
  onLaunch: (input: LaunchGroup) => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const requestId = useRef(props.pending?.requestId ?? crypto.randomUUID());
  const [task, setTask] = useState(props.pending?.task ?? props.task);

  const [mode, setMode] = useState<LaunchGroup["mode"]>(
    props.pending?.mode ?? "fresh",
  );

  const [boundary, setBoundary] = useState(
    props.pending?.sourceEntry ?? props.snapshot?.entries?.at(-1)?.id ?? 0,
  );

  const [slots, setSlots] = useState<readonly string[]>(
    props.pending?.models ??
      Array.from({ length: props.count }, () => props.model),
  );

  const [launching, setLaunching] = useState(false);

  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  return (
    <dialog
      ref={dialog}
      className="modal-backdrop"
      aria-label="Set up delegation"
      onCancel={props.onClose}
    >
      <form
        className="model-sheet delegation-sheet"
        onSubmit={(event) => {
          event.preventDefault();
          setLaunching(true);
          void props
            .onLaunch({
              task: task.trim(),
              mode,
              sourceEntry: mode === "fork" ? boundary : null,
              models: slots,
              requestId: requestId.current,
            })
            .finally(() => setLaunching(false));
        }}
      >
        <header>
          <div>
            <p className="eyebrow">USER-TRIGGERED / CHAT ONLY</p>
            <h2>{slots.length === 1 ? "Delegate a task" : "Start an arena"}</h2>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="Close delegation setup"
            onClick={props.onClose}
          >
            <X size={20} />
          </button>
        </header>
        <div className="sheet-fields">
          <label>
            Task / brief
            <textarea
              aria-label="Delegation task"
              value={task}
              onChange={(event) => setTask(event.target.value)}
              maxLength={16000}
              rows={3}
              required
              readOnly={props.pending !== null}
            />
          </label>
          <label>
            Context
            <select
              aria-label="Context mode"
              value={mode}
              disabled={props.pending !== null}
              onChange={(event) =>
                setMode(event.target.value === "fork" ? "fork" : "fresh")
              }
            >
              <option value="fresh">Fresh brief · task only</option>
              <option value="fork" disabled={!props.snapshot?.entries?.length}>
                Frozen fork · through one entry
              </option>
            </select>
          </label>
          {mode === "fork" && (
            <label>
              Include history through
              <select
                aria-label="Context boundary"
                value={boundary}
                disabled={props.pending !== null}
                onChange={(event) => setBoundary(Number(event.target.value))}
              >
                {props.snapshot?.entries?.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    #{entry.id} · {entry.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          <p className="sheet-note">
            The boundary is inclusive. Later parent messages and sibling answers
            are excluded. Put all required context in a fresh brief. No tools or
            workspace access.
          </p>
          <label>
            Model workloads
            <select
              aria-label="Arena slot count"
              value={slots.length}
              disabled={props.pending !== null}
              onChange={(event) =>
                setSlots(
                  Array.from(
                    { length: Number(event.target.value) },
                    (_, slot) => slots[slot] ?? props.model,
                  ),
                )
              }
            >
              {[1, 2, 3, 4, 5].map((count) => (
                <option key={count} value={count}>
                  {count} {count === 1 ? "child" : "independent children"}
                </option>
              ))}
            </select>
          </label>
          {slots.map((model, slot) => (
            <label key={slot}>
              Slot {slot + 1}
              <select
                aria-label={`Model for slot ${slot + 1}`}
                value={model}
                disabled={props.pending !== null}
                onChange={(event) =>
                  setSlots((values) =>
                    values.map((value, index) =>
                      index === slot ? event.target.value : value,
                    ),
                  )
                }
              >
                {props.models.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name} · {item.provider}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
        <p className="sheet-note">
          {slots.length} model {slots.length === 1 ? "workload" : "workloads"}.
          Nothing returns to this chat automatically. Work continues if you
          disconnect.
        </p>
        {props.error && (
          <p className="error-banner" role="alert">
            {props.error}
          </p>
        )}
        <button
          type="submit"
          className="launch-button"
          disabled={
            launching ||
            !task.trim() ||
            slots.some((item) => !item) ||
            (mode === "fork" && !boundary)
          }
        >
          {launching
            ? "Launching…"
            : props.pending
              ? "Retry the same launch"
              : `Launch ${slots.length === 1 ? "delegate" : "arena"}`}
        </button>
      </form>
    </dialog>
  );
}

export function GroupCard(props: {
  group: Group;
  models: readonly ModelChoice[];
  onOpen: (id: number) => void;
  onAction: (input: GroupAction) => Promise<void>;
}) {
  const [compare, setCompare] = useState(false);
  const [slot, setSlot] = useState(0);

  const [synthesisModel, setSynthesisModel] = useState(
    props.group.candidates[0]?.model ?? "",
  );

  const [pending, setPending] = useState(false);

  const [actionId, setActionId] = useState<{ key: string; id: string } | null>(
    null,
  );

  const group = props.group;

  const completed = group.candidates.flatMap((item) =>
    item.status === "completed" ? [item] : [],
  );

  const live = group.candidates.some(
    (item) =>
      item.status === "queued" ||
      item.status === "running" ||
      item.status === "cancelling",
  );

  const selected = group.candidates[slot];

  function action(kind: GroupAction["action"], target = slot) {
    const key = `${kind}:${target}:${group.candidates[target]?.attempt}`;
    const id = actionId?.key === key ? actionId.id : crypto.randomUUID();
    setActionId({ key, id });
    setPending(true);
    void props
      .onAction({
        groupId: group.id,
        action: kind,
        slot: target,
        requestId: id,
        model: synthesisModel,
      })
      .then(() => setActionId(null))
      .catch(() => {})
      .finally(() => setPending(false));
  }

  return (
    <details className="group-card" open={compare || undefined}>
      <summary>
        <span>
          <strong>
            {group.candidates.length === 1 ? "Delegate" : "Arena"} ·{" "}
            {completed.length}/{group.candidates.length} answers
          </strong>
          <small>
            {live
              ? "Working in background"
              : group.cancelled
                ? "Stopped"
                : "Settled"}{" "}
            ·{" "}
            {group.mode === "fork"
              ? `frozen through #${group.sourceEntry}`
              : "fresh brief"}
          </small>
        </span>
        <span className="muted">↗</span>
      </summary>
      <p className="group-task">{group.task}</p>
      <div className="candidate-list">
        {group.candidates.map((item) => (
          <div className="candidate-row" key={`${item.slot}:${item.attempt}`}>
            <button
              className="candidate-open"
              onClick={() => props.onOpen(item.conversationId)}
            >
              <strong>
                {item.slot + 1} ·{" "}
                {props.models.find((model) => model.id === item.model)?.name ??
                  item.model}
              </strong>
              <small>
                {item.status} · attempt {item.attempt} · open chat ↗
              </small>
            </button>
            <button
              disabled={pending || item.status === "cancelling"}
              onClick={() =>
                action(
                  item.status === "running" || item.status === "queued"
                    ? "stop"
                    : "retry",
                  item.slot,
                )
              }
            >
              {item.status === "cancelling"
                ? "Stopping…"
                : item.status === "running" || item.status === "queued"
                  ? "Stop"
                  : "Retry"}
            </button>
            {item.error && <p className="candidate-error">{item.error}</p>}
          </div>
        ))}
      </div>
      <div className="group-actions">
        <button onClick={() => setCompare((value) => !value)}>
          {compare ? "Close comparison" : "Compare answers"}
        </button>
        <button disabled={pending} onClick={() => action("cancel", 0)}>
          Stop group
        </button>
      </div>
      {compare && (
        <section className="comparison" aria-label="Compare arena answers">
          <label>
            Result
            <select
              aria-label="Compare slot"
              value={slot}
              onChange={(event) => setSlot(Number(event.target.value))}
            >
              {group.candidates.map((item) => (
                <option key={item.slot} value={item.slot}>
                  Slot {item.slot + 1} ·{" "}
                  {props.models.find((model) => model.id === item.model)
                    ?.name ?? item.model}{" "}
                  · {item.status}
                </option>
              ))}
            </select>
          </label>
          <div className="message-body">
            <Markdown>
              {selected?.answer || "This child has no completed answer yet."}
            </Markdown>
          </div>
          <div className="group-actions">
            <button
              disabled={pending || selected?.status !== "completed"}
              onClick={() => action("return")}
            >
              Use this answer
            </button>
            <button
              onClick={() => selected && props.onOpen(selected.conversationId)}
            >
              Continue separately ↗
            </button>
          </div>
          <label>
            Synthesis model
            <select
              aria-label="Synthesis model"
              value={synthesisModel}
              onChange={(event) => setSynthesisModel(event.target.value)}
            >
              {props.models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.name}
                </option>
              ))}
            </select>
          </label>
          <p className="sheet-note">
            Synthesis starts one additional model workload from the completed
            answers. It still requires explicit return.
          </p>
          <button
            className="launch-button"
            disabled={pending || !completed.length}
            onClick={() => action("synthesize", 0)}
          >
            Synthesize {completed.length} results
          </button>
        </section>
      )}
    </details>
  );
}
