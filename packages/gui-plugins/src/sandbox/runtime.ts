import type { Sandbox } from "@opencode/schema/sandbox"

const KNOWN_BARE_IMPORTS: readonly string[] = [
  "react",
  "react/jsx-runtime",
  "react-dom",
  "react-dom/client",
  "lucide-react",
  "recharts",
  "framer-motion",
  "canvas-confetti",
  "three",
  "clsx",
  "tailwind-merge",
]

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
}

function escapeInlineScript(script: string): string {
  return script.replace(/<\/script/gi, "<\\/script")
}

export function normalizeFenceLanguage(language: string): Sandbox.Language | undefined {
  const lower = language.trim().toLowerCase()
  if (lower === "html" || lower === "htm") return "html"
  if (lower === "jsx") return "jsx"
  if (lower === "tsx" || lower === "react") return "tsx"
  if (lower === "svg") return "svg"
  return undefined
}

export function inferSandboxTitle(code: string, language: Sandbox.Language): string {
  if (language === "html") {
    const titleMatch = /<title[^>]*>([^<]+)<\/title>/i.exec(code)
    if (titleMatch?.[1]?.trim()) return titleMatch[1].trim().slice(0, 48)
    const h1Match = /<h1[^>]*>([^<]+)<\/h1>/i.exec(code)
    if (h1Match?.[1]?.trim()) return h1Match[1].trim().slice(0, 48)
    return "HTML Preview"
  }

  if (language === "svg") {
    const titleMatch = /<title[^>]*>([^<]+)<\/title>/i.exec(code)
    if (titleMatch?.[1]?.trim()) return titleMatch[1].trim().slice(0, 48)
    return "SVG Preview"
  }

  const defaultFnMatch = /export\s+default\s+function\s+([A-Z][A-Za-z0-9_]*)/.exec(code)
  if (defaultFnMatch?.[1]) return defaultFnMatch[1]

  const fnMatch = /(?:export\s+)?function\s+([A-Z][A-Za-z0-9_]*)\s*\(/.exec(code)
  if (fnMatch?.[1]) return fnMatch[1]

  const constMatch = /(?:export\s+)?const\s+([A-Z][A-Za-z0-9_]*)\s*=/.exec(code)
  if (constMatch?.[1]) return constMatch[1]

  return language === "tsx" ? "React TSX Preview" : "React JSX Preview"
}

export function rewriteUnknownBareImports(code: string): string {
  return code.replace(
    /(\b(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?["'])([^"'./][^"']*)(["'])/g,
    (full, prefix: string, specifier: string, suffix: string) => {
      if (
        specifier.startsWith("http://") ||
        specifier.startsWith("https://") ||
        specifier.startsWith("data:") ||
        specifier.startsWith("blob:") ||
        KNOWN_BARE_IMPORTS.includes(specifier)
      ) {
        return full
      }
      return `${prefix}https://esm.sh/${specifier}?external=react,react-dom${suffix}`
    },
  )
}

function buildErrorBridgeHead(token: string, filesJson?: string): string {
  return `<script>
(function() {
  var TOKEN = ${JSON.stringify(token)};
  var FILES = ${filesJson ?? "{}"};
  window.__PIGU_SANDBOX_FILES__ = FILES;
  function report(kind, msg) {
    try {
      window.parent.postMessage({ source: "pigu-sandbox", token: TOKEN, kind: kind, message: String(msg || "Unknown error") }, "*");
    } catch (_) {}
  }
  window.__piguSandboxReportError = function(msg) { report("error", msg); };
  window.addEventListener("error", function(ev) {
    var detail = ev && ev.error && ev.error.stack ? ev.error.stack : (ev && ev.message ? ev.message : "Script error");
    report("error", detail);
  });
  window.addEventListener("unhandledrejection", function(ev) {
    var reason = ev ? ev.reason : undefined;
    var detail = reason && reason.stack ? reason.stack : String(reason || "Unhandled promise rejection");
    report("error", detail);
  });
  if (FILES && Object.keys(FILES).length > 0 && typeof window.fetch === "function") {
    var origFetch = window.fetch.bind(window);
    window.fetch = function(input, init) {
      if (typeof input === "string") {
        var clean = input.replace(/^\\.\\//, "").replace(/^\\//, "").split(/[?#]/)[0];
        if (Object.prototype.hasOwnProperty.call(FILES, clean)) {
          var body = FILES[clean];
          var mime = clean.endsWith(".json") ? "application/json"
            : clean.endsWith(".svg") ? "image/svg+xml"
            : clean.endsWith(".css") ? "text/css"
            : clean.endsWith(".js") ? "text/javascript"
            : "text/plain";
          return Promise.resolve(new Response(body, { status: 200, headers: { "content-type": mime } }));
        }
      }
      return origFetch(input, init);
    };
  }
})();
</script>`
}

function inlineRelativeHtmlAssets(html: string, files: Readonly<Record<string, string>> | undefined): string {
  if (!files || Object.keys(files).length === 0) return html

  const lookup = (href: string) => {
    const normalized = href.trim().replace(/^\.\//, "").replace(/^\//, "").split(/[?#]/)[0] ?? ""
    return files[normalized]
  }

  const withStyles = html.replace(
    /<link\b[^>]*rel=["']stylesheet["'][^>]*href=["']([^"']+)["'][^>]*\/?>/gi,
    (match, href: string) => {
      const css = lookup(href)
      return css !== undefined ? `<style>\n${css}\n</style>` : match
    },
  )

  return withStyles.replace(
    /<script\b([^>]*?)\bsrc=["']([^"']+)["']([^>]*)><\/script>/gi,
    (match, before: string, src: string, after: string) => {
      const js = lookup(src)
      if (js === undefined) return match
      return `<script${before}${after}>\n${escapeInlineScript(js)}\n</script>`
    },
  )
}

export function buildSandboxDocument(item: Pick<Sandbox.Item, "title" | "language" | "code" | "files">, token: string): string {
  const filesMap = item.files ?? {}
  const filesJson = escapeInlineScript(JSON.stringify(filesMap))
  const bridgeScript = buildErrorBridgeHead(token, filesJson)

  if (item.language === "svg") {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(item.title)}</title>
  ${bridgeScript}
  <style>
    html, body { margin: 0; height: 100%; background: #ffffff; display: grid; place-items: center; overflow: auto; font-family: system-ui, sans-serif; }
    svg { max-width: 100%; max-height: 100%; height: auto; width: auto; }
  </style>
</head>
<body>
${item.code}
</body>
</html>`
  }

  if (item.language === "html") {
    const resolved = inlineRelativeHtmlAssets(item.code, item.files)
    if (/<head[\s>]/i.test(resolved)) {
      return resolved.replace(/<head([^>]*)>/i, `<head$1>\n${bridgeScript}`)
    }
    if (/<html[\s>]/i.test(resolved)) {
      return resolved.replace(/<html([^>]*)>/i, `<html$1>\n<head>${bridgeScript}</head>`)
    }
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(item.title)}</title>
  ${bridgeScript}
</head>
<body>
${resolved}
</body>
</html>`
  }

  const extraCss = Object.entries(filesMap)
    .filter(([name]) => name.toLowerCase().endsWith(".css"))
    .map(([, css]) => css)
    .join("\n")

  const hasReactImport = /\bfrom\s+["']react["']/.test(item.code)
  const fallbackNameMatch =
    /(?:export\s+default\s+function|export\s+function|function)\s+([A-Z][A-Za-z0-9_]*)/.exec(item.code) ??
    /(?:export\s+)?const\s+([A-Z][A-Za-z0-9_]*)\s*=/.exec(item.code)
  const inferredRoot = fallbackNameMatch?.[1] ?? ""
  const hasDefaultExport = /\bexport\s+default\b/.test(item.code)

  const augmentedSource = [
    ...(hasReactImport
      ? []
      : [
          'import React, { useState, useEffect, useMemo, useCallback, useRef, useReducer, useContext, createContext, Fragment } from "react";',
        ]),
    rewriteUnknownBareImports(item.code).replace(/^\s*import\s+["'][^"']+\.css["'];?\s*$/gm, ""),
    ...(!hasDefaultExport && inferredRoot ? [`\nexport default ${inferredRoot};`] : []),
  ].join("\n")

  const encodedSource = escapeInlineScript(JSON.stringify(augmentedSource))

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(item.title)}</title>
  ${bridgeScript}
  <script src="https://cdn.tailwindcss.com"></script>
  <script src="https://unpkg.com/@babel/standalone@7.26.9/babel.min.js"></script>
  <script type="importmap">
  {
    "imports": {
      "react": "https://esm.sh/react@18.3.1",
      "react/jsx-runtime": "https://esm.sh/react@18.3.1/jsx-runtime",
      "react-dom": "https://esm.sh/react-dom@18.3.1",
      "react-dom/client": "https://esm.sh/react-dom@18.3.1/client",
      "lucide-react": "https://esm.sh/lucide-react@0.468.0?external=react",
      "recharts": "https://esm.sh/recharts@2.15.0?external=react,react-dom",
      "framer-motion": "https://esm.sh/framer-motion@11.15.0?external=react,react-dom",
      "canvas-confetti": "https://esm.sh/canvas-confetti@1.9.3",
      "three": "https://esm.sh/three@0.171.0",
      "clsx": "https://esm.sh/clsx@2.1.1",
      "tailwind-merge": "https://esm.sh/tailwind-merge@2.6.0"
    }
  }
  </script>
  <style>
    html, body, #root { min-height: 100%; margin: 0; }
    body { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #ffffff; color: #0f172a; }
    ${extraCss}
  </style>
</head>
<body>
  <div id="root"></div>
  <script type="module">
    import React from "react";
    import { createRoot } from "react-dom/client";

    class PiguErrorBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { error: null };
      }
      static getDerivedStateFromError(error) {
        return { error };
      }
      componentDidCatch(error) {
        window.__piguSandboxReportError?.(error?.stack || error?.message || String(error));
      }
      render() {
        if (this.state.error) {
          return React.createElement(
            "div",
            { style: { padding: "20px", fontFamily: "ui-monospace, monospace", fontSize: "12px", color: "#b91c1c", background: "#fef2f2", borderBottom: "1px solid #fecaca", whiteSpace: "pre-wrap" } },
            String(this.state.error?.stack || this.state.error?.message || this.state.error)
          );
        }
        return this.props.children;
      }
    }

    async function boot() {
      const rawSource = ${encodedSource};
      if (!window.Babel) {
        throw new Error("Failed to load Babel JSX/TSX compiler from CDN. Check network connectivity.");
      }
      const compiled = window.Babel.transform(rawSource, {
        filename: "SandboxApp.tsx",
        presets: [
          ["react", { runtime: "classic" }],
          ["typescript", { isTSX: true, allExtensions: true }]
        ],
        sourceType: "module"
      }).code;

      const blobUrl = URL.createObjectURL(new Blob([compiled], { type: "text/javascript" }));
      try {
        const mod = await import(blobUrl);
        const Component =
          mod.default ||
          Object.values(mod).find((val) => typeof val === "function");
        if (typeof Component !== "function") {
          throw new Error("No React component exported. Export default a function component (e.g. export default function App() { ... }).");
        }
        const root = createRoot(document.getElementById("root"));
        root.render(React.createElement(PiguErrorBoundary, null, React.createElement(Component)));
      } finally {
        URL.revokeObjectURL(blobUrl);
      }
    }

    boot().catch((err) => {
      const text = err?.stack || err?.message || String(err);
      window.__piguSandboxReportError?.(text);
      const el = document.getElementById("root");
      if (el) {
        el.innerHTML = '<pre style="margin:0;padding:20px;font-family:ui-monospace,monospace;font-size:12px;color:#b91c1c;background:#fef2f2;white-space:pre-wrap;">' +
          text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") +
          '</pre>';
      }
    });
  </script>
</body>
</html>`
}
