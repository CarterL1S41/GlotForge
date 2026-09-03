"use client";

import React, { useEffect, useState, type CSSProperties } from "react";
import { useI18nOptional } from "./context";
import { PSEUDO_LOCALE } from "./pseudo";

/**
 * Translation devtools: a floating toggle (visible only when the provider
 * says devtoolsAllowed — wire that to a server-controlled user flag), a
 * locale quick-switcher including the pseudo-locale, and a hover inspector
 * that shows each <Trans>/<Plural> chunk's hash, source English, context,
 * and current translation status.
 *
 * Render once near the app root: <I18nDevtools />
 */

interface HoverInfo {
  id: string;
  message: string;
  context?: string;
  rect: DOMRect;
}

const panelStyle: CSSProperties = {
  position: "fixed",
  bottom: 56,
  right: 16,
  zIndex: 2147483000,
  background: "#0f172a",
  color: "#e2e8f0",
  borderRadius: 8,
  padding: "10px 12px",
  fontSize: 12,
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
  maxWidth: 320,
};

const buttonStyle: CSSProperties = {
  position: "fixed",
  bottom: 16,
  right: 16,
  zIndex: 2147483000,
  width: 34,
  height: 34,
  borderRadius: 17,
  border: "1px solid #334155",
  background: "#0f172a",
  color: "#e2e8f0",
  fontSize: 13,
  cursor: "pointer",
  lineHeight: "32px",
  textAlign: "center",
  padding: 0,
};

const localeButtonStyle = (active: boolean): CSSProperties => ({
  border: "1px solid " + (active ? "#38bdf8" : "#334155"),
  background: active ? "#0c4a6e" : "transparent",
  color: "#e2e8f0",
  borderRadius: 4,
  padding: "2px 6px",
  margin: "0 4px 4px 0",
  fontSize: 11,
  cursor: "pointer",
});

const tooltipStyle = (rect: DOMRect): CSSProperties => ({
  position: "fixed",
  top: Math.max(8, rect.top - 8),
  left: Math.min(rect.left, Math.max(8, window.innerWidth - 340)),
  transform: "translateY(-100%)",
  zIndex: 2147483001,
  background: "#0f172a",
  color: "#e2e8f0",
  border: "1px solid #334155",
  borderRadius: 6,
  padding: "8px 10px",
  fontSize: 11,
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  maxWidth: 330,
  pointerEvents: "none",
  whiteSpace: "pre-wrap",
  overflowWrap: "break-word",
});

export function I18nDevtools(): React.ReactNode {
  const ctx = useI18nOptional();
  const [hover, setHover] = useState<HoverInfo | null>(null);

  const active = ctx?.devtoolsActive ?? false;

  useEffect(() => {
    if (!active) {
      setHover(null);
      return;
    }
    const onOver = (event: MouseEvent) => {
      const target = event.target as Element | null;
      const chunk = target?.closest?.("[data-i18n-id]");
      if (!chunk) {
        setHover(null);
        return;
      }
      setHover({
        id: chunk.getAttribute("data-i18n-id") ?? "",
        message: chunk.getAttribute("data-i18n-message") ?? "",
        context: chunk.getAttribute("data-i18n-context") ?? undefined,
        rect: chunk.getBoundingClientRect(),
      });
    };
    document.addEventListener("mouseover", onOver, true);
    return () => document.removeEventListener("mouseover", onOver, true);
  }, [active]);

  if (!ctx || !ctx.devtoolsAllowed) return null;

  const { locale, setLocale, locales, sourceLocale, catalog } = ctx;

  const translationOf = (id: string): string | undefined => {
    if (locale === sourceLocale || locale === PSEUDO_LOCALE) return undefined;
    return catalog?.[id];
  };

  return (
    <>
      <button
        type="button"
        style={buttonStyle}
        title="Translation devtools"
        onClick={() => ctx.setDevtoolsActive(!active)}
      >
        {"文"}
      </button>

      {active && (
        <div style={panelStyle}>
          <div style={{ marginBottom: 6, fontWeight: 600 }}>
            i18n devtools
            <span style={{ opacity: 0.6, fontWeight: 400 }}> — hover text to inspect</span>
          </div>
          <div>
            {[...locales, PSEUDO_LOCALE].map((code) => (
              <button
                key={code}
                type="button"
                style={localeButtonStyle(code === locale)}
                onClick={() => setLocale(code)}
              >
                {code}
              </button>
            ))}
          </div>
        </div>
      )}

      {active && hover && (
        <div style={tooltipStyle(hover.rect)}>
          <div style={{ color: "#38bdf8" }}>#{hover.id}</div>
          {hover.context && (
            <div style={{ color: "#fbbf24" }}>context: {hover.context}</div>
          )}
          <div style={{ opacity: 0.85 }}>{hover.message}</div>
          {locale !== sourceLocale && locale !== PSEUDO_LOCALE && (
            <div
              style={{
                marginTop: 4,
                color: translationOf(hover.id) ? "#4ade80" : "#f87171",
              }}
            >
              {translationOf(hover.id) ?? `missing in ${locale}`}
            </div>
          )}
        </div>
      )}
    </>
  );
}
