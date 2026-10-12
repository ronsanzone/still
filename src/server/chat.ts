import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  Config,
  Context,
  Effect,
  Layer,
  Predicate,
  Queue,
  Schema,
  Semaphore,
  Stream,
} from "effect";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  AgentDoc,
  LiveDoc,
  InboxDoc,
  UsageDoc,
  configure,
  createRegistry,
  Harness,
  type ConversationId,
  type ConversationView,
  type EntryId,
  type Tx,
} from "@earendil-works/pi-durable";
import type {
  Message as PiMessage,
  TextContent,
  ImageContent,
} from "@earendil-works/pi-ai";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import {
  ChatId,
  type Branch,
  type ChatSnapshot,
  type ChatSummary,
  type Message,
  type SendMessage,
  Work,
} from "../shared/contracts.ts";
import { ModelCatalog } from "./models.ts";
import { ChatServices } from "./services.ts";
import { Attachments, AttachmentEntry } from "../kernel/attachments.ts";
import { SearchProvider } from "../kernel/search.ts";
import { researchExtension, citations } from "../kernel/research.ts";
import {
  Notifier,
  notificationExtension,
  subscribe,
  unsubscribe,
} from "../kernel/push.ts";
import type { PushSubscription, PushEvent } from "../shared/push.ts";
import type { FeedbackInput, FeedbackItem } from "../shared/feedback.ts";
import { FeedbackDoc, recordFeedback } from "../kernel/feedback.ts";
import { loadExtensions } from "../kernel/extensions.ts";
import {
  ChatFailure,
  ChatDoc,
  ChatStart,
  ModelChange,
  agentExtension,
  idle,
  workspaceEnv,
} from "../kernel/agent.ts";

export { ChatFailure } from "../kernel/agent.ts";

const attempt = <A>(operation: () => Promise<A>) =>
  Effect.tryPromise({
    try: operation,
    catch: (error) =>
      error instanceof ChatFailure
        ? error
        : new ChatFailure({
            message:
              "The chat operation failed. Reconnect and retry; existing data is preserved.",
            status: 500,
          }),
  });

function message(
  id: string,
  entry: number | null,
  before: number | null,
  value: PiMessage,
): Message[] {
  if (value.role !== "user" && value.role !== "assistant") return [];

  const content = Predicate.isString(value.content)
    ? [{ type: "text", text: value.content }]
    : value.content;

  const result: Message = {
    id,
    entry,
    before,
    role: value.role,
    text: content
      .flatMap((part) =>
        part.type === "text" && "text" in part ? [part.text] : [],
      )
      .join(""),
    thinking: content
      .flatMap((part) =>
        part.type === "thinking" && "thinking" in part ? [part.thinking] : [],
      )
      .join(""),
    interrupted: value.role === "assistant" && value.stopReason === "aborted",
    failed: value.role === "assistant" && value.stopReason === "error",
  };

  if (value.role === "user" && Array.isArray(value.content)) {
    return [
      {
        ...result,
        text: value.content[0]?.type === "text" ? value.content[0].text : "",
        images: value.content.flatMap((part) =>
          part.type === "image"
            ? [{ mimeType: part.mimeType, data: part.data }]
            : [],
        ),
        attachmentText: value.content
          .slice(1)
          .flatMap((part) => (part.type === "text" ? [part.text] : []))
          .join("\n\n"),
      },
    ];
  }

  return value.role === "assistant"
    ? [
        {
          ...result,
          model: `${value.provider}/${value.model}`,
          cost: value.usage.cost.total,
        },
      ]
    : [result];
}

export class Chats extends Context.Service<
  Chats,
  {
    readonly list: () => Effect.Effect<readonly ChatSummary[], ChatFailure>;
    readonly create: (model: string) => Effect.Effect<ChatSummary, ChatFailure>;
    readonly branch: (
      id: number,
      input: Branch,
    ) => Effect.Effect<{ id: number }, ChatFailure | Schema.SchemaError>;
    readonly send: (
      id: number,
      input: SendMessage,
    ) => Effect.Effect<{ id: number }, ChatFailure | Schema.SchemaError>;
    readonly stop: (
      id: number,
    ) => Effect.Effect<void, ChatFailure | Schema.SchemaError>;
    readonly watch: (
      id: number,
    ) => Stream.Stream<ChatSnapshot, ChatFailure | Schema.SchemaError>;
    readonly work: () => Effect.Effect<
      Schema.Schema.Type<typeof Work>,
      ChatFailure
    >;
    readonly extensions: readonly string[];
    readonly pdf: (
      id: number,
      hash: string,
    ) => Effect.Effect<Uint8Array, ChatFailure | Schema.SchemaError>;
    readonly subscribe: (
      input: PushSubscription,
    ) => Effect.Effect<void, ChatFailure>;
    readonly unsubscribe: (
      endpoint: string,
    ) => Effect.Effect<void, ChatFailure>;
    readonly notify: (
      input: PushEvent,
    ) => Effect.Effect<{ id: number }, ChatFailure>;
    readonly feedback: (
      input: FeedbackInput,
      release: string,
    ) => Effect.Effect<void, ChatFailure>;
    readonly feedbackList: () => Effect.Effect<
      readonly FeedbackItem[],
      ChatFailure
    >;
  }
>()("still/Chats") {
  static readonly core = Layer.effect(
    Chats,
    Effect.gen(function* () {
      const catalog = yield* ModelCatalog;
      const attachments = yield* Attachments;
      const research = researchExtension(yield* SearchProvider, attachments);
      const push = notificationExtension(yield* Notifier);

      const path = yield* Config.String("STILL_DATABASE").pipe(
        Config.withDefault(".data/still-v1.sqlite"),
      );

      // Where the agent's tools run. Isolation comes later; today this is a host directory.
      const workspace = resolve(
        yield* Config.String("STILL_WORKSPACE").pipe(
          Config.withDefault(join(dirname(path), "workspace")),
        ),
      );

      const admission = yield* Semaphore.make(1);
      yield* attempt(() => mkdir(dirname(path), { recursive: true }));
      yield* attempt(() => mkdir(workspace, { recursive: true }));
      const registry = createRegistry();
      registry.install(agentExtension(workspace));
      registry.install(research);
      registry.install(push.extension);

      const extensions = yield* attempt(() =>
        loadExtensions(join(process.cwd(), "extensions"), registry),
      );

      const harness = yield* Effect.acquireRelease(
        attempt(async () => {
          const storage = await openNodeSqliteStorage(path);

          const opened = await Harness.open(
            storage,
            {
              models: catalog.runtime,
              registry,
              // No stored selection: every conversation, fork and child gets all installed extensions.
              env: workspaceEnv(workspace),
            },
            context,
          ).catch(async (error) => {
            await storage.close(context);
            throw error;
          });

          return opened;
        }),
        (value) => Effect.promise(() => value.close(context)),
      );

      harness.resume();

      const conversation = Effect.fn("Chat.conversation")(function* (
        id: number,
      ) {
        const valid = yield* Schema.decodeUnknownEffect(ChatId)(id);

        // SAFETY: Schema validates positive IDs; Pi checks existence.
        const handle = yield* attempt(() =>
          harness.conversation(valid as ConversationId, context),
        );

        if (!handle)
          return yield* new ChatFailure({
            message: "Conversation not found.",
            status: 404,
          });

        return handle;
      });

      function modelRef(model: string) {
        const selected = catalog.runtime
          .getModels()
          .find((item) => `${item.provider}/${item.id}` === model);

        // Choices are the offered models; the server accepts nothing else.
        if (!selected || !catalog.choices.some((choice) => choice.id === model))
          throw new ChatFailure({
            message: "Choose an available model.",
            status: 400,
          });

        return { provider: selected.provider, modelId: selected.id };
      }

      async function summary(tx: Tx, id: ConversationId): Promise<ChatSummary> {
        const meta = await tx.doc(ChatDoc, id);
        const agent = await tx.doc(AgentDoc, id);

        return {
          id,
          title: meta.title,
          model: agent.model
            ? `${agent.model.provider}/${agent.model.modelId}`
            : "",
        };
      }

      const list = Effect.fn("Chat.list")(function* () {
        return yield* attempt(() =>
          harness.commit(async (tx) => {
            const result: ChatSummary[] = [];
            let page = await tx.scanConversations({}, 100);

            while (true) {
              for (const record of page.items)
                result.push(await summary(tx, record.id));

              if (!page.next) break;
              page = await tx.scanConversations({}, 100, page.next);
            }

            return result.reverse();
          }, context),
        );
      });

      const create = Effect.fn("Chat.create")(function* (model: string) {
        return yield* attempt(() =>
          harness.commit(async (tx) => {
            const selected = modelRef(model);

            const created = await tx.createConversation({
              ownership: { kind: "ownerless" },
            });

            await configure(tx, created.id, {
              model: selected,
              thinkingLevel: "low",
            });
            await tx.appendEntry(ChatStart, created.id, { data: { model } });

            return summary(tx, created.id);
          }, context),
        );
      });

      const send = Effect.fn("Chat.send")(function* (
        id: number,
        input: SendMessage,
      ) {
        const handle = yield* conversation(id);

        const replay = yield* attempt(() =>
          handle.commit(async (tx) => {
            const existing = await tx.submissionByRequest(
              handle.id,
              input.requestId,
            );

            if (existing) return { id: existing.id };
            const agent = await tx.doc(AgentDoc, handle.id);

            const current = agent.model
              ? `${agent.model.provider}/${agent.model.modelId}`
              : "";

            if (input.attachments?.length) await idle(tx, handle.id);

            if (input.model && input.model !== current) {
              const selected = modelRef(input.model);
              await idle(tx, handle.id);
              await configure(tx, handle.id, { model: selected });
              await tx.appendEntry(ModelChange, handle.id, {
                data: { from: current, to: input.model },
              });
            }

            const meta = await tx.doc(ChatDoc, handle.id);

            if (meta.title === "New conversation")
              meta.title = input.text.trim().slice(0, 64);

            return undefined;
          }, context),
        );

        if (replay) return replay;

        const admitted = yield* Effect.forEach(
          input.attachments ?? [],
          (upload) => attachments.admit(upload),
        ).pipe(
          Effect.mapError(
            (error) => new ChatFailure({ message: error.message, status: 400 }),
          ),
        );

        const content: (TextContent | ImageContent)[] = [
          { type: "text", text: input.text },
        ];

        if (input.reuseEntry) {
          const record = yield* attempt(() =>
            harness.commit((tx) => tx.conversation(handle.id), context),
          );

          const parent = record?.parent;

          if (!parent)
            return yield* new ChatFailure({
              message: "Attachment reuse requires a branch",
              status: 400,
            });
          const source = yield* conversation(parent.conversationId);
          const original = yield* attempt(() => source.context(context));

          const at = original.entries.findIndex(
            (entry) => entry.id === input.reuseEntry,
          );

          const message = original.entries[at]?.model?.find(
            (item) => item.role === "user",
          );

          if (at < 1 || original.entries[at - 1]?.id !== parent.at || !message)
            return yield* new ChatFailure({
              message: "Attachment source is not the branch's next prompt",
              status: 400,
            });

          if (Array.isArray(message.content))
            content.push(...message.content.slice(1));
        }

        if (admitted.length) {
          const view = yield* attempt(() => handle.context(context));

          const previous = yield* attempt(() =>
            handle.commit(async (tx) => {
              const submission = await tx.submissionByRequest(
                handle.id,
                `attachments-${input.requestId}`,
              );

              if (!submission?.entry) return undefined;

              return tx.entry(AttachmentEntry, submission.entry);
            }, context),
          );

          if (
            previous &&
            JSON.stringify(previous.data.files) !==
              JSON.stringify(admitted.map((item) => item.metadata))
          )
            return yield* new ChatFailure({
              message: "Attachment request identity conflict",
              status: 409,
            });

          const start = Math.max(
            0,
            ...citations(view.entries).map((item) => item.number),
          );

          const sources =
            previous?.data.citations ??
            admitted.map((item, index) => ({
              number: start + index + 1,
              url: `attachment:${item.metadata.sha256}`,
              title: item.metadata.name,
              fetchedAt: new Date().toISOString(),
            }));

          for (const [index, item] of admitted.entries())
            content.push(
              {
                type: "text",
                text: `Uploaded source [${sources[index]?.number}]`,
              },
              ...item.content,
            );
          yield* attempt(() =>
            handle.submit(
              {
                type: "write",
                requestId: `attachments-${input.requestId}`,
                entry: {
                  kind: AttachmentEntry.kind,
                  data: {
                    files: admitted.map((item) => ({ ...item.metadata })),
                    citations: sources,
                  },
                },
              },
              context,
            ),
          );
        }

        // Pi 1.0.2 has no public tx.submit. Serialize host calls across this boundary;
        // a crash before submit admits no input. Never nest submit inside commit.
        const submitted = yield* attempt(() =>
          handle.submit(
            {
              type: "input",
              content: content.length === 1 ? input.text : content,
              requestId: input.requestId,
              whenBusy: input.whenBusy ?? "followUp",
            },
            context,
          ),
        );

        return { id: submitted.id };
      });

      const branch = Effect.fn("Chat.branch")(function* (
        id: number,
        input: Branch,
      ) {
        const handle = yield* conversation(id);

        return yield* attempt(() =>
          harness.commit(async (tx) => {
            const selected = modelRef(input.model);
            await idle(tx, handle.id);

            // SAFETY: request schema validates positive EntryId. Pi verifies ancestry.
            const record = await tx.forkConversation(
              handle.id,
              input.entry as EntryId,
              { ownership: { kind: "ownerless" } },
            );

            await configure(tx, record.id, { model: selected });

            return { id: record.id };
          }, context),
        );
      });

      const stop = Effect.fn("Chat.stop")(function* (id: number) {
        const handle = yield* conversation(id);
        yield* attempt(() => handle.abort(context));
      });

      const project = Effect.fn("Chat.project")(function* (
        view: ConversationView,
      ) {
        const id = view.conversation.id;

        return yield* attempt(() =>
          harness.commit(async (tx) => {
            const state = {
              ...(await summary(tx, id)),
              live: await tx.doc(LiveDoc, id),
              inbox: await tx.doc(InboxDoc, id),
              usage: await tx.doc(UsageDoc, id),
            };

            const messages = view.entries.flatMap((entry, index) =>
              (entry.model ?? []).flatMap((value, part) =>
                message(
                  `${entry.id}-${part}`,
                  entry.id,
                  view.entries[index - 1]?.id ?? null,
                  value,
                ),
              ),
            );

            if (state.live.generation?.message)
              messages.push(
                ...message("live", null, null, state.live.generation.message),
              );

            const result: ChatSnapshot = {
              id,
              title: state.title,
              model: state.model,
              messages,
              busy: state.live.run !== undefined,
              queued: state.inbox.items.length,
              attachments: view.entries.flatMap((entry) =>
                AttachmentEntry.is(entry) ? entry.data.files : [],
              ),
              citations: citations(view.entries),
              cost: [
                ...Object.values(state.usage.models),
                ...Object.values(state.usage.tools),
              ].reduce((sum, usage) => sum + usage.cost.total, 0),
              changes: view.entries.flatMap((entry) =>
                ModelChange.is(entry)
                  ? [{ id: entry.id, text: `Model: ${entry.data.to}` }]
                  : [],
              ),
              tools: view.entries.flatMap((entry) =>
                (entry.model ?? []).flatMap((item) =>
                  item.role === "toolResult"
                    ? [
                        {
                          id: String(entry.id),
                          name: item.toolName,
                          text: item.content
                            .flatMap((part) =>
                              part.type === "text" ? [part.text] : [],
                            )
                            .join(""),
                          failed: item.isError,
                        },
                      ]
                    : [],
                ),
              ),
            };

            return view.conversation.parent
              ? { ...result, parent: view.conversation.parent.conversationId }
              : result;
          }, context),
        );
      });

      const watch = (id: number) =>
        Stream.callback<ConversationView, ChatFailure | Schema.SchemaError>(
          (queue) =>
            Effect.gen(function* () {
              const handle = yield* conversation(id);

              const observer = yield* Effect.acquireRelease(
                attempt(() => handle.watch(context)),
                (value) => Effect.promise(() => value.stop()),
              );

              yield* Effect.acquireRelease(
                Effect.sync(() =>
                  harness.subscribeCommits((publication) => {
                    if (
                      publication.changes.some(
                        (change) =>
                          change.type === "document" &&
                          change.conversationId === handle.id &&
                          change.record.kind === ChatDoc.definition.kind,
                      )
                    )
                      Queue.offerUnsafe(queue, observer.value);
                  }),
                ),
                (unsubscribe) => Effect.sync(unsubscribe),
              );
              Queue.offerUnsafe(queue, observer.value);
              observer.start(async (value) => {
                Queue.offerUnsafe(queue, value);
              });
            }).pipe(Effect.catch((error) => Queue.fail(queue, error))),
          { bufferSize: 1, strategy: "sliding" },
        ).pipe(Stream.mapEffect(project));

      const work = Effect.fn("Chat.work")(function* () {
        return yield* attempt(async () => {
          const watch = await harness.watchTaskGraph(context);

          try {
            return Object.values(watch.value.tasks).map((task) => ({
              id: task.id,
              conversationId: task.conversationId,
              kind: task.kind,
              status: task.state.status,
              background: task.background,
            }));
          } finally {
            await watch.stop();
          }
        });
      });

      const pdf = Effect.fn("Chat.pdf")(function* (id: number, hash: string) {
        const handle = yield* conversation(id);
        const view = yield* attempt(() => handle.context(context));

        if (
          !view.entries.some(
            (entry) =>
              AttachmentEntry.is(entry) &&
              entry.data.files.some(
                (item) =>
                  item.sha256 === hash && item.mimeType === "application/pdf",
              ),
          )
        )
          return yield* new ChatFailure({
            message: "Attachment not found in this conversation",
            status: 404,
          });

        return yield* attachments.readPdf(hash).pipe(
          Effect.mapError(
            () =>
              new ChatFailure({
                message: "Attachment unavailable",
                status: 404,
              }),
          ),
        );
      });

      return Chats.of({
        list,
        create,
        extensions: extensions.map((item) => item.name),
        send: (id, input) => send(id, input).pipe(admission.withPermits(1)),
        branch: (id, input) => branch(id, input).pipe(admission.withPermits(1)),
        stop,
        watch,
        work,
        pdf,
        subscribe: (input) =>
          attempt(() =>
            harness.commit(
              (tx) => Effect.runPromise(subscribe(tx, input, Date.now())),
              context,
            ),
          ),
        unsubscribe: (endpoint) =>
          attempt(() =>
            harness.commit(
              (tx) => Effect.runPromise(unsubscribe(tx, endpoint)),
              context,
            ),
          ),
        notify: (input) =>
          attempt(async () => ({
            id: await harness.commit(
              (tx) => Effect.runPromise(push.admit(tx, input)),
              context,
            ),
          })),
        feedback: (input, release) =>
          attempt(() =>
            harness.commit(
              (tx) =>
                recordFeedback(tx, {
                  id: input.requestId,
                  text: input.text,
                  conversationId: input.conversationId,
                  context: input.context,
                  release,
                  createdAt: Date.now(),
                }),
              context,
            ),
          ),
        feedbackList: () =>
          attempt(() =>
            harness.commit(
              // Copy out of the transaction overlay before it settles.
              async (tx) =>
                (await tx.doc(FeedbackDoc)).items
                  .map((item) => ({ ...item }))
                  .reverse(),
              context,
            ),
          ),
      });
    }),
  );
  static readonly layer = Chats.core.pipe(Layer.provide(ChatServices));
}
