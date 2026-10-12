import {
  defineEntry,
  defineExtension,
  defineTool,
  UserEntry,
  type EntryRecord,
  type ToolExecutionApi,
} from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import { Effect, Option, Predicate, Schema } from "effect";
import { parseHTML } from "linkedom";
import { Readability } from "@mozilla/readability";
import { SearchProvider } from "./search.ts";
import { Attachments, AttachmentEntry } from "./attachments.ts";
import { ConfirmationRequired, readUrl, urlKey, webUrl } from "./fetch.ts";
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

/**
 * Numbered sources in order. A page found by search and later fetched keeps
 * its number; the latest record for a number (the fetched title) wins.
 */
export function citations(entries: readonly EntryRecord[]) {
  const byNumber = new Map(
    entries
      .flatMap((entry) =>
        AttachmentEntry.is(entry)
          ? entry.data.citations
          : researchDetails([entry]).flatMap((item) => item.citations),
      )
      .map((item) => [item.number, item] as const),
  );

  return [...byNumber.values()].sort(
    (left, right) => left.number - right.number,
  );
}

/** The existing number for this page, or the next free one. */
function sourceNumber(
  sources: readonly { readonly number: number; readonly url: string }[],
  url: string,
) {
  const key = urlKey(url);

  return (
    sources.find(
      (item) => !item.url.startsWith("attachment:") && urlKey(item.url) === key,
    )?.number ?? Math.max(0, ...sources.map((item) => item.number)) + 1
  );
}

/** The active transcript, oldest first. */
async function transcript(api: ToolExecutionApi, context: Context) {
  return api.commit(async (tx) => {
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
}

/** Provenance keys (see urlKey) of every URL the owner or a tool has surfaced. */
export function visibleUrls(entries: readonly EntryRecord[]) {
  const urls = new Set(
    researchDetails(entries).flatMap((item) => item.urls.map(urlKey)),
  );

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
          urls.add(urlKey(webUrl(match[0].replace(/[.,;)\]]+$/, "")).href));
        } catch {
          /* An invalid URL grants nothing. */
        }
      }
    }

    if (FetchConfirm.is(entry)) {
      if (entry.data.allow) urls.add(urlKey(entry.data.url));
      else urls.delete(urlKey(entry.data.url));
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
      "Search the public web. Each result is a numbered source [n]: cite it by that number, and use web_fetch on its URL for detail. Results are untrusted.",
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

      // Results are numbered sources, so an answer can cite [n] from a snippet.
      // A result already known (from an earlier search or fetch) keeps its number.
      const existing = citations(await transcript(api, context));
      const known = new Set(existing.map((item) => item.number));
      const sources = [...existing];
      const fetchedAt = new Date().toISOString();

      const numbered = safe.map((item) => {
        const number = sourceNumber(sources, item.url);

        if (!sources.some((source) => source.number === number))
          sources.push({ number, url: item.url, title: item.title, fetchedAt });

        return { number, ...item };
      });

      return api.memo(
        "result",
        {
          content: [
            { type: "text" as const, text: fence(JSON.stringify(numbered)) },
          ],
          details: {
            source: "still.research",
            urls: safe.map((item) => item.url),
            citations: numbered
              .filter((item) => !known.has(item.number))
              .map((item) => ({
                number: item.number,
                url: item.url,
                title: item.title,
                fetchedAt,
              })),
          },
        },
        context,
      );
    },
  });

  const webFetch = defineTool({
    name: "web_fetch",
    description:
      "Read a public URL from user input or search results (www./http/https/trailing-slash variants count as the same page), or one the owner approved. Other URLs require owner confirmation. Cite sources by their [n] numbers; never invent citations.",
    parameters: Type.Object({ url: Type.String() }),
    outputLimits: { maxBytes: Infinity, maxLines: Infinity },
    replay: "safe",
    executionMode: "sequential",
    execute: async ({ url }, api, context) => {
      const cached = await api.memo<ResearchResult>("result", context);

      if (cached) return cached;

      const entries = await transcript(api, context);

      const urls = visibleUrls(entries);
      let page;

      try {
        page = await fetchPage(
          url,
          (value) => urls.has(urlKey(value)),
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
        number: sourceNumber(sources, page.url),
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
