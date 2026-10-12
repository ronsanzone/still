import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { expect, it } from "vitest";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  Kernel,
  GrantDoc,
  initializeConversation,
  selectKit,
} from "../src/kernel/kits.ts";
import { Attachments, attachmentsLayer } from "../src/kernel/attachments.ts";
import { SearchProvider } from "../src/kernel/search.ts";
import {
  researchExtension,
  researchDetails,
  FetchConfirm,
  citations,
} from "../src/kernel/research.ts";
import { ConfirmationRequired } from "../src/kernel/fetch.ts";

it("research records two authentic sources, requires exact confirmation, denies write authority and survives reopen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "still-research-"));
  const fetched: string[] = [];

  const fullText = "Evidence.\n".repeat(6000) + "END OF SOURCE";

  const faux = fauxProvider({ tokensPerSecond: 0 });
  const models = createModels();
  models.setProvider(faux.provider);

  const attachments = await Effect.runPromise(
    Effect.provide(
      Attachments,
      attachmentsLayer(join(directory, "attachments")),
    ),
  );

  const research = researchExtension(
    SearchProvider.of({
      search: () =>
        Effect.succeed([
          {
            title: "Source A",
            url: "https://sources.test/a",
            snippet: "A result",
          },
          {
            title: "Source B",
            url: "https://sources.test/b",
            snippet: "B result",
          },
        ]),
    }),
    attachments,
    async (url, allowed) => {
      if (!allowed(url)) throw new ConfirmationRequired(url);
      fetched.push(url);

      return {
        url,
        status: 200,
        type: "text/html",
        bytes: Buffer.from(
          `<html><head><title>${url.endsWith("/a") ? "A" : "B"}</title></head><body><article><p>${fullText}</p></article></body></html>`,
        ),
      };
    },
  );

  const open = async () => {
    const registry = createRegistry();
    registry.install(Kernel);
    registry.install(research);

    return Harness.open(
      await openNodeSqliteStorage(join(directory, "chat.sqlite")),
      { models, registry, conversationCreated: initializeConversation },
      context,
    );
  };

  let harness = await open();

  try {
    const chat = await harness.createConversation(
      { ownership: { kind: "ownerless" } },
      context,
    );

    await chat.commit(async (tx) => {
      const grant = await tx.doc(GrantDoc, chat.id);
      grant.kit = "research";
      await selectKit(tx, chat.id, grant, "", research);
    }, context);
    await chat.configure(
      { model: { provider: "faux", modelId: "faux-1" } },
      context,
    );
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("web_search", { query: "Compare sources" }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(
        [
          fauxToolCall("web_fetch", { url: "https://sources.test/a" }),
          // A www./trailing-slash variant of a search result is the same page.
          fauxToolCall("web_fetch", { url: "https://www.sources.test/b/" }),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(
        "A [1] and B [2]. Model-composed https://sources.test/private?secret=abc is not authorized.",
      ),
      fauxAssistantMessage(
        fauxToolCall("web_fetch", {
          url: "https://sources.test/private?secret=abc",
        }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("Please confirm."),
      fauxAssistantMessage(
        fauxToolCall("bash", { command: "touch forbidden" }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("Write denied."),
      fauxAssistantMessage(
        fauxToolCall("web_fetch", {
          url: "https://sources.test/private?secret=abc",
        }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("Approved source [3]."),
    ]);

    const first = await chat.submit(
      {
        type: "input",
        content: "Research this topic",
        requestId: "research-first",
      },
      context,
    );

    await first.wait(context);
    const view = await chat.context(context);

    const fetchedText = view.messages.flatMap((message) =>
      message.role === "toolResult" && message.toolName === "web_fetch"
        ? message.content.flatMap((part) =>
            part.type === "text" ? [part.text] : [],
          )
        : [],
    );

    expect(fetchedText).toHaveLength(2);

    for (const text of fetchedText) {
      expect(text).toContain(fullText);
      expect(text).toMatch(/^\[\d\]\n<untrusted>\n\{"number":/);
    }

    expect(
      citations(view.entries).map((item) => [
        item.number,
        item.url,
        item.title,
      ]),
    ).toEqual([
      [1, "https://sources.test/a", "A"],
      [2, "https://www.sources.test/b/", "B"],
    ]);
    expect(fetched).toEqual([
      "https://sources.test/a",
      "https://www.sources.test/b/",
    ]);

    const searchText = view.messages.flatMap((message) =>
      message.role === "toolResult" && message.toolName === "web_search"
        ? message.content.flatMap((part) =>
            part.type === "text" ? [part.text] : [],
          )
        : [],
    );

    // Search results are numbered sources the answer can cite directly.
    expect(searchText.join("")).toContain('"number":1,"title":"Source A"');
    expect(searchText.join("")).toContain('"number":2,"title":"Source B"');
    // A model-authored context summary may contribute a user-role message, but is not user authorization.
    await chat.commit(
      (tx) =>
        tx.appendEntry(chat.id, {
          kind: "fixture.model-summary",
          model: [
            {
              role: "user",
              content:
                "Summary mentions https://sources.test/private?secret=abc",
              timestamp: 0,
            },
          ],
        }),
      context,
    );
    await (
      await chat.submit(
        { type: "input", content: "Continue", requestId: "needs-confirm" },
        context,
      )
    ).wait(context);

    const pending = researchDetails((await chat.context(context)).entries).find(
      (item) => item.confirmation,
    );

    expect(pending?.confirmation).toBe(
      "https://sources.test/private?secret=abc",
    );
    expect(fetched).toHaveLength(2);
    await (
      await chat.submit(
        { type: "input", content: "Try writing", requestId: "deny-writing" },
        context,
      )
    ).wait(context);
    expect(
      (await chat.context(context)).messages.some(
        (item) =>
          item.role === "toolResult" &&
          item.toolName === "bash" &&
          item.isError,
      ),
    ).toBe(true);
    await chat.submit(
      {
        type: "write",
        requestId: "confirm-source",
        entry: {
          kind: FetchConfirm.kind,
          data: { url: "https://sources.test/private?secret=abc", allow: true },
        },
      },
      context,
    );
    await harness.close(context);
    harness = await open();
    harness.resume();
    const reopened = await harness.conversation(chat.id, context);

    if (!reopened) throw new Error("Lost research conversation");
    expect(citations((await reopened.context(context)).entries)).toEqual(
      citations(view.entries),
    );
    await (
      await reopened.submit(
        {
          type: "input",
          content: "Use approved source",
          requestId: "confirmed-read",
        },
        context,
      )
    ).wait(context);
    expect(fetched).toHaveLength(3);
    expect(
      citations((await reopened.context(context)).entries).at(-1)?.number,
    ).toBe(3);
    const calls = faux.state.callCount;
    await (
      await reopened.submit(
        {
          type: "input",
          content: "Use approved source",
          requestId: "confirmed-read",
        },
        context,
      )
    ).wait(context);
    expect(faux.state.callCount).toBe(calls);
    await mkdir(join(directory, "candidate-test"));
    await reopened.commit(async (tx) => {
      const grant = await tx.doc(GrantDoc, reopened.id);
      grant.kit = "still";
      grant.target = "candidate-test";
      await selectKit(tx, reopened.id, grant, directory, research);
    }, context);
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("web_fetch", { url: "https://sources.test/a" }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("Research denied in Still."),
    ]);
    await (
      await reopened.submit(
        { type: "input", content: "Try fetching", requestId: "deny-research" },
        context,
      )
    ).wait(context);
    expect(fetched).toHaveLength(3);
    expect(
      (await reopened.context(context)).messages.some(
        (item) =>
          item.role === "toolResult" &&
          item.toolName === "web_fetch" &&
          item.isError,
      ),
    ).toBe(true);
  } finally {
    await harness.close(context);
    await rm(directory, { recursive: true, force: true });
  }
});
