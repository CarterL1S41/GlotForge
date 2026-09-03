/**
 * The string-translation function for everything JSX can't wrap:
 * placeholders, aria-labels, toasts, document titles.
 *
 *   t`Failed to save transaction`
 *   t`Welcome back, ${user.firstName}`          // build-time loader names the placeholder
 *   t("Wire", { context: "wire as in wire request" })
 *   t({ message: "{count, plural, one {# item} other {# items}}", values: { count } })
 *
 * Template and plain-string forms are LITERAL text (braces/angles escaped
 * for you); the descriptor form's message is raw grammar for plurals/selects.
 *
 * The global `t` is bound to the provider's state on the CLIENT. On the
 * server it has no provider and falls back to source English — use
 * createT(locale, catalog) from "glotforge/server" there.
 */

import type { Catalog } from "../shared/types";
import { hashMessage, } from "../shared/hash";
import { escapeText, parseMessage, type MessageNode } from "../shared/message";
import { renderToString } from "./render";
import { getRuntimeSnapshot, type RuntimeSnapshot } from "./store";
import { PSEUDO_LOCALE } from "./pseudo";

export interface MessageDescriptor {
  id?: string;
  message: string;
  context?: string;
  values?: Record<string, unknown>;
}

export interface TOptions {
  id?: string;
  context?: string;
  values?: Record<string, unknown>;
}

export type TFunction = {
  (strings: TemplateStringsArray, ...expressions: unknown[]): string;
  /**
   * Accepts plain literal text OR a msg() descriptor — including the union
   * of the two, so config fields typed `string | MessageDescriptor` (the
   * piece-by-piece migration shape) translate with a bare t(value).
   */
  (message: string | MessageDescriptor, options?: TOptions): string;
};

const parseCache = new Map<string, MessageNode[] | null>();

function parseCached(message: string): MessageNode[] | null {
  let nodes = parseCache.get(message);
  if (nodes === undefined) {
    try {
      nodes = parseMessage(message);
    } catch (err) {
      if (process.env.NODE_ENV !== "production") {
        console.warn(`[glotforge] unparseable message: ${message}`, err);
      }
      nodes = null;
    }
    // Unbounded growth guard: UI string sets are finite, but don't let a
    // pathological caller leak forever.
    if (parseCache.size > 5000) parseCache.clear();
    parseCache.set(message, nodes);
  }
  return nodes;
}

export function translateDescriptor(
  snapshot: RuntimeSnapshot,
  descriptor: MessageDescriptor,
): string {
  const { message, context, values } = descriptor;
  const pseudo = snapshot.pseudo || snapshot.locale === PSEUDO_LOCALE;
  let translated = message;
  if (!pseudo && snapshot.locale !== snapshot.sourceLocale) {
    const id = descriptor.id ?? hashMessage(message, context);
    translated = snapshot.catalog?.[id] ?? message;
  }
  const nodes = parseCached(translated);
  if (!nodes) {
    // Fall back to the source message; if even that fails, hand back raw text.
    const fallback = translated === message ? null : parseCached(message);
    if (!fallback) return translated;
    return renderToString(fallback, {
      locale: snapshot.locale,
      values,
      pseudo,
    });
  }
  return renderToString(nodes, {
    locale: pseudo ? snapshot.sourceLocale : snapshot.locale,
    values,
    pseudo,
  });
}

let warnedTemplateWithoutLoader = false;

export function makeT(getSnapshot: () => RuntimeSnapshot): TFunction {
  const t = (
    first: TemplateStringsArray | MessageDescriptor | string,
    ...rest: unknown[]
  ): string => {
    const snapshot = getSnapshot();

    // Tagged template: t`...`
    if (Array.isArray(first) && "raw" in (first as TemplateStringsArray)) {
      const strings = first as TemplateStringsArray;
      if (strings.length === 1) {
        return translateDescriptor(snapshot, {
          message: escapeText(strings[0]),
        });
      }
      // Interpolated templates need the build-time loader to name their
      // placeholders (it rewrites the call to the descriptor form). Without
      // it we can't produce a stable hash — degrade to English gracefully.
      if (
        process.env.NODE_ENV !== "production" &&
        !warnedTemplateWithoutLoader
      ) {
        warnedTemplateWithoutLoader = true;
        console.warn(
          "[glotforge] t`...${expr}...` reached the runtime untransformed — configure glotforge/loader in your build so interpolated templates are translatable.",
        );
      }
      let out = strings[0];
      for (let i = 0; i < rest.length; i++) {
        out += String(rest[i] ?? "") + strings[i + 1];
      }
      return out;
    }

    // Descriptor form: t({ id, message, values, context })
    if (typeof first === "object" && first !== null) {
      return translateDescriptor(snapshot, first as MessageDescriptor);
    }

    // Plain-string form: t("Wire", { context })
    const options = (rest[0] ?? {}) as TOptions;
    return translateDescriptor(snapshot, {
      id: options.id,
      message: escapeText(first as string),
      context: options.context,
      values: options.values,
    });
  };
  return t as TFunction;
}

/** Global t — bound to the provider's live state on the client. */
export const t: TFunction = makeT(getRuntimeSnapshot);

let warnedMsgWithoutLoader = false;

/**
 * Mark a message WITHOUT translating it — for module-scope constants
 * (nav configs, option lists) that are defined once at import time, long
 * before any locale exists. msg() extracts to the catalog exactly like t,
 * but returns a descriptor; the render site translates it with the live
 * locale:
 *
 *   // config (module scope)
 *   label: msg("Admin", { context: "hub module name" }),
 *   // render site
 *   const t = useT();
 *   <span>{t(module.label)}</span>
 *
 * Never render a msg() result directly — it's a descriptor, not a string.
 */
export function msg(
  first: TemplateStringsArray | MessageDescriptor | string,
  ...rest: unknown[]
): MessageDescriptor {
  // Tagged template: msg`Admin`
  if (Array.isArray(first) && "raw" in (first as TemplateStringsArray)) {
    const strings = first as TemplateStringsArray;
    if (strings.length === 1) {
      return { message: escapeText(strings[0]) };
    }
    // Interpolated templates need the loader to name placeholders (it
    // rewrites the call to the descriptor form). Degrade to literal text.
    if (process.env.NODE_ENV !== "production" && !warnedMsgWithoutLoader) {
      warnedMsgWithoutLoader = true;
      console.warn(
        "[glotforge] msg`...${expr}...` reached the runtime untransformed — configure glotforge/loader in your build.",
      );
    }
    let out = strings[0];
    for (let i = 0; i < rest.length; i++) {
      out += String(rest[i] ?? "") + strings[i + 1];
    }
    return { message: escapeText(out) };
  }

  // Descriptor form (what the loader emits): pass through.
  if (typeof first === "object" && first !== null) {
    return first as MessageDescriptor;
  }

  // Plain-string form: msg("Admin", { context: "..." })
  const options = (rest[0] ?? {}) as TOptions;
  return {
    id: options.id,
    message: escapeText(first as string),
    context: options.context,
    values: options.values,
  };
}

/**
 * Build a t bound to an explicit locale + catalog. This is the server-side
 * entry point (per-request, no shared state) and also useful in tests.
 */
export function createT(
  locale: string,
  catalog: Catalog | null,
  sourceLocale = "en-US",
): TFunction {
  const snapshot: RuntimeSnapshot = {
    locale,
    sourceLocale,
    catalog,
    pseudo: locale === PSEUDO_LOCALE,
  };
  return makeT(() => snapshot);
}
