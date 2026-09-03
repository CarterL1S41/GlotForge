/**
 * The GlotForge message grammar — a deliberately small, owned format. Because the
 * same package produces catalogs (extractor), consumes them (runtime), and
 * writes translations (CLI), we don't need full ICU compatibility; we need a
 * grammar just rich enough for real UI copy:
 *
 *   text            Hello world
 *   escapes         \{  \<  \\           (literal { < \ in text)
 *   arguments       {name}
 *   plural          {name, plural, one {# item} other {# items}}
 *   select          {name, select, admin {Admin} other {User}}
 *   tags            <link>our team</link>   <br/>
 *   pound           #  (inside a plural branch: the formatted number)
 *
 * Plural selectors: exact matches (=0, =1, ...) and the CLDR categories
 * zero/one/two/few/many/other. Translations may use a DIFFERENT set of
 * categories than the source (Russian needs few/many; Indonesian only
 * other) — that is expected and validated, not an error — but every plural
 * must include `other`.
 */

export type MessageNode =
  | { type: "text"; value: string }
  | { type: "arg"; name: string }
  | { type: "pound" }
  | { type: "tag"; name: string; children: MessageNode[] }
  | {
      type: "plural" | "select";
      name: string;
      options: { selector: string; value: MessageNode[] }[];
    };

const PLURAL_CATEGORIES = ["zero", "one", "two", "few", "many", "other"];

export class MessageSyntaxError extends Error {
  constructor(
    message: string,
    public readonly position: number,
  ) {
    super(`${message} (at position ${position})`);
    this.name = "MessageSyntaxError";
  }
}

/** Escape literal text so it round-trips through the grammar. */
export function escapeText(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/\{/g, "\\{")
    .replace(/\}/g, "\\}")
    .replace(/</g, "\\<");
}

/** Escape text inside a plural/select branch, where # is also special. */
function escapeBranchText(text: string): string {
  return escapeText(text).replace(/#/g, "\\#");
}

interface ParseContext {
  /** Inside a plural branch # is the special pound token. */
  inPlural: boolean;
  /** Inside a plural/select branch } closes the branch; elsewhere it's text. */
  inBranch: boolean;
}

/** Parse a canonical message string into an AST. Throws MessageSyntaxError. */
export function parseMessage(message: string): MessageNode[] {
  const parser = new Parser(message);
  const nodes = parser.parseNodes({ inPlural: false, inBranch: false }, null);
  if (parser.pos < message.length) {
    throw new MessageSyntaxError(
      `Unexpected '${message[parser.pos]}'`,
      parser.pos,
    );
  }
  return nodes;
}

class Parser {
  pos = 0;
  constructor(private readonly src: string) {}

  parseNodes(ctx: ParseContext, closingTag: string | null): MessageNode[] {
    const nodes: MessageNode[] = [];
    let text = "";
    const flush = () => {
      if (text) {
        nodes.push({ type: "text", value: text });
        text = "";
      }
    };
    while (this.pos < this.src.length) {
      const ch = this.src[this.pos];
      if (ch === "\\") {
        // Escape: take the next character literally.
        if (this.pos + 1 >= this.src.length) {
          throw new MessageSyntaxError("Dangling escape", this.pos);
        }
        text += this.src[this.pos + 1];
        this.pos += 2;
      } else if (ch === "{") {
        flush();
        nodes.push(this.parseArgument(ctx));
      } else if (ch === "}") {
        if (ctx.inBranch) break; // end of a plural/select branch — caller handles it
        text += ch; // outside a branch a bare } is just text
        this.pos++;
      } else if (ch === "#" && ctx.inPlural) {
        flush();
        nodes.push({ type: "pound" });
        this.pos++;
      } else if (ch === "<") {
        if (this.src.startsWith("</", this.pos)) {
          // Closing tag — must match the tag we're inside.
          const end = this.src.indexOf(">", this.pos);
          if (end === -1) {
            throw new MessageSyntaxError("Unterminated closing tag", this.pos);
          }
          const name = this.src.slice(this.pos + 2, end).trim();
          if (name !== closingTag) {
            throw new MessageSyntaxError(
              closingTag
                ? `Expected </${closingTag}> but found </${name}>`
                : `Unexpected closing tag </${name}>`,
              this.pos,
            );
          }
          break;
        }
        flush();
        nodes.push(this.parseTag(ctx));
      } else {
        text += ch;
        this.pos++;
      }
    }
    flush();
    return nodes;
  }

  private parseTag(ctx: ParseContext): MessageNode {
    const start = this.pos;
    const match = /^<([a-zA-Z][a-zA-Z0-9-]*)\s*(\/?)>/.exec(
      this.src.slice(this.pos),
    );
    if (!match) {
      throw new MessageSyntaxError("Malformed tag", start);
    }
    const name = match[1];
    this.pos += match[0].length;
    if (match[2] === "/") {
      return { type: "tag", name, children: [] };
    }
    const children = this.parseNodes(ctx, name);
    // parseNodes stopped at "</name" — consume the closing tag.
    const closeMatch = /^<\/\s*([a-zA-Z][a-zA-Z0-9-]*)\s*>/.exec(
      this.src.slice(this.pos),
    );
    if (!closeMatch || closeMatch[1] !== name) {
      throw new MessageSyntaxError(`Missing </${name}>`, this.pos);
    }
    this.pos += closeMatch[0].length;
    return { type: "tag", name, children };
  }

  private parseArgument(ctx: ParseContext): MessageNode {
    const start = this.pos;
    this.pos++; // consume {
    const nameMatch = /^\s*([a-zA-Z_][a-zA-Z0-9_]*|\d+)\s*/.exec(
      this.src.slice(this.pos),
    );
    if (!nameMatch) {
      throw new MessageSyntaxError("Expected argument name after '{'", start);
    }
    const name = nameMatch[1];
    this.pos += nameMatch[0].length;

    if (this.src[this.pos] === "}") {
      this.pos++;
      return { type: "arg", name };
    }
    if (this.src[this.pos] !== ",") {
      throw new MessageSyntaxError("Expected '}' or ',' in argument", this.pos);
    }
    this.pos++; // consume ,
    const kindMatch = /^\s*(plural|select)\s*,\s*/.exec(this.src.slice(this.pos));
    if (!kindMatch) {
      throw new MessageSyntaxError(
        "Expected 'plural' or 'select' after argument name",
        this.pos,
      );
    }
    const kind = kindMatch[1] as "plural" | "select";
    this.pos += kindMatch[0].length;

    const options: { selector: string; value: MessageNode[] }[] = [];
    while (true) {
      const selMatch = /^\s*(=\d+|[a-zA-Z_][a-zA-Z0-9_]*)\s*\{/.exec(
        this.src.slice(this.pos),
      );
      if (!selMatch) break;
      const selector = selMatch[1];
      if (kind === "plural" && !selector.startsWith("=")) {
        if (!PLURAL_CATEGORIES.includes(selector)) {
          throw new MessageSyntaxError(
            `Unknown plural category '${selector}'`,
            this.pos,
          );
        }
      }
      this.pos += selMatch[0].length;
      const value = this.parseNodes(
        { inPlural: kind === "plural" || ctx.inPlural, inBranch: true },
        null,
      );
      if (this.src[this.pos] !== "}") {
        throw new MessageSyntaxError(
          `Unterminated ${kind} branch '${selector}'`,
          this.pos,
        );
      }
      this.pos++; // consume branch }
      options.push({ selector, value });
    }
    const wsMatch = /^\s*/.exec(this.src.slice(this.pos));
    if (wsMatch) this.pos += wsMatch[0].length;
    if (this.src[this.pos] !== "}") {
      throw new MessageSyntaxError(`Unterminated ${kind}`, this.pos);
    }
    this.pos++; // consume closing }
    if (options.length === 0) {
      throw new MessageSyntaxError(`Empty ${kind}`, start);
    }
    if (!options.some((o) => o.selector === "other")) {
      throw new MessageSyntaxError(`A ${kind} must include 'other'`, start);
    }
    return { type: kind, name, options };
  }
}

/** Serialize an AST back to a canonical message string. */
export function serializeMessage(nodes: MessageNode[], inPlural = false): string {
  let out = "";
  for (const node of nodes) {
    switch (node.type) {
      case "text":
        out += inPlural ? escapeBranchText(node.value) : escapeText(node.value);
        break;
      case "arg":
        out += `{${node.name}}`;
        break;
      case "pound":
        out += "#";
        break;
      case "tag":
        out += node.children.length
          ? `<${node.name}>${serializeMessage(node.children, inPlural)}</${node.name}>`
          : `<${node.name}/>`;
        break;
      case "plural":
      case "select": {
        const branches = node.options
          .map(
            (o) =>
              `${o.selector} {${serializeMessage(o.value, node.type === "plural" || inPlural)}}`,
          )
          .join(" ");
        out += `{${node.name}, ${node.type}, ${branches}}`;
        break;
      }
    }
  }
  return out;
}

/** Structural summary of a message, used to validate translations. */
export interface MessageShape {
  args: string[];
  tags: string[];
  /** Names of plural/select arguments (their category sets may vary by language). */
  branchArgs: string[];
}

export function shapeOf(nodes: MessageNode[]): MessageShape {
  const args = new Set<string>();
  const tags = new Set<string>();
  const branchArgs = new Set<string>();
  const walk = (list: MessageNode[]) => {
    for (const node of list) {
      if (node.type === "arg") args.add(node.name);
      else if (node.type === "tag") {
        tags.add(node.name);
        walk(node.children);
      } else if (node.type === "plural" || node.type === "select") {
        branchArgs.add(node.name);
        for (const option of node.options) walk(option.value);
      }
    }
  };
  walk(nodes);
  return {
    args: [...args].sort(),
    tags: [...tags].sort(),
    branchArgs: [...branchArgs].sort(),
  };
}

/**
 * Validate that a translation is structurally compatible with its source:
 * same arguments, same tags, same plural/select argument names. Plural
 * CATEGORIES may differ per language. Returns null when valid, otherwise a
 * human-readable problem description.
 */
export function validateTranslation(
  sourceMessage: string,
  translation: string,
): string | null {
  let source: MessageShape;
  try {
    source = shapeOf(parseMessage(sourceMessage));
  } catch (err) {
    return `source failed to parse: ${(err as Error).message}`;
  }
  let translated: MessageShape;
  try {
    translated = shapeOf(parseMessage(translation));
  } catch (err) {
    return `translation failed to parse: ${(err as Error).message}`;
  }
  const diff = (kind: string, a: string[], b: string[]): string | null => {
    const missing = a.filter((x) => !b.includes(x));
    const extra = b.filter((x) => !a.includes(x));
    if (!missing.length && !extra.length) return null;
    const parts = [];
    if (missing.length) parts.push(`missing ${kind}: ${missing.join(", ")}`);
    if (extra.length) parts.push(`unexpected ${kind}: ${extra.join(", ")}`);
    return parts.join("; ");
  };
  return (
    diff("arguments", source.args, translated.args) ??
    diff("tags", source.tags, translated.tags) ??
    diff("plural/select arguments", source.branchArgs, translated.branchArgs)
  );
}
