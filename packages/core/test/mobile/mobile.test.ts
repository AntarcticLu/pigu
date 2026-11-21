import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Context, Deferred, Effect, Fiber, Layer, LayerMap, Stream } from "effect"
import { Agent } from "@opencode/core/agent"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import type { FileSystem } from "@opencode/core/filesystem"
import { Form } from "@opencode/core/form"
import { Image } from "@opencode/core/image"
import { Location } from "@opencode/core/location"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import type { LocationServices } from "@opencode/core/location-services"
import { Mobile } from "@opencode/core/mobile"
import { Model } from "@opencode/core/model"
import { Plugin } from "@opencode/core/plugin"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { Project } from "@opencode/core/project"
import { Provider } from "@opencode/core/provider"
import { Session } from "@opencode/core/session"
import { StepFailedError } from "@opencode/core/session/error"
import { SessionEvent } from "@opencode/core/session/event"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionInbox } from "@opencode/core/session/inbox"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionProjector } from "@opencode/core/session/projector"
import { SessionRunner } from "@opencode/core/session/runner/index"
import { SessionStore } from "@opencode/core/session/store"
import { Skill } from "@opencode/core/skill"
import { Snapshot } from "@opencode/core/snapshot"
import { AbsolutePath } from "@opencode/core/schema"
import { Money } from "@opencode/schema/money"
import { Global } from "@opencode/util/global"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import {
  decodeUniversalRobotMigrationCode,
  encodeRobotMigrationCode,
  normalizeAllowFromWithOwner,
  shortMigrationCode,
} from "../../src/mobile/migration"
import { isUserAllowed, parseMobileInput } from "../../src/mobile/commands"
import { extractMobileButlerActions } from "../../src/mobile/butler"
import { createCipheriv } from "node:crypto"
import { renderCardMarkdownFallback, renderFeishuCardObject } from "../../src/mobile/card"
import { createFeishuConnector } from "../../src/mobile/platforms/feishu"
import { createWeixinConnector, decryptWeixinCdnPayload } from "../../src/mobile/platforms/weixin"
import type { InboundMobileMessage } from "../../src/mobile/platforms/types"
import { testEffect } from "../lib/effect"
import { globalProjectNode } from "../lib/project"
import { initGit, initRepo } from "../fixture/git"
import { tempGlobalLayer } from "../fixture/global"
import { promptLocationNode } from "../fixture/prompt-location"
import { tmpdirScoped } from "../fixture/tmpdir"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      Bus.node,
      SessionProjector.node,
      SessionStore.node,
      Session.node,
      Mobile.node,
    ]),
    [
      Bus.node.replace(Bus.configured({ persist: true })),
      Global.node.replace(tempGlobalLayer),
      Project.node.replace(globalProjectNode),
      LocationServiceMap.node.replace(promptLocationNode),
      SessionExecution.node.replace(SessionExecution.noopLayer),
    ],
  ),
)

describe("mobile migration codes (AL-ROBOT-1 & AL-FEISHU-1)", () => {
  test("encodes and decodes AL-ROBOT-1 for Feishu with owner and allowFrom", () => {
    const code = encodeRobotMigrationCode({
      id: "robot_1",
      name: "Pigu 飞书助手",
      platform: "feishu",
      enabled: true,
      ownerID: "ou_owner123",
      allowFrom: "ou_user456",
      adminFrom: "",
      userNames: { ou_owner123: "大飞鱼" },
      feishu: {
        appId: "cli_a9d123456789",
        appSecret: "sec_abcdef123456789",
        domain: "feishu",
      },
      createdAt: 1000,
      updatedAt: 1000,
    })

    expect(code.startsWith("AL-ROBOT-1.")).toBe(true)
    const short = shortMigrationCode(code)
    expect(short).toContain("...")

    const decoded = decodeUniversalRobotMigrationCode(code)
    expect(decoded.platform).toBe("feishu")
    expect(decoded.name).toBe("Pigu 飞书助手")
    expect(decoded.feishu?.app_id).toBe("cli_a9d123456789")
    expect(decoded.feishu?.app_secret).toBe("sec_abcdef123456789")
    expect(decoded.owner_id).toBe("ou_owner123")
    expect(decoded.allow_from).toBe("ou_owner123,ou_user456")
  })

  test("encodes and decodes AL-ROBOT-1 for WeChat, DingTalk, WeCom, and QQBot", () => {
    const weixinCode = encodeRobotMigrationCode({
      id: "wx_1",
      name: "微信助手",
      platform: "weixin",
      enabled: true,
      ownerID: "wx_user_1",
      allowFrom: "",
      weixin: {
        token: "ilink_token_xyz",
        baseUrl: "https://ilinkai.weixin.qq.com",
        accountId: "bot_acc_1",
      },
      createdAt: 1000,
      updatedAt: 1000,
    })
    const wxDecoded = decodeUniversalRobotMigrationCode(weixinCode)
    expect(wxDecoded.platform).toBe("weixin")
    expect(wxDecoded.weixin?.token).toBe("ilink_token_xyz")
    expect(wxDecoded.weixin?.account_id).toBe("bot_acc_1")
    expect(wxDecoded.allow_from).toBe("wx_user_1")

    const dtCode = encodeRobotMigrationCode({
      id: "dt_1",
      name: "钉钉助手",
      platform: "dingtalk",
      enabled: true,
      ownerID: "",
      allowFrom: "",
      dingtalk: {
        clientId: "ding_id_1",
        clientSecret: "ding_sec_1",
      },
      createdAt: 1000,
      updatedAt: 1000,
    })
    const dtDecoded = decodeUniversalRobotMigrationCode(dtCode)
    expect(dtDecoded.platform).toBe("dingtalk")
    expect(dtDecoded.dingtalk?.client_id).toBe("ding_id_1")
    expect(dtDecoded.dingtalk?.client_secret).toBe("ding_sec_1")

    const wcCode = encodeRobotMigrationCode({
      id: "wc_1",
      name: "企微助手",
      platform: "wecom",
      enabled: true,
      ownerID: "",
      allowFrom: "",
      wecom: {
        botId: "aib_bot_1",
        secret: "wecom_sec_1",
      },
      createdAt: 1000,
      updatedAt: 1000,
    })
    const wcDecoded = decodeUniversalRobotMigrationCode(wcCode)
    expect(wcDecoded.platform).toBe("wecom")
    expect(wcDecoded.wecom?.bot_id).toBe("aib_bot_1")

    const qqCode = encodeRobotMigrationCode({
      id: "qq_1",
      name: "QQ助手",
      platform: "qqbot",
      enabled: true,
      ownerID: "",
      allowFrom: "",
      qqbot: {
        appId: "10203040",
        appSecret: "qq_sec_1",
      },
      createdAt: 1000,
      updatedAt: 1000,
    })
    const qqDecoded = decodeUniversalRobotMigrationCode(qqCode)
    expect(qqDecoded.platform).toBe("qqbot")
    expect(qqDecoded.qqbot?.app_id).toBe("10203040")
  })

  test("rejects tampered checksum in AL-ROBOT-1", () => {
    const code = encodeRobotMigrationCode({
      id: "r1",
      name: "Bot",
      platform: "feishu",
      enabled: true,
      ownerID: "",
      allowFrom: "",
      feishu: {
        appId: "cli_1",
        appSecret: "sec_1",
      },
      createdAt: 1000,
      updatedAt: 1000,
    })
    const tampered = code.slice(0, -2) + "ff"
    expect(() => decodeUniversalRobotMigrationCode(tampered)).toThrow()
  })

  test("normalizes allowFrom with owner first and deduplicated", () => {
    expect(normalizeAllowFromWithOwner("owner_1", "user_2, owner_1, user_2, ")).toBe("owner_1,user_2")
  })
})

describe("mobile 8 + 1 dot commands parser", () => {
  test("parses all 8 + 1 commands and aliases", () => {
    expect(parseMobileInput(".project")).toEqual({ kind: "project", sub: "list", arg: "" })
    expect(parseMobileInput("。proj 2")).toEqual({ kind: "project", sub: "switch", arg: "2" })
    expect(parseMobileInput(".project new /tmp/demo")).toEqual({
      kind: "project",
      sub: "new",
      arg: "/tmp/demo",
    })
    expect(parseMobileInput(".chat new")).toEqual({ kind: "chat", sub: "new", arg: "" })
    expect(parseMobileInput(".new")).toEqual({ kind: "chat", sub: "new", arg: "" })
    expect(parseMobileInput(".undo")).toEqual({ kind: "chat", sub: "undo", arg: "" })
    expect(parseMobileInput(".model 3")).toEqual({ kind: "model", sub: "switch", arg: "3" })
    expect(parseMobileInput(".model effort high")).toEqual({ kind: "model", sub: "effort", arg: "high" })
    expect(parseMobileInput(".sh git status")).toEqual({
      kind: "shell",
      command: "git status",
    })
    expect(parseMobileInput(".shell ls -la")).toEqual({
      kind: "shell",
      command: "ls -la",
    })
    expect(parseMobileInput(".stop")).toEqual({ kind: "stop" })
    expect(parseMobileInput(".skip")).toEqual({ kind: "skip" })
    expect(parseMobileInput("。pass")).toEqual({ kind: "skip" })
    expect( parseMobileInput(".ps 请顺便加上单元测试")).toEqual({
      kind: "ps",
      text: "请顺便加上单元测试",
    })
    expect(parseMobileInput(".log")).toEqual({ kind: "log" })
    expect(parseMobileInput(".progress")).toEqual({ kind: "log" })
    expect(parseMobileInput(".send package.json")).toEqual({
      kind: "send",
      filePath: "package.json",
    })
    expect(parseMobileInput(".access add ou_123")).toEqual({
      kind: "access",
      sub: "add",
      arg: "ou_123",
    })
    expect(parseMobileInput(".whoami")).toEqual({
      kind: "access",
      sub: "whoami",
      arg: "",
    })
    expect(parseMobileInput(".help")).toEqual({ kind: "help" })
  })

  test("intercepts unknown .xxx commands without sending to LLM", () => {
    const unknown = parseMobileInput(".unknowncmd arg1")
    expect(unknown).toEqual({ kind: "unknown_command", rawCommand: ".unknowncmd" })
  })

  test("treats normal messages and decimal numbers as prompts", () => {
    expect(parseMobileInput("帮我重构一下登录模块")).toEqual({
      kind: "prompt",
      text: "帮我重构一下登录模块",
    })
    expect(parseMobileInput(".5 seconds")).toEqual({
      kind: "prompt",
      text: ".5 seconds",
    })
  })

  test("enforces ACL allowlist", () => {
    expect(isUserAllowed("ou_1", "", "ou_1")).toBe(true)
    expect(isUserAllowed("ou_1", "ou_1,ou_2", "ou_stranger")).toBe(false)
    expect(isUserAllowed("ou_1", "ou_1,ou_2", "ou_2")).toBe(true)
  })
})

describe("mobile card rendering", () => {
  test("renders unified compact markdown across Feishu and fallback platforms", () => {
    const card = {
      header: {
        title: "Pigu 手机主控台",
        color: "blue" as const,
      },
      elements: [
        { kind: "markdown" as const, content: "欢迎使用 Pigu 手机端" },
        { kind: "list_item" as const, text: "* **#1 pigu** (本机) · `/Volumes/AntL/pigu/pigu`" },
        { kind: "note" as const, text: "用法：.p <编号> 切换项目" },
      ],
    }

    const feishuObj = renderFeishuCardObject(card)
    expect(feishuObj.config).toEqual({ wide_screen_mode: true })
    expect(Array.isArray(feishuObj.elements)).toBe(true)

    const fallback = renderCardMarkdownFallback(card)
    expect(fallback).toContain("**Pigu 手机主控台**")
    expect(fallback).toContain("#1 pigu")

    const collapsibleCard = {
      header: { title: "📋 执行过程记录", color: "grey" as const },
      elements: [
        {
          kind: "collapsible" as const,
          title: "点击展开查看中间过程",
          expanded: false,
          content: "- 💬 第一步检查文件\n- 🔧 ✓ 读取文件 `auth.ts`",
        },
      ],
    }
    const schema2Obj = renderFeishuCardObject(collapsibleCard)
    expect(schema2Obj.schema).toBe("2.0")
    const bodyElements = (schema2Obj.body as { elements: Array<Record<string, unknown>> }).elements
    expect(bodyElements[0]?.tag).toBe("collapsible_panel")
    expect(bodyElements[0]?.expanded).toBe(false)
  })
})

describe("end-to-end 8 + 1 mobile commands audit (functional, UX & .help consistency)", () => {
  it.live("executes all 8 + 1 commands against real Project, Session & Mobile services", () =>
    Effect.gen(function* () {
      const mobile = yield* Mobile.Service
      const tmp = yield* tmpdirScoped("pigu-mobile-test-")
      const projDir = tmp.path
      yield* Effect.promise(() =>
        fs.writeFile(path.join(projDir, "README.md"), "# Pigu Mobile Test\nHello from Pigu!\n", "utf8"),
      )

      const bot = yield* mobile.create({
        name: "Pigu 实测机器人",
        platform: "feishu",
        enabled: false,
        ownerID: "ou_admin_001",
        allowFrom: "ou_admin_001",
      })

      const livePush = process.env.FEISHU_LIVE_PUSH === "1"
      const liveChatId = process.env.FEISHU_LIVE_CHAT_ID || "oc_1445514107a067e02628f4a7802c84b9"
      const liveConnector = livePush
        ? createFeishuConnector({
            robotId: bot.id,
            platform: "feishu",
            appId: process.env.FEISHU_LIVE_APP_ID || "cli_aa531c63f3b89c1a",
            appSecret: process.env.FEISHU_LIVE_APP_SECRET || "zSNCNQ7zwKORzwJlHg9bdbXnIBlHpbHB",
          })
        : undefined
      let stepCounter = 0

      const runCmd = (text: string, userId = "ou_admin_001") =>
        Effect.gen(function* () {
          const res = yield* mobile.simulateInbound({
            robotId: bot.id,
            userId,
            userName: userId === "ou_admin_001" ? "管理员大飞鱼" : "访客",
            chatId: "oc_test_chat",
            text,
          })
          if (liveConnector) {
            stepCounter += 1
            const rc = { chatId: liveChatId, sessionKey: `feishu:${bot.id}:${liveChatId}` }
            const actorTag = userId === "ou_admin_001" ? "管理员" : "访客"
            yield* Effect.promise(async () => {
              await liveConnector.sendText(rc, `[实测 #${stepCounter} · ${actorTag}] \`${text}\``)
              for (const card of res.cards) {
                await liveConnector.sendCard(rc, card)
              }
              for (const txt of res.texts) {
                await liveConnector.sendText(rc, txt)
              }
              if (res.files.length > 0) {
                const rawBytes = new Uint8Array(await fs.readFile(path.join(projDir, "README.md")))
                for (const f of res.files) {
                  await liveConnector.sendFile(rc, {
                    fileName: f.fileName,
                    mimeType: f.mimeType,
                    data: rawBytes,
                  })
                }
              }
            })
          }
          return res
        })

      // 1. .project new <dir> & .project list & .project switch
      const projNewRes = yield* runCmd(`.project new ${projDir}`)
      expect(projNewRes.cards[0]?.header?.title).toContain("已打开并切换项目")

      const projListRes = yield* runCmd(".project")
      expect(projListRes.cards[0]?.header?.title).toContain("项目列表")
      const projListMd = renderCardMarkdownFallback(projListRes.cards[0]!)
      expect(projListMd).toContain(path.basename(projDir))

      const projSwitchRes = yield* runCmd(`.project ${path.basename(projDir)}`)
      expect(projSwitchRes.cards[0]?.header?.title).toContain("已切换项目")

      // 2. .help & consistency audit with parser
      const helpRes = yield* runCmd(".help")
      const helpCard = helpRes.cards[0]!
      expect(helpCard.header?.title).toContain("Pigu 手机端控制中心")
      const helpFallback = renderCardMarkdownFallback(helpCard)
      for (const expectedCmd of [".project", ".chat", ".model", ".sh", ".stop", ".ps", ".send", ".access", ".help"]) {
        expect(helpFallback).toContain(expectedCmd)
      }

      // 3. .chat (new, name, list, switch, history, undo, delete)
      const chatNewRes = yield* runCmd(".chat new 移动端专项测试会话")
      expect(chatNewRes.cards[0]?.header?.title).toContain("已新建并切换会话")

      const chatNameRes = yield* runCmd(".chat name 重命名后的会话")
      expect(chatNameRes.cards[0]?.header?.title).toContain("会话已重命名")

      const chatListRes = yield* runCmd(".chat")
      const chatListText = renderCardMarkdownFallback(chatListRes.cards[0]!)
      expect(chatListText).toContain("重命名后的会话")
      expect(chatListText).not.toContain("NaN")

      const chatSwitchRes = yield* runCmd(".chat 1")
      expect(chatSwitchRes.cards[0]?.header?.title).toContain("已切换会话")

      const chatUndoEmptyRes = yield* runCmd(".chat undo")
      expect(chatUndoEmptyRes.cards[0]?.header?.title).toContain("撤回上一轮")

      // 4. .model (list, effort, switch)
      const modelListRes = yield* runCmd(".model")
      expect(modelListRes.cards[0]?.header?.title).toContain("模型与厂商切换")

      const modelEffortViewRes = yield* runCmd(".model effort")
      expect(modelEffortViewRes.cards[0]?.header?.title).toContain("推理强度")

      const modelEffortSetRes = yield* runCmd(".model effort high")
      expect(modelEffortSetRes.cards[0]?.header?.title).toContain("已更新推理强度")

      const modelSwitchRes = yield* runCmd(".model anthropic/claude-sonnet-4-5")
      expect(modelSwitchRes.cards[0]?.header?.title).toContain("已切换会话模型")

      // 5. .sh / .shell (no-arg usage & real shell execution)
      const shEmptyRes = yield* runCmd(".sh")
      expect(shEmptyRes.cards[0]?.header?.title).toContain("终端命令")

      const shExecRes = yield* runCmd(".sh echo pigu_shell_ok")
      expect(shExecRes.cards[0]?.header?.title).toContain("命令执行成功")
      expect(renderCardMarkdownFallback(shExecRes.cards[0]!)).toContain("pigu_shell_ok")

      // 6. .stop
      const stopRes = yield* runCmd(".stop")
      expect(stopRes.cards[0]?.header?.title).toContain("当前会话处于空闲状态")

      // 7. .ps / .btw
      const psEmptyRes = yield* runCmd(".ps")
      expect(psEmptyRes.cards[0]?.header?.title).toContain("插话补充")

      const psInjectRes = yield* runCmd(".ps 请同时检查边界条件")
      expect(psInjectRes.cards[0]?.header?.title).toContain("已注入补充指令")

      // Verify .chat history now shows our user message
      const chatHistoryRes = yield* runCmd(".chat history")
      expect(chatHistoryRes.cards[0]?.header?.title).toContain("最近对话记录")

      // 8. .send / .file (no-arg numbered file list + .send 1 by number!)
      const sendPickerRes = yield* runCmd(".send")
      const pickerText = renderCardMarkdownFallback(sendPickerRes.cards[0]!)
      expect(pickerText).toContain("#1 README.md")

      const sendFileByIdxRes = yield* runCmd(".send 1")
      expect(sendFileByIdxRes.files.length).toBe(1)
      expect(sendFileByIdxRes.files[0]?.fileName).toBe("README.md")
      expect(sendFileByIdxRes.files[0]?.size).toBeGreaterThan(10)

      // 9. .access / .acl / .whoami (owner, guest block, add, remove by #1 index!)
      const whoamiOwner = yield* runCmd(".whoami", "ou_admin_001")
      expect(renderCardMarkdownFallback(whoamiOwner.cards[0]!)).toContain("管理员 (Owner)")

      const whoamiGuest = yield* runCmd(".whoami", "ou_guest_999")
      expect(renderCardMarkdownFallback(whoamiGuest.cards[0]!)).toContain("未授权用户")

      const blockedGuest = yield* runCmd(".project", "ou_guest_999")
      expect(blockedGuest.cards[0]?.header?.title).toContain("未授权访问")

      const addGuest = yield* runCmd(".access add ou_guest_999", "ou_admin_001")
      expect(renderCardMarkdownFallback(addGuest.cards[0]!)).toContain("ou_guest_999")

      const allowedGuest = yield* runCmd(".project", "ou_guest_999")
      expect(allowedGuest.cards[0]?.header?.title).toContain("项目列表")

      const removeGuestByIdx = yield* runCmd(".access rm 1", "ou_admin_001")
      expect(renderCardMarkdownFallback(removeGuestByIdx.cards[0]!)).not.toContain("ou_guest_999")

      // 10. Unknown .xxx command interception
      const unknownRes = yield* runCmd(".notacommand 123")
      expect(renderCardMarkdownFallback(unknownRes.cards[0]!)).toContain("未识别的命令 `.notacommand`")
    }),
  )
})

class ComboGates extends Context.Service<
  ComboGates,
  {
    readonly steerStepStarted: Deferred.Deferred<void>
    readonly allowSteerCheck: Deferred.Deferred<void>
    readonly slowStepStarted: Deferred.Deferred<void>
    readonly naturalSteerStarted: Deferred.Deferred<void>
    readonly allowNaturalSteerFinish: Deferred.Deferred<void>
    readonly retryStepStarted: Deferred.Deferred<void>
    readonly allowRetryFinish: Deferred.Deferred<void>
  }
>()("test/MobileComboGates") {}

const comboGatesNode = makeGlobalNode({
  service: ComboGates,
  layer: Layer.effect(
    ComboGates,
    Effect.gen(function* () {
      return {
        steerStepStarted: yield* Deferred.make<void>(),
        allowSteerCheck: yield* Deferred.make<void>(),
        slowStepStarted: yield* Deferred.make<void>(),
        naturalSteerStarted: yield* Deferred.make<void>(),
        allowNaturalSteerFinish: yield* Deferred.make<void>(),
        retryStepStarted: yield* Deferred.make<void>(),
        allowRetryFinish: yield* Deferred.make<void>(),
      }
    }),
  ),
  deps: [],
})

const comboLocationNode = makeGlobalNode({
  service: LocationServiceMap.Service,
  layer: Layer.effect(
    LocationServiceMap.Service,
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const database = yield* Database.Service
      const store = yield* SessionStore.Service
      const global = yield* Global.Service
      const projects = yield* Project.Service
      const gates = yield* ComboGates

      return yield* LayerMap.make((ref: Location.Ref) => {
        const runnerLayer = Layer.effect(
          SessionRunner.Service,
          Effect.gen(function* () {
            const snapshot = yield* Snapshot.Service
            const forms = yield* Form.Service
            return SessionRunner.Service.of({
              drain: ({ sessionID }) =>
                Effect.gen(function* () {
                  while (true) {
                    const promoted = yield* SessionInbox.promote(database.db, bus, sessionID, "input")
                    if (!promoted) break

                    const sessionInfo = yield* store.get(sessionID).pipe(Effect.orDie)
                    const activeModel = sessionInfo?.model ?? {
                      providerID: Provider.ID.make("local"),
                      id: Model.ID.make("claude-haiku-4-5"),
                    }
                    const ctxMsgs = yield* store.context(sessionID).pipe(Effect.orDie)
                    const latestInput = [...ctxMsgs]
                      .reverse()
                      .find((m) => m.type === "user" || m.type === "synthetic")
                    const latestUser = latestInput?.type === "user" ? latestInput : undefined
                    const userText =
                      latestInput?.type === "user" || latestInput?.type === "synthetic" ? latestInput.text : ""

                    if (userText.includes("耗时很长的全量扫描")) {
                      yield* Deferred.succeed(gates.slowStepStarted, undefined)
                      return yield* Effect.never
                    }

                    const before = yield* snapshot.capture()
                    const assistantMessageID = SessionMessage.ID.create()
                    yield* bus.publish(SessionEvent.Step.Started, {
                      sessionID,
                      assistantMessageID,
                      agent: Agent.defaultID,
                      model: activeModel,
                      snapshot: before,
                      started: 0,
                    })

                    let reply = "已完成处理。"
                    if (userText.includes("统计 orders.csv")) {
                      yield* Effect.promise(() =>
                        fs.writeFile(
                          path.join(ref.directory, "calc.js"),
                          [
                            'const fs = require("fs");',
                            'const lines = fs.readFileSync("orders.csv", "utf8").trim().split("\\n").slice(1);',
                            "const total = lines.reduce((sum, line) => sum + Number(line.split(\",\")[1] || 0), 0);",
                            'console.log(JSON.stringify({ count: lines.length, total }));',
                          ].join("\n"),
                          "utf8",
                        ),
                      )
                      reply = "已创建 `calc.js` 统计脚本。"
                      yield* Deferred.succeed(gates.steerStepStarted, undefined)
                      yield* Deferred.await(gates.allowSteerCheck)
                    }
                    if (userText.includes("output/report.md")) {
                      yield* Effect.promise(async () => {
                        await fs.mkdir(path.join(ref.directory, "output"), { recursive: true })
                        await fs.writeFile(
                          path.join(ref.directory, "output", "report.md"),
                          "# 订单汇总报告\n\n- 订单笔数：3\n- 总金额：450\n",
                          "utf8",
                        )
                      })
                      reply = "已按补充要求生成 `output/report.md` 汇总报告。"
                    }
                    if (userText.includes("改成破坏性错误版本")) {
                      yield* Effect.promise(() =>
                        fs.writeFile(path.join(ref.directory, "calc.js"), "throw new Error('broken_calc');\n", "utf8"),
                      )
                      reply = "已修改 `calc.js`（模拟误改）。"
                    }
                    const butlerMatch = userText.match(/自然语言切到项目:([^\s]+)\s+并执行:(.+)/)
                    if (butlerMatch) {
                      reply = [
                        `好的，正在为您切换到 **${butlerMatch[1]}** 项目并继续处理。`,
                        `<pigu-mobile-action>${JSON.stringify({
                          type: "switch_project",
                          target: butlerMatch[1],
                          followUpPrompt: butlerMatch[2],
                        })}</pigu-mobile-action>`,
                      ].join("\n")
                    }
                    if (!butlerMatch && userText.includes("读取当前项目的标识文件")) {
                      const marker = yield* Effect.promise(() =>
                        fs.readFile(path.join(ref.directory, "PROJECT_ID.txt"), "utf8").catch(() => "missing"),
                      )
                      reply = `当前项目标识是：${marker.trim()}`
                    }
                    const userFiles = latestUser?.type === "user" ? (latestUser.files ?? []) : []
                    const audioFiles = userFiles.filter((f) => f.mime.startsWith("audio/"))
                    if (audioFiles.length > 0) {
                      reply = `已原生接收语音附件：${audioFiles.map((f) => `${f.name}(${f.mime})`).join(", ")}`
                    }
                    const nonAudioFiles = userFiles.filter((f) => !f.mime.startsWith("audio/"))
                    if (nonAudioFiles.length > 0) {
                      reply = `已接收图片与文件附件：${nonAudioFiles.map((f) => `${f.name}(${f.mime})`).join(", ")}`
                    }
                    const sendFileMatch = userText.match(/生成并发送文件:([^\s]+)/)
                    if (sendFileMatch) {
                      const outName = sendFileMatch[1]!
                      yield* Effect.promise(() =>
                        fs.writeFile(path.join(ref.directory, outName), "AI_GENERATED_DELIVERY_OK\n", "utf8"),
                      )
                      reply = [
                        `已生成 \`${outName}\` 并推送到您的手机。`,
                        `<pigu-mobile-action>${JSON.stringify({ type: "send_file", target: outName })}</pigu-mobile-action>`,
                      ].join("\n")
                    }
                    if (userText.includes("执行多步静默重构任务")) {
                      const intermediateRemarks = [
                        "第一步：我正在读取 auth.ts 分析瓶颈。",
                        "第二步：我已经修改了 auth.ts 并准备验证测试。",
                      ]
                      for (const [idx, remark] of intermediateRemarks.entries()) {
                        const midId = idx === 0 ? assistantMessageID : SessionMessage.ID.create()
                        if (idx > 0) {
                          yield* bus.publish(SessionEvent.Step.Started, {
                            sessionID,
                            assistantMessageID: midId,
                            agent: Agent.defaultID,
                            model: activeModel,
                            snapshot: before,
                            started: 0,
                          })
                        }
                        yield* bus.publish(SessionEvent.Text.Started, {
                          sessionID,
                          assistantMessageID: midId,
                          ordinal: 0,
                        })
                        yield* bus.publish(SessionEvent.Text.Ended, {
                          sessionID,
                          assistantMessageID: midId,
                          ordinal: 0,
                          text: remark,
                        })
                        yield* Effect.sleep("70 millis")
                        yield* bus.publish(SessionEvent.Step.Ended, {
                          sessionID,
                          assistantMessageID: midId,
                          finish: "tool-calls",
                          cost: Money.USD.zero,
                          tokens: { input: 10, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
                          snapshot: before,
                        })
                      }
                      const finalStepId = SessionMessage.ID.create()
                      yield* bus.publish(SessionEvent.Step.Started, {
                        sessionID,
                        assistantMessageID: finalStepId,
                        agent: Agent.defaultID,
                        model: activeModel,
                        snapshot: before,
                        started: 0,
                      })
                      yield* Effect.sleep("70 millis")
                      yield* bus.publish(SessionEvent.Text.Started, {
                        sessionID,
                        assistantMessageID: finalStepId,
                        ordinal: 0,
                      })
                      yield* bus.publish(SessionEvent.Text.Ended, {
                        sessionID,
                        assistantMessageID: finalStepId,
                        ordinal: 0,
                        text: "多步重构已全部完成，所有测试均通过！",
                      })
                      yield* bus.publish(SessionEvent.Step.Ended, {
                        sessionID,
                        assistantMessageID: finalStepId,
                        finish: "stop",
                        cost: Money.USD.zero,
                        tokens: { input: 10, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
                        snapshot: before,
                      })
                      continue
                    }

                    if (userText.includes("搭建持久层并询问需求")) {
                      yield* bus.publish(SessionEvent.Text.Started, {
                        sessionID,
                        assistantMessageID,
                        ordinal: 0,
                      })
                      yield* bus.publish(SessionEvent.Text.Ended, {
                        sessionID,
                        assistantMessageID,
                        ordinal: 0,
                        text: "在实现持久层之前，我需要先向你确认两个关键选型问题。",
                      })
                      const formState = yield* forms
                        .ask({
                          sessionID,
                          title: "Questions",
                          metadata: { kind: "question" },
                          fields: [
                            {
                              key: "q0",
                              title: "数据库选型",
                              description: "你希望使用哪种数据库方案？",
                              type: "string",
                              options: [
                                {
                                  value: "SQLite (Recommended)",
                                  label: "SQLite (Recommended)",
                                  description: "零运维单文件本地存储",
                                },
                                {
                                  value: "PostgreSQL",
                                  label: "PostgreSQL",
                                  description: "适合多实例生产集群",
                                },
                                {
                                  value: "MySQL",
                                  label: "MySQL",
                                  description: "传统关系型数据库",
                                },
                              ],
                              custom: true,
                            },
                            {
                              key: "q1",
                              title: "附加能力",
                              description: "需要同时启用哪些附加模块？",
                              type: "multiselect",
                              options: [
                                { value: "自动备份", label: "自动备份" },
                                { value: "读写分离", label: "读写分离" },
                                { value: "慢查询日志", label: "慢查询日志" },
                              ],
                              custom: true,
                            },
                          ],
                        })
                        .pipe(Effect.orDie)

                      yield* bus.publish(SessionEvent.Step.Ended, {
                        sessionID,
                        assistantMessageID,
                        finish: "tool-calls",
                        cost: Money.USD.zero,
                        tokens: { input: 10, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
                        snapshot: before,
                      })

                      const finalQaStepId = SessionMessage.ID.create()
                      yield* bus.publish(SessionEvent.Step.Started, {
                        sessionID,
                        assistantMessageID: finalQaStepId,
                        agent: Agent.defaultID,
                        model: activeModel,
                        snapshot: before,
                        started: 0,
                      })
                      const qaFinalText =
                        formState.status === "answered"
                          ? `已按你的确认完成持久层搭建：数据库=${String(formState.answer.q0)}，模块=${Array.isArray(formState.answer.q1) ? formState.answer.q1.join("+") : String(formState.answer.q1)}。`
                          : `已按跳过策略采用推荐方案（SQLite）完成搭建（原因：${formState.message ?? "dismissed"}）。`
                      yield* bus.publish(SessionEvent.Text.Started, {
                        sessionID,
                        assistantMessageID: finalQaStepId,
                        ordinal: 0,
                      })
                      yield* bus.publish(SessionEvent.Text.Ended, {
                        sessionID,
                        assistantMessageID: finalQaStepId,
                        ordinal: 0,
                        text: qaFinalText,
                      })
                      yield* bus.publish(SessionEvent.Step.Ended, {
                        sessionID,
                        assistantMessageID: finalQaStepId,
                        finish: "stop",
                        cost: Money.USD.zero,
                        tokens: { input: 10, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
                        snapshot: before,
                      })
                      continue
                    }

                    if (userText.includes("确认部署环境单选问答")) {
                      const singleState = yield* forms
                        .ask({
                          sessionID,
                          title: "Questions",
                          metadata: { kind: "question" },
                          fields: [
                            {
                              key: "q0",
                              title: "部署目标",
                              description: "请确认本次发布的部署目标环境：",
                              type: "string",
                              options: [
                                { value: "Staging (Recommended)", label: "Staging (Recommended)" },
                                { value: "Production", label: "Production" },
                              ],
                              custom: true,
                            },
                          ],
                        })
                        .pipe(Effect.orDie)
                      reply =
                        singleState.status === "answered"
                          ? `已完成向 **${String(singleState.answer.q0)}** 环境的发布！`
                          : `已按默认推荐 Staging 环境完成发布！`
                    }

                    if (userText.includes("执行长耗时代码审计")) {
                      yield* Effect.sleep("180 millis")
                      reply = "长耗时代码审计已完成。"
                    }

                    if (userText.includes("重构登录模块自然插话测试")) {
                      reply = "已完成登录模块 login.ts 重构。"
                      yield* Deferred.succeed(gates.naturalSteerStarted, undefined)
                      yield* Deferred.await(gates.allowNaturalSteerFinish)
                    }

                    if (userText.includes("顺便把覆盖率报告也补上")) {
                      reply = "已按中途补充指令生成覆盖率报告！"
                    }

                    if (userText.includes("模拟上游429限流退避重试")) {
                      yield* bus.publish(SessionEvent.RetryScheduled, {
                        sessionID,
                        assistantMessageID,
                        attempt: 2,
                        at: Date.now() + 15_000,
                        error: {
                          type: "RateLimitError",
                          message: "429 Too Many Requests: upstream rate limit",
                          status: 429,
                        },
                      })
                      yield* Deferred.succeed(gates.retryStepStarted, undefined)
                      yield* Deferred.await(gates.allowRetryFinish)
                      reply = "限流恢复后已完成推理。"
                    }

                    if (userText.includes("模拟中途配额耗尽硬性报错")) {
                      yield* bus.publish(SessionEvent.Text.Started, {
                        sessionID,
                        assistantMessageID,
                        ordinal: 0,
                      })
                      yield* bus.publish(SessionEvent.Text.Ended, {
                        sessionID,
                        assistantMessageID,
                        ordinal: 0,
                        text: "我先检查一下构建目录结构…",
                      })
                      yield* bus.publish(SessionEvent.Step.Ended, {
                        sessionID,
                        assistantMessageID,
                        finish: "tool-calls",
                        cost: Money.USD.zero,
                        tokens: { input: 10, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
                        snapshot: before,
                      })
                      const failStepId = SessionMessage.ID.create()
                      yield* bus.publish(SessionEvent.Step.Started, {
                        sessionID,
                        assistantMessageID: failStepId,
                        agent: Agent.defaultID,
                        model: activeModel,
                        snapshot: before,
                        started: 0,
                      })
                      const structuredErr = {
                        type: "InsufficientQuotaError",
                        message: "402 Insufficient API Quota: token balance exhausted",
                        status: 402,
                      }
                      yield* bus.publish(SessionEvent.Step.Failed, {
                        sessionID,
                        assistantMessageID: failStepId,
                        error: structuredErr,
                      })
                      return yield* Effect.fail(new StepFailedError({ error: structuredErr }))
                    }

                    if (userText.includes("桌面端直接发起的长重构任务")) {
                      reply = "桌面端重构已完成，共清理 4 个冗余模块。"
                    }

                    if (userText.includes("定时巡检线上训练日志")) {
                      reply = "训练日志巡检正常，Loss 已收敛至 0.041。"
                    }

                    if (userText.includes("模拟终端命令暗卡无进展等待")) {
                      yield* Effect.sleep("260 millis")
                      reply = "耗时命令最终已完成执行。"
                    }

                    yield* bus.publish(SessionEvent.Text.Started, {
                      sessionID,
                      assistantMessageID,
                      ordinal: 0,
                    })
                    yield* bus.publish(SessionEvent.Text.Ended, {
                      sessionID,
                      assistantMessageID,
                      ordinal: 0,
                      text: reply,
                    })

                    const after = yield* snapshot.capture()
                    const changedFiles =
                      before && after
                        ? yield* snapshot.files({ from: before, to: after }).pipe(Effect.orDie)
                        : undefined
                    yield* bus.publish(SessionEvent.Step.Ended, {
                      sessionID,
                      assistantMessageID,
                      finish: "stop",
                      cost: Money.USD.zero,
                      tokens: { input: 10, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
                      snapshot: after,
                      files: changedFiles,
                    })
                  }
                  return SessionRunner.DrainResult.Complete()
                }),
            })
          }),
        )

        const baseLoc = AppNodeBuilder.build(
          LayerNode.group([Location.node, Form.node, Snapshot.node, PluginHooks.node, Image.node, Skill.node, Plugin.node]),
          [
            Location.node.replace(Location.boundNode(ref)),
            Project.node.replace(Layer.succeed(Project.Service, projects)),
            Global.node.replace(Layer.succeed(Global.Service, global)),
            Bus.node.replace(Layer.succeed(Bus.Service, bus)),
            Plugin.node.replace(Layer.mock(Plugin.Service, { awaitActivation: Effect.void })),
          ],
        )
        return runnerLayer.pipe(
          Layer.provideMerge(baseLoc),
        ) as unknown as Layer.Layer<LocationServices, FileSystem.DirectoryNotFoundError>
      })
    }),
  ),
  deps: [Bus.node, Database.node, SessionStore.node, Global.node, Project.node, comboGatesNode],
})

const comboIt = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      Bus.node,
      Project.node,
      LocationServiceMap.node,
      SessionProjector.node,
      SessionStore.node,
      SessionExecution.node,
      Session.node,
      Mobile.node,
      comboGatesNode,
    ]),
    [
      Bus.node.replace(Bus.configured({ persist: true })),
      Global.node.replace(tempGlobalLayer),
      LocationServiceMap.node.replace(comboLocationNode),
    ],
  ),
)

describe("end-to-end chained mini-task workflow (isolated sandbox)", () => {
  comboIt.live("chains migration, ACL, project, chat, model, prompt + mid-turn .ps, .sh, .send, .undo, and .stop", () =>
    Effect.gen(function* () {
      const mobile = yield* Mobile.Service
      const gates = yield* ComboGates
      const tmp = yield* tmpdirScoped("pigu-combo-sandbox-")
      const sandboxDir = path.join(tmp.path, "order-mini-task")

      yield* Effect.promise(async () => {
        await fs.mkdir(sandboxDir, { recursive: true })
        await fs.writeFile(
          path.join(sandboxDir, "orders.csv"),
          "item,amount\nkeyboard,150\nmouse,100\nmonitor,200\n",
          "utf8",
        )
        await initGit(sandboxDir)
      })

      // Step 1: Export AL-ROBOT-1 migration code and import it as a working robot
      const migCode = encodeRobotMigrationCode({
        id: "seed_bot",
        name: "组合测试飞书助手",
        platform: "feishu",
        enabled: false,
        ownerID: "ou_owner_combo",
        allowFrom: "ou_owner_combo",
        feishu: { appId: "cli_combo_1", appSecret: "sec_combo_1" },
        createdAt: 1000,
        updatedAt: 1000,
      })
      const imported = yield* mobile.importCode(migCode)
      const bot = yield* mobile.update({ id: imported.id, enabled: false })
      const chatId = "oc_combo_room"

      const sendAs = (text: string, userId = "ou_owner_combo", userName = "大飞鱼") =>
        mobile.simulateInbound({
          robotId: bot.id,
          userId,
          userName,
          chatId,
          text,
        })

      // Step 2: ACL workflow — guest blocked -> owner grants access -> collaborator joins -> check .whoami
      const blockedTeammate = yield* sendAs(".help", "ou_teammate_01", "协作成员小王")
      expect(blockedTeammate.cards[0]?.header?.title).toContain("未授权访问")

      const grantTeammate = yield* sendAs(".access add ou_teammate_01")
      expect(renderCardMarkdownFallback(grantTeammate.cards[0]!)).toContain("ou_teammate_01")

      const teammateWhoami = yield* sendAs(".whoami", "ou_teammate_01", "协作成员小王")
      expect(renderCardMarkdownFallback(teammateWhoami.cards[0]!)).toContain("授权用户")

      // Step 3: Open isolated sandbox project -> create & rename task session -> configure model & effort
      const openProj = yield* sendAs(`.project new ${sandboxDir}`)
      expect(openProj.cards[0]?.header?.title).toContain("已打开并切换项目")

      const newChat = yield* sendAs(".new 订单统计任务")
      expect(newChat.cards[0]?.header?.title).toContain("已新建并切换会话")

      const renameChat = yield* sendAs(".chat name 订单统计与报表")
      expect(renameChat.cards[0]?.header?.title).toContain("会话已重命名")

      const setEffort = yield* sendAs(".m effort high")
      expect(setEffort.cards[0]?.header?.title).toContain("已更新推理强度")

      const setModel = yield* sendAs(".m local/claude-sonnet-4-6")
      expect(setModel.cards[0]?.header?.title).toContain("已切换会话模型")

      // Step 4: Fire real AI Prompt in background fiber + check busy status via .help + inject .ps mid-turn!
      const promptFiber = yield* Effect.forkChild(
        sendAs("请帮我写一个脚本统计 orders.csv 的订单笔数与总金额"),
        { startImmediately: true },
      )
      yield* Deferred.await(gates.steerStepStarted)

      const helpWhileBusy = yield* sendAs(".help")
      const helpBusyMd = renderCardMarkdownFallback(helpWhileBusy.cards[0]!)
      expect(helpBusyMd).toContain("订单统计与报表")
      expect(helpBusyMd).toContain("运行中")
      expect(helpBusyMd).toContain("local/claude-sonnet-4-6")

      // Teammate injects .ps mid-turn while Prompt 1 is still running!
      const psMidTurn = yield* sendAs(".ps 顺便把汇总写入 output/report.md", "ou_teammate_01", "协作成员小王")
      expect(psMidTurn.cards[0]?.header?.title).toContain("已注入补充指令")
      expect(psMidTurn.texts).toEqual([])

      yield* Deferred.succeed(gates.allowSteerCheck, undefined)
      const promptRes = yield* Fiber.join(promptFiber)
      expect(promptRes.texts.length).toBe(1)
      expect(promptRes.texts[0]).toContain("已创建 `calc.js` 统计脚本")
      expect(promptRes.texts[0]).toContain("已按补充要求生成 `output/report.md` 汇总报告")
      expect(promptRes.texts[0]).toContain("订单统计与报表")

      // Step 5: Verify generated code in sandbox via .sh
      const shVerify = yield* sendAs(".sh node calc.js")
      expect(shVerify.cards[0]?.header?.title).toContain("命令执行成功")
      expect(renderCardMarkdownFallback(shVerify.cards[0]!)).toContain('{"count":3,"total":450}')

      // Step 6: List generated files (including subdirectory output/report.md!) via .send and download #1
      const sendList = yield* sendAs(".send")
      const sendListMd = renderCardMarkdownFallback(sendList.cards[0]!)
      expect(sendListMd).toContain("output/report.md")
      expect(sendListMd).toContain("calc.js")

      const reportIdxMatch = sendListMd.match(/#(\d+)\s+output\/report\.md/)
      expect(reportIdxMatch).not.toBeNull()
      const sendReport = yield* sendAs(`.send ${reportIdxMatch![1]}`)
      expect(sendReport.files.length).toBe(1)
      expect(sendReport.files[0]?.fileName).toBe("report.md")

      // Step 7: Accidental destructive prompt -> inspect .chat history -> rollback code & turn via .undo -> re-verify .sh!
      const badTurn = yield* sendAs("把 calc.js 改成破坏性错误版本")
      expect(badTurn.texts[0]).toContain("模拟误改")

      const shBroken = yield* sendAs(".sh node calc.js")
      expect(shBroken.cards[0]?.header?.title).toContain("命令退出码")

      const historyBeforeUndo = yield* sendAs(".chat history")
      expect(renderCardMarkdownFallback(historyBeforeUndo.cards[0]!)).toContain("改成破坏性错误版本")

      const undoRes = yield* sendAs(".undo")
      expect(undoRes.cards[0]?.header?.title).toContain("已撤回上一轮")

      const shRestored = yield* sendAs(".sh node calc.js")
      expect(shRestored.cards[0]?.header?.title).toContain("命令执行成功")
      expect(renderCardMarkdownFallback(shRestored.cards[0]!)).toContain('{"count":3,"total":450}')

      // Step 8: Start a slow runaway prompt -> interrupt mid-flight via .stop -> ensure no bogus "(已完成)" text!
      const slowFiber = yield* Effect.forkChild(sendAs("执行一个耗时很长的全量扫描任务"), { startImmediately: true })
      yield* Deferred.await(gates.slowStepStarted)

      const stopActive = yield* sendAs(".stop")
      expect(stopActive.cards[0]?.header?.title).toContain("已中断当前会话生成")

      const slowInterruptedRes = yield* Fiber.join(slowFiber)
      expect(slowInterruptedRes.texts).toEqual([])

      // Step 9: Revoke teammate access by #1 index, create clean session, delete temporary session
      const revokeTeammate = yield* sendAs(".access rm 1")
      expect(renderCardMarkdownFallback(revokeTeammate.cards[0]!)).not.toContain("ou_teammate_01")

      const afterRevoke = yield* sendAs(".project", "ou_teammate_01", "协作成员小王")
      expect(afterRevoke.cards[0]?.header?.title).toContain("未授权访问")

      const secondChat = yield* sendAs(".new 收尾会话")
      expect(secondChat.cards[0]?.header?.title).toContain("已新建并切换会话")

      const chatList = yield* sendAs(".chat")
      expect(renderCardMarkdownFallback(chatList.cards[0]!)).toContain("收尾会话")
      expect(renderCardMarkdownFallback(chatList.cards[0]!)).toContain("订单统计与报表")
    }),
  )

  it.live("deduplicates repeated create and importCode calls for the same bot account", () =>
    Effect.gen(function* () {
      const mobile = yield* Mobile.Service
      const first = yield* mobile.create({
        name: "个人微信",
        platform: "weixin",
        enabled: false,
        ownerID: "wx_owner_1",
        weixin: {
          token: "wx_tok_1",
          accountId: "wx_bot_001@im.bot",
        },
      })
      const second = yield* mobile.create({
        name: "个人微信",
        platform: "weixin",
        enabled: false,
        ownerID: "wx_owner_1",
        weixin: {
          token: "wx_tok_2",
          accountId: "wx_bot_001@im.bot",
        },
      })
      expect(second.id).toBe(first.id)
      const list = yield* mobile.list()
      const wxRobots = list.filter((r) => r.weixin?.accountId === "wx_bot_001@im.bot")
      expect(wxRobots.length).toBe(1)
      expect(wxRobots[0]?.weixin?.token).toBe("wx_tok_2")
    }),
  )

  it.live("ignores deleted local directories in .project list and falls back cleanly", () =>
    Effect.gen(function* () {
      const mobile = yield* Mobile.Service
      const liveTmp = yield* tmpdirScoped("pigu-mobile-live-")
      const deadTmp = yield* tmpdirScoped("pigu-mobile-dead-")
      const bot = yield* mobile.create({
        name: "目录过滤测试机器人",
        platform: "weixin",
        enabled: false,
        ownerID: "wx_owner_dir",
        weixin: { token: "wx_tok_dir", accountId: "wx_dir_bot@im.bot" },
      })

      yield* mobile.simulateInbound({
        robotId: bot.id,
        userId: "wx_owner_dir",
        chatId: "wx_chat_live",
        text: `.project new ${liveTmp.path}`,
      })
      yield* mobile.simulateInbound({
        robotId: bot.id,
        userId: "wx_owner_dir",
        chatId: "wx_chat_dead",
        text: `.project new ${deadTmp.path}`,
      })

      yield* Effect.promise(() => fs.rm(deadTmp.path, { recursive: true, force: true }))

      const projList = yield* mobile.simulateInbound({
        robotId: bot.id,
        userId: "wx_owner_dir",
        chatId: "wx_chat_dead",
        text: ".project",
      })
      const md = renderCardMarkdownFallback(projList.cards[0]!)
      expect(md).not.toContain(path.basename(deadTmp.path))
      expect(md).toContain(path.basename(liveTmp.path))

      const helpAfterDead = yield* mobile.simulateInbound({
        robotId: bot.id,
        userId: "wx_owner_dir",
        chatId: "wx_chat_dead",
        text: ".help",
      })
      expect(renderCardMarkdownFallback(helpAfterDead.cards[0]!)).toContain("默认项目")
    }),
  )

  comboIt.live("allows immediate zero-setup chatting right after connecting using built-in default workspace", () =>
    Effect.gen(function* () {
      const mobile = yield* Mobile.Service
      const projects = yield* Project.Service
      const tmp = yield* tmpdirScoped("pigu-existing-repo-")
      const codeRepoDir = path.join(tmp.path, "user-secret-repo")
      yield* Effect.promise(async () => {
        await fs.mkdir(codeRepoDir, { recursive: true })
        await initRepo(codeRepoDir)
      })
      yield* projects.resolve(AbsolutePath.make(codeRepoDir))

      const bot = yield* mobile.create({
        name: "扫码即聊微信机器人",
        platform: "weixin",
        enabled: false,
        ownerID: "wx_immediate_user",
        weixin: { token: "wx_tok_imm", accountId: "wx_imm_bot@im.bot" },
      })

      // User immediately chats right after QR login without running .project!
      const chatRes = yield* mobile.simulateInbound({
        robotId: bot.id,
        userId: "wx_immediate_user",
        userName: "大飞鱼",
        chatId: "wx_imm_chat_1",
        text: "你好，刚扫码连上直接聊天",
      })
      expect(chatRes.texts.length).toBe(1)
      expect(chatRes.texts[0]).toContain("已完成处理")
      expect(chatRes.texts[0]).toContain("默认项目")
      expect(chatRes.texts[0]).toContain("默认会话")
      expect(chatRes.texts[0]).not.toContain("user-secret-repo")

      // .model works seamlessly in 默认项目
      const modelRes = yield* mobile.simulateInbound({
        robotId: bot.id,
        userId: "wx_immediate_user",
        chatId: "wx_imm_chat_1",
        text: ".model",
      })
      expect(modelRes.cards[0]?.header?.title).toContain("模型与厂商切换")
    }),
  )

  test("extracts and strips <pigu-mobile-action> butler tags cleanly", () => {
    const raw = [
      "好的，正在为您切换到 pigu 项目并查看版本。",
      '<pigu-mobile-action>{"type":"switch_project","target":"pigu","followUpPrompt":"查看 package.json"}</pigu-mobile-action>',
    ].join("\n")
    const parsed = extractMobileButlerActions(raw)
    expect(parsed.cleanText).toBe("好的，正在为您切换到 pigu 项目并查看版本。")
    expect(parsed.actions).toEqual([
      {
        type: "switch_project",
        target: "pigu",
        followUpPrompt: "查看 package.json",
      },
    ])
  })

  comboIt.live("supports AI natural-language project switching with followUpPrompt relay and native Gemini voice attachments", () =>
    Effect.gen(function* () {
      const mobile = yield* Mobile.Service
      const projects = yield* Project.Service
      const tmp = yield* tmpdirScoped("pigu-butler-voice-")
      const targetRepoDir = path.join(tmp.path, "butler-target-app")
      yield* Effect.promise(async () => {
        await fs.mkdir(targetRepoDir, { recursive: true })
        await fs.writeFile(path.join(targetRepoDir, "PROJECT_ID.txt"), "BUTLER_TARGET_OK_42\n", "utf8")
        await initRepo(targetRepoDir)
      })
      yield* projects.resolve(AbsolutePath.make(targetRepoDir))

      const bot = yield* mobile.create({
        name: "智能管家与语音机器人",
        platform: "weixin",
        enabled: false,
        ownerID: "wx_butler_user",
        weixin: { token: "wx_tok_butler", accountId: "wx_butler_bot@im.bot" },
      })

      // 1. User starts in 默认会话 (默认项目) and asks AI in natural language to switch project + read PROJECT_ID.txt
      const relayRes = yield* mobile.simulateInbound({
        robotId: bot.id,
        userId: "wx_butler_user",
        userName: "大飞鱼",
        chatId: "wx_butler_chat_1",
        text: "自然语言切到项目:butler-target-app 并执行:读取当前项目的标识文件",
      })

      // Should strip <pigu-mobile-action>, emit the switch card, AND relay followUpPrompt in butler-target-app!
      expect(relayRes.cards.some((c) => c.header?.title.includes("已切换项目"))).toBe(true)
      const combinedTexts = relayRes.texts.join("\n")
      expect(combinedTexts).not.toContain("<pigu-mobile-action>")
      expect(combinedTexts).toContain("正在为您切换到 **butler-target-app** 项目")
      expect(combinedTexts).toContain("当前项目标识是：BUTLER_TARGET_OK_42")

      // 2. Switch active session model to Gemini (supports native audio) and send a WAV voice message!
      const switchGemini = yield* mobile.simulateInbound({
        robotId: bot.id,
        userId: "wx_butler_user",
        chatId: "wx_butler_chat_1",
        text: ".model local/gemini-3-flash",
      })
      expect(switchGemini.cards[0]?.header?.title).toContain("已切换会话模型")

      const fakeWavHeader = Uint8Array.from(
        Buffer.from("524946462400000057415645666d74201000000001000100803e0000007d0000020010006461746100000000", "hex"),
      )
      const voiceRes = yield* mobile.simulateInbound({
        robotId: bot.id,
        userId: "wx_butler_user",
        chatId: "wx_butler_chat_1",
        text: "",
        audioAttachments: [
          {
            fileName: "wechat-voice.wav",
            mimeType: "audio/wav",
            data: fakeWavHeader,
          },
        ],
      })
      expect(voiceRes.texts.length).toBe(1)
      expect(voiceRes.texts[0]).toContain("已原生接收语音附件：wechat-voice.wav(audio/wav)")

      // 3. Inbound PNG image + UTF-8 text file from phone -> passed inline to AI & saved to mobile-inbox
      const onePxPng = Uint8Array.from(
        Buffer.from(
          "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082",
          "hex",
        ),
      )
      const inboundMediaRes = yield* mobile.simulateInbound({
        robotId: bot.id,
        userId: "wx_butler_user",
        chatId: "wx_butler_chat_1",
        text: "",
        fileAttachments: [
          {
            fileName: "error-screenshot.png",
            mimeType: "image/png",
            data: onePxPng,
          },
          {
            fileName: "crash.log",
            mimeType: "text/plain",
            data: new Uint8Array(Buffer.from("TypeError: cannot read x\n", "utf8")),
          },
        ],
      })
      expect(inboundMediaRes.texts.length).toBe(1)
      expect(inboundMediaRes.texts[0]).toContain("error-screenshot.png(image/png)")
      expect(inboundMediaRes.texts[0]).toContain("crash.log(text/plain)")

      // 3b. Multiple WeChat images with identical default names + corrupted PNG fallback (never replies "执行出错")
      const multiDupRes = yield* mobile.simulateInbound({
        robotId: bot.id,
        userId: "wx_butler_user",
        chatId: "wx_butler_chat_1",
        text: "对比这三张截图",
        fileAttachments: [
          { fileName: "weixin-image.png", mimeType: "image/png", data: onePxPng },
          { fileName: "weixin-image.png", mimeType: "image/png", data: onePxPng },
          { fileName: "weixin-image.png", mimeType: "image/png", data: onePxPng },
        ],
      })
      expect(multiDupRes.texts.length).toBe(1)
      expect(multiDupRes.texts[0]).not.toContain("执行出错")
      expect(multiDupRes.texts[0]).toContain("weixin-image.png(image/png)")
      expect(multiDupRes.texts[0]).toContain("weixin-image-2.png(image/png)")
      expect(multiDupRes.texts[0]).toContain("weixin-image-3.png(image/png)")

      const corruptedPng = Uint8Array.from(Buffer.from("89504e470d0a1a0a0000000d49484452ffffffff", "hex"))
      const fallbackRes = yield* mobile.simulateInbound({
        robotId: bot.id,
        userId: "wx_butler_user",
        chatId: "wx_butler_chat_1",
        text: "查看这张长截图",
        fileAttachments: [
          { fileName: "weixin-image-1.png", mimeType: "image/png", data: onePxPng },
          { fileName: "weixin-long-shot.png", mimeType: "image/png", data: corruptedPng },
        ],
      })
      expect(fallbackRes.texts.length).toBe(1)
      expect(fallbackRes.texts[0]).not.toContain("执行出错")

      // 4. AI generates and proactively delivers a file back to phone via <pigu-mobile-action type="send_file">
      const aiSendRes = yield* mobile.simulateInbound({
        robotId: bot.id,
        userId: "wx_butler_user",
        chatId: "wx_butler_chat_1",
        text: "请帮我 生成并发送文件:summary-report.md",
      })
      expect(aiSendRes.texts[0]).toContain("已生成 `summary-report.md` 并推送到您的手机")
      expect(aiSendRes.texts[0]).not.toContain("<pigu-mobile-action>")
      expect(aiSendRes.files.length).toBe(1)
      expect(aiSendRes.files[0]?.fileName).toBe("summary-report.md")
      expect(aiSendRes.files[0]?.size).toBeGreaterThan(10)

      // 5. Long-task live progress feedback (Feishu card progress + WeChat text progress)
      const feishuBot = yield* mobile.create({
        name: "飞书长任务进度测试",
        platform: "feishu",
        enabled: false,
        ownerID: "ou_prog_user",
        feishu: { appId: "cli_prog_1", appSecret: "sec_prog_1" },
      })
      const progRes = yield* mobile.simulateInbound({
        robotId: feishuBot.id,
        userId: "ou_prog_user",
        chatId: "oc_prog_chat",
        text: "请帮我 执行长耗时代码审计",
        progressDelayMs: 40,
      })
      expect(progRes.progressUpdates.length).toBeGreaterThanOrEqual(1)
      expect(progRes.progressUpdates[0]).toContain("⏳ AI 正在处理中")
      expect(progRes.texts[0]).toContain("长耗时代码审计已完成")

      // 6. Multi-step silent execution: notify ONLY once on completion while preserving intermediate AI content!
      const multiFeishuRes = yield* mobile.simulateInbound({
        robotId: feishuBot.id,
        userId: "ou_prog_user",
        chatId: "oc_prog_chat",
        text: "请帮我 执行多步静默重构任务",
        progressDelayMs: 30,
      })
      // Only 1 completion notification message sent (never 1 per sentence!)
      expect(multiFeishuRes.texts.length).toBe(1)
      expect(multiFeishuRes.texts[0]).toContain("多步重构已全部完成，所有测试均通过！")
      expect(multiFeishuRes.texts[0]).not.toContain("第一步：我正在读取 auth.ts")
      // Intermediate content was streamed silently in-place AND preserved in the final collapsed process card!
      const settledProcessCard = multiFeishuRes.progressUpdates[multiFeishuRes.progressUpdates.length - 1] ?? ""
      expect(settledProcessCard).toContain("📋 执行过程记录")
      expect(settledProcessCard).toContain("（已折叠）")
      expect(settledProcessCard).toContain("第一步：我正在读取 auth.ts")
      expect(settledProcessCard).toContain("第二步：我已经修改了 auth.ts")

      // On WeChat (non-editable platform): 0 mid-task notifications, 1 final message with result + intermediate digest + .log!
      const multiWeixinRes = yield* mobile.simulateInbound({
        robotId: bot.id,
        userId: "wx_butler_user",
        chatId: "wx_butler_chat_1",
        text: "请帮我 执行多步静默重构任务",
        progressDelayMs: 30,
      })
      expect(multiWeixinRes.texts.length).toBe(1)
      expect(multiWeixinRes.texts[0]).toContain("多步重构已全部完成，所有测试均通过！")
      expect(multiWeixinRes.texts[0]).toContain("📋 **中间执行过程")
      expect(multiWeixinRes.texts[0]).toContain("第一步：我正在读取 auth.ts")
      expect(multiWeixinRes.texts[0]).toContain("第二步：我已经修改了 auth.ts")

      const logCardRes = yield* mobile.simulateInbound({
        robotId: bot.id,
        userId: "wx_butler_user",
        chatId: "wx_butler_chat_1",
        text: ".log",
      })
      const logMd = renderCardMarkdownFallback(logCardRes.cards[0]!)
      expect(logMd).toContain("最近一轮中间执行明细")
      expect(logMd).toContain("第一步：我正在读取 auth.ts")
      expect(logMd).toContain("第二步：我已经修改了 auth.ts")

      // 7. Interactive Q&A (question tool / Form.Service):
      //    - Immediately pushes notification card when AI pauses to ask questions!
      //    - Supports sequential option-index + multiselect replies on WeChat AND button actions / .skip on Feishu!
      const waitForFormCreated = Effect.gen(function* () {
        const bus = yield* Bus.Service
        const deferred = yield* Deferred.make<Form.Info>()
        const subFiber = yield* Effect.forkChild(
          Stream.runForEach(bus.subscribe(Form.Event.Created), (ev) =>
            Deferred.succeed(deferred, ev.data.form).pipe(Effect.asVoid),
          ),
          { startImmediately: true },
        )
        return {
          awaitForm: Deferred.await(deferred),
          cleanup: Fiber.interrupt(subFiber),
        }
      })

      // 7a. WeChat multi-question Q&A (Question 1: single-select #1, Question 2: multiselect 1,3)
      const wxFormWaiter = yield* waitForFormCreated
      const wxQaTurnFiber = yield* Effect.forkChild(
        mobile.simulateInbound({
          robotId: bot.id,
          userId: "wx_butler_user",
          chatId: "wx_butler_chat_1",
          text: "请帮我 搭建持久层并询问需求",
          progressDelayMs: 30,
        }),
        { startImmediately: true },
      )

      const wxCreatedForm = yield* wxFormWaiter.awaitForm
      yield* wxFormWaiter.cleanup
      expect(wxCreatedForm.fields.length).toBe(2)

      // Allow the real-time notification push to land on captureConnector
      yield* Effect.sleep("40 millis")

      // User answers Question 1 ("1" -> SQLite (Recommended)) -> receives Question 2 prompt!
      const ans1Res = yield* mobile.simulateInbound({
        robotId: bot.id,
        userId: "wx_butler_user",
        chatId: "wx_butler_chat_1",
        text: "1",
      })
      expect(ans1Res.texts.length).toBe(0)
      expect(ans1Res.cards.length).toBe(1)
      const q2PromptMd = renderCardMarkdownFallback(ans1Res.cards[0]!)
      expect(q2PromptMd).toContain("SQLite (Recommended)")
      expect(q2PromptMd).toContain("附加能力")

      // User answers Question 2 ("1,3" -> 自动备份 + 慢查询日志) -> submits form and unblocks AI!
      const ans2Res = yield* mobile.simulateInbound({
        robotId: bot.id,
        userId: "wx_butler_user",
        chatId: "wx_butler_chat_1",
        text: "1,3",
      })
      expect(ans2Res.texts.length).toBe(0)
      expect(ans2Res.cards[0]?.header?.title).toContain("已确认需求")

      const wxQaFinalRes = yield* Fiber.join(wxQaTurnFiber)
      // Phone received 1 proactive question notification card + 1 final completion message!
      expect(wxQaFinalRes.cards.length).toBe(1)
      expect(wxQaFinalRes.cards[0]?.header?.title).toContain("❓ AI 需要确认需求")
      expect(wxQaFinalRes.texts.length).toBe(1)
      expect(wxQaFinalRes.texts[0]).toContain("数据库=SQLite (Recommended)")
      expect(wxQaFinalRes.texts[0]).toContain("模块=自动备份+慢查询日志")

      // 7b. Feishu interactive card button action (`qa:<formId>:2`) + Schema 1.0 `action` buttons check!
      const fsFormWaiter = yield* waitForFormCreated
      const fsQaTurnFiber = yield* Effect.forkChild(
        mobile.simulateInbound({
          robotId: feishuBot.id,
          userId: "ou_prog_user",
          chatId: "oc_prog_chat",
          text: "请帮我 确认部署环境单选问答",
          progressDelayMs: 30,
        }),
        { startImmediately: true },
      )

      const fsCreatedForm = yield* fsFormWaiter.awaitForm
      yield* fsFormWaiter.cleanup
      yield* Effect.sleep("40 millis")

      // Tap button #2 (Production) via Feishu cardAction!
      const clickRes = yield* mobile.simulateInbound({
        robotId: feishuBot.id,
        userId: "ou_prog_user",
        chatId: "oc_prog_chat",
        text: "",
        cardAction: `qa:${fsCreatedForm.id}:2`,
      })
      expect(clickRes.cards[0]?.header?.title).toContain("已确认需求")

      const fsQaFinalRes = yield* Fiber.join(fsQaTurnFiber)
      expect(fsQaFinalRes.cards.length).toBe(1)
      const renderedFeishuQaCard = renderFeishuCardObject(fsQaFinalRes.cards[0]!, "feishu:bot:chat")
      expect(JSON.stringify(renderedFeishuQaCard)).toContain(`qa:${fsCreatedForm.id}:1`)
      expect(JSON.stringify(renderedFeishuQaCard)).toContain(`qa:${fsCreatedForm.id}:2`)
      expect(fsQaFinalRes.texts.length).toBe(1)
      expect(fsQaFinalRes.texts[0]).toContain("已完成向 **Production** 环境的发布！")

      // 7c. Skipping a question with `.skip` lets AI proceed with its recommended default!
      const skipFormWaiter = yield* waitForFormCreated
      const skipQaTurnFiber = yield* Effect.forkChild(
        mobile.simulateInbound({
          robotId: feishuBot.id,
          userId: "ou_prog_user",
          chatId: "oc_prog_chat",
          text: "请再次 确认部署环境单选问答",
          progressDelayMs: 30,
        }),
        { startImmediately: true },
      )
      yield* skipFormWaiter.awaitForm
      yield* skipFormWaiter.cleanup
      yield* Effect.sleep("40 millis")

      const skipRes = yield* mobile.simulateInbound({
        robotId: feishuBot.id,
        userId: "ou_prog_user",
        chatId: "oc_prog_chat",
        text: ".skip",
      })
      expect(skipRes.cards[0]?.header?.title).toContain("已跳过问答")
      const skipFinalRes = yield* Fiber.join(skipQaTurnFiber)
      expect(skipFinalRes.texts[0]).toContain("已按默认推荐 Staging 环境完成发布！")
    }),
  )

  comboIt.live(
    "covers 4 mobile resilience paths: natural mid-turn steer, 429 retry + hard error alert, desktop/schedule background push, and stall watchdog",
    () =>
      Effect.gen(function* () {
        const mobile = yield* Mobile.Service
        const sessions = yield* Session.Service
        const gates = yield* ComboGates
        const tmp = yield* tmpdirScoped("pigu-resilience-")
        const projDir = path.join(tmp.path, "resilience-proj")
        yield* Effect.promise(async () => {
          await fs.mkdir(projDir, { recursive: true })
          await initGit(projDir)
        })

        const fsBot = yield* mobile.create({
          name: "飞书韧性测试助手",
          platform: "feishu",
          enabled: false,
          ownerID: "ou_res_user",
          allowFrom: "ou_res_user",
          feishu: { appId: "cli_res_001", appSecret: "sec_res_001" },
        })
        const chatId = "oc_resilience_room"
        const sessionKey = `feishu:${fsBot.id}:${chatId}`

        yield* mobile.simulateInbound({
          robotId: fsBot.id,
          userId: "ou_res_user",
          chatId,
          text: `.project new ${projDir}`,
        })
        yield* mobile.simulateInbound({
          robotId: fsBot.id,
          userId: "ou_res_user",
          chatId,
          text: ".new 四大突发场景联调",
        })

        // 1. Mid-turn natural message steer coalescing (no `.ps` prefix needed, 0 duplicate replies!)
        const turn1Fiber = yield* Effect.forkChild(
          mobile.simulateInbound({
            robotId: fsBot.id,
            userId: "ou_res_user",
            chatId,
            text: "请帮我 重构登录模块自然插话测试",
            progressDelayMs: 30,
          }),
          { startImmediately: true },
        )
        yield* Deferred.await(gates.naturalSteerStarted)

        const naturalSteerRes = yield* mobile.simulateInbound({
          robotId: fsBot.id,
          userId: "ou_res_user",
          chatId,
          text: "对了，顺便把覆盖率报告也补上",
        })
        expect(naturalSteerRes.texts.length).toBe(0)
        expect(naturalSteerRes.cards.length).toBe(1)
        expect(naturalSteerRes.cards[0]?.header?.title).toContain("已收到补充指令")
        expect(renderCardMarkdownFallback(naturalSteerRes.cards[0]!)).toContain("顺便把覆盖率报告也补上")

        yield* Deferred.succeed(gates.allowNaturalSteerFinish, undefined)
        const turn1Final = yield* Fiber.join(turn1Fiber)
        expect(turn1Final.texts.length).toBe(1)
        expect(turn1Final.texts[0]).toContain("已完成登录模块 login.ts 重构")
        expect(turn1Final.texts[0]).toContain("已按中途补充指令生成覆盖率报告")

        // 2a. 429 Rate Limit backoff visibility in live status / progress
        const retryFiber = yield* Effect.forkChild(
          mobile.simulateInbound({
            robotId: fsBot.id,
            userId: "ou_res_user",
            chatId,
            text: "请执行 模拟上游429限流退避重试",
            progressDelayMs: 30,
          }),
          { startImmediately: true },
        )
        yield* Deferred.await(gates.retryStepStarted)
        yield* Effect.sleep("40 millis")

        const helpDuringRetry = yield* mobile.simulateInbound({
          robotId: fsBot.id,
          userId: "ou_res_user",
          chatId,
          text: ".help",
        })
        expect(renderCardMarkdownFallback(helpDuringRetry.cards[0]!)).toContain("退避等待第 2 次自动重试")

        yield* Deferred.succeed(gates.allowRetryFinish, undefined)
        const retryFinal = yield* Fiber.join(retryFiber)
        expect(retryFinal.texts.length).toBe(1)
        expect(retryFinal.texts[0]).toContain("限流恢复后已完成推理")

        // 2b. Mid-turn Hard Failure (402 Quota Exhausted after Step 1 text) -> Immediate RED Alert Card!
        const crashRes = yield* mobile.simulateInbound({
          robotId: fsBot.id,
          userId: "ou_res_user",
          chatId,
          text: "请执行 模拟中途配额耗尽硬性报错",
          progressDelayMs: 30,
        })
        expect(crashRes.texts.length).toBe(0)
        expect(crashRes.cards.length).toBe(1)
        expect(crashRes.cards[0]?.header?.color).toBe("red")
        expect(crashRes.cards[0]?.header?.title).toContain("🔴 任务异常中断")
        const crashMd = renderCardMarkdownFallback(crashRes.cards[0]!)
        expect(crashMd).toContain("402 Insufficient API Quota")
        expect(crashMd).toContain("我先检查一下构建目录结构")
        expect(crashMd).toContain(".model")

        // Switch to a clean session for 3 & 4
        yield* mobile.simulateInbound({
          robotId: fsBot.id,
          userId: "ou_res_user",
          chatId,
          text: ".new 跨端与巡检会话",
        })

        // Find bound sessionID for direct Desktop & Schedule wakeup tests
        const listedSessions = yield* sessions.list({ limit: 10 })
        const boundSession = listedSessions.data.find((s) => s.title === "跨端与巡检会话")
        expect(boundSession).toBeDefined()
        const boundSessionID = boundSession!.id

        // Clear any prior outbox items
        yield* mobile.drainBackgroundOutbox(sessionKey)

        // 3a. Desktop-initiated turn (started directly via Session.Service, NOT mobile!) -> pushes to mobile!
        yield* sessions.prompt({
          sessionID: boundSessionID,
          text: "执行 桌面端直接发起的长重构任务",
        })
        yield* sessions.wait(boundSessionID)

        const pollOutbox = Effect.gen(function* () {
          const deadline = Date.now() + 3_000
          while (Date.now() < deadline) {
            const box = yield* mobile.drainBackgroundOutbox(sessionKey)
            if (box.texts.length > 0 || box.cards.length > 0) return box
            yield* Effect.sleep("25 millis")
          }
          return { cards: [], texts: [] }
        })

        const desktopPush = yield* pollOutbox
        expect(desktopPush.texts.length).toBe(1)
        expect(desktopPush.texts[0]).toContain("🖥️ **[桌面端任务已完成]**")
        expect(desktopPush.texts[0]).toContain("桌面端重构已完成，共清理 4 个冗余模块")

        // 3b. Scheduled cron/timer or Subagent wakeup (`sessions.synthetic`) -> pushes `⏰` to mobile!
        yield* sessions.synthetic({
          sessionID: boundSessionID,
          description: "定时巡检任务",
          text: "执行 定时巡检线上训练日志",
        })
        yield* sessions.wait(boundSessionID)

        const schedulePush = yield* pollOutbox
        expect(schedulePush.texts.length).toBe(1)
        expect(schedulePush.texts[0]).toContain("⏰ **[定时 / 后台子智能体任务已完成]**")
        expect(schedulePush.texts[0]).toContain("训练日志巡检正常，Loss 已收敛至 0.041")

        // 4. Stall Watchdog (`stallTimeoutMs: 90` when command hangs silently for 260ms) -> 1 orange warning card!
        const stallRes = yield* mobile.simulateInbound({
          robotId: fsBot.id,
          userId: "ou_res_user",
          chatId,
          text: "请运行 模拟终端命令暗卡无进展等待",
          progressDelayMs: 30,
          stallTimeoutMs: 90,
        })
        expect(stallRes.cards.length).toBe(1)
        expect(stallRes.cards[0]?.header?.color).toBe("orange")
        expect(stallRes.cards[0]?.header?.title).toContain("⚠️ 任务长时间无新进展提醒")
        expect(stallRes.texts.length).toBe(1)
        expect(stallRes.texts[0]).toContain("耗时命令最终已完成执行")
      }),
  )

  comboIt.live(
    "sleep-prevention guard settings & SSH remote Mobile Butler parity (Pigu + vanilla opencode + ~/ and /tmp files)",
    () =>
      Effect.gen(function* () {
        const mobile = yield* Mobile.Service

        let piguRemoteMode = true
        const promptCalls: Array<{ sessionId: string; body: Record<string, unknown> }> = []
        const syntheticCalls: Array<{ sessionId: string; body: Record<string, unknown> }> = []
        const fsReadCalls: Array<{ path: string; dir: string }> = []
        const patchedModels: Array<{ providerID: string; id: string }> = []
        const remoteMessages = new Map<string, Array<Record<string, unknown>>>()
        let msgSeq = 1
        let activeRemoteModel = { providerID: "anthropic", id: "claude-sonnet-4-5" }

        const remoteServer = Bun.serve({
          port: 0,
          hostname: "127.0.0.1",
          async fetch(req) {
            const url = new URL(req.url)
            const pathname = url.pathname

            if (pathname.includes("getupdates")) {
              return Response.json({ ret: 0, msgs: [], get_updates_buf: "buf_ok" })
            }

            if (pathname === "/api/experimental/mobile/robots") {
              if (piguRemoteMode) return Response.json({ data: [] })
              return new Response("Not Found", { status: 404 })
            }

            if (pathname === "/api/project" && req.method === "GET") {
              return Response.json([
                {
                  id: "proj_autodl_1",
                  name: "autodl-train",
                  canonical: "/root/autodl-tmp/autodl-train",
                  time: { created: 1000, updated: 2000, active: 2000 },
                },
              ])
            }

            if (pathname === "/api/session" && req.method === "GET") {
              return Response.json({
                data: [
                  {
                    id: "ses_remote_1",
                    title: "GPU 训练会话",
                    model: activeRemoteModel,
                    time: { created: 1000, updated: 2000 },
                  },
                ],
              })
            }

            if (pathname === "/api/session" && req.method === "POST") {
              const body = (await req.json()) as { location?: { directory?: string }; title?: string }
              const createdId = `ses_remote_new_${msgSeq++}`
              return Response.json({
                data: {
                  id: createdId,
                  projectID: "proj_autodl_new",
                  title: body.title ?? "远程新会话",
                  location: { directory: body.location?.directory ?? "/root/code" },
                },
              })
            }

            if (pathname === "/api/session/active" && req.method === "GET") {
              return Response.json({ data: {} })
            }

            if (pathname === "/api/model" && req.method === "GET") {
              return Response.json({
                data: [
                  {
                    providerID: "anthropic",
                    id: "claude-sonnet-4-5",
                    name: "Claude Sonnet 4.5",
                    capabilities: { input: ["text", "image", "pdf"] },
                  },
                  {
                    providerID: "openai",
                    id: "gpt-5",
                    name: "GPT-5",
                    capabilities: { input: ["text", "image"] },
                  },
                ],
              })
            }

            if (pathname === "/api/session/ses_remote_1" && req.method === "GET") {
              return Response.json({
                data: {
                  id: "ses_remote_1",
                  title: "GPU 训练会话",
                  model: activeRemoteModel,
                },
              })
            }

            if (pathname === "/api/session/ses_remote_1/model" && req.method === "POST") {
              const body = (await req.json()) as { model?: { providerID: string; id: string } }
              if (body.model) {
                activeRemoteModel = body.model
                patchedModels.push(body.model)
              }
              return new Response(null, { status: 204 })
            }

            if (pathname === "/api/session/ses_remote_1/synthetic" && req.method === "POST") {
              const body = (await req.json()) as Record<string, unknown>
              syntheticCalls.push({ sessionId: "ses_remote_1", body })
              const synId = `msg_syn_${msgSeq++}`
              const list = remoteMessages.get("ses_remote_1") ?? []
              list.push({ id: synId, type: "synthetic", text: String(body.text ?? "") })
              remoteMessages.set("ses_remote_1", list)
              return Response.json({ data: { id: synId } })
            }

            if (pathname === "/api/session/ses_remote_1/prompt" && req.method === "POST") {
              const body = (await req.json()) as Record<string, unknown>
              promptCalls.push({ sessionId: "ses_remote_1", body })
              const userId = `msg_usr_${msgSeq++}`
              const asstId = `msg_ast_${msgSeq++}`
              const userText = String(body.text ?? "")
              const list = remoteMessages.get("ses_remote_1") ?? []
              list.push({ id: userId, type: "user", text: userText })

              const replyText = userText.includes("发送训练曲线和报告")
                ? [
                    "好的，这就把远端生成的曲线和总结发到你手机上。",
                    '<pigu-mobile-action>{"type":"send_file","target":"/tmp/loss_curve.png"}</pigu-mobile-action>',
                    '<pigu-mobile-action>{"type":"send_file","target":"~/train_summary.md"}</pigu-mobile-action>',
                  ].join("\n")
                : userText.includes("自然语言切到gpt5")
                  ? '好的，立即为你把远程训练会话切换到 GPT-5。\n<pigu-mobile-action>{"type":"switch_model","target":"openai/gpt-5"}</pigu-mobile-action>'
                  : "远程会话普通回复正常。"

              list.push({
                id: asstId,
                type: "assistant",
                content: [{ type: "text", text: replyText }],
              })
              remoteMessages.set("ses_remote_1", list)
              return Response.json({ data: { id: userId } })
            }

            if (pathname === "/api/experimental/session/ses_remote_1/wait" && req.method === "POST") {
              return new Response(null, { status: 204 })
            }

            if (pathname === "/api/session/ses_remote_1/context" && req.method === "GET") {
              return Response.json({ data: remoteMessages.get("ses_remote_1") ?? [] })
            }

            if (pathname === "/api/session/ses_remote_1/form" && req.method === "GET") {
              return Response.json({ data: [] })
            }

            if (pathname === "/api/session/ses_remote_1/permission" && req.method === "GET") {
              return Response.json({ data: [] })
            }

            if (pathname.startsWith("/api/fs/read/") && req.method === "GET") {
              const relFile = decodeURIComponent(pathname.slice("/api/fs/read/".length))
              const locDir = url.searchParams.get("location[directory]") ?? ""
              fsReadCalls.push({ path: relFile, dir: locDir })
              if (locDir === "/tmp" && relFile === "loss_curve.png") {
                return new Response(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), {
                  status: 200,
                })
              }
              if (locDir === "/root" && relFile === "train_summary.md") {
                return new Response("# AutoDL Training Summary\nLoss: 0.012\n", { status: 200 })
              }
              return new Response("Not Found", { status: 404 })
            }

            return new Response("Not Found", { status: 404 })
          },
        })

        yield* Effect.addFinalizer(() => Effect.sync(() => remoteServer.stop(true)))
        const baseUrl = `http://127.0.0.1:${remoteServer.port}`

        // 1. Sleep-prevention settings lifecycle
        const initialSettings = yield* mobile.settings()
        expect(initialSettings.preventSleep).toBe(true)
        expect(initialSettings.active).toBe(false)

        const bot = yield* mobile.create({
          name: "睡眠守护与SSH管家机器人",
          platform: "weixin",
          enabled: true,
          ownerID: "wx_ssh_owner",
          weixin: {
            token: "tok_local_loopback",
            baseUrl,
          },
        })

        const activeSettings = yield* mobile.settings()
        expect(activeSettings.preventSleep).toBe(true)
        expect(activeSettings.active).toBe(true)

        const pausedSettings = yield* mobile.updateSettings({ preventSleep: false })
        expect(pausedSettings.preventSleep).toBe(false)
        expect(pausedSettings.active).toBe(false)

        const resumedSettings = yield* mobile.updateSettings({ preventSleep: true })
        expect(resumedSettings.preventSleep).toBe(true)
        expect(resumedSettings.active).toBe(true)

        yield* mobile.update({ id: bot.id, enabled: false })
        const disabledBotSettings = yield* mobile.settings()
        expect(disabledBotSettings.preventSleep).toBe(true)
        expect(disabledBotSettings.active).toBe(false)

        // 2. Remote SSH Butler Parity — Mode A: Pigu SSH server (uses metadata.mobileButlerPrompt, 0 synthetic bloat)
        piguRemoteMode = true
        yield* mobile.syncRemotes([{ key: "autodl-pigu", name: "AutoDL-Pigu", url: baseUrl }])

        const swProj1 = yield* mobile.simulateInbound({
          robotId: bot.id,
          userId: "wx_ssh_owner",
          chatId: "chat_ssh_1",
          text: ".project autodl-train",
        })
        expect(swProj1.cards[0]?.header?.title).toContain("已切换项目")

        // Also verify `.project new ~/workspace-exp` on an SSH-bound chat (or `autodl-pigu:~/...`) expands `~` to `/root/workspace-exp`
        yield* mobile.simulateInbound({
          robotId: bot.id,
          userId: "wx_ssh_owner",
          chatId: "chat_ssh_open",
          text: ".project autodl-train",
        })
        const openRemoteHome = yield* mobile.simulateInbound({
          robotId: bot.id,
          userId: "wx_ssh_owner",
          chatId: "chat_ssh_open",
          text: ".project new ~/workspace-exp",
        })
        expect(renderCardMarkdownFallback(openRemoteHome.cards[0]!)).toContain("/root/workspace-exp")

        const sendFilesRes = yield* mobile.simulateInbound({
          robotId: bot.id,
          userId: "wx_ssh_owner",
          chatId: "chat_ssh_1",
          text: "请帮我 发送训练曲线和报告",
        })
        expect(syntheticCalls.length).toBe(0)
        expect(promptCalls.length).toBe(1)
        const promptMeta = promptCalls[0]?.body.metadata as Record<string, unknown> | undefined
        expect(typeof promptMeta?.mobileButlerPrompt).toBe("string")
        expect(String(promptMeta?.mobileButlerPrompt)).toContain("# Pigu 手机端智能管家上下文")
        expect(String(promptMeta?.mobileButlerPrompt)).toContain("SSH:AutoDL-Pigu")
        expect(sendFilesRes.texts[0]).toContain("这就把远端生成的曲线和总结发到你手机上")
        expect(sendFilesRes.texts[0]).not.toContain("<pigu-mobile-action>")
        expect(sendFilesRes.files.map((f) => f.fileName)).toEqual(["loss_curve.png", "train_summary.md"])
        expect(fsReadCalls).toEqual([
          { path: "loss_curve.png", dir: "/tmp" },
          { path: "train_summary.md", dir: "/root" },
        ])

        // 3. Remote SSH Butler Parity — Mode B: Vanilla upstream opencode SSH server (404 on mobile API -> deduplicated hidden synthetic)
        piguRemoteMode = false
        yield* mobile.syncRemotes([{ key: "autodl-vanilla", name: "AutoDL-Vanilla", url: baseUrl }])

        const swProj2 = yield* mobile.simulateInbound({
          robotId: bot.id,
          userId: "wx_ssh_owner",
          chatId: "chat_ssh_2",
          text: ".project autodl-train",
        })
        expect(swProj2.cards[0]?.header?.title).toContain("已切换项目")

        const vanillaChat1 = yield* mobile.simulateInbound({
          robotId: bot.id,
          userId: "wx_ssh_owner",
          chatId: "chat_ssh_2",
          text: "你好，汇报一下连接情况",
        })
        expect(vanillaChat1.texts[0]).toContain("远程会话普通回复正常")
        expect(syntheticCalls.length).toBe(1)
        expect(syntheticCalls[0]?.body.resume).toBe(false)
        expect(syntheticCalls[0]?.body.description).toBeUndefined()
        expect(String(syntheticCalls[0]?.body.text)).toContain("SSH:AutoDL-Vanilla")

        // Second message with unchanged snapshot does NOT re-inject duplicate synthetic message!
        const vanillaSwitchModel = yield* mobile.simulateInbound({
          robotId: bot.id,
          userId: "wx_ssh_owner",
          chatId: "chat_ssh_2",
          text: "帮我 自然语言切到gpt5",
        })
        expect(syntheticCalls.length).toBe(1)
        expect(patchedModels).toEqual([{ providerID: "openai", id: "gpt-5" }])
        expect(vanillaSwitchModel.cards.some((c) => c.header?.title?.includes("已切换会话模型"))).toBe(true)
      }),
  )

  comboIt.live(
    "discovers remote non-git global directories, ses_ext_codex_* sessions, colon-prefixed SSH keys, remote .send listing, and disconnect guard",
    () =>
      Effect.gen(function* () {
        const mobile = yield* Mobile.Service
        const extSessionId = "ses_ext_codex_remote_99"
        let activeModel = { providerID: "local/codex", id: "gpt-6.1-sol" }
        const remoteHistory: Array<{
          id: string
          type: string
          text?: string
          model?: { providerID: string; id: string }
          content?: Array<{ type: string; text?: string }>
        }> = [
          { id: "msg_ext_1", type: "user", text: "记住远端暗号 ORION-77" },
          {
            id: "msg_ext_2",
            type: "assistant",
            model: { providerID: "local/codex", id: "gpt-6.1-sol" },
            content: [{ type: "text", text: "已记住远端暗号 ORION-77。" }],
          },
        ]

        const remoteServer = Bun.serve({
          port: 0,
          hostname: "127.0.0.1",
          async fetch(req) {
            const url = new URL(req.url)
            const pathname = url.pathname
            if (pathname === "/api/experimental/mobile/robots") {
              return Response.json([])
            }
            if (pathname === "/api/project") {
              return Response.json([])
            }
            if (pathname === "/api/session" && req.method === "GET") {
              const proj = url.searchParams.get("project")
              if (proj === "global") {
                return Response.json({
                  data: [
                    {
                      id: extSessionId,
                      title: "AutoDL Codex 训练排查",
                      location: { directory: "/root/autodl-tmp" },
                      model: activeModel,
                      time: { updated: Date.now() + 5_000 },
                    },
                  ],
                })
              }
              return Response.json({ data: [] })
            }
            if (pathname === "/api/session" && req.method === "POST") {
              const body = (await req.json()) as { location?: { directory?: string } }
              const dir = body.location?.directory ?? "/root/exp2"
              return Response.json({
                data: {
                  id: "ses_remote_created",
                  projectID: "global",
                  location: { directory: dir },
                },
              })
            }
            if (pathname === `/api/session/${extSessionId}` && req.method === "GET") {
              return Response.json({
                data: {
                  id: extSessionId,
                  title: "AutoDL Codex 训练排查",
                  model: activeModel,
                },
              })
            }
            if (pathname === "/api/session/active") {
              return Response.json({ data: {} })
            }
            if (pathname === "/api/model/default") {
              return Response.json({ data: activeModel })
            }
            if (pathname === "/api/model") {
              return Response.json({
                data: [
                  { providerID: "local/codex", id: "gpt-6.1-sol", name: "GPT-6.1 Sol (Codex CLI)" },
                  { providerID: "pigutoken", id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash" },
                ],
              })
            }
            if (pathname === `/api/session/${extSessionId}/model` && req.method === "POST") {
              const body = (await req.json()) as { model: { providerID: string; id: string } }
              activeModel = { providerID: body.model.providerID, id: body.model.id }
              return new Response(null, { status: 204 })
            }
            if (pathname === `/api/session/${extSessionId}/context` && req.method === "GET") {
              return Response.json({ data: remoteHistory })
            }
            if (pathname === `/api/session/${extSessionId}/prompt` && req.method === "POST") {
              const body = (await req.json()) as { text?: string }
              const uid = `msg_u_${remoteHistory.length + 1}`
              remoteHistory.push({ id: uid, type: "user", text: body.text ?? "" })
              remoteHistory.push({
                id: `msg_a_${remoteHistory.length + 1}`,
                type: "assistant",
                model: activeModel,
                content: [{ type: "text", text: `远端 ${activeModel.providerID}/${activeModel.id} 复述暗号 ORION-77` }],
              })
              return Response.json({ data: { id: uid } })
            }
            if (pathname === `/api/experimental/session/${extSessionId}/wait` && req.method === "POST") {
              return new Response(null, { status: 204 })
            }
            if (pathname === `/api/session/${extSessionId}/form` || pathname === `/api/session/${extSessionId}/permission`) {
              return Response.json({ data: [] })
            }
            if (pathname === "/api/fs/list" && req.method === "GET") {
              return Response.json({
                data: [
                  { path: "metrics.json", type: "file" },
                  { path: "checkpoints", type: "directory" },
                ],
              })
            }
            if (pathname === "/api/fs/read/metrics.json" && req.method === "GET") {
              return new Response('{"acc":0.992}\n', { status: 200 })
            }
            return new Response("Not Found", { status: 404 })
          },
        })
        yield* Effect.addFinalizer(() => Effect.sync(() => remoteServer.stop(true)))
        const baseUrl = `http://127.0.0.1:${remoteServer.port}`

        const bot = yield* mobile.create({
          name: "飞书SSH测试机器人",
          platform: "feishu",
          enabled: false,
          ownerID: "ou_feishu_owner",
          feishu: { appId: "cli_test_ssh", appSecret: "sec_test_ssh" },
        })

        // Desktop SSH GUI plugin keys contain colons (`ssh:<id>`)
        yield* mobile.syncRemotes([{ key: "ssh:9f4a8b12", name: "AutoDL-GPU", url: baseUrl }])

        const projList = yield* mobile.simulateInbound({
          robotId: bot.id,
          userId: "ou_feishu_owner",
          chatId: "oc_feishu_ssh",
          text: ".project",
        })
        const projMd = renderCardMarkdownFallback(projList.cards[0]!)
        expect(projMd).toContain("autodl-tmp")
        expect(projMd).toContain("SSH:AutoDL-GPU")

        // Colon-prefixed SSH key switch (`ssh:9f4a8b12:/root/autodl-tmp`) works cleanly
        const swProj = yield* mobile.simulateInbound({
          robotId: bot.id,
          userId: "ou_feishu_owner",
          chatId: "oc_feishu_ssh",
          text: ".project ssh:9f4a8b12:/root/autodl-tmp",
        })
        expect(swProj.cards[0]?.header?.title).toContain("已切换项目")
        expect(renderCardMarkdownFallback(swProj.cards[0]!)).toContain("AutoDL Codex 训练排查")

        // Friendly server name prefix (`AutoDL-GPU:~/exp2`) also works for `.project new`
        const openByName = yield* mobile.simulateInbound({
          robotId: bot.id,
          userId: "ou_feishu_owner",
          chatId: "oc_feishu_ssh_exp",
          text: ".project new AutoDL-GPU:~/exp2",
        })
        expect(renderCardMarkdownFallback(openByName.cards[0]!)).toContain("/root/exp2")

        // `.chat` lists external Codex CLI session (`ses_ext_codex_*`) and `.history` reads its turns
        const chatList = yield* mobile.simulateInbound({
          robotId: bot.id,
          userId: "ou_feishu_owner",
          chatId: "oc_feishu_ssh",
          text: ".chat",
        })
        expect(renderCardMarkdownFallback(chatList.cards[0]!)).toContain("AutoDL Codex 训练排查")
        expect(renderCardMarkdownFallback(chatList.cards[0]!)).toContain("local/codex/gpt-6.1-sol")

        const histRes = yield* mobile.simulateInbound({
          robotId: bot.id,
          userId: "ou_feishu_owner",
          chatId: "oc_feishu_ssh",
          text: ".history",
        })
        expect(renderCardMarkdownFallback(histRes.cards[0]!)).toContain("ORION-77")

        // `.undo` on pure `msg_ext_*` history refuses cleanly without 404
        const undoExt = yield* mobile.simulateInbound({
          robotId: bot.id,
          userId: "ou_feishu_owner",
          chatId: "oc_feishu_ssh",
          text: ".undo",
        })
        expect(renderCardMarkdownFallback(undoExt.cards[0]!)).toContain("无可撤回记录")

        // 2-level vendor -> model listing on SSH device & Feishu cardAction drill-down
        const sshVendors = yield* mobile.simulateInbound({
          robotId: bot.id,
          userId: "ou_feishu_owner",
          chatId: "oc_feishu_ssh",
          text: ".m",
        })
        expect(sshVendors.cards[0]?.header?.title).toContain("SSH:AutoDL-GPU")
        const sshVendorsMd = renderCardMarkdownFallback(sshVendors.cards[0]!)
        expect(sshVendorsMd).toContain("#1 PiguToken")
        expect(sshVendorsMd).toContain("#2 OpenAI Codex (本地 CLI)")

        const expandVendor2 = yield* mobile.simulateInbound({
          robotId: bot.id,
          userId: "ou_feishu_owner",
          chatId: "oc_feishu_ssh",
          text: ".m 2",
        })
        expect(expandVendor2.cards[0]?.header?.title).toContain("OpenAI Codex")
        expect(renderCardMarkdownFallback(expandVendor2.cards[0]!)).toContain("2.1")

        // Switch via two-level index (including Chinese full-width dot `。` from mobile keyboard)
        const swTwoLevel = yield* mobile.simulateInbound({
          robotId: bot.id,
          userId: "ou_feishu_owner",
          chatId: "oc_feishu_ssh",
          text: "。m 1。1",
        })
        expect(swTwoLevel.cards[0]?.header?.title).toContain("已切换会话模型")
        expect(renderCardMarkdownFallback(swTwoLevel.cards[0]!)).toContain("pigutoken/deepseek-v4.1-flash")

        // Switch back via Feishu interactive cardAction `model:pick:...`
        const swByCardBtn = yield* mobile.simulateInbound({
          robotId: bot.id,
          userId: "ou_feishu_owner",
          chatId: "oc_feishu_ssh",
          text: "",
          cardAction: "model:pick:local/codex/gpt-6.1-sol",
        })
        expect(swByCardBtn.cards[0]?.header?.title).toContain("已切换会话模型")

        // Prompt via `local/codex/gpt-6.1-sol`, then switch model to `pigutoken/deepseek-v4.1-flash` and prompt again
        const turn1 = yield* mobile.simulateInbound({
          robotId: bot.id,
          userId: "ou_feishu_owner",
          chatId: "oc_feishu_ssh",
          text: "复述远端暗号",
        })
        expect(turn1.texts[0]).toContain("local/codex/gpt-6.1-sol 复述暗号 ORION-77")

        const swModel = yield* mobile.simulateInbound({
          robotId: bot.id,
          userId: "ou_feishu_owner",
          chatId: "oc_feishu_ssh",
          text: ".model pigutoken/deepseek-v4.1-flash",
        })
        expect(swModel.cards[0]?.header?.title).toContain("已切换会话模型")

        const turn2 = yield* mobile.simulateInbound({
          robotId: bot.id,
          userId: "ou_feishu_owner",
          chatId: "oc_feishu_ssh",
          text: "切换模型后再次复述暗号",
        })
        expect(turn2.texts[0]).toContain("pigutoken/deepseek-v4.1-flash 复述暗号 ORION-77")

        // `.send` lists remote files via `/api/fs/list` and `.send 1` delivers `metrics.json`
        const sendList = yield* mobile.simulateInbound({
          robotId: bot.id,
          userId: "ou_feishu_owner",
          chatId: "oc_feishu_ssh",
          text: ".send",
        })
        expect(renderCardMarkdownFallback(sendList.cards[0]!)).toContain("#1 metrics.json")

        const sendFile1 = yield* mobile.simulateInbound({
          robotId: bot.id,
          userId: "ou_feishu_owner",
          chatId: "oc_feishu_ssh",
          text: ".send 1",
        })
        expect(sendFile1.files.map((f) => f.fileName)).toEqual(["metrics.json"])

        // Transient SSH disconnect preserves binding and warns explicitly instead of running locally
        yield* mobile.syncRemotes([])
        const offlineTurn = yield* mobile.simulateInbound({
          robotId: bot.id,
          userId: "ou_feishu_owner",
          chatId: "oc_feishu_ssh",
          text: "断线期间发消息",
        })
        expect(offlineTurn.texts[0]).toContain("当前绑定的 SSH 服务器未连接")

        yield* mobile.syncRemotes([{ key: "ssh:9f4a8b12", name: "AutoDL-GPU", url: baseUrl }])
        const recoveredTurn = yield* mobile.simulateInbound({
          robotId: bot.id,
          userId: "ou_feishu_owner",
          chatId: "oc_feishu_ssh",
          text: "重连后继续发消息",
        })
        expect(recoveredTurn.texts[0]).toContain("pigutoken/deepseek-v4.1-flash 复述暗号 ORION-77")
      }),
  )

  test("groups 200+ models by desktop-aligned vendor priority without hiding PiguToken or local CLIs", () => {
    const rawModels = [
      ...Array.from({ length: 15 }, (_, i) => ({
        providerID: "opencode",
        id: `zen-free-${i + 1}`,
        name: `Zen Free ${i + 1}`,
      })),
      ...Array.from({ length: 20 }, (_, i) => ({
        providerID: "anthropic",
        id: `claude-cloud-${i + 1}`,
        name: `Claude Cloud ${i + 1}`,
      })),
      { providerID: "local", id: "agy/gemini-3-pro", name: "gemini-3-pro" },
      { providerID: "local", id: "deepseek-harness/deepseek-v4", name: "deepseek-v4" },
      { providerID: "local", id: "codex/gpt-6.1-sol", name: "gpt-6.1-sol" },
      { providerID: "local", id: "claude/claude-sonnet-5-5", name: "claude-sonnet-5-5" },
      ...Array.from({ length: 35 }, (_, i) => ({
        providerID: "pigutoken",
        id: `pigu-model-${i + 1}`,
        name: `Pigu Model ${i + 1}`,
      })),
    ]

    const groups = Mobile.groupModelsByVendor(rawModels)
    expect(groups.map((g) => g.key)).toEqual([
      "pigutoken",
      "local:claude",
      "local:codex",
      "local:agy",
      "local:deepseek-harness",
      "anthropic",
      "opencode",
    ])
    expect(groups[0]?.models.length).toBe(35)
  })

  test("parses pagination and search subcommands across .p, .c, and .m without breaking numeric switch", () => {
    expect(parseMobileInput(".p ? autodl")).toEqual({ kind: "project", sub: "list", arg: "? autodl" })
    expect(parseMobileInput(".p list 1 p2")).toEqual({ kind: "project", sub: "list", arg: "1 p2" })
    expect(parseMobileInput("。p 1。18")).toEqual({ kind: "project", sub: "switch", arg: "1。18" })

    expect(parseMobileInput(".c p2")).toEqual({ kind: "chat", sub: "list", arg: "p2" })
    expect(parseMobileInput(".c page 3")).toEqual({ kind: "chat", sub: "list", arg: "page 3" })
    expect(parseMobileInput(".c ? 排查")).toEqual({ kind: "chat", sub: "list", arg: "? 排查" })
    expect(parseMobileInput(".c 18")).toEqual({ kind: "chat", sub: "switch", arg: "18" })

    expect(parseMobileInput(".m list 1 p2")).toEqual({ kind: "model", sub: "list", arg: "1 p2" })
  })

  it.live(
    "paginates and searches 15+ items across .p, .c, and .send with zero truncation and filters child sessions",
    () =>
      Effect.gen(function* () {
        const mobile = yield* Mobile.Service
        const sessions = yield* Session.Service
        const tmp = yield* tmpdirScoped("pigu-mobile-pagination-")
        const localDir = tmp.path

        // Create 18 local files with distinct mtime ordering so #1..#18 are deterministic
        for (let i = 1; i <= 18; i++) {
          const pad = String(i).padStart(2, "0")
          const fPath = path.join(localDir, `artifact-${pad}.txt`)
          yield* Effect.promise(async () => {
            await fs.writeFile(fPath, `payload-${pad}\n`, "utf8")
            const ts = new Date(Date.UTC(2026, 10, 16, 12, 0, 100 - i))
            await fs.utimes(fPath, ts, ts)
          })
        }

        // Mock SSH server with 18 remote projects matching Project.Info schema (`canonical` + bare array)
        const remoteProjects = Array.from({ length: 18 }, (_, idx) => {
          const pad = String(idx + 1).padStart(2, "0")
          return {
            id: `proj_ssh_${pad}`,
            name: `gpu-job-${pad}`,
            canonical: `/root/autodl-tmp/gpu-job-${pad}`,
            time: { updated: 1_760_000_000_000 - idx * 1000 },
          }
        })

        const remoteServer = Bun.serve({
          port: 0,
          hostname: "127.0.0.1",
          fetch(req) {
            const u = new URL(req.url)
            if (u.pathname === "/api/project") {
              return Response.json(remoteProjects)
            }
            if (u.pathname === "/api/session" && req.method === "GET") {
              const projParam = u.searchParams.get("project") ?? ""
              const dirParam = u.searchParams.get("directory") ?? ""
              const matched = remoteProjects.find((p) => p.id === projParam || p.canonical === dirParam)
              if (!matched) return Response.json({ data: [] })
              return Response.json({
                data: [
                  {
                    id: `ses_${matched.id}`,
                    title: `${matched.name} 主会话`,
                    location: { directory: matched.canonical },
                    time: { updated: 1_760_000_000_000 },
                  },
                ],
              })
            }
            if (u.pathname === "/api/model/default") {
              return Response.json({ data: { providerID: "pigutoken", id: "deepseek-v4.1" } })
            }
            if (u.pathname === "/api/session/active") {
              return Response.json({ data: {} })
            }
            return Response.json({ data: {} })
          },
        })
        yield* Effect.addFinalizer(() => Effect.sync(() => remoteServer.stop(true)))

        const bot = yield* mobile.create({
          name: "分页完整性测试机器人",
          platform: "feishu",
          enabled: false,
          ownerID: "ou_page_owner",
          feishu: { appId: "cli_page_test", appSecret: "sec_page_test" },
        })

        yield* mobile.syncRemotes([
          { key: "ssh:cluster18", name: "AutoDL-Cluster", url: `http://127.0.0.1:${remoteServer.port}` },
        ])

        // Open local project and create 17 more top-level sessions (total 18) + 1 child subagent session
        yield* mobile.simulateInbound({
          robotId: bot.id,
          userId: "ou_page_owner",
          chatId: "oc_page_chat",
          text: `.p new ${localDir}`,
        })

        let oldestSessionId = ""
        for (let i = 2; i <= 18; i++) {
          const pad = String(i).padStart(2, "0")
          const created = yield* sessions.create({
            location: Location.Ref.make({ directory: AbsolutePath.make(localDir) }),
            title: `本地训练轮次-${pad}`,
          })
          if (i === 2) oldestSessionId = created.id
        }
        // Child session with parentID must NOT appear in `.c`
        yield* sessions.create({
          parentID: Session.ID.make(oldestSessionId),
          title: "隐藏子代理会话-SUBAGENT",
        })

        // 1. `.p` overview shows all devices + explicit count of remaining projects on #2 SSH:AutoDL-Cluster
        const pRoot = yield* mobile.simulateInbound({
          robotId: bot.id,
          userId: "ou_page_owner",
          chatId: "oc_page_chat",
          text: ".p",
        })
        const pRootMd = renderCardMarkdownFallback(pRoot.cards[0]!)
        expect(pRootMd).toContain("#1 本机")
        expect(pRootMd).toContain("#2 SSH:AutoDL-Cluster")
        expect(pRootMd).toContain("共 18 个项目")

        // `.p 2` drills into #2 SSH:AutoDL-Cluster page 1/2 (2.1..2.15), `.p 2 p2` (and cardAction) shows 2.16..2.18
        const pDev2P1 = yield* mobile.simulateInbound({
          robotId: bot.id,
          userId: "ou_page_owner",
          chatId: "oc_page_chat",
          text: ".p 2",
        })
        const pDev2P1Md = renderCardMarkdownFallback(pDev2P1.cards[0]!)
        expect(pDev2P1Md).toContain("第 1/2 页（共 18 个项目）")
        expect(pDev2P1Md).toContain("2.15 gpu-job-15")
        expect(pDev2P1Md).not.toContain("2.16 gpu-job-16")

        const pDev2P2Card = yield* mobile.simulateInbound({
          robotId: bot.id,
          userId: "ou_page_owner",
          chatId: "oc_page_chat",
          text: "",
          cardAction: "proj:dev:ssh:cluster18:2",
        })
        const pDev2P2Md = renderCardMarkdownFallback(pDev2P2Card.cards[0]!)
        expect(pDev2P2Md).toContain("第 2/2 页（共 18 个项目）")
        expect(pDev2P2Md).toContain("2.18 gpu-job-18")

        // `.p ? job-18` searches across devices, and `。p 2。18` switches to the 18th remote project
        const pSearch = yield* mobile.simulateInbound({
          robotId: bot.id,
          userId: "ou_page_owner",
          chatId: "oc_page_chat",
          text: ".p ? job-18",
        })
        expect(renderCardMarkdownFallback(pSearch.cards[0]!)).toContain("2.18 gpu-job-18")

        const pSw18 = yield* mobile.simulateInbound({
          robotId: bot.id,
          userId: "ou_page_owner",
          chatId: "oc_page_chat",
          text: "。p 2。18",
        })
        expect(pSw18.cards[0]?.header?.title).toContain("已切换项目")
        expect(renderCardMarkdownFallback(pSw18.cards[0]!)).toContain("gpu-job-18")

        // Switch back to `#1 本机` project `1.1` via cardAction `proj:pick:1.1`
        const pBackLocal = yield* mobile.simulateInbound({
          robotId: bot.id,
          userId: "ou_page_owner",
          chatId: "oc_page_chat",
          text: "",
          cardAction: "proj:pick:1.1",
        })
        expect(pBackLocal.cards[0]?.header?.title).toContain("已切换项目")

        // 2. `.c` paginates all 18 top-level sessions (excluding child subagent session)
        const cPage1 = yield* mobile.simulateInbound({
          robotId: bot.id,
          userId: "ou_page_owner",
          chatId: "oc_page_chat",
          text: ".c",
        })
        const cPage1Md = renderCardMarkdownFallback(cPage1.cards[0]!)
        expect(cPage1Md).toContain("第 1/2 页（共 18 个会话）")
        expect(cPage1Md).not.toContain("隐藏子代理会话-SUBAGENT")
        expect(cPage1Md).toContain("#15")
        expect(cPage1Md).not.toContain("#16")

        const cPage2 = yield* mobile.simulateInbound({
          robotId: bot.id,
          userId: "ou_page_owner",
          chatId: "oc_page_chat",
          text: ".c p2",
        })
        const cPage2Md = renderCardMarkdownFallback(cPage2.cards[0]!)
        expect(cPage2Md).toContain("第 2/2 页（共 18 个会话）")
        expect(cPage2Md).toContain("#18")

        // `.c 18` switches directly to session #18 on page 2
        const cSwitch18 = yield* mobile.simulateInbound({
          robotId: bot.id,
          userId: "ou_page_owner",
          chatId: "oc_page_chat",
          text: ".c 18",
        })
        expect(cSwitch18.cards[0]?.header?.title).toContain("已切换会话")

        const cSearch = yield* mobile.simulateInbound({
          robotId: bot.id,
          userId: "ou_page_owner",
          chatId: "oc_page_chat",
          text: ".c ? 轮次-17",
        })
        expect(renderCardMarkdownFallback(cSearch.cards[0]!)).toContain("本地训练轮次-17")

        // 3. `.send` paginates all 18 files (`.send`, `send:page:2`, `.send 18`, `.send ? artifact-18`)
        const sendP1 = yield* mobile.simulateInbound({
          robotId: bot.id,
          userId: "ou_page_owner",
          chatId: "oc_page_chat",
          text: ".send",
        })
        const sendP1Md = renderCardMarkdownFallback(sendP1.cards[0]!)
        expect(sendP1Md).toContain("第 1/2 页（共 18 个文件）")
        expect(sendP1Md).toContain("#15 artifact-15.txt")
        expect(sendP1Md).not.toContain("#16 artifact-16.txt")

        const sendP2ViaBtn = yield* mobile.simulateInbound({
          robotId: bot.id,
          userId: "ou_page_owner",
          chatId: "oc_page_chat",
          text: "",
          cardAction: "send:page:2",
        })
        const sendP2Md = renderCardMarkdownFallback(sendP2ViaBtn.cards[0]!)
        expect(sendP2Md).toContain("第 2/2 页（共 18 个文件）")
        expect(sendP2Md).toContain("#18 artifact-18.txt")

        const sendSearch = yield* mobile.simulateInbound({
          robotId: bot.id,
          userId: "ou_page_owner",
          chatId: "oc_page_chat",
          text: ".send ? artifact-17",
        })
        expect(renderCardMarkdownFallback(sendSearch.cards[0]!)).toContain("#17 artifact-17.txt")

        const sendPick18 = yield* mobile.simulateInbound({
          robotId: bot.id,
          userId: "ou_page_owner",
          chatId: "oc_page_chat",
          text: ".send 18",
        })
        expect(sendPick18.files.map((f) => f.fileName)).toEqual(["artifact-18.txt"])
      }),
  )

  test("WeChat connector coalesces multi-image bursts + caption and falls back across candidate AES keys", async () => {
    const onePxPng = Buffer.from(
      "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082",
      "hex",
    )
    const validKey = Buffer.from("0102030405060708090a0b0c0d0e0f10", "hex")
    const wrongKey = Buffer.from("ffffffffffffffffffffffffffffffff", "hex")
    const encryptPng = () => {
      const cipher = createCipheriv("aes-128-ecb", validKey, null)
      cipher.setAutoPadding(true)
      return Buffer.concat([cipher.update(onePxPng), cipher.final()])
    }
    const encryptedPng = encryptPng()

    // Direct helper check: wrong media.aes_key followed by valid image_item.aeskey recovers exact PNG
    const decrypted = decryptWeixinCdnPayload(new Uint8Array(encryptedPng), [
      wrongKey.toString("base64"),
      validKey.toString("hex"),
    ])
    expect(Buffer.from(decrypted).equals(onePxPng)).toBe(true)

    let pollCount = 0
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (req) => {
        const url = new URL(req.url)
        if (url.pathname === "/c2c/download") {
          return new Response(encryptedPng, { headers: { "Content-Type": "application/octet-stream" } })
        }
        if (url.pathname === "/ilink/bot/getupdates") {
          pollCount += 1
          if (pollCount === 1) {
            return Response.json({
              ret: 0,
              get_updates_buf: "cur_1",
              msgs: [
                {
                  message_id: 101,
                  from_user_id: "wx_multi_user",
                  message_type: 1,
                  context_token: "ctx_1",
                  item_list: [
                    {
                      type: 2,
                      image_item: {
                        aeskey: validKey.toString("hex"),
                        media: { encrypt_query_param: "img_1", aes_key: wrongKey.toString("base64") },
                      },
                    },
                  ],
                },
                {
                  message_id: 102,
                  from_user_id: "wx_multi_user",
                  message_type: 1,
                  context_token: "ctx_2",
                  item_list: [
                    {
                      type: 2,
                      image_item: {
                        aeskey: validKey.toString("hex"),
                        hd_media: { encrypt_query_param: "img_2_hd" },
                      },
                    },
                  ],
                },
              ],
            })
          }
          if (pollCount === 2) {
            return Response.json({
              ret: 0,
              get_updates_buf: "cur_2",
              msgs: [
                {
                  message_id: 103,
                  from_user_id: "wx_multi_user",
                  message_type: 1,
                  context_token: "ctx_3",
                  item_list: [
                    {
                      type: 2,
                      image_item: {
                        media: { encrypt_query_param: "img_3", aes_key: validKey.toString("base64") },
                      },
                    },
                  ],
                },
                {
                  message_id: 104,
                  from_user_id: "wx_multi_user",
                  message_type: 1,
                  context_token: "ctx_4",
                  item_list: [{ type: 1, text_item: { text: "帮我分析这三张报错图" } }],
                },
              ],
            })
          }
          await new Promise((r) => setTimeout(r, 200))
          return Response.json({ ret: 0, msgs: [] })
        }
        return Response.json({ ret: 0 })
      },
    })

    const received: InboundMobileMessage[] = []
    const base = `http://127.0.0.1:${server.port}`
    const connector = createWeixinConnector({
      robotId: "wx_bot_burst",
      token: "tok_test",
      baseUrl: base,
      cdnBaseUrl: `${base}/c2c`,
      burstDebounceMs: 80,
    })

    try {
      await connector.start(
        async (msg) => {
          received.push(msg)
        },
        async () => undefined,
      )
      const deadline = Date.now() + 2_000
      while (received.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25))
      }
      expect(received).toHaveLength(1)
      expect(received[0]?.text).toBe("帮我分析这三张报错图")
      expect(received[0]?.fileAttachments?.map((f) => f.fileName)).toEqual([
        "weixin-image-1.png",
        "weixin-image-2.png",
        "weixin-image-3.png",
      ])
      expect(received[0]?.fileAttachments?.every((f) => f.mimeType === "image/png")).toBe(true)
    } finally {
      await connector.stop()
      await server.stop(true)
    }
  })

  test("aligns mobile project filtering with desktop rules while keeping active $HOME and bound directories", () => {
    expect(Mobile.normalizeMobileProjectDir("/Volumes/AntL/pigu/pigu///")).toBe("/Volumes/AntL/pigu/pigu")
    expect(Mobile.normalizeMobileProjectDir("C:\\Users\\al\\proj\\")).toBe("c:/Users/al/proj")

    // Active real user home directories stay visible
    expect(
      Mobile.isMobileNoiseProjectDirectory("/home/lsy", 61, {
        isTestRuntime: false,
        hasSessionTelemetry: true,
      }),
    ).toBe(false)
    expect(
      Mobile.isMobileNoiseProjectDirectory("/Users/al", 2, {
        isTestRuntime: false,
        hasSessionTelemetry: true,
      }),
    ).toBe(false)

    // Bare container roots, dot-config folders, temp folders, and 0-session fallback dirs are excluded
    for (const dir of ["/", "/Users", "/home", "/Volumes", "C:\\", "C:\\Users"]) {
      expect(Mobile.isMobileNoiseProjectDirectory(dir, 5, { isTestRuntime: false, hasSessionTelemetry: true })).toBe(
        true,
      )
    }
    expect(
      Mobile.isMobileNoiseProjectDirectory("/Users/al/.config/opencode", 3, {
        isTestRuntime: false,
        hasSessionTelemetry: true,
      }),
    ).toBe(true)
    expect(
      Mobile.isMobileNoiseProjectDirectory("/Users/al/.gemini/antigravity/brain/scratch", 1, {
        isTestRuntime: false,
        hasSessionTelemetry: true,
      }),
    ).toBe(true)
    expect(
      Mobile.isMobileNoiseProjectDirectory("/home/lsy/.pigu/projects/历史会话", 0, {
        isTestRuntime: false,
        hasSessionTelemetry: true,
      }),
    ).toBe(true)
    expect(
      Mobile.isMobileNoiseProjectDirectory("/Users/al/.pigu/projects/gen_video", 41, {
        isTestRuntime: false,
        hasSessionTelemetry: true,
      }),
    ).toBe(false)
    expect(
      Mobile.isMobileNoiseProjectDirectory("/Volumes/AntL/test_temp", 2, {
        isTestRuntime: false,
        hasSessionTelemetry: true,
      }),
    ).toBe(true)
    expect(
      Mobile.isMobileNoiseProjectDirectory("/Volumes/AntL/my_voice", 0, {
        isTestRuntime: false,
        hasSessionTelemetry: true,
      }),
    ).toBe(true)
    expect(
      Mobile.isMobileNoiseProjectDirectory("/Volumes/AntL/my_voice", 0, {
        isTestRuntime: false,
        isBound: true,
        hasSessionTelemetry: true,
      }),
    ).toBe(false)

    expect(Mobile.formatCompactionSourceBadge("agy")).toBe("Antigravity 原生 · 已压缩")
    expect(Mobile.formatCompactionSourceBadge("claude")).toBe("Claude 原生 · 已压缩")
    expect(Mobile.formatCompactionSourceBadge("codex")).toBe("Codex 原生 · 已压缩")
    expect(Mobile.formatCompactionSourceBadge("deepseek-harness")).toBe("DSH 原生 · 已压缩")
  })

  it.live(
    "deduplicates projects, floats active $HOME (lsy) to #1, shows server version & session counts, and compacts via .compact / /compact",
    () =>
      Effect.gen(function* () {
        const mobile = yield* Mobile.Service
        let compactCalls = 0
        const lsyMessages: Array<{
          id: string
          type: string
          text?: string
          summary?: string
          native?: { cliEngine?: string }
          content?: Array<{ type: string; text?: string }>
        }> = [
          {
            id: "msg_comp_1",
            type: "compaction",
            summary: "已完成服务端 SSH 热更新与 $HOME 会话归属修复。",
            native: { cliEngine: "agy" },
          },
          { id: "msg_u_1", type: "user", text: "继续验证手机端项目顺序" },
          {
            id: "msg_a_1",
            type: "assistant",
            content: [{ type: "text", text: "手机端已与桌面端保持完全一致。" }],
          },
        ]

        const remoteServer = Bun.serve({
          port: 0,
          hostname: "127.0.0.1",
          fetch(req) {
            const u = new URL(req.url)
            if (u.pathname === "/api/info") {
              return Response.json({ version: "1.0.4", pid: 1234, urls: [], paths: { tmp: "/tmp" } })
            }
            if (u.pathname === "/api/project") {
              return Response.json([
                // Duplicate rows for the same directory + empty 历史会话 + dot-config junk
                {
                  id: "proj_moe_1",
                  name: "moe-vm2api",
                  canonical: "/home/lsy/code/moe-vm2api",
                  time: { updated: 1_760_000_010_000 },
                },
                {
                  id: "proj_moe_dup",
                  name: "moe-vm2api",
                  canonical: "/home/lsy/code/moe-vm2api/",
                  time: { updated: 1_760_000_005_000 },
                },
                {
                  id: "proj_legacy_empty",
                  name: "历史会话",
                  canonical: "/home/lsy/.pigu/projects/历史会话",
                  time: { updated: 1_760_999_999_000 },
                },
                {
                  id: "proj_dot_cfg",
                  name: "opencode",
                  canonical: "/home/lsy/.config/opencode",
                  time: { updated: 1_760_999_999_000 },
                },
              ])
            }
            if (u.pathname === "/api/session" && req.method === "GET") {
              const projParam = u.searchParams.get("project")
              const dirParam = u.searchParams.get("directory")
              const allRemote = [
                {
                  id: "ses_ext_agy_lsy_1",
                  projectID: "global",
                  title: "Pigu Chat Bug Feedback",
                  location: { directory: "/home/lsy" },
                  model: { providerID: "local/agy", id: "gemini-3-pro" },
                  time: { updated: 1_760_500_000_000 },
                },
                {
                  id: "ses_ext_agy_lsy_2",
                  projectID: "global",
                  title: "LSY 历史排查",
                  location: { directory: "/home/lsy" },
                  model: { providerID: "local/agy", id: "gemini-3-pro" },
                  time: { updated: 1_760_400_000_000 },
                },
                {
                  id: "ses_moe_1",
                  projectID: "proj_moe_1",
                  title: "MOE 接口优化",
                  location: { directory: "/home/lsy/code/moe-vm2api" },
                  model: { providerID: "local/claude", id: "claude-sonnet-4-5" },
                  time: { updated: 1_760_100_000_000 },
                },
              ]
              const filtered = allRemote.filter((s) => {
                if (dirParam) return s.location.directory === dirParam
                if (projParam) return s.projectID === projParam
                return true
              })
              return Response.json({ data: filtered })
            }
            if (u.pathname === "/api/session/ses_ext_agy_lsy_1" && req.method === "GET") {
              return Response.json({
                data: {
                  id: "ses_ext_agy_lsy_1",
                  title: "Pigu Chat Bug Feedback",
                  model: { providerID: "local/agy", id: "gemini-3-pro" },
                },
              })
            }
            if (u.pathname === "/api/session/ses_ext_agy_lsy_1/context" && req.method === "GET") {
              return Response.json({ data: lsyMessages })
            }
            if (u.pathname === "/api/session/ses_ext_agy_lsy_1/compact" && req.method === "POST") {
              compactCalls += 1
              lsyMessages.push({
                id: `msg_comp_live_${compactCalls}`,
                type: "compaction",
                summary: `第 ${compactCalls} 次远程原生压缩完成：保留核心上下文。`,
                native: { cliEngine: "agy" },
              })
              return Response.json({ data: { id: `inb_comp_${compactCalls}`, type: "compaction" } })
            }
            if (u.pathname === "/api/experimental/session/ses_ext_agy_lsy_1/wait" && req.method === "POST") {
              return new Response(null, { status: 204 })
            }
            if (u.pathname === "/api/session/active") {
              return Response.json({ data: {} })
            }
            if (u.pathname === "/api/model/default") {
              return Response.json({ data: { providerID: "local/agy", id: "gemini-3-pro" } })
            }
            return new Response("Not Found", { status: 404 })
          },
        })
        yield* Effect.addFinalizer(() => Effect.sync(() => remoteServer.stop(true)))

        const bot = yield* mobile.create({
          name: "手机端LSY对齐验证机器人",
          platform: "weixin",
          enabled: false,
          ownerID: "wx_lsy_owner",
          weixin: { token: "wx_tok_lsy", accountId: "wx_lsy_bot@im.bot" },
        })

        yield* mobile.syncRemotes([
          { key: "ssh:lsy", name: "lsy", url: `http://127.0.0.1:${remoteServer.port}` },
        ])

        // 1. `.p` shows SSH:lsy version `v1.0.4`, floats `2.1 lsy` (2 sessions) above `2.2 moe-vm2api` (deduped to 1!), and hides empty 历史会话 & .config
        const pRes = yield* mobile.simulateInbound({
          robotId: bot.id,
          userId: "wx_lsy_owner",
          chatId: "wx_lsy_chat",
          text: ".p",
        })
        const pMd = renderCardMarkdownFallback(pRes.cards[0]!)
        expect(pMd).toContain("#2 SSH:lsy")
        expect(pMd).toContain("`v1.0.4`")
        expect(pMd).toContain("共 2 个项目")
        expect(pMd).toContain("2.1 lsy")
        expect(pMd).toContain("2 会话")
        expect(pMd).toContain("2.2 moe-vm2api")
        expect(pMd).not.toContain("历史会话")
        expect(pMd).not.toContain(".config")

        // 2. Switch to `2.1` (`lsy`) -> binds directly to `Pigu Chat Bug Feedback`
        const swLsy = yield* mobile.simulateInbound({
          robotId: bot.id,
          userId: "wx_lsy_owner",
          chatId: "wx_lsy_chat",
          text: ".p 2.1",
        })
        const swMd = renderCardMarkdownFallback(swLsy.cards[0]!)
        expect(swMd).toContain("Pigu Chat Bug Feedback")

        // 3. `.history` renders `Antigravity 原生 · 已压缩` badge and summary
        const histRes = yield* mobile.simulateInbound({
          robotId: bot.id,
          userId: "wx_lsy_owner",
          chatId: "wx_lsy_chat",
          text: ".history",
        })
        const histMd = renderCardMarkdownFallback(histRes.cards[0]!)
        expect(histMd).toContain("Antigravity 原生 · 已压缩")
        expect(histMd).toContain("已完成服务端 SSH 热更新")

        // 4. Both `.compact` and `/compact` trigger real session compaction and return the source-badged card
        const compDot = yield* mobile.simulateInbound({
          robotId: bot.id,
          userId: "wx_lsy_owner",
          chatId: "wx_lsy_chat",
          text: ".compact",
        })
        expect(compactCalls).toBe(1)
        expect(compDot.cards[0]?.header?.title).toContain("Antigravity 原生 · 已压缩")
        expect(renderCardMarkdownFallback(compDot.cards[0]!)).toContain("第 1 次远程原生压缩完成")

        const compSlash = yield* mobile.simulateInbound({
          robotId: bot.id,
          userId: "wx_lsy_owner",
          chatId: "wx_lsy_chat",
          text: "/compact",
        })
        expect(compactCalls).toBe(2)
        expect(compSlash.cards[0]?.header?.title).toContain("Antigravity 原生 · 已压缩")
        expect(renderCardMarkdownFallback(compSlash.cards[0]!)).toContain("第 2 次远程原生压缩完成")
      }),
  )
})
