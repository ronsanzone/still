import {
  configure,
  defineDoc,
  defineEntry,
  defineExtension,
  defineTask,
  type ConversationId,
  type EntryId,
  type Extension,
  type Harness,
  type TaskId,
  type Tx,
} from "@earendil-works/pi-durable";
import type { Group, LaunchGroup } from "../shared/contracts.ts";

export const chatInstructions =
  "You are Still, a thoughtful, helpful personal assistant. Be clear, warm, and concise. Use Markdown when useful. You have no tools, web access, file access, or ability to run code. Never imply you performed an action you cannot perform.";

type Member = {
  slot: number;
  conversationId: ConversationId;
  anchor: TaskId;
  worker: TaskId;
  model: string;
  attempt: number;
  status: Group["candidates"][number]["status"];
  answer: string;
  error: string;
};

type StoredGroup = {
  id: string;
  task: string;
  mode: LaunchGroup["mode"];
  sourceEntry: EntryId | null;
  coordinatorId: TaskId;
  cancelled: boolean;
  candidates: Member[];
  retryRequests: string[];
  synthesis?: { sourceGroupId: string };
};

export const GroupsDoc = defineDoc<{ groups: StoredGroup[] }>({
  kind: "still.groups",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ groups: [] }),
});

export const ChildDoc = defineDoc<{
  parent: number;
  group: string;
  slot: number;
}>({
  kind: "still.child",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ parent: 0, group: "", slot: 0 }),
});

export const GroupEntry = defineEntry<{ groupId: string }>("still.group");

// A conversation-owned background anchor keeps each child reusable after the coordinator settles.
const Anchor = defineTask<null, { phase: "done" }, null>({
  name: "still.child-anchor",
  version: 1,
  initial: () => ({ phase: "done" }),
  phases: {
    done: async (_task, runtime, context) => {
      await runtime.commit(
        () => ({
          status: "terminal",
          outcome: { status: "completed", result: null },
        }),
        context,
      );
    },
  },
  abort: async (_task, runtime, context) => {
    await runtime.commit(
      () => ({ status: "terminal", outcome: { status: "aborted" } }),
      context,
    );
  },
});

type RunInput = {
  parent: ConversationId;
  group: string;
  slot: number;
  attempt: number;
  child: ConversationId;
  prompt: string;
};

async function updateMember(
  tx: Tx,
  input: RunInput,
  status: Member["status"],
  answer = "",
  error = "",
) {
  const doc = await tx.doc(GroupsDoc, input.parent);
  const group = doc.groups.find((item) => item.id === input.group);
  const member = group?.candidates.find((item) => item.slot === input.slot);

  // Older attempts may still settle after an explicit replacement. They cannot overwrite the new attempt.
  if (
    member?.conversationId === input.child &&
    member.attempt === input.attempt &&
    ((member.status !== "cancelled" && member.status !== "cancelling") ||
      status === "cancelled")
  ) {
    member.status = status;
    member.answer = answer;
    member.error = error;
  }
}

export const CandidateRun = defineTask<RunInput, { phase: "run" }, null>({
  name: "still.candidate",
  version: 1,
  initial: () => ({ phase: "run" }),
  phases: {
    run: async (task, runtime, context) => {
      try {
        const child = await runtime.conversation(task.input.child, context);

        if (!child) throw new Error("Missing durable child conversation");

        await runtime.commit(async (tx) => {
          await updateMember(tx, task.input, "running");

          return undefined;
        }, context);

        const settled = await (
          await child.submit(
            {
              type: "input",
              content: task.input.prompt,
              requestId: `group:${task.input.group}:slot:${task.input.slot}:attempt:${task.input.attempt}`,
              whenBusy: "reject",
            },
            context,
          )
        ).wait(context);

        const view = await runtime.context(task.input.child, context);

        const answer =
          settled.status === "done" && settled.type === "input"
            ? view.entries
                .find((entry) => entry.id === settled.answer)
                ?.model?.find((item) => item.role === "assistant")
            : undefined;

        const completed =
          answer?.role === "assistant" &&
          answer.stopReason !== "error" &&
          answer.stopReason !== "aborted";

        const text =
          answer?.role === "assistant"
            ? answer.content
                .flatMap((part) => (part.type === "text" ? [part.text] : []))
                .join("")
            : "";

        await runtime.commit(async (tx) => {
          await updateMember(
            tx,
            task.input,
            completed
              ? "completed"
              : settled.status === "unanswered" && settled.reason === "aborted"
                ? "cancelled"
                : "failed",
            text,
            completed
              ? ""
              : "The child did not complete an answer. Retry starts a new isolated attempt.",
          );

          return {
            status: "terminal",
            outcome: { status: "completed", result: null },
          };
        }, context);
      } catch (error) {
        if (runtime.signal.aborted) throw error;

        await runtime.commit(async (tx) => {
          await updateMember(
            tx,
            task.input,
            "failed",
            "",
            "The durable child request failed. Retry starts an isolated attempt.",
          );

          return {
            status: "terminal",
            outcome: {
              status: "failed",
              error: { message: "Child request failed" },
            },
          };
        }, context);
      }
    },
  },
  abort: async (task, runtime, context) => {
    await runtime.commit(async (tx) => {
      await updateMember(tx, task.input, "cancelled");

      return { status: "terminal", outcome: { status: "aborted" } };
    }, context);
  },
});

type CoordinatorInput = { parent: ConversationId; group: string };

type CoordinatorState =
  { phase: "spawn" } | { phase: "settle"; children: TaskId[] };

export const Coordinator = defineTask<CoordinatorInput, CoordinatorState, null>(
  {
    name: "still.coordinator",
    version: 1,
    initial: () => ({ phase: "spawn" }),
    phases: {
      spawn: async (task, runtime, context) => {
        await runtime.commit(async (tx) => {
          const doc = await tx.doc(GroupsDoc, task.input.parent);
          const group = doc.groups.find((item) => item.id === task.input.group);

          if (!group || group.cancelled)
            return { status: "terminal", outcome: { status: "aborted" } };

          const children = group.candidates.map((member) => member.worker);

          return {
            status: "waiting",
            checkpoint: { phase: "settle", children },
            on: children,
            policy: "allSettled",
          };
        }, context);
      },
      settle: async (task, runtime, context) => {
        const outcomes = await runtime.outcomes(
          task.state.checkpoint.children,
          context,
        );

        await runtime.commit(async (tx) => {
          const doc = await tx.doc(GroupsDoc, task.input.parent);
          const group = doc.groups.find((item) => item.id === task.input.group);

          // Infrastructure task failures remain visible even when no normal response callback ran.
          outcomes.forEach((outcome, slot) => {
            const member = group?.candidates[slot];

            if (
              member &&
              member.worker === task.state.checkpoint.children[slot] &&
              outcome.status !== "completed" &&
              (member.status === "running" || member.status === "queued")
            ) {
              member.status =
                outcome.status === "aborted" ? "cancelled" : "failed";
              member.error =
                "Durable execution did not complete. Retry this child.";
            }
          });

          return {
            status: "terminal",
            outcome: { status: "completed", result: null },
          };
        }, context);
      },
    },
    abort: async (_task, runtime, context) => {
      await runtime.commit(
        () => ({ status: "terminal", outcome: { status: "aborted" } }),
        context,
      );
    },
  },
);

export const DelegationExtension = defineExtension({
  name: "still.delegation-tasks",
  tasks: [Anchor, CandidateRun, Coordinator],
});

export function cancellationTask(getHarness: () => Harness) {
  return defineTask<
    { targets: TaskId[]; conversations?: ConversationId[] },
    { phase: "cancel" },
    null
  >({
    name: "still.cancel-group",
    version: 1,
    initial: () => ({ phase: "cancel" }),
    phases: {
      cancel: async (task, runtime, context) => {
        for (const target of task.input.targets)
          await getHarness().abortTask(target, context);

        // Terminal anchors do not cascade to later child turns. Persist child IDs at admission.
        // Older v1 cancellation records can resolve their still-current members by anchor.
        const groups = task.input.conversations
          ? undefined
          : await getHarness().snapshot(
              GroupsDoc,
              runtime.conversationId,
              context,
            );

        const conversations =
          task.input.conversations ??
          groups?.groups.flatMap((group) =>
            group.candidates
              .filter((member) => task.input.targets.includes(member.anchor))
              .map((member) => member.conversationId),
          ) ??
          [];

        for (const id of conversations) {
          const child = await runtime.conversation(id, context);
          await child?.abort(context, { background: true });
        }

        for (const target of task.input.targets)
          await runtime.waitForTask(target, context);

        await runtime.commit(async (tx) => {
          const groups = await tx.doc(GroupsDoc, runtime.conversationId);

          for (const group of groups.groups) {
            for (const member of group.candidates) {
              if (
                task.input.targets.includes(member.anchor) &&
                member.status === "cancelling"
              )
                member.status = "cancelled";
            }
          }

          return {
            status: "terminal",
            outcome: { status: "completed", result: null },
          };
        }, context);
      },
    },
    abort: async (_task, runtime, context) => {
      await runtime.commit(
        () => ({ status: "terminal", outcome: { status: "aborted" } }),
        context,
      );
    },
  });
}

export async function createMember(
  tx: Tx,
  parent: ConversationId,
  group: StoredGroup,
  slot: number,
  model: string,
  attempt: number,
  audit: Extension,
) {
  const anchor = await tx.createTask(Anchor, null, {
    ownership: { kind: "conversation" },
    conversationId: parent,
    background: true,
  });

  const child =
    group.mode === "fork" && group.sourceEntry !== null
      ? await tx.forkConversation(parent, group.sourceEntry, {
          ownership: { kind: "task", taskId: anchor },
        })
      : await tx.createConversation({
          ownership: { kind: "task", taskId: anchor },
        });

  const split = model.indexOf("/");
  await configure(tx, child.id, {
    model: { provider: model.slice(0, split), modelId: model.slice(split + 1) },
    tools: [],
    extensions: [audit],
    thinkingLevel: "low",
    instructions: chatInstructions,
  });
  const link = await tx.doc(ChildDoc, child.id);
  link.parent = parent;
  link.group = group.id;
  link.slot = slot;

  const worker = await tx.createTask(
    CandidateRun,
    {
      parent,
      group: group.id,
      slot,
      attempt,
      child: child.id,
      prompt: group.task,
    },
    { conversationId: parent, ownership: { kind: "task", taskId: anchor } },
  );

  return {
    slot,
    conversationId: child.id,
    anchor,
    worker,
    model,
    attempt,
    status: "queued",
    answer: "",
    error: "",
  } satisfies Member;
}
