import type { MobileCard } from "../card.js"
import type { MobilePlatformType } from "../migration.js"

export interface UserMention {
  readonly id: string
  readonly name: string
}

export interface MobileAudioAttachment {
  readonly data: Uint8Array
  readonly mimeType: string
  readonly fileName?: string
}

export interface MobileFileAttachment {
  readonly data: Uint8Array
  readonly mimeType: string
  readonly fileName: string
}

export interface InboundMobileMessage {
  readonly robotId: string
  readonly platform: MobilePlatformType
  readonly sessionKey: string
  readonly messageId: string
  readonly userId: string
  readonly userName: string
  readonly chatId: string
  readonly text: string
  readonly mentionedUsers?: readonly UserMention[]
  readonly audioAttachments?: readonly MobileAudioAttachment[]
  readonly fileAttachments?: readonly MobileFileAttachment[]
  readonly progressDelayMs?: number
  readonly stallTimeoutMs?: number
  readonly replyContext: unknown
}

export type MobileMessageHandler = (msg: InboundMobileMessage) => Promise<void>

export type MobileCardActionHandler = (input: {
  readonly robotId: string
  readonly action: string
  readonly sessionKey: string
  readonly userId: string
  readonly chatId: string
  readonly replyContext: unknown
}) => Promise<MobileCard | undefined>

export interface MobilePlatformStatus {
  readonly state: "connected" | "connecting" | "error" | "stopped"
  readonly error?: string
}

export interface MobileProgressHandle {
  readonly update: (card: MobileCard) => Promise<void>
  readonly finish: (finalCard?: MobileCard) => Promise<void>
}

export interface MobilePlatformConnector {
  readonly start: (onMessage: MobileMessageHandler, onCardAction: MobileCardActionHandler) => Promise<void>
  readonly stop: () => Promise<void>
  readonly status: () => MobilePlatformStatus
  readonly sendText: (replyContext: unknown, text: string) => Promise<void>
  readonly sendCard: (replyContext: unknown, card: MobileCard) => Promise<void>
  readonly sendFile: (
    replyContext: unknown,
    file: { readonly fileName: string; readonly mimeType: string; readonly data: Uint8Array },
  ) => Promise<void>
  readonly startProgress?: (
    replyContext: unknown,
    initialCard: MobileCard,
  ) => Promise<MobileProgressHandle | undefined>
  readonly setTyping?: (replyContext: unknown, typing: boolean) => Promise<void>
  readonly resolveUserDisplayName?: (userId: string) => Promise<string>
}
