import { Show, createSignal, onCleanup } from "solid-js"
import { Button } from "@opencode/ui/button"
import { Icon } from "@opencode/ui/icon"
import { Loader } from "@opencode/ui/loader"
import { Tooltip } from "@opencode/ui/tooltip"
import { useLanguage } from "@/runtime/i18n/language"
import { useServerSDK } from "@/runtime/server/client"
import { formatServerError } from "@/runtime/server/errors"
import { showToast } from "@/shell/notifications/toast"
import type { ComposerModel } from "./model"

type VoiceState = "idle" | "recording" | "transcribing"

type ActiveRecording = {
  readonly stream: MediaStream
  readonly audioCtx: AudioContext
  readonly source: MediaStreamAudioSourceNode
  readonly processor: ScriptProcessorNode
  readonly gain: GainNode
  readonly chunks: Float32Array[]
  readonly timer: ReturnType<typeof setInterval>
  readonly removeKeyListener: () => void
}

export function ComposerVoiceControl(props: { model: ComposerModel }) {
  const language = useLanguage()
  const serverSDK = useServerSDK()
  const [state, setState] = createSignal<VoiceState>("idle")
  const [seconds, setSeconds] = createSignal(0)

  let active: ActiveRecording | undefined

  const supportsNativeAudio = () => Boolean(props.model.model.selection.current()?.capabilities.input.audio)

  const releaseRecording = (session: ActiveRecording) => {
    clearInterval(session.timer)
    session.removeKeyListener()
    session.processor.onaudioprocess = null
    session.source.disconnect()
    session.processor.disconnect()
    session.gain.disconnect()
    session.stream.getTracks().forEach((track) => track.stop())
    void session.audioCtx.close().catch(() => undefined)
  }

  const cancelRecording = () => {
    const session = active
    if (!session) return
    active = undefined
    releaseRecording(session)
    setSeconds(0)
    setState("idle")
    props.model.restoreFocus()
  }

  const finishRecording = () => {
    const session = active
    if (!session) return
    active = undefined
    const sampleRate = session.audioCtx.sampleRate
    const chunks = session.chunks
    releaseRecording(session)
    setSeconds(0)

    const wavBytes = encodeMonoWav16k(chunks, sampleRate)
    if (!wavBytes) {
      setState("idle")
      showToast({
        title: language.tr("录音时间过短", "Recording too short"),
        description: language.tr("请说话后再点击结束录音", "Please speak before stopping"),
      })
      return
    }

    const fileName = `voice-${Date.now()}.wav`

    if (supportsNativeAudio()) {
      const buffer = new ArrayBuffer(wavBytes.byteLength)
      new Uint8Array(buffer).set(wavBytes)
      const file = new File([buffer], fileName, { type: "audio/wav" })
      setState("idle")
      props.model.addAttachments([file])
      return
    }

    setState("transcribing")
    const audioBase64 = bytesToBase64(wavBytes)
    void serverSDK.api.experimental.mobile
      .transcribe({ audioBase64, mimeType: "audio/wav", fileName })
      .then((result) => {
        const text = result.text.trim()
        setState("idle")
        if (!text) {
          showToast({
            title: language.tr("未识别到清晰语音", "No speech detected"),
            description: language.tr("请靠近麦克风重试", "Please try speaking closer to the microphone"),
          })
          return
        }
        props.model.insertText(text)
      })
      .catch((error: unknown) => {
        setState("idle")
        showToast({
          variant: "error",
          title: language.tr("语音转文字失败", "Voice transcription failed"),
          description: formatServerError(error, language.t),
        })
      })
  }

  const startRecording = () => {
    if (state() !== "idle") return
    if (!navigator.mediaDevices?.getUserMedia) {
      showToast({
        variant: "error",
        title: language.tr("当前环境不支持麦克风录音", "Microphone not supported"),
      })
      return
    }

    void navigator.mediaDevices
      .getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      })
      .then((stream) => {
        const audioCtx = new AudioContext()
        const source = audioCtx.createMediaStreamSource(stream)
        const processor = audioCtx.createScriptProcessor(4096, 1, 1)
        const gain = audioCtx.createGain()
        gain.gain.value = 0
        const chunks: Float32Array[] = []

        processor.onaudioprocess = (event) => {
          const input = event.inputBuffer.getChannelData(0)
          chunks.push(new Float32Array(input))
        }

        source.connect(processor)
        processor.connect(gain)
        gain.connect(audioCtx.destination)

        const startedAt = Date.now()
        setSeconds(0)
        const timer = setInterval(() => {
          setSeconds(Math.floor((Date.now() - startedAt) / 1000))
        }, 250)

        const onKeyDown = (event: KeyboardEvent) => {
          if (event.key !== "Escape") return
          event.preventDefault()
          event.stopPropagation()
          cancelRecording()
        }
        window.addEventListener("keydown", onKeyDown, true)

        active = {
          stream,
          audioCtx,
          source,
          processor,
          gain,
          chunks,
          timer,
          removeKeyListener: () => window.removeEventListener("keydown", onKeyDown, true),
        }
        setState("recording")
      })
      .catch((error: unknown) => {
        setState("idle")
        showToast({
          variant: "error",
          title: language.tr("无法访问麦克风", "Microphone access denied"),
          description: error instanceof Error ? error.message : language.tr("请检查系统麦克风权限", "Check microphone permissions"),
        })
      })
  }

  onCleanup(() => {
    if (!active) return
    releaseRecording(active)
    active = undefined
  })

  const idleTooltip = () =>
    supportsNativeAudio()
      ? language.tr("语音输入（当前模型原生支持听取语音）", "Voice input (model hears audio natively)")
      : language.tr("语音输入（自动转写为文字）", "Voice input (auto-transcribed to text)")

  return (
    <Show
      when={state() === "recording"}
      fallback={
        <Tooltip
          placement="top"
          value={
            state() === "transcribing"
              ? language.tr("正在识别语音…", "Transcribing voice…")
              : idleTooltip()
          }
        >
          <Button
            data-action="composer-voice"
            type="button"
            variant="ghost-muted"
            size="normal"
            disabled={state() === "transcribing"}
            class="size-7 shrink-0 !p-0 ![font-weight:440]"
            aria-label={idleTooltip()}
            onMouseDown={(event: MouseEvent) => event.preventDefault()}
            onClick={startRecording}
          >
            <Show
              when={state() === "transcribing"}
              fallback={
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 16 16"
                  fill="none"
                  aria-hidden="true"
                  class="size-4 text-v2-icon-icon-muted"
                >
                  <rect x="6" y="2" width="4" height="7" rx="2" stroke="currentColor" stroke-width="1.25" />
                  <path
                    d="M3.75 7.5C3.75 9.84721 5.65279 11.75 8 11.75C10.3472 11.75 12.25 9.84721 12.25 7.5"
                    stroke="currentColor"
                    stroke-width="1.25"
                    stroke-linecap="round"
                  />
                  <path d="M8 11.75V14" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" />
                  <path d="M5.75 14H10.25" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" />
                </svg>
              }
            >
              <Loader class="size-4 text-v2-icon-icon-muted" />
            </Show>
          </Button>
        </Tooltip>
      }
    >
      <div class="flex h-7 items-center gap-0.5 rounded-md bg-v2-background-bg-layer-02 px-1.5 shadow-[inset_0_0_0_0.5px_var(--v2-border-border-muted)]">
        <Tooltip
          placement="top"
          value={
            supportsNativeAudio()
              ? language.tr("点击完成并添加语音附件", "Click to finish and attach voice")
              : language.tr("点击完成并转写为文字", "Click to finish and transcribe")
          }
        >
          <button
            data-action="composer-voice-stop"
            type="button"
            class="flex h-6 items-center gap-1.5 rounded px-1.5 text-[12px] font-[500] tabular-nums text-v2-text-text-base transition-colors hover:bg-v2-overlay-simple-overlay-hover"
            onMouseDown={(event: MouseEvent) => event.preventDefault()}
            onClick={finishRecording}
          >
            <span class="size-2 animate-pulse rounded-full bg-v2-text-feedback-error" aria-hidden="true" />
            <span>{formatDuration(seconds())}</span>
          </button>
        </Tooltip>
        <Tooltip placement="top" value={language.tr("取消录音 (Esc)", "Cancel recording (Esc)")}>
          <button
            data-action="composer-voice-cancel"
            type="button"
            aria-label={language.tr("取消录音", "Cancel recording")}
            class="flex size-5 items-center justify-center rounded text-v2-icon-icon-muted transition-colors hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-text-text-base"
            onMouseDown={(event: MouseEvent) => event.preventDefault()}
            onClick={cancelRecording}
          >
            <Icon name="outline-xmark" size="small" />
          </button>
        </Tooltip>
      </div>
    </Show>
  )
}

function formatDuration(totalSeconds: number) {
  const mins = Math.floor(totalSeconds / 60)
  const secs = totalSeconds % 60
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`
}

function encodeMonoWav16k(chunks: readonly Float32Array[], sourceRate: number): Uint8Array | undefined {
  const totalSamples = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  if (totalSamples < Math.floor(sourceRate * 0.15)) return undefined

  const merged = new Float32Array(totalSamples)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.length
  }

  const targetRate = 16_000
  const samples = downsampleLinear(merged, sourceRate, targetRate)
  if (samples.length < 1600) return undefined

  const dataByteLength = samples.length * 2
  const buffer = new ArrayBuffer(44 + dataByteLength)
  const view = new DataView(buffer)

  writeAscii(view, 0, "RIFF")
  view.setUint32(4, 36 + dataByteLength, true)
  writeAscii(view, 8, "WAVE")
  writeAscii(view, 12, "fmt ")
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, targetRate, true)
  view.setUint32(28, targetRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeAscii(view, 36, "data")
  view.setUint32(40, dataByteLength, true)

  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i] ?? 0))
    view.setInt16(44 + i * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true)
  }

  return new Uint8Array(buffer)
}

function downsampleLinear(input: Float32Array, sourceRate: number, targetRate: number) {
  if (sourceRate === targetRate) return input
  const ratio = sourceRate / targetRate
  const outputLength = Math.max(1, Math.round(input.length / ratio))
  const output = new Float32Array(outputLength)

  for (let i = 0; i < outputLength; i++) {
    const start = Math.floor(i * ratio)
    const end = Math.min(input.length, Math.max(start + 1, Math.floor((i + 1) * ratio)))
    let sum = 0
    for (let j = start; j < end; j++) {
      sum += input[j] ?? 0
    }
    output[i] = sum / (end - start)
  }

  return output
}

function writeAscii(view: DataView, offset: number, text: string) {
  for (let i = 0; i < text.length; i++) {
    view.setUint8(offset + i, text.charCodeAt(i))
  }
}

function bytesToBase64(bytes: Uint8Array) {
  const chunkSize = 0x8000
  const parts: string[] = []
  for (let i = 0; i < bytes.length; i += chunkSize) {
    parts.push(String.fromCharCode(...bytes.subarray(i, i + chunkSize)))
  }
  return btoa(parts.join(""))
}
