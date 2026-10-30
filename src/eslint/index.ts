/**
 * ESLint plugin — the enforcement layer that makes coverage structural:
 *
 *   no-bare-text      bare JSX text (and watched attributes like placeholder/
 *                     aria-label) must go through <Trans> / t — untranslated
 *                     UI text cannot merge.
 *   no-block-in-trans <Trans> is for chunks, not layout: block-level elements
 *                     (div/p/section/...) and nested <Trans> are errors.
 *
 * Plain string literals in ordinary code (console.error, logger.*, thrown
 * Errors, API payloads) are never candidates — only JSX text nodes and the
 * configured attribute list are examined, so logs can't be flagged.
 *
 * Flat config usage (eslint.config.mjs):
 *
 *   import glotforge from "glotforge/eslint";
 *   export default [
 *     glotforge.configs.recommended,
 *     // or configure manually:
 *     // { plugins: { "glotforge": glotforge },
 *     //   rules: { "glotforge/no-bare-text": ["error", { attributes: [...] }] } }
 *   ];
 */

// Minimal structural types so the plugin compiles without eslint installed
// (eslint is an optional peer). ESLint only needs these shapes at runtime.
interface EstreeNode {
  type: string;
  parent?: EstreeNode;
  [key: string]: unknown;
}

interface RuleContext {
  options: unknown[];
  report(descriptor: { node: EstreeNode; messageId: string; data?: Record<string, string> }): void;
}

interface RuleModule {
  meta: {
    type: string;
    docs: { description: string };
    schema: unknown[];
    messages: Record<string, string>;
  };
  create(context: RuleContext): Record<string, (node: EstreeNode) => void>;
}

const DEFAULT_ATTRIBUTES = [
  "placeholder",
  "aria-label",
  "aria-description",
  "aria-roledescription",
  "aria-valuetext",
  "title",
  "alt",
  "label",
];

const BLOCK_ELEMENTS = new Set([
  "div", "p", "section", "article", "main", "aside", "header", "footer",
  "nav", "ul", "ol", "li", "table", "thead", "tbody", "tfoot", "tr", "td",
  "th", "form", "fieldset", "legend", "h1", "h2", "h3", "h4", "h5", "h6",
  "blockquote", "pre", "dl", "dt", "dd", "figure", "figcaption", "hr",
  "address", "details", "summary", "dialog",
]);

function jsxElementName(node: EstreeNode): string | null {
  const opening = (node.openingElement ?? node) as EstreeNode | undefined;
  const name = opening?.name as EstreeNode | undefined;
  if (!name) return null;
  if (name.type === "JSXIdentifier") return name.name as string;
  if (name.type === "JSXMemberExpression") {
    const property = name.property as EstreeNode | undefined;
    return (property?.name as string) ?? null;
  }
  return null;
}

function hasAncestorTrans(node: EstreeNode): boolean {
  let current = node.parent;
  while (current) {
    if (current.type === "JSXElement") {
      const name = jsxElementName(current);
      if (name === "Trans" || name === "Plural") return true;
    }
    current = current.parent;
  }
  return false;
}

/** Letters in any script — punctuation-only or numeric text is not copy. */
function hasLetters(text: string): boolean {
  return /\p{L}/u.test(text);
}

const noBareText: RuleModule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "User-facing text must be translatable: JSX text belongs inside <Trans>, watched attributes must use t`...`",
    },
    schema: [
      {
        type: "object",
        properties: {
          attributes: { type: "array", items: { type: "string" } },
          allowedStrings: { type: "array", items: { type: "string" } },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      bareText:
        "Bare text in JSX — wrap it in <Trans> so it can be translated.",
      bareAttribute:
        'User-facing attribute "{{attribute}}" has an untranslated string — use t`...`.',
    },
  },
  create(context) {
    const options = (context.options[0] ?? {}) as {
      attributes?: string[];
      allowedStrings?: string[];
    };
    const attributes = new Set(options.attributes ?? DEFAULT_ATTRIBUTES);
    const allowed = new Set(options.allowedStrings ?? []);

    return {
      JSXText(node) {
        const text = String(node.value ?? "");
        if (!hasLetters(text)) return;
        if (allowed.has(text.trim())) return;
        if (hasAncestorTrans(node)) return;
        context.report({ node, messageId: "bareText" });
      },
      JSXAttribute(node) {
        const name = node.name as EstreeNode | undefined;
        if (!name || name.type !== "JSXIdentifier") return;
        const attrName = name.name as string;
        if (!attributes.has(attrName)) return;
        let value = node.value as EstreeNode | null | undefined;
        if (!value) return;
        if (value.type === "JSXExpressionContainer") {
          value = value.expression as EstreeNode;
        }
        if (!value) return;
        const report = () =>
          context.report({
            node,
            messageId: "bareAttribute",
            data: { attribute: attrName },
          });
        if (value.type === "Literal" && typeof value.value === "string") {
          if (hasLetters(value.value) && !allowed.has(value.value.trim())) {
            report();
          }
          return;
        }
        if (value.type === "TemplateLiteral") {
          // An UNtagged template — t`...` arrives as TaggedTemplateExpression
          // and is fine.
          const quasis = (value.quasis ?? []) as EstreeNode[];
          const raw = quasis
            .map((q) => ((q.value as { raw?: string })?.raw ?? ""))
            .join("");
          if (hasLetters(raw)) report();
        }
      },
    };
  },
};

const noBlockInTrans: RuleModule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "<Trans> wraps chunks of copy, not page structure: no block-level elements or nested <Trans> inside it",
    },
    schema: [],
    messages: {
      blockElement:
        "<{{element}}> is a block-level element — <Trans> wraps phrasing content only. Move <Trans> inside it.",
      nestedTrans: "<Trans> cannot be nested inside another <Trans>.",
    },
  },
  create(context) {
    return {
      JSXElement(node) {
        const name = jsxElementName(node);
        if (!name) return;
        if (!hasAncestorTrans(node)) return;
        if (name === "Trans") {
          context.report({ node, messageId: "nestedTrans" });
          return;
        }
        if (BLOCK_ELEMENTS.has(name)) {
          context.report({
            node,
            messageId: "blockElement",
            data: { element: name },
          });
        }
      },
    };
  },
};

const plugin = {
  meta: {
    name: "glotforge",
    version: "1.0.0",
  },
  rules: {
    "no-bare-text": noBareText,
    "no-block-in-trans": noBlockInTrans,
  },
  configs: {} as Record<string, unknown>,
};

plugin.configs.recommended = {
  name: "glotforge/recommended",
  files: ["**/*.{jsx,tsx}"],
  plugins: { "glotforge": plugin },
  rules: {
    "glotforge/no-bare-text": "error",
    "glotforge/no-block-in-trans": "error",
  },
};

export = plugin;
