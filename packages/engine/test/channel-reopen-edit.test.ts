// A message that the assistant judged "no reply needed" while it was a placeholder ("… is reviewing…") can turn into the
// real text through an edit. Such an edit goes through the inbound judgement again; every other edit keeps its old behaviour
// (record only without an open card, update the open card with one).
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { getChannelCard, getEvent, listChannelCardsForObject, listEvents, openDb, type Db } from "@pi-lead-child/store";
import { MESSAGE_EVENT_KIND } from "@pi-lead-child/protocol";
import { ChannelHub, ChannelRegistry, createSlackChannelAdapter, type SmartModel } from "../src/index.js";
import { cardIdOf, FakeAgentTaskDispatcher, FakeSlack, scriptedSmartModel } from "../testing/index.js";

let db: Db;
let slack: FakeSlack;
let hubs: ChannelHub[] = [];
const clock = new Date("2026-11-06T06:09:52.000Z");

beforeEach(() => {
  db = openDb(join(tempDir("plc-reopen-edit-"), "plc.db"));
  slack = new FakeSlack({ now: () => clock });
});

afterEach(async () => {
  for (const instance of hubs.splice(0)) await instance.idle();
  db.close();
});

const PLACEHOLDER = ":robot: Review bot is reviewing…";
const BODY = ":robot: Review bot looked at #123 and found no blocking issue. One step is left: please send the link of the 1.1.2 changelog so the header fix can be checked.";

// The reply is judged needed only when the text is not the placeholder and not a pure remark.
function setup(needsReply: (first: string) => number) {
  const model = scriptedSmartModel({ answers: { needs_reply: (state) => needsReply(state.split("\n\n")[0] ?? "") } });
  const hub = new ChannelHub({
    db, registry: new ChannelRegistry([createSlackChannelAdapter({ api: slack.api, now: () => clock })]),
    credentials: { credential: async () => slack.credential }, now: () => clock, smartModel: () => model, classifyTimeoutMs: 60_000, audit: { rate: 0 },
  });
  hubs.push(hub);
  return { hub, model };
}

const placeholderJudged = (first: string) => (first.includes("is reviewing") ? 0.05 : 0.9);

describe("an edit that turns a no-reply placeholder into the real text", () => {
  it("goes through the inbound judgement again and opens the card", async () => {
    const { hub } = setup(placeholderJudged);
    const dm = slack.dm("U0FAIRY", PLACEHOLDER);
    const head = (await hub.receive("slack", dm)).items[0]!;
    await hub.idle();
    expect(getEvent(db, head.seq!)).toMatchObject({ disposition: "no_action", dispositionDetail: { by: "assistant" } });
    expect(listChannelCardsForObject(db, head.objectKey)).toEqual([]);

    const edited = (await hub.receive("slack", slack.edit(dm, BODY))).items[0]!;
    await hub.idle();
    const card = getChannelCard(db, cardIdOf(db, edited)!)!;
    expect(card).toMatchObject({ state: "open", firstSeq: edited.seq });
    expect(getEvent(db, edited.seq!)).toMatchObject({ payload: { reopen: true, reopenOf: head.seq } });
    expect(getEvent(db, edited.seq!)!.level).not.toBe("record");
  });

  it("does not for a typo fix, which is still recorded only", async () => {
    const { hub, model } = setup(() => 0.05);
    const text = "各种连招好多。我等客户端它们优化好了。弄不动了 :facepalm:";
    const dm = slack.dm("U0FAIRY", text);
    await hub.receive("slack", dm);
    await hub.idle();
    const calls = model.calls.length;
    const edited = (await hub.receive("slack", slack.edit(dm, text.replace("优化好了", "优化好啦")))).items[0]!;
    await hub.idle();
    expect(edited).toMatchObject({ delivery: "record", cardId: null });
    expect(listChannelCardsForObject(db, edited.objectKey)).toEqual([]);
    expect(model.calls.length).toBe(calls);
  });

  it("does not after the user answered in the conversation", async () => {
    const { hub } = setup(placeholderJudged);
    const dm = slack.dm("U0FAIRY", PLACEHOLDER);
    await hub.receive("slack", dm);
    await hub.idle();
    await hub.receive("slack", slack.selfReply("D0FAIRY", "got it, will send the link"));
    await hub.idle();
    const edited = (await hub.receive("slack", slack.edit(dm, BODY))).items[0]!;
    await hub.idle();
    expect(edited).toMatchObject({ delivery: "record", cardId: null });
    expect(listChannelCardsForObject(db, edited.objectKey)).toEqual([]);
  });

  it("does not after the user dismissed a card for the message", async () => {
    const { hub } = setup(() => 0.9);
    const dm = slack.dm("U0FAIRY", PLACEHOLDER);
    const first = (await hub.receive("slack", dm)).items[0]!;
    await hub.idle();
    await hub.act(cardIdOf(db, first)!, "dismiss", { by: "user via test" });
    const edited = (await hub.receive("slack", slack.edit(dm, BODY))).items[0]!;
    await hub.idle();
    expect(edited).toMatchObject({ delivery: "record", cardId: null });
    expect(listChannelCardsForObject(db, edited.objectKey)).toHaveLength(1);
  });

  it("judges once per edit, keeps one card, and stops after three reopenings of the same message", async () => {
    const { hub } = setup(() => 0.05);
    const dm = slack.dm("U0FAIRY", PLACEHOLDER);
    const head = (await hub.receive("slack", dm)).items[0]!;
    await hub.idle();
    const versions = ["alpha ".repeat(20), "bravo ".repeat(20), "charlie ".repeat(20), "delta ".repeat(20)];
    for (const text of versions) {
      await hub.receive("slack", slack.edit(dm, text));
      await hub.idle();
    }
    const reopened = listEvents(db, { kind: "slack.message.edited" }).filter((event) => event.payload.reopen === true);
    expect(reopened).toHaveLength(3);
    expect(reopened.map((event) => event.payload.reopenOf)).toEqual([head.seq, reopened[0]!.seq, reopened[1]!.seq]);
    expect(listChannelCardsForObject(db, head.objectKey)).toEqual([]);
  });

  it("leaves a deleted message alone", async () => {
    const { hub } = setup(placeholderJudged);
    const dm = slack.dm("U0FAIRY", PLACEHOLDER);
    await hub.receive("slack", dm);
    await hub.idle();
    const removed = (await hub.receive("slack", slack.remove(dm))).items[0]!;
    expect(removed).toMatchObject({ kind: "slack.message.deleted", delivery: "record", cardId: null });
  });
});

// The same hub with Lead connected (as in the daemon), so the message event that Lead receives can be checked. The model can be
// held while it judges the placeholder: the edit then arrives before the first judgement is done.
function leadHub(options: { trusted?: string[]; hold?: boolean; urgent?: boolean } = {}) {
  const base = scriptedSmartModel({ answers: { needs_reply: (state) => placeholderJudged(state.split("\n\n")[0] ?? "") } });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let heldOnce = false;
  const calls: Array<{ purpose?: string }> = [];
  const model: SmartModel = {
    ...base,
    decide: async (state, questions, opts) => {
      calls.push({ purpose: opts?.purpose });
      if (opts?.purpose === "channel_urgency") {
        const probability = options.urgent && state.includes("looked at #123") ? 0.95 : 0.05;
        const answers = Object.fromEntries(Object.keys(questions).map((name) => [name, { type: "yes_no", probability }]));
        return { answers: answers as never, backend: "fake-jev", model: null, latencyMs: 1, fallbackFrom: null };
      }
      if (options.hold && !heldOnce && opts?.purpose === "channel_intake") {
        heldOnce = true;
        await gate;
      }
      return base.decide(state, questions, opts);
    },
  };
  const pushes: Array<{ cardId: number }> = [];
  const dispatcher = new FakeAgentTaskDispatcher(db, {});
  const hub = new ChannelHub({
    db, registry: new ChannelRegistry([createSlackChannelAdapter({ api: slack.api, now: () => clock, trust: { trusted: options.trusted ?? [] } })]),
    credentials: { credential: async () => slack.credential }, now: () => clock, smartModel: () => model, classifyTimeoutMs: 60_000, audit: { rate: 0 },
    push: (notice) => pushes.push(notice), lead: { dispatcher, available: () => true, taken: () => false },
  });
  dispatcher.hub = hub;
  hubs.push(hub);
  return { hub, model: { calls }, release, pushes };
}

const messageEvents = () => listEvents(db, { kind: MESSAGE_EVENT_KIND });
const intakeCalls = (model: { calls: Array<{ purpose?: string }> }) => model.calls.filter((call) => call.purpose === "channel_intake").length;

describe("an edit that arrives while the first judgement is still running", () => {
  it("is judged again on the latest text instead of being lost, with one card and one message event for Lead", async () => {
    const { hub, model, release } = leadHub({ hold: true });
    const dm = slack.dm("U0FAIRY", PLACEHOLDER);
    const head = (await hub.receive("slack", dm)).items[0]!;
    await expect.poll(() => intakeCalls(model)).toBe(1);
    await hub.receive("slack", slack.edit(dm, BODY));
    release();
    await hub.idle();
    expect(getEvent(db, head.seq!)!.disposition).not.toBe("no_action");
    expect(listEvents(db, { kind: "channel.reply.not_needed" })).toEqual([]);
    expect(intakeCalls(model)).toBe(2);
    expect(getChannelCard(db, cardIdOf(db, head)!)).toMatchObject({ state: "open", excerpt: BODY });
    expect(messageEvents().map((event) => event.payload.text)).toEqual([BODY]);
  });

  it("does not judge again for a typo fix", async () => {
    const { hub, model, release } = leadHub({ hold: true });
    const text = "各种连招好多。我等客户端它们优化好了。弄不动了 :facepalm:";
    const dm = slack.dm("U0FAIRY", text);
    await hub.receive("slack", dm);
    await expect.poll(() => intakeCalls(model)).toBe(1);
    await hub.receive("slack", slack.edit(dm, text.replace("优化好了", "优化好啦")));
    release();
    await hub.idle();
    expect(intakeCalls(model)).toBe(1);
  });

  it("does not open a second card or send Lead a second message when Slack delivers the same edit again", async () => {
    const { hub, release } = leadHub({ hold: true });
    const dm = slack.dm("U0FAIRY", PLACEHOLDER);
    await hub.receive("slack", dm);
    const edit = slack.edit(dm, BODY);
    await hub.receive("slack", edit);
    await hub.receive("slack", slack.redeliver(edit));
    release();
    await hub.idle();
    await hub.receive("slack", slack.redeliver(edit));
    await hub.idle();
    expect(listEvents(db, { kind: "slack.message.edited" })).toHaveLength(1);
    expect(messageEvents()).toHaveLength(1);
    expect(listChannelCardsForObject(db, "slack:D0FAIRY:main")).toHaveLength(1);
  });
});

describe("an edit that reopens a skipped message follows the normal delivery and urgency rules", () => {
  it("asks how urgent the new text is and pushes like a new direct message from a trusted sender", async () => {
    const { hub } = leadHub({ trusted: ["U0FAIRY"], urgent: true });
    const dm = slack.dm("U0FAIRY", PLACEHOLDER);
    await hub.receive("slack", dm);
    await hub.idle();
    const edited = (await hub.receive("slack", slack.edit(dm, BODY))).items[0]!;
    await hub.idle();
    expect(edited.delivery).toBe("push_card");
    expect(getEvent(db, edited.seq!)!.payload).toMatchObject({ urgent: true, reopen: true });
    // With Lead connected the card is pushed when Lead decides to tell the user; the card carries the delivery mode.
    expect(getChannelCard(db, cardIdOf(db, edited)!)).toMatchObject({ state: "open", delivery: "push_card" });
  });

  it("does not push when the new text is not urgent", async () => {
    const { hub, pushes } = leadHub({ trusted: ["U0FAIRY"], urgent: false });
    const dm = slack.dm("U0FAIRY", PLACEHOLDER);
    await hub.receive("slack", dm);
    await hub.idle();
    const edited = (await hub.receive("slack", slack.edit(dm, BODY))).items[0]!;
    await hub.idle();
    expect(edited.delivery).toBe("card");
    expect(pushes).toEqual([]);
  });
});
