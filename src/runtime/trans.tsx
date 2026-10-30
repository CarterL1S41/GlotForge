"use client";

import React, { type ReactElement, type ReactNode } from "react";
import { hashMessage } from "../shared/hash";
import { escapeText, parseMessage, type MessageNode } from "../shared/message";
import {
  NameAllocator,
  baseTagName,
  orderPluralSelectors,
  pluralPropToSelector,
  PLURAL_ARG_NAME,
} from "../shared/canonical";
import { renderToReact } from "./render";
import { useI18nOptional } from "./context";
import { PSEUDO_LOCALE } from "./pseudo";

export interface TransProps {
  children?: ReactNode;
  /** Injected by the build-time loader — never hand-written. */
  id?: string;
  /** Injected by the build-time loader — never hand-written. */
  message?: string;
  /** Injected by the loader (or passed manually with the descriptor style). */
  values?: Record<string, unknown>;
  /**
   * Free-prose disambiguation for the translator, e.g.
   * "wire as in wire request". Participates in the hash.
   */
  context?: string;
  /**
   * Generate spoken audio for this message (`glotforge voice`). A string is
   * the key the app plays it by: useVoicePlayer("intro"). Not in the hash.
   */
  voice?: string | boolean;
  /**
   * Word-highlight mode: when set (even to null) every word renders in a
   * <span data-voice-word={n}>, and the word whose index equals the value
   * also gets data-voice-active. Feed it useVoicePlayer(...).word.
   */
  highlight?: number | null;
}

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
    if (parseCache.size > 5000) parseCache.clear();
    parseCache.set(message, nodes);
  }
  return nodes;
}

function elementName(el: ReactElement): string {
  const type = el.type as { displayName?: string; name?: string } | string;
  if (typeof type === "string") return type;
  return type?.displayName || type?.name || "component";
}

interface ChildWalk {
  canonical: string;
  supported: boolean;
  tags: Record<string, ReactElement>;
}

/**
 * Walk live React children in the same pre-order as the extractor walks the
 * JSX AST, so semantic tag names line up with the elements they came from.
 * Also produces a canonical message for the loaderless static fallback.
 */
function walkChildren(
  children: ReactNode,
  allocator: NameAllocator,
  walk: ChildWalk,
): void {
  React.Children.forEach(children, (child) => {
    if (child === null || child === undefined || typeof child === "boolean") {
      return;
    }
    if (typeof child === "string") {
      walk.canonical += escapeText(child);
      return;
    }
    if (typeof child === "number") {
      // A bare numeric expression needs the loader to become a named
      // placeholder; the fallback canonicalization can't represent it.
      walk.supported = false;
      return;
    }
    if (React.isValidElement(child)) {
      const name = allocator.allocate(baseTagName(elementName(child)));
      walk.tags[name] = child;
      const inner = (child.props as { children?: ReactNode }).children;
      if (inner === undefined || inner === null) {
        walk.canonical += `<${name}/>`;
      } else {
        walk.canonical += `<${name}>`;
        walkChildren(inner, allocator, walk);
        walk.canonical += `</${name}>`;
      }
      return;
    }
    walk.supported = false;
  });
}

let warnedTransWithoutLoader = false;

/**
 * <Trans>Contact <a href="/support">our team</a> before <b>Friday</b></Trans>
 *
 * The build-time loader injects id/message/values; at runtime this is a
 * catalog lookup, a cached parse, and a children walk to map semantic tags
 * back onto the original elements (styles, handlers, and props intact).
 */
export function Trans(props: TransProps): ReactNode {
  const ctx = useI18nOptional();

  const walk: ChildWalk = { canonical: "", supported: true, tags: {} };
  walkChildren(props.children, new NameAllocator(), walk);

  let message = props.message;
  if (message === undefined) {
    if (!walk.supported) {
      if (process.env.NODE_ENV !== "production" && !warnedTransWithoutLoader) {
        warnedTransWithoutLoader = true;
        console.warn(
          "[glotforge] <Trans> with expressions reached the runtime untransformed — configure glotforge/loader in your build. Rendering source English.",
        );
      }
      return props.children;
    }
    message = walk.canonical;
  }

  const locale = ctx?.locale ?? "en-US";
  const sourceLocale = ctx?.sourceLocale ?? "en-US";
  const pseudo = ctx?.pseudo || locale === PSEUDO_LOCALE;

  let translated = message;
  if (ctx && !pseudo && locale !== sourceLocale) {
    const id = props.id ?? hashMessage(message, props.context);
    translated = ctx.catalog?.[id] ?? message;
  }

  let nodes = parseCached(translated);
  if (!nodes && translated !== message) nodes = parseCached(message);
  if (!nodes) return props.children;

  const rendered = renderToReact(nodes, {
    locale: pseudo ? sourceLocale : locale,
    values: props.values,
    tags: walk.tags,
    pseudo,
    words:
      props.highlight !== undefined
        ? { active: props.highlight, index: 0 }
        : undefined,
  });

  if (ctx?.devtoolsActive) {
    const id = props.id ?? hashMessage(message, props.context);
    return (
      <span
        data-i18n-id={id}
        data-i18n-message={message}
        data-i18n-context={props.context}
      >
        {rendered}
      </span>
    );
  }
  return <>{rendered}</>;
}

type PluralBranchProps = {
  zero?: string;
  one?: string;
  two?: string;
  few?: string;
  many?: string;
  other: string;
} & {
  /** Exact-count branches: _0="No items" _1="Just one" */
  [exact: `_${number}`]: string | undefined;
};

export type PluralProps = PluralBranchProps & {
  value: number;
  /** Extra placeholder values referenced inside branch text. */
  values?: Record<string, unknown>;
  context?: string;
  /** Injected by the build-time loader — never hand-written. */
  id?: string;
  /** Injected by the build-time loader — never hand-written. */
  message?: string;
};

/**
 * <Plural value={count} one="# item" other="# items" _0="No items" />
 *
 * Branch text is message grammar: # is the formatted count, {name} reads
 * from `values`. Translations may use the plural categories their language
 * needs (Russian adds few/many) — the source only writes English's.
 */
export function Plural(props: PluralProps): ReactNode {
  const ctx = useI18nOptional();

  let message = props.message;
  if (message === undefined) {
    // Branches are static strings, so unlike <Trans> the canonical form is
    // fully reconstructible at runtime — loaderless setups lose nothing.
    const branches = new Map<string, string>();
    for (const [prop, value] of Object.entries(props)) {
      if (typeof value !== "string") continue;
      const selector = pluralPropToSelector(prop);
      if (selector) branches.set(selector, value);
    }
    const ordered = orderPluralSelectors([...branches.keys()]);
    const body = ordered
      .map((sel) => `${sel} {${branches.get(sel)}}`)
      .join(" ");
    message = `{${PLURAL_ARG_NAME}, plural, ${body}}`;
  }

  const locale = ctx?.locale ?? "en-US";
  const sourceLocale = ctx?.sourceLocale ?? "en-US";
  const pseudo = ctx?.pseudo || locale === PSEUDO_LOCALE;

  let translated = message;
  if (ctx && !pseudo && locale !== sourceLocale) {
    const id = props.id ?? hashMessage(message, props.context);
    translated = ctx.catalog?.[id] ?? message;
  }

  let nodes = parseCached(translated);
  if (!nodes && translated !== message) nodes = parseCached(message);
  if (!nodes) return null;

  const values = { [PLURAL_ARG_NAME]: props.value, ...props.values };
  const rendered = renderToReact(nodes, {
    locale: pseudo ? sourceLocale : locale,
    values,
    pseudo,
  });

  if (ctx?.devtoolsActive) {
    const id = props.id ?? hashMessage(message, props.context);
    return (
      <span
        data-i18n-id={id}
        data-i18n-message={message}
        data-i18n-context={props.context}
      >
        {rendered}
      </span>
    );
  }
  return <>{rendered}</>;
}
