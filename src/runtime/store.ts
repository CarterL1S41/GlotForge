import type { Catalog } from "../shared/types";

/**
 * Module-level snapshot of the active locale/catalog, maintained by the
 * provider ON THE CLIENT ONLY. It exists so the global `t` works outside
 * React (toasts, event handlers). On the server this stays empty — module
 * state would leak across concurrent requests — so server code uses
 * createT(locale, catalog) from "glotforge/server" instead.
 */
export interface RuntimeSnapshot {
  locale: string;
  sourceLocale: string;
  catalog: Catalog | null;
  pseudo: boolean;
}

let snapshot: RuntimeSnapshot = {
  locale: "en-US",
  sourceLocale: "en-US",
  catalog: null,
  pseudo: false,
};

export function setRuntimeSnapshot(next: RuntimeSnapshot): void {
  snapshot = next;
}

export function getRuntimeSnapshot(): RuntimeSnapshot {
  return snapshot;
}
