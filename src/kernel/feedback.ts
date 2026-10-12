import { defineDoc, type Tx } from "@earendil-works/pi-durable";
import type { FeedbackItem } from "../shared/feedback.ts";

type FeedbackState = { items: FeedbackItem[] };

/** Owner dogfooding notes. One session doc in Pi's store; no second database. */
export const FeedbackDoc = defineDoc({
  kind: "still.feedback",
  version: 1,
  scope: "session",
  initial: (): FeedbackState => ({ items: [] }),
});

export async function recordFeedback(tx: Tx, item: FeedbackItem) {
  const doc = await tx.doc(FeedbackDoc);

  if (!doc.items.some((existing) => existing.id === item.id))
    doc.items.push(item);
}
