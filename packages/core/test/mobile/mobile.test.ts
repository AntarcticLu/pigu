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
import { renderCardMarkdownFallback, renderFeishuCardObject } from "../../src/mobile/card"
import { createFeishuConnector } from "../../src/mobile/platforms/feishu"
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
})
