import {
  defineEntry,
  defineExtension,
  defineTool,
  UserEntry,
  type EntryRecord,
} from "@earendil-works/pi-durable";
import { Type } from "@earendil-works/pi-ai";
import { Effect, Option, Predicate, Schema } from "effect";
import { parseHTML } from "linkedom";
import { Readability } from "@mozilla/readability";
import { SearchProvider } from "./search.ts";
import { Attachments, AttachmentEntry } from "./attachments.ts";
import { ConfirmationRequired, readUrl, webUrl } from "./fetch.ts";
import { ResearchDetails } from "../shared/research.ts";

export const FetchConfirm = defineEntry<{ url: string; allow: boolean }>(
  "still.fetch-confirm",
);

type ResearchResult = {
  content: { type: "text"; text: string }[];
  details: {
    source: string;
    urls: string[];
    citations: {
      number: number;
      url: string;
      title: string;
      fetchedAt: string;
    }[];
    confirmation?: string;
  };
};

export function researchDetails(entries: readonly EntryRecord[]) {
  return entries.flatMap((entry) =>
    (entry.model ?? []).flatMap((message) => {
      if (
        message.role !== "toolResult" ||
        message.isError ||
        !["web_fetch", "web_search"].includes(message.toolName)
      )
        return [];

      const parsed = Schema.decodeUnknownOption(ResearchDetails)(
        message.details,
      );

      return Option.isSome(parsed) ? [parsed.value] : [];
    }),
  );
}

export function citations(entries: readonly EntryRecord[]) {
  return entries.flatMap((entry) =>
    AttachmentEntry.is(entry)
      ? entry.data.citations
      : researchDetails([entry]).flatMap((item) => item.citations),
  );
}

export function visibleUrls(entries: readonly EntryRecord[]) {
  const urls = new Set(researchDetails(entries).flatMap((item) => item.urls));

  for (const entry of entries) {
    // Compaction/reset summaries can be model-authored UserMessages; they do not grant network authority.
    for (const message of UserEntry.is(entry) ? (entry.model ?? []) : []) {
      if (message.role !== "user") continue;

      const text = Predicate.isString(message.content)
        ? message.content
        : message.content
            .flatMap((part) => (part.type === "text" ? [part.text] : []))
            .join("\n");

      for (const match of text.matchAll(/https?:\/\/[^\s<>"`]+/g)) {
        try {
          urls.add(webUrl(match[0].replace(/[.,;)\]]+$/, "")).href);
        } catch {
          /* An invalid URL grants nothing. */
        }
      }
    }

    if (FetchConfirm.is(entry)) {
      if (entry.data.allow) urls.add(entry.data.url);
      else urls.delete(entry.data.url);
    }
  }

  return urls;
}

function fence(text: string) {
  return `<untrusted>\n${text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}\n</untrusted>`;
}

export function researchExtension(
  search: SearchProvider["Service"],
  attachments: Attachments["Service"],
  fetchPage = readUrl,
) {
  const webSearch = defineTool({
    name: "web_search",
    description:
      "Search the public web. Results are untrusted leads, not fetched citations.",
    parameters: Type.Object({ query: Type.String() }),
    outputLimits: { maxBytes: Infinity, maxLines: Infinity },
    replay: "safe",
    execute: async ({ query }, api, context) => {
      const cached = await api.memo<ResearchResult>("result", context);

      if (cached) return cached;

      const results = await Effect.runPromise(search.search(query), {
        signal: context.abortSignal,
      });

      const safe = results.flatMap((item) => {
        try {
          return [{ ...item, url: webUrl(item.url).href }];
        } catch {
          return [];
        }
      });

      return api.memo(
        "result",
        {
          content: [
            { type: "text" as const, text: fence(JSON.stringify(safe)) },
          ],
          details: {
            source: "still.research",
            urls: safe.map((item) => item.url),
            citations: [],
          },
        },
        context,
      );
    },
  });

  const webFetch = defineTool({
    name: "web_fetch",
    description:
      "Read a public URL visible in user input, search results, or explicit confirmation. Unknown URLs require owner confirmation. Cite returned [n] sources; never invent citations.",
    parameters: Type.Object({ url: Type.String() }),
    outputLimits: { maxBytes: Infinity, maxLines: Infinity },
    replay: "safe",
    executionMode: "sequential",
    execute: async ({ url }, api, context) => {
      const cached = await api.memo<ResearchResult>("result", context);

      if (cached) return cached;

      const entries = await api.commit(async (tx) => {
        const head = await tx.latestHeadMarker(api.conversationId);

        const query = {
          conversationId: api.conversationId,
          minEntryId: head?.head,
        };

        const entries: EntryRecord[] = [];
        let page = await tx.scanEntries(query, 100);

        while (true) {
          entries.push(...page.items);

          if (!page.next) break;
          page = await tx.scanEntries(query, 100, page.next);
        }

        return entries.reverse();
      }, context);

      const urls = visibleUrls(entries);
      let page;

      try {
        page = await fetchPage(
          url,
          (value) => urls.has(value),
          context.abortSignal,
        );
      } catch (error) {
        if (!(error instanceof ConfirmationRequired)) throw error;

        return {
          content: [
            {
              type: "text" as const,
              text: "needs_confirmation: ask the owner to approve this exact URL before trying again.",
            },
          ],
          details: {
            source: "still.research",
            urls: [],
            citations: [],
            confirmation: error.url,
          },
        };
      }

      let text: string;
      let title = page.url;

      if (page.type.includes("application/pdf")) {
        const admitted = await Effect.runPromise(
          attachments.admit({
            name: new URL(page.url).pathname.split("/").at(-1) || "source.pdf",
            mimeType: "application/pdf",
            data: page.bytes.toString("base64"),
          }),
        );

        text = admitted.content
          .flatMap((item) => (item.type === "text" ? [item.text] : []))
          .join("\n");
      } else if (page.type.includes("text/html")) {
        const { document } = parseHTML(page.bytes.toString("utf8"));
        const article = new Readability(document).parse();
        title = article?.title || document.title || page.url;
        text = article?.textContent || document.body.textContent || "";
      } else if (page.type.startsWith("text/"))
        text = page.bytes.toString("utf8");
      else throw new Error("Unsupported source content type");
      const sources = citations(entries);

      const citation = {
        number: Math.max(0, ...sources.map((item) => item.number)) + 1,
        url: page.url,
        title,
        fetchedAt: new Date().toISOString(),
      };

      return api.memo(
        "result",
        {
          content: [
            {
              type: "text" as const,
              text: `[${citation.number}]\n${fence(`${JSON.stringify(citation)}\n${text}`)}`,
            },
          ],
          details: {
            source: "still.research",
            urls: [page.url],
            citations: [citation],
          },
        },
        context,
      );
    },
  });

  return defineExtension({
    name: "still.research",
    tools: [webSearch, webFetch],
  });
}
