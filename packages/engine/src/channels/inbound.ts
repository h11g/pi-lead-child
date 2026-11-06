// 外部通道共用的入站层（unified-message-events spec D1、D2、D6，工单 03）。别人在外部通道发给你的消息，不管来自哪个通道，
// 都按同一个顺序处理，处理完产生一条统一的消息事件（protocol 的 message-events.ts）：
//   1. 身份和去重：适配器给每件事一个投递编号，同一次投递只记一次（hub 的 record）。
//   2. 合并编辑：Lead 处理以前，对方改了消息，并进排着的那条消息事件，不产生新的 Lead 输入，也不再问一次 Jev；
//      Lead 处理以后，改过的消息按新消息再走一遍入站判断（editMergeOf）。
//   3. Jev 判定：要不要回、意图、紧急程度、敏感程度、是不是在要求改规则（hub 的 urgency、runIntake）。改规则的判断只让人
//      看得到（卡上和 Lead 的输入里写明没有照做，工单 08）；外部的一轮改不了规则由动作层的代码检查保证（工单 07）。
//   4. 外部标记：消息事件的正文都是外部的（external），交给 Lead 时包在外部标签里。
//   5. 权限上限：只按 Jev 的结论由代码算（授权表），Lead 只能收窄（messageCeiling）。
//      上下文包也在交给 Lead 以前由代码拼好，全部带外部标记（context-pack.ts，工单 04）。
//   6. 不通过的只记录、沉淀到记忆，不产生消息事件：只记录的投递方式（例如订阅频道里没提到你的消息）、机器人发的、
//      Jev 判断不用回也没人请你做事的（hub 的 record 和 settlePendingCard）。
// 通道自己的能力（例如 thread 的根消息、订阅哪些频道、回表情）在适配器里（ChannelAdapter 的 history、interest、capabilities），
// 新的外部通道只写适配器，这一层不用改。这里不出现任何具体来源的名字。
import {
  abilitiesGrantBound, CHANNEL_RULE_CHANGE_FLAG, DEFAULT_INTENT_GRANT_BOUNDS, GRANT_INTENTS, isChannelRuleChangeKind, MESSAGE_EVENT_VERSION,
  type GrantIntent, type MessageCeiling, type MessageContext, type MessageInbound, type MessageReceivedPayload, type SenderTrust,
} from "@pi-lead-child/protocol";
import type { HandbookDecision } from "./handbook-decision.js";

/** 一条消息事件的事实：hub 从入站事件、卡和 Jev 的回答里取。 */
export interface ExternalMessageInput {
  source: string;
  sourceLabel: string;
  conversation: { key: string; label: string };
  sender: { id: string; name: string; trust: SenderTrust };
  text: string;
  // Jev 的回答（channel.intake.decided 的 payload）和入站事件的紧急程度。没有回答时是 null。
  intake: Record<string, unknown> | null;
  urgent: boolean | null;
  // 授权表的结论（动作）和意图。
  authority: string;
  intent: string | null;
  // 按交接说明的结论（handbook-decision.ts）：写进权限上限，Lead 看得到起作用的一句和它的上限。没有时是 null。
  handbook?: HandbookDecision | null;
  // 回复到来源里的哪条消息（来源里的编号）。
  messageId: string | null;
  // 这条消息事件包含的入站事件（第一条是消息本身，后面是并进来的编辑）。
  messages: readonly number[];
  cardId: number;
  summary: string;
  // 上下文包（spec D5，context-pack.ts）。没拼成时是 null。
  context?: MessageContext | null;
}

const isGrantIntent = (value: string | null): value is GrantIntent => value !== null && (GRANT_INTENTS as readonly string[]).includes(value);
const probability = (value: unknown): number | null => (typeof value === "number" && value >= 0 && value <= 1 ? value : null);

/**
 * 权限上限里交接说明的部分（自动代你处理方案 B，issue 03）：起作用的一句、它的做法、压过以后的做法（Lead 的上限）、
 * 压过它的那一句、派活能用的能力、这一句的例外。没有交接说明的结论时不加。
 */
export function handbookCeiling(decided: HandbookDecision | null): Partial<MessageCeiling> {
  if (!decided) return {};
  return {
    situation: decided.situation, mode: decided.mode, final: decided.final, by: decided.by, limit: decided.limit,
    abilities: decided.abilities, exception: decided.exception, ...(decided.ruleChange ? { ruleChange: true } : {}),
  };
}

/**
 * 权限上限（spec D4）：只按授权表的结论和 Jev 的意图算。要干活的意图给派活的上限；告诉你的（对方在接着回答你）、
 * 问你的没有派活的上限。
 */
export function messageCeiling(authority: string, intent: string | null, handbook: HandbookDecision | null = null): MessageCeiling {
  // 交接说明（issue 04）：派活的上限按起作用的一句的能力算（已经按对方的上限压过）。
  if (handbook) return { authority, bound: authority !== "tell" ? abilitiesGrantBound(handbook.abilities) : null };
  return { authority, bound: authority !== "tell" && isGrantIntent(intent) ? DEFAULT_INTENT_GRANT_BOUNDS[intent] : null };
}

/**
 * 前置处理的结论（D1）。Jev 没有回答时意图、要不要回、敏感程度、改规则都是 null。改规则要改哪几类只在算是要求改规则时有
 * （第 6 版以前的判断没有这一项）。
 */
export function inboundConclusions(intake: Record<string, unknown> | null, intent: string | null, urgent: boolean | null): MessageInbound {
  const sensitive = intake?.sensitive && typeof intake.sensitive === "object"
    ? Object.fromEntries(Object.entries(intake.sensitive as Record<string, unknown>)
      .flatMap(([name, value]) => (probability(value) === null ? [] : [[name, value as number] as const])))
    : null;
  const ruleChange = probability(intake?.ruleChange);
  const kinds = ruleChange !== null && ruleChange >= CHANNEL_RULE_CHANGE_FLAG && Array.isArray(intake?.ruleChangeKinds)
    ? intake.ruleChangeKinds.filter(isChannelRuleChangeKind) : [];
  return { intent, needsReply: probability(intake?.needsReply), urgent, sensitive, ruleChange, ruleChangeKinds: kinds };
}

/** 外部通道的一条消息事件（message.received 的 payload）。正文带外部标记。 */
export function externalMessageEvent(input: ExternalMessageInput): MessageReceivedPayload {
  return {
    version: MESSAGE_EVENT_VERSION,
    entry: "external",
    source: input.source,
    sourceLabel: input.sourceLabel,
    conversation: { key: input.conversation.key, label: input.conversation.label },
    sender: { id: input.sender.id, name: input.sender.name, trust: input.sender.trust },
    text: input.text,
    external: true,
    inbound: inboundConclusions(input.intake, input.intent, input.urgent),
    ceiling: { ...messageCeiling(input.authority, input.intent, input.handbook ?? null), ...handbookCeiling(input.handbook ?? null) },
    context: input.context ?? null,
    replyTo: { conversation: input.conversation.key, message: input.messageId },
    messages: [...input.messages],
    edits: Math.max(input.messages.length - 1, 0),
    cardId: input.cardId,
    summary: input.summary,
  };
}

/** 把一次编辑并进排着的消息事件：正文换成改后的话，记下这次编辑。别的（Jev 的结论、权限上限）不变：不再问一次 Jev。 */
export function mergeEdit(queued: MessageReceivedPayload, edit: { seq: number; text: string }): MessageReceivedPayload {
  const messages = [...queued.messages, edit.seq];
  return { ...queued, text: edit.text, messages, edits: queued.edits + 1 };
}

/** 一条消息最多重开几次（reopenOf）：连续刷新的占位消息不会让每次编辑都问一遍 Jev。 */
export const REOPEN_LIMIT = 3;
/** 重开只对新鲜的编辑：补拉到的历史编辑不重开，免得旧数据变成一批新卡。 */
export const REOPEN_MAX_AGE_MS = 60 * 60_000;

/**
 * 改动是不是大到要重新判断（决策边界，纯函数）。判断「不用回」是按旧的话做的；占位变正文，长度或内容变了一大半。
 * 改错字、补几个字不算：开头和结尾没变的部分还占旧的话的一半以上，长度也没怎么变。
 */
export function materialEdit(previous: string, next: string): boolean {
  const before = previous.trim();
  const after = next.trim();
  if (Math.abs(after.length - before.length) >= Math.max(20, before.length / 2)) return true;
  const limit = Math.min(before.length, after.length);
  let head = 0;
  while (head < limit && before[head] === after[head]) head += 1;
  let tail = 0;
  while (tail < limit - head && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail += 1;
  return head + tail < before.length / 2;
}

/**
 * 对方改了一条消息（spec D6），入站层怎么处理（决策边界，纯函数）：
 *   merge_pending：这条消息还在入站判断里（Jev 还没回答），还没有它的消息事件：只记录，产生消息事件时用改后的话。
 *     判断的可能是原来的消息，也可能是 Lead 拿走以后按新消息再判断的那次编辑：又改一次时并进这次判断，不再多一次；
 *   merge_queued：判断完了，这条消息的消息事件还排着，Lead 没拿走：并进去；
 *   rejudge：Lead 已经拿走了这条消息（或者它没交给 Lead）：改过的消息按新消息再走一遍入站判断（照旧的做法）。
 */
export type EditMerge = "merge_queued" | "merge_pending" | "rejudge";

export function editMergeOf(facts: {
  // 在判断的那一条（原来的消息，或者最近一次按新消息再判断的编辑）的 Jev 判定有没有做完。
  judged: boolean;
  // 这条消息最新的消息事件：没有时是 null；有时说它还排着没有（没被并掉、Lead 没拿走）。
  latest: { queued: boolean } | null;
}): EditMerge {
  if (!facts.judged) return "merge_pending";
  return facts.latest?.queued ? "merge_queued" : "rejudge";
}
