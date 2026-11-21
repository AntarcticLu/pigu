export type ParsedMobileCommand =
  | { readonly kind: "help" }
  | { readonly kind: "project"; readonly sub: "list" | "switch" | "new"; readonly arg: string }
  | {
      readonly kind: "chat"
      readonly sub: "list" | "new" | "switch" | "history" | "undo" | "name" | "delete" | "compact"
      readonly arg: string
    }
  | { readonly kind: "model"; readonly sub: "list" | "switch" | "effort"; readonly arg: string }
  | { readonly kind: "shell"; readonly command: string }
  | { readonly kind: "stop" }
  | { readonly kind: "skip" }
  | { readonly kind: "ps"; readonly text: string }
  | { readonly kind: "log" }
  | { readonly kind: "send"; readonly filePath: string }
  | {
      readonly kind: "access"
      readonly sub: "list" | "add" | "remove" | "whoami"
      readonly arg: string
    }
  | { readonly kind: "unknown_command"; readonly rawCommand: string }
  | { readonly kind: "prompt"; readonly text: string }

function normalizeDotPrefix(input: string): string {
  const trimmed = input.trim()
  if (trimmed.startsWith("。") || trimmed.startsWith("．")) {
    return `.${trimmed.slice(1)}`
  }
  return trimmed
}

export function parseMobileInput(rawInput: string): ParsedMobileCommand {
  const normalized = normalizeDotPrefix(rawInput)
  if (!normalized.startsWith(".")) {
    return { kind: "prompt", text: rawInput.trim() }
  }

  // Exclude ellipsis (...), relative paths (./ or ../), or decimal numbers (.5)
  if (
    normalized.startsWith("..") ||
    normalized.startsWith("./") ||
    normalized.startsWith(".\\") ||
    !/^\.[a-zA-Z]/.test(normalized)
  ) {
    return { kind: "prompt", text: rawInput.trim() }
  }

  const firstSpace = normalized.search(/\s/)
  const head = (firstSpace === -1 ? normalized.slice(1) : normalized.slice(1, firstSpace)).toLowerCase()
  const rest = firstSpace === -1 ? "" : normalized.slice(firstSpace + 1).trim()

  if (head === "help" || head === "h" || head === "status") {
    return { kind: "help" }
  }

  if (head === "project" || head === "proj" || head === "p") {
    if (!rest) {
      return { kind: "project", sub: "list", arg: "" }
    }
    const subParts = rest.split(/\s+/)
    const subCmd = (subParts[0] ?? "").toLowerCase()
    const subRest = rest.slice((subParts[0] ?? "").length).trim()
    if (subCmd === "list" || subCmd === "ls") {
      return { kind: "project", sub: "list", arg: subRest }
    }
    if (subCmd === "?" || subCmd === "search") {
      return { kind: "project", sub: "list", arg: `? ${subRest}`.trim() }
    }
    if (subCmd === "new" || subCmd === "add" || subCmd === "create") {
      return { kind: "project", sub: "new", arg: subRest }
    }
    if (subCmd === "switch" && subRest) {
      return { kind: "project", sub: "switch", arg: subRest }
    }
    return { kind: "project", sub: "switch", arg: rest }
  }

  if (head === "new") {
    return { kind: "chat", sub: "new", arg: rest }
  }
  if (head === "list") {
    return { kind: "chat", sub: "list", arg: rest }
  }
  if (head === "history") {
    return { kind: "chat", sub: "history", arg: rest }
  }
  if (head === "undo") {
    return { kind: "chat", sub: "undo", arg: "" }
  }
  if (head === "compact") {
    return { kind: "chat", sub: "compact", arg: "" }
  }

  if (head === "chat" || head === "c" || head === "session") {
    if (!rest) {
      return { kind: "chat", sub: "list", arg: "" }
    }
    const subParts = rest.split(/\s+/)
    const subCmd = (subParts[0] ?? "").toLowerCase()
    const subRest = rest.slice((subParts[0] ?? "").length).trim()
    if (subCmd === "list" || subCmd === "ls") {
      return { kind: "chat", sub: "list", arg: subRest }
    }
    if (subCmd === "?" || subCmd === "search") {
      return { kind: "chat", sub: "list", arg: `? ${subRest}`.trim() }
    }
    if (/^p(?:age)?\d+$/i.test(subCmd) || (subCmd === "page" && /^\d+$/.test(subRest))) {
      return { kind: "chat", sub: "list", arg: rest }
    }
    if (subCmd === "new" || subCmd === "create") {
      return { kind: "chat", sub: "new", arg: subRest }
    }
    if (subCmd === "history" || subCmd === "log") {
      return { kind: "chat", sub: "history", arg: subRest }
    }
    if (subCmd === "undo" || subCmd === "revert") {
      return { kind: "chat", sub: "undo", arg: "" }
    }
    if (subCmd === "compact") {
      return { kind: "chat", sub: "compact", arg: "" }
    }
    if (subCmd === "name" || subCmd === "rename" || subCmd === "title") {
      return { kind: "chat", sub: "name", arg: subRest }
    }
    if (subCmd === "delete" || subCmd === "del" || subCmd === "rm") {
      return { kind: "chat", sub: "delete", arg: subRest }
    }
    if (subCmd === "switch" && subRest) {
      return { kind: "chat", sub: "switch", arg: subRest }
    }
    return { kind: "chat", sub: "switch", arg: rest }
  }

  if (head === "model" || head === "m" || head === "models") {
    if (!rest) {
      return { kind: "model", sub: "list", arg: "" }
    }
    const subParts = rest.split(/\s+/)
    const subCmd = (subParts[0] ?? "").toLowerCase()
    const subRest = rest.slice((subParts[0] ?? "").length).trim()
    if (subCmd === "list" || subCmd === "ls") {
      return { kind: "model", sub: "list", arg: subRest }
    }
    if (subCmd === "effort" || subCmd === "thinking" || subCmd === "reasoning") {
      return { kind: "model", sub: "effort", arg: subRest }
    }
    if (subCmd === "switch" && subRest) {
      return { kind: "model", sub: "switch", arg: subRest }
    }
    return { kind: "model", sub: "switch", arg: rest }
  }

  if (head === "shell" || head === "sh") {
    return { kind: "shell", command: rest }
  }

  if (head === "stop" || head === "abort" || head === "cancel") {
    return { kind: "stop" }
  }

  if (head === "skip" || head === "pass") {
    return { kind: "skip" }
  }

  if (head === "ps" || head === "btw" || head === "steer") {
    return { kind: "ps", text: rest }
  }

  if (head === "log" || head === "progress" || head === "steps" || head === "live") {
    return { kind: "log" }
  }

  if (head === "send" || head === "file") {
    return { kind: "send", filePath: rest }
  }

  if (head === "whoami") {
    return { kind: "access", sub: "whoami", arg: "" }
  }

  if (head === "access" || head === "acl" || head === "auth") {
    if (!rest || rest.toLowerCase() === "list") {
      return { kind: "access", sub: "list", arg: "" }
    }
    const subParts = rest.split(/\s+/)
    const subCmd = (subParts[0] ?? "").toLowerCase()
    const subRest = rest.slice((subParts[0] ?? "").length).trim()
    if (subCmd === "add" || subCmd === "allow" || subCmd === "grant") {
      return { kind: "access", sub: "add", arg: subRest }
    }
    if (subCmd === "remove" || subCmd === "rm" || subCmd === "del" || subCmd === "revoke") {
      return { kind: "access", sub: "remove", arg: subRest }
    }
    if (subCmd === "whoami") {
      return { kind: "access", sub: "whoami", arg: "" }
    }
    return { kind: "access", sub: "list", arg: rest }
  }

  return { kind: "unknown_command", rawCommand: `.${head}` }
}

export function isUserAllowed(ownerID: string, allowFrom: string, userID: string): boolean {
  const user = userID.trim().toLowerCase()
  if (!user) return false
  const owner = ownerID.trim().toLowerCase()
  if (owner && owner === user) return true
  const raw = allowFrom.trim()
  if (raw === "*") return true
  if (!owner && !raw) return true
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .includes(user)
}
