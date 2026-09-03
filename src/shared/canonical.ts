/**
 * Canonicalization rules shared by the extractor/loader (which read TS/JSX
 * source) and the runtime (which reads live React children). Both sides walk
 * children in the same order and apply the same naming, so a tag name in a
 * translated message always maps back to the right original element.
 */

/** Semantic tag names for common HTML elements inside <Trans>. */
const ELEMENT_TAG_NAMES: Record<string, string> = {
  a: "link",
  b: "bold",
  strong: "strong",
  i: "italic",
  em: "em",
  u: "underline",
  s: "strike",
  del: "strike",
  mark: "mark",
  small: "small",
  sup: "sup",
  sub: "sub",
  code: "code",
  kbd: "kbd",
  abbr: "abbr",
  span: "span",
  br: "br",
  wbr: "wbr",
};

/**
 * Derive the semantic tag name for an element inside <Trans>.
 * HTML elements map through ELEMENT_TAG_NAMES; components use their own
 * name, lowercased (Tooltip -> tooltip, HelpLink -> helplink).
 */
export function baseTagName(elementName: string): string {
  const simple = elementName.includes(".")
    ? elementName.slice(elementName.lastIndexOf(".") + 1)
    : elementName;
  if (ELEMENT_TAG_NAMES[simple]) return ELEMENT_TAG_NAMES[simple];
  return simple.toLowerCase().replace(/[^a-z0-9-]/g, "") || "component";
}

/**
 * Stateful dedupe: first occurrence keeps the base name, later ones get a
 * numeric suffix (link, link2, link3). Create one per message and feed it
 * names in child order — extraction and runtime then agree.
 */
export class NameAllocator {
  private counts = new Map<string, number>();

  allocate(base: string): string {
    const count = (this.counts.get(base) ?? 0) + 1;
    this.counts.set(base, count);
    return count === 1 ? base : `${base}${count}`;
  }
}

/**
 * Derive a placeholder name from an expression's source text:
 *   name            -> name
 *   user.firstName  -> firstName
 *   items.length    -> length
 *   getTotal()      -> getTotal
 * Anything unrecognizable falls back to "value" (then dedupes to value2...).
 */
export function basePlaceholderName(expressionText: string): string {
  const text = expressionText.trim();
  const identifier = /^([a-zA-Z_$][a-zA-Z0-9_$]*)$/.exec(text);
  if (identifier) return identifier[1];
  const property = /\.([a-zA-Z_$][a-zA-Z0-9_$]*)\s*(\?)?$/.exec(text);
  if (property) return property[1];
  const call = /^([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/.exec(text);
  if (call) return call[1];
  return "value";
}

/**
 * HTML entity references in JSX text/attributes ("don&rsquo;t") are decoded
 * by the JSX compiler before React ever sees them. The extractor must do the
 * same, or the entity text leaks into the catalog, translators preserve it,
 * and the translated string renders the entity literally on screen.
 */
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  middot: "·",
  bull: "•",
  copy: "©",
  reg: "®",
  trade: "™",
  deg: "°",
  times: "×",
  rarr: "→",
  larr: "←",
};

export function decodeJsxEntities(text: string): string {
  return text.replace(
    /&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g,
    (whole, body: string) => {
      if (body.startsWith("#x") || body.startsWith("#X")) {
        const code = parseInt(body.slice(2), 16);
        return Number.isNaN(code) ? whole : String.fromCodePoint(code);
      }
      if (body.startsWith("#")) {
        const code = parseInt(body.slice(1), 10);
        return Number.isNaN(code) ? whole : String.fromCodePoint(code);
      }
      return NAMED_ENTITIES[body] ?? whole;
    },
  );
}

/**
 * JSX text normalization — Babel/SWC's cleanJSXElementLiteralChild algorithm
 * plus entity decoding. The JSX compiler applies both to source text before
 * it ever reaches React, so the extractor must apply the identical rules to
 * raw JsxText for hashes and rendering to line up with what the runtime sees.
 */
export function normalizeJsxText(raw: string): string {
  return decodeJsxEntities(cleanJsxWhitespace(raw));
}

function cleanJsxWhitespace(raw: string): string {
  const lines = raw.split(/\r\n|\n|\r/);
  let lastNonEmptyLine = 0;
  for (let i = 0; i < lines.length; i++) {
    if (/[^ \t]/.test(lines[i])) lastNonEmptyLine = i;
  }
  let str = "";
  for (let i = 0; i < lines.length; i++) {
    const isFirstLine = i === 0;
    const isLastLine = i === lines.length - 1;
    const isLastNonEmptyLine = i === lastNonEmptyLine;
    let trimmed = lines[i].replace(/\t/g, " ");
    if (!isFirstLine) trimmed = trimmed.replace(/^ +/, "");
    if (!isLastLine) trimmed = trimmed.replace(/ +$/, "");
    if (trimmed) {
      if (!isLastNonEmptyLine) trimmed += " ";
      str += trimmed;
    }
  }
  return str;
}

/**
 * Canonical ordering for <Plural> branches so extraction and any runtime
 * reconstruction serialize identically: exact matches ascending, then the
 * CLDR categories in fixed order.
 */
const CATEGORY_ORDER = ["zero", "one", "two", "few", "many", "other"];

export function orderPluralSelectors(selectors: string[]): string[] {
  return [...selectors].sort((a, b) => {
    const aExact = a.startsWith("=");
    const bExact = b.startsWith("=");
    if (aExact && bExact) return Number(a.slice(1)) - Number(b.slice(1));
    if (aExact) return -1;
    if (bExact) return 1;
    return CATEGORY_ORDER.indexOf(a) - CATEGORY_ORDER.indexOf(b);
  });
}

/** Prop names on <Plural> that are plural branches. */
export const PLURAL_BRANCH_PROPS = ["zero", "one", "two", "few", "many", "other"];

/** Convert a <Plural> prop name to a message selector: _0 -> =0, one -> one. */
export function pluralPropToSelector(prop: string): string | null {
  if (PLURAL_BRANCH_PROPS.includes(prop)) return prop;
  const exact = /^_(\d+)$/.exec(prop);
  if (exact) return `=${exact[1]}`;
  return null;
}

/** The <Plural> component's numeric argument always canonicalizes as "value". */
export const PLURAL_ARG_NAME = "value";
