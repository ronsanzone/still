import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { Effect, Option, Schema } from "effect";
import {
  BuilderStart,
  BuilderStatus,
  CandidateVersion,
  type BuilderStatus as Status,
} from "../shared/builder.ts";
import { Receipt, type ModelChoice } from "../shared/contracts.ts";
import { request } from "./api.ts";

export function BuilderSheet(props: {
  models: readonly ModelChoice[];
  model: string;
  task: string;
  onClose: () => void;
  onOpen: (id: number) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [token, setToken] = useState("");
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);

  const restored = Schema.decodeUnknownOption(
    Schema.fromJsonString(BuilderStart),
  )(localStorage.getItem("still:builder-pending") ?? "");

  const [pending, setPending] = useState(Option.getOrNull(restored));
  const [task, setTask] = useState(pending?.text ?? props.task);
  const [model, setModel] = useState(pending?.model ?? props.model);

  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  async function run<A>(
    effect: Effect.Effect<A, { readonly message: string }>,
    done: (value: A) => void,
  ) {
    setWorking(true);
    setError("");
    await Effect.runPromise(
      effect.pipe(
        Effect.match({
          onSuccess: done,
          onFailure: (failure) => setError(failure.message),
        }),
      ),
    );
    setWorking(false);
  }

  function refresh() {
    return request("/api/builder/status", BuilderStatus, undefined, token);
  }

  return (
    <dialog
      ref={dialog}
      className="modal-backdrop"
      aria-label="Still Builder"
      onCancel={props.onClose}
    >
      <section className="model-sheet builder-sheet">
        <header>
          <div>
            <p className="eyebrow">EXPLICIT OWNER AUTHORITY</p>
            <h2>Still Builder</h2>
          </div>
          <button
            className="icon-button"
            aria-label="Close Builder"
            onClick={props.onClose}
          >
            <X size={20} />
          </button>
        </header>
        <p className="sheet-note">
          Edit a candidate copy, inspect checks and preview, then approve an
          exact version. Shell and extensions are trusted code, not sandboxed.
          Ordinary chat stays tool-free.
        </p>
        <div className="sheet-fields">
          <label>
            Owner token
            <input
              aria-label="Builder owner token"
              type="password"
              autoComplete="off"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              placeholder="From your self-hosted supervisor"
            />
          </label>
          <button
            className="builder-action"
            disabled={working}
            onClick={() => void run(refresh(), setStatus)}
          >
            Unlock / refresh
          </button>
          {status && (
            <>
              <p className="builder-release">
                Active release <code>{status.active}</code>
                <span>{status.outcome}</span>
              </p>
              <label>
                Builder model
                <select
                  aria-label="Builder model"
                  value={model}
                  disabled={pending !== null}
                  onChange={(event) => setModel(event.target.value)}
                >
                  {props.models.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name} · {item.provider}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                App fix / extension
                <textarea
                  aria-label="Builder task"
                  value={task}
                  rows={3}
                  maxLength={16000}
                  readOnly={pending !== null}
                  onChange={(event) => setTask(event.target.value)}
                />
              </label>
              <button
                className="builder-action"
                disabled={working || !model || !task.trim()}
                onClick={() => {
                  const input = pending ?? {
                    text: task.trim(),
                    model,
                    requestId: crypto.randomUUID(),
                  };

                  localStorage.setItem(
                    "still:builder-pending",
                    JSON.stringify(input),
                  );
                  setPending(input);
                  void run(
                    request("/api/builder/create", Receipt, input, token),
                    (result) => {
                      localStorage.removeItem("still:builder-pending");
                      setPending(null);
                      props.onOpen(result.id);
                      props.onClose();
                    },
                  );
                }}
              >
                {pending
                  ? "Replay Builder admission"
                  : "Start coding candidate"}
              </button>
              {status.candidates
                .slice()
                .reverse()
                .map((candidate) => (
                  <article key={candidate.id} className="builder-candidate">
                    <strong>{candidate.id}</strong>
                    <span>{candidate.status}</span>
                    <code>
                      {candidate.version || "No validated version yet"}
                    </code>
                    <div className="group-actions">
                      <button
                        disabled={working}
                        onClick={() =>
                          void run(
                            request(
                              "/api/builder/validate",
                              CandidateVersion,
                              { candidate: candidate.id },
                              token,
                            ).pipe(Effect.flatMap(refresh)),
                            setStatus,
                          )
                        }
                      >
                        Run checks / preview
                      </button>
                      {candidate.preview &&
                        candidate.status === "validated" && (
                          <a
                            href={candidate.preview}
                            target="_blank"
                            rel="noreferrer"
                          >
                            Open disposable preview ↗
                          </a>
                        )}
                      <button
                        disabled={working || candidate.status !== "validated"}
                        onClick={() => {
                          if (
                            !window.confirm(
                              `Approve and activate exactly ${candidate.version}? This restarts Still. Code rollback does not undo database writes.`,
                            )
                          )
                            return;
                          void run(
                            request(
                              "/api/builder/activate",
                              BuilderStatus,
                              {
                                candidate: candidate.id,
                                version: candidate.version,
                              },
                              token,
                            ),
                            (result) => {
                              setStatus(result);

                              if (result.active === candidate.version)
                                location.reload();
                            },
                          );
                        }}
                      >
                        Approve exact version / activate
                      </button>
                    </div>
                    {candidate.diff && (
                      <details>
                        <summary>Validated source diff</summary>
                        <pre>{candidate.diff}</pre>
                      </details>
                    )}
                    {candidate.checks && (
                      <details>
                        <summary>Checks / failure details</summary>
                        <pre>{candidate.checks}</pre>
                      </details>
                    )}
                  </article>
                ))}
            </>
          )}
          {working && (
            <p role="status">
              Working in the supervisor. Safe to disconnect; refresh to inspect
              the outcome.
            </p>
          )}
          {error && (
            <p role="alert" className="error-note">
              {error}
            </p>
          )}
        </div>
      </section>
    </dialog>
  );
}
