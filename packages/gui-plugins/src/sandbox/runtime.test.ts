import { describe, expect, test } from "bun:test"
import {
  buildSandboxDocument,
  inferSandboxTitle,
  normalizeFenceLanguage,
  rewriteUnknownBareImports,
} from "./runtime"

describe("sandbox runtime", () => {
  test("normalizes supported fenced code block languages", () => {
    expect(normalizeFenceLanguage("html")).toBe("html")
    expect(normalizeFenceLanguage("HTM")).toBe("html")
    expect(normalizeFenceLanguage("jsx")).toBe("jsx")
    expect(normalizeFenceLanguage("tsx")).toBe("tsx")
    expect(normalizeFenceLanguage("react")).toBe("tsx")
    expect(normalizeFenceLanguage("svg")).toBe("svg")
    expect(normalizeFenceLanguage("python")).toBeUndefined()
  })

  test("infers readable titles from HTML, SVG, and React components", () => {
    expect(inferSandboxTitle("<html><head><title>Sales Overview</title></head></html>", "html")).toBe("Sales Overview")
    expect(inferSandboxTitle("<div><h1>Quarterly Revenue</h1></div>", "html")).toBe("Quarterly Revenue")
    expect(inferSandboxTitle("export default function CompoundCalculator() { return <div /> }", "tsx")).toBe(
      "CompoundCalculator",
    )
    expect(inferSandboxTitle("const InteractiveChart = () => <div />", "jsx")).toBe("InteractiveChart")
    expect(inferSandboxTitle("<svg><title>Topology</title></svg>", "svg")).toBe("Topology")
  })

  test("rewrites unknown bare npm imports to esm.sh while keeping importmap and relative imports intact", () => {
    const input = [
      'import React, { useState } from "react"',
      'import { Sparkles } from "lucide-react"',
      'import confetti from "canvas-confetti"',
      'import dayjs from "dayjs"',
      'import { helper } from "./helper"',
    ].join("\n")

    const output = rewriteUnknownBareImports(input)
    expect(output).toContain('from "react"')
    expect(output).toContain('from "lucide-react"')
    expect(output).toContain('from "canvas-confetti"')
    expect(output).toContain('from "https://esm.sh/dayjs?external=react,react-dom"')
    expect(output).toContain('from "./helper"')
  })

  test("inlines relative stylesheets and scripts for multi-file HTML sandbox items", () => {
    const doc = buildSandboxDocument(
      {
        title: "Demo",
        language: "html",
        code: '<!DOCTYPE html><html><head><link rel="stylesheet" href="./style.css"></head><body><div id="app"></div><script src="./app.js"></script></body></html>',
        files: {
          "style.css": "body { background: #112233; }",
          "app.js": 'document.getElementById("app").textContent = "ready";',
        },
      },
      "tok_123",
    )

    expect(doc).toContain("body { background: #112233; }")
    expect(doc).toContain('document.getElementById("app").textContent = "ready";')
    expect(doc).toContain('"tok_123"')
  })

  test("builds zero-setup React TSX document with auto React import and root export fallback", () => {
    const doc = buildSandboxDocument(
      {
        title: "Counter",
        language: "tsx",
        code: "function Counter() { const [n, setN] = useState(0); return <button onClick={() => setN(n + 1)}>{n}</button>; }",
      },
      "tok_react",
    )

    expect(doc).toContain("importmap")
    expect(doc).toContain("lucide-react")
    expect(doc).toContain("recharts")
    expect(doc).toContain("export default Counter;")
  })
})
