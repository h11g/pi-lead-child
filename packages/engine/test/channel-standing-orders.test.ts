// 通道的常设指令（工单 11）：来源插件的种子（打断阈值、投递）、改它们的档位（工单 10 的三档），以及授权表
// （channel.authority，落地计划 A5）的放开只算系统种子、用户写的、或者用户批准过的版本。
import { createHash } from "node:crypto";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import {
  classifyStandingOrderChange, validateStandingOrderDefinition,
  type StandingOrderCondition, type StandingOrderState,
} from "@pi-lead-child/protocol";
import {
  channelAuthorityTable, channelDeliveryPolicy, getStandingOrder, openDb, proposeStandingOrderChange, recordStandingOrderVersion,
  resolveStandingOrderProposal, SYSTEM_STANDING_ORDERS, sourceThreshold, triageEvent,
} from "@pi-lead-child/store";
import { ChannelRegistry, channelDeliveryDecision, createSlackChannelAdapter } from "../src/index.js";
import { FakeSlack } from "../testing/index.js";

const slackAdapter = createSlackChannelAdapter({ api: new FakeSlack().api });
const toState = ({ seedRevision: _revision, status, ...definition }: (typeof SYSTEM_STANDING_ORDERS)[number]): StandingOrderState =>
  ({ ...definition, status: status ?? "active" });
const active: StandingOrderState[] = [...SYSTEM_STANDING_ORDERS, ...slackAdapter.standingOrders].map(toState);
const order = (id: string): StandingOrderState => structuredClone(active.find((candidate) => candidate.id === id)!);
const withParams = (id: string, params: Record<string, unknown>): StandingOrderState => {
  const current = order(id);
  if (current.action.type !== "rule") throw new Error(id);
  return { ...current, action: { ...current.action, params: { ...current.action.params, ...params } }, reason: "测试" };
};
const classify = (after: StandingOrderState) => classifyStandingOrderChange({ active, before: order(after.id), after });
const tier = (after: StandingOrderState) => classify(after).tier;

describe("the slack plugin's default standing orders", () => {
  it("are valid, and set a very high interrupt bar", () => {
    for (const seed of slackAdapter.standingOrders) expect(validateStandingOrderDefinition(seed), seed.id).toEqual([]);
    const delivery = order("channel.slack.delivery");
    const params = (delivery.action as { params: Record<string, StandingOrderCondition | null> }).params;
    const subject = (kind: string, trust: string, urgent: boolean) => ({
      source: "slack", kind, entityKey: "slack:D1:main", payload: { sender: { trust }, urgent }, rootCause: null,
    });
    const policy = { pushWhen: params.pushWhen!, cardWhen: params.cardWhen!, digestWhen: params.digestWhen!, order: { id: delivery.id, version: 1 } };
    // 推送只给你信任的人在私信里说紧急的消息；缺省没有你信任的人。
    expect(channelDeliveryDecision(policy, subject("slack.dm.received", "trusted", true)).mode).toBe("push_card");
    expect(channelDeliveryDecision(policy, subject("slack.dm.received", "colleague", true)).mode).toBe("card");
    expect(channelDeliveryDecision(policy, subject("slack.dm.received", "external", false)).mode).toBe("card");
    expect(channelDeliveryDecision(policy, subject("slack.mention.received", "colleague", false)).mode).toBe("card");
    expect(channelDeliveryDecision(policy, subject("slack.mention.received", "external", false)).mode).toBe("digest");
    expect(channelDeliveryDecision(policy, subject("slack.self.reply", "trusted", false)).mode).toBe("record");
    // 你的线程里同事的后续消息进会话卡，外部的人的进摘要；订阅频道里的普通消息即使紧急也只记录（slack-takeover 工单 02）。
    expect(channelDeliveryDecision(policy, subject("slack.thread.message", "colleague", false)).mode).toBe("card");
    expect(channelDeliveryDecision(policy, subject("slack.thread.message", "external", false)).mode).toBe("digest");
    expect(channelDeliveryDecision(policy, subject("slack.message.edited", "colleague", false)).mode).toBe("card");
    expect(channelDeliveryDecision(policy, subject("slack.channel.message", "trusted", true)).mode).toBe("record");
    // 来源没有投递指令时进摘要：消息不丢，也不打扰用户。
    expect(channelDeliveryDecision(null, subject("slack.dm.received", "trusted", true))).toMatchObject({ mode: "digest", matched: "default" });
    // 模板代回退役了（用户 2026-10-22）：这条种子停用，由授权表取代。
    expect(order("channel.slack.delegate")).toMatchObject({ status: "disabled", title: expect.stringContaining("已退役") });
    // 代查和按信心代回也退役了（落地计划 D1）：由 Lead 派的子 agent 工单和信心模型取代。
    for (const id of ["channel.slack.lookup", "channel.slack.reply"]) {
      expect(order(id), id).toMatchObject({ status: "disabled", title: expect.stringContaining("已退役") });
    }
  });

  it("are synced into a database once the adapter is registered, and triage slack events as an external source", () => {
    const db = openDb(join(tempDir("plc-channel-orders-"), "plc.db"));
    new ChannelRegistry([slackAdapter]);
    // hub 启动时同步；这里直接用 store 的同步（openDb 也会做，只是这个库打开得更早）。
    expect(getStandingOrder(db, "channel.slack.delivery")).toBeUndefined();
    db.close();
    const reopened = openDb(join(tempDir("plc-channel-orders-reopen-"), "plc.db"));
    expect(getStandingOrder(reopened, "channel.slack.delivery")).toMatchObject({ version: 1, author: "system" });
    expect(sourceThreshold(reopened, "slack")).toMatchObject({ defaultLevel: "digest", maxLevel: "tell", order: { id: "source.slack" } });
    expect(channelDeliveryPolicy(reopened, "slack")?.order).toEqual({ id: "channel.slack.delivery", version: 1 });
    // 外部来源：分诊最高 tell。即使有一条（别的办法写进库的）指令把它定成 interrupt。
    const decision = triageEvent(reopened, {
      source: "slack", kind: "slack.dm.received", entityKey: "slack:D1:main", occurredAt: new Date().toISOString(),
      payload: { role: "message" },
    });
    expect(decision).toMatchObject({ level: "digest", basis: { order: { id: "source.slack" } } });
    reopened.close();
  });
});

describe("changing the channel orders (ticket 10's tiers)", () => {
  it("refuses new channel rule orders from Lead, and interrupts for the external source", () => {
    const created = { ...order("channel.slack.delivery"), id: "channel.slack.delivery_2" };
    expect(classifyStandingOrderChange({ active, before: null, after: created }).tier).toBe("forbidden");
    expect(tier(withParams("source.slack", { maxLevel: "interrupt" }))).toBe("forbidden");
  });
});

describe("changing the delivery order", () => {
  const params = (order("channel.slack.delivery").action as { params: Record<string, StandingOrderCondition | null> }).params;

  it("any change to the push threshold needs the user's approval", () => {
    expect(tier(withParams("channel.slack.delivery", { pushWhen: { kinds: ["slack.dm.received"] } }))).toBe("permissive");
    expect(tier(withParams("channel.slack.delivery", { pushWhen: null }))).toBe("permissive");
  });

  it("cards and digests: giving the user more is conservative, less is permissive", () => {
    // 线程里的后续消息、改消息、删消息和提及一样投递（slack-takeover 工单 02，种子修订 3）。
    const conversation = ["slack.mention.received", "slack.thread.message", "slack.message.edited", "slack.message.deleted"];
    expect(tier(withParams("channel.slack.delivery", { cardWhen: { kinds: ["slack.dm.received", ...conversation] } }))).toBe("conservative");
    expect(tier(withParams("channel.slack.delivery", { cardWhen: { kinds: ["slack.dm.received", "slack.mention.received"] } }))).toBe("permissive");
    expect(tier(withParams("channel.slack.delivery", { cardWhen: { kinds: ["slack.dm.received"] } }))).toBe("permissive");
    expect(tier(withParams("channel.slack.delivery", { digestWhen: { kinds: [...conversation, "slack.dm.received"] } }))).toBe("conservative");
    expect(tier(withParams("channel.slack.delivery", { digestWhen: { kinds: ["slack.mention.received"] } }))).toBe("permissive");
    // 证明不了是放宽（条件换了写法）时，按更放开处理。
    expect(tier(withParams("channel.slack.delivery", { digestWhen: { sources: ["slack"] } }))).toBe("permissive");
    expect(tier(withParams("channel.slack.delivery", { digestWhen: null }))).toBe("permissive");
    // 机器人和应用发的消息只记录（种子修订 4，用户 2026-10-21）。
    expect(params.digestWhen).toEqual({ kinds: conversation, fields: { "payload.sender.bot": { not: true } } });
  });
});

describe("changing the authority table", () => {
  const intents = (patch: Record<string, unknown>) =>
    ({ ...(order("channel.authority").action as unknown as { params: { intents: Record<string, unknown> } }).params.intents, ...patch });

  it("opening an intent or lowering a threshold needs the user's approval; the reverse is conservative", () => {
    expect(tier(withParams("channel.authority", { intents: intents({ other: { action: "auto" } }) }))).toBe("permissive");
    expect(tier(withParams("channel.authority", { intents: intents({ meeting: { action: "refuse" } }) }))).toBe("permissive");
    expect(tier(withParams("channel.authority", { intents: intents({ code_review: { action: "auto", minConfidence: 0.2 } }) }))).toBe("permissive");
    expect(tier(withParams("channel.authority", { source: "slack" }))).toBe("permissive");
    expect(tier(withParams("channel.authority", { intents: intents({ code_review: { action: "ask" } }) }))).toBe("conservative");
    expect(tier(withParams("channel.authority", { intents: intents({ meeting: { action: "ask" } }) }))).toBe("conservative");
    expect(tier(withParams("channel.authority", { intents: intents({ approve: { action: "auto", minConfidence: 0.6 } }) }))).toBe("conservative");
  });

  it("never lets anyone answer secrets for the user", () => {
    expect(classify(withParams("channel.authority", { intents: intents({ secret: { action: "auto" } }) })))
      .toMatchObject({ tier: "forbidden", findings: expect.arrayContaining([expect.objectContaining({ hardRule: "secrets_never_delegated" })]) });
  });
});

describe("the authority table that really applies", () => {
  it("opens only what a system seed, the user, or an approved version opened, and Lead can narrow it at once", () => {
    const seeded = openDb(join(tempDir("plc-channel-authority-"), "plc.db"));
    const authority = getStandingOrder(seeded, "channel.authority")!;
    const params = (authority.action as any).params;
    const withIntents = (patch: Record<string, unknown>) => ({ ...authority.action, params: { ...params, intents: { ...params.intents, ...patch } } }) as never;
    expect(channelAuthorityTable(seeded, "slack")).toMatchObject({
      table: { code_review: { action: "auto" }, meeting: { action: "remind" }, secret: { action: "refuse" }, other: { action: "ask" } },
      order: { id: "channel.authority", version: 1 },
    });
    // 走工单 10 的流程：Lead 提议放开「别的」，更放开，等批准；用户批准以后才算数。
    const proposal = proposeStandingOrderChange(seeded, {
      op: "update", id: "channel.authority", reason: "别的请求也先替我处理", patch: { action: withIntents({ other: { action: "auto" } }) },
    });
    expect(proposal.outcome).toBe("pending_approval");
    expect(channelAuthorityTable(seeded, "slack")!.table.other).toEqual({ action: "ask" });
    const approvalId = proposal.outcome === "pending_approval" ? proposal.proposal.approvalId : 0;
    resolveStandingOrderProposal(seeded, approvalId, { approve: true, resolvedBy: "user via test" });
    expect(channelAuthorityTable(seeded, "slack")).toMatchObject({ table: { other: { action: "auto" } }, order: { version: 2 } });
    // Lead 收紧（更保守，直接生效）：代码 review 改成问你。
    const tightened = proposeStandingOrderChange(seeded, {
      op: "update", id: "channel.authority", reason: "这周的 review 我自己看",
      patch: { action: withIntents({ other: { action: "auto" }, code_review: { action: "ask" } }) },
    });
    expect(tightened.outcome).toBe("applied");
    expect(channelAuthorityTable(seeded, "slack")!.table).toMatchObject({ code_review: { action: "ask" }, other: { action: "auto" } });
    // 不经批准写进库的版本（例如被别的办法写进去的）放开不了：这一项按「问你」。涉密的 auto 一律不认。
    const current = getStandingOrder(seeded, "channel.authority")!;
    const loose = withIntents({ other: { action: "auto" }, code_review: { action: "ask" }, meeting: { action: "auto" }, secret: { action: "auto" } });
    seeded.transaction(() => recordStandingOrderVersion(seeded, { ...current, action: loose, reason: "未经批准" }, { author: "lead" }))();
    expect(channelAuthorityTable(seeded, "slack")).toMatchObject({
      table: { meeting: { action: "ask" }, secret: { action: "ask" }, other: { action: "auto" } },
      requested: { meeting: { action: "auto" }, secret: { action: "auto" } },
    });
    seeded.close();
  });
});

// 来源插件的种子和内置种子一样：改了内容却忘了加修订号，已有的库永远收不到这次修改（同步只看修订号）。
// store 的 standing-orders.test.ts 只钉内置种子，这里钉 Slack 插件的：内容变了，这个测试失败；
// 改的人把修订号加 1，再把这里的值改成新的「修订号:指纹」。
describe("the slack plugin's seeds are pinned to their revision", () => {
  it("fails when a seed's content changes without a new revision", () => {
    const stable = (value: unknown): string => Array.isArray(value) ? `[${value.map(stable).join(",")}]`
      : value && typeof value === "object"
        ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(",")}}`
        : JSON.stringify(value ?? null);
    const fingerprints = Object.fromEntries(slackAdapter.standingOrders.map(({ seedRevision, ...content }) =>
      [content.id, `${seedRevision}:${createHash("sha256").update(stable(content)).digest("hex").slice(0, 12)}`]));
    expect(fingerprints).toEqual({
      "channel.slack.delegate": "2:b5b8efd00f1e",
      "channel.slack.delivery": "4:3d396653a3b5",
      "channel.slack.lookup": "2:45ea7faf5d0d",
      "channel.slack.reply": "3:8f9efa82d142",
      "slack.amendment": "2:c81122fe5be4",
      "slack.channel_message": "1:bd5361bb349e",
      "slack.record_only": "1:9ef976114b9d",
      "slack.self_reply": "1:c1ea9aa02720",
      "source.slack": "1:3261e5d94c4c",
    });
  });
});
