/**
 * Widget registry. `widgets/index.ts` fills it at module load; the host reads
 * it. Kept separate from the host so a widget's own test can register into a
 * throwaway registry without dragging the DOM host in.
 */

import type { WidgetDefinition } from "./widget-api.js";

export class WidgetRegistry {
  private defs = new Map<string, WidgetDefinition>();

  /**
   * Two widgets claiming one type is a build-time mistake and should be loud,
   * but not fatal: registration runs at module load, on the import chain the
   * whole renderer boots through, so throwing here would replace Orbit with a
   * blank window over a widget-name typo. First one wins, second is reported.
   */
  register(def: WidgetDefinition): boolean {
    if (this.defs.has(def.type)) {
      console.error(`[dashboard] widget type "${def.type}" is registered twice; keeping the first`);
      return false;
    }
    this.defs.set(def.type, def);
    return true;
  }

  get(type: string): WidgetDefinition | undefined {
    return this.defs.get(type);
  }

  list(): WidgetDefinition[] {
    return [...this.defs.values()];
  }
}

/** The registry the shipped dashboard uses. */
export const widgetRegistry = new WidgetRegistry();

export function registerWidget(def: WidgetDefinition): boolean {
  return widgetRegistry.register(def);
}
