/**
 * Minimal glob support (no dependency): **, *, ?, {a,b} alternation.
 * Paths are matched with forward slashes, relative to the project root.
 */

export function globToRegExp(glob: string): RegExp {
  let pattern = "";
  let i = 0;
  const g = glob.replace(/\\/g, "/");
  while (i < g.length) {
    const ch = g[i];
    if (ch === "*") {
      if (g[i + 1] === "*") {
        // ** — any number of path segments. Swallow a following slash so
        // "src/**/x" also matches "src/x".
        if (g[i + 2] === "/") {
          pattern += "(?:[^/]+/)*";
          i += 3;
        } else {
          pattern += ".*";
          i += 2;
        }
      } else {
        pattern += "[^/]*";
        i += 1;
      }
    } else if (ch === "?") {
      pattern += "[^/]";
      i += 1;
    } else if (ch === "{") {
      const end = g.indexOf("}", i);
      if (end === -1) {
        pattern += "\\{";
        i += 1;
      } else {
        const alternatives = g
          .slice(i + 1, end)
          .split(",")
          .map((alt) => alt.replace(/[.+^${}()|[\]\\?*]/g, "\\$&"));
        pattern += `(?:${alternatives.join("|")})`;
        i = end + 1;
      }
    } else {
      pattern += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
      i += 1;
    }
  }
  return new RegExp(`^${pattern}$`);
}

export function matchesAny(path: string, patterns: RegExp[]): boolean {
  const normalized = path.replace(/\\/g, "/");
  return patterns.some((p) => p.test(normalized));
}
