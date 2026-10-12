import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ChatSnapshot, Message } from "../src/shared/contracts.ts";
import {
  describeChange,
  sameMessage,
  summarizeWork,
  thinkingPreview,
  Timeline,
  timeline,
} from "../src/client/timeline.tsx";
import {
  Composer,
  sendsOnEnter,
  type ComposerProps,
} from "../src/client/composer.tsx";
import { DecisionCard } from "../src/client/views.tsx";
import { parseFeedback } from "../src/shared/feedback.ts";

function message(
  id: string,
  role: Message["role"],
  entry: number | null,
  text: string,
  extra: Partial<Message> = {},
): Message {
  return {
    id,
    entry,
    before: entry === null ? null : entry - 1,
    role,
    text,
    thinking: "",
    interrupted: false,
    failed: false,
    ...extra,
  };
}

function snapshot(extra: Partial<ChatSnapshot> = {}): ChatSnapshot {
  return {
    id: 7,
    title: "Durable writes",
    model: "faux/faux-1",
    grant: { kit: "research", target: null },
    messages: [],
    busy: false,
    queued: 0,
    attachments: [],
    citations: [],
    confirmations: [],
    cost: 0,
    changes: [],
    tools: [],
    ...extra,
  };
}

const ask = message("3-0", "user", 3, "Is example.com safe to cite?");

const toolCall = message("4-0", "assistant", 4, "");

const answer = message("7-0", "assistant", 7, "Yes [1].", {
  model: "faux/faux-1",
});

const research = snapshot({
  messages: [ask, toolCall, answer],
  changes: [{ id: 1, text: "Kit: research" }],
  tools: [
    { id: "5", name: "web_search", text: "3 results", failed: false },
    { id: "5", name: "web_fetch", text: "Fetched", failed: false },
    { id: "6", name: "web_fetch", text: "Blocked", failed: true },
  ],
  citations: [
    {
      number: 1,
      url: "https://example.com/",
      title: "Example Domain",
      fetchedAt: "2026-10-11T18:02:11Z",
    },
  ],
});

const noop = () => {};

describe("timeline", () => {
  it("places changes and grouped tool work between the turns that produced them", () => {
    const items = timeline(research);

    expect(items.map((item) => item.kind)).toEqual([
      "change",
      "message",
      "work",
      "message",
    ]);
    expect(items[2]?.kind === "work" && items[2].tools.length).toBe(3);
  });

  it("drops kit resets that change nothing, as forks record", () => {
    const items = timeline(
      snapshot({
        changes: [
          { id: 1, text: "Kit: chat" },
          { id: 2, text: "Kit: research" },
          { id: 3, text: "Kit: research" },
          { id: 4, text: "Kit: chat" },
        ],
      }),
    );

    expect(items.map((item) => item.kind === "change" && item.text)).toEqual([
      "Switched to Research kit",
      "Switched to Chat kit",
    ]);
  });

  it("keeps the live message last and hides tool-call-only assistant entries", () => {
    const live = message("live", "assistant", null, "Streaming");
    const items = timeline(snapshot({ messages: [live, ask, toolCall] }));

    expect(
      items.map((item) =>
        item.kind === "message" ? item.message.id : item.kind,
      ),
    ).toEqual(["3-0", "live"]);
  });

  it("summarizes work in one line and keeps failures countable", () => {
    expect(summarizeWork(research.tools)).toEqual({
      summary: "Searched 1 time · read 2 pages",
      failed: 1,
    });
    expect(describeChange("Kit: research")).toBe("Switched to Research kit");
    expect(describeChange("Model: opencode-go/space-bunny-free")).toBe(
      "Model set to space-bunny-free",
    );
  });
});

describe("Timeline rendering", () => {
  it("shows the answer, a collapsed work line and numbered sources", () => {
    const html = renderToStaticMarkup(
      <Timeline
        snapshot={research}
        parentTitle={null}
        locked={false}
        onFork={noop}
        onOpenParent={noop}
      />,
    );

    expect(html).toContain('<details class="work-summary">');
    expect(html).toContain("1 blocked or failed");
    expect(html).toContain('aria-label="Sources and files"');
    expect(html).toContain('href="https://example.com/"');
    expect(html.indexOf("Yes [1].")).toBeLessThan(html.indexOf("Sources"));
  });

  it("lists cited sources and folds uncited search results", () => {
    const source = (number: number) => ({
      number,
      url: `https://example.com/${number}`,
      title: `Result ${number}`,
      fetchedAt: "2026-10-11T18:02:11Z",
    });

    const html = renderToStaticMarkup(
      <Timeline
        snapshot={snapshot({
          messages: [
            ask,
            message("7-0", "assistant", 7, "Yes [1], see also [3, 4]."),
          ],
          citations: [1, 2, 3, 4, 5].map(source),
        })}
        parentTitle={null}
        locked={false}
        onFork={noop}
        onOpenParent={noop}
      />,
    );

    const [shown = "", folded = ""] = html.split('class="more-sources"');

    for (const number of [1, 3, 4]) expect(shown).toContain(`Result ${number}`);
    expect(shown).not.toContain("Result 2");
    expect(folded).toContain("2 more results");
    expect(folded).toContain("Result 2");
    expect(folded).toContain("Result 5");
  });

  it("offers retry in a branch for a failed answer and marks branches", () => {
    const html = renderToStaticMarkup(
      <Timeline
        snapshot={snapshot({
          parent: 3,
          messages: [ask, message("4-0", "assistant", 4, "", { failed: true })],
        })}
        parentTitle="Original chat"
        locked={false}
        onFork={noop}
        onOpenParent={noop}
      />,
    );

    expect(html).toContain("Retry in a new branch");
    expect(html).toContain("Branch of");
    expect(html).toContain("Original chat");
  });

  it("renders GitHub-flavored Markdown tables in answers", () => {
    const html = renderToStaticMarkup(
      <Timeline
        snapshot={snapshot({
          messages: [
            ask,
            message(
              "4-0",
              "assistant",
              4,
              "| Mode | Durable |\n|---|---|\n| WAL | yes |",
            ),
          ],
        })}
        parentTitle={null}
        locked={false}
        onFork={noop}
        onOpenParent={noop}
      />,
    );

    expect(html).toContain("<table>");
    expect(html).toContain("<td>WAL</td>");
  });

  it("shows thinking while busy with no answer text yet", () => {
    const html = renderToStaticMarkup(
      <Timeline
        snapshot={snapshot({ busy: true, messages: [ask] })}
        parentTitle={null}
        locked
        onFork={noop}
        onOpenParent={noop}
      />,
    );

    expect(html).toContain('role="status"');
    expect(html).toContain("Thinking…");
  });

  it("previews the latest line of live reasoning while thinking", () => {
    const live = message("live", "assistant", null, "", {
      thinking:
        "First consider WAL.\n\nThen check fsync on network file systems.",
    });

    const html = renderToStaticMarkup(
      <Timeline
        snapshot={snapshot({ busy: true, messages: [ask, live] })}
        parentTitle={null}
        locked
        onFork={noop}
        onOpenParent={noop}
      />,
    );

    expect(html).toContain("Then check fsync on network file systems.");
    expect(html).not.toContain("Thought process");
    expect(thinkingPreview("x".repeat(200))).toBe(`…${"x".repeat(140)}`);
  });

  it("keeps the latest exchange in one viewport-tall group", () => {
    const html = renderToStaticMarkup(
      <Timeline
        snapshot={research}
        parentTitle={null}
        locked={false}
        onFork={noop}
        onOpenParent={noop}
      />,
    );

    const group = html.slice(html.indexOf('class="current-turn"'));

    expect(group).toContain("Is example.com safe to cite?");
    expect(group).toContain("Yes [1].");
    expect(html.indexOf("Switched to Research kit")).toBeLessThan(
      html.indexOf('class="current-turn"'),
    );
  });

  it("treats freshly decoded but identical messages as unchanged", () => {
    expect(sameMessage(answer, { ...answer })).toBe(true);
    expect(sameMessage(answer, { ...answer, text: "Yes [1]. More" })).toBe(
      false,
    );
  });
});

const composer: ComposerProps = {
  draft: "Also cover NORMAL",
  onDraft: noop,
  models: [{ id: "faux/faux-1", name: "Scripted faux", provider: "faux" }],
  model: "faux/faux-1",
  onModel: noop,
  kit: "chat",
  onKit: noop,
  canChooseStill: false,
  cost: 0.00042,
  busy: false,
  queued: 0,
  whenBusy: "followUp",
  onWhenBusy: noop,
  uploads: [],
  onUploads: noop,
  onPreparing: noop,
  preparing: false,
  locked: false,
  pending: false,
  sending: false,
  reusing: false,
  onSend: noop,
  onStop: noop,
  onError: noop,
};

describe("Composer", () => {
  it("is a plain send with model, kit and cost chips when idle", () => {
    const html = renderToStaticMarkup(<Composer {...composer} />);

    expect(html).toContain('aria-label="Send"');
    expect(html).not.toContain("Stop answer");
    expect(html).toContain('aria-label="Model"');
    expect(html).toContain('aria-label="Kit"');
    expect(html).toContain("$0.0004");
    expect(html).toMatch(/<option value="still" disabled="">/);
  });

  it("turns Send into Queue or Steer with Stop while busy", () => {
    const queue = renderToStaticMarkup(
      <Composer {...composer} busy queued={1} locked />,
    );

    const steer = renderToStaticMarkup(
      <Composer {...composer} busy locked whenBusy="steer" />,
    );

    expect(queue).toContain('aria-label="Stop answer"');
    expect(queue).toContain('aria-label="Queue"');
    expect(queue).toContain("1 queued");
    expect(steer).toContain('aria-label="Steer"');
    expect(steer).toMatch(/aria-checked="true"[^>]*>Steer/);
    // Locked model and kit give way to Queue/Steer so the composer keeps its height.
    expect(queue).not.toContain('aria-label="Model"');
    expect(queue).not.toContain('aria-label="Kit"');
  });

  it("labels a saved unsent input as a retry", () => {
    const html = renderToStaticMarkup(<Composer {...composer} pending />);

    expect(html).toContain('aria-label="Retry send"');
  });

  it("sends on Enter only with a fine pointer; modifier Enter always sends", () => {
    const key = {
      key: "Enter",
      shiftKey: false,
      metaKey: false,
      ctrlKey: false,
    };

    expect(sendsOnEnter(key, true)).toBe(true);
    expect(sendsOnEnter(key, false)).toBe(false);
    expect(sendsOnEnter({ ...key, shiftKey: true }, true)).toBe(false);
    expect(sendsOnEnter({ ...key, metaKey: true }, false)).toBe(true);
    expect(sendsOnEnter({ ...key, key: "a" }, true)).toBe(false);
  });
});

describe("/feedback", () => {
  it("parses the command and leaves ordinary prompts alone", () => {
    expect(parseFeedback("/feedback streaming felt janky")).toBe(
      "streaming felt janky",
    );
    expect(parseFeedback("  /Feedback\nline one\nline two ")).toBe(
      "line one\nline two",
    );
    expect(parseFeedback("/feedback")).toBe("");
    expect(parseFeedback("/feedbacks")).toBeNull();
    expect(parseFeedback("Give me /feedback on this")).toBeNull();
  });

  it("saves without a model and suggests the command while typing", () => {
    const save = renderToStaticMarkup(
      <Composer {...composer} model="" draft="/feedback chips are small" />,
    );

    const typing = renderToStaticMarkup(<Composer {...composer} draft="/fe" />);

    expect(save).toMatch(/aria-label="Save feedback"(?![^>]*disabled)/);
    expect(typing).toContain("Save a note about Still for dogfooding");
    expect(save).not.toContain("Save a note about Still for dogfooding");
  });
});

describe("DecisionCard", () => {
  it("names the exact URL and offers allow or deny", () => {
    const html = renderToStaticMarkup(
      <DecisionCard
        url="https://www.rfc-editor.org/rfc/rfc2606"
        onDecide={noop}
      />,
    );

    expect(html).toContain(
      "<code>https://www.rfc-editor.org/rfc/rfc2606</code>",
    );
    expect(html).toContain("Allow this URL");
    expect(html).toContain("Deny");
  });
});
