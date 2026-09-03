/**
 * Source analysis shared by the extractor (catalog reconciliation) and the
 * build-time loader (hash/message injection). One AST walk finds every
 * <Trans>, <Plural>, and t-form, canonicalizes it, hashes it, and — for the
 * loader — records the source edit that bakes the result into the code so
 * the runtime never hashes or re-serializes anything.
 */

import ts from "typescript";
import { hashMessage } from "../shared/hash";
import { parseMessage, escapeText } from "../shared/message";
import {
  NameAllocator,
  baseTagName,
  basePlaceholderName,
  decodeJsxEntities,
  normalizeJsxText,
  orderPluralSelectors,
  pluralPropToSelector,
  PLURAL_ARG_NAME,
} from "../shared/canonical";

export interface FoundMessage {
  hash: string;
  message: string;
  context?: string;
  line: number;
}

export interface Diagnostic {
  line: number;
  problem: string;
}

interface Edit {
  start: number;
  end: number;
  replacement: string;
}

export interface AnalyzeResult {
  messages: FoundMessage[];
  diagnostics: Diagnostic[];
  /** Transformed source (loader use). Equals the input when nothing matched. */
  code: string;
}

const PACKAGE_NAME = "glotforge";

/** Cheap pre-check so the loader can skip files with no i18n usage. */
export function mightUseI18n(source: string): boolean {
  return source.includes(PACKAGE_NAME) || source.includes("useT(");
}

export function analyzeSource(source: string, filePath: string): AnalyzeResult {
  const messages: FoundMessage[] = [];
  const diagnostics: Diagnostic[] = [];
  const edits: Edit[] = [];

  if (!mightUseI18n(source)) {
    return { messages, diagnostics, code: source };
  }

  const sf = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.TSX,
  );

  const lineOf = (node: ts.Node): number =>
    sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

  const record = (node: ts.Node, message: string, context?: string, id?: string) => {
    try {
      parseMessage(message);
    } catch (err) {
      diagnostics.push({
        line: lineOf(node),
        problem: `message does not parse: ${(err as Error).message}`,
      });
      return null;
    }
    const hash = id ?? hashMessage(message, context);
    messages.push({ hash, message, context, line: lineOf(node) });
    return hash;
  };

  // ---- attribute helpers -------------------------------------------------

  const attributeStringValue = (
    attr: ts.JsxAttribute,
  ): string | undefined => {
    const init = attr.initializer;
    if (!init) return undefined;
    // Bare string attributes are JSX text — entities decode like the
    // compiler does. Expression-container strings are plain TS literals.
    if (ts.isStringLiteral(init)) return decodeJsxEntities(init.text);
    if (ts.isJsxExpression(init) && init.expression) {
      if (
        ts.isStringLiteral(init.expression) ||
        ts.isNoSubstitutionTemplateLiteral(init.expression)
      ) {
        return init.expression.text;
      }
    }
    return undefined;
  };

  const findAttribute = (
    attrs: ts.JsxAttributes,
    name: string,
  ): ts.JsxAttribute | undefined => {
    for (const prop of attrs.properties) {
      if (
        ts.isJsxAttribute(prop) &&
        ts.isIdentifier(prop.name) &&
        prop.name.text === name
      ) {
        return prop;
      }
    }
    return undefined;
  };

  // ---- <Trans> -----------------------------------------------------------

  const serializeTransChildren = (
    children: ts.NodeArray<ts.JsxChild>,
    tagAllocator: NameAllocator,
    valueAllocator: NameAllocator,
    values: Map<string, string>,
    owner: ts.Node,
  ): string => {
    let out = "";
    for (const child of children) {
      if (ts.isJsxText(child)) {
        out += escapeText(normalizeJsxText(child.text));
      } else if (ts.isJsxExpression(child)) {
        if (!child.expression) continue; // {/* comment */}
        const expr = child.expression;
        if (
          ts.isStringLiteral(expr) ||
          ts.isNoSubstitutionTemplateLiteral(expr)
        ) {
          out += escapeText(expr.text);
        } else {
          const exprText = expr.getText(sf);
          if (exprText.includes("t`")) {
            diagnostics.push({
              line: lineOf(child),
              problem:
                "t`...` inside a <Trans> expression is not supported — hoist it to a variable above the JSX",
            });
          }
          const name = valueAllocator.allocate(basePlaceholderName(exprText));
          values.set(name, exprText);
          out += `{${name}}`;
        }
      } else if (ts.isJsxElement(child)) {
        const tagName = tagAllocator.allocate(
          baseTagName(child.openingElement.tagName.getText(sf)),
        );
        const inner = serializeTransChildren(
          child.children,
          tagAllocator,
          valueAllocator,
          values,
          owner,
        );
        out += `<${tagName}>${inner}</${tagName}>`;
      } else if (ts.isJsxSelfClosingElement(child)) {
        const tagName = tagAllocator.allocate(
          baseTagName(child.tagName.getText(sf)),
        );
        out += `<${tagName}/>`;
      } else if (ts.isJsxFragment(child)) {
        diagnostics.push({
          line: lineOf(child),
          problem: "fragments are not supported inside <Trans>",
        });
      }
    }
    return out;
  };

  const processTrans = (node: ts.JsxElement) => {
    const attrs = node.openingElement.attributes;
    const contextAttr = findAttribute(attrs, "context");
    let context: string | undefined;
    if (contextAttr) {
      context = attributeStringValue(contextAttr);
      if (context === undefined) {
        diagnostics.push({
          line: lineOf(node),
          problem: "context must be a string literal",
        });
        return;
      }
    }

    // Already carries a compiled/manual message — trust it, no edit.
    const messageAttr = findAttribute(attrs, "message");
    const idAttr = findAttribute(attrs, "id");
    if (messageAttr) {
      const manual = attributeStringValue(messageAttr);
      if (manual !== undefined) {
        record(node, manual, context, idAttr && attributeStringValue(idAttr));
      }
      return;
    }

    const values = new Map<string, string>();
    const message = serializeTransChildren(
      node.children,
      new NameAllocator(),
      new NameAllocator(),
      values,
      node,
    );
    if (!message.trim()) {
      diagnostics.push({ line: lineOf(node), problem: "empty <Trans>" });
      return;
    }
    const hash = record(node, message, context);
    if (!hash) return;

    let injection = ` id=${JSON.stringify(hash)} message={${JSON.stringify(message)}}`;
    if (values.size) {
      const pairs = [...values.entries()]
        .map(([name, expr]) => `${JSON.stringify(name)}: (${expr})`)
        .join(", ");
      injection += ` values={{ ${pairs} }}`;
    }
    // Insert before the ">" of the opening element.
    edits.push({
      start: node.openingElement.getEnd() - 1,
      end: node.openingElement.getEnd() - 1,
      replacement: injection,
    });
  };

  // ---- <Plural> ----------------------------------------------------------

  const processPlural = (
    node: ts.JsxElement | ts.JsxSelfClosingElement,
  ) => {
    const opening = ts.isJsxElement(node) ? node.openingElement : node;
    const attrs = opening.attributes;
    const contextAttr = findAttribute(attrs, "context");
    const context = contextAttr ? attributeStringValue(contextAttr) : undefined;
    if (contextAttr && context === undefined) {
      diagnostics.push({
        line: lineOf(node),
        problem: "context must be a string literal",
      });
      return;
    }
    if (findAttribute(attrs, "message")) return; // already compiled

    const branches = new Map<string, string>();
    for (const prop of attrs.properties) {
      if (!ts.isJsxAttribute(prop) || !ts.isIdentifier(prop.name)) continue;
      const selector = pluralPropToSelector(prop.name.text);
      if (!selector) continue;
      const text = attributeStringValue(prop);
      if (text === undefined) {
        diagnostics.push({
          line: lineOf(prop),
          problem: `<Plural> branch "${prop.name.text}" must be a string literal`,
        });
        return;
      }
      branches.set(selector, text);
    }
    if (!branches.has("other")) {
      diagnostics.push({
        line: lineOf(node),
        problem: '<Plural> requires an "other" branch',
      });
      return;
    }
    const ordered = orderPluralSelectors([...branches.keys()]);
    const body = ordered
      .map((sel) => `${sel} {${branches.get(sel)}}`)
      .join(" ");
    const message = `{${PLURAL_ARG_NAME}, plural, ${body}}`;
    const hash = record(node, message, context);
    if (!hash) return;

    const injection = ` id=${JSON.stringify(hash)} message={${JSON.stringify(message)}}`;
    const end = opening.getEnd();
    edits.push({
      // Before "/>" on self-closing, before ">" otherwise.
      start: ts.isJsxSelfClosingElement(opening) ? end - 2 : end - 1,
      end: ts.isJsxSelfClosingElement(opening) ? end - 2 : end - 1,
      replacement: injection,
    });
  };

  // ---- t forms -----------------------------------------------------------

  const objectPropertyString = (
    obj: ts.ObjectLiteralExpression,
    name: string,
  ): string | undefined => {
    for (const prop of obj.properties) {
      if (
        ts.isPropertyAssignment(prop) &&
        ((ts.isIdentifier(prop.name) && prop.name.text === name) ||
          (ts.isStringLiteral(prop.name) && prop.name.text === name))
      ) {
        if (
          ts.isStringLiteral(prop.initializer) ||
          ts.isNoSubstitutionTemplateLiteral(prop.initializer)
        ) {
          return prop.initializer.text;
        }
      }
    }
    return undefined;
  };

  const hasObjectProperty = (
    obj: ts.ObjectLiteralExpression,
    name: string,
  ): boolean => {
    return obj.properties.some(
      (prop) =>
        ts.isPropertyAssignment(prop) &&
        ((ts.isIdentifier(prop.name) && prop.name.text === name) ||
          (ts.isStringLiteral(prop.name) && prop.name.text === name)),
    );
  };

  /** Both string-form markers: t translates now, msg marks for later. */
  const T_FUNCTIONS = new Set(["t", "msg"]);

  /** t`Welcome ${user.firstName}` -> t({ id, message, values }) — same for msg. */
  const processTaggedTemplate = (node: ts.TaggedTemplateExpression): boolean => {
    if (!ts.isIdentifier(node.tag) || !T_FUNCTIONS.has(node.tag.text)) {
      return false;
    }
    const fn = node.tag.text;
    const template = node.template;
    let message: string;
    const values = new Map<string, string>();
    if (ts.isNoSubstitutionTemplateLiteral(template)) {
      message = escapeText(template.text);
    } else if (ts.isTemplateExpression(template)) {
      const allocator = new NameAllocator();
      message = escapeText(template.head.text);
      for (const span of template.templateSpans) {
        const exprText = span.expression.getText(sf);
        const name = allocator.allocate(basePlaceholderName(exprText));
        values.set(name, exprText);
        message += `{${name}}` + escapeText(span.literal.text);
      }
    } else {
      return false;
    }
    if (!message.trim()) return false;
    const hash = record(node, message);
    if (!hash) return true;
    let replacement = `${fn}({ id: ${JSON.stringify(hash)}, message: ${JSON.stringify(message)}`;
    if (values.size) {
      const pairs = [...values.entries()]
        .map(([name, expr]) => `${JSON.stringify(name)}: (${expr})`)
        .join(", ");
      replacement += `, values: { ${pairs} }`;
    }
    replacement += " })";
    edits.push({ start: node.getStart(sf), end: node.getEnd(), replacement });
    return true;
  };

  /**
   * t("Wire", { context: "..." })  -> t({ id, message, context })
   * t({ message: "...", ... })     -> inject id into the descriptor
   * (identical handling for msg)
   */
  const processTCall = (node: ts.CallExpression): boolean => {
    if (
      !ts.isIdentifier(node.expression) ||
      !T_FUNCTIONS.has(node.expression.text)
    ) {
      return false;
    }
    const fn = node.expression.text;
    const [first, second] = node.arguments;
    if (!first) return false;

    if (ts.isObjectLiteralExpression(first)) {
      // Descriptor form: message is raw grammar, not escaped literal text.
      const message = objectPropertyString(first, "message");
      if (message === undefined) return false;
      const context = objectPropertyString(first, "context");
      if (hasObjectProperty(first, "id")) {
        record(node, message, context, objectPropertyString(first, "id"));
        return true;
      }
      const hash = record(node, message, context);
      if (!hash) return true;
      edits.push({
        start: first.getStart(sf) + 1,
        end: first.getStart(sf) + 1,
        replacement: ` id: ${JSON.stringify(hash)},`,
      });
      return true;
    }

    if (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first)) {
      const message = escapeText(first.text);
      if (!message.trim()) return false;
      let context: string | undefined;
      let valuesText: string | undefined;
      if (second) {
        if (!ts.isObjectLiteralExpression(second)) {
          diagnostics.push({
            line: lineOf(node),
            problem: "t() options must be an inline object literal",
          });
          return true;
        }
        context = objectPropertyString(second, "context");
        for (const prop of second.properties) {
          if (
            ts.isPropertyAssignment(prop) &&
            ts.isIdentifier(prop.name) &&
            prop.name.text === "values"
          ) {
            valuesText = prop.initializer.getText(sf);
          }
        }
        if (hasObjectProperty(second, "id")) return true; // already compiled
      }
      const hash = record(node, message, context);
      if (!hash) return true;
      let replacement = `${fn}({ id: ${JSON.stringify(hash)}, message: ${JSON.stringify(message)}`;
      if (context !== undefined) {
        replacement += `, context: ${JSON.stringify(context)}`;
      }
      if (valuesText !== undefined) {
        replacement += `, values: ${valuesText}`;
      }
      replacement += " })";
      edits.push({ start: node.getStart(sf), end: node.getEnd(), replacement });
      return true;
    }
    return false;
  };

  // ---- walk --------------------------------------------------------------

  const visit = (node: ts.Node): void => {
    if (ts.isJsxElement(node)) {
      const tag = node.openingElement.tagName.getText(sf);
      if (tag === "Trans") {
        processTrans(node);
        // Still walk children: expressions may contain t() calls and
        // nested JSX that carries its own translations.
        ts.forEachChild(node, visit);
        return;
      }
      if (tag === "Plural") {
        processPlural(node);
        ts.forEachChild(node, visit);
        return;
      }
    } else if (ts.isJsxSelfClosingElement(node)) {
      if (node.tagName.getText(sf) === "Plural") {
        processPlural(node);
        return;
      }
    } else if (ts.isTaggedTemplateExpression(node)) {
      if (processTaggedTemplate(node)) {
        // The whole expression is replaced verbatim — don't also transform
        // nodes inside it (their text was copied into the replacement).
        return;
      }
    } else if (ts.isCallExpression(node)) {
      if (processTCall(node)) return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  // ---- apply edits -------------------------------------------------------

  let code = source;
  if (edits.length) {
    // Drop any edit nested inside another replaced range, then apply
    // back-to-front so positions stay valid.
    const sorted = [...edits].sort((a, b) => a.start - b.start || a.end - b.end);
    const kept: Edit[] = [];
    let coveredUntil = -1;
    for (const edit of sorted) {
      if (edit.start < coveredUntil) continue;
      kept.push(edit);
      coveredUntil = Math.max(coveredUntil, edit.end);
    }
    for (const edit of kept.reverse()) {
      code = code.slice(0, edit.start) + edit.replacement + code.slice(edit.end);
    }
  }

  return { messages, diagnostics, code };
}
