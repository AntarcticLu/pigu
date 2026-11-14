import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { parse } from "jsonc-parser"
import { isRecord } from "@opencode/util/record"
import { Option, Predicate, Schema } from "effect"

export const PIGU_PROTOCOLS = ["openai-chat", "gemini", "anthropic", "openai-responses"] as const
export type PiguProtocol = (typeof PIGU_PROTOCOLS)[number]

export const PIGU_MODALITIES = ["text", "image", "video", "audio"] as const
export type PiguModality = (typeof PIGU_MODALITIES)[number]

export const CANONICAL_PROVIDER_PRIORITY = [
  "openai",
  "anthropic",
  "google",
  "deepseek",
  "zai",
  "xai",
  "moonshotai",
  "alibaba",
  "minimax",
  "mistral",
  "openrouter",
] as const

export type PiguEndpointKind =
  | "anthropic-native"
  | "gemini-native"
  | "openai-chat-only"
  | "openai-official"
  | "multi-protocol"

export type ResolvedModelLimit = {
  readonly context: number
  readonly input?: number
  readonly output: number
}

export const PROTOCOL_OVERRIDES_FILE = "pigu-model-protocols.json"
export const MULTIMODAL_CONFIG_FILE = "pigu-multimodal.json"
export const PIGU_IMAGEGEN_SCRIPT_FILE = "pigu-imagegen.py"

export type MultimodalEndpointConfig = {
  readonly providerID: string
  readonly modelID: string
  readonly protocol: PiguProtocol
  readonly baseURL: string
  readonly apiKey?: string
}

export type MultimodalConfigFile = {
  readonly version: 1
  readonly overrides: Readonly<Record<string, PiguModality>>
  readonly userDefaults?: Partial<Readonly<Record<PiguModality, MultimodalEndpointConfig>>>
  readonly defaults: Partial<Readonly<Record<PiguModality, MultimodalEndpointConfig>>>
}

const MultimodalEndpointSchema = Schema.Struct({
  providerID: Schema.String,
  modelID: Schema.String,
  protocol: Schema.String,
  baseURL: Schema.String,
  apiKey: Schema.optional(Schema.String),
})

const MultimodalConfigFileSchema = Schema.Struct({
  version: Schema.optional(Schema.Number),
  overrides: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  userDefaults: Schema.optional(Schema.Record(Schema.String, MultimodalEndpointSchema)),
  defaults: Schema.optional(Schema.Record(Schema.String, MultimodalEndpointSchema)),
})

const decodeMultimodalConfig = Schema.decodeUnknownOption(Schema.fromJsonString(MultimodalConfigFileSchema))
const decodeStringMap = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)))

export function isPiguProtocolID(value: unknown): value is PiguProtocol {
  return value === "openai-chat" || value === "gemini" || value === "anthropic" || value === "openai-responses"
}

export function isPiguModality(value: unknown): value is PiguModality {
  return value === "text" || value === "image" || value === "video" || value === "audio"
}

function defaultBasePathForHost(host: string): string {
  if (host === "generativelanguage.googleapis.com") return "/v1beta"
  if (host.includes("dashscope") && host.endsWith("aliyuncs.com")) return "/compatible-mode/v1"
  if (host === "open.bigmodel.cn" || host === "api.z.ai") return "/api/paas/v4"
  if (host.endsWith("volces.com")) return "/api/v3"
  if (host === "openrouter.ai") return "/api/v1"
  if (host === "api.groq.com") return "/openai/v1"
  if (host === "qianfan.baidubce.com") return "/v2"
  return "/v1"
}

export function normalizeProviderBaseURL(input: unknown): string {
  if (!Predicate.isString(input)) return ""
  const trimmed = input.trim().replace(/\/+$/, "")
  if (!trimmed) return ""
  const isLocal = /^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?(\/|$)/i.test(trimmed)
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `${isLocal ? "http" : "https"}://${trimmed}`
  const stripped = withProtocol
    .replace(/\/chat\/completions$/i, "")
    .replace(/\/completions$/i, "")
    .replace(/\/messages$/i, "")
    .replace(/\/responses$/i, "")
    .replace(/\/models$/i, "")
    .replace(/\/+$/, "")
  if (!URL.canParse(stripped)) return stripped
  const parsed = new URL(stripped)
  const cleanPath = parsed.pathname.replace(/\/+$/, "")
  if (/\/anthropic$/i.test(cleanPath)) {
    parsed.pathname = `${cleanPath}/v1`
    return parsed.toString().replace(/\/+$/, "")
  }
  if (cleanPath === "") {
    parsed.pathname = defaultBasePathForHost(parsed.hostname.toLowerCase())
    return parsed.toString().replace(/\/+$/, "")
  }
  return stripped
}

export function detectEndpointKind(baseURL?: string): PiguEndpointKind {
  const normalized = normalizeProviderBaseURL(baseURL)
  if (!normalized || !URL.canParse(normalized)) return "multi-protocol"
  const parsed = new URL(normalized)
  const host = parsed.hostname.toLowerCase()
  const pathname = parsed.pathname.replace(/\/+$/, "")

  if (host === "api.anthropic.com" || /\/anthropic(\/v1)?$/i.test(pathname)) {
    return "anthropic-native"
  }
  if (host === "generativelanguage.googleapis.com") {
    return /\/openai(\/|$)/i.test(pathname) ? "openai-chat-only" : "gemini-native"
  }
  if (host === "api.openai.com") {
    return "openai-official"
  }
  if (
    host === "openrouter.ai" ||
    host.endsWith("siliconflow.cn") ||
    host.endsWith("siliconflow.com") ||
    (host.includes("dashscope") && host.endsWith("aliyuncs.com")) ||
    host === "open.bigmodel.cn" ||
    host === "api.z.ai" ||
    host.endsWith("volces.com") ||
    host === "api.deepseek.com" ||
    host.endsWith(".deepseek.com") ||
    host === "api.moonshot.cn" ||
    host === "api.moonshot.ai" ||
    host === "api.minimaxi.com" ||
    host === "api.minimax.io" ||
    host === "api.minimax.chat" ||
    host === "api.x.ai" ||
    host === "api.groq.com" ||
    host === "api.together.xyz" ||
    host === "api.together.ai" ||
    host === "api.fireworks.ai" ||
    host === "integrate.api.nvidia.com" ||
    host === "api.cerebras.ai" ||
    host === "api.mistral.ai" ||
    host === "qianfan.baidubce.com" ||
    host === "api.stepfun.com" ||
    host === "api.baichuan-ai.com" ||
    host === "api.lingyiwanwu.com" ||
    host === "models.inference.ai.azure.com" ||
    host === "models.github.ai"
  ) {
    return "openai-chat-only"
  }
  return "multi-protocol"
}

function isOpenAIResponsesModel(modelID: string): boolean {
  if (detectModelModality(modelID) !== "text") return false
  return /(^|\/)(gpt-([5-9]|\d{2,})|o[134](\b|-))/i.test(modelID) || /codex/i.test(modelID)
}

export function detectModelProtocol(modelID: string, baseURL?: string): PiguProtocol {
  const kind = detectEndpointKind(baseURL)
  if (kind === "anthropic-native") return "anthropic"
  if (kind === "gemini-native") return "gemini"
  if (kind === "openai-chat-only") return "openai-chat"
  if (kind === "openai-official") {
    return isOpenAIResponsesModel(modelID) ? "openai-responses" : "openai-chat"
  }
  if (modelID.includes("/") && !/^models\//i.test(modelID)) return "openai-chat"
  if (/gemini/i.test(modelID)) return "gemini"
  if (/claude/i.test(modelID)) return "anthropic"
  if (isOpenAIResponsesModel(modelID)) return "openai-responses"
  return "openai-chat"
}

export function isNonChatUtilityModel(modelID: string): boolean {
  return /(^|[-_/])(embedding|embeddings|embed|moderation|rerank|reranker|bge-|jina-embeddings|jina-reranker|text-embedding|omni-moderation|text-moderation|babbage-002|davinci-002|aqa)($|[-_/.0-9])/i.test(
    modelID.trim(),
  )
}

export function detectModelModality(modelID: string): PiguModality {
  if (/video|seedance|sora|veo|kling|wan[-_.]|hailuo|runway|luma|pika|cogvideo|hunyuan-video/i.test(modelID)) {
    return "video"
  }
  if (
    /gpt-image|grok-imagine-image|gemini-.*-image|imagen|dall-e|flux|midjourney|ideogram|recraft|stable-diffusion|sdxl|kolors|wanx/i.test(
      modelID,
    )
  ) {
    return "image"
  }
  if (/whisper|tts|audio|speech|transcribe|cosyvoice|fish-speech|elevenlabs|minimax-speech/i.test(modelID)) {
    return "audio"
  }
  return "text"
}

export function protocolBaseURL(baseURL: string, protocol: PiguProtocol): string {
  const normalized = normalizeProviderBaseURL(baseURL)
  if (!normalized) return ""
  if (protocol === "gemini") {
    return /\/v1$/i.test(normalized) && !/\/anthropic\/v1$/i.test(normalized)
      ? normalized.replace(/\/v1$/i, "/v1beta")
      : normalized
  }
  return /\/v1beta$/i.test(normalized) ? normalized.replace(/\/v1beta$/i, "/v1") : normalized
}

export function readModelProtocolOverridesSync(configDir: string): Record<string, PiguProtocol> {
  const filepath = path.join(configDir, PROTOCOL_OVERRIDES_FILE)
  if (!existsSync(filepath)) return {}
  const parsed = Option.getOrUndefined(decodeStringMap(readFileSync(filepath, "utf8")))
  if (!parsed) return {}
  return Object.fromEntries(
    Object.entries(parsed).filter((entry): entry is [string, PiguProtocol] => isPiguProtocolID(entry[1])),
  )
}

function parseEndpointMap(
  source: Readonly<Record<string, typeof MultimodalEndpointSchema.Type>> | undefined,
): Partial<Record<PiguModality, MultimodalEndpointConfig>> {
  const result: Partial<Record<PiguModality, MultimodalEndpointConfig>> = {}
  PIGU_MODALITIES.forEach((modality) => {
    const raw = source?.[modality]
    if (!raw || !raw.providerID.trim() || !raw.modelID.trim() || !raw.baseURL.trim()) return
    const protocol = isPiguProtocolID(raw.protocol) ? raw.protocol : detectModelProtocol(raw.modelID, raw.baseURL)
    result[modality] = {
      providerID: raw.providerID.trim(),
      modelID: raw.modelID.trim(),
      protocol,
      baseURL: protocolBaseURL(raw.baseURL, protocol),
      ...(raw.apiKey?.trim() ? { apiKey: raw.apiKey.trim() } : {}),
    }
  })
  return result
}

export function readMultimodalConfigSync(configDir: string): MultimodalConfigFile {
  const filepath = path.join(configDir, MULTIMODAL_CONFIG_FILE)
  if (!existsSync(filepath)) {
    return { version: 1, overrides: {}, userDefaults: {}, defaults: {} }
  }
  const parsed = Option.getOrUndefined(decodeMultimodalConfig(readFileSync(filepath, "utf8")))
  if (!parsed) {
    return { version: 1, overrides: {}, userDefaults: {}, defaults: {} }
  }
  const overrides = Object.fromEntries(
    Object.entries(parsed.overrides ?? {}).filter((entry): entry is [string, PiguModality] => isPiguModality(entry[1])),
  )
  const userDefaults = parseEndpointMap(parsed.userDefaults)
  const defaults = parseEndpointMap(parsed.defaults)
  return {
    version: 1,
    overrides,
    userDefaults,
    defaults,
  }
}

type ConfiguredProviderCandidate = {
  readonly providerID: string
  readonly baseURL: string
  readonly apiKey?: string
  readonly multimodalOnly: boolean
  readonly modelIDs: readonly string[]
}

export function rankModalityModel(modality: PiguModality, modelID: string): number {
  if (modality !== "image") return 0
  if (/^gpt-image-2$/i.test(modelID)) return 0
  if (/^gpt-image-2/i.test(modelID)) return 1
  if (/^gpt-image-/i.test(modelID)) return 2
  if (/gemini-.*-image/i.test(modelID)) return 3
  return 4
}

export function readConfiguredProviderCandidatesSync(configDir: string): readonly ConfiguredProviderCandidate[] {
  const candidates = [
    path.join(configDir, "opencode.json"),
    path.join(configDir, "opencode.jsonc"),
    path.join(configDir, "config.json"),
  ]
  const configPath = candidates.find((file) => existsSync(file))
  if (!configPath) return []
  const doc = parse(readFileSync(configPath, "utf8"))
  if (!isRecord(doc)) return []
  const rawProviders = isRecord(doc.provider) ? doc.provider : isRecord(doc.providers) ? doc.providers : undefined
  if (!rawProviders) return []
  return Object.entries(rawProviders)
    .flatMap(([providerID, value]): ConfiguredProviderCandidate[] => {
      if (!isRecord(value)) return []
      const opts = isRecord(value.options) ? value.options : isRecord(value.settings) ? value.settings : undefined
      const baseURL = normalizeProviderBaseURL(opts?.baseURL)
      if (!baseURL) return []
      const apiKey = Predicate.isString(opts?.apiKey) && opts.apiKey.trim() ? opts.apiKey.trim() : undefined
      const multimodalOnly = opts?.piguMultimodalOnly === true
      const modelIDs = isRecord(value.models) ? Object.keys(value.models) : []
      return [{ providerID, baseURL, apiKey, multimodalOnly, modelIDs }]
    })
    .toSorted((a, b) => {
      const aPigu = a.providerID === "pigutoken" || a.providerID === "pigu" ? 0 : 1
      const bPigu = b.providerID === "pigutoken" || b.providerID === "pigu" ? 0 : 1
      if (aPigu !== bPigu) return aPigu - bPigu
      return a.providerID.localeCompare(b.providerID)
    })
}

export function resolveMultimodalConfigSync(configDir: string): MultimodalConfigFile {
  const saved = readMultimodalConfigSync(configDir)
  const protocolOverrides = readModelProtocolOverridesSync(configDir)
  const providers = readConfiguredProviderCandidatesSync(configDir)
  const byProvider = new Map(providers.map((item) => [item.providerID, item]))

  const effectiveModality = (providerID: string, modelID: string): PiguModality =>
    saved.overrides[`${providerID}/${modelID}`] ?? detectModelModality(modelID)

  const effectiveProtocol = (providerID: string, modelID: string, baseURL?: string): PiguProtocol =>
    protocolOverrides[`${providerID}/${modelID}`] ?? detectModelProtocol(modelID, baseURL)

  const resolvedDefaults: Partial<Record<PiguModality, MultimodalEndpointConfig>> = {}

  const explicitMap = saved.userDefaults ?? {}

  PIGU_MODALITIES.forEach((modality) => {
    const explicit = explicitMap[modality]
    if (explicit) {
      const liveProvider = byProvider.get(explicit.providerID)
      if (liveProvider) {
        const protocol = effectiveProtocol(explicit.providerID, explicit.modelID, liveProvider.baseURL)
        resolvedDefaults[modality] = {
          providerID: explicit.providerID,
          modelID: explicit.modelID,
          protocol,
          baseURL: protocolBaseURL(liveProvider.baseURL, protocol),
          ...(liveProvider.apiKey ?? explicit.apiKey ? { apiKey: liveProvider.apiKey ?? explicit.apiKey } : {}),
        }
        return
      }
      resolvedDefaults[modality] = explicit
      return
    }

    const orderedProviders =
      modality === "text"
        ? providers.filter((item) => !item.multimodalOnly)
        : providers.toSorted((a, b) => Number(b.multimodalOnly) - Number(a.multimodalOnly))

    const found = orderedProviders
      .map((provider) => {
        const matchedModelID = provider.modelIDs
          .filter((id) => effectiveModality(provider.providerID, id) === modality)
          .toSorted((a, b) => rankModalityModel(modality, a) - rankModalityModel(modality, b))[0]
        return matchedModelID ? { provider, matchedModelID } : undefined
      })
      .find((entry) => entry !== undefined)

    if (!found) return
    const protocol = effectiveProtocol(found.provider.providerID, found.matchedModelID, found.provider.baseURL)
    resolvedDefaults[modality] = {
      providerID: found.provider.providerID,
      modelID: found.matchedModelID,
      protocol,
      baseURL: protocolBaseURL(found.provider.baseURL, protocol),
      ...(found.provider.apiKey ? { apiKey: found.provider.apiKey } : {}),
    }
  })

  return {
    version: 1,
    overrides: saved.overrides,
    userDefaults: explicitMap,
    defaults: resolvedDefaults,
  }
}

const PIGU_IMAGEGEN_WRAPPER_PY = `#!/usr/bin/env python3
"""Pigu multimodal imagegen runner.

Delegates gpt-image-* calls to Codex's bundled image_gen.py in memory (without
modifying it on disk) while normalizing relay providers that return data[].url
instead of data[].b64_json, and provides compatible generate/edit support for
other OpenAI-compatible and Gemini image models configured in Pigu.
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import importlib.util
from io import BytesIO
import json
import mimetypes
import os
from pathlib import Path
import sys
import urllib.error
import urllib.request


def _fetch_url_bytes(url: str, api_key: str | None) -> bytes:
    if url.startswith("data:"):
        _, _, payload = url.partition(",")
        return base64.b64decode(payload)
    headers = {"User-Agent": "Pigu/1.0"}
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            return resp.read()
    except urllib.error.HTTPError as err:
        if err.code in (401, 403) and api_key:
            auth_headers = {**headers, "Authorization": f"Bearer {api_key}"}
            req2 = urllib.request.Request(url, headers=auth_headers)
            with urllib.request.urlopen(req2, timeout=180) as resp2:
                return resp2.read()
        raise


def _transcode_if_needed(raw: bytes, output_format: str | None) -> bytes:
    if not output_format:
        return raw
    fmt = "jpeg" if output_format.lower() == "jpg" else output_format.lower()
    try:
        from PIL import Image
    except ImportError:
        return raw
    with Image.open(BytesIO(raw)) as img:
        current = (img.format or "").lower()
        if current == fmt:
            return raw
        converted = img.convert("RGB") if fmt == "jpeg" and img.mode in ("RGBA", "LA", "P") else img
        buf = BytesIO()
        converted.save(buf, format=fmt.upper())
        return buf.getvalue()


def _normalize_images_result(result: object, output_format: str | None, api_key: str | None) -> object:
    items = getattr(result, "data", None) or []
    for item in items:
        b64 = getattr(item, "b64_json", None)
        url = getattr(item, "url", None)
        if not b64 and url:
            raw = _fetch_url_bytes(url, api_key)
            raw = _transcode_if_needed(raw, output_format)
            item.b64_json = base64.b64encode(raw).decode("ascii")
    return result


def _detect_requested_model(argv: list[str], default_model: str) -> str:
    for idx, token in enumerate(argv):
        if token == "--model" and idx + 1 < len(argv):
            return argv[idx + 1]
        if token.startswith("--model="):
            return token.split("=", 1)[1]
    return default_model


def _ensure_model_flag(argv: list[str], model: str) -> list[str]:
    if not argv or argv[0] not in ("generate", "edit", "generate-batch"):
        return argv
    for token in argv[1:]:
        if token == "--model" or token.startswith("--model="):
            return argv
    return [argv[0], "--model", model, *argv[1:]]


def _run_codex_wrapper(codex_script: Path, default_model: str) -> int:
    sys.argv = [sys.argv[0], *_ensure_model_flag(sys.argv[1:], default_model)]
    spec = importlib.util.spec_from_file_location("codex_image_gen", str(codex_script))
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Unable to load {codex_script}")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)

    orig_sync = mod._create_client
    orig_async = mod._create_async_client
    api_key = os.getenv("OPENAI_API_KEY") or os.getenv("PIGU_IMAGE_API_KEY")

    def wrapped_sync():
        client = orig_sync()
        orig_gen = client.images.generate
        orig_edit = client.images.edit
        client.images.generate = lambda **kw: _normalize_images_result(
            orig_gen(**kw), kw.get("output_format"), api_key
        )
        client.images.edit = lambda **kw: _normalize_images_result(
            orig_edit(**kw), kw.get("output_format"), api_key
        )
        return client

    def wrapped_async():
        client = orig_async()
        orig_gen = client.images.generate

        async def async_gen(**kw):
            res = await orig_gen(**kw)
            return await asyncio.to_thread(_normalize_images_result, res, kw.get("output_format"), api_key)

        client.images.generate = async_gen
        return client

    mod._create_client = wrapped_sync
    mod._create_async_client = wrapped_async
    return mod.main()


def _build_outputs(out: str, out_dir: str | None, fmt: str, count: int) -> list[Path]:
    ext = "." + fmt
    if out_dir:
        base = Path(out_dir)
        base.mkdir(parents=True, exist_ok=True)
        return [base / f"image_{i}{ext}" for i in range(1, count + 1)]
    target = Path(out)
    if target.suffix == "":
        target = target.with_suffix(ext)
    if count == 1:
        return [target]
    return [target.with_name(f"{target.stem}-{i}{target.suffix}") for i in range(1, count + 1)]


def _run_gemini(mode: str, args: argparse.Namespace, prompt: str, fmt: str, outputs: list[Path]) -> None:
    base_url = (os.getenv("PIGU_IMAGE_BASE_URL") or os.getenv("GOOGLE_GEMINI_BASE_URL") or "").rstrip("/")
    api_key = os.getenv("PIGU_IMAGE_API_KEY") or os.getenv("GEMINI_API_KEY") or ""
    if not base_url or not api_key:
        raise SystemExit("Error: PIGU_IMAGE_BASE_URL / PIGU_IMAGE_API_KEY not configured for Gemini image model.")
    parts: list[dict] = []
    if mode == "edit":
        for img_str in args.image or []:
            p = Path(img_str)
            mime = mimetypes.guess_type(str(p))[0] or "image/png"
            parts.append({"inlineData": {"mimeType": mime, "data": base64.b64encode(p.read_bytes()).decode("ascii")}})
    parts.append({"text": prompt})
    body = json.dumps({
        "contents": [{"role": "user", "parts": parts}],
        "generationConfig": {"responseModalities": ["TEXT", "IMAGE"]},
    }).encode("utf-8")
    endpoint = f"{base_url}/models/{args.model}:generateContent"
    req = urllib.request.Request(
        endpoint,
        data=body,
        headers={
            "Content-Type": "application/json",
            "x-goog-api-key": api_key,
            "Authorization": f"Bearer {api_key}",
            "User-Agent": "Pigu/1.0",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=180) as resp:
        payload = json.loads(resp.read().decode("utf-8"))
    raw_images: list[bytes] = []
    for cand in payload.get("candidates") or []:
        for part in (cand.get("content") or {}).get("parts") or []:
            inline = part.get("inlineData") or part.get("inline_data")
            if inline and inline.get("data"):
                raw_images.append(base64.b64decode(inline["data"]))
    if not raw_images:
        raise SystemExit(f"Error: Gemini model {args.model} returned no image data.")
    for idx, raw in enumerate(raw_images[: len(outputs)]):
        out_path = outputs[idx]
        if out_path.exists() and not args.force:
            raise SystemExit(f"Error: Output already exists: {out_path} (use --force to overwrite)")
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_bytes(_transcode_if_needed(raw, fmt))
        print(f"Wrote {out_path}")


def _run_generic() -> int:
    default_model = os.getenv("PIGU_IMAGE_MODEL") or os.getenv("OPENAI_IMAGE_MODEL") or "gpt-image-2"
    parser = argparse.ArgumentParser(description="Pigu Multimodal Image CLI")
    sub = parser.add_subparsers(dest="cmd", required=True)
    for name in ("generate", "edit"):
        sp = sub.add_parser(name)
        sp.add_argument("--model", default=default_model)
        sp.add_argument("--prompt")
        sp.add_argument("--prompt-file")
        sp.add_argument("--n", type=int, default=1)
        sp.add_argument("--size", default="auto")
        sp.add_argument("--quality", default="auto")
        sp.add_argument("--background")
        sp.add_argument("--output-format", default="png")
        sp.add_argument("--output-compression", type=int)
        sp.add_argument("--input-fidelity")
        sp.add_argument("--moderation")
        sp.add_argument("--out", default="output/imagegen/output.png")
        sp.add_argument("--out-dir")
        sp.add_argument("--force", action="store_true")
        sp.add_argument("--dry-run", action="store_true")
        sp.add_argument("--augment", dest="augment", action="store_true", default=True)
        sp.add_argument("--no-augment", dest="augment", action="store_false")
        for extra in (
            "use-case", "scene", "subject", "style", "composition",
            "lighting", "palette", "materials", "text", "constraints", "negative",
            "downscale-max-dim", "downscale-suffix",
        ):
            sp.add_argument(f"--{extra}")
        if name == "edit":
            sp.add_argument("--image", action="append", required=True)
            sp.add_argument("--mask")

    args, _ = parser.parse_known_args()
    prompt = Path(args.prompt_file).read_text("utf-8").strip() if args.prompt_file else (args.prompt or "").strip()
    if not prompt:
        raise SystemExit("Error: Missing --prompt or --prompt-file.")
    fmt = "jpeg" if (args.output_format or "png").lower() == "jpg" else (args.output_format or "png").lower()
    outputs = _build_outputs(args.out, args.out_dir, fmt, args.n)
    if args.dry_run:
        print(json.dumps({"mode": args.cmd, "model": args.model, "outputs": [str(p) for p in outputs], "prompt": prompt}, indent=2))
        return 0

    protocol = os.getenv("PIGU_IMAGE_PROTOCOL") or ("gemini" if args.model.lower().startswith("gemini-") else "openai-chat")
    if protocol == "gemini":
        _run_gemini(args.cmd, args, prompt, fmt, outputs)
        return 0

    from openai import OpenAI
    api_key = os.getenv("PIGU_IMAGE_API_KEY") or os.getenv("OPENAI_API_KEY")
    base_url = os.getenv("PIGU_IMAGE_BASE_URL") or os.getenv("OPENAI_BASE_URL")
    client = OpenAI(api_key=api_key, base_url=base_url)
    req_kwargs: dict = {"model": args.model, "prompt": prompt, "n": args.n}
    if args.size and args.size != "auto":
        req_kwargs["size"] = args.size
    if args.cmd == "edit":
        handles = [Path(p).open("rb") for p in (args.image or [])]
        try:
            req_kwargs["image"] = handles if len(handles) > 1 else handles[0]
            if getattr(args, "mask", None):
                with Path(args.mask).open("rb") as mfh:
                    req_kwargs["mask"] = mfh
                    res = client.images.edit(**req_kwargs)
            else:
                res = client.images.edit(**req_kwargs)
        finally:
            for h in handles:
                h.close()
    else:
        res = client.images.generate(**req_kwargs)

    _normalize_images_result(res, fmt, api_key)
    for idx, item in enumerate((res.data or [])[: len(outputs)]):
        out_path = outputs[idx]
        if out_path.exists() and not args.force:
            raise SystemExit(f"Error: Output already exists: {out_path} (use --force to overwrite)")
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_bytes(base64.b64decode(item.b64_json))
        print(f"Wrote {out_path}")
    return 0


def main() -> int:
    default_model = os.getenv("PIGU_IMAGE_MODEL") or os.getenv("OPENAI_IMAGE_MODEL") or "gpt-image-2"
    model = _detect_requested_model(sys.argv[1:], default_model)
    codex_default = Path.home() / ".codex" / "skills" / ".system" / "imagegen" / "scripts" / "image_gen.py"
    codex_script = Path(os.getenv("PIGU_CODEX_IMAGEGEN_SCRIPT") or str(codex_default))
    if model.lower().startswith("gpt-image-") and codex_script.is_file():
        return _run_codex_wrapper(codex_script, default_model)
    return _run_generic()


if __name__ == "__main__":
    raise SystemExit(main())
`

export function ensureImagegenWrapperSync(configDir: string): string {
  const scriptPath = path.join(configDir, PIGU_IMAGEGEN_SCRIPT_FILE)
  mkdirSync(configDir, { recursive: true })
  const current = existsSync(scriptPath) ? readFileSync(scriptPath, "utf8") : ""
  if (current !== PIGU_IMAGEGEN_WRAPPER_PY) {
    writeFileSync(scriptPath, PIGU_IMAGEGEN_WRAPPER_PY, { encoding: "utf8", mode: 0o755 })
  }
  return scriptPath
}

export function writeResolvedMultimodalConfigSync(
  configDir: string,
  next?: {
    readonly overrides?: Readonly<Record<string, PiguModality>>
    readonly userDefaults?: Partial<Readonly<Record<PiguModality, MultimodalEndpointConfig>>>
  },
) {
  const current = readMultimodalConfigSync(configDir)
  const seed: MultimodalConfigFile = {
    version: 1,
    overrides: next?.overrides ?? current.overrides,
    userDefaults: next?.userDefaults ?? current.userDefaults ?? {},
    defaults: current.defaults,
  }
  const filepath = path.join(configDir, MULTIMODAL_CONFIG_FILE)
  mkdirSync(configDir, { recursive: true })
  writeFileSync(filepath, `${JSON.stringify(seed, null, 2)}\n`, "utf8")
  const resolved = resolveMultimodalConfigSync(configDir)
  writeFileSync(filepath, `${JSON.stringify(resolved, null, 2)}\n`, "utf8")
  ensureImagegenWrapperSync(configDir)
  return resolved
}

export function resolveDefaultConfigDir(home = process.env.OPENCODE_TEST_HOME || os.homedir()): string {
  const xdgConfig = process.env.XDG_CONFIG_HOME?.trim()
  if (xdgConfig) return path.join(xdgConfig, "opencode")
  return path.join(home, ".config", "opencode")
}

export function buildMultimodalProcessEnv(configDir: string): Record<string, string> {
  const resolved = resolveMultimodalConfigSync(configDir)
  const configPath = path.join(configDir, MULTIMODAL_CONFIG_FILE)
  const env: Record<string, string> = {}
  const entries = Object.entries(resolved.defaults) as [PiguModality, MultimodalEndpointConfig | undefined][]
  const active = entries.filter((entry): entry is [PiguModality, MultimodalEndpointConfig] => Boolean(entry[1]))
  if (active.length === 0 && !existsSync(configPath)) return env

  env.PIGU_MULTIMODAL_CONFIG = configPath
  active.forEach(([modality, endpoint]) => {
    const prefix = `PIGU_${modality.toUpperCase()}`
    env[`${prefix}_PROVIDER`] = endpoint.providerID
    env[`${prefix}_MODEL`] = endpoint.modelID
    env[`${prefix}_PROTOCOL`] = endpoint.protocol
    env[`${prefix}_BASE_URL`] = endpoint.baseURL
    if (endpoint.apiKey) {
      env[`${prefix}_API_KEY`] = endpoint.apiKey
    }
  })
  return env
}

export function buildMultimodalToolEnv(configDir: string): Record<string, string> {
  const env = buildMultimodalProcessEnv(configDir)
  const resolved = resolveMultimodalConfigSync(configDir)
  const image = resolved.defaults.image
  if (!image) return env

  env.PIGU_IMAGEGEN_SCRIPT = ensureImagegenWrapperSync(configDir)

  if (image.protocol === "openai-chat" || image.protocol === "openai-responses") {
    env.OPENAI_IMAGE_MODEL = image.modelID
    env.OPENAI_BASE_URL = image.baseURL
    if (image.apiKey) {
      env.OPENAI_API_KEY = image.apiKey
    }
  }

  if (image.protocol === "gemini") {
    env.GEMINI_IMAGE_MODEL = image.modelID
    env.GOOGLE_GEMINI_BASE_URL = image.baseURL
    if (image.apiKey) {
      env.GEMINI_API_KEY = image.apiKey
    }
  }

  return env
}

export const IMAGEGEN_BRIDGE_MARKER = "<!-- pigu-multimodal-imagegen-bridge -->"

export function buildImagegenSkillBridge(configDir: string, skillPath?: string): string | undefined {
  const resolved = resolveMultimodalConfigSync(configDir)
  const image = resolved.defaults.image
  if (!image) return undefined

  const baseDir =
    skillPath && !skillPath.startsWith("skill://")
      ? path.dirname(skillPath)
      : path.join(os.homedir(), ".codex", "skills", ".system", "imagegen")
  const codexScriptPath = path.join(baseDir, "scripts", "image_gen.py")
  const wrapperPath = ensureImagegenWrapperSync(configDir)

  return [
    IMAGEGEN_BRIDGE_MARKER,
    "## Pigu Multimodal Routing (Auto-Linked)",
    "",
    `Pigu Extensions -> Advanced (Multimodal) has already linked this skill to \`${image.providerID}/${image.modelID}\` (\`${image.baseURL}\`).`,
    "- In Pigu sessions where a built-in `image_gen` tool is not registered, proceed directly with CLI execution without asking the user for `OPENAI_API_KEY` or CLI fallback confirmation.",
    "- `PIGU_IMAGEGEN_SCRIPT`, `PIGU_IMAGE_MODEL`, `PIGU_IMAGE_BASE_URL`, `PIGU_IMAGE_API_KEY`, `OPENAI_API_KEY`, and `OPENAI_BASE_URL` are already pre-injected into your shell environment.",
    `- Run Pigu's non-destructive wrapper \`"${wrapperPath}"\` (which delegates \`gpt-image-*\` calls to \`"${codexScriptPath}"\` in memory without modifying it on disk, transparently downloads relay \`data[].url\` responses when \`b64_json\` is null, and also supports Gemini / other OpenAI-compatible image models):`,
    `  - Text-to-image (\`generate\`): \`uv run --with openai --with pillow python3 "${wrapperPath}" generate --model "$PIGU_IMAGE_MODEL" --prompt "..." --out "<output.png>"\``,
    `  - Image editing (\`edit\`): \`uv run --with openai --with pillow python3 "${wrapperPath}" edit --model "$PIGU_IMAGE_MODEL" --image "<input.png>" --prompt "..." --out "<output.png>"\``,
  ].join("\n")
}

export interface AudioTranscribeInput {
  readonly data: Uint8Array
  readonly mimeType: string
  readonly fileName?: string
  readonly prompt?: string
}

const GeminiTranscribeResponseSchema = Schema.Struct({
  candidates: Schema.optional(
    Schema.Array(
      Schema.Struct({
        content: Schema.optional(
          Schema.Struct({
            parts: Schema.optional(
              Schema.Array(
                Schema.Struct({
                  text: Schema.optional(Schema.String),
                  thought: Schema.optional(Schema.Boolean),
                }),
              ),
            ),
          }),
        ),
      }),
    ),
  ),
})
const decodeGeminiTranscribeResponse = Schema.decodeUnknownOption(
  Schema.fromJsonString(GeminiTranscribeResponseSchema),
)

const OpenAITranscribeResponseSchema = Schema.Struct({
  text: Schema.optional(Schema.String),
})
const decodeOpenAITranscribeResponse = Schema.decodeUnknownOption(
  Schema.fromJsonString(OpenAITranscribeResponseSchema),
)

function rankGeminiAudioCandidate(modelID: string): number {
  if (/^gemini-3-flash$/i.test(modelID)) return 0
  if (/^gemini-3\.5-flash$/i.test(modelID)) return 1
  if (/^gemini-2\.5-flash$/i.test(modelID)) return 2
  if (/^gemini-2\.0-flash$/i.test(modelID)) return 3
  if (/gemini-.*flash/i.test(modelID) && !/lite|thinking|tiered/i.test(modelID)) return 4
  if (/gemini-.*flash/i.test(modelID)) return 5
  return 6
}

function collectAudioEndpoints(configDir: string): readonly MultimodalEndpointConfig[] {
  const resolved = resolveMultimodalConfigSync(configDir)
  const protocolOverrides = readModelProtocolOverridesSync(configDir)
  const providers = readConfiguredProviderCandidatesSync(configDir)
  const list: MultimodalEndpointConfig[] = []
  const seen = new Set<string>()

  const push = (ep: MultimodalEndpointConfig | undefined) => {
    if (!ep || !ep.baseURL || !ep.modelID) return
    const key = `${ep.protocol}:${ep.baseURL}:${ep.modelID}`
    if (seen.has(key)) return
    seen.add(key)
    list.push(ep)
  }

  push(resolved.defaults.audio)

  providers.forEach((provider) => {
    const geminiModels = provider.modelIDs
      .filter((id) => {
        const protocol =
          protocolOverrides[`${provider.providerID}/${id}`] ?? detectModelProtocol(id, provider.baseURL)
        const modality = resolved.overrides[`${provider.providerID}/${id}`] ?? detectModelModality(id)
        return protocol === "gemini" && modality === "text"
      })
      .toSorted((a, b) => rankGeminiAudioCandidate(a) - rankGeminiAudioCandidate(b))

    geminiModels.slice(0, 3).forEach((modelID) => {
      push({
        providerID: provider.providerID,
        modelID,
        protocol: "gemini",
        baseURL: protocolBaseURL(provider.baseURL, "gemini"),
        ...(provider.apiKey ? { apiKey: provider.apiKey } : {}),
      })
    })

    provider.modelIDs
      .filter((id) => /whisper|transcribe|sensevoice|paraformer|asr/i.test(id))
      .slice(0, 2)
      .forEach((modelID) => {
        push({
          providerID: provider.providerID,
          modelID,
          protocol: "openai-chat",
          baseURL: protocolBaseURL(provider.baseURL, "openai-chat"),
          ...(provider.apiKey ? { apiKey: provider.apiKey } : {}),
        })
      })
  })

  const envGeminiKey = process.env.GEMINI_API_KEY?.trim() || process.env.GOOGLE_GENERATIVE_AI_API_KEY?.trim()
  if (envGeminiKey) {
    push({
      providerID: "google",
      modelID: "gemini-2.5-flash",
      protocol: "gemini",
      baseURL: protocolBaseURL(
        process.env.GOOGLE_GEMINI_BASE_URL || "https://generativelanguage.googleapis.com/v1beta",
        "gemini",
      ),
      apiKey: envGeminiKey,
    })
  }

  const envOpenAIKey = process.env.OPENAI_API_KEY?.trim()
  if (envOpenAIKey) {
    push({
      providerID: "openai",
      modelID: "gpt-4o-mini-transcribe",
      protocol: "openai-chat",
      baseURL: protocolBaseURL(process.env.OPENAI_BASE_URL || "https://api.openai.com/v1", "openai-chat"),
      apiKey: envOpenAIKey,
    })
  }

  return list
}

async function transcribeViaGemini(endpoint: MultimodalEndpointConfig, input: AudioTranscribeInput): Promise<string> {
  const instruction =
    input.prompt?.trim() ||
    "请准确逐字转写这段语音的内容，保留原始语言与自然标点，中文汉字之间不要插入多余空格，只输出转写后的纯文本，不要添加任何解释、前缀或引号。如果语音完全空白或无法听清，请只输出空字符串。"
  const url = `${endpoint.baseURL.replace(/\/+$/, "")}/models/${encodeURIComponent(endpoint.modelID)}:generateContent`
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "Pigu/1.0",
  }
  if (endpoint.apiKey) {
    headers["x-goog-api-key"] = endpoint.apiKey
    headers.Authorization = `Bearer ${endpoint.apiKey}`
  }
  const resp = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [
            {
              inlineData: {
                mimeType: input.mimeType || "audio/wav",
                data: Buffer.from(input.data).toString("base64"),
              },
            },
            { text: instruction },
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(45_000),
  })
  const rawBody = await resp.text()
  if (!resp.ok) {
    throw new Error(`Gemini audio HTTP ${resp.status}: ${rawBody.slice(0, 180)}`)
  }
  const parsed = Option.getOrUndefined(decodeGeminiTranscribeResponse(rawBody))
  const text = (parsed?.candidates ?? [])
    .flatMap((cand) => cand.content?.parts ?? [])
    .filter((part) => !part.thought && Predicate.isString(part.text))
    .map((part) => part.text!.trim())
    .filter(Boolean)
    .join("\n")
    .replace(/([\u4e00-\u9fff])\s+(?=[\u4e00-\u9fff，。！？、；：])/g, "$1")
    .replace(/([，。！？、；：])\s+(?=[\u4e00-\u9fff])/g, "$1")
    .trim()
  return text
}

async function transcribeViaOpenAIWhisper(
  endpoint: MultimodalEndpointConfig,
  input: AudioTranscribeInput,
): Promise<string> {
  const url = `${endpoint.baseURL.replace(/\/+$/, "")}/audio/transcriptions`
  const ext = (input.mimeType.split("/")[1] || "wav").replace(/^x-/, "").split(";")[0] || "wav"
  const fileName = input.fileName?.trim() || `voice.${ext === "mpeg" ? "mp3" : ext}`
  const form = new FormData()
  form.append("file", new Blob([Buffer.from(input.data)], { type: input.mimeType || "audio/wav" }), fileName)
  form.append("model", endpoint.modelID)
  if (input.prompt?.trim()) {
    form.append("prompt", input.prompt.trim())
  }
  const headers: Record<string, string> = {
    "User-Agent": "Pigu/1.0",
  }
  if (endpoint.apiKey) {
    headers.Authorization = `Bearer ${endpoint.apiKey}`
  }
  const resp = await fetch(url, {
    method: "POST",
    headers,
    body: form,
    signal: AbortSignal.timeout(45_000),
  })
  const rawBody = await resp.text()
  if (!resp.ok) {
    throw new Error(`Whisper HTTP ${resp.status}: ${rawBody.slice(0, 180)}`)
  }
  const parsed = Option.getOrUndefined(decodeOpenAITranscribeResponse(rawBody))
  return (parsed?.text ?? rawBody).trim()
}

export async function transcribeAudioWithMultimodal(
  configDir: string,
  input: AudioTranscribeInput,
): Promise<string> {
  const candidates = collectAudioEndpoints(configDir).slice(0, 5)
  if (candidates.length === 0) {
    throw new Error("未找到可用的语音识别模型，请先连接支持 Gemini 或 Whisper 的模型提供商。")
  }
  const errors: string[] = []
  for (const candidate of candidates) {
    const isGemini = candidate.protocol === "gemini" || /gemini/i.test(candidate.modelID)
    const result = await (isGemini
      ? transcribeViaGemini(candidate, input)
      : transcribeViaOpenAIWhisper(candidate, input)
    ).then(
      (text) => ({ ok: true as const, text }),
      (err: unknown) => ({ ok: false as const, message: err instanceof Error ? err.message : String(err) }),
    )
    if (result.ok) {
      return result.text
    }
    errors.push(`${candidate.providerID}/${candidate.modelID}: ${result.message}`)
  }
  throw new Error(`语音识别失败：${errors[0] ?? "未知错误"}`)
}

export async function describeMediaWithMultimodal(
  configDir: string,
  input: {
    readonly data: Uint8Array
    readonly mimeType: string
    readonly fileName?: string
    readonly prompt?: string
  },
): Promise<string> {
  const geminiCandidates = collectAudioEndpoints(configDir)
    .filter((ep) => ep.protocol === "gemini" || /gemini/i.test(ep.modelID))
    .slice(0, 3)
  if (geminiCandidates.length === 0) return ""
  const instruction =
    input.prompt?.trim() ||
    "请仔细读取并提取这张图片或文档中的所有关键信息：完整抄录画面中出现的报错文本、代码片段、终端输出、界面文字或表格数据，并简要说明界面/画面结构，以便纯文本编程助手准确理解和排查问题。"
  for (const candidate of geminiCandidates) {
    const text = await transcribeViaGemini(candidate, {
      data: input.data,
      mimeType: input.mimeType,
      fileName: input.fileName,
      prompt: instruction,
    }).catch(() => "")
    if (text.trim()) return text.trim()
  }
  return ""
}

export function buildCatalogLimitMap(
  records: readonly {
    provider: { id: string; activation: string }
    models: ReadonlyMap<string, { readonly id: string; readonly modelID?: string; readonly limit: ResolvedModelLimit }>
  }[],
): ReadonlyMap<string, ResolvedModelLimit> {
  const map = new Map<string, ResolvedModelLimit>()
  const rank = (id: string) => {
    const idx = CANONICAL_PROVIDER_PRIORITY.indexOf(id as (typeof CANONICAL_PROVIDER_PRIORITY)[number])
    return idx === -1 ? CANONICAL_PROVIDER_PRIORITY.length : idx
  }
  const ordered = records
    .filter((record) => record.provider.activation === "auto")
    .toSorted((a, b) => rank(a.provider.id) - rank(b.provider.id))
  ordered.forEach((record) => {
    Array.from(record.models.values()).forEach((model) => {
      if (model.limit.context <= 0) return
      const entry: ResolvedModelLimit = {
        context: model.limit.context,
        ...(model.limit.input !== undefined && model.limit.input > 0 ? { input: model.limit.input } : {}),
        output: model.limit.output > 0 ? model.limit.output : 32_000,
      }
      const primaryKey = model.id.toLowerCase()
      if (!map.has(primaryKey)) map.set(primaryKey, entry)
      const secondaryKey = model.modelID?.toLowerCase()
      if (secondaryKey && !map.has(secondaryKey)) map.set(secondaryKey, entry)
    })
  })
  return map
}

export function resolveModelLimit(
  rawModelID: string,
  options?: {
    readonly catalogLimits?: ReadonlyMap<string, ResolvedModelLimit>
    readonly baseURL?: string
    readonly explicitContext?: number
    readonly explicitOutput?: number
  },
): ResolvedModelLimit {
  if (options?.explicitContext !== undefined && options.explicitContext > 0) {
    const output =
      options.explicitOutput !== undefined && options.explicitOutput > 0
        ? options.explicitOutput
        : Math.min(32_000, options.explicitContext)
    return { context: options.explicitContext, output }
  }

  const normalized = rawModelID.trim().toLowerCase().replace(/^models\//, "")
  const shortID = normalized.includes("/") ? normalized.slice(normalized.lastIndexOf("/") + 1) : normalized
  if (!shortID) return { context: 200_000, output: 32_000 }

  const dateStripped = shortID.replace(/-\d{4,8}$/, "")
  const tierStripped = dateStripped.replace(/-(none|minimal|low|medium|high|xhigh|max|tiered)$/i, "")
  const fromCatalog = lookupCatalogLimit(
    [shortID, normalized, dateStripped, tierStripped, `${shortID}-preview`, `${dateStripped}-preview`],
    options?.catalogLimits,
  )
  const base = fromCatalog ?? inferFamilyLimit(tierStripped)
  const withExplicitOutput =
    options?.explicitOutput !== undefined && options.explicitOutput > 0
      ? { ...base, output: options.explicitOutput }
      : base
  return applyCodexRelayCap(withExplicitOutput, tierStripped, options?.baseURL)
}

function lookupCatalogLimit(
  keys: readonly string[],
  catalogLimits: ReadonlyMap<string, ResolvedModelLimit> | undefined,
): ResolvedModelLimit | undefined {
  if (!catalogLimits) return undefined
  const matchedKey = keys.find((key) => catalogLimits.has(key))
  return matchedKey ? catalogLimits.get(matchedKey) : undefined
}

function inferFamilyLimit(shortID: string): ResolvedModelLimit {
  const isText = detectModelModality(shortID) === "text"
  if (isText && (/^gpt-([6-9]|\d{2,})\b/i.test(shortID) || /^gpt-5\.[4-9]/i.test(shortID))) {
    return { context: 1_050_000, input: 922_000, output: 128_000 }
  }
  if (isText && (/^gpt-5\b/i.test(shortID) || /codex/i.test(shortID))) {
    return { context: 400_000, input: 272_000, output: 128_000 }
  }
  if (isText && /^gpt-4\.1/i.test(shortID)) return { context: 1_047_576, output: 32_768 }
  if (isText && /^gpt-4o/i.test(shortID)) return { context: 128_000, output: 16_384 }
  if (/^(o1|o3|o4)\b/i.test(shortID)) return { context: 200_000, output: 100_000 }

  if (/claude/i.test(shortID)) {
    if (/(opus|sonnet|haiku|fable|mythos)-(4[.-][6-9]|[5-9](\b|[.-]))/i.test(shortID)) {
      return { context: 1_000_000, output: 128_000 }
    }
    return { context: 200_000, output: 64_000 }
  }

  if (isText && /gemini-(2\.5|[3-9])/i.test(shortID)) return { context: 1_048_576, output: 65_536 }
  if (/gemini/i.test(shortID)) return { context: 131_072, output: 32_768 }

  if (/deepseek-v[4-9]/i.test(shortID)) return { context: 1_048_576, output: 393_216 }
  if (/deepseek/i.test(shortID)) return { context: 128_000, output: 32_768 }

  if (/glm-(5\.[3-9]|[6-9])/i.test(shortID)) return { context: 1_000_000, output: 131_072 }
  if (/glm-(5|4\.[5-9])/i.test(shortID)) return { context: 200_000, output: 131_072 }

  if (/kimi-k[3-9]/i.test(shortID)) return { context: 1_048_576, output: 131_072 }
  if (/kimi-k2/i.test(shortID)) return { context: 262_144, output: 131_072 }

  if (isText && /grok-(4\.[5-9]|[5-9])/i.test(shortID)) return { context: 500_000, output: 128_000 }
  if (isText && /grok-4/i.test(shortID)) return { context: 256_000, output: 64_000 }

  if (/qwen3-coder|qwen3\.[5-9]|qwen-long/i.test(shortID)) return { context: 1_000_000, output: 65_536 }
  if (/qwen3|qwen-max|qwen-plus|qwq/i.test(shortID)) return { context: 131_072, output: 32_768 }
  if (/minimax/i.test(shortID)) return { context: 204_800, output: 65_536 }
  if (/mistral|codestral|devstral|pixtral/i.test(shortID)) return { context: 256_000, output: 32_768 }
  if (/doubao/i.test(shortID)) return { context: 256_000, output: 32_768 }

  return { context: 200_000, output: 32_000 }
}

function isOfficialOpenAIBaseURL(baseURL: string | undefined): boolean {
  if (!baseURL || !URL.canParse(baseURL)) return false
  return new URL(baseURL).hostname.toLowerCase() === "api.openai.com"
}

function codexRelayInputCap(shortID: string): number {
  const match = shortID.match(/^gpt-(\d+)(?:\.(\d+))?/i)
  if (!match) return 272_000
  const major = Number(match[1])
  const minor = Number(match[2] ?? 0)
  return major > 6 || (major === 6 && minor >= 1) ? 500_000 : 272_000
}

function applyCodexRelayCap(
  base: ResolvedModelLimit,
  shortID: string,
  baseURL: string | undefined,
): ResolvedModelLimit {
  if (isOfficialOpenAIBaseURL(baseURL)) return base
  if (detectModelModality(shortID) !== "text") return base
  if (!/^gpt-([5-9]|\d{2,})(?:\.(\d+))?/i.test(shortID) && !/codex/i.test(shortID)) return base
  const cap = codexRelayInputCap(shortID)
  if ((base.input ?? base.context) <= cap) return base
  return {
    context: cap + base.output,
    input: cap,
    output: base.output,
  }
}
