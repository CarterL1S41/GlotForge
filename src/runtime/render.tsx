import React, { type ReactElement, type ReactNode } from "react";
import type { MessageNode } from "../shared/message";
import { splitWords } from "../shared/speech";
import { pseudoize } from "./pseudo";

/**
 * Word-highlight state threaded through a render: every text node is split
 * into word spans numbered in render order (the same order the voice
 * command numbers them), and the span whose number equals `active` carries
 * data-voice-active for the app's CSS.
 */
export interface WordHighlight {
  active: number | null;
  /** Running word counter, advanced as text nodes render. */
  index: number;
}

export interface RenderOptions {
  locale: string;
  values?: Record<string, unknown>;
  /** Semantic tag name -> the original React element to clone. */
  tags?: Record<string, ReactElement>;
  pseudo?: boolean;
  words?: WordHighlight;
}

function renderWords(
  text: string,
  locale: string,
  words: WordHighlight,
  keyBase: number,
): ReactNode[] {
  const out: ReactNode[] = [];
  let cursor = 0;
  for (const span of splitWords(text, locale)) {
    if (span.start > cursor) out.push(text.slice(cursor, span.start));
    const index = words.index++;
    out.push(
      <span
        key={`${keyBase}-${index}`}
        data-voice-word={index}
        {...(words.active === index ? { "data-voice-active": "" } : {})}
      >
        {span.text}
      </span>,
    );
    cursor = span.end;
  }
  if (cursor < text.length) out.push(text.slice(cursor));
  return out;
}

function selectBranch(
  options: { selector: string; value: MessageNode[] }[],
  kind: "plural" | "select",
  raw: unknown,
  locale: string,
): MessageNode[] {
  if (kind === "plural") {
    const value = Number(raw);
    const exact = options.find((o) => o.selector === `=${value}`);
    if (exact) return exact.value;
    let category = "other";
    try {
      category = new Intl.PluralRules(locale).select(value);
    } catch {
      // Unknown locale tag — fall through to "other".
    }
    const branch =
      options.find((o) => o.selector === category) ??
      options.find((o) => o.selector === "other");
    return branch ? branch.value : [];
  }
  const key = String(raw);
  const branch =
    options.find((o) => o.selector === key) ??
    options.find((o) => o.selector === "other");
  return branch ? branch.value : [];
}

/** Render a parsed message to React nodes. */
export function renderToReact(
  nodes: MessageNode[],
  opts: RenderOptions,
  pluralValue?: number,
): ReactNode[] {
  const out: ReactNode[] = [];
  nodes.forEach((node, index) => {
    switch (node.type) {
      case "text":
        if (opts.words && !opts.pseudo) {
          out.push(...renderWords(node.value, opts.locale, opts.words, index));
        } else {
          out.push(opts.pseudo ? pseudoize(node.value) : node.value);
        }
        break;
      case "arg": {
        const value = opts.values?.[node.name];
        out.push(value as ReactNode);
        break;
      }
      case "pound":
        out.push(
          pluralValue === undefined
            ? "#"
            : formatPluralNumber(pluralValue, opts.locale),
        );
        break;
      case "tag": {
        const original = opts.tags?.[node.name];
        const children = renderToReact(node.children, opts, pluralValue);
        if (original) {
          out.push(
            node.children.length
              ? React.cloneElement(original, { key: index }, ...children)
              : React.cloneElement(original, { key: index }),
          );
        } else {
          // Tag has no matching element (translation drifted) — render the
          // content unstyled rather than dropping words.
          out.push(
            <React.Fragment key={index}>{children}</React.Fragment>,
          );
        }
        break;
      }
      case "plural":
      case "select": {
        const raw = opts.values?.[node.name];
        const branch = selectBranch(node.options, node.type, raw, opts.locale);
        const value = node.type === "plural" ? Number(raw) : pluralValue;
        out.push(
          <React.Fragment key={index}>
            {renderToReact(branch, opts, value)}
          </React.Fragment>,
        );
        break;
      }
    }
  });
  return out;
}

/** Render a parsed message to a plain string (the t() path). */
export function renderToString(
  nodes: MessageNode[],
  opts: RenderOptions,
  pluralValue?: number,
): string {
  let out = "";
  for (const node of nodes) {
    switch (node.type) {
      case "text":
        out += opts.pseudo ? pseudoize(node.value) : node.value;
        break;
      case "arg": {
        const value = opts.values?.[node.name];
        out += value === undefined || value === null ? "" : String(value);
        break;
      }
      case "pound":
        out +=
          pluralValue === undefined
            ? "#"
            : formatPluralNumber(pluralValue, opts.locale);
        break;
      case "tag":
        // Tags carry no meaning in plain strings — keep the words.
        out += renderToString(node.children, opts, pluralValue);
        break;
      case "plural":
      case "select": {
        const raw = opts.values?.[node.name];
        const branch = selectBranch(node.options, node.type, raw, opts.locale);
        const value = node.type === "plural" ? Number(raw) : pluralValue;
        out += renderToString(branch, opts, value);
        break;
      }
    }
  }
  return out;
}

function formatPluralNumber(value: number, locale: string): string {
  try {
    return new Intl.NumberFormat(locale).format(value);
  } catch {
    return String(value);
  }
}
