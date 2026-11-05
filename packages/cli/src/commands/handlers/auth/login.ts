import { intro, log, outro, select, spinner, text } from "@clack/prompts"
import { Effect, Option } from "effect"
import type { FormAnswer, IntegrationInfo, OpenCodeClient } from "@opencode/client"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { selectIntegration, type IntegrationChoice } from "../../../ui/integration-picker"
import { handlePromptErrors, openUrl, prompt, requireInteractive } from "../../../ui/prompt"
import { errorMessage } from "../../../util/error"
import { answerForm, secret } from "./form"
import {
  createClient,
  connectMethods,
  loadIntegrations,
  location,
  request,
  resolveIntegration,
  resolveMethod,
  type ConnectMethod,
} from "./shared"

const integrationPriority = new Map([
  ["opencode-go", 0],
  ["opencode", 1],
  ["openai", 2],
  ["github-copilot", 3],
  ["anthropic", 4],
  ["google", 5],
])

export default Runtime.handler(
  Commands.commands.auth.commands.login,
  Effect.fn("cli.auth.login")((input) =>
    login({
      target: Option.getOrUndefined(input.target),
      url: Option.getOrUndefined(input.url),
      key: Option.getOrUndefined(input.key),
      method: Option.getOrUndefined(input.method),
      answer: input.answer,
    }).pipe(handlePromptErrors),
  ),
)

export const login = Effect.fn("cli.auth.login.run")(function* (input: {
  target?: string
  url?: string
  key?: string
  method?: string
  answer?: ReadonlyArray<string>
}) {
  intro("Configure Pigu API")
  const client = yield* createClient()
  const integration = yield* findIntegration(client, input.target)
  const methods = connectMethods(integration)
  if (methods.length === 0) yield* Effect.fail(new Error(`${integration.name} has no interactive login methods`))
  const method = yield* chooseMethod(methods, input.method)
  const rawAnswers = [...(input.answer ?? []), ...(input.url ? [`baseURL=${input.url}`] : [])]
  const answer = yield* answerForm(method.type === "command" ? undefined : method.form, rawAnswers)
  yield* authenticate(client, integration, method, answer, input.key)
  outro("Done")
})

const findIntegration = Effect.fn("cli.auth.login.integration")(function* (client: OpenCodeClient, target?: string) {
  if (target && URL.canParse(target)) {
    const protocol = new URL(target).protocol
    if (protocol === "http:" || protocol === "https:") {
      const progress = spinner()
      progress.start("Discovering authentication provider...")
      yield* request((signal) => client.experimental.integration.wellknown.add({ url: target, location }, { signal })).pipe(
        Effect.tap(() => Effect.sync(() => progress.stop("Authentication provider discovered"))),
        Effect.tapCause(() => Effect.sync(() => progress.stop("Discovery failed", 1))),
      )
    }
  }
  const integrations = yield* loadIntegrations(client)
  if (target) return yield* resolveIntegration(integrations, target)
  const choices = loginChoices(integrations)
  if (choices.length === 0) return yield* Effect.fail(new Error("No authentication integrations are available"))
  if (choices.length === 1) return yield* resolveIntegration(integrations, choices[0].value)
  yield* requireInteractive("Pass an integration ID or name when running without an interactive terminal")
  const id = yield* prompt<string>(() => selectIntegration(choices))
  return yield* resolveIntegration(integrations, id)
})

export function loginChoices(integrations: IntegrationInfo[]): IntegrationChoice[] {
  return integrations
    .filter((integration) => connectMethods(integration).length > 0)
    .toSorted(
      (a, b) =>
        Number(b.metadata?.source === "mcp") - Number(a.metadata?.source === "mcp") ||
        (integrationPriority.get(a.id) ?? integrationPriority.size) -
          (integrationPriority.get(b.id) ?? integrationPriority.size) ||
        a.name.localeCompare(b.name) ||
        a.id.localeCompare(b.id),
    )
    .map((integration) => ({
      value: integration.id,
      label: integration.name,
      category:
        integration.metadata?.source === "mcp"
          ? "MCP"
          : integrationPriority.has(integration.id)
            ? "Popular"
            : "Services",
      connected: integration.connections.length > 0,
    }))
}

const chooseMethod = Effect.fn("cli.auth.login.method")(function* (methods: ConnectMethod[], target?: string) {
  if (target) return yield* resolveMethod(methods, target)
  if (methods.length === 1) return methods[0]
  yield* requireInteractive("Pass --method when running without an interactive terminal")
  const id = yield* prompt<string>(() =>
    select({
      message: "Select login method",
      options: methods.map((method) => {
        if (method.type === "key") return { value: "key", label: method.label ?? "API key" }
        return { value: method.id, label: method.label }
      }),
    }),
  )
  return yield* resolveMethod(methods, id)
})

const authenticate = Effect.fn("cli.auth.login.authenticate")(function* (
  client: OpenCodeClient,
  integration: IntegrationInfo,
  method: ConnectMethod,
  answer?: FormAnswer,
  providedKey?: string,
) {
  if (method.type === "key") return yield* keyLogin(client, integration, method, answer, providedKey)
  if (method.type === "command") return yield* commandLogin(client, integration, method)
  if (method.type === "external") return yield* externalLogin(client, integration, method, answer)
  return yield* oauthLogin(client, integration, method, answer)
})

const externalLogin = Effect.fn("cli.auth.login.external")(function* (
  client: OpenCodeClient,
  integration: IntegrationInfo,
  method: Extract<ConnectMethod, { type: "external" }>,
  answer?: FormAnswer,
) {
  const progress = spinner()
  progress.start("Saving credential...")
  yield* request((signal) =>
    client.integration.connect.external(
      { integrationID: integration.id, methodID: method.id, answer, location },
      { signal },
    ),
  ).pipe(
    Effect.tap(() => Effect.sync(() => progress.stop(`Connected to ${integration.name}`))),
    Effect.tapCause(() => Effect.sync(() => progress.stop("Authentication failed", 1))),
  )
})

const keyLogin = Effect.fn("cli.auth.login.key")(function* (
  client: OpenCodeClient,
  integration: IntegrationInfo,
  method: Extract<ConnectMethod, { type: "key" }>,
  answer?: FormAnswer,
  providedKey?: string,
) {
  const key = providedKey?.trim() || (yield* secret(method.label ?? `Enter your ${integration.name} API key`))
  const progress = spinner()
  progress.start("Saving credential and fetching models...")
  yield* request((signal) =>
    client.integration.connect.key({ integrationID: integration.id, key, answer, location }, { signal }),
  ).pipe(Effect.tapCause(() => Effect.sync(() => progress.stop("Authentication failed", 1))))
  const discovered = yield* waitForModels(client, integration.id)
  progress.stop(
    discovered.length > 0
      ? `Connected to ${integration.name} (${discovered.length} models loaded)`
      : `Connected to ${integration.name}`,
  )
  if (discovered.length > 0) {
    const preview = discovered.slice(0, 10).join(", ")
    const suffix = discovered.length > 10 ? ` (+${discovered.length - 10} more)` : ""
    log.info(`Available models: ${preview}${suffix}`)
  }
})

const waitForModels: (client: OpenCodeClient, integrationID: string, remaining?: number) => Effect.Effect<string[], Error> =
  Effect.fn("cli.auth.login.waitForModels")(function* (client: OpenCodeClient, integrationID: string, remaining = 15) {
    const response = yield* request((signal) => client.model.list({ location }, { signal })).pipe(
      Effect.orElseSucceed(() => ({ data: [] })),
    )
    const matching = response.data.filter((item) => item.providerID === integrationID).map((item) => item.id)
    if (matching.length > 0 || remaining <= 1) return matching
    yield* Effect.sleep("200 millis")
    return yield* waitForModels(client, integrationID, remaining - 1)
  })

export const oauthLogin = Effect.fn("cli.auth.login.oauth")(function* (
  client: OpenCodeClient,
  integration: IntegrationInfo,
  method: Extract<ConnectMethod, { type: "oauth" }>,
  answer?: FormAnswer,
  label?: string,
) {
  const progress = spinner()
  progress.start("Starting authorization...")
  const started = yield* request((signal) =>
    client.integration.oauth.connect(
      { integrationID: integration.id, methodID: method.id, answer, label, location },
      { signal },
    ),
  ).pipe(Effect.tapCause(() => Effect.sync(() => progress.stop("Authentication failed", 1))))
  const attempt = started.data
  yield* Effect.addFinalizer(() =>
    request(() =>
      client.integration.oauth.cancel(
        { integrationID: integration.id, attemptID: attempt.attemptID, location },
        { signal: AbortSignal.timeout(5_000) },
      ),
    ).pipe(Effect.ignore),
  )
  progress.stop("Authorization started")
  log.info(attempt.instructions)
  log.info(attempt.url)
  if (process.stdin.isTTY && process.stdout.isTTY) yield* openUrl(attempt.url)

  if (attempt.mode === "code") {
    yield* requireInteractive("This login requires an interactive terminal to enter the authorization code")
    const code = yield* prompt<string>(() =>
      text({ message: "Paste the authorization code", validate: (value) => (!value ? "Required" : undefined) }),
    )
    const completing = spinner()
    completing.start("Completing authorization...")
    yield* request((signal) =>
      client.integration.oauth.complete(
        { integrationID: integration.id, attemptID: attempt.attemptID, code, location },
        { signal },
      ),
    ).pipe(
      Effect.tap(() => Effect.sync(() => completing.stop(`Connected to ${integration.name}`))),
      Effect.tapCause(() => Effect.sync(() => completing.stop("Authentication failed", 1))),
    )
    return
  }

  // Clack's spinner captures Ctrl+C and exits the process directly, which would skip the finalizer that
  // cancels the attempt. Waits that can last minutes use plain log lines so Ctrl+C interrupts normally.
  log.step("Waiting for authorization...")
  const wait = waitForOAuth(client, integration.id, attempt.attemptID)
  const status =
    attempt.paste && process.stdin.isTTY && process.stdout.isTTY
      ? yield* Effect.raceFirst(
          wait,
          pasteRedirect(client, integration.id, attempt.attemptID).pipe(Effect.andThen(Effect.never)),
        )
      : yield* wait
  if (status.status === "complete") {
    log.success(`Connected to ${integration.name}`)
    return
  }
  if (status.status === "failed") yield* Effect.fail(new Error(status.message))
  yield* Effect.fail(new Error("Authorization expired"))
})

const commandLogin = Effect.fn("cli.auth.login.command")(function* (
  client: OpenCodeClient,
  integration: IntegrationInfo,
  method: Extract<ConnectMethod, { type: "command" }>,
) {
  const progress = spinner()
  progress.start("Starting authentication command...")
  const started = yield* request((signal) =>
    client.integration.command.connect({ integrationID: integration.id, methodID: method.id, location }, { signal }),
  ).pipe(Effect.tapCause(() => Effect.sync(() => progress.stop("Authentication failed", 1))))
  yield* Effect.addFinalizer(() =>
    request(() =>
      client.integration.command.cancel(
        {
          integrationID: integration.id,
          attemptID: started.data.attemptID,
          location,
        },
        { signal: AbortSignal.timeout(5_000) },
      ),
    ).pipe(Effect.ignore),
  )
  progress.stop("Authentication command started")
  // The status message accumulates the command's stderr; print each completed line once.
  let printed = 0
  log.step("Waiting for authentication command...")
  const status = yield* waitForCommand(client, integration.id, started.data.attemptID, (message) => {
    const end = message.lastIndexOf("\n") + 1
    if (end <= printed) return
    const output = message.slice(printed, end).trim()
    printed = end
    if (output) log.message(output)
  })
  if (status.status === "complete") {
    log.success(`Connected to ${integration.name}`)
    return
  }
  if (status.status === "failed") yield* Effect.fail(new Error(status.message))
  yield* Effect.fail(new Error("Authentication expired"))
})

// Hands the redirect URL to the attempt, which still settles through its status; a rejected paste asks again.
const pasteRedirect = Effect.fn("cli.auth.login.oauth.paste")(function* (
  client: OpenCodeClient,
  integrationID: string,
  attemptID: string,
) {
  while (true) {
    const code = yield* prompt<string>((signal) =>
      text({
        message: "If the browser can't reach this machine, paste the URL it was redirected to",
        validate: (value) => (!value ? "Required" : undefined),
        signal,
      }),
    )
    const pasted = yield* request((signal) =>
      client.integration.oauth.complete({ integrationID, attemptID, code, location }, { signal }),
    ).pipe(
      Effect.as(true),
      Effect.catch((error) => Effect.sync(() => log.error(errorMessage(error))).pipe(Effect.as(false))),
    )
    if (pasted) return
  }
})

const waitForOAuth = Effect.fn("cli.auth.login.oauth.wait")(function* (
  client: OpenCodeClient,
  integrationID: string,
  attemptID: string,
) {
  while (true) {
    const response = yield* request((signal) =>
      client.integration.oauth.status({ integrationID, attemptID, location }, { signal }),
    )
    if (response.data.status !== "pending") return response.data
    yield* Effect.sleep(500)
  }
})

const waitForCommand = Effect.fn("cli.auth.login.command.wait")(function* (
  client: OpenCodeClient,
  integrationID: string,
  attemptID: string,
  update: (message: string) => void,
) {
  while (true) {
    const response = yield* request((signal) =>
      client.integration.command.status({ integrationID, attemptID, location }, { signal }),
    )
    if (response.data.status !== "pending") return response.data
    if (response.data.message) update(response.data.message)
    yield* Effect.sleep(500)
  }
})
