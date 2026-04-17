import type { RoleSpec } from "./types";

export class FilterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FilterError";
  }
}

export function filterToolsForRole<T>(
  role: RoleSpec,
  registry: Map<string, T>,
  isReadOnly: (name: string) => boolean,
): T[] {
  const out = new Map<string, T>();

  for (const name of role.tools_read) {
    const tool = registry.get(name);
    if (!tool) {
      throw new FilterError(
        `Role "${role.name}": tools_read references unknown tool "${name}"`,
      );
    }
    if (!isReadOnly(name)) {
      throw new FilterError(
        `Role "${role.name}": tools_read includes "${name}" which is not read-only. ` +
        `Move it to tools_write if an explicit mutation grant is intended.`,
      );
    }
    out.set(name, tool);
  }

  for (const name of role.tools_write ?? []) {
    const tool = registry.get(name);
    if (!tool) {
      throw new FilterError(
        `Role "${role.name}": tools_write references unknown tool "${name}"`,
      );
    }
    out.set(name, tool);
  }

  return Array.from(out.values());
}
