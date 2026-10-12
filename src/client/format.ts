export function shortModel(id: string) {
  return id.split("/").at(-1) ?? id;
}

export function formatCost(cost: number) {
  return cost === 0
    ? "$0"
    : cost < 0.01
      ? `$${cost.toFixed(4)}`
      : `$${cost.toFixed(2)}`;
}
