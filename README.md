# GlotForge

Keyless i18n for TypeScript & React — write copy in your own language, ship
every language. Your UI text lives directly in the source code — no keys, no
registry file. Catalogs are keyed by a content hash of the source text (plus
optional context), a build-time loader bakes the hashes in so the runtime
never hashes or re-serializes anything, and an AI-powered CLI fills the
catalogs with glossary and context steering.

English is the default source language, but any `sourceLocale` works — write
your copy in the language your team thinks in.

```tsx
<Trans>
  Contact <a href="/support">our team</a> before <b>Friday</b>
</Trans>

<Trans context="wire as in wire request">Wire</Trans>

<Plural value={count} one="# item" other="# items" _0="No items" />

<Input placeholder={t`Search transactions`} />
toast.error(t`Failed to save transaction`);
```

## How it fits together

| Piece | Import | Job |
|---|---|---|
| Runtime | `glotforge` | `<Trans>`, `<Plural>`, `t`, provider, Intl helpers, devtools |
| Server helpers | `glotforge/server` | cookie reading, `pickLocale`, per-request `createT` |
| Loader | `glotforge/loader` | build-time hash/message injection (zero runtime hashing) |
| ESLint plugin | `glotforge/eslint` | untranslated text cannot merge; `<Trans>` stays chunk-sized |
| CLI | `npx glotforge` | extract / translate / status |

### Where translations live (and why they're committed)

Each app owns an `i18n/` directory, **committed to git — never gitignored**:

```
i18n/messages.json          hash -> { message, context?, origins }   (the manifest)
i18n/catalog/es-ES.json     hash -> translated string                (one per locale)
i18n/catalog/id-ID.json
```

The committed catalogs ARE the translation cache. `glotforge translate` only
fills hashes missing from a catalog, so nothing already translated is ever
paid for or regenerated again. When source text changes, its hash changes —
the old entry is pruned (git history keeps it) and only the new string is
translated. There is no graveyard file: a git revert restores code and
translations in the same commit.

## Setup in an app

### 0. Install

```
npm install glotforge
```

### 1. Config

```
npx glotforge init
```

creates `i18n.config.json`:

```json
{
  "locales": ["es-ES", "fr-FR", "pt-BR", "id-ID", "ja-JP", "ko-KR"],
  "sourceLocale": "en-US",
  "include": ["src/**/*.{ts,tsx,js,jsx}"],
  "exclude": [],
  "catalogDir": "i18n",
  "translation": {
    "model": "claude-opus-5",
    "batchSize": 20,
    "appContext": "Acme Dashboard — internal finance tooling. Formal but plain register; 'book' means recording a transaction, never a publication."
  }
}
```

Write a real `appContext` — it rides along in every translation prompt and is
the single biggest lever on translation quality.

### 2. The loader (required)

`next.config.ts`:

```ts
const nextConfig = {
  webpack(config) {
    config.module.rules.push({
      test: /\.(ts|tsx|js|jsx)$/,
      exclude: /node_modules/,
      enforce: "pre",
      use: ["glotforge/loader"],
    });
    return config;
  },
};
```

(For Turbopack dev, add the same loader under `turbopack.rules`.)

The loader rewrites, at build time:

```tsx
<Trans>Hello <b>{user.name}</b></Trans>
// becomes
<Trans id="1abc..." message={"Hello <bold>{name}</bold>"} values={{ "name": (user.name) }}>...</Trans>
```

so a render is: one object lookup, one cached parse, done. Without the loader,
static text still works (the runtime falls back to hashing), but interpolated
`t\`...\``/`<Trans>{expr}</Trans>` degrade to the source language with a
dev-console warning — treat the loader as required.

### 3. The provider — and the no-flash recipe

The locale lives in a cookie (so the **server** renders the right language on
first paint) and localStorage caches the catalog. Client-side navigation never
re-reads either, so page changes never flash; the cookie+`initialCatalog` pair
is what makes the *first* paint already translated.

Root layout (server component):

```tsx
import { cookies } from "next/headers";
import { readLocaleCookie, pickLocale } from "glotforge/server";

const LOCALES = ["en-US", "es-ES", "fr-FR", "pt-BR", "id-ID", "ja-JP", "ko-KR"];

export default async function RootLayout({ children }) {
  const cookieStore = await cookies();
  const locale = pickLocale(cookieStore.get("glotforge_locale")?.value, LOCALES, "en-US");
  const catalog =
    locale === "en-US"
      ? null
      : (await import(`@/i18n/catalog/${locale}.json`)).default;

  return (
    <html lang={locale}>
      <body>
        <Providers locale={locale} catalog={catalog}>{children}</Providers>
      </body>
    </html>
  );
}
```

Client providers file:

```tsx
"use client";
import { I18nProvider, I18nDevtools } from "glotforge";

export function Providers({ locale, catalog, user, children }) {
  return (
    <I18nProvider
      locales={LOCALES}
      sourceLocale="en-US"
      initialLocale={locale}
      initialCatalog={catalog}
      loadCatalog={(l) => import(`@/i18n/catalog/${l}.json`).then((m) => m.default)}
      fontMap={{ "ja-JP": "ja", "ko-KR": "ko" }}
      devtoolsAllowed={user?.i18nDevtoolsPermitted === true}
    >
      {children}
      <I18nDevtools />
    </I18nProvider>
  );
}
```

Only the active locale's catalog is ever loaded (lazy per-locale chunks —
no 9,000-line all-languages bundle). `fontMap` writes
`<html data-i18n-font="ja">` for locale-specific font stacks in CSS; the
provider also maintains `lang` and `dir` (RTL-ready).

### 4. ESLint enforcement

`eslint.config.mjs`:

```js
import glotforge from "glotforge/eslint";
export default [
  glotforge.configs.recommended,
];
```

- `no-bare-text` — bare JSX text and watched attributes (`placeholder`,
  `aria-label`, `title`, `alt`, ...) must go through `<Trans>` / `t`.
  Plain string literals in ordinary code (`console.error`, `logger.*`,
  thrown Errors) are never candidates, so logs can't be flagged. Options:
  `{ attributes: [...], allowedStrings: ["Acme"] }` (brand names and other
  never-translated strings), plus standard `eslint-disable` escapes.
- `no-block-in-trans` — `<Trans>` wraps phrasing content only: block-level
  elements (`div`, `p`, `section`, ...) and nested `<Trans>` are errors. This
  is the guard rail against wrapping whole pages.

## Writing translatable code

### `<Trans>` — rich chunks

```tsx
<Trans>Save your changes before leaving.</Trans>
<Trans>Contact <a className="text-brand" href="/support">our team</a> today.</Trans>
<Trans context="verb, as in publish a post">Post</Trans>
```

Inline elements become semantic tags in the catalog (`a` → `<link>`, `b` →
`<bold>`, components → their lowercased name), so the translator sees one full
sentence — `Contact <link>our team</link> today.` — and can reorder freely.
Styles, handlers, and props stay on your original elements.

Rules of thumb:
- Chunks, not pages (the lint rule enforces it).
- Don't conditionally render elements *inside* a `<Trans>` — split into two
  `<Trans>` chunks instead.
- `context` is free prose written for the translator. Identical source text
  with different contexts = separate catalog entries.

### `<Plural>`

```tsx
<Plural value={count} one="# item" other="# items" _0="No items" />
```

`#` renders the locale-formatted number; `_N` props are exact matches.
Branch text is message grammar, so `{name}` placeholders work with a
`values={{ name }}` prop. Translations may use the categories their language
needs (Russian adds `few`/`many`) — you only write your source language's.

### `t` — strings JSX can't wrap

```tsx
t`Failed to save transaction`
t`Welcome back, ${user.firstName}`
t("Wire", { context: "wire as in wire request" })
t({ message: "{count, plural, one {# item} other {# items}}", values: { count } })
```

Template and plain-string forms are literal text (braces auto-escaped); the
descriptor form's `message` is raw grammar when you need plurals/selects in a
string. Inside components prefer `const t = useT()` (re-renders on locale
change); the global `t` import is for non-component code — on the server use
`createT(locale, catalog)` from `/server` instead.

### `msg` — messages defined before any locale exists

Module-scope constants (nav configs, option lists) evaluate once at import
time — a `t()` there would freeze English into the array forever. Mark those
with `msg` (extracts to the catalog exactly like `t`, returns a descriptor)
and translate at the render site:

```tsx
// config — module scope
const MODULES = [
  { id: "admin", label: msg("Admin", { context: "hub module name" }) },
];

// render site — live locale
const t = useT();
<span>{t(module.label)}</span>
```

Internal identifiers (`id: "admin"`) stay plain strings — never translate
keys. And never render a `msg()` result directly; it's a descriptor, not a
string.

### Formatting — no catalog entries needed

```tsx
const { formatDate, formatCurrency, formatNumber } = useFormat();
formatDate(tx.checkDate, "long");        // "5 de septiembre de 2026"
formatCurrency(tx.amount, tx.currency);  // "1.234,56 €"
```

Intl ships full CLDR data — translated month names come free.

## The CLI

```
npx glotforge extract                          # scan → reconcile manifest → prune orphans
npx glotforge translate                        # fill missing entries (estimate + confirm first)
npx glotforge translate --locale id-ID --yes
npx glotforge translate --include "src/app/audits/**" --dry-run
npx glotforge status
```

`extract` rebuilds the active message set from source on every run (a pure
function of the code — no incremental bookkeeping), adds new hashes, and
prunes dead ones from every catalog. A scoped run (`--include`/`--exclude`)
never prunes entries that have origins in files it didn't scan.

`translate` needs an API key for whichever provider(s) the run uses. For the
default Anthropic provider, set `ANTHROPIC_TRANSLATION_KEY` in the app's
`.env.local` or `.env` (the CLI loads them itself; real env vars win over
file values), or fall back to the SDK's standard resolution
(`ANTHROPIC_API_KEY` / an `ant auth login` profile). Other providers read the
env var named in their config (below). Features:

- **Thinking is ON by default** (`--no-thinking` / `--thinking` force it off
  or on for a run; `--effort low|medium|high|xhigh|max` tunes depth —
  OpenAI-compatible providers clamp `xhigh`/`max` to `high`).
- **Per-locale model/thinking/effort** via `translation.overrides` in
  `i18n.config.json` — harder languages can run stronger settings (or a
  different provider entirely) while the rest stay cheap; a plain
  `glotforge translate` applies them automatically:

  ```json
  "translation": {
    "model": "claude-opus-5",
    "thinking": false,
    "overrides": {
      "am-ET": { "thinking": true },
      "yo-NG": { "model": "claude-fable-5", "thinking": true },
      "fr-FR": { "model": "openai:gpt-5.2-mini" }
    }
  }
  ```

  Precedence: CLI flags > per-locale override > global `translation` config.
- **Estimates before spending**: input tokens via a free count-tokens
  endpoint where the provider has one (Anthropic), a calibrated
  chars-per-token ratio elsewhere; output estimated; priced from the model
  table, then a confirmation prompt (`--yes` skips, `--dry-run` estimates
  only).
- **Live progress bar**: single line redrawn in place with count, current
  locale/string, and running cost; plain lines when not a TTY.
- **Structural validation**: every translation is parsed and checked against
  the source (same placeholders, same tags; plural categories may differ).
  Failures retry once with feedback, then are skipped and reported — a bad
  answer can never corrupt a catalog.
- **Server-side refusal fallbacks** are enabled on the Anthropic provider,
  so a safety-classifier decline reroutes within the same request instead of
  failing a batch.
- **Crash-safe**: catalogs are written after every batch.
- `--force` retranslates in-scope entries; `--model` overrides the config
  (accepts `provider:model` references).

### Providers & multi-model translation

Model references are `provider:model` — a bare id means the `anthropic`
provider, so `"claude-opus-5"` and `"anthropic:claude-opus-5"` are the same.
Two providers are built in:

| Provider | Protocol | Key env var |
|---|---|---|
| `anthropic` | Anthropic SDK (prompt caching, thinking, free token counting, refusal fallbacks) | `ANTHROPIC_TRANSLATION_KEY`, then SDK resolution |
| `openai` | OpenAI chat completions | `OPENAI_TRANSLATION_KEY`, then `OPENAI_API_KEY` |

Any OpenAI-compatible endpoint (Ollama, OpenRouter, Groq, LM Studio, a
vLLM box, ...) can be added under `translation.providers`; entries reusing a
built-in name override that built-in's settings:

```json
"translation": {
  "providers": {
    "ollama": { "baseUrl": "http://localhost:11434/v1", "apiKeyEnv": "" },
    "openrouter": { "baseUrl": "https://openrouter.ai/api/v1", "apiKeyEnv": "OPENROUTER_API_KEY" }
  },
  "models": {
    "openai:gpt-5.2": { "inputPerMTok": 1.25, "outputPerMTok": 10 },
    "openrouter:deepseek/deepseek-v4": { "inputPerMTok": 0.3, "outputPerMTok": 1.2 }
  },
  "overrides": {
    "fr-FR": { "model": "openrouter:deepseek/deepseek-v4" },
    "am-ET": { "model": "claude-opus-5", "thinking": true }
  }
}
```

`translation.models` supplies pricing for the estimate/actuals display —
Anthropic models ship with built-in pricing (`claude-opus-5` default,
`claude-sonnet-5`, `claude-opus-4-8`, `claude-haiku-4-5`, `claude-fable-5`,
with correct per-model thinking parameter shapes); anything else without an
entry runs fine but reports $0 with a warning. Mixed-provider runs price
each request at its own model's rates.

### The loop

```
write copy in JSX  →  glotforge extract  →  glotforge translate  →  commit i18n/ with the code
```

## Devtools & pseudo-locale

`devtoolsAllowed` on the provider is a server-controlled permission (wire it
to a flag on the user record, like `auditPermitted`). Allowed users get a
floating 文 button: toggling it on enables a hover inspector (hash, source
text, context, translation status per chunk) and a locale quick-switcher
that includes the **pseudo-locale** — accented, ~40%-widened source text
(`Ţŕáñšáçţîöñš···`) that exposes layout breakage from text expansion without
waiting for real translations.

## Releases

Branches: `develop` (integration) → `main` (release). CI (typecheck + build)
runs on pushes and PRs to both. To release, merge to `main`, bump `version`
in package.json, then:

```
git tag v0.2.0
git push origin v0.2.0
```

The release workflow verifies the tag matches package.json and publishes to
the public npm registry using the repo's `NPM_TOKEN` secret (an npmjs.com
automation token).

## Development

```
npm install
npm run typecheck
npm run build
```

Things that must never change casually: `hashMessage` (every catalog key
depends on it), the canonicalization rules in `src/shared/canonical.ts`, and
the message grammar — all three are shared contracts between the extractor,
the loader, and the runtime.

## License

[MIT](./LICENSE)
