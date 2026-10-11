import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
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
import type { Message as PiMessage } from "@earendil-works/pi-ai";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import {
  ChatId,
  Grant,
  type Branch,
  type ChatSnapshot,
  type ChatSummary,
  type Message,
  type SendMessage,
  Work,
} from "../shared/contracts.ts";
import type { BuilderAdmission } from "../shared/builder.ts";
import { ModelCatalog } from "./models.ts";
import { loadExtensions } from "../kernel/extensions.ts";
import {
  ChatFailure,
  ChatDoc,
  GrantDoc,
  KitChange,
  ModelChange,
  Kernel,
  environment,
  idle,
  selectKit,
  initializeConversation,
} from "../kernel/kits.ts";

export { ChatFailure } from "../kernel/kits.ts";

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
    readonly kit: (
      id: number,
      grant: Grant,
      supervisor?: boolean,
    ) => Effect.Effect<{ id: number }, ChatFailure | Schema.SchemaError>;
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
    // Protected supervisor bridge retained until ReleaseHost/passkey replacement, not a product surface.
    readonly builder: (
      input: BuilderAdmission,
    ) => Effect.Effect<{ id: number }, ChatFailure | Schema.SchemaError>;
    readonly builderCandidate: (
      id: number,
    ) => Effect.Effect<string, ChatFailure | Schema.SchemaError>;
    readonly extensions: readonly string[];
  }
>()("still/Chats") {
  static readonly layer = Layer.effect(
    Chats,
    Effect.gen(function* () {
      const catalog = yield* ModelCatalog;

      const path = yield* Config.String("STILL_DATABASE").pipe(
        Config.withDefault(".data/still-v1.sqlite"),
      );

      const root = yield* Config.String("STILL_BUILDER_ROOT").pipe(
        Config.withDefault(""),
      );

      const admission = yield* Semaphore.make(1);
      yield* attempt(() => mkdir(dirname(path), { recursive: true }));
      const registry = createRegistry();
      registry.install(Kernel);

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
              settings: { extensions: [] },
              env: (target, frame) => environment(root, target, frame),
              conversationCreated: initializeConversation,
            },
            context,
          ).catch(async (error) => {
            await storage.close(context);
            throw error;
          });

          try {
            await opened.commit(async (tx) => {
              let page = await tx.scanConversations({}, 100);

              while (true) {
                for (const record of page.items) {
                  const meta = await tx.doc(ChatDoc, record.id);

                  if ("model" in meta)
                    throw new ChatFailure({
                      message:
                        "Pre-v1 database refused. Archive it and select a fresh STILL_DATABASE; no migration is performed.",
                      status: 503,
                    });
                }

                if (!page.next) break;
                page = await tx.scanConversations({}, 100, page.next);
              }
            }, context);

            return opened;
          } catch (error) {
            await opened.close(context);
            throw error;
          }
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

        if (!selected)
          throw new ChatFailure({
            message: "Choose an available model.",
            status: 400,
          });

        return { provider: selected.provider, modelId: selected.id };
      }

      async function summary(tx: Tx, id: ConversationId): Promise<ChatSummary> {
        const meta = await tx.doc(ChatDoc, id);
        const agent = await tx.doc(AgentDoc, id);
        const grant = await tx.doc(GrantDoc, id);

        return {
          id,
          title: meta.title,
          model: agent.model
            ? `${agent.model.provider}/${agent.model.modelId}`
            : "",
          grant: { kit: grant.kit, target: grant.target },
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
            await tx.appendEntry(KitChange, created.id, {
              data: { from: "chat", to: "chat", target: null },
            });

            return summary(tx, created.id);
          }, context),
        );
      });

      const kit = Effect.fn("Chat.kit")(function* (
        id: number,
        input: Grant,
        supervisor = false,
      ) {
        const valid = yield* Schema.decodeUnknownEffect(Grant)(input);

        if (valid.kit === "still" && !supervisor)
          return yield* new ChatFailure({
            message:
              "Still requires a supervisor-created candidate; owner release controls are not yet available in this client.",
            status: 403,
          });
        const handle = yield* conversation(id);
        yield* attempt(() =>
          handle.commit(async (tx) => {
            await idle(tx, handle.id);
            const grant = await tx.doc(GrantDoc, handle.id);
            const from = grant.kit;
            await selectKit(tx, handle.id, valid, root);
            grant.kit = valid.kit;
            grant.target = valid.target;
            await tx.appendEntry(KitChange, handle.id, {
              data: { from, to: valid.kit, target: valid.target },
            });
          }, context),
        );

        return { id };
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

            const live = await tx.doc(LiveDoc, handle.id);
            const inbox = await tx.doc(InboxDoc, handle.id);

            if (input.model && input.model !== current) {
              const selected = modelRef(input.model);
              await idle(tx, handle.id);
              await configure(tx, handle.id, { model: selected });
              await tx.appendEntry(ModelChange, handle.id, {
                data: { from: current, to: input.model },
              });
            }

            if (!live.run && !inbox.items.length)
              await selectKit(
                tx,
                handle.id,
                await tx.doc(GrantDoc, handle.id),
                root,
              );
            const meta = await tx.doc(ChatDoc, handle.id);

            if (meta.title === "New conversation")
              meta.title = input.text.trim().slice(0, 64);

            return undefined;
          }, context),
        );

        if (replay) return replay;

        // Pi 1.0.2 has no public tx.submit. Serialize host calls across this boundary;
        // a crash before submit admits no input. Never nest submit inside commit.
        const submitted = yield* attempt(() =>
          handle.submit(
            {
              type: "input",
              content: input.text,
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

            await selectKit(tx, record.id, { kit: "chat", target: null }, root);
            await configure(tx, record.id, { model: selected });
            await tx.appendEntry(KitChange, record.id, {
              data: { from: "chat", to: "chat", target: null },
            });

            return { id: record.id };
          }, context),
        );
      });

      const builderCandidate = Effect.fn("Chat.target")(function* (id: number) {
        const handle = yield* conversation(id);

        const grant = yield* attempt(() =>
          harness.snapshot(GrantDoc, handle.id, context),
        );

        return grant?.target ?? "";
      });

      const builder = Effect.fn("Still.admitCandidate")(function* (
        input: BuilderAdmission,
      ) {
        const existing = (yield* list()).find(
          (item) => item.grant.target === input.candidate,
        );

        let id = existing?.id;

        if (id === undefined) {
          // Candidate identity is authoritative in the supervisor journal, not a second conversation store.
          id = yield* attempt(() =>
            harness.commit(async (tx) => {
              const selected = modelRef(input.model);

              const created = await tx.createConversation({
                ownership: { kind: "ownerless" },
              });

              const grant = await tx.doc(GrantDoc, created.id);
              grant.kit = "still";
              grant.target = input.candidate;
              await selectKit(tx, created.id, grant, root);
              await configure(tx, created.id, {
                model: selected,
                thinkingLevel: "low",
              });
              await tx.appendEntry(KitChange, created.id, {
                data: { from: "chat", to: "still", target: input.candidate },
              });

              return created.id;
            }, context),
          );
        } else {
          const handle = yield* conversation(id);
          const view = yield* attempt(() => handle.context(context));

          const first = view.entries
            .flatMap((entry) => entry.model ?? [])
            .find((item) => item.role === "user");

          if (
            existing?.model !== input.model ||
            (first && first.content !== input.text)
          )
            return yield* new ChatFailure({
              message: "Candidate already belongs to another task/model.",
              status: 409,
            });
        }

        yield* send(id, { text: input.text, requestId: input.requestId });

        return { id };
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
              grant: state.grant,
              messages,
              busy: state.live.run !== undefined,
              queued: state.inbox.items.length,
              cost: [
                ...Object.values(state.usage.models),
                ...Object.values(state.usage.tools),
              ].reduce((sum, usage) => sum + usage.cost.total, 0),
              changes: view.entries.flatMap((entry) =>
                KitChange.is(entry)
                  ? [{ id: entry.id, text: `Kit: ${entry.data.to}` }]
                  : ModelChange.is(entry)
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
                          [
                            GrantDoc.definition.kind,
                            ChatDoc.definition.kind,
                          ].includes(change.record.kind),
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

      return Chats.of({
        list,
        create,
        extensions: extensions.map((item) => item.name),
        kit: (id, input, supervisor) =>
          kit(id, input, supervisor).pipe(admission.withPermits(1)),
        send: (id, input) => send(id, input).pipe(admission.withPermits(1)),
        branch: (id, input) => branch(id, input).pipe(admission.withPermits(1)),
        builder: (input) => builder(input).pipe(admission.withPermits(1)),
        builderCandidate,
        stop,
        watch,
        work,
      });
    }),
  );
}
