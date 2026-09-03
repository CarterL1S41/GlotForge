import fs from "fs";
import path from "path";

/**
 * Minimal .env loader so the translate command can find its API key
 * (ANTHROPIC_TRANSLATION_KEY) in the app's own env file instead of
 * requiring a per-session export.
 * Reads .env.local then .env from the working directory; parses simple
 * KEY=VALUE lines (quotes stripped, # comments ignored); never overwrites
 * a variable that is already set in the real environment.
 */
export function loadEnvFiles(cwd: string): void {
  for (const name of [".env.local", ".env"]) {
    const file = path.join(cwd, name);
    if (!fs.existsSync(file)) continue;
    let content: string;
    try {
      content = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim().replace(/^export\s+/, "");
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
      if (process.env[key] !== undefined) continue;
      let value = line.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      process.env[key] = value;
    }
  }
}
