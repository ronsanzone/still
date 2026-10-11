import type { Grant } from "../shared/contracts.ts";

export function shortModel(id: string) {
  return id.split("/").at(-1) ?? id;
}

/** What each kit may do, shown wherever the kit is visible. */
export const kits: Readonly<
  Record<Grant["kit"], { readonly label: string; readonly authority: string }>
> = {
  chat: { label: "Chat", authority: "No tools" },
  research: { label: "Research", authority: "Read-only web" },
  still: { label: "Still", authority: "Edits candidate · not sandboxed" },
};

export function formatCost(cost: number) {
  return cost === 0
    ? "$0"
    : cost < 0.01
      ? `$${cost.toFixed(4)}`
      : `$${cost.toFixed(2)}`;
}
