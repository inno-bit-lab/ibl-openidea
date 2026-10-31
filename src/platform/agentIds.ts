/** Saved fork ids use the ids published by the ACP Registry. */
export function legacyAgentId(id: string): string {
  if (id === "agy") return "antigravity-acp";
  if (id === "pi") return "pi-acp";
  return id;
}
