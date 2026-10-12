import { mkdtemp, rm } from "node:fs/promises";
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
import { Attachments, attachmentsLayer } from "../src/kernel/attachments.ts";
import { SearchProvider } from "../src/kernel/search.ts";
import { researchExtension, citations } from "../src/kernel/research.ts";

it("numbers search results as sources, keeps them when pages are read, and survives reopen", async () => {
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
    async (url) => {
      fetched.push(url);

      return {
        url,
        status: 200,
        type: "text/html",
        bytes: Buffer.from(
          `<html><head><title>${url.includes("/a") ? "A" : url.includes("/b") ? "B" : "C"}</title></head><body><article><p>${fullText}</p></article></body></html>`,
        ),
      };
    },
  );

  const open = async () => {
    const registry = createRegistry();
    registry.install(research);

    return Harness.open(
      await openNodeSqliteStorage(join(directory, "chat.sqlite")),
      { models, registry },
      context,
    );
  };

  let harness = await open();

  try {
    const chat = await harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: { model: { provider: "faux", modelId: "faux-1" } },
      },
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
          // A www./trailing-slash variant of a search result is the same source.
          fauxToolCall("web_fetch", { url: "https://www.sources.test/b/" }),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("A [1] and B [2]."),
      // Any public URL can be read; it becomes the next numbered source.
      fauxAssistantMessage(
        fauxToolCall("web_fetch", { url: "https://other.test/c" }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("C [3]."),
    ]);

    await (
      await chat.submit(
        {
          type: "input",
          content: "Research this topic",
          requestId: "research-first",
        },
        context,
      )
    ).wait(context);
    const view = await chat.context(context);

    const toolText = (name: string) =>
      view.messages.flatMap((message) =>
        message.role === "toolResult" && message.toolName === name
          ? message.content.flatMap((part) =>
              part.type === "text" ? [part.text] : [],
            )
          : [],
      );

    // Search results are numbered sources the answer can cite directly.
    expect(toolText("web_search").join("")).toContain(
      '"number":1,"title":"Source A"',
    );
    expect(toolText("web_search").join("")).toContain(
      '"number":2,"title":"Source B"',
    );

    // Fetched pages arrive complete and keep their search numbers.
    expect(toolText("web_fetch")).toHaveLength(2);

    for (const text of toolText("web_fetch")) {
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

    await (
      await chat.submit(
        { type: "input", content: "One more", requestId: "research-more" },
        context,
      )
    ).wait(context);
    expect(fetched).toEqual([
      "https://sources.test/a",
      "https://www.sources.test/b/",
      "https://other.test/c",
    ]);

    const before = citations((await chat.context(context)).entries);
    expect(before.at(-1)).toMatchObject({ number: 3, title: "C" });

    await harness.close(context);
    harness = await open();
    harness.resume();
    const reopened = await harness.conversation(chat.id, context);

    if (!reopened) throw new Error("Lost research conversation");
    expect(citations((await reopened.context(context)).entries)).toEqual(
      before,
    );

    // Replaying an admitted request does not call the model again.
    const calls = faux.state.callCount;
    await (
      await reopened.submit(
        { type: "input", content: "One more", requestId: "research-more" },
        context,
      )
    ).wait(context);
    expect(faux.state.callCount).toBe(calls);
  } finally {
    await harness.close(context);
    await rm(directory, { recursive: true, force: true });
  }
});
