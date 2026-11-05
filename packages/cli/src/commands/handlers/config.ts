import { Effect, Option } from "effect"
import { Commands } from "../commands"
import { Runtime } from "../../framework/runtime"
import { handlePromptErrors } from "../../ui/prompt"
import { login } from "./auth/login"

export default Runtime.handler(
  Commands.commands.config,
  Effect.fn("cli.config")((input) =>
    login({
      target: "pigu",
      url: Option.getOrUndefined(input.url),
      key: Option.getOrUndefined(input.key),
    }).pipe(handlePromptErrors),
  ),
)
