import React, { type ReactElement, type ReactNode } from "react";
import type { MessageNode } from "../shared/message";
import { pseudoize } from "./pseudo";

export interface RenderOptions {
  locale: string;
  values?: Record<string, unknown>;
  /** Semantic tag name -> the original React element to clone. */
  tags?: Record<string, ReactElement>;
  pseudo?: boolean;
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
        out.push(opts.pseudo ? pseudoize(node.value) : node.value);
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
