// 通道的 hub（Lead 事件主干 spec D2、D3、D10、D14，工单 11）：外部来源的事件从这里进系统，出站动作从这里出去。
// 这里不出现任何具体来源的名字：来源的知识都在适配器里（registry 登记的）。
//
// 进来（receive）：
//   1. 鉴权：适配器的凭据要在（connections 表的连接，或者适配器声明的 daemon 专用密钥），推来的投递要通过适配器的校验
//      （例如签名）。不通过的不记。适配器自己的进程内传输（例如 Socket 连接）送来的投递走 receiveFromTransport：
//      只有进程内的代码能调用它（不经过 HTTP），不校验签名。
//   2. 适配器认出几件事。每件事写一条事件（来源是适配器的名字，source_ref 是投递编号：同一次投递只记一次），
//      分诊照常按常设指令定级别（外部来源最高 tell，永远不插进 Lead 的回合）。
//      别人发来的消息先问 SmartModel 紧不紧急（urgency.ts，对所有来源一样），结果和依据写进事件的 urgent、urgency。
//      问在事务外面、入库之前，几件事并行地问；入库按解析完的先后一件一件来（模型先回答了后到的消息，它也不会排到前面）。
//      同一次投递正在问或者已经记过时不再问。问不成（没有模型、超时、出错）时按不紧急处理，照常入库、开卡。
//   3. 分道：每件事记进它的道（对话）的上下文。用户本人的话（self_reply）、系统替用户发的话被推回来（echo）
//      只在道已经存在时才记：别的对话里用户说什么和这里无关。
//      只记录的消息（投递方式是 record）不开新道：道是用户在场的对话。没有道时它只进事件日志，不进 Lead 的道摘要。
//      改消息和删消息（amends）也不开新道：没有道时（适配器认为和用户有关，例如订阅频道里的线程）只记录，给记忆沉淀用。
//      紧急也只会记录的消息不问紧急程度。
//   4. 别人发来的消息按常设指令 channel.delivery 定投递方式。只记录的不开卡；其余开卡或者更新这个对话没结束的那张卡
//      （一个对话同一时间一张卡，状态原地更新）。推送加会话卡的另外推一条通知。改消息、删消息只更新没结束的卡，不开新卡。
//   5. 用户本人的话：在后台问 SmartModel 这句话是不是回答了对方（self-reply.ts）。回答了，这个对话没结束的卡「别处已处理」，
//      处置是 resolved_elsewhere；只是说收到、稍等（或者问不成），卡留着，标成「你在来源里回复过」（replying_self），不再推送。
//      你点过「我自己回」的卡已经结束（left_to_user）：这句话只给卡上的草稿打校准标签，不改卡（统一消息事件 spec D11）。
//   6. 别人发来的消息在后台问请求 A（intake.ts，不阻塞投递）：对方的意图、收尾的种类、敏感查询、要不要回，写一条
//      channel.intake.decided。授权表（authority.ts，常设指令 channel.authority）定通道做什么：不打扰的只记录，
//      别的都交给 Lead（落地计划 B），授权表的结论是权限上限和建议。没有接 Lead 时：回表情、代你拒绝照授权表做，别的卡等你处理。
//   卡上的草稿只由 Lead 写（统一消息事件 spec D8，工单 06 删了起草器）：Lead 还没处理的卡没有草稿，卡上写明在排队等 Lead。
//   统一的消息事件（unified-message-events spec D1、D2、D6，工单 03）：交给 Lead 的是一条消息事件（message.received，
//   外部通道共用的入站层 inbound.ts 产生）：带对方的原话（外部标记）、前置处理的结论和权限上限。这条消息事件就是交给 Lead
//   的请求（工单 05，不再另记 channel.lead.requested）：带 forSeq 和代码认出的对象，没有期限（工单 06）。对方改了消息：Lead 拿走以前并进那条
//   消息事件（不再问一次请求 A），拿走以后按新消息再判断（mergeEditNow、editMergeFor）。
//   消息事件带上下文包（spec D5，工单 04，context-pack.ts）：交给 Lead 以前由代码拼好（这个对话最近的消息、别的对话里的
//   相关消息、提到的对象和状态、以前的卡、记忆里的笔记），拼的时间有上限；每个上下文包记一条 message.context_packed。
//   拼的时候对方改了消息：并进这次判断（packing），不多一次 Lead 输入。消息改了以后（拼包时又改了，或者编辑并进排着的
//   消息事件），上下文包按改后的话同步重拼（repackContext）。
// 交给 Lead 以后（统一消息事件 spec D6、D8、D9，工单 05）：Lead 只用通用工具，都按消息事件找卡：派活（leadDispatch，
//   C 的派单器，权限由代码按授权表算，只有 Lead 派活时才在来源里说「正在处理」）、回复到来源（sendMessage 的出站扩展）、
//   回表情（react）、告诉你（leadNotify，带 Lead 写的草稿）、记下已处理（leadDisposed）。Lead 做了哪一件，请求就关掉，
//   卡跟着 Lead 的动作走。问涉密信息的，Lead 用回复到来源的固定拒绝（只能是固定的话，refuseForLead）。
// Lead 不能工作时（spec D7，工单 06）：系统不替 Lead 做决定，不对外发任何东西（不回复、不回表情、不拒绝、不派活）。
//   卡照常显示，按投递方式推送（pushWhileLeadDown）；消息事件照样是 tell 级，Lead 恢复以后按顺序处理。
//   子 agent 工单记成这张卡的一次「代查」（channel_lookups）。
// 外部通道的出站扩展（spec D9）：Lead 不在你这一轮里写的话（卡上的发送、往对话发消息、reply_to_source 都一样）由 Lead 自己判断，
//   直接代你发，带 auto-reply 署名，回复卡的留撤回窗口。不过信心检验，不变成卡上的草稿（用户 2026-10-29：「我期望它就能自己做判断」）。
//   你这一轮明确要发的带 confirmed by 署名。
// 子 agent 工单结束（agentTaskFinished，派单器的回调）：问请求 B（reply-check.ts），信心模型（confidence-model.ts）决定：
//   代你回（改写「正在处理」那一条，带披露署名，留撤回窗口），或者问你、交给你（channel.task.finished 交回 Lead）。
// 每一拍（tick）：「稍后」到点的卡重新打开并提醒；没发成的回复用同一个幂等键再发；还没定开不开卡的消息补上；
//   Lead 不能工作时把还没处理的、要推送的卡推一次；第一拍把还没结束的旧代查记成失败（代查退役，落地计划 D1）。
// 卡上的动作（act）：用草稿回复、改一下再发、我自己回、稍后、不回、撤回自动回复、停掉在跑的子 agent 工单。
// 每个动作写一条事件，并给这张卡的事件记处置。
// 校准（落地计划 D2，calibration.ts）：信心模型给每份要代你发的草稿打的分记成 channel.reply.scored（卡上的分数面板）；
//   你实际做了什么记成它的标签（channel.reply.labeled）：照发、改了再发、撤回当场记；别的等卡结束以后，看你在来源里回没回。
//   样本不分任务；本该代你发的抽 5% 照样问你。
// Lead 的隔离（spec D10）：道的一行摘要不带原文；Lead 读对话时卡的事实来自 cardForLead（原文由 Lead 的工具包上不可信的标签）。
// Lead 代用户直接发消息（2026-10-23）：findConversations 找对话，sendMessage 往一个对话里发一条，不经过卡片。只由操作层调用
// （engine 的 ui-actions/ 的 channel_conversation：在哪一轮都能发，不在你这一轮里的带 auto-reply 署名）。
// 卡跟着做完的事结束（用户 2026-10-26：你用自然语言让 Lead 做了卡上的事，卡不应该还等着你点）：
//   - Lead 代你在一个对话里发了消息：这个对话里等你的卡由代码结束（已回复），「正在处理」改写成这条消息；
//   - Lead 在别处做完了卡上的事（卡的 handled，或者发消息时带 cardId）：卡结束，缺省在对方的消息上回 ✅；
//   - Lead 代你回表情（react）：回的是卡上最新的一条时，卡也结束（handled）。
//   你这一轮开始以后对方又发来的，你说话时还没见过：卡不结束（seenBefore）。
// 「正在处理」是对对方的一句承诺（用户 2026-10-26）：回复改写它；工作没有回复就结束了（卡结束、工单交给你、你说自己回），
// 就删掉它（settleStatusNotices）。每一拍补收最近 24 小时漏下的（删失败了、daemon 重启了），有界、幂等。
import { randomUUID } from "node:crypto";
import {
  CHANNEL_CARD_NOTE_MAX, CHANNEL_CARD_OPEN_STATES, CHANNEL_CARD_TEXT_MAX, CHANNEL_EMOJI_NAME_PATTERN, CHANNEL_EVENT_KINDS, CHANNEL_HANDLED_EMOJI, CHANNEL_DELIVERY_LABELS, CHANNEL_INTENT_LABELS,
  AGENT_TASK_LIMITS, AUTHORITY_INTENT_SITUATIONS, CHANNEL_AUTHORITY_ACTIONS, CHANNEL_AUTHORITY_DEFAULTS, CHANNEL_HANDBOOK_DEFAULTS, CHANNEL_LEAD_DECISIONS,
  abilitiesGrantBound, ATLASSIAN_CONNECTION, HANDBOOK_ABILITIES, HANDBOOK_FALLBACK_ID, HANDBOOK_MODE_LABELS, HANDBOOK_MODE_PHRASES,
  handbookModePhrase, isHandbookMode, situationIntent,
  type HandbookAbility, type HandbookMode, type HandbookSituation, CHANNEL_REACTION_EMOJIS, CHANNEL_REPLY_DECISIONS,
  CHANNEL_REPLY_DRAFT_KINDS, CHANNEL_LOOKUP_CHECK_STATUSES, CHANNEL_RULE_CHANGE_FLAG, DEFAULT_INTENT_GRANT_BOUNDS, channelPolicyLabels,
  channelRuleChangeNotice, isChannelRuleChangeKind, type ChannelRuleChangeKind,
  GRANT_INTENTS, describeRunGrant, SENDER_TRUST_LABELS, isChannelClosingKind, isChannelIntent,
  isSenderTrust, NEVER_DELEGATED_TRUST, redactSecretText, strongerDelivery,
  type ChannelCardAction, type ChannelCardDto, type ChannelHandbook, type HandbookRehearsal, type HandbookRehearsalRequest, type ChannelCardState, type ChannelDeliveryMode, type ChannelIntent,
  type ChannelReactionEmoji, type EventDisposition, type SenderTrust, CHANNEL_POLICY_DEFAULTS, CHANNEL_POLICY_REPLAY_HOURS,
  CHANNEL_POLICY_REPLAY_MAX_CALLS,
  type ChannelPolicyParams, type ChannelPolicyReplayResult, type ChannelPolicyTestRequest, type ChannelPolicyTestResult,
  type AgentTaskDispatch, type AgentTaskDispatcher, type AgentTaskOutcome, type ChannelAuthorityActionKind, type ChannelCardHandling,
  type ChannelLeadDecision, type ChannelLeadStage,
  type ChannelReplyDecision, type ChannelReplyDraftKind, type ChannelReplyLabel, type ChannelLookupCheckStatus, type ConnectionSource, type GrantIntent,
  type ExternalGrantScope, type GrantReviewEvent, type IntentGrantBound, type LookupSource, isExternalReviewEvent,
  MESSAGE_CONTEXT_EVENT_KIND, MESSAGE_EVENT_KIND, messageEventConversationKey, type MessageReceivedPayload,
} from "@pi-lead-child/protocol";
import { LLM_BACKEND } from "../smart-model/llm.js";
import type { SmartModel, SmartTextComplete } from "../smart-model/types.js";
import {
  appendEvent, appendEventGuarded, channelAuthorityTable, getChannelCatchUpMark, setChannelCatchUpMark, channelDelegatePolicy, channelHandbook, CHANNEL_HANDBOOK_ORDER_ID, channelDeliveryPolicy, channelPolicy, channelReplyPolicy,
  clipEventText, createChannelLookup, findNoteByTitle, getActiveLookupForCard, getChannelCard, getChannelLane,
  getChannelLaneById, getChannelLookup, getEvent, getLocale, getRun, getLatestChannelCard, getLatestLookupForCard, getOpenChannelCard, hasRecentChannelLane, isActiveLookupState,
  leadDisplayName, listActiveLookups, listChannelCards, listChannelCardsForObject, listDueSnoozedChannelCards,
  listOpenChannelLanes, listRecentChannelLanes, openChannelCard,
  recordChannelLaneMessage, setChannelLaneOrigin, setChannelLaneSummary, setEventDisposition, syncSystemStandingOrders, updateChannelCard,
  updateChannelLookup, CHANNEL_LANE_ORIGIN_LIMIT,
  type ChannelCard, type ChannelCardPatch, type ChannelCardSent, type ChannelLane, type ChannelLaneMessage, type ChannelLookup,
  type Db, type EventRecord,
} from "@pi-lead-child/store";
import { channelDeliveryDecision } from "./delivery.js";
import {
  AUTHORITY_ANSWER_WINDOW_MS, AUTHORITY_ORDER, AUTHORITY_REFUSAL_TEXT, AUTHORITY_REVOKE_WINDOW_MS, closingReaction, type AuthorityAction,
} from "./authority.js";
import { DELEGATION_GATE_LABELS } from "./delegation-gate.js";
import { channelHubMessages } from "./hub.messages.js";
import {
  autoReplyDisclosure, confirmedDraftDisclosure, defaultHandlingVerb, disclosureAssistantName, disclosureOwnerName, handlingNotice,
  isHandlingVerb, ownerReplyDisclosure,
} from "./disclosure.js";
import {
  buildContextPack, contextParts, repackForText, type BuiltContextPack, type ContextPackDeps, type ContextPackInput, type ContextPackOptions,
} from "./context-pack.js";
import {
  editMergeOf, externalMessageEvent, materialEdit, mergeEdit, messageCeiling, REOPEN_LIMIT, REOPEN_MAX_AGE_MS, type EditMerge,
} from "./inbound.js";
import { decideByHandbook, type HandbookDecision } from "./handbook-decision.js";
import { handbookDecisionFor } from "./handbook-suggestions.js";
import {
  BUSINESS_MAP_NOTE_TITLE, channelIntakeRef, CHANNEL_INTAKE_QUESTION_VERSION, CHANNEL_INTAKE_TIMEOUT_MS, judgeChannelIntake, judgeHandlingVerb, type ChannelIntakeResult, type ChannelLookupCandidate,
} from "./intake.js";
import { lookupDto } from "./lookup-dto.js";
import { ChannelOutbox, scrubCredential, type ChannelOutboundOutcome, type ChannelOutboundPurpose } from "./outbound.js";
import type { ChannelRegistry } from "./registry.js";
import { CHANNEL_REPLY_CHECK_TIMEOUT_MS, draftOnlyResult, judgeReplyCheck, type ChannelReplyCheckResult } from "./reply-check.js";
import {
  auditsReply, settledReplyLabel, CHANNEL_REPLY_AUDIT_RATE, CHANNEL_REPLY_LABEL_RULES, CHANNEL_REPLY_LABEL_SETTLE_MS,
} from "./calibration.js";
import {
  evaluateConfidenceModel, type ConfidenceModelInput, type ConfidenceModelParams, type ConfidenceModelResult,
} from "./confidence-model.js";
import {
  channelCalibration, confidenceParamsFrom, judgePastMessages, judgePolicyCase, pastChannelMessages, scoredInputRecord, scoreTestMessage,
  type DraftScores, type PastChannelMessage,
} from "./policy.js";
import { maskEmails } from "./pii-mask.js";
import { channelReplyDecision, type ChannelReplyDecisionResult } from "./reply-decision.js";
import { replyConfidenceBucket } from "./reply-gate.js";
import { CHANNEL_SELF_REPLY_TIMEOUT_MS, judgeSelfReply } from "./self-reply.js";
import { CHANNEL_URGENCY_TIMEOUT_MS, channelUrgencyNotAsked, judgeChannelUrgency, type ChannelUrgency } from "./urgency.js";
import type {
  ChannelAdapter, ChannelAdapterContext, ChannelCredential, ChannelCredentialSource, ChannelDelivery,
  ChannelConversationCandidate, ChannelInbound, ChannelInboundRole, ChannelInterest, ChannelOpenCard, ChannelOpenLane, ChannelReaction,
  ChannelConversationRead, ChannelEditedMessage, ChannelFile, ChannelMarkPreview, ChannelRecentConversation, ChannelSentMessage,
  ChannelCatchUpReport, ChannelTransportContext,
} from "./types.js";
import { ChannelFileNotFoundError } from "./types.js";

export interface ChannelPushNotice {
  cardId: number;
  title: string;
  body: string;
}

export interface ChannelHubOptions {
  db: Db;
  registry: ChannelRegistry;
  credentials: ChannelCredentialSource;
  now?: () => Date;
  log?: (line: string) => void;
  // 卡变了（新开、更新、结束）：daemon 推 snapshot.required，客户端重取。
  onCardsChanged?: (cardIds: number[]) => void;
  // 推送加会话卡、「稍后」到点：daemon 推到用户的手机或桌面。
  push?: (notice: ChannelPushNotice) => void;
  // 等分类等多久。超过以后闸门按「没有分类」拒绝（卡已经投递了，只是不会自动回复）。缺省 5 分钟。
  classifyTimeoutMs?: number;
  // 「稍后」等多久。缺省 1 小时。
  snoozeMs?: number;
  // 没发成的回复隔多久再发（连续失败时翻倍），最多发几次。缺省 30 秒、5 次。
  outboundRetryBaseMs?: number;
  outboundMaxAttempts?: number;
  // 判断别人发来的消息紧不紧急用的 SmartModel（urgency.ts）。daemon 给的是 Lead 会话的那一个（Jev 优先，LLM 兜底）。
  // 每条消息调用一次：会话中途才建好、换了模型时也拿到新的。不给或者返回 null 时，消息都按不紧急处理。
  smartModel?: () => SmartModel | null;
  // Lead 的便宜模型（Haiku）的自由文本补全。收件判断在决策模型没有配置或者失败时用它（intake-llm.ts，issue 10）。不给时只问决策模型。
  textModel?: () => SmartTextComplete | null;
  // 问紧急程度最多等多久。缺省 CHANNEL_URGENCY_TIMEOUT_MS。
  urgencyTimeoutMs?: number;
  // 请求 A 的 target_repo 选项（daemon 的 listLookupCandidates）。每次问请求 A 调一次。
  lookupCandidates?: () => readonly ChannelLookupCandidate[];
  // 披露署名里的主人名的第二选择（配置 channels.ownerName）。第一选择是凭据里的 accountName，最后是「用户」。
  ownerName?: () => string | null;
  // 披露署名里的助手名：daemon 给配置的 channels.assistantName，没有时是 Lead 的名字。不给或者是空的时用 disclosure.ts 的缺省名字。
  assistantName?: () => string | null;
  // 交给 Lead（落地计划 B，用户 2026-10-22）。给了时：不打扰的以外的消息（和信心模型交回的「问你、交给你」）都交给 Lead
  // 决定，卡不马上推送；没有期限，系统不替 Lead 决定（工单 06）。Lead 不能工作时卡按投递方式推送，不对外发任何东西。
  // 没给时卡按投递方式推送，等你处理（旧的代查剧本退役了，落地计划 D1）。
  lead?: ChannelLeadOptions;
  // 认出原文里的 PR（交给 Lead 的请求里「代码认出的对象」，落地计划 B1）。daemon 给的只认明确的语法（链接、owner/repo#n）。
  pullRequestOf?: (text: string) => { owner: string; repo: string; number: number } | null;
  // 请求 A、请求 B、自己的回复各自最多等多久。缺省都是 8 秒（spec D3、D6）。
  intakeTimeoutMs?: number;
  // 请求 A 的 needs_reply 低于它时，新消息不开卡（用户 2026-10-21：先判断要不要回，再开卡）。缺省 0.3。
  noReplyBelow?: number;
  // 还没定开不开卡的消息，收到多久以后由每一拍补上（例如判断时 daemon 重启了）。缺省 60 秒。
  pendingCardGraceMs?: number;
  replyCheckTimeoutMs?: number;
  // 抽查（落地计划 D2）：信心模型说代你发的，按 rate 的概率照样放到卡上问你。缺省 5%，random 缺省 Math.random（测试里给定）。
  audit?: { rate?: number; random?: () => number };
  // 卡结束以后等多久再按你在来源里的做法给草稿定标签。缺省 30 分钟。
  labelSettleMs?: number;
  // 取历史（补起点）最多等多久。缺省 3 秒。
  historyTimeoutMs?: number;
  selfReplyTimeoutMs?: number;
  // 上下文包（统一消息事件 spec D5，工单 04）：对话摘要用的便宜模型、对象的状态、笔记的召回、拼的时间上限。
  // 不给时只有读库的几项，对象的状态写「没查到」，更早的消息没有摘要。
  contextPack?: ContextPackOptions;
  // 用户本人写给 Lead 的话（role owner，例如 Slack 里发给自己的私信，用户 2026-10-30）：daemon 认出是用户本人以后，
  // 按用户本人的一轮交给 Lead，返回 true。返回 false（例如用户撤销了这个入口）、抛错或者不给时，hub 照用户本人的话（self_reply）处理。
  owner?: (message: ChannelOwnerMessage) => boolean | Promise<boolean>;
}

/** 用户本人写给 Lead 的一句话（ChannelHubOptions.owner）。 */
export interface ChannelOwnerMessage {
  source: string;
  // 来源里的用户本人：凭据的 account 和名字。daemon 按它认这个入口是谁的。
  account: string;
  accountName: string | null;
  // 来源自己的投递编号（去重用）。没有时为 null。
  deliveryId: string | null;
  // 回复发到哪里：对话编号，交给 replyToOwner。
  conversation: string;
  text: string;
  occurredAt: string;
}

// 信心模型给一份草稿打的分（落地计划 A6、D2）：模型的结论，抽查以后的结论（decision），卡上的形状（gate），是不是抽查。
interface ScoredDraft {
  // 打分用的模型输入（不含校准）：记进 channel.reply.scored，面板的「过去 24 小时的消息」用它里面草稿的分数，不再调请求 B。
  input: Omit<ConfidenceModelInput, "calibration">;
  model: ConfidenceModelResult;
  decision: ConfidenceModelResult["decision"];
  gate: ChannelReplyDecisionResult;
  audit: boolean;
}

// 一次出站的回复：发什么、用哪个幂等键、是不是草稿原样（用户的选择）、谁发的。
// 带署名的回复有 parts（disclosure.ts）：text 是完整的一条，parts 给有样式的来源排版。
interface OutgoingReply {
  key: string;
  text: string;
  parts?: { byline: string; body: string | null };
  fromDraft: boolean;
  by: "user" | "auto";
}

// 助手写的草稿（代查的、Lead 写的、子 agent 的；model 是旧卡上按对话起草的，工单 06 删了起草器）：用户点「用草稿回复」
// 发出时加「confirmed by」的署名（spec D8）。模板的草稿不加。
const ASSISTANT_DRAFTERS: ReadonlySet<string> = new Set(["lookup", "lead", "model", "agent"]);
const DAY_MS = 24 * 60 * 60_000;
// 代查的自动回复的幂等键：auto:card:<卡>:lookup:<代查>。这是我们自己生成的文字，重发时按它认出是哪一次代查。
const LOOKUP_AUTO_KEY = /^auto:card:\d+:lookup:(\d+)$/;
// review 发到 PR 以后在来源里的那句回复的幂等键：review:card:<卡>:lookup:<代查>（工单 06）。一次代查只回一次。
const REVIEW_REPLY_KEY = /^review:card:\d+:lookup:\d+$/;
// 用固定的话代你拒绝的回复（落地计划 A5；工单 06 起由 Lead 用回复到来源的固定拒绝发）。
const REFUSE_KEY = /^refuse:card:\d+:seq:\d+$/;
// 子 agent 工单的结果代你回的一句、Lead 写的草稿代你发的一句（落地计划 B）。
const TASK_KEY = /^task:card:\d+:run:\d+$/;
const ANSWER_KEY = /^answer:card:\d+:seq:\d+$/;

// no_connection：这个来源现在没有可用的凭据（没有连接，或者缺适配器声明的密钥）。
export type ChannelReceiveRejection = "unknown_source" | "no_connection" | "unauthenticated" | "unparseable";

export interface ChannelReceiveItem {
  seq: number | null;
  // false：同一次投递已经记过，这一次什么也没做。
  inserted: boolean;
  kind: string;
  role: ChannelInboundRole;
  objectKey: string;
  cardId: number | null;
  delivery: ChannelDeliveryMode | null;
  // no_lane：用户本人的话（或者推回来的回复）不在任何已有的对话里，没有记。
  ignored?: "no_lane";
  // owner：用户本人写给 Lead 的话交给了 daemon（ChannelHubOptions.owner），不记成通道的事件。
  handedTo?: "owner";
  // 这件事没有记成（例如适配器给的类型没有注册、payload 不合 schema）。
  error?: string;
}

export interface ChannelReceiveResult {
  accepted: boolean;
  rejection?: ChannelReceiveRejection;
  items: ChannelReceiveItem[];
}

// 入库以后要在后台做的事：请求 A（别人发来的消息开了卡）、判断用户自己的话（这个对话有没结束的卡）。
// intake 的 cardId 是 null：这条消息还没有卡，先判断要不要用户回，再开卡（runIntake → settlePendingCard）。
type FollowUp = { kind: "intake"; cardId: number | null; seq: number } | { kind: "self_reply"; cardId: number; seq: number };
type RecordResult = { item: ChannelReceiveItem; card: ChannelCard | null; push: boolean; followUp?: FollowUp };

/** Lead 读一张卡（read_channel_conversation 带出卡的事实）：卡的线上形状，加上这条道最近的消息（外部原文，不可信，由 Lead 的工具包上标签）。 */
export interface ChannelCardForLead {
  card: ChannelCardDto;
  // seq：消息的事件编号（Lead 代你回表情时指定哪一条）；系统代你发的、记在道里的没有时是 null。
  messages: Array<{ at: string; seq: number | null; role: "them" | "me" | "assistant"; sender: string; text: string }>;
  // 还在等 Lead 决定的请求（落地计划 B），没有时是 null。
  request?: Omit<LeadRequest, "seq" | "channel"> | null;
  // 这张卡派过的子 agent 工单：谁派的、结局、回复的结论。
  tasks?: Array<{ itemId: number; runId: number; by: string; status: string | null; reply: string | null }>;
}

/** 交给 Lead 的选项（落地计划 B）。 */
export interface ChannelLeadOptions {
  // C 的派单器（daemon 的 agentTasks）：Lead 用它派子 agent 工单。
  dispatcher: Pick<AgentTaskDispatcher, "dispatch"> & Partial<Pick<AgentTaskDispatcher, "cancel">>;
  // Lead 现在能不能工作（daemon 的 leadIncapacity，Jarvis 模式的判断）。不能时卡按投递方式推送，系统不替 Lead 做任何事。
  available: () => boolean;
  // Lead 已经拿走了这条消息事件（交给了正在跑的一轮，或者处理完了）：daemon 的 Lead 输入回答。对方改消息时，
  // 拿走以前并进去，拿走以后按新消息再判断（统一消息事件 spec D6）。不给时只看这条事件有没有处置。
  taken?: (seq: number) => boolean;
}

/** 子 agent 工单的 Run 结束以后，结果最多等多久交回；过了按没有交回处理（settleLostTasks）。 */
const TASK_RESULT_GRACE_MS = 60_000;
/** 子 agent 工单交回结果时的回调名：daemon 把 C 的派单器的这个回调接到 hub.agentTaskFinished。 */
export const CHANNEL_TASK_CALLBACK = "channel";

/** 代码从消息里认出的对象（例如 PR 链接）。 */
export interface ChannelLeadObject {
  kind: "pull_request";
  owner: string;
  repo: string;
  number: number;
}

/**
 * 一个交给 Lead、还没有决定的请求（统一消息事件工单 05）：intake 是外部通道的消息事件（message.received），reply 是交回 Lead 的
 * 子 agent 结果（channel.task.finished 的 handedBack）。seq 是那条事件；event 是这张卡的消息事件（Lead 的通用工具按它找卡）。
 */
export interface LeadRequest {
  seq: number;
  event: number | null;
  channel: string;
  cardId: number;
  forSeq: number;
  stage: ChannelLeadStage;
  intent: ChannelIntent | null;
  action: string;
  reason: string;
  objects: ChannelLeadObject[];
  bound: IntentGrantBound | null;
  // 交接说明的上限（issue 03）：起作用的一句、压过以后的做法和派活能用的能力。旧事件、子 agent 交回的结果是 null。
  handbook: { situation: { id: string; text: string }; final: HandbookMode; abilities: HandbookAbility[]; ruleChange: boolean } | null;
}

/** Lead 改选一句以后的上限（repick_situation，用户 2026-10-30 定 D1）。 */
export interface ChannelLeadRepicked {
  cardId: number;
  situation: { id: string; text: string };
  final: HandbookMode;
  by: string;
  limit: string | null;
  abilities: string[];
  next: string;
}

/** Lead 派工单时选的范围（只能收窄）。不给的项按授权表的上限。 */
export interface ChannelLeadDispatchInput {
  summary: string;
  intent?: GrantIntent;
  pullRequest?: { owner: string; repo: string; number: number };
  repos?: string[];
  localRepos?: string[];
  connections?: string[];
  reviewEvents?: GrantReviewEvent[];
}

export interface ChannelLeadDispatchResult {
  itemId: number;
  runId: number;
  // 算出来的清单（一句话一条）。
  grant: string[];
  // Lead 要的、超出上限被丢掉的部分。
  dropped: string[];
}

/** Lead 记下怎么处理一条消息事件（record_disposition）以后，卡怎样了。 */
export interface ChannelLeadDisposed {
  cardId: number;
  state: ChannelCardState;
  note: string | null;
}

export type ChannelActionErrorCode ="not_found" | "conflict" | "invalid_action" | "outbound_failed" | "unavailable";

export class ChannelActionError extends Error {
  constructor(readonly code: ChannelActionErrorCode, message: string) {
    super(message);
    this.name = "ChannelActionError";
  }
}

const EXCERPT_MAX = 280;
// 起点里放被回复的那条之前的几条（同一个对话里的）。只有根消息在另一个对话里时才放（例如私信的 thread，根消息在整段私信里）：
// 私信里很多人直接在根上发消息，收到 thread 里的话时先看前面 10 条根消息（被回复的那条和它之前的 9 条，用户 2026-11-02）。
const ORIGIN_BEFORE = 9;
const HISTORY_TIMEOUT_MS = 3_000;

// 事件 payload 里的 replyTo（ChannelInbound.replyTo）。形状不对时当作没有。
function replyToOf(payload: Record<string, unknown> | undefined): { objectKey: string; ref: string } | null {
  const value = payload?.replyTo as { objectKey?: unknown; ref?: unknown } | undefined;
  return value && typeof value.objectKey === "string" && typeof value.ref === "string" ? { objectKey: value.objectKey, ref: value.ref } : null;
}

function laneRoleOf(role: unknown): ChannelLaneMessage["role"] {
  return role === "self_reply" ? "me" : role === "echo" ? "assistant" : "them";
}

// 请求 A 看的上下文：起点（回复的那条和它之前的几条），加上这条消息之前最近的 5 条。
function recentForIntake(context: readonly ChannelLaneMessage[], seq: number): Array<{ role: ChannelLaneMessage["role"]; text: string; origin?: boolean }> {
  const before = context.filter((message) => message.seq === null || message.seq < seq);
  const origin = before.filter((message) => message.origin).map((message) => ({ role: message.role, text: message.text, origin: true }));
  const rest = before.filter((message) => !message.origin).slice(-5).map((message) => ({ role: message.role, text: message.text }));
  return [...origin, ...rest];
}
const TEXT_MAX = 4_000;
// 卡的事件被别的处置覆盖时，只覆盖这些（Lead 看过的、暂时搁着的）。最终的处置不改。
const OVERWRITABLE: readonly EventDisposition[] = ["digested", "seen", "deferred"];
// 启动时一次改成结束的旧「我自己回」卡，最多这么多张（endLegacyReplyMyselfCards）。
const LEGACY_REPLY_MYSELF_MAX = 500;

const oneLine = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
};
const clock = (iso: string) => {
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

export class ChannelHub {
  private readonly db: Db;
  private readonly now: () => Date;
  private readonly log: (line: string) => void;
  private readonly outbox: ChannelOutbox;
  private readonly classifyTimeoutMs: number;
  private readonly snoozeMs: number;
  private readonly retryBaseMs: number;
  private readonly maxAttempts: number;
  private readonly urgencyTimeoutMs: number;
  // 给了时（测试）用它；没给时用常设指令 channel.authority 里的不打扰线（面板上调的，2026-10-23）。
  private readonly noReplyBelowOption: number | undefined;
  private readonly pendingCardGraceMs: number;
  // 每个来源扫「还没定开不开卡的消息」从哪个事件以后开始（settleStalePendingCards）：比它早的都定了。启动时是 0，扫一遍以后往前走。
  private readonly pendingScanFrom = new Map<string, number>();
  private readonly sending = new Set<number>();
  private ticking: Promise<void> | null = null;
  // 正在进行的 receive：idle() 等它们。
  private readonly receiving = new Set<Promise<ChannelReceiveResult>>();
  // 正在问紧急程度的投递（来源 + 投递编号）：同一次投递又来时共用这一次的回答，不再问。
  private readonly judging = new Map<string, Promise<ChannelUrgency | null>>();
  // 入库的队尾：每次 receive 解析完以后排一个位置，按位置一个一个入库。
  private recordTail: Promise<void> = Promise.resolve();
  // 在后台进行的事（请求 A、自己的回复、代查结束以后的核对和代回）：idle() 等它们。
  private readonly background = new Set<Promise<void>>();
  // 正在派工单的请求（stage:forSeq）：同一个请求不会派两次。
  private readonly leadDeciding = new Set<string>();
  // Lead 不能工作时已经推过的请求（stage:forSeq）：一次停摆里一个请求只推一次。Lead 能工作时清空（只在内存里：daemon 重启以后
  // Lead 还不能工作，会再推一次）。
  private readonly pushedWhileDown = new Set<string>();
  // 判断完了、正在拼上下文包、还没记消息事件的消息（事件编号）：这时对方改了消息，并进这次判断（editMergeFor）。
  private readonly packing = new Set<number>();
  // 第一拍把还没结束的旧代查记成失败（代查退役，落地计划 D1）。
  private retiredOldLookups = false;
  // 上一次给结束的卡定标签的时间（labelSettledReplies 最多一分钟一次）。
  private labeledAt = 0;
  // 还在发的状态消息，按卡：回复先等它发完，才知道要不要改写它。
  private readonly statusNotices = new Map<number, Promise<void>>();
  // 每个来源最近一次取到的主人名（凭据的 accountName）。卡的 DTO 是同步的，用这里的。
  private readonly ownerNames = new Map<string, string>();
  // 过去的消息（replayPolicy）里，现在调请求 B 给草稿打的分：来源、卡、草稿的时间 → 分数。只留在内存里，最多
  // REPLY_CHECK_CACHE_MAX 份，先进先出。
  private readonly replyChecks = new Map<string, ChannelReplyCheckResult>();

  constructor(private readonly options: ChannelHubOptions) {
    this.db = options.db;
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? (() => {});
    this.outbox = new ChannelOutbox({ db: this.db, now: this.now, log: this.log });
    this.classifyTimeoutMs = Math.max(options.classifyTimeoutMs ?? 5 * 60_000, 0);
    this.snoozeMs = Math.max(options.snoozeMs ?? 60 * 60_000, 1);
    this.retryBaseMs = Math.max(options.outboundRetryBaseMs ?? 30_000, 0);
    this.maxAttempts = Math.max(options.outboundMaxAttempts ?? 5, 1);
    this.urgencyTimeoutMs = Math.max(options.urgencyTimeoutMs ?? CHANNEL_URGENCY_TIMEOUT_MS, 1);
    this.noReplyBelowOption = options.noReplyBelow === undefined ? undefined : Math.min(Math.max(options.noReplyBelow, 0), 1);
    this.pendingCardGraceMs = Math.max(options.pendingCardGraceMs ?? 60_000, 0);
    // 插件的种子在登记适配器时才有：这个库打开得更早时，现在同步进去。
    syncSystemStandingOrders(this.db, this.now());
    this.endLegacyReplyMyselfCards();
  }

  /**
   * 启动时一次：以前点了「我自己回」的卡停在 replying_self，等你在来源里回复（统一消息事件 spec D11 以前）。改成结束（left_to_user）。
   * 认法：卡上记过 reply_myself 的动作，或者卡不是因为你在来源里回过一句才停在这里的。改过的不再匹配（幂等），
   * 一次最多 LEGACY_REPLY_MYSELF_MAX 张。你在来源里回过一句、没点按钮的卡不动（还开着，spec D11 的第 4 条）。不抛错。
   */
  private endLegacyReplyMyselfCards(): void {
    try {
      const rows = this.db.prepare(
        `SELECT c.id FROM channel_cards c
         WHERE c.state = 'replying_self'
           AND (c.resolution IS NULL OR NOT json_valid(c.resolution)
             OR json_extract(c.resolution, '$.action') IS NOT 'replied_in_source'
             OR EXISTS (SELECT 1 FROM events e WHERE e.source = 'system' AND e.kind = ? AND e.entity_key = c.object_key
               AND json_valid(e.payload) AND json_extract(e.payload, '$.cardId') = c.id
               AND json_extract(e.payload, '$.action') = 'reply_myself'))
         ORDER BY c.id LIMIT ?`,
      ).all(CHANNEL_EVENT_KINDS.cardAction, LEGACY_REPLY_MYSELF_MAX) as Array<{ id: number }>;
      if (!rows.length) return;
      const now = this.now();
      const at = now.toISOString();
      const ended: number[] = [];
      this.db.transaction(() => {
        for (const { id } of rows) {
          const card = getChannelCard(this.db, id);
          if (card?.state !== "replying_self") continue;
          const updated = updateChannelCard(this.db, id, {
            state: "left_to_user", snoozedUntil: null, resolvedAt: at,
            resolution: { by: "system", action: "reply_myself", at, detail: { migrated: "replying_self" } },
          }, { expectedVersion: card.version, at: now });
          if (!updated) continue;
          this.disposeCardEvents(card, "handled", { by: "system", action: "reply_myself", cardId: id, migrated: "replying_self" });
          ended.push(id);
        }
      })();
      this.log(`[channels] ended ${ended.length} card(s) left in replying_self after 我自己回${rows.length === LEGACY_REPLY_MYSELF_MAX ? " (more may remain)" : ""}`);
    } catch (error) {
      this.log(`[channels] could not end the cards left in replying_self: ${errorText(error)}`);
    }
  }

  get registry(): ChannelRegistry {
    return this.options.registry;
  }

  // ── 进来 ──────────────────────────────────────────────────────────────────────────

  /**
   * 来源推来一次投递。不抛错：鉴权、解析失败时返回 accepted=false。
   * 别人发来的消息要先问紧急程度，所以最多多等 urgencyTimeoutMs（加上排在前面的投递还没问完的时间）。
   */
  receive(source: string, delivery: ChannelDelivery): Promise<ChannelReceiveResult> {
    // 推来的投递一律校验：投递自己说它是怎样送来的不算数。
    return this.track(this.receiveNow(source, { headers: delivery.headers, body: delivery.body }, false));
  }

  /**
   * 进程内的入口：适配器自己的传输（transport，例如一条 Socket 连接）送来的投递。只有进程内的代码能调用它（daemon 的
   * startChannels 交给传输），不暴露成 HTTP，所以不校验签名。凭据照样要有：解析时要调来源的接口。不抛错。
   */
  receiveFromTransport(source: string, delivery: ChannelDelivery): Promise<ChannelReceiveResult> {
    return this.track(this.receiveNow(source, { ...delivery, transport: delivery.transport ?? "socket" }, true));
  }

  private track(run: Promise<ChannelReceiveResult>): Promise<ChannelReceiveResult> {
    this.receiving.add(run);
    const done = () => { this.receiving.delete(run); };
    run.then(done, done);
    return run;
  }

  private async receiveNow(source: string, delivery: ChannelDelivery, inProcess: boolean): Promise<ChannelReceiveResult> {
    const adapter = this.options.registry.get(source);
    if (!adapter) return { accepted: false, rejection: "unknown_source", items: [] };
    const context = await this.context(adapter);
    if (!context) {
      this.log(`[channels] ${adapter.id}: rejected a delivery: no usable credential for ${adapter.auth.connectionProvider}`);
      return { accepted: false, rejection: "no_connection", items: [] };
    }
    let verified = inProcess;
    if (!inProcess) {
      try {
        verified = adapter.verify(delivery, context);
      } catch (error) {
        this.log(`[channels] ${adapter.id}: verify failed: ${scrubCredential(errorText(error), context)}`);
      }
    }
    if (!verified) {
      this.log(`[channels] ${adapter.id}: rejected a delivery that failed authentication`);
      return { accepted: false, rejection: "unauthenticated", items: [] };
    }
    let inbound: ChannelInbound[];
    try {
      inbound = await adapter.parse(delivery, context);
    } catch (error) {
      this.log(`[channels] ${adapter.id}: could not parse a delivery: ${scrubCredential(errorText(error), context)}`);
      return { accepted: false, rejection: "unparseable", items: [] };
    }
    // 用户本人写给 Lead 的话：交给 daemon，不记成通道的事件。daemon 不收时照用户本人的话处理。
    const items: ChannelReceiveItem[] = [];
    const parsed = inbound;
    inbound = [];
    for (const item of parsed) {
      if (item.role !== "owner") {
        inbound.push(item);
        continue;
      }
      if (await this.handToOwner(adapter, context, item)) {
        items.push({
          seq: null, inserted: false, kind: item.kind, role: item.role, objectKey: item.objectKey, cardId: null, delivery: null, handedTo: "owner",
        });
      } else {
        inbound.push({ ...item, role: "self_reply" });
      }
    }
    // 和用户无关的投递：没有要记的，也不用排队。
    if (!inbound.length) return { accepted: true, items };
    const changed = new Set<number>();
    const pushes: ChannelCard[] = [];
    const followUps: FollowUp[] = [];
    // 先问紧急程度（并行），再按位置入库。
    const judged = inbound.map((item) => this.urgencyFor(adapter, item));
    const turn = this.reserveTurn();
    try {
      await turn.ready;
      for (const [index, item] of inbound.entries()) {
        const urgency = await judged[index]!.urgency;
        let result: RecordResult;
        try {
          result = this.db.transaction(() => this.record(adapter, item, urgency))();
        } catch (error) {
          const message = scrubCredential(errorText(error), context);
          this.log(`[channels] ${adapter.id}: could not record ${item.kind} for ${item.objectKey}: ${message}`);
          items.push({
            seq: null, inserted: false, kind: item.kind, role: item.role, objectKey: item.objectKey, cardId: null, delivery: null,
            error: message,
          });
          continue;
        }
        items.push(result.item);
        if (result.item.inserted && urgency?.basis.by === "fallback") {
          const { reason, error } = urgency.basis;
          this.log(`[channels] ${adapter.id}: urgency of event #${result.item.seq} not judged (${reason}${error ? `: ${scrubCredential(error, context)}` : ""}); `
            + "treated as not urgent");
        }
        if (result.card) changed.add(result.card.id);
        if (result.push && result.card) pushes.push(result.card);
        if (result.followUp) followUps.push(result.followUp);
      }
    } finally {
      turn.release();
      for (const entry of judged) entry.release();
    }
    for (const card of pushes) this.pushCard(adapter, card, "new");
    this.cardsChanged([...changed]);
    // 请求 A、自己的回复：在后台问，不阻塞投递（receive 不等它们）。
    for (const follow of followUps) {
      if (follow.kind === "intake") this.later(() => this.runIntake(adapter, follow.cardId, follow.seq), `intake of event #${follow.seq}`);
      else this.later(() => this.judgeOwnReply(adapter, follow.cardId, follow.seq), `own reply #${follow.seq}`);
    }
    return { accepted: true, items };
  }

  private async handToOwner(adapter: ChannelAdapter, context: ChannelAdapterContext, item: ChannelInbound): Promise<boolean> {
    const account = context.credential.account;
    if (!this.options.owner || !account) return false;
    try {
      return await this.options.owner({
        source: adapter.id, account, accountName: context.credential.accountName?.trim() || null, deliveryId: item.deliveryId,
        conversation: item.objectKey, text: item.text, occurredAt: item.occurredAt,
      });
    } catch (error) {
      this.log(`[channels] ${adapter.id}: could not hand the user's own message to Lead: ${scrubCredential(errorText(error), context)}`);
      return false;
    }
  }

  /**
   * 回用户本人（用户写给 Lead 的话那一轮的回复，ChannelHubOptions.owner）：署上助手的名字，发回那个对话。
   * Lead 写的 Markdown 由来源发送时换成自己的格式（带署名的话都这样）。key 是幂等键（daemon 用轮次的编号），重试不会发两次。
   * 没有经过卡、授权表和信心模型：这是用户本人和 Lead 的对话。发不出去时抛 ChannelActionError。
   */
  async replyToOwner(conversationId: string, text: string, key: string): Promise<{ objectKey: string; status: ChannelOutboundOutcome["status"] }> {
    const source = conversationId.split(":")[0] ?? "";
    const adapter = this.options.registry.get(source);
    if (!adapter?.capabilities.reply || !adapter.resolveConversation) throw new ChannelActionError("unavailable", `来源 ${source} 不能直接发消息`);
    const context = await this.context(adapter);
    if (!context) throw new ChannelActionError("unavailable", `来源 ${source} 现在没有接上`);
    let place;
    try {
      place = await adapter.resolveConversation(conversationId, context);
    } catch (error) {
      throw new ChannelActionError("not_found", errorText(error));
    }
    const signed = ownerReplyDisclosure(this.assistantFor(adapter), text.trim());
    const outcome = await this.outbox.perform(adapter, context, {
      key: `owner:${key}`, purpose: "auto_reply", cardId: null,
      request: { action: "reply", objectKey: place.objectKey, target: place.target, text: signed.text, parts: signed.parts },
    });
    if (outcome.status === "failed") throw new ChannelActionError("outbound_failed", `没有发出去：${outcome.error ?? "未知原因"}`);
    return { objectKey: place.objectKey, status: outcome.status };
  }

  // 别人发来的一条消息紧不紧急（urgency.ts）。用户本人的话、推回来的回复不问（null）。同一次投递正在问时共用那一次的回答；
  // 已经记过时不问（null：入库时认出重复，什么也不做）。release 在这次投递入库以后调用。
  private urgencyFor(adapter: ChannelAdapter, item: ChannelInbound): { urgency: Promise<ChannelUrgency | null>; release: () => void } {
    const none = { urgency: Promise.resolve(null), release: () => {} };
    if (item.role !== "message") return none;
    if (this.recordOnly(adapter, item)) return { urgency: Promise.resolve(channelUrgencyNotAsked("record_only")), release: () => {} };
    const key = item.deliveryId === null ? null : `${adapter.id}\u0000${item.deliveryId}`;
    if (key !== null) {
      const pending = this.judging.get(key);
      if (pending) return { urgency: pending, release: () => {} };
      // 读不了库时照样问：入库那一步会报错并记下来，receive 不抛错。
      let recorded = false;
      try {
        recorded = this.db.prepare("SELECT 1 FROM events WHERE source = ? AND source_ref = ? LIMIT 1").get(adapter.id, item.deliveryId) !== undefined;
      } catch (error) {
        this.log(`[channels] ${adapter.id}: could not look up delivery ${item.deliveryId}: ${errorText(error)}`);
      }
      if (recorded) return none;
    }
    let model: SmartModel | null = null;
    try {
      model = this.options.smartModel?.() ?? null;
    } catch (error) {
      this.log(`[channels] ${adapter.id}: the smart model is not available: ${errorText(error)}`);
    }
    const urgency = judgeChannelUrgency({ item, model, timeoutMs: this.urgencyTimeoutMs });
    if (key === null) return { urgency, release: () => {} };
    this.judging.set(key, urgency);
    return { urgency, release: () => { if (this.judging.get(key) === urgency) this.judging.delete(key); } };
  }

  // 别人发来的这条消息即使紧急也只会记录：投递指令按「紧急」算也是 record，或者它改的是一条消息、这个对话又没有没结束的卡。
  // 读不了库时按「不是」处理（照常问）。
  private recordOnly(adapter: ChannelAdapter, item: ChannelInbound): boolean {
    try {
      // 助手按占位判断过不用回、现在正文变了的编辑（reopenOf）和新消息一样问紧急程度，按原来那条消息的类型定投递。
      const reopen = this.reopenOf(adapter.id, item);
      if (item.amends && reopen === null && !getOpenChannelCard(this.db, item.objectKey)) return true;
      const payload = { ...item.fields, role: item.role, sender: { ...item.sender }, text: item.text, urgent: true };
      return channelDeliveryDecision(channelDeliveryPolicy(this.db, adapter.id), {
        source: adapter.id, kind: reopen?.kind ?? item.kind, entityKey: item.objectKey, payload, rootCause: null,
      }).mode === "record";
    } catch (error) {
      this.log(`[channels] ${adapter.id}: could not read the delivery policy: ${errorText(error)}`);
      return false;
    }
  }

  // 入库的位置：等前面的都入库了（ready），自己入库以后放开（release）。release 一定要调用。
  private reserveTurn(): { ready: Promise<void>; release: () => void } {
    const ready = this.recordTail;
    let release!: () => void;
    const done = new Promise<void>((resolve) => { release = resolve; });
    this.recordTail = ready.then(() => done);
    return { ready, release };
  }

  private record(adapter: ChannelAdapter, item: ChannelInbound, urgency: ChannelUrgency | null): RecordResult {
    const db = this.db;
    const base: ChannelReceiveItem = {
      seq: null, inserted: false, kind: item.kind, role: item.role, objectKey: item.objectKey, cardId: null, delivery: null,
    };
    if (!item.objectKey.startsWith(`${adapter.id}:`)) throw new Error(`${adapter.id} gave an object key outside its namespace`);
    // 用户本人的话、推回来的回复：只在道已经存在时记。改消息和删消息没有道时只记录（下面按 record 处理，不开道）。
    // 例外：用户本人说了让他关注这个对象的话（follows，例如在 Slack 的 thread 里发起或者回复）：没有道也只记录这一条，
    // 以后 interest.followed 认它，这个对象里别人的话只记录、沉淀进记忆（用户 2026-10-21：照 Slack 的自动关注规则）。
    const existingLane = getChannelLane(db, item.objectKey);
    // 推回来的回复带 follows 时同样只记录（例如私信 thread 里的回复，2026-11-02）：以后这个 thread 有道时，上下文包里有这条。
    const followOnly = (item.role === "self_reply" || item.role === "echo") && item.follows === true && !existingLane;
    if (item.role !== "message" && !existingLane && !followOnly) return { item: { ...base, ignored: "no_lane" }, card: null, push: false };
    const at = this.now();
    const text = clipEventText(item.text, TEXT_MAX);
    // 身份的第三步（spec D2）：适配器给不出投递编号时不去重，两条都存；同一个对象里同一个人在同一时刻的同一种事件，
    // 标上 maybeDuplicateOf（只比结构化字段，不比原文）。
    const maybeDuplicateOf = item.deliveryId === null ? this.possibleDuplicate(adapter.id, item) : null;
    // 紧急程度只由内核定：适配器的字段里有同名的也不用。
    const { urgent: _urgent, urgency: _urgency, ...fields } = item.fields;
    const payload: Record<string, unknown> = {
      ...fields,
      role: item.role,
      laneLabel: item.laneLabel,
      sender: { id: item.sender.id, name: item.sender.name, trust: item.sender.trust, ...(item.sender.bot ? { bot: true } : {}) },
      text,
      ...(item.messageRef ? { messageRef: item.messageRef } : {}),
      ...(item.messageId ? { messageId: item.messageId } : {}),
      ...(item.audience ? { audience: item.audience } : {}),
      ...(item.replyTo ? { replyTo: item.replyTo } : {}),
      summary: `${item.sender.name}（${SENDER_TRUST_LABELS[item.sender.trust]}）在${item.laneLabel}：${oneLine(item.text, 300)}`,
      urgent: urgency?.urgent ?? false,
      ...(urgency ? { urgency: urgency.basis } : {}),
      ...(maybeDuplicateOf !== null ? { maybeDuplicateOf } : {}),
    };
    // 别人发来的消息：先定投递方式，写进事件的 channelDelivery。摘要投递的消息由 06 的「Lead 动态」卡片显示；
    // 会话卡、推送加会话卡的有自己的卡，只记录的不显示：「Lead 动态」不再说一遍（store 的 listLeadActivityEvents）。
    // 助手按占位判断过「不用回」、后来改成了正文：当作新消息再判断一次（reopenOf），投递方式按原来那条消息的类型定。
    const reopen = item.role === "message" ? this.reopenOf(adapter.id, item) : null;
    let decision = item.role === "message"
      ? channelDeliveryDecision(channelDeliveryPolicy(db, adapter.id), {
        source: adapter.id, kind: reopen?.kind ?? item.kind, entityKey: item.objectKey, payload, rootCause: null,
      })
      : null;
    // 改消息、删消息只更新没结束的卡：这个对话没有这样的卡时只记录，不为它开新卡。
    if (decision && item.amends && reopen === null && decision.mode !== "record" && !getOpenChannelCard(db, item.objectKey)) {
      decision = { ...decision, mode: "record" };
    }
    // 合并编辑（统一消息事件 spec D6，inbound.ts）：交给 Lead 时，Lead 拿走以前对方改的消息并进那条消息，不再问一次请求 A，
    // 也不产生新的 Lead 输入：这条编辑只记录，记下以后再并（mergeEditNow）。拿走以后照旧：有卡时更新卡、按新消息再判断。
    const merge = decision && item.amends === "edited" && this.options.lead ? this.editMergeFor(adapter.id, item) : null;
    if (decision && merge && merge.kind !== "rejudge") decision = { ...decision, mode: "record" };
    if (item.amends) payload.amends = item.amends;
    if (merge) payload.editMerge = merge.kind;
    // reopen 让常设指令 slack.amendment 不把它压成 record；editMerge 让它成为这条消息新的判断头（editMergeFor），之后的编辑并进来。
    if (reopen !== null) Object.assign(payload, { reopen: true, reopenOf: reopen.seq, reopenKind: reopen.kind, editMerge: "rejudge" });
    if (decision) payload.channelDelivery = decision.mode;
    if (followOnly) payload.channelDelivery = "record";
    // 要开新卡的消息：有快模型时先不开，等请求 A 判断要不要用户回（用户 2026-10-21）。开卡要用的东西先记在事件里，
    // 判断丢了（例如 daemon 重启）时每一拍按它补上（settleStalePendingCards）。这个对话已经有没结束的卡时照旧并进去。
    const deferCard = decision !== null && (decision.mode === "card" || decision.mode === "push_card") && adapter.kind === "conversation"
      && (!item.amends || reopen !== null) && !getOpenChannelCard(db, item.objectKey) && this.smartModelNow() !== null;
    if (deferCard) payload.cardPending = { delivery: decision!.mode, replyTarget: item.replyTarget, at: at.toISOString() };
    const { event, inserted } = appendEvent(db, {
      source: adapter.id,
      sourceRef: item.deliveryId,
      kind: item.kind,
      entityKey: item.objectKey,
      occurredAt: item.occurredAt,
      correlationId: `channel:${item.objectKey}`,
      payload,
    });
    if (!inserted) return { item: { ...base, seq: event.seq }, card: null, push: false };
    // 只记录的消息不开新道：道是用户在场的对话（私信、提到用户的讨论）。例如订阅频道里的普通消息只进事件日志。
    if (followOnly) return { item: { ...base, seq: event.seq, inserted: true, delivery: "record" }, card: null, push: false };
    if (decision?.mode === "record" && !existingLane) {
      return { item: { ...base, seq: event.seq, inserted: true, delivery: "record" }, card: null, push: false };
    }
    const lane = recordChannelLaneMessage(db, {
      source: adapter.id, objectKey: item.objectKey, label: item.laneLabel, at,
      message: {
        at: item.occurredAt, seq: event.seq, role: item.role === "message" ? "them" : item.role === "self_reply" ? "me" : "assistant",
        sender: item.sender.name, text, ...(item.messageId ? { ref: item.messageId } : {}),
      },
    });
    const recorded = { ...base, seq: event.seq, inserted: true };
    if (item.role === "echo") {
      this.refreshLaneSummary(lane);
      return { item: recorded, card: null, push: false };
    }
    if (item.role === "self_reply") {
      // 这句话回答了对方没有，在后台问 SmartModel（judgeOwnReply）。卡先不动。
      const open = getOpenChannelCard(db, item.objectKey);
      this.refreshLaneSummary(lane);
      if (!open) {
        // 你点过「我自己回」、卡已经结束：这句话只给卡上的草稿打校准标签（你没用它），卡不动（统一消息事件 spec D11）。
        const latest = getLatestChannelCard(db, item.objectKey);
        if (latest?.state === "left_to_user") db.transaction(() => this.labelReply(latest, "rewritten", at))();
        return { item: recorded, card: null, push: false };
      }
      return {
        item: { ...recorded, cardId: open.id }, card: null, push: false,
        followUp: { kind: "self_reply", cardId: open.id, seq: event.seq },
      };
    }
    // 别人发来的消息：按上面定的投递方式开卡或者只记录。
    if (!decision) throw new Error(`${adapter.id}: a message without a delivery decision`);
    if (merge && merge.kind !== "rejudge") {
      const merged = this.mergeEditNow(adapter, item, event.seq, text, merge, at);
      this.refreshLaneSummary(lane);
      return { item: { ...recorded, cardId: merged?.id ?? null, delivery: "record" }, card: merged, push: false };
    }
    if (decision.mode === "record") {
      this.refreshLaneSummary(lane);
      return { item: { ...recorded, delivery: "record" }, card: null, push: false };
    }
    if (deferCard) {
      this.refreshLaneSummary(lane);
      return {
        item: { ...recorded, delivery: decision.mode }, card: null, push: false,
        followUp: { kind: "intake", cardId: null, seq: event.seq },
      };
    }
    const sender = { id: item.sender.id, name: item.sender.name, trust: item.sender.trust };
    const excerpt = oneLine(item.text, EXCERPT_MAX);
    const open = getOpenChannelCard(db, item.objectKey);
    const card = open
      ? updateChannelCard(db, open.id, {
        state: "open", snoozedUntil: null, lastSeq: event.seq, messageCount: open.messageCount + 1, sender, excerpt,
        // 退役以前开的卡带着模板代回闸门的结论：有新消息时清掉，免得卡上还显示旧的结论。
        replyTarget: item.replyTarget, delivery: strongerDelivery(open.delivery, decision.mode), gate: null, draft: null,
      }, { at })!
      : openChannelCard(db, {
        laneId: lane.id, source: adapter.id, objectKey: item.objectKey, delivery: decision.mode, seq: event.seq, sender, excerpt,
        replyTarget: item.replyTarget, at,
      });
    this.refreshLaneSummary(lane);
    return {
      item: { ...recorded, cardId: card.id, delivery: decision.mode }, card,
      // 交给 Lead 时卡不马上推送：请求 A 问完以后交给 Lead 决定（落地计划 B）。
      push: decision.mode === "push_card" && !(this.options.lead && adapter.kind === "conversation"),
      // 对话型来源别人发来的消息：问请求 A（授权表和代查都要它）。
      ...(adapter.kind === "conversation" ? { followUp: { kind: "intake" as const, cardId: card.id, seq: event.seq } } : {}),
    };
  }

  private possibleDuplicate(source: string, item: ChannelInbound): number | null {
    const row = this.db.prepare(
      `SELECT seq FROM events
       WHERE source = ? AND kind = ? AND entity_key = ? AND occurred_at = ?
         AND json_valid(payload) AND json_extract(payload, '$.sender.id') = ?
       ORDER BY seq LIMIT 1`,
    ).get(source, item.kind, item.objectKey, new Date(item.occurredAt).toISOString(), item.sender.id) as { seq: number } | undefined;
    return row?.seq ?? null;
  }

  // ── 合并编辑（统一消息事件 spec D6，inbound.ts）────────────────────────────────────────

  /**
   * 对方改了一条消息，怎么并（inbound.ts 的 editMergeOf）。按 messageId 认出改的是哪一条。判定的那一条是原来的消息，
   * 或者 Lead 拿走以后按新消息再判断的那次编辑（最新的一次）；最新的消息事件是这条消息最近交给 Lead 的那一条。
   * 读不了库时按以前的做法（rejudge）。
   */
  private editMergeFor(source: string, item: ChannelInbound): { kind: EditMerge; queued: EventRecord | null } {
    const rejudge = { kind: "rejudge" as const, queued: null };
    if (!item.messageId) return rejudge;
    try {
      const headSeq = this.judgedHeadSeq(source, item);
      if (headSeq === undefined) return rejudge;
      const latest = this.latestMessageEvent(item.objectKey, item.messageId);
      const kind = editMergeOf({
        // 判断完了、还在拼上下文包（还没有消息事件）的，也算还在判断：编辑并进去，记消息事件时用改后的话。
        judged: this.intakeOf(source, headSeq) !== null && !this.packing.has(headSeq),
        latest: latest ? { queued: latest.disposition === null && !this.messageTaken(latest.seq) } : null,
      });
      return { kind, queued: kind === "merge_queued" ? latest ?? null : null };
    } catch (error) {
      this.log(`[channels] ${source}: could not tell how to merge an edit in ${item.objectKey}: ${errorText(error)}`);
      return rejudge;
    }
  }

  // 这条消息判断的那一条：原来的消息，或者按新消息再判断的那次编辑（最近的一次）。
  private judgedHeadSeq(source: string, item: ChannelInbound): number | undefined {
    const row = this.db.prepare(
      `SELECT seq FROM events
       WHERE source = ? AND entity_key = ? AND json_valid(payload) AND json_extract(payload, '$.role') = 'message'
         AND json_extract(payload, '$.messageId') = ?
         AND (json_extract(payload, '$.amends') IS NULL OR json_extract(payload, '$.editMerge') = 'rejudge')
       ORDER BY seq DESC LIMIT 1`,
    ).get(source, item.objectKey, item.messageId) as { seq: number } | undefined;
    return row?.seq;
  }

  /**
   * 一次编辑要不要当新消息再判断：助手按旧的话判断过「不用回」（没开卡、没交给 Lead），现在话变了一大半，
   * 用户没有在这个对话里回复过，这条消息重开不到 REOPEN_LIMIT 次，编辑是新的。返回被改的那条判断的事件编号和最早那条消息的类型，不重开时是 null。
   * 用户点了忽略、Lead 处理过的消息处置不是助手的 no_action，不会重开；这个对话有开着的卡时编辑照旧更新卡。
   */
  private reopenOf(source: string, item: ChannelInbound): { seq: number; kind: string } | null {
    if (item.amends !== "edited" || item.role !== "message" || !item.messageId) return null;
    try {
      if (getOpenChannelCard(this.db, item.objectKey)) return null;
      if (this.now().getTime() - Date.parse(item.occurredAt) > REOPEN_MAX_AGE_MS) return null;
      const seq = this.judgedHeadSeq(source, item);
      const head = seq === undefined ? undefined : getEvent(this.db, seq);
      if (!head || head.disposition !== "no_action" || head.dispositionDetail?.by !== "assistant") return null;
      if (!materialEdit(typeof head.payload.text === "string" ? head.payload.text : "", item.text)) return null;
      const answered = this.db.prepare(
        `SELECT 1 FROM events WHERE source = ? AND entity_key = ? AND seq > ? AND json_valid(payload)
           AND json_extract(payload, '$.role') IN ('self_reply', 'echo') LIMIT 1`,
      ).get(source, item.objectKey, head.seq);
      if (answered) return null;
      const { n } = this.db.prepare(
        `SELECT COUNT(*) AS n FROM events WHERE source = ? AND entity_key = ? AND json_valid(payload)
           AND json_extract(payload, '$.messageId') = ? AND json_extract(payload, '$.reopen') = 1`,
      ).get(source, item.objectKey, item.messageId) as { n: number };
      // 再次重开时，头是上一次重开的编辑：类型还是最早那条消息的（reopenKind）。
      const kind = typeof head.payload.reopenKind === "string" ? head.payload.reopenKind : head.kind;
      return n < REOPEN_LIMIT ? { seq: head.seq, kind } : null;
    } catch (error) {
      this.log(`[channels] ${source}: could not tell whether to judge an edit in ${item.objectKey} again: ${errorText(error)}`);
      return null;
    }
  }

  // 这条消息（来源里的编号）最近的消息事件。没有时是 undefined。
  private latestMessageEvent(objectKey: string, messageId: string): EventRecord | undefined {
    const row = this.db.prepare(
      `SELECT seq FROM events
       WHERE source = 'system' AND kind = ? AND entity_key = ? AND json_valid(payload)
         AND json_extract(payload, '$.replyTo.message') = ?
       ORDER BY seq DESC LIMIT 1`,
    ).get(MESSAGE_EVENT_KIND, objectKey, messageId) as { seq: number } | undefined;
    return row ? getEvent(this.db, row.seq) : undefined;
  }

  // Lead 拿走了这条消息事件没有（daemon 的 Lead 输入回答）。问不成时当作拿走了：按新消息再判断，宁可多问一次，不丢编辑。
  private messageTaken(seq: number): boolean {
    try {
      return this.options.lead?.taken?.(seq) ?? false;
    } catch (error) {
      this.log(`[channels] could not tell whether Lead took message event #${seq}: ${errorText(error)}`);
      return true;
    }
  }

  /**
   * 把一次编辑并进去（spec D6）。这个对话没结束的卡上最新的一条就是被改的这条时，卡的摘录换成改后的话
   * （草稿是按旧的话写的，清掉）。消息事件还排着时，换成并进这次编辑的新一条，旧的记成 superseded（Lead 的输入不再交它）；
   * 还在判断的消息（merge_pending）以后产生消息事件时用改后的话（mergedMessage）。调用方负责事务。返回更新了的卡。
   */
  private mergeEditNow(
    adapter: ChannelAdapter, item: ChannelInbound, seq: number, text: string, merge: { kind: EditMerge; queued: EventRecord | null }, at: Date,
  ): ChannelCard | null {
    const db = this.db;
    const open = getOpenChannelCard(db, item.objectKey);
    const last = open ? getEvent(db, open.lastSeq) : undefined;
    const card = open && last?.payload.messageId === item.messageId
      ? updateChannelCard(db, open.id, { excerpt: oneLine(text, EXCERPT_MAX), draft: null, gate: null }, { at }) ?? open
      : null;
    if (merge.kind === "merge_queued" && merge.queued) {
      const queued = merge.queued.payload as unknown as MessageReceivedPayload;
      const payload = mergeEdit(queued, { seq, text });
      // 上下文包按改后的话重拼（工单 11 回放的问题 B）：编辑可能补了一个对象，例如李雷补了第三个仓库。
      const rebuilt = this.repackMerged(adapter, payload, queued.text);
      if (rebuilt) payload.context = rebuilt.built.context;
      const { event } = appendEvent(db, {
        source: "system", sourceRef: messageEventRef(adapter.id, payload.messages), kind: MESSAGE_EVENT_KIND, entityKey: item.objectKey,
        correlationId: `channel:${item.objectKey}`, level: merge.queued.level === "digest" ? "digest" : "tell", causationId: String(seq),
        occurredAt: at.toISOString(), payload,
      });
      setEventDisposition(db, merge.queued.seq, "superseded", { replacedBy: event.seq, reason: "edited", editSeq: seq }, at);
      if (rebuilt) this.recordContextPacked(rebuilt.card, event.seq, rebuilt.built, at, merge.queued.seq);
    }
    return card;
  }

  // 排着的消息事件并进一次编辑时，它的上下文包按改后的话重拼。排着的那一条的话就是它的上下文包按的话（previousText）。
  // 没有上下文包、找不到卡或者原来的消息、话没变时是 null（照用原来的）。
  private repackMerged(
    adapter: ChannelAdapter, payload: MessageReceivedPayload, previousText: string,
  ): { card: ChannelCard; built: BuiltContextPack } | null {
    const card = typeof payload.cardId === "number" ? getChannelCard(this.db, payload.cardId) : undefined;
    const original = payload.messages[0] === undefined ? undefined : getEvent(this.db, payload.messages[0]);
    if (!payload.context || !card || !original) return null;
    const previous: BuiltContextPack = { context: payload.context, parts: contextParts(payload.context), ms: 0, text: previousText };
    const built = this.repackContext(adapter, card, original, previous);
    return built === previous ? null : { card, built };
  }

  // 一条消息并进编辑以后的话（spec D6）：这条消息以后、并进它的编辑（按 messageId 认，删掉的不算），用最后一次的话。
  // seqs 是这条消息和这些编辑的事件编号。
  private mergedMessage(source: string, event: EventRecord): { text: string; seqs: number[] } {
    const text = typeof event.payload.text === "string" ? event.payload.text : "";
    const messageId = event.payload.messageId;
    if (typeof messageId !== "string" || !event.entityKey) return { text, seqs: [event.seq] };
    const edits = this.db.prepare(
      `SELECT seq, json_extract(payload, '$.text') AS text FROM events
       WHERE source = ? AND entity_key = ? AND seq > ? AND json_valid(payload) AND json_extract(payload, '$.messageId') = ?
         AND json_extract(payload, '$.amends') = 'edited' AND json_extract(payload, '$.editMerge') IN ('merge_pending', 'merge_queued')
       ORDER BY seq LIMIT 50`,
    ).all(source, event.entityKey, event.seq, messageId) as Array<{ seq: number; text: unknown }>;
    const last = edits.at(-1);
    return { text: last && typeof last.text === "string" ? last.text : text, seqs: [event.seq, ...edits.map((edit) => edit.seq)] };
  }

  // ── 每一拍 ────────────────────────────────────────────────────────────────────────

  /** daemon 的轮询每一拍调用一次。同一时间只跑一次；不抛错。 */
  tick(): Promise<void> {
    if (this.ticking) return this.ticking;
    const run = (async () => {
      try {
        const changed = new Set<number>();
        for (const id of this.wakeSnoozed()) changed.add(id);
        for (const id of this.settleStalePendingCards()) changed.add(id);
        for (const id of await this.retryReplies()) changed.add(id);
        this.cardsChanged([...changed]);
        await this.settleLeftoverNotices();
        this.retireOldLookups();
        this.settleLostTasks();
        this.pushWhileLeadDown();
        this.labelSettledReplies();
      } catch (error) {
        this.log(`[channels] tick failed: ${errorText(error)}`);
      }
    })().finally(() => { this.ticking = null; });
    this.ticking = run;
    return run;
  }

  /**
   * 等正在进行的投递（包括还在问紧急程度的）、正在跑的一拍、后台的事（请求 A、自己的回复、代查结束以后的核对和代回）
   * 都结束（停机时关库之前用，测试也用它）。不等代查本身：代查在 daemon 的启动器里跑。
   */
  async idle(): Promise<void> {
    while (this.receiving.size || this.ticking || this.background.size) {
      await Promise.allSettled([...this.receiving]);
      await this.ticking;
      await Promise.allSettled([...this.background]);
    }
  }

  // 在后台做一件事：不抛错（出错只记日志），idle() 等它。
  private later(work: () => Promise<unknown>, what: string): void {
    const run: Promise<void> = work().then(() => {}, (error: unknown) => {
      this.log(`[channels] ${what} failed: ${errorText(error)}`);
    });
    this.background.add(run);
    void run.finally(() => this.background.delete(run));
  }

  private textModelNow(): SmartTextComplete | null {
    try {
      return this.options.textModel?.() ?? null;
    } catch (error) {
      this.log(`[channels] the text model is not available: ${errorText(error)}`);
      return null;
    }
  }

  private smartModelNow(): SmartModel | null {
    try {
      return this.options.smartModel?.() ?? null;
    } catch (error) {
      this.log(`[channels] the smart model is not available: ${errorText(error)}`);
      return null;
    }
  }

  private wakeSnoozed(): number[] {
    const now = this.now();
    const woke: number[] = [];
    for (const due of listDueSnoozedChannelCards(this.db, now)) {
      const card = updateChannelCard(this.db, due.id, { state: "open", snoozedUntil: null }, { expectedVersion: due.version, at: now });
      if (!card) continue;
      woke.push(card.id);
      const adapter = this.options.registry.get(card.source);
      if (adapter) this.pushCard(adapter, card, "snooze");
      const lane = getChannelLane(this.db, card.objectKey);
      if (lane) this.refreshLaneSummary(lane);
    }
    return woke;
  }

  // 请求 A 对一条消息的回答（channel.intake.decided 事件）。还没有时是 null。
  private intakeOf(source: string, seq: number): Record<string, unknown> | null {
    const row = this.db.prepare("SELECT payload FROM events WHERE source = 'system' AND source_ref = ?")
      .get(intakeRef(source, seq)) as { payload: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.payload) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  private async retryReplies(): Promise<number[]> {
    const now = this.now().getTime();
    const changed: number[] = [];
    const states = CHANNEL_CARD_OPEN_STATES.map(() => "?").join(", ");
    const rows = this.db.prepare(
      `SELECT id FROM channel_cards
       WHERE state IN (${states}) AND json_valid(sent) AND json_extract(sent, '$.status') = 'pending'
       ORDER BY id LIMIT 50`,
    ).all(...CHANNEL_CARD_OPEN_STATES) as Array<{ id: number }>;
    for (const { id } of rows) {
      const card = getChannelCard(this.db, id);
      const sent = card?.sent;
      if (!card || !sent || sent.status !== "pending" || this.sending.has(card.id)) continue;
      if (sent.nextAttemptAt && Date.parse(sent.nextAttemptAt) > now) continue;
      const adapter = this.options.registry.get(card.source);
      if (!adapter) continue;
      await this.sendReply(adapter, card, sent.by === "auto" ? "auto_reply" : "user_reply", {
        revokeWindowMs: sent.by === "auto" ? this.revokeWindowFor(adapter, sent.key) : 0, resume: true,
      });
      changed.push(card.id);
    }
    return changed;
  }

  // 自动回复的撤回窗口：代查的回复按 channel.reply，模板的回复按 channel.delegate。
  private revokeWindowFor(adapter: ChannelAdapter, key: string): number {
    const window = REFUSE_KEY.test(key) || TASK_KEY.test(key) || ANSWER_KEY.test(key) ? AUTHORITY_REVOKE_WINDOW_MS
      : LOOKUP_AUTO_KEY.test(key) ? channelReplyPolicy(this.db, adapter.id)?.revokeWindowMs
      : channelDelegatePolicy(this.db, adapter.id)?.revokeWindowMs;
    return window ?? 10 * 60_000;
  }

  // ── 发出去 ────────────────────────────────────────────────────────────────────────

  /**
   * 发一条回复（用户点的，或者闸门放行的自动回复）。先在卡上占住（sent.status = pending，按版本），
   * 再用幂等键调用适配器。resume：daemon 重启或者上一次失败以后接着发，卡上已经占住了。
   * outgoing 是要发的文字（披露署名已经加好）；不给时发卡上的草稿原文。
   */
  private async sendReply(
    adapter: ChannelAdapter, card: ChannelCard, purpose: "user_reply" | "auto_reply",
    options: { revokeWindowMs: number; resume?: boolean; outgoing?: OutgoingReply; resolution?: { by: string; action: string } },
  ): Promise<ChannelOutboundOutcome | null> {
    if (this.sending.has(card.id)) return null;
    let claimed = card;
    if (!options.resume) {
      // 这张卡还有一条状态消息在发：等它发完，回复才能改写它（落地计划 A3）。
      const notice = this.statusNotices.get(card.id);
      if (notice) {
        await notice;
        const fresh = getChannelCard(this.db, card.id);
        if (!fresh) return null;
        card = fresh;
        claimed = fresh;
      }
      const outgoing: OutgoingReply | null = options.outgoing ?? (card.draft ? {
        by: purpose === "auto_reply" ? "auto" : "user",
        key: `${purpose === "auto_reply" ? "auto" : "reply"}:card:${card.id}:seq:${card.draft.forSeq}`,
        text: card.draft.text, fromDraft: true,
      } : null);
      if (!outgoing) return null;
      // 用回复改写这张卡上还没被改写过的「正在处理」，不另发一条（用户 2026-10-22）。来源不能改写时照常另发。
      const replaces = adapter.capabilities.edit ? this.openStatusMessage(card.id) : null;
      // 助手写的正文（代你发的、你照草稿发的）发出去以前把邮箱脱敏（落地计划 A7）。你自己改过的文字原样发。
      const masked = outgoing.by === "auto" || outgoing.fromDraft ? maskOutgoing(outgoing) : { ...outgoing, masked: 0 };
      if (masked.masked) this.log(`[channels] ${adapter.id}: masked ${masked.masked} email address(es) in the reply on card #${card.id}`);
      const sent: ChannelCardSent = {
        by: outgoing.by, key: outgoing.key, text: clipEventText(masked.text, CHANNEL_CARD_TEXT_MAX + 200),
        ...(masked.parts ? { parts: clipParts(masked.parts) } : {}),
        ...(replaces ? { replaces } : {}),
        fromDraft: outgoing.fromDraft, status: "pending", remoteRef: {}, at: this.now().toISOString(),
        failures: 0, nextAttemptAt: null, error: null,
      };
      const next = updateChannelCard(this.db, card.id, { sent }, { expectedVersion: card.version, at: this.now() });
      if (!next) return null;
      claimed = next;
    }
    const sent = claimed.sent!;
    this.sending.add(claimed.id);
    try {
      const context = await this.context(adapter);
      const perform = (replaces: Record<string, string> | null | undefined) => this.outbox.perform(adapter, context!, {
        key: sent.key, purpose, cardId: claimed.id,
        request: {
          action: replaces ? "edit" : "reply", objectKey: claimed.objectKey, target: replaces ?? claimed.replyTarget, text: sent.text,
          ...(sent.parts ? { parts: sent.parts } : {}),
        },
      });
      let outcome: ChannelOutboundOutcome = context
        ? await perform(sent.replaces)
        : { status: "failed", remoteRef: null, duplicate: false, error: "这个来源的连接不可用", failures: sent.failures + 1 };
      if (context && outcome.status === "failed" && outcome.targetGone && sent.replaces) {
        // 状态消息改写不了（被删了、过了能改的时间）：另发一条，以后的重试也另发。临时的失败照常下一拍再改写。
        this.log(`[channels] ${adapter.id}: could not edit the status message of card #${claimed.id}; posting the reply instead`);
        const current = getChannelCard(this.db, claimed.id);
        if (current?.sent?.key === sent.key) updateChannelCard(this.db, claimed.id, { sent: { ...current.sent, replaces: null } }, { at: this.now() });
        outcome = await perform(null);
      }
      this.applyReply(adapter, claimed.id, purpose, outcome, options.revokeWindowMs, options.resolution);
      return outcome;
    } finally {
      this.sending.delete(claimed.id);
    }
  }

  private applyReply(
    adapter: ChannelAdapter, cardId: number, purpose: "user_reply" | "auto_reply",
    outcome: ChannelOutboundOutcome, revokeWindowMs: number, resolution?: { by: string; action: string },
  ): void {
    const db = this.db;
    const now = this.now();
    const at = now.toISOString();
    db.transaction(() => {
      const card = getChannelCard(db, cardId);
      if (!card?.sent) return;
      if (outcome.status === "failed") {
        const failures = card.sent.failures + 1;
        const giveUp = failures >= this.maxAttempts;
        updateChannelCard(db, card.id, {
          sent: {
            ...card.sent, failures, error: outcome.error, status: giveUp ? "failed" : "pending",
            nextAttemptAt: giveUp ? null : new Date(now.getTime() + this.retryBaseMs * 2 ** Math.min(failures - 1, 10)).toISOString(),
          },
        }, { at: now });
        return;
      }
      const sent: ChannelCardSent = { ...card.sent, status: "sent", remoteRef: outcome.remoteRef ?? {}, error: null, nextAttemptAt: null };
      if (purpose === "user_reply") {
        // review 发到 PR 以后的那句回复（工单 06）：卡的结局是「发到 PR 并回复」。
        // resolution：Lead 代你在这个对话里发的消息（sendMessage）带着谁、哪个动作。
        const action = resolution?.action ?? (REVIEW_REPLY_KEY.test(sent.key) ? "post_review" : sent.fromDraft ? "send_draft" : "send_edited");
        const by = resolution?.by ?? "user";
        updateChannelCard(db, card.id, {
          state: "replied", sent, resolvedAt: at, snoozedUntil: null,
          resolution: { by, action, at },
        }, { at: now });
        this.disposeCardEvents(card, "handled", { by, action, cardId: card.id });
        this.laneMessage(card, "me", sent.text, at, outcome.messageId);
        return;
      }
      // 代查的自动回复（幂等键里有代查的编号）按 channel.reply；授权表代你拒绝的按授权表；模板的（旧卡）按 channel.delegate。
      const refusal = REFUSE_KEY.test(sent.key);
      const task = TASK_KEY.test(sent.key);
      const answer = ANSWER_KEY.test(sent.key);
      const lookupId = Number(LOOKUP_AUTO_KEY.exec(sent.key)?.[1] ?? NaN);
      const lookup = Number.isInteger(lookupId) ? getChannelLookup(db, lookupId) : undefined;
      const policyOrder = refusal || task || answer ? channelAuthorityTable(db, adapter.id)?.order ?? AUTHORITY_ORDER
        : lookup ? channelReplyPolicy(db, adapter.id)?.order ?? lookup.reply?.order
        : channelDelegatePolicy(db, adapter.id)?.order ?? card.gate?.order;
      const order = policyOrder ?? { id: `channel.${adapter.id}.${lookup ? "reply" : "delegate"}`, version: 0 };
      const revokeUntil = new Date(now.getTime() + revokeWindowMs).toISOString();
      updateChannelCard(db, card.id, {
        state: "auto_replied", sent, resolvedAt: at, revokeUntil, snoozedUntil: null,
        resolution: { by: "system", action: "auto_reply", at, detail: { standingOrder: order, ...(lookup ? { lookupId: lookup.id } : {}) } },
      }, { at: now });
      const category = refusal ? "refusal" : task ? "agent_task" : answer ? "lead_answer"
        : lookup ? lookup.playbook : card.gate?.category ?? "acknowledgement";
      // 「Lead 动态」里给你看的那一句：按你选的语言写，不写内部的词和会过期的撤回期限（2026-11-03 截图）。
      const locale = getLocale(db);
      const words = channelHubMessages(locale).autoReply;
      const labels = channelPolicyLabels(locale);
      const summary = refusal ? words.refused(card.sender.name)
        : words.replied(card.sender.name, task ? words.task
          : answer ? words.answer(leadDisplayName(db))
          : lookup ? words.lookup(labels.playbook[lookup.playbook])
          : labels.delegationCategory[category as keyof typeof labels.delegationCategory] ?? category);
      const { event } = appendEvent(db, {
        source: "system", sourceRef: `channel-auto-reply:${adapter.id}:${sent.key}`, kind: CHANNEL_EVENT_KINDS.replyAutoSent,
        entityKey: card.objectKey, correlationId: `channel:${card.objectKey}`, level: "auto",
        payload: {
          channel: adapter.id, cardId: card.id, category, templateId: lookup ? "" : card.draft?.templateId ?? "", text: sent.text,
          revokeUntil, order, summary,
        },
      });
      setEventDisposition(db, event.seq, "auto_handled", { standingOrder: order, cardId: card.id }, now);
      this.disposeCardEvents(card, "auto_handled", { standingOrder: order, cardId: card.id, autoReplySeq: event.seq });
      this.laneMessage(card, "assistant", sent.text, at, outcome.messageId);
    })();
  }

  // ── 交给 Lead（落地计划 B）────────────────────────────────────────────────────────

  // 给了 lead 时，这个结论先交给 Lead：要干活、要打扰你（提醒你、问你），和请求 A 没有回答的（没有结论）。
  // 用户 2026-10-26：能代你回的（回表情、代你拒绝、收尾说一句）也先交给 Lead，Lead 看了上下文再定；授权表的结论只是权限上限和建议。
  // 只有不打扰你的（skip）不交。系统不替 Lead 定（工单 06）。
  private leadRoutes(action: AuthorityAction | null): boolean {
    return Boolean(this.options.lead) && (!action || action.kind !== "skip");
  }

  /**
   * 交给 Lead 一个请求（B1，统一消息事件 spec D1、D8，工单 05）：记一条消息事件（message.received），它就是请求，不再另记
   * channel.lead.requested。tell 级，Lead 单独一轮看到它：结构化的事实（意图、发信人、对话、代码认出的对象、权限上限）
   * 加上外部标签里的原话和上下文包。同一条消息（和并进来的编辑）只交一次。没有期限（工单 06）。Lead 不能工作时照样记 tell 级
   * （Lead 恢复以后按顺序处理），卡按投递方式推送（spec D7）。context：上下文包（contextPackFor 拼的）。
   */
  private requestLead(
    adapter: ChannelAdapter, cardId: number, forSeq: number,
    input: { intent: ChannelIntent | null; action: string; reason: string; handbook?: HandbookDecision | null }, context: BuiltContextPack | null = null,
  ): void {
    const lead = this.options.lead;
    const db = this.db;
    const card = getChannelCard(db, cardId);
    const event = getEvent(db, forSeq);
    if (!lead || !card || !event) return;
    const at = this.now();
    const objects = this.objectsOf(card, event);
    // 同一张卡上还没有决定的请求并进这一个：Lead 处理这一个时，通用工具按卡关掉这张卡上所有还没决定的请求
    // （两条合成一次处理，spec D6）。
    for (const older of this.leadRequests({ cardId: card.id, stage: "intake" })) {
      if (older.forSeq === forSeq) continue;
      this.recordLeadDecision(older, "superseded", "system", `同一张卡又来了新消息（事件 #${forSeq}），并进新的请求`);
    }
    const lane = getChannelLaneById(db, card.laneId);
    const what = input.handbook ? `按「${input.handbook.situation.text}」` : input.intent ? CHANNEL_INTENT_LABELS[input.intent] : "没认出意图";
    const prs = objects.map((object) => `${object.owner}/${object.repo}#${object.number}`).join("、");
    const head = `通道卡 #${card.id}：${card.sender.name}（${SENDER_TRUST_LABELS[card.sender.trust]}）在${lane?.label ?? card.objectKey}找用户`
      + `（${what}${prs ? `，${prs}` : ""}）：${input.reason}。对方的原话在下面的外部标签里。`;
    const summary = `${head}${leadNextStep(input.action)}。`;
    const inserted = db.transaction(() => this.appendMessageEvent(adapter, card, event, input, summary, at, context, { forSeq, objects }))();
    if (inserted) this.pushIfLeadDown(adapter, "intake", forSeq);
  }


  /**
   * 外部通道的一条消息事件（统一消息事件 spec D1，inbound.ts）：交给 Lead 的输入，也是请求（request：forSeq、认出的对象）。
   * 正文是这条消息并进编辑以后的话，带外部标记；前置处理的结论来自请求 A，权限上限按授权表的结论算。带上下文包时（spec D5），
   * 另记一条 message.context_packed：多少条、多少字、缺了哪几项（给 token 成本的统计用）。调用方负责事务。返回这一次有没有记下。
   */
  private appendMessageEvent(
    adapter: ChannelAdapter, card: ChannelCard, event: EventRecord,
    input: { intent: ChannelIntent | null; action: string; handbook?: HandbookDecision | null },
    summary: string, at: Date, context: BuiltContextPack | null, request: { forSeq: number; objects: ChannelLeadObject[] },
  ): boolean {
    const db = this.db;
    const merged = this.mergedMessage(adapter.id, event);
    // 拼包的时候对方又改了消息（并进了这次判断）：按改后的话重拼（工单 11 回放的问题 B）。
    if (context) context = this.repackContext(adapter, card, event, context);
    const sender = event.payload.sender as { id?: unknown; name?: unknown; trust?: unknown } | undefined;
    const lane = getChannelLaneById(db, card.laneId);
    const payload = externalMessageEvent({
      source: adapter.id, sourceLabel: adapter.label,
      conversation: { key: card.objectKey, label: lane?.label ?? card.objectKey },
      sender: {
        id: typeof sender?.id === "string" ? sender.id : card.sender.id,
        name: typeof sender?.name === "string" ? sender.name : card.sender.name,
        trust: isSenderTrust(sender?.trust) ? sender.trust : card.sender.trust,
      },
      text: merged.text, intake: this.intakeOf(adapter.id, event.seq),
      urgent: typeof event.payload.urgent === "boolean" ? event.payload.urgent : null,
      authority: input.action, intent: input.intent, handbook: input.handbook ?? null,
      messageId: typeof event.payload.messageId === "string" ? event.payload.messageId : null,
      messages: merged.seqs, cardId: card.id, summary, context: context?.context ?? null,
    });
    const recorded = appendEvent(db, {
      source: "system", sourceRef: messageEventRef(adapter.id, merged.seqs), kind: MESSAGE_EVENT_KIND, entityKey: card.objectKey,
      correlationId: `channel:${card.objectKey}`, level: "tell", causationId: String(event.seq), occurredAt: at.toISOString(),
      payload: { ...payload, forSeq: request.forSeq, objects: request.objects },
    });
    if (!context || !recorded.inserted) return recorded.inserted;
    this.recordContextPacked(card, recorded.event.seq, context, at);
    return true;
  }

  /**
   * 拼一条消息事件的上下文包（spec D5，context-pack.ts）：读库的几项马上拼好，要等的几项（对话摘要、对象的状态、笔记的召回）
   * 最多等 contextPack.timeoutMs，到了先交给 Lead，写明缺了哪几项。不抛错：拼不成时是 null，消息照样交给 Lead。
   */
  private async contextPackFor(adapter: ChannelAdapter, cardId: number, seq: number): Promise<BuiltContextPack | null> {
    try {
      const card = getChannelCard(this.db, cardId);
      const event = getEvent(this.db, seq);
      if (!card || !event) return null;
      return await buildContextPack(this.contextPackDeps(), this.contextPackInput(adapter, card, event));
    } catch (error) {
      this.log(`[channels] ${adapter.id}: no context pack for event #${seq}: ${errorText(error)}`);
      return null;
    }
  }

  /**
   * 消息改了以后按改后的话重拼上下文包（工单 11 回放的问题 B，context-pack.ts 的 repackForText）。同步的，调用方负责事务。
   * 话没变时原样返回；重拼出错时照用以前的（日志里记一行）。
   */
  private repackContext(adapter: ChannelAdapter, card: ChannelCard, event: EventRecord, previous: BuiltContextPack): BuiltContextPack {
    const input = this.contextPackInput(adapter, card, event);
    if (input.text === previous.text) return previous;
    try {
      return repackForText(this.contextPackDeps(), input, previous.context);
    } catch (error) {
      this.log(`[channels] ${adapter.id}: the context pack for event #${event.seq} was not rebuilt after an edit: ${errorText(error)}`);
      return previous;
    }
  }

  private contextPackDeps(): ContextPackDeps {
    return {
      ...this.options.contextPack,
      db: this.db, now: this.now, log: this.log,
      ...(this.options.pullRequestOf ? { pullRequestOf: (text: string) => this.pullRequestOf(text) } : {}),
      repos: () => this.candidates(),
      describeCard: (described) => cardStateLabel(described),
      later: (work, what) => this.later(work, what),
    };
  }

  // 一条消息事件的上下文包要的事实。话是并进编辑以后的（mergedMessage）。
  private contextPackInput(adapter: ChannelAdapter, card: ChannelCard, event: EventRecord): ContextPackInput {
    const lane = getChannelLaneById(this.db, card.laneId);
    const sender = event.payload.sender as { id?: unknown; name?: unknown } | undefined;
    return {
      source: adapter.id, sourceLabel: adapter.label, kinds: adapter.eventKinds.map((kind) => kind.kind),
      conversation: { key: card.objectKey, label: lane?.label ?? card.objectKey },
      event, text: this.mergedMessage(adapter.id, event).text,
      sender: {
        id: typeof sender?.id === "string" ? sender.id : card.sender.id,
        name: typeof sender?.name === "string" ? sender.name : card.sender.name,
      },
      cardId: card.id, lane,
    };
  }

  // 记一条 message.context_packed：这个上下文包多少条、多少字、缺了哪几项（给 token 成本的统计用）。rebuiltFrom：编辑以后重拼的，
  // 换下来的那条消息事件。调用方负责事务。
  private recordContextPacked(card: ChannelCard, messageEvent: number, built: BuiltContextPack, at: Date, rebuiltFrom: number | null = null): void {
    const { size, missing } = built.context;
    const lacking = missing.length ? `，缺了 ${missing.join("、")}` : "";
    const how = rebuiltFrom === null ? `拼了 ${Math.round(built.ms)} 毫秒` : `改后的话重拼（换下了消息事件 #${rebuiltFrom}）`;
    appendEvent(this.db, {
      source: "system", sourceRef: `message-context:${messageEvent}`, kind: MESSAGE_CONTEXT_EVENT_KIND, entityKey: card.objectKey,
      correlationId: `channel:${card.objectKey}`, level: "record", causationId: String(messageEvent), occurredAt: at.toISOString(),
      payload: {
        messageEvent, cardId: card.id, items: size.items, chars: size.chars, parts: built.parts, missing,
        ms: Math.max(Math.round(built.ms), 0), ...(rebuiltFrom === null ? {} : { rebuiltFrom }),
        summary: `消息事件 #${messageEvent} 的上下文包：${size.items} 条，${size.chars} 字，${how}${lacking}`,
      },
    });
  }

  private leadAvailable(): boolean {
    try {
      return this.options.lead?.available() ?? false;
    } catch (error) {
      this.log(`[channels] could not tell whether Lead can work: ${errorText(error)}`);
      return false;
    }
  }

  // 代码从这条消息和它回复的那条（道的起点）里认出的 PR。不读模型，不读原话以外的东西。
  private objectsOf(card: ChannelCard, event: EventRecord): ChannelLeadObject[] {
    const lane = getChannelLaneById(this.db, card.laneId);
    const texts = [
      typeof event.payload.text === "string" ? event.payload.text : "",
      ...(lane?.context ?? []).filter((message) => message.origin).reverse().map((message) => message.text),
    ];
    const found = new Map<string, ChannelLeadObject>();
    // 一句话里可能有几个 PR（2026-11-02：一条消息请你看两个 PR）：认出一个，从话里去掉它的写法，再认下一个。
    for (let text of texts) {
      for (let pr = this.pullRequestOf(text); pr && found.size < 8; pr = this.pullRequestOf(text)) {
        found.set(`${pr.owner}/${pr.repo}#${pr.number}`.toLowerCase(), { kind: "pull_request", ...pr });
        const rest = withoutPullRequest(text, pr);
        if (rest === text) break;
        text = rest;
      }
    }
    return [...found.values()];
  }

  // 交给 Lead 的请求（统一消息事件工单 05）：intake 是消息事件（并进编辑被取代的不算），reply 是交回 Lead 的子 agent 结果
  // （channel.task.finished 的 handedBack）。工单 05 以前的消息事件没有 forSeq，不算请求。undecided：跳过已经有 channel.lead.decided 的。
  // 先按 kind 索引取这两种事件，再看 source（`+r.source` 不让 SQLite 改走 (source, source_ref) 索引）。走 source 索引时，
  // 每次都要解析全部系统事件的 JSON：2026-11-03 一次卡片列表（185 张卡，每张一次）占住 daemon 主线程 10–12 秒。
  // cardIds：一次取这些卡的请求（卡片列表用，不限条数）。
  private leadRequestRows(
    filter: {
      cardId?: number; cardIds?: readonly number[]; stage?: ChannelLeadStage; forSeq?: number; undecided: boolean; newest?: boolean;
    },
  ): LeadRequest[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.cardId !== undefined) { where.push("json_extract(r.payload, '$.cardId') = ?"); params.push(filter.cardId); }
    if (filter.cardIds !== undefined) {
      where.push("json_extract(r.payload, '$.cardId') IN (SELECT value FROM json_each(?))");
      params.push(JSON.stringify(filter.cardIds));
    }
    if (filter.forSeq !== undefined) { where.push("json_extract(r.payload, '$.forSeq') = ?"); params.push(filter.forSeq); }
    if (filter.stage !== undefined) { where.push("r.kind = ?"); params.push(filter.stage === "intake" ? MESSAGE_EVENT_KIND : CHANNEL_EVENT_KINDS.taskFinished); }
    const rows = this.db.prepare(
      `SELECT r.seq, r.kind, r.payload FROM events r
       WHERE r.kind IN (?, ?) AND +r.source = 'system' AND json_valid(r.payload) AND json_type(r.payload, '$.forSeq') = 'integer'
         AND ((r.kind = ? AND (r.disposition IS NULL OR r.disposition <> 'superseded'))
           OR (r.kind = ? AND json_extract(r.payload, '$.handedBack') = 1))
         ${where.map((clause) => `AND ${clause}`).join(" ")}
         ${filter.undecided ? `AND NOT EXISTS (SELECT 1 FROM events d WHERE d.source = 'system' AND d.source_ref IN (
           'channel-lead-decided:' || (CASE r.kind WHEN ? THEN 'intake' ELSE 'reply' END) || ':' || json_extract(r.payload, '$.forSeq'),
           'channel-lead-decided:reply:' || json_extract(r.payload, '$.forSeq') || ':' || r.seq))` : ""}
       ORDER BY r.seq ${filter.newest ? "DESC" : ""} ${filter.cardIds !== undefined ? "" : "LIMIT 20"}`,
    ).all(
      MESSAGE_EVENT_KIND, CHANNEL_EVENT_KINDS.taskFinished, MESSAGE_EVENT_KIND, CHANNEL_EVENT_KINDS.taskFinished,
      ...params, ...(filter.undecided ? [MESSAGE_EVENT_KIND] : []),
    ) as Array<{ seq: number; kind: string; payload: string }>;
    return rows.flatMap((row) => {
      const request = leadRequestOf(row.seq, row.kind, row.payload);
      return request ? [request] : [];
    });
  }

  // 还没有决定的请求，旧的在前。
  private leadRequests(filter: { cardId?: number; stage?: ChannelLeadStage; forSeq?: number } = {}): LeadRequest[] {
    return this.leadRequestRows({ ...filter, undecided: true });
  }

  private leadRequestAt(stage: ChannelLeadStage, forSeq: number): LeadRequest | null {
    return this.leadRequests({ stage, forSeq })[0] ?? null;
  }

  /** 这张卡上还在等 Lead 决定的请求（最新的一个）。没有时是 null。 */
  pendingLeadRequest(cardId: number): LeadRequest | null {
    return this.leadRequests({ cardId }).at(-1) ?? null;
  }

  // Lead 用通用工具做了一件事：这张卡上所有还没决定的请求都记成这个决定（两条消息合成一次处理，spec D6）。
  private decidePending(cardId: number, decision: ChannelLeadDecision, reason: string, extra: { itemId?: number; runId?: number; dropped?: string[] } = {}): void {
    for (const request of this.leadRequests({ cardId })) this.recordLeadDecision(request, decision, "lead", reason, extra);
  }

  /**
   * Lead 的通用工具按消息事件找卡（统一消息事件工单 05）：外部通道的消息事件，或者交回 Lead 的子 agent 结果（channel.task.finished）。
   * 不是这两种、卡或者来源不在了时抛 ChannelActionError。
   */
  private leadTarget(eventSeq: number): { card: ChannelCard; adapter: ChannelAdapter; event: EventRecord } {
    const event = getEvent(this.db, eventSeq);
    const cardId = event && (event.kind === MESSAGE_EVENT_KIND || event.kind === CHANNEL_EVENT_KINDS.taskFinished) ? event.payload.cardId : null;
    if (!event || typeof cardId !== "number") throw new ChannelActionError("not_found", `#${eventSeq} 不是外部通道的消息事件`);
    const card = getChannelCard(this.db, cardId);
    if (!card) throw new ChannelActionError("not_found", `没有通道卡 #${cardId}`);
    const adapter = this.options.registry.get(card.source);
    if (!adapter) throw new ChannelActionError("unavailable", `来源 ${card.source} 现在没有接上`);
    return { card, adapter, event };
  }


  // 记 Lead 的决定（系统只记两种事实：并进了新的请求、卡已经结束）。同一个请求只记一次：返回 false 时别人已经定了。
  private recordLeadDecision(
    request: LeadRequest, decision: ChannelLeadDecision, by: "lead" | "system", reason: string,
    extra: { itemId?: number; runId?: number; dropped?: string[]; pullRequest?: string } = {},
    // 同一条消息多派的一张工单另记一条（extraDispatchRef），不占这个请求的决定。
    sourceRef: string = leadDecidedRef(request.stage, request.forSeq, request.seq),
  ): boolean {
    const card = getChannelCard(this.db, request.cardId);
    const objectKey = card?.objectKey ?? `${request.channel}:unknown`;
    const words: Record<ChannelLeadDecision, string> = {
      dispatch: "派了子 agent 工单", answer: "自己写了草稿", push: "推送了这张卡", told: "已经告诉了用户",
      superseded: "并进了新的请求", closed: "卡已经结束，不用再决定",
      react: "回了表情", refuse: "用固定的话拒绝了", no_reply: "判断不用回",
    };
    return this.db.transaction(() => appendEvent(this.db, {
      source: "system", sourceRef, kind: CHANNEL_EVENT_KINDS.leadDecided,
      entityKey: objectKey, correlationId: `channel:${objectKey}`, level: "record", causationId: String(request.seq),
      occurredAt: this.now().toISOString(),
      payload: {
        channel: request.channel, cardId: request.cardId, forSeq: request.forSeq, stage: request.stage, decision, by, reason,
        ...extra, summary: `通道卡 #${request.cardId}：${by === "lead" ? "Lead " : ""}${words[decision]}（${reason}）`,
      },
    }).inserted)();
  }

  /**
   * Lead 派活（通用工具 dispatch_agent_task，统一消息事件工单 05）：为一条消息事件派一张子 agent 工单。权限清单由代码算：
   * 这条消息事件的权限上限（授权表给这个意图的上限）∩ Lead 选的范围，Lead 只能收窄（超出的写进 dropped）。要 PR 的意图没给 PR 时
   * 用代码认出的那一个。意图不是要干活的（例如「别的」）时，Lead 只能派只读的咨询或者进度。派出去以后在来源里回一句「正在处理」
   * （只有 Lead 派活时才发，spec D9），结果回到通道的 ⑦。
   */
  async leadDispatch(eventSeq: number, input: ChannelLeadDispatchInput): Promise<ChannelLeadDispatchResult> {
    const { card } = this.leadTarget(eventSeq);
    const pending = this.leadRequests({ cardId: card.id, stage: "intake" }).at(-1);
    const request = pending ?? this.followUpDispatch(card.id, eventSeq, input);
    const followUp = !pending && request.stage === "intake";
    if (request.action === "tell") {
      throw new ChannelActionError("invalid_action", `卡 #${card.id} 是对方在接着回答用户刚说的话：权限上限只让你告诉用户，不能派活`);
    }
    // 交接说明（issue 03）：只告诉你、婉拒不派活。交给你可以派只读的咨询或进度，帮你拟草稿（和以前「问你」一样）。说明下一步。
    const ceiling = this.replyCeilingOf(card.id);
    if (ceiling && (ceiling.final === "tell" || ceiling.final === "refuse")) {
      throw new ChannelActionError("invalid_action", `交接说明让这条消息按「${ceiling.situation.text}」${HANDBOOK_MODE_LABELS[ceiling.final]}，`
        + "不派活。下一步：拟一份回复用 notify_user 交给用户；认为句子选错了，用 repick_situation 改选一句并写理由");
    }
    // 派活的上限（issue 04）：有交接说明的结论时按这一句的能力（abilitiesGrantBound）；这一句没有派活的能力（例如交给你、
    // 兜底的自己判断）时，和以前一样只能派只读的咨询或者进度，帮你拟草稿。没有交接说明的旧消息按意图。
    const sentenceBound = ceiling ? abilitiesGrantBound(ceiling.abilities) : null;
    const reviewIntent = (bound: IntentGrantBound): GrantIntent => (bound.reviewEvents.includes("APPROVE") ? "approve" : "code_review");
    const intent = input.intent ?? (sentenceBound
      ? sentenceBound.pullRequest ? reviewIntent(sentenceBound) : sentenceBound.connections.includes(ATLASSIAN_CONNECTION) ? "progress" : "knowledge"
      : request.intent && isGrantIntent(request.intent) ? request.intent : null);
    if (!intent) throw new ChannelActionError("invalid_action", "这个请求不是要干活的意图：要派工单，请说明是 knowledge（咨询）还是 progress（进度）");
    const reviews = intent === "code_review" || intent === "approve";
    if (sentenceBound && reviews && !sentenceBound.pullRequest) {
      throw new ChannelActionError("invalid_action", `交接说明里的「${ceiling!.situation.text}」不能在 PR 上评论或批准：派 knowledge 或 progress，`
        + "或者认为句子选错了，用 repick_situation 改选一句");
    }
    if (!sentenceBound && !(request.intent && isGrantIntent(request.intent) && !ceiling) && intent !== "knowledge" && intent !== "progress") {
      throw new ChannelActionError("invalid_action", "这条消息没有派活的能力（看交接说明里的这一句）：只能派只读的咨询或者进度，帮用户拟草稿");
    }
    const adapter = this.options.registry.get(request.channel);
    if (!adapter) throw new ChannelActionError("unavailable", `来源 ${request.channel} 现在没有接上`);
    const pullRequest = input.pullRequest ?? (request.objects[0] ? { owner: request.objects[0].owner, repo: request.objects[0].repo, number: request.objects[0].number } : undefined);
    const scope: ExternalGrantScope = {
      ...((sentenceBound ?? DEFAULT_INTENT_GRANT_BOUNDS[intent]).pullRequest && pullRequest ? { pullRequest } : {}),
      ...(input.repos ? { repos: input.repos } : {}),
      ...(input.localRepos ? { localRepos: input.localRepos } : {}),
      ...(input.connections ? { connections: input.connections } : {}),
      // 外部的人请你做事：不能代你要求改动（REQUEST_CHANGES 只给你本人要的评审，lead-self-routing spec B）。
      ...(input.reviewEvents ? { reviewEvents: input.reviewEvents.filter(isExternalReviewEvent) } : {}),
    };
    const dispatched = await this.dispatchTask(adapter, request, {
      intent, summary: input.summary, scope, followUp, ...(sentenceBound ? { bound: sentenceBound } : {}),
    });
    return { itemId: dispatched.itemId, runId: dispatched.runId, grant: describeRunGrant(dispatched.grant), dropped: dispatched.dropped };
  }

  /**
   * 这条消息的请求已经定了以后，Lead 还能再派的两种情况（2026-11-02：同事等了一个多小时）：
   *   - 子 agent 的结果交回了（交回的那一次还没定）：重派，算 Lead 对那次交回的决定；
   *   - 这条消息里还有别的 PR 没派：每个 PR 一张工单，权限各管一个 PR。
   * 上限都按原来那条消息算。一条消息最多派 CHANNEL_MAX_TASKS_PER_MESSAGE 张。不能派时抛错，写明下一步。
   */
  private followUpDispatch(cardId: number, eventSeq: number, input: ChannelLeadDispatchInput): LeadRequest {
    const refuse = (why: string) => new ChannelActionError("invalid_action", `消息事件 #${eventSeq}（卡 #${cardId}）${why}。${DISPATCH_NEXT_STEP}`);
    const intake = this.leadRequestRows({ cardId, stage: "intake", undecided: false, newest: true })[0];
    const dispatched = intake ? this.dispatchedFor(intake.forSeq) : null;
    if (!intake || !dispatched?.count) throw refuse("没有等你派活的请求：已经处理过了");
    if (dispatched.count >= CHANNEL_MAX_TASKS_PER_MESSAGE) throw refuse(`这条消息已经派了 ${dispatched.count} 张工单，不能再派`);
    const back = this.leadRequests({ cardId, stage: "reply", forSeq: intake.forSeq }).at(-1);
    if (back) return { ...intake, seq: back.seq, event: back.event, stage: "reply" };
    const wanted = input.pullRequest ?? intake.objects.find((object) => !dispatched.pullRequests.has(pullRequestKey(object)));
    if (!wanted) throw refuse("这条消息派过工单了，结果还没交回，也没有别的 PR 要派");
    const key = pullRequestKey(wanted);
    const object = intake.objects.find((candidate) => pullRequestKey(candidate) === key);
    if (!object) throw refuse(`这条消息里没有 ${key}，只能为这条消息里的 PR 再派`);
    if (dispatched.pullRequests.has(key)) throw refuse(`${key} 已经派过工单，等结果交回以后才能重派`);
    // 没给 PR 时 leadDispatch 用 objects 的第一个：把要派的这个排到前面。
    return { ...intake, objects: [object, ...intake.objects.filter((candidate) => candidate !== object)] };
  }

  // 这条消息派过的子 agent 工单：几张，哪些 PR（Lead 的决定里记着）。
  private dispatchedFor(forSeq: number): { count: number; pullRequests: Set<string> } {
    const rows = this.db.prepare(
      `SELECT json_extract(payload, '$.pullRequest') AS pr FROM events
       WHERE source = 'system' AND kind = ? AND json_valid(payload)
         AND json_extract(payload, '$.forSeq') = ? AND json_extract(payload, '$.decision') = 'dispatch'`,
    ).all(CHANNEL_EVENT_KINDS.leadDecided, forSeq) as Array<{ pr: unknown }>;
    return { count: rows.length, pullRequests: new Set(rows.flatMap((row) => (typeof row.pr === "string" ? [row.pr] : []))) };
  }

  // Lead 派一张子 agent 工单：原话和上下文只进子 agent 的提示词（不可信）；工单的说明是 Lead 写的一句话。
  // followUp：这条消息已经派过工单，这一张是另一个 PR 的（followUpDispatch 查过），不再要求请求没有定。
  private async dispatchTask(adapter: ChannelAdapter, request: LeadRequest, input: {
    intent: GrantIntent; summary: string; scope: ExternalGrantScope; bound?: IntentGrantBound; followUp?: boolean;
  }): Promise<AgentTaskDispatch> {
    const lead = this.options.lead;
    const db = this.db;
    const card = getChannelCard(db, request.cardId);
    const event = getEvent(db, request.forSeq);
    if (!lead || !card || !event) throw new ChannelActionError("not_found", `没有通道卡 #${request.cardId}`);
    // 同一个 PR 同时只派一张；同一条消息里不同的 PR 可以同时派（2026-11-02）。
    const pr = input.scope.pullRequest ? pullRequestKey(input.scope.pullRequest) : "-";
    const key = `${request.stage}:${request.forSeq}:${pr}`;
    if (this.leadDeciding.has(key)) throw new ChannelActionError("conflict", `卡 #${card.id} 正在为 ${pr === "-" ? "这条消息" : pr} 派工单，等它派完`);
    this.leadDeciding.add(key);
    try {
      if (!input.followUp && !this.leadRequestAt(request.stage, request.forSeq)) {
        throw new ChannelActionError("conflict", `卡 #${card.id} 的请求已经定了。${DISPATCH_NEXT_STEP}`);
      }
      const lane = getChannelLaneById(db, card.laneId);
      // 对方改过的消息用改以后的话（spec D6）。
      const text = this.mergedMessage(adapter.id, event).text || card.excerpt;
      const context = (lane?.context ?? []).filter((message) => message.seq !== request.forSeq)
        .map((message) => `[${message.role === "them" ? message.sender : message.role === "me" ? "用户" : "助手"}] ${message.text}`).join("\n");
      const dispatched = await lead.dispatcher.dispatch({
        intent: input.intent,
        request: {
          source: adapter.id, requester: (card.sender.name || "对方").slice(0, 120),
          summary: (input.summary.trim() || CHANNEL_INTENT_LABELS[input.intent]).slice(0, AGENT_TASK_LIMITS.summaryChars), ref: `card:${card.id}`,
        },
        untrusted: {
          message: clipEventText(text, AGENT_TASK_LIMITS.messageChars),
          ...(context ? { context: clipEventText(context.slice(-AGENT_TASK_LIMITS.contextChars), AGENT_TASK_LIMITS.contextChars) } : {}),
        },
        scope: input.scope,
        bound: input.bound ?? (request.intent === input.intent && request.bound ? request.bound : DEFAULT_INTENT_GRANT_BOUNDS[input.intent]),
        callback: { kind: CHANNEL_TASK_CALLBACK, ref: taskRef(card.id, request.forSeq) },
      });
      const decided = {
        itemId: dispatched.itemId, runId: dispatched.runId, ...(pr !== "-" ? { pullRequest: pr } : {}),
        ...(dispatched.dropped.length ? { dropped: dispatched.dropped } : {}),
      };
      // 同时派的另一个 PR 的工单，请求已经被前一张定了：另记一条，下一次派活按它数这条消息派过哪些 PR。
      if (input.followUp || !this.recordLeadDecision(request, "dispatch", "lead", "Lead 决定派工单", decided)) {
        this.recordLeadDecision(request, "dispatch", "lead", `Lead 为 ${pr} 再派一张工单`, decided, extraDispatchRef(request.forSeq, dispatched.runId));
      }
      this.recordTaskStart(adapter, card, request, input.intent, input.scope, dispatched, text);
      // 回一句「正在处理」：结果出来以后的回复改写它（落地计划 A3）。只有 Lead 派活时才发（统一消息事件 spec D9）。
      this.sendStatusNotice(adapter, card, request.forSeq, text, input.intent === "code_review" || input.intent === "approve" ? "review" : "lookup");
      this.cardsChanged([card.id]);
      return dispatched;
    } finally {
      this.leadDeciding.delete(key);
    }
  }

  /**
   * 子 agent 工单记成这张卡的一次「代查」（channel_lookups，落地计划 D1）：卡上的两条轨道、Lead 读对话时看到的卡、
   * 你在卡上的选择（校准样本）都按它。剧本按意图：代码 review、approve 是 review，咨询、进度是 lookup。原话只截断存着，
   * 和代查一样只用来显示。这张卡已经有一张在跑的工单时不记（部分唯一索引），结果照样回到 ⑦。
   */
  private recordTaskStart(
    adapter: ChannelAdapter, card: ChannelCard, request: LeadRequest, intent: GrantIntent, scope: ExternalGrantScope,
    dispatched: AgentTaskDispatch, question: string,
  ): void {
    const db = this.db;
    const intake = this.intakeOf(adapter.id, request.forSeq);
    const number = (value: unknown) => (typeof value === "number" ? value : null);
    const pr = scope.pullRequest;
    const local = dispatched.grant.localRepos.slice(0, 4).map((repo) => ({ repo: repo.name, root: repo.root }));
    const github = [...new Set([...(pr ? [`${pr.owner}/${pr.repo}`] : []), ...(scope.repos ?? [])])].slice(0, 4)
      .map((name) => ({ owner: name.split("/")[0]!, repo: name.split("/")[1]! }));
    const at = this.now();
    try {
      db.transaction(() => {
        const created = createChannelLookup(db, {
          cardId: card.id, source: adapter.id, objectKey: card.objectKey, forSeq: request.forSeq,
          playbook: intent === "code_review" || intent === "approve" ? "review" : "lookup", state: "running",
          requester: { id: card.sender.id, name: card.sender.name, trust: card.sender.trust }, question,
          intake: {
            answered: intake?.status === "answered", askKind: typeof intake?.askKind === "string" ? intake.askKind : null,
            askConfidence: number(intake?.askConfidence), targetRepo: typeof intake?.targetRepo === "string" ? intake.targetRepo : null,
            sensitive: (intake?.sensitive ?? {}) as Record<string, number>, topics: (intake?.topics ?? {}) as Record<string, number>,
            needsReply: number(intake?.needsReply), gate: null, at: at.toISOString(),
          },
          scope: { local, github, ...(pr ? { pullRequest: pr } : {}) }, at,
        });
        updateChannelLookup(db, created.id, { itemId: dispatched.itemId, runId: dispatched.runId }, { at });
        updateChannelCard(db, card.id, {}, { at });
      })();
    } catch (error) {
      this.log(`[channels] ${adapter.id}: could not record the task of card #${card.id}: ${errorText(error)}`);
    }
  }

  /**
   * 代查退役（落地计划 D1）：daemon 换版本时还没结束的旧代查（过了代查闸门的，在跑或者还在排队）再也不会有结果了：
   * 记成失败，原因写明，卡留着等你处理。只在这个 hub 的第一拍做一次；修过的不再匹配，所以有界、幂等。
   */
  private retireOldLookups(): void {
    if (this.retiredOldLookups) return;
    this.retiredOldLookups = true;
    const at = this.now();
    for (const lookup of listActiveLookups(this.db)) {
      // 子 agent 工单的记录没有代查闸门的结论（recordTaskStart 写 gate: null）；旧代查都过了闸门。
      if (lookup.intake.gate === null) continue;
      this.db.transaction(() => {
        updateChannelLookup(this.db, lookup.id, {
          state: "failed", finishedAt: at.toISOString(),
          reply: { decision: "hand_over", reasons: ["代查已经退役，这次没有结果；现在由 Lead 派子 agent 工单"], order: null, at: at.toISOString(), choice: null },
        }, { at });
        updateChannelCard(this.db, lookup.cardId, {}, { at });
      })();
      this.cardsChanged([lookup.cardId]);
    }
  }

  /**
   * 每一拍（不变量：没有一张卡停在「在跑」）：子 agent 工单的 Run 已经结束超过 TASK_RESULT_GRACE_MS，结果却没有交回
   * （例如 daemon 在 Run 结束和交回之间退出）：记成失败，交给你，再交给 Lead（B4）。
   */
  private settleLostTasks(): void {
    const now = this.now();
    for (const lookup of listActiveLookups(this.db)) {
      if (lookup.runId === null || lookup.intake.gate !== null) continue;
      const run = getRun(this.db, lookup.runId);
      const ended = run && !["starting", "running", "paused"].includes(run.state) ? dbTime(run.ended_at ?? run.started_at) : NaN;
      if (!Number.isFinite(ended) || now.getTime() - ended < TASK_RESULT_GRACE_MS) continue;
      const adapter = this.options.registry.get(lookup.source);
      const at = now.toISOString();
      const reason = "子 agent 工单结束了，结果没有交回（例如 daemon 重启了）";
      this.db.transaction(() => {
        updateChannelLookup(this.db, lookup.id, {
          state: "failed", finishedAt: at,
          reply: { decision: "hand_over", reasons: [reason], order: null, at, choice: null },
        }, { at: now });
        updateChannelCard(this.db, lookup.cardId, {}, { at: now });
      })();
      this.cardsChanged([lookup.cardId]);
      this.later(() => this.settleStatusNotices(lookup.cardId), `status notice of card #${lookup.cardId}`);
      const card = getChannelCard(this.db, lookup.cardId);
      if (!adapter || !card || lookup.itemId === null || !(CHANNEL_CARD_OPEN_STATES as readonly ChannelCardState[]).includes(card.state)) continue;
      // 交回 Lead（B4）：记一条 channel.task.finished（失败，交回 Lead）。结果以后又交回来时按同一个 source_ref 不再记。
      const back = this.handBack(card, lookup.forSeq, { intent: lookup.playbook === "review" ? "code_review" : "knowledge", decision: "hand_over", reason });
      const { inserted } = appendEvent(this.db, {
        source: "system", sourceRef: `channel-task-finished:${lookup.runId}`, kind: CHANNEL_EVENT_KINDS.taskFinished, entityKey: card.objectKey,
        correlationId: `channel:${card.objectKey}`, level: back.level, causationId: String(lookup.forSeq), occurredAt: at,
        payload: {
          channel: adapter.id, cardId: card.id, forSeq: lookup.forSeq, runId: lookup.runId, itemId: lookup.itemId, status: "failed",
          decision: "hand_over", confidence: null, threshold: null, actions: 0, ...back.fields,
          summary: `通道卡 #${card.id} 的子 agent 工单 #${lookup.itemId}：${reason}${back.next ? `。${back.next}` : ""}`,
        },
      });
      if (inserted) this.pushIfLeadDown(adapter, "reply", lookup.forSeq);
    }
  }

  /**
   * 外部通道的出站扩展（统一消息事件 spec D9，工单 05）：Lead 不在用户这一轮里写的回复。Lead 自己判断（用户 2026-10-29），
   * 不过信心检验：草稿记到卡上（drafter 是 lead），带 auto-reply 署名代你发，留撤回窗口，卡结束；这张卡上还没决定的请求都记成 answer。
   * 卡正在发别的回复时抛 conflict。reasons：没发出去时写原因（系统会用同一个幂等键再试）。
   */
  private async leadReply(adapter: ChannelAdapter, card: ChannelCard, text: string): Promise<{ card: ChannelCard; reasons: string[] }> {
    // 派了活还没交回：子 agent 的结果交回以后由出站检验定代你回还是交给你，「正在处理」已经告诉了对方。现在回会让卡提前结束。
    const task = this.awaitingTask(card.id);
    if (task) throw new ChannelActionError("conflict", `${awaitingTaskNote(card.id, task)}，现在不用回复对方`);
    this.updateDraftByLead(card.id, text);
    const latest = getChannelCard(this.db, card.id)!;
    const draft = latest.draft!;
    const outcome = await this.sendReply(adapter, latest, "auto_reply", {
      revokeWindowMs: AUTHORITY_REVOKE_WINDOW_MS,
      outgoing: {
        key: `answer:card:${latest.id}:seq:${draft.forSeq}`, by: "auto", fromDraft: true,
        ...autoReplyDisclosure(this.assistantFor(adapter), this.ownerNameFor(adapter), draft.text),
      },
    });
    if (!outcome) throw new ChannelActionError("conflict", `卡 #${card.id} 正在发别的回复，等它发完再回`);
    const failed = outcome.status === "failed" ? `这一次没有发出去，系统会用同一个幂等键再试（${outcome.error ?? "未知原因"}）` : null;
    this.decidePending(latest.id, "answer", `Lead 的回复代你发了${failed ? `；${failed}` : ""}`);
    this.refreshLaneOf(latest);
    this.cardsChanged([latest.id]);
    await this.settleStatusNotices(latest.id);
    return { card: getChannelCard(this.db, latest.id)!, reasons: failed ? [failed] : [] };
  }

  /**
   * 回复绑定到触发它的消息事件（工单 #286）：event 要是外部通道的消息事件（或者带着它的子 agent 交回），而且它的对话就是
   * 要发的对话。不是时抛 invalid_action，什么都不发。
   */
  private assertReplyBelongs(conversationId: string, eventSeq: number): void {
    let event = getEvent(this.db, eventSeq);
    if (event && event.kind !== MESSAGE_EVENT_KIND && event.payload.handedBack === true && typeof event.payload.messageEvent === "number") {
      event = getEvent(this.db, event.payload.messageEvent);
    }
    const key = event?.kind === MESSAGE_EVENT_KIND ? messageEventConversationKey(event.payload) : null;
    if (!key) throw new ChannelActionError("invalid_action", `#${eventSeq} 不是外部通道的消息事件：回复要填对方那条消息的消息事件`);
    if (key !== conversationId) {
      throw new ChannelActionError(
        "invalid_action",
        `没有发：消息事件 #${eventSeq} 在对话 ${key}，不在 ${conversationId}。回复只能回到那条消息所在的对话；先确认这段话是写给哪个对话的`,
      );
    }
  }

  // Lead 回复的是哪一条：给了消息事件时是它最后一条入站事件（编辑也算），否则是卡上最新的一条。
  private replyForSeq(card: ChannelCard, eventSeq: number | undefined): number {
    const event = eventSeq === undefined ? undefined : getEvent(this.db, eventSeq);
    const seqs = event?.kind === MESSAGE_EVENT_KIND && Array.isArray(event.payload.messages)
      ? event.payload.messages.filter((seq): seq is number => typeof seq === "number") : [];
    return seqs.length && event?.payload.cardId === card.id ? Math.max(...seqs) : card.lastSeq;
  }


  /** 按人名、对话名找可以发消息的对话（Lead 代用户直接发消息）。source 为 null 时用第一个能找对话的来源。来源不支持时抛 unavailable。 */
  async findConversations(source: string | null, query: string): Promise<ChannelConversationCandidate[]> {
    const adapter = source === null
      ? this.options.registry.list().find((candidate) => candidate.findConversations)
      : this.options.registry.get(source);
    if (!adapter?.findConversations) throw new ChannelActionError("unavailable", `${source ? `来源 ${source}` : "接上的来源"}不能按名字找对话`);
    const context = await this.context(adapter);
    if (!context) throw new ChannelActionError("unavailable", `来源 ${adapter.id} 现在没有接上`);
    return adapter.findConversations(query, context);
  }

  /**
   * 设置页的署名预览（Lead 的形象，2026-10-28）：署名里助手名前面的标记（例如来源里的自定义 emoji 的短代码）在来源里查得到吗，
   * 加上自动回复的署名文字（不带标记，和真的发出去的一样）。用第一个能查标记的来源。
   * 不抛错：没有这样的来源、没接上、查不了时 status 是 unavailable，reason 说明为什么（不含凭据）。
   */
  async previewDisclosureMark(mark: string): Promise<ChannelMarkPreview> {
    const adapter = this.options.registry.list().find((candidate) => candidate.lookupDisclosureMark);
    if (!adapter?.lookupDisclosureMark) {
      return { status: "unavailable", reason: "接上的来源都查不了署名的标记。", byline: this.autoReplyByline({ id: "" }) };
    }
    const context = await this.context(adapter);
    // 主人名取凭据里的名字：先取凭据（context 记下它），再拼署名。
    const byline = this.autoReplyByline(adapter);
    if (!context) {
      return { status: "unavailable", reason: `${adapter.label} 还没有连上：在设置 → 消息通道里连上以后才能预览。`, byline };
    }
    try {
      return { ...(await adapter.lookupDisclosureMark(mark, context)), byline };
    } catch (error) {
      return {
        status: "unavailable", reason: `问 ${adapter.label} 失败：${scrubCredential(errorText(error), { credential: context.credential })}`, byline,
      };
    }
  }

  // 自动发出的回复的署名文字（不带来源的标记）。
  private autoReplyByline(adapter: Pick<ChannelAdapter, "id">): string {
    return autoReplyDisclosure(this.assistantNameNow(), this.ownerNameFor(adapter), "").parts.byline;
  }

  /** 这个来源能不能往对话里直接发消息。 */
  canSendMessage(source: string): boolean {
    const adapter = this.options.registry.get(source);
    return Boolean(adapter?.capabilities.reply && adapter.resolveConversation);
  }

  /** 不能往这个来源里写的原因（来源说的，例如用户关掉了「代你发消息」）。能写、或者来源没说时是 null。 */
  writesBlocked(source: string): string | null {
    return this.options.registry.get(source)?.writesBlocked?.() ?? null;
  }

  /**
   * 往一个对话里发一条消息，不经过卡片（用户 2026-10-23：Lead 要能直接在外部来源里发消息，不依赖通道卡片）。
   * forUser：你本人，或者 Lead 在你这一轮里代你发：words 是 user 时是你的原话，原样发，不加署名；assistant 是 Lead 组织的话，
   * 带「confirmed by <主人名>」的署名。不是（定时器、外部消息叫醒的一轮）：是 Lead 自己的话，带「auto-reply」的署名，
   * 不冒充你确认过（统一消息事件 spec D9，工单 05）。邮箱先脱敏。
   * 每次一个新的幂等键（一次请求只发一条）。发不出去时抛 outbound_failed；对话编号不对、找不到时抛 not_found。
   * 卡跟着结束（2026-10-26）：这个对话里有等你的卡时，这条消息就是你的回复（卡「已回复」，「正在处理」改写成它）；
   * 不在你这一轮里时是 Lead 自己的回复（leadReply）：Lead 判断，代你发，留撤回窗口，outcome 是 auto_sent。event 是 Lead 回复的消息事件。
   * cardId 是另一个对话里的卡时，这条消息做的是那张卡上的事（卡「已处理」，在对方的消息上回 ✅）。
   * seenBefore：你这一轮开始的时间（毫秒）。卡上最新的消息不早于它时，你说话时还没见过，卡不结束，card.note 写明。
   * refusal：Lead 用固定的话拒绝（回复到来源的固定拒绝，refuseForLead），不走上面这些。
   */
  async sendMessage(
    conversationId: string,
    input: {
      text: string; words: "user" | "assistant"; by: string; forUser: boolean; seenBefore?: number | null; cardId?: number; event?: number;
      refusal?: boolean;
    },
  ): Promise<ChannelSentMessage> {
    const source = conversationId.split(":")[0] ?? "";
    // 工单 #286：回复一条消息事件的（event）只能发到那条消息所在的对话。对不上时什么都不发：多半是给别的对话写的话。
    if (input.event !== undefined) this.assertReplyBelongs(conversationId, input.event);
    const adapter = this.options.registry.get(source);
    if (!adapter?.capabilities.reply || !adapter.resolveConversation) throw new ChannelActionError("unavailable", `来源 ${source} 不能直接发消息`);
    const context = await this.context(adapter);
    if (!context) throw new ChannelActionError("unavailable", `来源 ${source} 现在没有接上`);
    let place;
    try {
      place = await adapter.resolveConversation(conversationId, context);
    } catch (error) {
      throw new ChannelActionError("not_found", errorText(error));
    }
    // 交接说明的上限（用户 2026-10-30 定 D2）：Lead 自己的回复（不是替用户发的）落在一张开着的卡上时，按这张卡最新一条消息的
    // 上限：放手照常发；做好给你看、交给你、只告诉你、婉拒，回复放到卡上等用户点发送，不发出去。固定的拒绝走它自己的检查。
    // 连续对话不算（用户 2026-10-29：「连续对话和互动哪来那么多傻逼死锁机制」）：你或 Lead 在这个对话里最近 30 分钟说过话，
    // 对方在接着说，Lead 的回复按 Lead 自己的判断发。交接说明管的是别人找你的新消息。
    if (!input.forUser && !input.refusal) {
      const open = getOpenChannelCard(this.db, place.objectKey);
      const ceiling = open ? this.replyCeilingOf(open.id) : null;
      // 底线 4：对方在要求改规则、记忆或偏好：Lead 的回复（玩笑或者拒绝）可以直接发，它不做任何事。
      if (open && ceiling && !replyAllowed(ceiling.final) && !ceiling.ruleChange && !this.inConversation(adapter, open)) {
        return this.draftForUser(adapter, open, input.text.trim(), ceiling, { conversation: conversationId, label: place.label, objectKey: place.objectKey });
      }
    }
    if (input.refusal) return this.refuseForLead(adapter, conversationId, place, input);
    const text = input.text.trim();
    const signed = !input.forUser ? autoReplyDisclosure(this.assistantFor(adapter), this.ownerNameFor(adapter), text)
      : input.words === "assistant" ? confirmedDraftDisclosure(this.assistantFor(adapter), this.ownerNameFor(adapter), text) : null;
    const message = signed ? maskOutgoing({ ...signed, key: "", fromDraft: true, by: input.forUser ? "user" : "auto" }) : { text, masked: 0 };
    if (message.masked) this.log(`[channels] ${adapter.id}: masked ${message.masked} email address(es) in a message to ${place.objectKey}`);
    const key = `message:${place.objectKey}:${randomUUID()}`;
    const sent = { conversation: conversationId, label: place.label, objectKey: place.objectKey, text: message.text, outcome: "sent" as const };
    const waiting = getOpenChannelCard(this.db, place.objectKey);
    let card: ChannelSentMessage["card"] = null;
    if (waiting && !this.seenBy(waiting, input.seenBefore)) {
      card = { id: waiting.id, state: waiting.state, note: `卡 #${waiting.id} 在你这一轮开始之后又来了新消息，没有结束；先告诉用户` };
    } else if (waiting && !input.forUser) {
      // 出站扩展：Lead 自己写的回复走卡的发送（spec D9），卡结束，不另发一条。
      if (this.sending.has(waiting.id) || waiting.sent?.status === "pending") {
        throw new ChannelActionError("conflict", `卡 #${waiting.id} 正在发别的回复，等它发完再回`);
      }
      const replied = await this.leadReply(adapter, waiting, text);
      this.log(`[channels] ${adapter.id}: Lead's own reply on card #${waiting.id}: auto_sent`);
      return {
        ...sent, text: replied.card.sent?.text ?? message.text, outcome: "auto_sent",
        ...(replied.reasons.length ? { reasons: replied.reasons } : {}), card: { id: replied.card.id, state: replied.card.state },
      };
    } else if (waiting) {
      // 这条消息就是你对这张卡的回复：走卡的发送（改写「正在处理」、卡「已回复」、事件处理掉）。
      const outcome = await this.sendReply(adapter, waiting, "user_reply", {
        revokeWindowMs: 0,
        outgoing: { key, text: message.text, ...(message.parts ? { parts: message.parts } : {}), fromDraft: false, by: "user" },
        resolution: { by: input.by, action: "send_message" },
      });
      if (outcome) {
        if (outcome.status === "failed") {
          this.cardsChanged([waiting.id]);
          throw new ChannelActionError("outbound_failed", `没有发出去，系统会用同一个幂等键再试：${outcome.error ?? "未知原因"}`);
        }
        // 校准的标签：卡上的草稿原样发的算照发，别的算改写。
        recordActionInTransaction(this.db, () => this.labelReply(
          waiting, waiting.draft && waiting.draft.text.trim() === text ? "sent_as_is" : "rewritten", this.now(), waiting.draft?.at ?? null,
        ));
        this.refreshLaneOf(waiting);
        this.cardsChanged([waiting.id]);
        await this.settleStatusNotices(waiting.id);
        this.log(`[channels] ${adapter.id}: sent a message to ${place.objectKey} for the user (${input.by}), answering card #${waiting.id}`);
        const after = getChannelCard(this.db, waiting.id)!;
        this.closePendingRequest(after, input.by);
        card = { id: after.id, state: after.state };
        if (input.cardId !== undefined && input.cardId !== waiting.id) {
          return { ...sent, card: await this.handledBy(input.cardId, place.label, input) };
        }
        return { ...sent, card };
      }
      // 卡正在发别的回复：照常另发一条，卡不动。
    }
    const outcome = await this.outbox.perform(adapter, context, {
      key, purpose: "user_reply", cardId: null,
      request: {
        action: "reply", objectKey: place.objectKey, target: place.target, text: message.text,
        ...(message.parts ? { parts: message.parts } : {}),
      },
    });
    if (outcome.status === "failed") throw new ChannelActionError("outbound_failed", `没有发出去：${outcome.error ?? "未知原因"}`);
    this.log(`[channels] ${adapter.id}: sent a message to ${place.objectKey} for the user (${input.by})`);
    if (input.cardId !== undefined && input.cardId !== waiting?.id) card = await this.handledBy(input.cardId, place.label, input);
    return { ...sent, card };
  }

  /**
   * Lead 用固定的话拒绝（回复到来源的 refusal，统一消息事件工单 06；用户 2026-10-22：问涉密信息的，直接用固定的话拒绝）。
   * 内容只能是 AUTHORITY_REFUSAL_TEXT，Lead 不能自己写拒绝的内容。授权表的涉密是「用固定的话拒绝」、自动代你处理开着时才允许；
   * 外部客户、外部共享的对话照旧什么都不代你发（底线）。内容固定、不泄露任何信息，所以不过信心检验（不受敏感查询的底线拦截），
   * 在哪一轮都带 auto-reply 署名，留撤回窗口。回的是这个对话里等你的卡上 Lead 回复的那一条，这张卡上还没决定的请求记成 refuse。
   * 不合规时抛 invalid_action；卡上又来了新消息、正在发别的回复时抛 conflict。
   */
  private async refuseForLead(
    adapter: ChannelAdapter, conversationId: string, place: { objectKey: string; label: string },
    input: { text: string; seenBefore?: number | null; event?: number },
  ): Promise<ChannelSentMessage> {
    if (input.text.trim() !== AUTHORITY_REFUSAL_TEXT) {
      throw new ChannelActionError("invalid_action", `固定的拒绝只能发固定的话：「${AUTHORITY_REFUSAL_TEXT}」。不要自己写拒绝的内容；要说别的，不用 refusal`);
    }
    const card = getOpenChannelCard(this.db, place.objectKey);
    if (card?.state !== "open") throw new ChannelActionError("invalid_action", `${place.label}没有等你处理的卡：固定的拒绝只用来回复对方的消息`);
    // 交接说明（issue 07）：开关关着时不代你发任何东西。问到敏感信息婉拒是底线，不能在交接说明里改。
    if (!this.handbookNow().autoReply) {
      throw new ChannelActionError("invalid_action", "自动代你处理关着，不代你拒绝：用 notify_user 告诉用户");
    }
    if (NEVER_DELEGATED_TRUST.includes(card.sender.trust) || this.externalSharedOf(card.lastSeq) !== false) {
      throw new ChannelActionError("invalid_action", "外部客户、外部共享的对话什么都不代你发：用 notify_user 告诉用户");
    }
    const forSeq = this.replyForSeq(card, input.event);
    if (card.lastSeq !== forSeq || !this.seenBy(card, input.seenBefore)) {
      throw new ChannelActionError("conflict", `卡 #${card.id} 上又来了新消息：先看新消息再定`);
    }
    if (this.sending.has(card.id) || card.sent?.status === "pending") throw new ChannelActionError("conflict", `卡 #${card.id} 正在发别的回复`);
    const outcome = await this.sendRefusal(adapter, card, forSeq);
    if (!outcome) throw new ChannelActionError("conflict", `卡 #${card.id} 正在发别的回复`);
    const failed = outcome.status === "failed" ? `这一次没有发出去，系统会用同一个幂等键再试（${outcome.error ?? "未知原因"}）` : null;
    this.decidePending(card.id, "refuse", `Lead 用固定的话拒绝了涉密的请求${failed ? `；${failed}` : ""}`);
    this.refreshLaneOf(card);
    this.cardsChanged([card.id]);
    await this.settleStatusNotices(card.id);
    const after = getChannelCard(this.db, card.id)!;
    return {
      conversation: conversationId, label: place.label, objectKey: place.objectKey, text: after.sent?.text ?? AUTHORITY_REFUSAL_TEXT,
      outcome: "auto_sent", reasons: ["固定的拒绝，不过信心检验", ...(failed ? [failed] : [])], card: { id: after.id, state: after.state },
    };
  }

  // 一条发到别的对话的消息做的是这张卡上的事：卡还开着、你说话时见过它，就结束成「已处理」并回 ✅；已经结束的照原样报告。
  private async handledBy(
    cardId: number, label: string, input: { by: string; seenBefore?: number | null },
  ): Promise<NonNullable<ChannelSentMessage["card"]>> {
    const card = getChannelCard(this.db, cardId);
    if (!card) return { id: cardId, state: "open", note: `没有卡 #${cardId}` };
    if (!(CHANNEL_CARD_OPEN_STATES as readonly ChannelCardState[]).includes(card.state)) return { id: card.id, state: card.state };
    if (!this.seenBy(card, input.seenBefore)) {
      return { id: card.id, state: card.state, note: `卡 #${card.id} 在你这一轮开始之后又来了新消息，没有结束；先告诉用户` };
    }
    try {
      const after = await this.act(card.id, "handled", { by: input.by, note: `在${label}里发了消息` });
      return { id: after.id, state: after.state };
    } catch (error) {
      return { id: card.id, state: card.state, note: `消息发出去了，卡 #${card.id} 没有结束：${errorText(error)}` };
    }
  }

  /**
   * 改对话里的一条消息（2026-11-02，用户：要能改用户或者 Lead 发出去的消息）。ref 是这条消息在来源里的编号
   * （read_channel_conversation 的消息上有）。先从来源里取这一条：只能改用户自己的账号发的（role 是 me 或 assistant）。
   * 新的文字和 sendMessage 一样带署名：words=user 是用户的原话，不加署名；words=assistant 在用户这一轮里带「confirmed by」，
   * 别的轮次带「auto-reply」。邮箱先脱敏。卡不跟着变。
   * 文字是空的、是别人的消息时抛 invalid_action；对话、消息找不到时抛 not_found；来源不能改消息时抛 unavailable；
   * 来源拒绝（例如过了能改的时间）时抛 outbound_failed。
   */
  async editMessage(
    conversationId: string, input: { ref: string; text: string; words: "user" | "assistant"; by: string; forUser: boolean },
  ): Promise<ChannelEditedMessage> {
    const text = input.text.trim();
    if (!text) throw new ChannelActionError("invalid_action", "新的文字是空的");
    const source = conversationId.split(":")[0] ?? "";
    const adapter = this.options.registry.get(source);
    if (!adapter?.capabilities.edit || !adapter.history || !adapter.capabilities.history || !adapter.resolveConversation) {
      throw new ChannelActionError("unavailable", `来源 ${source} 不能改消息`);
    }
    const context = await this.context(adapter);
    if (!context) throw new ChannelActionError("unavailable", `来源 ${source} 现在没有接上`);
    let place;
    try {
      place = await adapter.resolveConversation(conversationId, context);
    } catch (error) {
      throw new ChannelActionError("not_found", errorText(error));
    }
    let found;
    try {
      found = (await adapter.history({ objectKey: place.objectKey, ref: input.ref, limit: 1 }, context))
        .find((message) => message.ref === input.ref);
    } catch (error) {
      throw new ChannelActionError("not_found", `${place.label}里没有读到消息 ${input.ref}：${errorText(error)}`);
    }
    if (!found?.target) throw new ChannelActionError("not_found", `${place.label}里没有消息 ${input.ref}`);
    if (found.role === "them") {
      throw new ChannelActionError("invalid_action", `消息 ${input.ref} 是 ${found.sender.name} 发的：只能改用户自己的账号发的消息（用户本人或者 Lead 发的）`);
    }
    const signed = !input.forUser ? autoReplyDisclosure(this.assistantFor(adapter), this.ownerNameFor(adapter), text)
      : input.words === "assistant" ? confirmedDraftDisclosure(this.assistantFor(adapter), this.ownerNameFor(adapter), text) : null;
    const message = signed ? maskOutgoing({ ...signed, key: "", fromDraft: true, by: input.forUser ? "user" : "auto" }) : { text, masked: 0 };
    if (message.masked) this.log(`[channels] ${adapter.id}: masked ${message.masked} email address(es) in an edit in ${place.objectKey}`);
    const outcome = await this.outbox.perform(adapter, context, {
      key: `edit:${place.objectKey}:${input.ref}:${randomUUID()}`, purpose: input.forUser ? "user_reply" : "auto_reply", cardId: null,
      request: {
        action: "edit", objectKey: place.objectKey, target: found.target, text: message.text,
        ...("parts" in message && message.parts ? { parts: message.parts } : {}),
      },
    });
    if (outcome.status === "failed") {
      throw new ChannelActionError("outbound_failed", outcome.targetGone
        ? `消息 ${input.ref} 改不了了（被删了、不是用户的账号发的，或者过了工作区允许改的时间）：${outcome.error ?? "未知原因"}`
        : `没有改成：${outcome.error ?? "未知原因"}`);
    }
    this.log(`[channels] ${adapter.id}: edited message ${input.ref} in ${place.objectKey} (${input.by})`);
    return { conversation: conversationId, label: place.label, objectKey: place.objectKey, ref: input.ref, text: message.text };
  }

  /**
   * 代你在一条消息上回表情（2026-10-26）。缺省回对方在这个对话里最新的一条；seq 指定一条（事件编号）。
   * 回的是这个对话里等你的卡上最新的一条、你说话时见过它：卡结束成「已处理」。表情名不对时抛 invalid_action；
   * 对话、消息找不到时抛 not_found；发不出去时抛 outbound_failed。
   */
  async react(
    conversationId: string, input: { emoji: string; seq?: number; remove?: boolean; by: string; seenBefore?: number | null },
  ): Promise<ChannelReaction> {
    if (!new RegExp(CHANNEL_EMOJI_NAME_PATTERN).test(input.emoji)) {
      throw new ChannelActionError("invalid_action", `表情名不对：${input.emoji}。要写来源里的名字，不带冒号，例如 white_check_mark、+1`);
    }
    const source = conversationId.split(":")[0] ?? "";
    const adapter = this.options.registry.get(source);
    if (!adapter?.capabilities.react || !adapter.resolveConversation) throw new ChannelActionError("unavailable", `来源 ${source} 不能回表情`);
    const context = await this.context(adapter);
    if (!context) throw new ChannelActionError("unavailable", `来源 ${source} 现在没有接上`);
    let place;
    try {
      place = await adapter.resolveConversation(conversationId, context);
    } catch (error) {
      throw new ChannelActionError("not_found", errorText(error));
    }
    const row = input.seq !== undefined
      ? this.db.prepare(
        `SELECT seq FROM events WHERE seq = ? AND source = ? AND entity_key = ? AND json_valid(payload)
           AND json_extract(payload, '$.role') = 'message'`,
      ).get(input.seq, adapter.id, place.objectKey) as { seq: number } | undefined
      : this.db.prepare(
        `SELECT seq FROM events WHERE source = ? AND entity_key = ? AND json_valid(payload) AND json_extract(payload, '$.role') = 'message'
         ORDER BY seq DESC LIMIT 1`,
      ).get(adapter.id, place.objectKey) as { seq: number } | undefined;
    const event = row ? getEvent(this.db, row.seq) : undefined;
    const target = event ? messageRefOf(event.payload) : null;
    if (!event || !target) {
      throw new ChannelActionError("not_found", input.seq !== undefined
        ? `${place.label}里没有事件 #${input.seq} 这条对方的消息`
        : `${place.label}里还没有收到过对方的消息`);
    }
    // 每次一个新的幂等键：撤掉以后还能再回同一个（来源对重复的回表情、撤表情本来就是安全的）。
    const action = input.remove ? "unreact" : "react";
    const outcome = await this.outbox.perform(adapter, context, {
      key: `${action}:${event.seq}:${input.emoji}:${randomUUID()}`, purpose: "reaction", cardId: null,
      request: { action, objectKey: place.objectKey, target, emoji: input.emoji },
    });
    if (outcome.status === "failed") {
      throw new ChannelActionError("outbound_failed", `${input.remove ? "没有撤掉表情" : "没有回上表情"}：${outcome.error ?? "未知原因"}`);
    }
    this.log(`[channels] ${adapter.id}: ${input.remove ? "removed" : "reacted"} :${input.emoji}: on event #${event.seq} for the user (${input.by})`);
    const reacted = { conversation: conversationId, label: place.label, objectKey: place.objectKey, seq: event.seq, emoji: input.emoji };
    if (input.remove) return { ...reacted, card: null };
    const waiting = getOpenChannelCard(this.db, place.objectKey);
    if (!waiting || waiting.lastSeq !== event.seq) return { ...reacted, card: null };
    if (!this.seenBy(waiting, input.seenBefore)) {
      return { ...reacted, card: { id: waiting.id, state: waiting.state, note: `卡 #${waiting.id} 在你这一轮开始之后又来了新消息，没有结束` } };
    }
    // Lead 自己回的（不是用户这一轮）、这张卡派了活还没交回：表情回上了，卡等结果交回再结束（awaitingTask）。
    const task = input.by === "lead" ? this.awaitingTask(waiting.id) : null;
    if (task) return { ...reacted, card: { id: waiting.id, state: waiting.state, note: awaitingTaskNote(waiting.id, task) } };
    // 表情已经回过了：卡结束，不再回第二次。Lead 回的：这张卡上还没决定的请求记成「回了表情」（统一消息事件 spec D11）。
    if (input.by.startsWith("lead")) this.decidePending(waiting.id, "react", `回了表情 :${input.emoji}:`);
    const after = await this.act(waiting.id, "handled", { by: input.by, note: `回了表情 :${input.emoji}:`, react: false });
    return { ...reacted, card: { id: after.id, state: after.state } };
  }

  /**
   * Lead 读一个对话最近的消息（用户 2026-10-26：要能让 Lead 确认来源里的上下文）：从来源里现取，从旧到新，只读，
   * 不开卡、不触发判断。原文是不可信的外部文字，由 Lead 的工具包上标签。来源不能取历史时抛 unavailable；对话找不到时抛 not_found。
   */
  async readConversation(conversationId: string, limit = 20): Promise<ChannelConversationRead> {
    const source = conversationId.split(":")[0] ?? "";
    const adapter = this.options.registry.get(source);
    if (!adapter?.history || !adapter.capabilities.history || !adapter.resolveConversation) {
      throw new ChannelActionError("unavailable", `来源 ${source} 不能读对话的消息`);
    }
    const context = await this.context(adapter);
    if (!context) throw new ChannelActionError("unavailable", `来源 ${source} 现在没有接上`);
    let place;
    try {
      place = await adapter.resolveConversation(conversationId, context);
    } catch (error) {
      throw new ChannelActionError("not_found", errorText(error));
    }
    let messages;
    try {
      messages = await adapter.history({ objectKey: place.objectKey, limit: Math.min(Math.max(Math.floor(limit), 1), 50) }, context);
    } catch (error) {
      throw new ChannelActionError("unavailable", `没有读到${place.label}的消息：${errorText(error)}`);
    }
    const seqOf = this.db.prepare(
      `SELECT seq FROM events WHERE source = ? AND entity_key = ? AND json_valid(payload) AND json_extract(payload, '$.messageId') = ?
       ORDER BY seq LIMIT 1`,
    );
    return {
      conversation: conversationId, label: place.label, objectKey: place.objectKey,
      messages: messages.map((message) => ({
        at: message.at,
        ref: message.ref,
        seq: (seqOf.get(adapter.id, place.objectKey, message.ref) as { seq: number } | undefined)?.seq ?? null,
        role: message.role, sender: message.sender.name, text: clipEventText(message.text, TEXT_MAX),
        ...(message.thread ? { thread: message.thread } : {}),
      })),
    };
  }

  /**
   * Lead 取消息附带的一个文件（2026-11-02：别人发来的截图）。fileId 是正文里文件标记的文件编号（来源名:编号）。从来源里现取，
   * 只读，不告诉对方。内容是不可信的外部资料。来源不能取文件、没接上、取不到时抛 unavailable；编号不对、找不到时抛 not_found。
   */
  async readFile(fileId: string, maxBytes: number): Promise<ChannelFile> {
    const bar = fileId.indexOf(":");
    const source = bar < 0 ? "" : fileId.slice(0, bar);
    const adapter = this.options.registry.get(source);
    if (!adapter?.readFile) throw new ChannelActionError("unavailable", `来源 ${source || fileId} 不能取文件`);
    const context = await this.context(adapter);
    if (!context) throw new ChannelActionError("unavailable", `来源 ${source} 现在没有接上`);
    try {
      return await adapter.readFile(fileId.slice(bar + 1), { maxBytes }, context);
    } catch (error) {
      if (error instanceof ChannelFileNotFoundError) throw new ChannelActionError("not_found", error.message);
      throw new ChannelActionError("unavailable", `没有取到文件 ${fileId}：${errorText(error)}`);
    }
  }

  /**
   * 一个文件是哪条消息带来的（工单 #231：挂到工单上的附件要记来源）。在这个来源记过的消息里找正文带着这个文件标记的，
   * 取最新的一条：对话的称呼、消息在来源里的编号、发信人的称呼。没记过这条消息时返回 null。
   */
  fileOrigin(fileId: string): { conversation: string | null; message: string | null; sender: string | null } | null {
    const bar = fileId.indexOf(":");
    if (bar <= 0) return null;
    const row = this.db.prepare(
      "SELECT payload FROM events WHERE source = ? AND instr(payload, ?) > 0 ORDER BY seq DESC LIMIT 1",
    ).get(fileId.slice(0, bar), `文件编号 ${fileId}]`) as { payload: string } | undefined;
    if (!row) return null;
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(row.payload) as Record<string, unknown>;
    } catch {
      return null;
    }
    const sender = payload.sender && typeof payload.sender === "object" ? (payload.sender as Record<string, unknown>).name : null;
    const ref = messageRefOf(payload);
    return {
      conversation: typeof payload.laneLabel === "string" ? payload.laneLabel : null,
      message: ref ? Object.values(ref).join("/") : null,
      sender: typeof sender === "string" ? sender : null,
    };
  }

  /** 最近有动静的对话（道），最近的在前：给 Lead 翻对话列表用，只有结构化的事实。 */
  recentConversations(source: string | null, limit = 20): ChannelRecentConversation[] {
    return listRecentChannelLanes(this.db, Math.min(Math.max(Math.floor(limit), 1), 50), source ?? undefined)
      .map((lane) => ({ id: lane.objectKey, label: lane.label, updatedAt: lane.updatedAt, summary: lane.summary }));
  }

  /** 还在等你的卡（open、snoozed、replying_self），给 Lead 自查用：只有结构化的事实，没有原文。旧的在前。 */
  openCards(limit = 20): ChannelOpenCard[] {
    const states = CHANNEL_CARD_OPEN_STATES.map(() => "?").join(", ");
    const rows = this.db.prepare(`SELECT id FROM channel_cards WHERE state IN (${states}) ORDER BY id DESC LIMIT ?`)
      .all(...CHANNEL_CARD_OPEN_STATES, limit) as Array<{ id: number }>;
    return rows.reverse().flatMap(({ id }) => {
      const card = getChannelCard(this.db, id);
      if (!card) return [];
      const lane = getChannelLaneById(this.db, card.laneId);
      return [{
        id: card.id, sender: card.sender.name, conversation: lane?.label ?? card.objectKey, state: card.state,
        since: getEvent(this.db, card.lastSeq)?.occurredAt ?? card.updatedAt,
      }];
    });
  }

  // 卡上最新的消息你说话时见过没有：seenBefore 是你这一轮开始的时间，没有时（你自己在页面上做的）算见过。
  // 按消息在来源里发出的时间比：对方说这句话时你能在来源里看到。
  private seenBy(card: ChannelCard, seenBefore: number | null | undefined): boolean {
    if (seenBefore === undefined || seenBefore === null) return true;
    const latest = getEvent(this.db, card.lastSeq);
    const at = Date.parse(latest?.occurredAt ?? card.updatedAt);
    return Number.isFinite(at) && at < seenBefore;
  }

  /**
   * 「卡上的事做完了」时告诉对方：在卡上最新的一条消息上回表情。这个对话里在那条以后已经有你（或者系统代你）说的话时不回：
   * 回复本身就是回应。来源不能回表情时不回。回的表情名返回；没回时是 null。发不出去时抛 outbound_failed（卡不动）。
   */
  private async acknowledge(adapter: ChannelAdapter, card: ChannelCard, emoji: string): Promise<string | null> {
    if (!new RegExp(CHANNEL_EMOJI_NAME_PATTERN).test(emoji)) throw new ChannelActionError("invalid_action", `表情名不对：${emoji}`);
    if (!adapter.capabilities.react) return null;
    const lane = getChannelLaneById(this.db, card.laneId);
    const context = lane?.context ?? [];
    const index = context.findIndex((message) => message.seq === card.lastSeq);
    if (index >= 0 && context.slice(index + 1).some((message) => message.role !== "them")) return null;
    const event = getEvent(this.db, card.lastSeq);
    const target = event ? messageRefOf(event.payload) : null;
    const connection = await this.context(adapter);
    if (!target || !connection) return null;
    const outcome = await this.outbox.perform(adapter, connection, {
      key: `react:${card.lastSeq}:${emoji}`, purpose: "reaction", cardId: card.id,
      request: { action: "react", objectKey: card.objectKey, target, emoji },
    });
    if (outcome.status === "failed") throw new ChannelActionError("outbound_failed", `没有回上表情：${outcome.error ?? "未知原因"}`);
    return emoji;
  }

  /**
   * 这张卡上最新一条消息按交接说明的上限（issue 03）：Lead 改选过句子就按改选的（channel.situation.repicked）。
   * 不管 Lead 有没有决定过这条消息：派活以后交回的结果、Lead 后来的回复都按它。旧事件没有交接说明的结论时是 null（不限制）。
   */
  private replyCeilingOf(cardId: number): NonNullable<LeadRequest["handbook"]> | null {
    const request = this.leadRequestRows({ cardId, stage: "intake", undecided: false, newest: true })[0];
    if (!request) return null;
    const row = this.db.prepare(
      `SELECT payload FROM events WHERE source = 'system' AND kind = ? AND json_valid(payload)
         AND json_extract(payload, '$.cardId') = ? AND json_extract(payload, '$.forSeq') = ? ORDER BY seq DESC LIMIT 1`,
    ).get(CHANNEL_EVENT_KINDS.situationRepicked, cardId, request.forSeq) as { payload: string } | undefined;
    if (row) {
      const repicked = handbookOfCeiling(JSON.parse(row.payload) as Record<string, unknown>);
      if (repicked) return repicked;
    }
    return request.handbook;
  }

  // 连续对话（D2 的例外）：你本人或者 Lead 替你在这个对话里最近 30 分钟说过话（ownMessageAgoMs，同授权表的「接着回答你」）。
  private inConversation(adapter: ChannelAdapter, card: ChannelCard): boolean {
    const latest = getEvent(this.db, card.lastSeq);
    const ago = latest ? this.ownMessageAgoMs(adapter, latest) : null;
    return ago !== null && ago <= AUTHORITY_ANSWER_WINDOW_MS;
  }

  // Lead 的回复不能直接发（D2）：放到卡上当草稿，推送这张卡，告诉 Lead 下一步。不抛错：这是交接说明的正常结果，不是失败。
  private draftForUser(
    adapter: ChannelAdapter, card: ChannelCard, text: string, ceiling: NonNullable<LeadRequest["handbook"]>,
    sent: { conversation: string; label: string; objectKey: string },
  ): ChannelSentMessage {
    if (!text) throw new ChannelActionError("invalid_action", "回复是空的");
    this.updateDraftByLead(card.id, text);
    const why = `交接说明：按「${ceiling.situation.text}」，${HANDBOOK_MODE_LABELS[ceiling.final]}`;
    const note = clipEventText(`${why}。Lead 写的回复放在卡上，等你点发送`, 300);
    this.decidePending(card.id, "push", note);
    const after = getChannelCard(this.db, card.id)!;
    this.pushCard(adapter, after, "new", note);
    this.cardsChanged([card.id]);
    this.log(`[channels] ${adapter.id}: Lead's reply on card #${card.id} kept as a draft (${ceiling.final})`);
    return {
      ...sent, text, outcome: "drafted", reasons: [why],
      card: {
        id: after.id, state: after.state,
        note: `${why}：回复没有发出去，放到了卡 #${card.id} 上等用户点发送。下一步：在用户的对话里说一声卡上有你的草稿，不要换个办法再发；`
          + "认为句子选错了，用 repick_situation 改选一句并写理由",
      },
    };
  }

  /**
   * Lead 改选交接说明里的一句（repick_situation，用户 2026-10-30 定 D1，issue 03）：Lead 认为收件判断选错了句子时改选，要写理由。
   * 代码按新的一句重算上限，对方的上限和底线照样生效（同一个 decideByHandbook）。记一条 channel.situation.repicked：
   * 原来选的、改选的、理由和新的上限。以后这条消息的派活和 Lead 的回复都按新的上限。
   */
  leadRepick(eventSeq: number, input: { situation: string; reason: string }): ChannelLeadRepicked {
    const { card, adapter, event } = this.leadTarget(eventSeq);
    if (event.kind !== MESSAGE_EVENT_KIND) throw new ChannelActionError("invalid_action", `#${eventSeq} 不是交给你的消息事件，只能给消息事件改选句子`);
    const reason = clipEventText(input.reason.trim(), CHANNEL_CARD_NOTE_MAX);
    if (!reason) throw new ChannelActionError("invalid_action", "改选句子要写理由：为什么这条消息更像那一句");
    const forSeq = typeof event.payload.forSeq === "number" ? event.payload.forSeq : null;
    const source = forSeq === null ? null : getEvent(this.db, forSeq);
    const intake = forSeq === null ? null : this.intakeOf(adapter.id, forSeq);
    if (!source || !intake || intake.status !== "answered") {
      throw new ChannelActionError("unavailable", "这条消息没有收件判断，不能按交接说明重算：拟一份回复用 notify_user 交给用户");
    }
    const handbook = this.handbookNow();
    if (!handbook.situations.some((situation) => situation.id === input.situation)) {
      throw new ChannelActionError("invalid_action", `交接说明里没有「${input.situation}」。可选的有：${handbook.situations.map((situation) => `${situation.id}（${situation.text}）`).join("、")}`);
    }
    const decided = this.authorityFor(adapter, source, intake, input.situation)!.handbook;
    const before = this.replyCeilingOf(card.id);
    const at = this.now();
    this.db.transaction(() => appendEvent(this.db, {
      source: "system", kind: CHANNEL_EVENT_KINDS.situationRepicked, entityKey: card.objectKey, correlationId: `channel:${card.objectKey}`,
      level: "record", causationId: String(event.seq), occurredAt: at.toISOString(),
      payload: {
        channel: adapter.id, cardId: card.id, forSeq: source.seq, messageEvent: event.seq,
        from: before?.situation.id ?? null, to: decided.situation.id, reason,
        situation: decided.situation, mode: decided.mode, final: decided.final, by: decided.by, limit: decided.limit, abilities: decided.abilities,
        ...(decided.ruleChange ? { ruleChange: true } : {}),
        summary: `Lead 把卡 #${card.id} 改按「${decided.situation.text}」（原来按「${before?.situation.text ?? "没有"}」）：${reason}。`
          + `上限：${HANDBOOK_MODE_LABELS[decided.final]}`,
      },
    }))();
    this.cardsChanged([card.id]);
    const next = decided.final === "auto" ? "可以去做，做完直接回复对方"
      : decided.final === "review" ? "可以去做；你的回复会放到卡上，等用户点发送"
        : decided.final === "refuse" ? "只能用固定的话拒绝" : "不派活；拟一份回复用 notify_user 交给用户";
    return {
      cardId: card.id, situation: decided.situation, final: decided.final, by: decided.by, limit: decided.limit, abilities: decided.abilities,
      next: decided.by === "sentence" ? next : `被「${decided.limit ?? ""}」压过：${next}`,
    };
  }

  /**
   * Lead 告诉用户（通用工具 notify_user 带消息事件，统一消息事件 spec D6、D8，工单 05）：卡上放 Lead 写的草稿（drafter 是 lead，
   * 闲聊也要有），推送这张卡，note 是推送的正文。这张卡上还没决定的请求都记成 push。卡已经结束、草稿是空的时抛 invalid_action。
   */
  leadNotify(eventSeq: number, input: { note: string; draft: string }): ChannelCardDto {
    const { card, adapter } = this.leadTarget(eventSeq);
    if (!(CHANNEL_CARD_OPEN_STATES as readonly ChannelCardState[]).includes(card.state)) {
      throw new ChannelActionError("invalid_action", `卡 #${card.id} 已经结束（${cardStateLabel(card)}），不用再推给用户`);
    }
    if (!input.draft.trim()) throw new ChannelActionError("invalid_action", "推给用户时要带一份你写的草稿（draft）：用户改一改就能发");
    this.updateDraftByLead(card.id, input.draft);
    const note = clipEventText(input.note.trim() || "Lead 推送了这张卡", 300);
    this.decidePending(card.id, "push", note);
    const after = getChannelCard(this.db, card.id)!;
    this.pushCard(adapter, after, "new", note);
    return this.cardDto(after);
  }

  /**
   * Lead 记下怎么处理一条消息事件（通用工具 record_disposition，统一消息事件 spec D8、D11，工单 05）。卡跟着 Lead 的结论走：
   *   no_action 判断不用回：卡结束（不回），请求记成 no_reply；
   *   handled 自己处理了（例如照对方说的在别处做完了）：卡结束成「已处理」，缺省在对方的消息上回 ✅；
   *   told_user 在会话里告诉了用户：卡留着等用户，放上 Lead 写的草稿（必须带），请求记成 told；
   *   deferred：外部消息不能延后，抛 invalid_action。
   * 卡已经结束的只关掉还没决定的请求。消息事件记下同一个处置。
   */
  async leadDisposed(
    eventSeq: number, input: { disposition: "handled" | "told_user" | "no_action" | "deferred"; reason: string; draft?: string },
  ): Promise<ChannelLeadDisposed> {
    const { card, adapter, event } = this.leadTarget(eventSeq);
    if (input.disposition === "deferred") {
      throw new ChannelActionError("invalid_action", "外部消息不能延后：回复、回表情、派活、告诉用户（带你写的草稿），或者判断不用回（no_action）");
    }
    const reason = clipEventText(input.reason.trim() || "Lead 定的", CHANNEL_CARD_NOTE_MAX);
    const open = (CHANNEL_CARD_OPEN_STATES as readonly ChannelCardState[]).includes(card.state);
    // 派了活还没交回（工单 11 的真实回放：派完活接着记 handled，卡结束、回了 ✅，交回以后推不出去）：只记下 Lead 的处置，
    // 不结束卡，不回表情。子 agent 交回以后照常走出站检验。
    const task = open && input.disposition !== "told_user" ? this.awaitingTask(card.id) : null;
    if (task) {
      if (event.kind === MESSAGE_EVENT_KIND) {
        setEventDisposition(this.db, event.seq, input.disposition, { by: "lead", reason, cardId: card.id, awaitingTask: task.runId }, this.now());
      }
      return { cardId: card.id, state: card.state, note: `${awaitingTaskNote(card.id, task)}：这里只记下了你的处置，没有结束卡，也没有回表情` };
    }
    if (!open) {
      this.decidePending(card.id, "closed", `卡已经结束：${cardStateLabel(card)}`);
    } else if (input.disposition === "told_user") {
      if (!input.draft?.trim()) {
        throw new ChannelActionError("invalid_action", "告诉用户时要带一份你写的草稿（draft），闲聊也一样：用户改一改就能发");
      }
      this.updateDraftByLead(card.id, input.draft);
      this.decidePending(card.id, "told", reason);
    } else if (input.disposition === "no_action") {
      this.closeByLead(adapter, card, { by: "lead", action: "lead_no_reply", note: reason, disposition: "no_action" });
      this.decidePending(card.id, "no_reply", reason);
      await this.settleStatusNotices(card.id);
    } else {
      await this.act(card.id, "handled", { by: "lead", forUser: false, note: reason });
    }
    if (event.kind === MESSAGE_EVENT_KIND) {
      setEventDisposition(this.db, event.seq, input.disposition, { by: "lead", reason, cardId: card.id }, this.now());
    }
    const after = getChannelCard(this.db, card.id)!;
    return { cardId: after.id, state: after.state, note: open ? null : `卡 #${after.id} 已经结束（${cardStateLabel(after)}）` };
  }


  // 在卡上最新的一条消息上回表情，卡结束（handled）。回不上时抛 outbound_failed，卡不动。
  private async reactAndClose(
    adapter: ChannelAdapter, card: ChannelCard, input: { emoji: string; by: "lead" | "system"; action: string; note: string },
  ): Promise<void> {
    const event = getEvent(this.db, card.lastSeq);
    const target = event ? messageRefOf(event.payload) : null;
    const context = await this.context(adapter);
    if (!target || !context || !adapter.capabilities.react) {
      throw new ChannelActionError("unavailable", `卡 #${card.id} 的消息回不了表情（${!target ? "没有消息的引用" : "来源不能回表情或者没有接上"}）`);
    }
    const outcome = await this.outbox.perform(adapter, context, {
      key: `react:${card.lastSeq}:${input.emoji}`, purpose: "reaction", cardId: card.id,
      request: { action: "react", objectKey: card.objectKey, target, emoji: input.emoji },
    });
    if (outcome.status === "failed") throw new ChannelActionError("outbound_failed", `没有回上表情：${outcome.error ?? "未知原因"}`);
    this.closeByLead(adapter, card, { by: input.by, action: input.action, note: input.note, emoji: input.emoji, disposition: "handled" });
  }

  // Lead（或者兜底的系统）定完以后卡结束成 handled：账本记一条卡上的动作，卡的事件按 disposition 处理掉。
  private closeByLead(
    adapter: ChannelAdapter, card: ChannelCard,
    input: { by: "lead" | "system"; action: string; note: string; emoji?: string; disposition: EventDisposition },
  ): void {
    const now = this.now();
    const at = now.toISOString();
    const detail = { note: input.note, ...(input.emoji ? { emoji: input.emoji } : {}) };
    const closed = this.db.transaction(() => {
      const updated = updateChannelCard(this.db, card.id, {
        state: "handled", snoozedUntil: null, resolvedAt: at, resolution: { by: input.by, action: input.action, at, detail },
      }, { at: now });
      if (!updated) return null;
      appendEvent(this.db, {
        source: "system", kind: CHANNEL_EVENT_KINDS.cardAction, entityKey: card.objectKey, correlationId: `channel:${card.objectKey}`,
        level: "record", payload: {
          channel: adapter.id, cardId: card.id, action: input.action, by: input.by,
          summary: input.emoji ? `回了 :${input.emoji}:（${input.note}）` : `不回（${input.note}）`,
        },
      });
      this.disposeCardEvents(card, input.disposition, { by: input.by, action: input.action, cardId: card.id, ...detail });
      return updated;
    })();
    if (!closed) return;
    this.refreshLaneOf(closed);
    this.cardsChanged([closed.id]);
  }

  /**
   * Lead 不能工作时（统一消息事件 spec D7，工单 06）：系统只让你看到，不替 Lead 做决定，不对外发任何东西。还没有决定的请求的卡
   * 按投递方式推送（推送加会话卡的推一次，别的留在卡片列表里）；一次停摆里一个请求只推一次。请求留给 Lead：消息事件是 tell 级，
   * Lead 恢复以后按顺序处理。每一拍调用，也在交给 Lead 的时候调用（pushIfLeadDown）。Lead 能工作时清掉推过的记录。
   */
  private pushWhileLeadDown(): void {
    if (!this.options.lead) return;
    if (this.leadAvailable()) {
      this.pushedWhileDown.clear();
      return;
    }
    for (const request of this.leadRequests()) this.pushLeadRequest(request);
  }

  // 交给 Lead 的时候 Lead 不能工作：马上按投递方式推送，不等下一拍。
  private pushIfLeadDown(adapter: ChannelAdapter, stage: ChannelLeadStage, forSeq: number): void {
    if (!this.options.lead || this.leadAvailable()) return;
    const request = this.leadRequestAt(stage, forSeq);
    if (request && request.channel === adapter.id) this.pushLeadRequest(request);
  }

  private pushLeadRequest(request: LeadRequest): void {
    const key = `${request.stage}:${request.forSeq}`;
    if (this.pushedWhileDown.has(key)) return;
    const adapter = this.options.registry.get(request.channel);
    const card = getChannelCard(this.db, request.cardId);
    // 稍后提醒的到点再推；你在来源里回过一句的不再推（和卡的推送规则一样）。
    if (!adapter || card?.state !== "open") return;
    this.pushedWhileDown.add(key);
    if (card.delivery === "push_card") this.pushCard(adapter, card, "new");
  }

  /**
   * 子 agent 工单结束（C 的派单器按回调 channel 交回，不叫醒 Lead）：通道的 ⑦。请求 B 看结果、做完的动作和核实过的出处，
   * 信心模型决定：代你回（改写「正在处理」那一条），或者问你、交给你（B4：交回 Lead）。approve 的批准由 GitHub 工具的规矩做了，
   * 这里只决定那句回复，按代码 review 的门槛算。
   */
  agentTaskFinished(outcome: AgentTaskOutcome): void {
    this.later(() => this.finishAgentTask(outcome), `agent task #${outcome.runId}`);
  }

  private async finishAgentTask(outcome: AgentTaskOutcome): Promise<void> {
    const match = /^card:(\d+):seq:(\d+)$/.exec(outcome.callback.ref);
    if (outcome.callback.kind !== CHANNEL_TASK_CALLBACK || !match) return;
    const cardId = Number(match[1]);
    const forSeq = Number(match[2]);
    const db = this.db;
    const card = getChannelCard(db, cardId);
    const adapter = card ? this.options.registry.get(card.source) : undefined;
    const event = getEvent(db, forSeq);
    if (!card || !adapter || !event) return;
    const ref = `channel-task-finished:${outcome.runId}`;
    if (db.prepare("SELECT 1 FROM events WHERE source = 'system' AND source_ref = ?").get(ref)) return;
    const result = outcome.status === "finished" ? outcome.result : null;
    const visible = outcome.actions.filter((action) => action.visible);
    const draftText = result?.replyDraft.trim() ?? "";
    const files = (result?.sources ?? []).filter((source): source is LookupSource => source.via !== "connection");
    const connections = (result?.sources ?? []).filter((source): source is ConnectionSource => source.via === "connection");
    let check: ChannelReplyCheckResult | null = null;
    if (result && result.found !== "no" && (draftText || result.answer.trim())) {
      check = await judgeReplyCheck({
        question: typeof event.payload.text === "string" ? event.payload.text : card.excerpt,
        result: { found: result.found, answer: result.answer, sources: files, checked: result.checked, caveats: result.caveats, replyDraft: result.replyDraft },
        reads: outcome.reads, model: this.smartModelNow(),
        actions: visible.map((action) => `${action.summary}${action.url ? `（${action.url}）` : ""}`),
        connectionQuotes: connections.filter((source) => source.verified).map((source) => ({ connection: source.connection, tool: source.tool, quote: source.quote })),
        timeoutMs: Math.max(this.options.replyCheckTimeoutMs ?? CHANNEL_REPLY_CHECK_TIMEOUT_MS, 1),
      });
    }
    const fresh = getChannelCard(db, cardId) ?? card;
    // 意图按工单的清单（派的时候定的）。approve 的回复只报告做完的事：按代码 review 算。
    const intent: ChannelIntent = outcome.grant.intent === "approve" ? "code_review" : outcome.grant.intent;
    const writes = intent === "code_review" ? visible.length : 0;
    const total = files.length + connections.length + writes;
    const verified = files.filter((source) => source.verified).length + connections.filter((source) => source.verified).length + writes;
    const scored = this.replyDecisionFor(adapter, fresh, forSeq, intent, check, {
      found: result ? result.found : "failed", sources: { total, verified }, actions: visible.length, draft: draftText,
    });
    const gate = scored.gate;
    const at = this.now();
    const open = (CHANNEL_CARD_OPEN_STATES as readonly ChannelCardState[]).includes(fresh.state);
    // 没代你回、卡还开着：这一条交回 Lead（B4，统一消息事件工单 05），它就是交给 Lead 的请求。
    const back = open && !(gate.decision === "auto_send" && draftText)
      ? this.handBack(fresh, forSeq, { intent: outcome.grant.intent, decision: gate.decision, reason: gate.reasons.join("；") || "信心不够" })
      : null;
    const recorded = db.transaction(() => {
      const { inserted } = appendEvent(db, {
        source: "system", sourceRef: ref, kind: CHANNEL_EVENT_KINDS.taskFinished, entityKey: fresh.objectKey,
        correlationId: `channel:${fresh.objectKey}`, level: back?.level ?? "record", causationId: String(forSeq), occurredAt: at.toISOString(),
        payload: {
          channel: adapter.id, cardId, forSeq, runId: outcome.runId, itemId: outcome.itemId, status: outcome.status,
          decision: gate.decision, confidence: gate.confidence, threshold: gate.threshold, actions: visible.length, ...back?.fields,
          summary: `通道卡 #${cardId} 的子 agent 工单 #${outcome.itemId} ${outcome.status === "finished" ? "结束了" : outcome.status === "failed" ? "失败了" : "被停掉了"}`
            + `${visible.length ? `，做了 ${visible.length} 个别人看得到的动作` : ""}；回复：${replySummary(gate.decision, fresh.sender.name, gate.reasons)}`
            + (back?.next ? `。${back.next}` : ""),
        },
      });
      if (!inserted) return false;
      const row = getLatestLookupForCard(db, cardId);
      if (row && row.runId === outcome.runId) {
        const state = outcome.status === "finished" ? "finished" : outcome.status;
        updateChannelLookup(db, row.id, {
          state, finishedAt: at.toISOString(),
          result: result ? {
            found: result.found, answer: result.answer, sources: files, checked: result.checked, caveats: result.caveats,
            replyDraft: result.replyDraft, connectionSources: connections,
            actions: outcome.actions.map((action) => ({ summary: action.summary.slice(0, 300), url: action.url, visible: action.visible })),
          } : null,
          reads: outcome.reads,
          verification: {
            sources: { total, verified }, replyCheck: check ? {
              ok: check.ok, fulfillsRequest: check.fulfillsRequest, grounded: check.grounded, draftCommits: check.draftCommits,
              draftOvershares: check.draftOvershares, error: check.error ? clipEventText(redactSecretText(check.error), 300) : null,
            } : null,
            confidence: gate.confidence, threshold: gate.threshold, calibration: gate.calibration, checks: gate.checks, vetoes: gate.vetoes,
            error: outcome.error ? clipEventText(redactSecretText(outcome.error), 300) : null, at: at.toISOString(),
          },
          reply: { decision: gate.decision, reasons: gate.reasons, order: channelAuthorityTable(db, adapter.id)?.order ?? AUTHORITY_ORDER, at: at.toISOString(), choice: null },
        }, { at });
      }
      if (open && draftText && gate.decision !== "hand_over") {
        const withDraft = updateChannelCard(db, cardId, {
          draft: { text: draftText.slice(0, CHANNEL_CARD_TEXT_MAX), drafter: "agent", templateId: null, slots: {}, at: at.toISOString(), forSeq: fresh.lastSeq },
        }, { at });
        if (withDraft) this.recordScored(withDraft, forSeq, "task", intent, scored, at);
      }
      return true;
    })();
    if (!recorded) return;
    this.cardsChanged([cardId]);
    const latest = getChannelCard(db, cardId);
    if (!latest || !(CHANNEL_CARD_OPEN_STATES as readonly ChannelCardState[]).includes(latest.state)) return;
    if (gate.decision === "auto_send" && latest.draft) {
      await this.sendReply(adapter, latest, "auto_reply", {
        revokeWindowMs: AUTHORITY_REVOKE_WINDOW_MS,
        outgoing: {
          key: `task:card:${latest.id}:run:${outcome.runId}`, by: "auto", fromDraft: true,
          ...autoReplyDisclosure(this.assistantFor(adapter), this.ownerNameFor(adapter), latest.draft.text),
        },
      });
      this.cardsChanged([latest.id]);
      await this.settleStatusNotices(latest.id);
      return;
    }
    // 交给你（没有回复）：「正在处理」删掉；等你确认的草稿留着它，你发出时改写它。没有草稿时由 Lead 写（notify_user 带的草稿）。
    await this.settleStatusNotices(cardId);
    // B4：问你、交给你都交回 Lead（上面记的 channel.task.finished），由 Lead 决定怎么告诉你。Lead 不能工作时按投递方式推送。
    if (back) this.pushIfLeadDown(adapter, "reply", forSeq);
  }

  /**
   * 子 agent 工单的结果交回 Lead（B4，统一消息事件工单 05，取代 reply 这一步的 channel.lead.requested）：channel.task.finished
   * 带上 handedBack 和这张卡的消息事件，就是交给 Lead 的请求。tell 级，Lead 单独一轮看到它；Lead 不能工作时也是 tell 级
   * （恢复以后处理，工单 06），没有期限。没有接 Lead 时照旧只记录。next 是给 Lead 的说明（结论、能用的通用工具）。
   */
  private handBack(card: ChannelCard, forSeq: number, input: { intent: string; decision: string; reason: string }):
    { level: "record" | "tell"; fields: Record<string, unknown>; next: string } {
    if (!this.options.lead) return { level: "record", fields: {}, next: "" };
    const event = this.messageEventOf(card.id, forSeq);
    const verdict = input.decision === "hand_over" ? "交给用户" : "问用户";
    const next = `结论是${verdict}（${input.reason}）。${event ? `消息事件 #${event}：用 read_channel_conversation（event=${event}）看子 agent 查到的；` : ""}`
      + `要用户决定的用 notify_user${event ? `（event=${event}）` : ""}推给他，带你按查到的事实写的草稿；`
      + `你有把握的用 reply_to_source${event ? `（event=${event}，conversation=${this.replyConversationOf(event) ?? card.objectKey}）` : ""}回复`;
    return { level: "tell", fields: { handedBack: true, messageEvent: event, intent: input.intent, reason: input.reason }, next };
  }

  // 一条消息事件回复到哪个对话（reply_to_source 的 conversation 要填的）。
  private replyConversationOf(eventSeq: number): string | null {
    const event = getEvent(this.db, eventSeq);
    return event ? messageEventConversationKey(event.payload) : null;
  }

  // 这张卡的消息事件（Lead 的通用工具按它找卡）：先找这条消息的，没有时用这张卡最新的。并进编辑被取代的不算。
  private messageEventOf(cardId: number, forSeq: number): number | null {
    const row = this.db.prepare(
      `SELECT seq FROM events WHERE source = 'system' AND kind = ? AND json_valid(payload) AND json_extract(payload, '$.cardId') = ?
         AND (disposition IS NULL OR disposition <> 'superseded')
       ORDER BY (json_extract(payload, '$.forSeq') = ?) DESC, seq DESC LIMIT 1`,
    ).get(MESSAGE_EVENT_KIND, cardId, forSeq) as { seq: number } | undefined;
    return row?.seq ?? null;
  }

  // ⑦ 的信心模型：一份子 agent 的草稿交给信心模型，结论写成卡上的形状。
  private replyDecisionFor(
    adapter: ChannelAdapter, card: ChannelCard, forSeq: number, intent: ChannelIntent, check: ChannelReplyCheckResult | null,
    facts: { found: ConfidenceModelInput["found"]; sources: { total: number; verified: number }; actions: number; draft?: string },
  ): ScoredDraft {
    const intake = this.intakeOf(adapter.id, forSeq);
    const number = (value: unknown) => (typeof value === "number" ? value : null);
    const sender = getEvent(this.db, forSeq)?.payload.sender as { bot?: unknown } | undefined;
    return this.scoreDraft(adapter.id, {
      intent: { kind: intent, closing: null },
      draft: (facts.draft ?? card.draft?.text ?? "").trim().length > 0,
      found: facts.found,
      scores: {
        needsReply: number(intake?.needsReply), askConfidence: number(intake?.askConfidence),
        fulfills: check?.ok ? check.fulfillsRequest : null, grounded: check?.ok ? check.grounded : null,
        draftCommits: check?.ok ? check.draftCommits : null, draftOvershares: check?.ok ? check.draftOvershares : null,
        topics: (intake?.topics ?? {}) as Record<string, number>, sensitiveQueries: (intake?.sensitive ?? null) as Record<string, number> | null,
        ruleChange: number(intake?.ruleChange),
      },
      facts: {
        audience: this.audienceOf(forSeq), members: null,
        externalShared: this.externalSharedOf(forSeq), senderTrust: card.sender.trust,
        bot: sender?.bot === true, scoredBy: check?.ok && check.backend !== LLM_BACKEND ? "jev" : "fallback",
        retractable: facts.actions === 0 && adapter.capabilities.retract, canReply: adapter.capabilities.reply, sources: facts.sources,
        newerMessages: this.newerMessages({ source: adapter.id, objectKey: card.objectKey, forSeq }), resultAgeMs: 0,
        cardOpen: (CHANNEL_CARD_OPEN_STATES as readonly ChannelCardState[]).includes(card.state), approval: null,
      },
    });
  }

  /**
   * 信心模型给一份要代你发的草稿打分（落地计划 A6、D2）：按这个来源带标签的样本校准（不分任务）；
   * 本该代你发的按比例抽查，照样放到卡上问你，原因里写明是抽查。
   */
  private scoreDraft(channel: string, input: Omit<ConfidenceModelInput, "calibration">): ScoredDraft {
    const params = this.confidenceParamsFor(channel);
    const model = evaluateConfidenceModel({ ...input, calibration: channelCalibration(this.db, channel) }, params);
    const gate = channelReplyDecision(model, params);
    const rate = this.options.audit?.rate ?? CHANNEL_REPLY_AUDIT_RATE;
    if (!auditsReply(model.decision, rate, this.options.audit?.random ?? Math.random)) return { input, model, decision: model.decision, gate, audit: false };
    const why = `抽查：信心够代你发，这次照样放到卡上问你（抽 ${Math.round(rate * 100)}%），你怎么做就是高分段的标签`;
    return { input, model, decision: "ask_user", gate: { ...gate, decision: "ask_user", reasons: [why, ...gate.reasons] }, audit: true };
  }

  // 这个来源的自动代你处理（常设指令 channel.authority：开关、授权表、信心模型的参数，2026-10-23）。读不到时用代码里的缺省。
  private policyFor(channel: string): ChannelPolicyParams {
    return channelPolicy(this.db, channel)?.params ?? CHANNEL_POLICY_DEFAULTS;
  }

  private confidenceParamsFor(channel: string, policy: ChannelPolicyParams = this.policyFor(channel)): ConfidenceModelParams {
    return confidenceParamsFrom(policy, this.noReplyBelowOption === undefined ? {} : { noReplyBelow: this.noReplyBelowOption });
  }

  /**
   * 测一条消息（设置 → 消息通道，操作层的 channel_policy.test）：请求 A、B 真的给这条消息打分，再按给的参数算结论。
   * 只读，不开卡，不发任何东西。上一次的分数换参数再算由操作层直接算，不经过这里。
   */
  async testPolicy(source: string, request: ChannelPolicyTestRequest): Promise<ChannelPolicyTestResult> {
    const params = this.confidenceParamsFor(source, request.params ?? this.policyFor(source));
    const testCase = request.case;
    if (testCase.kind !== "message") {
      return judgePolicyCase(testCase.scored, params, channelCalibration(this.db, source));
    }
    let businessMap: string | null = null;
    try {
      businessMap = findNoteByTitle(this.db, BUSINESS_MAP_NOTE_TITLE, "fact")?.content ?? null;
    } catch (reason) {
      this.log(`[channels] could not read the business map: ${errorText(reason)}`);
    }
    const outcome = await scoreTestMessage({
      text: testCase.text, audience: testCase.audience, sender: testCase.sender, draft: testCase.draft ?? "", assumeFound: testCase.assumeFound,
      model: this.smartModelNow(), candidates: this.candidates(), userName: this.ownerNames.get(source) ?? null, businessMap,
      handbook: this.handbookNow(), timeoutMs: Math.max(this.options.intakeTimeoutMs ?? CHANNEL_INTAKE_TIMEOUT_MS, 1),
      textModel: this.textModelNow(),
    });
    return judgePolicyCase(outcome.scored, params, channelCalibration(this.db, source), outcome.error, outcome.calls);
  }

  /**
   * 预演一条消息（设置 → 消息通道 → 自动代你处理，操作层的 channel_handbook.rehearse，issue 07）：收件判断真的选一句，
   * 再用和真的消息一样的 decideByHandbook 算结论。假设是私信、能回复和回表情、对方的话要回；对方是外部的人时按外部共享的对话。
   * 只读：不开卡，不交给 Lead，不发任何东西。收件判断不可用时按兜底的一句算，写明没有判断成。
   */
  async rehearseHandbook(request: HandbookRehearsalRequest): Promise<HandbookRehearsal> {
    const handbook = request.handbook ?? this.handbookNow();
    let businessMap: string | null = null;
    try {
      businessMap = findNoteByTitle(this.db, BUSINESS_MAP_NOTE_TITLE, "fact")?.content ?? null;
    } catch (reason) {
      this.log(`[channels] could not read the business map: ${errorText(reason)}`);
    }
    const started = Date.now();
    const intake = await judgeChannelIntake({
      intake: { text: request.text, recent: [], senderTrust: request.sender, laneLabel: "私信", businessMap, candidates: this.candidates(), handbook },
      model: this.smartModelNow(),
      timeoutMs: Math.max(this.options.intakeTimeoutMs ?? CHANNEL_INTAKE_TIMEOUT_MS, 1),
      text: this.textModelNow(),
    });
    const situation = handbook.situations.find((candidate) => candidate.id === intake.situation) ?? null;
    const decided = decideByHandbook({
      situation, handbook, borrowed: intake.borrowed, ruleChange: intake.ruleChange,
      closing: intake.closing, reaction: intake.reaction, needsReply: intake.needsReply,
      sensitive: Object.keys(intake.sensitive).length ? intake.sensitive : null,
      sender: { trust: request.sender, bot: false }, externalShared: request.sender === "external",
      audience: "direct", capabilities: { reply: true, react: true }, reactable: true, ownMessageAgoMs: null,
      ...(this.noReplyBelowOption !== undefined ? { noReplyBelow: this.noReplyBelowOption } : {}),
    });
    return {
      status: intake.status, situation: decided.situation, picked: intake.situation, mode: decided.mode, final: decided.final, by: decided.by,
      phrase: situation ? handbookModePhrase(situation, decided.mode, "zh") : HANDBOOK_MODE_PHRASES[decided.mode], ruleChange: decided.ruleChange,
      limit: decided.limit, abilities: decided.abilities, exception: decided.exception, action: decided.action.kind, reason: decided.action.reason,
      backend: intake.backend, model: intake.model, ms: Math.max(0, Date.now() - started),
      error: intake.error ? clipEventText(redactSecretText(intake.error), 300) : null,
    };
  }

  /**
   * 过去 24 小时的消息（设置 → 消息通道，操作层的 channel_policy.replay，2026-10-24 用户）：请求 A 用当时的结果；
   * 卡上有草稿的，草稿的分数用打分时记下的，没记下的现在调请求 B（按「没有查过材料」打，并发 4 个，一次最多
   * CHANNEL_POLICY_REPLAY_MAX_CALLS 次，调成的留在内存里，换参数再算时不再调）。按现在生效的和给的两份参数各算一遍。
   * 只读，不开卡，不发任何东西。
   */
  async replayPolicy(source: string, before: ChannelPolicyParams, after: ChannelPolicyParams): Promise<ChannelPolicyReplayResult> {
    const until = this.now();
    const since = new Date(until.getTime() - CHANNEL_POLICY_REPLAY_HOURS * 3_600_000);
    const messages = pastChannelMessages(this.db, source, since, until);
    const model = this.smartModelNow();
    const timeoutMs = Math.max(this.options.replyCheckTimeoutMs ?? CHANNEL_REPLY_CHECK_TIMEOUT_MS, 1);
    const keyOf = (message: PastChannelMessage) => `${source}:${message.cardId}:${message.draft!.at}`;
    const toCall = messages.filter((message) => message.draft && !message.recorded && !this.replyChecks.has(keyOf(message)))
      .slice(0, CHANNEL_POLICY_REPLAY_MAX_CALLS);
    const failed = new Set<PastChannelMessage>();
    const called = new Set<PastChannelMessage>();
    let next = 0;
    const worker = async () => {
      while (next < toCall.length) {
        const message = toCall[next++]!;
        called.add(message);
        const check = await judgeReplyCheck({
          question: message.scored.text, result: draftOnlyResult(message.draft!.text), lookedUp: false, model, timeoutMs,
        });
        if (!check.ok) {
          failed.add(message);
          continue;
        }
        this.replyChecks.set(keyOf(message), check);
        while (this.replyChecks.size > REPLY_CHECK_CACHE_MAX) this.replyChecks.delete(this.replyChecks.keys().next().value!);
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, toCall.length) }, worker));
    const judged = judgePastMessages(messages.map((message) => {
      if (!message.draft) return { message, draft: null, scoring: "no_draft" as const };
      if (message.recorded) return { message, draft: message.recorded, scoring: "recorded" as const };
      const check = this.replyChecks.get(keyOf(message));
      const draft: DraftScores | null = check ? {
        fulfills: check.fulfillsRequest, grounded: check.grounded, draftCommits: check.draftCommits, draftOvershares: check.draftOvershares,
        scoredBy: check.backend !== LLM_BACKEND ? "jev" : "fallback",
      } : null;
      const scoring = failed.has(message) ? "failed" as const : !check ? "skipped" as const : called.has(message) ? "called" as const : "cached" as const;
      return { message, draft, scoring };
    }), this.confidenceParamsFor(source, before), this.confidenceParamsFor(source, after), channelCalibration(this.db, source));
    return { since: since.toISOString(), until: until.toISOString(), ...judged, calls: called.size, failed: failed.size };
  }

  /**
   * 记下信心模型给卡上这份草稿打的分（落地计划 D2）：卡上的分数面板读它，你后来的做法是它的标签。同一份草稿只记一次。
   * 记不成（例如形状不对）时改记一条被拒的事件，不影响调用方的写入。调用方负责事务。
   */
  private recordScored(
    card: ChannelCard, forSeq: number, draftKind: ChannelReplyDraftKind, intent: ChannelIntent | null, scored: ScoredDraft, at: Date,
  ): void {
    const draft = card.draft;
    if (!draft) return;
    const { gate, model, audit } = scored;
    appendEventGuarded(this.db, () => ({
      source: "system", sourceRef: `channel-scored:${card.id}:${draft.at}`, kind: CHANNEL_EVENT_KINDS.replyScored,
      entityKey: card.objectKey, correlationId: `channel:${card.objectKey}`, level: "record", causationId: String(forSeq),
      occurredAt: at.toISOString(),
      payload: {
        channel: card.source, cardId: card.id, forSeq, intent, draftKind, decision: gate.decision, audit, input: scoredInputRecord(scored.input),
        raw: model.raw, confidence: gate.confidence, threshold: gate.threshold, calibration: gate.calibration,
        checks: gate.checks, vetoes: gate.vetoes, reasons: gate.reasons.slice(0, 12).map((reason) => clipEventText(reason, 300)),
        draftAt: draft.at,
        summary: `通道卡 #${card.id} 的草稿打了分${audit ? "（抽查）" : ""}：${replySummary(gate.decision, card.sender.name, gate.reasons)}`,
      },
    }));
  }

  /** 卡上最新的一次打分（channel.reply.scored）。 */
  private latestScoreOf(card: ChannelCard): { seq: number; payload: Record<string, unknown> } | null {
    const row = this.db.prepare(
      `SELECT seq, payload FROM events WHERE entity_key = ? AND kind = ? AND source = 'system' AND json_valid(payload)
         AND json_extract(payload, '$.cardId') = ?
       ORDER BY seq DESC LIMIT 1`,
    ).get(card.objectKey, CHANNEL_EVENT_KINDS.replyScored, card.id) as { seq: number; payload: string } | undefined;
    if (!row) return null;
    try {
      return { seq: row.seq, payload: JSON.parse(row.payload) as Record<string, unknown> };
    } catch {
      return null;
    }
  }

  /**
   * 给卡上最新的一次打分记标签（落地计划 D2，calibration.ts）：你在来源里实际做了什么。一次打分只记一个标签（幂等键是打分的编号），
   * 没有打过分、已经有标签时什么也不做。照发的不是打过分的那份草稿时，算自己写了别的；撤回只算在代你发了的打分上。
   * 调用方负责事务。
   */
  private labelReply(card: ChannelCard, label: ChannelReplyLabel, at: Date, sentDraftAt: string | null = null): void {
    this.labelHandbookDraft(card, label, at, sentDraftAt);
    const scored = this.latestScoreOf(card);
    if (!scored) return;
    if (label === "retracted" && scored.payload.decision !== "auto_send") return;
    const final: ChannelReplyLabel = label === "sent_as_is" && scored.payload.draftAt !== sentDraftAt ? "rewritten" : label;
    const rule = CHANNEL_REPLY_LABEL_RULES[final];
    const raw = scored.payload.raw;
    appendEventGuarded(this.db, () => ({
      source: "system", sourceRef: `channel-label:${scored.seq}`, kind: CHANNEL_EVENT_KINDS.replyLabeled,
      entityKey: card.objectKey, correlationId: `channel:${card.objectKey}`, level: "record", causationId: String(scored.seq),
      occurredAt: at.toISOString(),
      payload: {
        channel: card.source, cardId: card.id, scoredSeq: scored.seq, label: final, value: rule.value, weight: rule.weight,
        bucket: typeof raw === "number" ? replyConfidenceBucket(raw) : null,
        summary: `通道卡 #${card.id} 的草稿：${rule.words}`,
      },
    }));
  }

  /**
   * 交接说明的草稿（issue 08，页边批注的「放宽」）：卡上这份草稿回的那条消息按交接说明是「做好给你看」或「交给你」时，
   * 记下你做了什么。和信心模型的标签分开记：Lead 自己的回复放到卡上时（D2）不打分。一份草稿只记一次。调用方负责事务。
   */
  private labelHandbookDraft(card: ChannelCard, label: ChannelReplyLabel, at: Date, sentDraftAt: string | null): void {
    const draft = card.draft;
    if (!draft || (label !== "sent_as_is" && label !== "rewritten")) return;
    const decided = handbookDecisionFor(this.db, card.id, draft.forSeq);
    if (!decided || (decided.final !== "review" && decided.final !== "hand")) return;
    const final: ChannelReplyLabel = label === "sent_as_is" && sentDraftAt !== draft.at ? "rewritten" : label;
    appendEventGuarded(this.db, () => ({
      source: "system", sourceRef: `channel-handbook-label:${card.id}:${draft.at}`, kind: CHANNEL_EVENT_KINDS.handbookDraftLabeled,
      entityKey: card.objectKey, correlationId: `channel:${card.objectKey}`, level: "record", causationId: String(draft.forSeq),
      occurredAt: at.toISOString(),
      payload: {
        channel: card.source, cardId: card.id, forSeq: draft.forSeq, draftAt: draft.at, ...decided, label: final,
        summary: `通道卡 #${card.id} 的草稿（交接说明「${decided.situation}」，${decided.final}）：${final === "sent_as_is" ? "原样发了" : "改了再发或者自己回了"}`,
      },
    }));
  }

  /**
   * 每一拍（落地计划 D2，最多一分钟一次）：卡上的按钮没有当场定下标签的打分，等卡结束以后按你在来源里的做法定
   * （calibration.ts 的 settledReplyLabel）。只看每张卡最新的、最近 14 天的打分；有界、幂等。
   */
  private labelSettledReplies(): void {
    const now = this.now();
    if (now.getTime() - this.labeledAt < 60_000) return;
    this.labeledAt = now.getTime();
    const db = this.db;
    const rows = db.prepare(
      `SELECT s.seq, s.payload, s.occurred_at AS at FROM events s
       WHERE s.kind = ? AND s.source = 'system' AND s.occurred_at >= ? AND json_valid(s.payload)
         AND NOT EXISTS (SELECT 1 FROM events l WHERE l.source = 'system' AND l.source_ref = 'channel-label:' || s.seq)
         AND NOT EXISTS (SELECT 1 FROM events n WHERE n.entity_key = s.entity_key AND n.kind = s.kind AND n.seq > s.seq
           AND json_valid(n.payload) AND json_extract(n.payload, '$.cardId') = json_extract(s.payload, '$.cardId'))
       ORDER BY s.seq LIMIT 200`,
    ).all(CHANNEL_EVENT_KINDS.replyScored, new Date(now.getTime() - 14 * DAY_MS).toISOString()) as Array<{ seq: number; payload: string; at: string }>;
    const settleMs = this.options.labelSettleMs ?? CHANNEL_REPLY_LABEL_SETTLE_MS;
    for (const row of rows) {
      try {
        const payload = JSON.parse(row.payload) as { cardId?: unknown; forSeq?: unknown; decision?: unknown };
        const card = typeof payload.cardId === "number" ? getChannelCard(db, payload.cardId) : undefined;
        if (!card || typeof payload.forSeq !== "number" || !(CHANNEL_REPLY_DECISIONS as readonly unknown[]).includes(payload.decision)) continue;
        const resolvedAt = card.resolvedAt ? dbTime(card.resolvedAt) : null;
        const selfReplies = (db.prepare(
          `SELECT COUNT(*) AS n FROM events WHERE source = ? AND entity_key = ? AND seq > ? AND occurred_at <= ?
             AND json_valid(payload) AND json_extract(payload, '$.role') = 'self_reply'`,
        ).get(card.source, card.objectKey, payload.forSeq, new Date((resolvedAt ?? now.getTime()) + settleMs).toISOString()) as { n: number }).n;
        const label = settledReplyLabel({
          decision: payload.decision as ChannelReplyDecision, scoredAt: dbTime(row.at) ?? now.getTime(),
          card: {
            open: (CHANNEL_CARD_OPEN_STATES as readonly ChannelCardState[]).includes(card.state),
            autoReplied: card.state === "auto_replied" && card.sent?.by === "auto",
            revokeUntil: card.revokeUntil ? dbTime(card.revokeUntil) : null,
            userSent: card.state === "replied", resolvedAt,
          },
          selfReplies, now: now.getTime(), settleMs,
        });
        if (label) db.transaction(() => this.labelReply(card, label, now))();
      } catch (error) {
        this.log(`[channels] could not label the score #${row.seq}: ${errorText(error)}`);
      }
    }
  }

  // ── 卡上的动作 ────────────────────────────────────────────────────────────────────

  /**
   * 用户在卡上的一个动作。by 是「user via <设备>」。text 是用户自己写的文字（「改一下再发」带它，网关已经校验过）。
   * 不合规时抛 ChannelActionError。
   */
  async act(
    cardId: number, action: ChannelCardAction,
    options: { by: string; forUser?: boolean; expectedVersion?: number; text?: string; note?: string; emoji?: string; react?: boolean },
  ): Promise<ChannelCard> {
    const card = getChannelCard(this.db, cardId);
    if (!card) throw new ChannelActionError("not_found", `没有通道卡 #${cardId}`);
    if (options.expectedVersion !== undefined && options.expectedVersion !== card.version) {
      throw new ChannelActionError("conflict", `卡 #${cardId} 已经变了（现在是第 ${card.version} 版），刷新后再操作`);
    }
    const adapter = this.options.registry.get(card.source);
    if (!adapter) throw new ChannelActionError("unavailable", `来源 ${card.source} 现在没有接上`);
    const allowed = this.actionsFor(card, adapter);
    if (!allowed.includes(action)) {
      throw new ChannelActionError("invalid_action", `卡 #${cardId} 现在（${card.state}）不能做 ${action}`);
    }
    // Lead 不在你这一轮里点的发送（forUser 是 false）：是 Lead 自己的回复，和往对话发消息一样走 leadReply（统一消息事件 spec D8、D9：
    // Lead 用哪个工具都一样）。缺省是你本人（页面）。
    if ((action === "send_draft" || action === "send_edited") && options.forUser === false) {
      const text = action === "send_draft" ? card.draft?.text ?? "" : options.text?.trim() ?? "";
      if (!text) throw new ChannelActionError("invalid_action", action === "send_draft" ? `卡 #${cardId} 上没有草稿` : "「改一下再发」要带要发的文字");
      return (await this.leadReply(adapter, card, text)).card;
    }
    const now = this.now();
    const at = now.toISOString();
    const recordAction = (summary: string) => appendEvent(this.db, {
      source: "system", kind: CHANNEL_EVENT_KINDS.cardAction, entityKey: card.objectKey, correlationId: `channel:${card.objectKey}`,
      level: "record", payload: { channel: adapter.id, cardId: card.id, action, by: options.by, summary },
    });
    const simple = (patch: ChannelCardPatch, disposition: EventDisposition, summary: string, detail: Record<string, unknown> = {}) => {
      const next = this.db.transaction(() => {
        const updated = updateChannelCard(this.db, card.id, patch, { expectedVersion: card.version, at: now });
        if (!updated) return null;
        recordAction(summary);
        this.disposeCardEvents(card, disposition, { by: options.by, action, cardId: card.id, ...detail });
        return updated;
      })();
      if (!next) throw new ChannelActionError("conflict", `卡 #${cardId} 刚刚变了，刷新后再操作`);
      return next;
    };
    // 发一条回复（用草稿、改一下再发）。label 是你对这份打了分的草稿做了什么（校准的标签，落地计划 D2）。
    const reply = async (outgoing: OutgoingReply, verb: string, label: ChannelReplyLabel) => {
      const outcome = await this.sendReply(adapter, card, "user_reply", { revokeWindowMs: 0, outgoing });
      if (!outcome) throw new ChannelActionError("conflict", `卡 #${cardId} 正在发送，或者刚刚变了`);
      recordActionInTransaction(this.db, () => {
        recordAction(outcome.status === "failed"
          ? `点了「${verb}」${card.sender.name}，这一次没有发出去，系统会再试`
          : `${verb}了${card.sender.name}`);
        if (outcome.status !== "failed") this.labelReply(card, label, now, card.draft?.at ?? null);
      });
      if (outcome.status === "failed") {
        this.cardsChanged([card.id]);
        throw new ChannelActionError("outbound_failed", `没有发出去，系统会用同一个幂等键再试：${outcome.error ?? "未知原因"}`);
      }
      return getChannelCard(this.db, card.id)!;
    };
    let result: ChannelCard;
    switch (action) {
      case "send_draft": {
        const draft = card.draft!;
        // 助手写的草稿（代查的、Lead 改过的）带「confirmed by」的署名；模板的草稿是一句确认，原样发（spec D8）。
        const message = ASSISTANT_DRAFTERS.has(draft.drafter)
          ? confirmedDraftDisclosure(this.assistantFor(adapter), this.ownerNameFor(adapter), draft.text)
          : { text: draft.text };
        result = await reply({ key: `reply:card:${card.id}:seq:${draft.forSeq}`, ...message, fromDraft: true, by: "user" }, "用草稿回复", "sent_as_is");
        break;
      }
      case "send_edited": {
        // 用户自己写的话：不加署名（spec D8）。
        const text = options.text?.trim() ?? "";
        if (!text) throw new ChannelActionError("invalid_action", "「改一下再发」要带要发的文字");
        result = await reply({
          key: `edited:card:${card.id}:seq:${card.lastSeq}`, text: text.slice(0, CHANNEL_CARD_TEXT_MAX), fromDraft: false, by: "user",
        }, "改了草稿回复", "rewritten");
        break;
      }
      case "reply_myself":
        // 卡马上结束，不再推送，也不等你在来源里回复；以后你在来源里的回复只给草稿打校准标签（统一消息事件 spec D11）。
        result = simple({ state: "left_to_user", snoozedUntil: null, resolvedAt: at, resolution: { by: options.by, action, at } },
          "handled", `你说会自己回复${card.sender.name}`);
        break;
      case "snooze": {
        const until = new Date(now.getTime() + this.snoozeMs).toISOString();
        result = simple({ state: "snoozed", snoozedUntil: until }, "deferred", `稍后再提醒（${clock(until)}）`, { until });
        break;
      }
      case "dismiss":
        result = simple({ state: "dismissed", snoozedUntil: null, resolvedAt: at, resolution: { by: options.by, action, at } },
          "no_action", `你选了不回复${card.sender.name}`);
        break;
      case "undo_auto_reply":
        result = await this.undoAutoReply(adapter, card, options.by);
        break;
      case "handled": {
        const note = options.note?.trim() ?? "";
        if (!note) throw new ChannelActionError("invalid_action", "「已处理」要写一句做了什么（note）");
        const reaction = options.react === false ? null : await this.acknowledge(adapter, card, options.emoji ?? CHANNEL_HANDLED_EMOJI);
        result = simple({
          state: "handled", snoozedUntil: null, resolvedAt: at, resolution: { by: options.by, action, at, detail: { note, reaction } },
        }, "handled", `卡上的事做完了：${note}`, { note, reaction });
        break;
      }
      case "cancel_lookup": {
        const active = getActiveLookupForCard(this.db, card.id);
        if (!active?.runId || !this.options.lead?.dispatcher.cancel) throw new ChannelActionError("invalid_action", `卡 #${cardId} 没有在跑的工单`);
        // 派单器把工单记成 cancelled，结果按回调交回（finishAgentTask），卡留着等你处理。
        await this.options.lead.dispatcher.cancel(active.runId);
        recordActionInTransaction(this.db, () => recordAction(`停掉了子 agent 工单 #${active.itemId ?? active.id}`));
        result = getChannelCard(this.db, card.id)!;
        break;
      }
    }
    const lane = getChannelLane(this.db, card.objectKey);
    if (lane) this.refreshLaneSummary(lane);
    this.closePendingRequest(result, options.by);
    this.cardsChanged([card.id]);
    this.later(() => this.settleStatusNotices(card.id), `status notice of card #${card.id}`);
    return result;
  }

  // 卡结束了：还在等 Lead 决定的请求不用再决定（卡上不再写「等 Lead 决定」，期限到了也不兜底）。
  private closePendingRequest(card: ChannelCard, by: string): void {
    if ((CHANNEL_CARD_OPEN_STATES as readonly ChannelCardState[]).includes(card.state) || !this.options.lead) return;
    for (const request of this.leadRequests({ cardId: card.id })) {
      this.recordLeadDecision(request, "closed", by.startsWith("lead") ? "lead" : "system", `卡已经结束：${cardStateLabel(card)}`);
    }
  }

  private async undoAutoReply(adapter: ChannelAdapter, card: ChannelCard, by: string): Promise<ChannelCard> {
    const sent = card.sent!;
    const context = await this.context(adapter);
    if (!context) throw new ChannelActionError("unavailable", "这个来源的连接不可用，没有撤回");
    const outcome = await this.outbox.perform(adapter, context, {
      key: `retract:${sent.key}`, purpose: "retract", cardId: card.id,
      request: { action: "retract", objectKey: card.objectKey, target: sent.remoteRef },
    });
    if (outcome.status === "failed") throw new ChannelActionError("outbound_failed", `没有撤回：${outcome.error ?? "未知原因"}`);
    const now = this.now();
    const at = now.toISOString();
    const result = this.db.transaction(() => {
      const fresh = getChannelCard(this.db, card.id)!;
      const updated = updateChannelCard(this.db, card.id, {
        // 撤回以后这张卡回到等你处理：自动回复撤掉了，消息还没人回。
        state: "open", revokeUntil: null, resolvedAt: null, sent: { ...sent, status: "retracted" },
        resolution: { by, action: "undo_auto_reply", at },
      }, { at: now })!;
      appendEvent(this.db, {
        source: "system", sourceRef: `channel-retracted:${adapter.id}:${sent.key}`, kind: CHANNEL_EVENT_KINDS.replyRetracted,
        entityKey: card.objectKey, correlationId: `channel:${card.objectKey}`, level: "record",
        payload: { channel: adapter.id, cardId: card.id, by, summary: `撤回了给${fresh.sender.name}的自动回复「${oneLine(sent.text, 80)}」` },
      });
      // 自动回复的处置撤掉：这张卡的事件回到「暂时搁着」，等用户处理。
      this.db.prepare(
        `UPDATE events SET disposition = 'deferred', disposition_detail = ?, disposed_at = ?
         WHERE correlation_id = ? AND seq >= ? AND disposition = 'auto_handled'
           AND ((source = ? AND seq <= ?) OR kind IN ('event.escalated', ?))`,
      ).run(JSON.stringify({ by, action: "undo_auto_reply", cardId: card.id }), at, `channel:${card.objectKey}`, card.firstSeq,
        adapter.id, card.lastSeq, CHANNEL_EVENT_KINDS.replyAutoSent);
      // 撤回的是打过分的草稿（子 agent 工单的、Lead 写的）：你不同意这一次（校准的标签，顶 3 个样本）。
      if (TASK_KEY.test(sent.key) || ANSWER_KEY.test(sent.key)) this.labelReply(card, "retracted", now);
      return getChannelCard(this.db, card.id) ?? updated;
    })();
    return result;
  }

  // ── 读 ────────────────────────────────────────────────────────────────────────────

  /** 卡上现在能做的动作。 */
  actionsFor(card: ChannelCard, adapter = this.options.registry.get(card.source)): ChannelCardAction[] {
    if (!adapter) return [];
    if ((CHANNEL_CARD_OPEN_STATES as readonly ChannelCardState[]).includes(card.state)) {
      const actions: ChannelCardAction[] = [];
      const sending = card.sent?.status === "pending";
      if (card.draft && adapter.capabilities.reply && !sending) actions.push("send_draft");
      if (adapter.capabilities.reply && !sending) actions.push("send_edited");
      // 有在跑的子 agent 工单时可以停掉。
      const latest = getLatestLookupForCard(this.db, card.id);
      if (latest?.runId && isActiveLookupState(latest.state) && this.options.lead?.dispatcher.cancel) actions.push("cancel_lookup");
      actions.push("reply_myself");
      if (card.state !== "snoozed") actions.push("snooze");
      actions.push("dismiss");
      // 卡上的事在别处做完了（页面上没有这个按钮，Lead 照你的话做完以后用）。
      actions.push("handled");
      return actions;
    }
    if (card.state === "auto_replied" && card.sent?.status === "sent" && adapter.capabilities.retract
      && card.revokeUntil && Date.parse(card.revokeUntil) > this.now().getTime()) {
      return ["undo_auto_reply"];
    }
    return [];
  }

  /** 卡的线上形状（网关的 /v1/channels/cards）。 */
  cardDto(card: ChannelCard, newestRequests?: ReadonlyMap<number, LeadRequest>): ChannelCardDto {
    const adapter = this.options.registry.get(card.source);
    const lane = getChannelLaneById(this.db, card.laneId);
    const gate = card.gate;
    return {
      id: card.id,
      version: card.version,
      source: card.source,
      sourceLabel: adapter?.label ?? card.source,
      objectKey: card.objectKey,
      laneLabel: lane?.label ?? card.objectKey,
      sender: card.sender,
      excerpt: card.excerpt,
      messageCount: card.messageCount,
      // 对方在这张卡里说的最近几条（这张卡的 seq 范围里，role 是 them）。
      recent: (lane?.context ?? [])
        .filter((message) => message.role === "them" && message.seq !== null && message.seq >= card.firstSeq && message.seq <= card.lastSeq)
        .slice(-5)
        .map((message) => ({ at: message.at, text: redactSecretText(message.text) })),
      delivery: card.delivery,
      state: card.state,
      draft: card.draft ? { text: card.draft.text, drafter: card.draft.drafter } : null,
      gate: gate ? {
        decision: gate.decision,
        category: gate.category,
        reasons: gate.failed.map((condition) => DELEGATION_GATE_LABELS[condition as keyof typeof DELEGATION_GATE_LABELS] ?? condition),
      } : null,
      lookup: this.lookupDtoFor(card, lane?.label ?? card.objectKey),
      handling: this.handlingOf(card, newestRequests),
      sentText: card.sent && card.sent.status === "sent" ? card.sent.text : null,
      outcome: (CHANNEL_CARD_OPEN_STATES as readonly ChannelCardState[]).includes(card.state) || !card.resolution ? null : {
        by: card.resolution.by.startsWith("lead") ? "lead" : card.resolution.by === "system" ? "system" : "user",
        action: card.resolution.action,
        note: typeof card.resolution.detail?.note === "string" ? card.resolution.detail.note : null,
      },
      snoozedUntil: card.snoozedUntil,
      revokeUntil: card.revokeUntil,
      resolvedAt: card.resolvedAt,
      actions: this.actionsFor(card, adapter),
      createdAt: card.createdAt,
      updatedAt: card.updatedAt,
    };
  }

  /** 最近的卡（只记录的不开卡），旧的在前。 */
  listCards(limit = 100): ChannelCardDto[] {
    const cards = listChannelCards(this.db, { limit });
    // 每张卡最新的 Lead 请求一次取完，不按卡一张一张查。
    const requests = new Map<number, LeadRequest>();
    if (this.options.lead && cards.length) {
      for (const request of this.leadRequestRows({ cardIds: cards.map((card) => card.id), undecided: false, newest: true })) {
        if (!requests.has(request.cardId)) requests.set(request.cardId, request);
      }
    }
    return cards.map((card) => this.cardDto(card, requests));
  }

  /**
   * Lead 的当前局面里每条道的一行（spec D14：Lead 的上下文只放每条道的一行摘要）。objectKeys 是上一轮以后有变化的对象，
   * 不是道的键不在结果里。另外加上还有没结束的卡、这次没有变化的道。
   */
  laneLines(objectKeys: readonly string[]): Map<string, string> {
    const lines = new Map<string, string>();
    const add = (lane: ChannelLane) => {
      const adapter = this.options.registry.get(lane.source);
      lines.set(lane.objectKey, `${adapter?.label ?? lane.source} · ${lane.label}：${lane.summary || "没有新的消息"}`);
    };
    for (const key of new Set(objectKeys)) {
      const lane = getChannelLane(this.db, key);
      if (lane) add(lane);
    }
    for (const lane of listOpenChannelLanes(this.db)) if (!lines.has(lane.objectKey)) add(lane);
    return lines;
  }

  // 通道对这张卡最新一条消息的处理（落地计划 D3）：授权表的结论，交给 Lead 以后 Lead（或者系统兜底）的决定。都没有时是 null。
  // newestRequests：卡片列表已经一次取好的每张卡最新的 Lead 请求（listCards）。不给时这里自己查这一张卡的。
  private handlingOf(card: ChannelCard, newestRequests?: ReadonlyMap<number, LeadRequest>): ChannelCardDto["handling"] {
    const payloadOf = (row: { payload: string } | undefined) => {
      if (!row) return null;
      try {
        return JSON.parse(row.payload) as Record<string, unknown>;
      } catch {
        return null;
      }
    };
    const decided = payloadOf(this.db.prepare("SELECT payload FROM events WHERE source = 'system' AND source_ref = ?")
      .get(authorityRef(card.lastSeq)) as { payload: string } | undefined);
    const authority = decided && (CHANNEL_AUTHORITY_ACTIONS as readonly unknown[]).includes(decided.action) ? {
      intent: isChannelIntent(decided.intent) ? decided.intent : null,
      action: decided.action as ChannelAuthorityActionKind,
      reason: typeof decided.reason === "string" ? decided.reason : "",
    } : null;
    const request = !this.options.lead ? null : newestRequests
      ? newestRequests.get(card.id) ?? null
      : this.leadRequestRows({ cardId: card.id, undecided: false, newest: true })[0] ?? null;
    let lead: ChannelCardHandling["lead"] = null;
    if (request) {
      const decidedRow = (ref: string) => this.db.prepare("SELECT payload FROM events WHERE source = 'system' AND source_ref = ?")
        .get(ref) as { payload: string } | undefined;
      const outcome = payloadOf(decidedRow(leadDecidedRef(request.stage, request.forSeq, request.seq))
        ?? (request.stage === "reply" ? decidedRow(legacyReplyDecidedRef(request.forSeq)) : undefined));
      const decision = outcome && (CHANNEL_LEAD_DECISIONS as readonly unknown[]).includes(outcome.decision)
        ? outcome.decision as ChannelLeadDecision : null;
      // 定过、但决定不认识的（工单 06 以前系统兜底的 fallback_*，旧记录不迁移）：不显示，免得卡上写成还在排队。
      lead = outcome && !decision ? null : {
        stage: request.stage, decision, by: decision ? (outcome?.by === "lead" ? "lead" : "system") : null,
        note: decision && typeof outcome?.reason === "string" ? outcome.reason : null,
      };
    }
    const reply = this.replyScoreOf(card);
    const ruleChange = this.ruleChangeOf(card);
    return authority || lead || reply || ruleChange ? { authority, lead, reply, ruleChange } : null;
  }

  /**
   * 这张卡上的消息里，请求 A 判断对方在要求改规则的（统一消息事件 spec D10 的 Jev 标记，工单 08）：要改的几类合在一起
   * （按概率从高到低、去重），概率取最高的。卡上写明没有照做。没有这样的消息时是 null。
   */
  private ruleChangeOf(card: ChannelCard): NonNullable<ChannelCardHandling["ruleChange"]> | null {
    const rows = this.db.prepare(
      `SELECT payload FROM events
        WHERE entity_key = ? AND seq > ? AND source = 'system' AND kind = ? AND json_valid(payload)
          AND json_extract(payload, '$.forSeq') BETWEEN ? AND ? AND json_extract(payload, '$.ruleChange') >= ?
        ORDER BY seq`,
    ).all(card.objectKey, card.firstSeq, CHANNEL_EVENT_KINDS.intakeDecided, card.firstSeq, card.lastSeq, CHANNEL_RULE_CHANGE_FLAG) as Array<{ payload: string }>;
    let probability = 0;
    const kinds = new Set<ChannelRuleChangeKind>();
    for (const row of rows) {
      const payload = JSON.parse(row.payload) as { ruleChange?: unknown; ruleChangeKinds?: unknown };
      if (typeof payload.ruleChange !== "number" || payload.ruleChange > 1) continue;
      probability = Math.max(probability, payload.ruleChange);
      for (const kind of Array.isArray(payload.ruleChangeKinds) ? payload.ruleChangeKinds : []) if (isChannelRuleChangeKind(kind)) kinds.add(kind);
    }
    return probability >= CHANNEL_RULE_CHANGE_FLAG ? { kinds: [...kinds], probability } : null;
  }

  // 信心模型给卡上这份草稿打的分（分数面板，落地计划 D2、D3）。卡上的草稿换了（例如 Lead 重写了）时不显示旧的分。
  private replyScoreOf(card: ChannelCard): ChannelCardHandling["reply"] {
    const scored = card.draft ? this.latestScoreOf(card) : null;
    const value = scored?.payload;
    if (!value || value.draftAt !== card.draft?.at) return null;
    const probability = (raw: unknown) => (typeof raw === "number" && raw >= 0 && raw <= 1 ? raw : null);
    const strings = (raw: unknown) => (Array.isArray(raw) ? raw.filter((item): item is string => typeof item === "string") : []);
    const calibration = value.calibration as Record<string, unknown> | null | undefined;
    return {
      draftKind: (CHANNEL_REPLY_DRAFT_KINDS as readonly unknown[]).includes(value.draftKind) ? value.draftKind as ChannelReplyDraftKind : "task",
      decision: (CHANNEL_REPLY_DECISIONS as readonly unknown[]).includes(value.decision) ? value.decision as ChannelReplyDecision : "ask_user",
      audit: value.audit === true,
      raw: probability(value.raw), confidence: probability(value.confidence), threshold: probability(value.threshold),
      calibration: calibration && probability(calibration.bucket) !== null && typeof calibration.samples === "number"
        && typeof calibration.agreed === "number" && typeof calibration.minSamples === "number" ? {
          bucket: probability(calibration.bucket)!, samples: Math.max(calibration.samples, 0), agreed: Math.max(calibration.agreed, 0),
          minSamples: Math.max(Math.round(calibration.minSamples), 1),
        } : null,
      checks: (Array.isArray(value.checks) ? value.checks : []).flatMap((raw) => {
        const check = raw as Record<string, unknown>;
        return typeof check.id === "string" && check.id && typeof check.label === "string" && typeof check.detail === "string"
          && (CHANNEL_LOOKUP_CHECK_STATUSES as readonly unknown[]).includes(check.status)
          ? [{
            id: check.id, label: check.label, status: check.status as ChannelLookupCheckStatus,
            value: typeof check.value === "number" && Number.isFinite(check.value) ? check.value : null, detail: check.detail,
          }]
          : [];
      }),
      vetoes: strings(value.vetoes), reasons: strings(value.reasons),
      at: typeof value.draftAt === "string" ? value.draftAt : card.updatedAt,
    };
  }

  // 卡上的代查（最新一次）。
  private lookupDtoFor(card: ChannelCard, laneLabel: string): ChannelCardDto["lookup"] {
    const latest = getLatestLookupForCard(this.db, card.id);
    if (!latest) return null;
    return lookupDto(latest, {
      laneLabel,
      externalShared: this.externalSharedOf(latest.forSeq),
      newerMessages: this.newerMessages(latest),
      ownerName: this.knownOwnerName(card.source),
    });
  }

  /**
   * Lead 读一张卡（spec D10；统一消息事件工单 05 以后由读对话的 read_channel_conversation 带出）：卡的线上形状和这条道最近的消息。
   * 外部的原文在里面，Lead 的工具要把它包进不可信的标签。没有这张卡时是 null。
   */
  cardForLead(cardId: number): ChannelCardForLead | null {
    const card = getChannelCard(this.db, cardId);
    if (!card) return null;
    const lane = getChannelLaneById(this.db, card.laneId);
    const request = this.options.lead ? this.pendingLeadRequest(cardId) : null;
    return {
      card: this.cardDto(card),
      messages: (lane?.context ?? []).map((message) => ({
        at: message.at, seq: message.seq, role: message.role, sender: message.sender, text: message.text,
      })),
      ...(this.options.lead ? {
        request: request ? {
          event: request.event, cardId: request.cardId, forSeq: request.forSeq, stage: request.stage, intent: request.intent, action: request.action,
          reason: request.reason, objects: request.objects, bound: request.bound,
          // 交接说明的上限：Lead 改选过句子就按改选的。
          handbook: this.replyCeilingOf(cardId) ?? request.handbook,
        } : null,
        tasks: this.tasksOf(cardId),
      } : {}),
    };
  }

  // 这张卡派过的子 agent 工单（channel.lead.decided 里派了工单的，加上 channel.task.finished 的结局）。
  /**
   * 这张卡派出去、还没交回的子 agent 工单（Lead 派的或者以前兜底派的）：派活的决定里有 Run，还没有 channel.task.finished，
   * 或者代查记录还在跑。没有时是 null。卡在它交回以前一直开着（统一消息事件工单 05 的跟进）。
   */
  private awaitingTask(cardId: number): { itemId: number | null; runId: number } | null {
    const pending = this.tasksOf(cardId).find((task) => task.status === null);
    if (pending) return { itemId: pending.itemId || null, runId: pending.runId };
    const lookup = getActiveLookupForCard(this.db, cardId);
    return lookup?.runId ? { itemId: lookup.itemId, runId: lookup.runId } : null;
  }

  private tasksOf(cardId: number): NonNullable<ChannelCardForLead["tasks"]> {
    const rows = this.db.prepare(
      `SELECT kind, payload FROM events WHERE source = 'system' AND kind IN (?, ?) AND json_valid(payload)
         AND json_extract(payload, '$.cardId') = ? AND json_type(payload, '$.runId') = 'integer' ORDER BY seq`,
    ).all(CHANNEL_EVENT_KINDS.leadDecided, CHANNEL_EVENT_KINDS.taskFinished, cardId) as Array<{ kind: string; payload: string }>;
    const tasks = new Map<number, NonNullable<ChannelCardForLead["tasks"]>[number]>();
    for (const row of rows) {
      const payload = JSON.parse(row.payload) as { runId: number; itemId?: number; by?: string; status?: string; decision?: string };
      const entry = tasks.get(payload.runId) ?? { itemId: payload.itemId ?? 0, runId: payload.runId, by: payload.by ?? "system", status: null, reply: null };
      if (row.kind === CHANNEL_EVENT_KINDS.taskFinished) {
        entry.status = payload.status ?? null;
        entry.reply = payload.decision ?? null;
      }
      tasks.set(payload.runId, entry);
    }
    return [...tasks.values()];
  }

  /**
   * 卡上放 Lead 写的草稿（统一消息事件工单 05：告诉用户时带的草稿、出站扩展没放行的回复）：drafter 记 lead，不发出。发出仍由用户在卡上点
   * （用户点「用草稿回复」时带「confirmed by」的署名）。卡已经结束、正在发送时抛 ChannelActionError。
   */
  updateDraftByLead(cardId: number, text: string): ChannelCardDto {
    const card = getChannelCard(this.db, cardId);
    if (!card) throw new ChannelActionError("not_found", `没有通道卡 #${cardId}`);
    if (!(CHANNEL_CARD_OPEN_STATES as readonly ChannelCardState[]).includes(card.state)) {
      throw new ChannelActionError("invalid_action", `卡 #${cardId} 已经结束（${card.state}），不能再改草稿`);
    }
    if (card.sent?.status === "pending") throw new ChannelActionError("conflict", `卡 #${cardId} 正在发送，不能改草稿`);
    const clean = text.trim();
    if (!clean) throw new ChannelActionError("invalid_action", "草稿不能是空的");
    const now = this.now();
    const updated = this.db.transaction(() => {
      const next = updateChannelCard(this.db, card.id, {
        draft: {
          text: clean.slice(0, CHANNEL_CARD_TEXT_MAX), drafter: "lead", templateId: null, slots: {}, at: now.toISOString(),
          forSeq: card.lastSeq,
        },
      }, { expectedVersion: card.version, at: now });
      if (!next) return null;
      appendEvent(this.db, {
        source: "system", kind: CHANNEL_EVENT_KINDS.cardAction, entityKey: card.objectKey, correlationId: `channel:${card.objectKey}`,
        level: "record",
        payload: { channel: card.source, cardId: card.id, action: "update_draft", by: "lead", summary: `${leadDisplayName(this.db)} 改了卡 #${card.id} 上的草稿（没有发出）` },
      });
      return next;
    })();
    if (!updated) throw new ChannelActionError("conflict", `卡 #${cardId} 刚刚变了，再读一次卡再改`);
    const lane = getChannelLaneById(this.db, updated.laneId);
    if (lane) this.refreshLaneSummary(lane);
    this.cardsChanged([updated.id]);
    return this.cardDto(updated);
  }

  // ── 内部 ──────────────────────────────────────────────────────────────────────────

  private async context(adapter: ChannelAdapter): Promise<ChannelAdapterContext | null> {
    let credential;
    try {
      credential = await this.options.credentials.credential(adapter.auth.connectionProvider);
    } catch (error) {
      this.log(`[channels] ${adapter.id}: could not read the connection: ${errorText(error)}`);
      return null;
    }
    if (!credential) return null;
    if (credential.accountName?.trim()) this.ownerNames.set(adapter.id, credential.accountName.trim());
    const context: ChannelAdapterContext = {
      credential,
      log: (line) => this.log(`[channels] ${adapter.id}: ${scrubCredential(line, { credential })}`),
      interest: this.interestFor(adapter),
    };
    return context;
  }

  // hub 告诉适配器的事实（ChannelInterest），只回答适配器自己名字下的对象键。
  private interestFor(adapter: ChannelAdapter): ChannelInterest {
    const own = (key: string) => key.startsWith(`${adapter.id}:`);
    return {
      laneExists: (objectKey) => own(objectKey) && getChannelLane(this.db, objectKey) !== undefined,
      recentLaneUnder: (prefix, sinceMs) => own(prefix) && Number.isFinite(sinceMs) && hasRecentChannelLane(this.db, prefix, new Date(sinceMs)),
      // 记过用户本人在这个对象里说的话（有道或者关注时记的）。走 events_entity 索引。
      followed: (objectKey) => own(objectKey) && this.db.prepare(
        `SELECT 1 FROM events WHERE entity_key = ? AND source = ?
           AND json_valid(payload) AND json_extract(payload, '$.role') = 'self_reply' LIMIT 1`,
      ).get(objectKey, adapter.id) !== undefined,
    };
  }

  /**
   * 适配器的传输（ChannelAdapter.transport）用的东西：当前的凭据、补拉要看的道、日志。daemon 的 startChannels 交给 transport.start。
   * 日志去掉最近一次取到的凭据。
   */
  transportContext(source: string): ChannelTransportContext {
    const adapter = this.options.registry.get(source);
    if (!adapter) throw new Error(`通道 ${source} 没有登记`);
    let latest: ChannelCredential | null = null;
    return {
      context: async () => {
        const context = await this.context(adapter);
        if (context) latest = context.credential;
        return context;
      },
      openLanes: (limit) => this.openLanesOf(adapter, limit),
      catchUpMark: {
        read: () => getChannelCatchUpMark(this.db, adapter.id),
        write: (at) => setChannelCatchUpMark(this.db, adapter.id, at),
      },
      catchUpIncomplete: (report) => this.catchUpIncomplete(adapter, report),
      log: (line) => this.log(`[channels] ${adapter.id}: ${scrubCredential(line, latest ? { credential: latest } : null)}`),
    };
  }

  // 断线这段时间的补拉没补全：记一条 tell 级的事件，Lead 下一轮看到，自己决定要不要告诉用户、去来源里查。
  // 同一段（来源和结束的时刻）只记一次。只有我们自己写的话，没有外部的原文。
  private catchUpIncomplete(adapter: ChannelAdapter, report: ChannelCatchUpReport): void {
    const from = report.from.toISOString();
    const to = report.to.toISOString();
    const summary = `${adapter.label} 在 ${from} 到 ${to}（UTC）之间断过线，重新连上以后补拉的消息没有补全，`
      + `补到了 ${report.caught} 条：${report.reasons.join("；")}。这段时间里可能有消息没收到，需要时到 ${adapter.label} 里查。`;
    try {
      this.db.transaction(() => appendEvent(this.db, {
        source: "system", sourceRef: `channel-catch-up:${adapter.id}:${to}`, kind: CHANNEL_EVENT_KINDS.catchUpIncomplete,
        entityKey: `channel:${adapter.id}`, level: "tell", occurredAt: to,
        payload: { channel: adapter.id, from, to, caught: report.caught, reasons: [...report.reasons], summary },
      }))();
    } catch (error) {
      this.log(`[channels] ${adapter.id}: could not tell Lead that the catch-up is incomplete: ${errorText(error)}`);
    }
  }

  // 这个来源有没结束的卡的道，带这条道里这个来源最后一条事件的 payload。
  private openLanesOf(adapter: ChannelAdapter, limit: number): ChannelOpenLane[] {
    const last = this.db.prepare("SELECT payload FROM events WHERE source = ? AND entity_key = ? ORDER BY seq DESC LIMIT 1");
    return listOpenChannelLanes(this.db, Math.max(1, Math.trunc(limit)), adapter.id).map((lane) => {
      const row = last.get(adapter.id, lane.objectKey) as { payload: string } | undefined;
      let lastPayload: Record<string, unknown> | null = null;
      try {
        lastPayload = row ? JSON.parse(row.payload) as Record<string, unknown> : null;
      } catch {
        lastPayload = null;
      }
      return { objectKey: lane.objectKey, lastPayload };
    });
  }

  // ── 代查（代查与按信心代回 spec D3–D8）────────────────────────────────────────

  // 助手名：daemon 给的名字（配置的 channels.assistantName，没有时是 Lead 的名字），取不到时用 disclosure.ts 的缺省名字。
  private assistantNameNow(): string {
    let configured: string | null = null;
    try {
      configured = this.options.assistantName?.() ?? null;
    } catch (error) {
      this.log(`[channels] could not read the assistant name: ${errorText(error)}`);
    }
    return disclosureAssistantName(configured);
  }

  // 发到这个来源的署名里的助手：来源的标记（例如自定义 emoji）加助手名。发到别处的（PR 上的 review）只用助手名。
  private assistantFor(adapter: Pick<ChannelAdapter, "disclosureMark">): string {
    const mark = adapter.disclosureMark?.trim();
    return mark ? `${mark} ${this.assistantNameNow()}` : this.assistantNameNow();
  }

  // 主人名：凭据里的 accountName，其次配置，最后「用户」（disclosure.ts）。
  private ownerNameFor(adapter: Pick<ChannelAdapter, "id">): string {
    let configured: string | null = null;
    try {
      configured = this.options.ownerName?.() ?? null;
    } catch (error) {
      this.log(`[channels] could not read the owner name: ${errorText(error)}`);
    }
    return disclosureOwnerName(this.ownerNames.get(adapter.id), configured);
  }

  // 卡的 DTO 里的主人名：署名里会写的名字；凭据和配置都没有时是 null（署名里写「用户」）。
  private knownOwnerName(source: string): string | null {
    const name = this.ownerNameFor({ id: source });
    return this.ownerNames.has(source) || name !== disclosureOwnerName() ? name : null;
  }

  // 对话是不是外部共享的：来源事件的 externalShared 字段（适配器给的事实）。没有这个字段或者问不到时是 null，用的人按外部共享对待。
  private externalSharedOf(seq: number): boolean | null {
    const value = getEvent(this.db, seq)?.payload.externalShared;
    return typeof value === "boolean" ? value : null;
  }

  // 回复会被谁看到（信心模型的受众档）。来源没说时按人数不知道的频道（代价最高的一档以下）。
  private audienceOf(seq: number): "dm" | "group_dm" | "public_channel" {
    const value = getEvent(this.db, seq)?.payload.audience;
    return value === "direct" ? "dm" : value === "group" ? "group_dm" : "public_channel";
  }

  // 查的那条消息以后，这条道里又来了几条消息（别人的消息、改和删、用户自己的话；系统发出去又推回来的不算）。
  private newerMessages(lookup: Pick<ChannelLookup, "source" | "objectKey" | "forSeq">): number {
    return (this.db.prepare(
      `SELECT COUNT(*) AS n FROM events
       WHERE source = ? AND entity_key = ? AND seq > ? AND json_valid(payload) AND json_extract(payload, '$.role') IN ('message', 'self_reply')`,
    ).get(lookup.source, lookup.objectKey, lookup.forSeq) as { n: number }).n;
  }

  private candidates(): readonly ChannelLookupCandidate[] {
    try {
      return this.options.lookupCandidates?.() ?? [];
    } catch (error) {
      this.log(`[channels] could not list the lookup candidates: ${errorText(error)}`);
      return [];
    }
  }

  /** 请求 A（spec D3）：在后台问，结果写成 channel.intake.decided 事件，再按授权表定。 */
  // 请求 A（spec D3）。cardId 是 null 时这条消息还没有卡：先判断要不要用户回，再开卡（settlePendingCard，用户 2026-10-21）。
  // 问完以后交给 Lead（不打扰的除外）。卡上不起草：草稿只由 Lead 写（工单 06）。
  /**
   * 起点（落地计划 A2）：这条消息回复的是另一条（payload 的 replyTo）时，把被回复的那条和它之前的几条放到这条道的最前面。
   * 先在自己的事件里按 messageId 找；找不到、而适配器能取历史时，取历史补（最多等 historyTimeoutMs）。补进来的只当上下文：
   * 不记事件，不开卡，不触发判断。道已经有起点时不再找。不抛错：补不成时用已有的上下文。
   */
  private async ensureOrigin(adapter: ChannelAdapter, seq: number): Promise<void> {
    const event = getEvent(this.db, seq);
    const replyTo = replyToOf(event?.payload);
    if (!event?.entityKey || !replyTo || !replyTo.objectKey.startsWith(`${adapter.id}:`)) return;
    const objectKey = event.entityKey;
    const lane = getChannelLane(this.db, objectKey);
    if (!lane || lane.context.some((message) => message.origin)) return;
    let origin = this.originFromEvents(adapter.id, replyTo, objectKey);
    if (!origin.length && adapter.capabilities.history && adapter.history) {
      origin = await this.originFromHistory(adapter, replyTo, typeof event.payload.messageId === "string" ? event.payload.messageId : null);
    }
    if (!origin.length) return;
    // 取历史要等：这期间别的消息可能已经放了起点。
    const fresh = getChannelLane(this.db, objectKey);
    if (!fresh || fresh.context.some((message) => message.origin)) return;
    setChannelLaneOrigin(this.db, objectKey, origin, this.now());
  }

  // 在自己的事件里找被回复的那一条，再加上它所在对话里它之前的几条。
  private originFromEvents(source: string, replyTo: { objectKey: string; ref: string }, objectKey: string): ChannelLaneMessage[] {
    const row = this.db.prepare(
      `SELECT seq, occurred_at, payload FROM events
       WHERE source = ? AND entity_key = ? AND json_valid(payload) AND json_extract(payload, '$.messageId') = ?
       ORDER BY seq LIMIT 1`,
    ).get(source, replyTo.objectKey, replyTo.ref) as { seq: number; occurred_at: string; payload: string } | undefined;
    if (!row) return [];
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(row.payload) as Record<string, unknown>;
    } catch {
      return [];
    }
    const sender = payload.sender as { name?: unknown } | undefined;
    const root: ChannelLaneMessage = {
      at: row.occurred_at, seq: row.seq, role: laneRoleOf(payload.role), ref: replyTo.ref,
      sender: typeof sender?.name === "string" ? sender.name : "对方", text: typeof payload.text === "string" ? payload.text : "",
    };
    // 根消息和回复在同一个道里（例如频道的 thread）时，之前的消息不属于这个 thread。
    const before = replyTo.objectKey === objectKey ? []
      : (getChannelLane(this.db, replyTo.objectKey)?.context ?? [])
        .filter((message) => !message.origin && message.seq !== null && message.seq < row.seq).slice(-ORIGIN_BEFORE);
    return [...before, root];
  }

  // 取历史补起点：被回复的那条和这条消息之前的回复（例如 thread 的根消息和前面的回复）。
  private async originFromHistory(adapter: ChannelAdapter, replyTo: { objectKey: string; ref: string }, current: string | null): Promise<ChannelLaneMessage[]> {
    const context = await this.context(adapter);
    if (!context || !adapter.history) return [];
    const timeoutMs = Math.max(this.options.historyTimeoutMs ?? HISTORY_TIMEOUT_MS, 1);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const messages = await Promise.race([
        adapter.history({ objectKey: replyTo.objectKey, ref: replyTo.ref, limit: CHANNEL_LANE_ORIGIN_LIMIT + 1 }, context),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`no history within ${timeoutMs} ms`)), timeoutMs); }),
      ]);
      const end = current === null ? -1 : messages.findIndex((message) => message.ref === current);
      return (end >= 0 ? messages.slice(0, end) : messages).slice(-CHANNEL_LANE_ORIGIN_LIMIT).map((message) => ({
        at: message.at, seq: null, role: message.role, sender: message.sender.name, ref: message.ref,
        text: clipEventText(redactSecretText(message.text), TEXT_MAX),
      }));
    } catch (error) {
      this.log(`[channels] ${adapter.id}: could not read the history of ${replyTo.objectKey}: ${errorText(error)}`);
      return [];
    } finally {
      clearTimeout(timer);
    }
  }

  private async runIntake(adapter: ChannelAdapter, cardId: number | null, seq: number): Promise<void> {
    const db = this.db;
    const event = getEvent(db, seq);
    let card = cardId === null ? null : getChannelCard(db, cardId) ?? null;
    if (!event || (cardId !== null && !card)) return;
    if (this.intakeOf(adapter.id, seq)) return;
    const objectKey = event.entityKey ?? card?.objectKey;
    if (!objectKey) return;
    // 先补起点（回复的是另一条消息时）：请求 A 和上下文包都读这条道的上下文。
    await this.ensureOrigin(adapter, seq);
    const lane = getChannelLane(db, objectKey);
    const text = typeof event.payload.text === "string" ? event.payload.text : "";
    const sender = event.payload.sender as { trust?: unknown } | undefined;
    const trust = isSenderTrust(sender?.trust) ? sender.trust : card?.sender.trust ?? "unknown";
    let businessMap: string | null = null;
    try {
      businessMap = findNoteByTitle(db, BUSINESS_MAP_NOTE_TITLE, "fact")?.content ?? null;
    } catch (error) {
      this.log(`[channels] could not read the business map: ${errorText(error)}`);
    }
    const judge = (judged: string) => judgeChannelIntake({
      intake: {
        text: judged,
        recent: recentForIntake(lane?.context ?? [], seq),
        senderTrust: trust,
        laneLabel: lane?.label ?? objectKey,
        userName: this.ownerNames.get(adapter.id) ?? null,
        businessMap,
        candidates: this.candidates(),
        handbook: this.handbookNow(),
      },
      model: this.smartModelNow(),
      timeoutMs: Math.max(this.options.intakeTimeoutMs ?? CHANNEL_INTAKE_TIMEOUT_MS, 1),
      text: this.textModelNow(),
    });
    let judged = this.mergedMessage(adapter.id, event).text || text;
    let result = await judge(judged);
    // 判断的时候对方把消息改了（editMergeFor 记成 merge_pending）：占位变成正文时，按旧的话判的「不用回」不能作数。
    // 实质变了就按最新的话再判断，直到判断完时话不再变（最多 REOPEN_LIMIT 轮）；改错字不重判。
    for (let round = 0; round < REOPEN_LIMIT; round += 1) {
      const latest = this.mergedMessage(adapter.id, event).text;
      if (!latest || !materialEdit(judged, latest)) break;
      judged = latest;
      result = await judge(judged);
    }
    const at = this.now();
    const payload = {
      channel: adapter.id, cardId: card?.id ?? null, forSeq: seq, status: result.status, situation: result.situation, askKind: result.askKind,
      askConfidence: result.askConfidence, targetRepo: result.target?.repo ?? null, sensitive: result.sensitive, topics: result.topics,
      closing: result.closing, reaction: result.reaction, questionVersion: CHANNEL_INTAKE_QUESTION_VERSION, needsReply: result.needsReply,
      ruleChange: result.ruleChange, ruleChangeKinds: result.ruleChangeKinds, borrowed: result.borrowed,
      // 谁判断的、有没有从决策模型换过来、为什么换；LLM 判断时它写的理由（issue 10）。
      backend: result.backend, why: result.reason ? clipEventText(redactSecretText(result.reason), 300) : null,
      fallback: result.fallback ? { from: result.fallback.from, reason: clipEventText(redactSecretText(result.fallback.reason), 200) } : null,
      error: result.error ? clipEventText(redactSecretText(result.error), 300) : null,
      summary: intakeSummary(result),
    };
    const inserted = db.transaction(() => appendEvent(db, {
      source: "system", sourceRef: intakeRef(adapter.id, seq), kind: CHANNEL_EVENT_KINDS.intakeDecided, entityKey: objectKey,
      correlationId: `channel:${objectKey}`, level: "record", occurredAt: at.toISOString(), payload,
    }).inserted)();
    if (!inserted) return;
    const decided = this.authorityFor(adapter, event, payload);
    let action: AuthorityAction | null = decided?.action ?? null;
    if (!card) {
      const settled = this.settlePendingCard(adapter, seq, decided);
      if (!settled.card) return;
      card = settled.card;
      action = settled.action;
    } else if (decided) {
      // 这条消息并进了已经开着的卡：卡还在等你，通道不替你回表情、拒绝或者收尾；要干活的、告诉你的照旧。
      // 只记录的照旧只记录：并进卡，不交给 Lead（2026-11-02：同一条消息改了四次，Lead 跑了四轮）。
      action = decided.action.kind === "work" || decided.action.kind === "tell" || decided.action.kind === "skip" ? decided.action
        : { kind: "ask", reason: `这个对话已经有一张卡在等你（${decided.action.reason}）` };
      const recorded = card;
      db.transaction(() => this.recordAuthority(adapter, event, recorded.id, decided, action!, at))();
    }
    // 交给 Lead（落地计划 B1）：要干活、要打扰你的（和请求 A 没有回答的）先交给 Lead 决定，不走代查剧本。
    if (this.leadRoutes(action)) {
      const kind = action?.kind ?? "ask";
      // 拼上下文包的时候对方改了消息：并进这次判断（editMergeFor），记消息事件时用改后的话。
      this.packing.add(seq);
      try {
        const context = await this.contextPackFor(adapter, card.id, seq);
        this.requestLead(adapter, card.id, seq, {
          intent: decided?.intent ?? null, action: kind, handbook: decided?.handbook ?? null,
          reason: (action?.reason ?? `收件判断没有做成（${result.error ? clipEventText(redactSecretText(result.error), 120) : "快模型不可用"}）`)
            + (action?.kind === "react" ? `（建议 :${action.emoji}:）` : "")
            + (event.payload.attachmentsOnly === true ? "（这条消息只有附件：先用 read_channel_file 看内容再判断）" : "")
            + (result.fallback && result.reason ? `（决策模型没有回答，由 LLM 判断：${clipEventText(redactSecretText(result.reason), 160)}）` : ""),
        }, context);
      } finally {
        this.packing.delete(seq);
      }
      return;
    }
    // 没有交给 Lead（daemon 没给 lead）：卡等你处理，不起草。干活由 Lead 派子 agent 工单（落地计划 B）；旧的代查退役了（D1）。
    if (result.status !== "answered") this.log(`[channels] ${adapter.id}: intake of event #${seq} not judged (${result.error ?? "unavailable"})`);
  }

  /** 现在生效的交接说明（store 的 channelHandbook：放开的部分只算可信的版本）。库里读不到时用缺省的，依据记成第 0 版。 */
  private handbookPolicyNow(): { handbook: ChannelHandbook; order: { id: string; version: number } } {
    try {
      const policy = channelHandbook(this.db);
      if (policy) return { handbook: policy.handbook, order: policy.order };
    } catch (error) {
      this.log(`[channels] could not read the handbook: ${errorText(error)}`);
    }
    return { handbook: CHANNEL_HANDBOOK_DEFAULTS, order: { id: CHANNEL_HANDBOOK_ORDER_ID, version: 0 } };
  }

  private handbookNow(): ChannelHandbook {
    return this.handbookPolicyNow().handbook;
  }

  /**
   * 按交接说明决定通道该做什么（自动代你处理方案 B，issue 03，handbook-decision.ts）：收件判断选的一句（intake 事件的 payload），
   * 加上这条消息的事实。交接说明是常设指令 channel.handbook（store 的 channelHandbook），读不到时用缺省的。
   * 总开关是交接说明自己的（设置页「自动代你处理」，issue 07）。旧授权表的开关在迁移时搬了过来（migrateAuthorityToHandbook）。
   * 请求 A 没有回答时是 null（照常开卡）。第 7 版以前的判断没有选句子：按旧意图对应的第一句（涉密按兜底，由敏感查询认出）。
   */
  private authorityFor(
    adapter: ChannelAdapter, event: EventRecord, intake: Record<string, unknown>, repicked: string | null = null,
  ): AuthorityDecision | null {
    if (intake.status !== "answered") return null;
    const settings = this.policyFor(adapter.id);
    const policy = this.handbookPolicyNow();
    const handbook = policy.handbook;
    const situation = situationOfIntake(handbook, repicked ?? intake.situation, intake.askKind);
    const sender = event.payload.sender as { trust?: unknown; bot?: unknown } | undefined;
    const audience = event.payload.audience;
    // 只有附件的消息（来源标的 attachmentsOnly）：收件判断只看得到文件的标记，敏感信息的分数不进底线，由 Lead 看了附件再定。
    const sensitive = event.payload.attachmentsOnly !== true && intake.sensitive && typeof intake.sensitive === "object"
      ? Object.fromEntries(Object.entries(intake.sensitive as Record<string, unknown>).filter((entry): entry is [string, number] => typeof entry[1] === "number"))
      : null;
    const decided = decideByHandbook({
      situation, handbook, borrowed: typeof intake.borrowed === "number" ? intake.borrowed : null,
      ruleChange: typeof intake.ruleChange === "number" ? intake.ruleChange : null,
      closing: isChannelClosingKind(intake.closing) ? intake.closing : null,
      reaction: (CHANNEL_REACTION_EMOJIS as readonly unknown[]).includes(intake.reaction) ? intake.reaction as ChannelReactionEmoji : null,
      needsReply: typeof intake.needsReply === "number" ? intake.needsReply : null,
      sensitive,
      sender: { trust: isSenderTrust(sender?.trust) ? sender.trust : "unknown", bot: sender?.bot === true },
      externalShared: this.externalSharedOf(event.seq),
      audience: audience === "direct" || audience === "group" || audience === "channel" ? audience : null,
      capabilities: { reply: adapter.capabilities.reply, react: adapter.capabilities.react === true },
      reactable: messageRefOf(event.payload) !== null,
      noReplyBelow: this.noReplyBelowOption ?? settings.confidence.noReplyBelow,
      ownMessageAgoMs: this.ownMessageAgoMs(adapter, event),
    });
    return { intent: situationIntent(situation), action: decided.action, order: policy.order, handbook: decided };
  }

  /**
   * 你本人或者 Lead 替你在这个对话里最近一次说话，到这条消息过了多久（毫秒，授权表的「接着回答你」，spec D3）。
   * 算两种：你在来源里自己说的话（self_reply 事件，道存在时才记），和替你发出的回复（出站的 user_reply：卡上发草稿、
   * Lead 代你发的消息）。系统自己发的（「正在处理」、自动回复、表情）不算。都没有时是 null。
   */
  private ownMessageAgoMs(adapter: ChannelAdapter, event: EventRecord): number | null {
    if (!event.entityKey) return null;
    const row = this.db.prepare(
      `SELECT occurred_at FROM events
        WHERE entity_key = ? AND seq < ? AND json_valid(payload)
          AND ((source = ? AND json_extract(payload, '$.role') = 'self_reply')
            OR (source = 'system' AND kind = ? AND json_extract(payload, '$.purpose') = 'user_reply'))
        ORDER BY seq DESC LIMIT 1`,
    ).get(event.entityKey, event.seq, adapter.id, CHANNEL_EVENT_KINDS.outboundRequested) as { occurred_at: string } | undefined;
    if (!row) return null;
    const spoke = dbTime(row.occurred_at);
    const now = dbTime(event.occurredAt);
    if (!Number.isFinite(spoke) || !Number.isFinite(now)) return null;
    // 来源的时钟和本机的可能差几秒：先说的话记得比这条晚一点时，按刚说过算。
    return Math.max(0, now - spoke);
  }

  // 记下授权表的决定（channel.authority.decided）。回表情是代你做的事，进摘要；别的只记录（拒绝由自动回复的事件进摘要）。
  // 调用方负责事务。
  private recordAuthority(
    adapter: ChannelAdapter, event: EventRecord, cardId: number | null, decided: AuthorityDecision, action: AuthorityAction, at: Date,
  ): void {
    const intent = decided.intent;
    const objectKey = event.entityKey!;
    const sender = event.payload.sender as { name?: unknown } | undefined;
    const name = typeof sender?.name === "string" ? sender.name : "对方";
    const laneLabel = typeof event.payload.laneLabel === "string" ? event.payload.laneLabel : objectKey;
    const excerpt = oneLine(typeof event.payload.text === "string" ? event.payload.text : "", 80);
    appendEvent(this.db, {
      source: "system", sourceRef: authorityRef(event.seq), kind: CHANNEL_EVENT_KINDS.authorityDecided, entityKey: objectKey,
      correlationId: `channel:${objectKey}`, level: action.kind === "react" ? "digest" : "record", causationId: String(event.seq),
      occurredAt: at.toISOString(),
      payload: {
        channel: adapter.id, forSeq: event.seq, cardId, intent, action: action.kind, reason: action.reason,
        ...(action.kind === "react" ? { emoji: action.emoji } : {}), order: decided.order,
        // 交接说明（issue 03）：起作用的一句、它的做法、压过以后的做法和压过它的那一句。
        situation: decided.handbook.situation.id, mode: decided.handbook.mode, final: decided.handbook.final, by: decided.handbook.by,
        ...(decided.handbook.limit ? { limit: decided.handbook.limit } : {}),
        summary: action.kind === "react"
          ? `${name}在${laneLabel}：「${excerpt}」${action.reason}（:${action.emoji}:）`
          : `${name}在${laneLabel}：「${excerpt}」${AUTHORITY_ACTION_LABELS[action.kind]}：${action.reason}`,
      },
    });
  }

  // 回表情（授权表的结论）。不开卡；回不成只记日志（出站的记账里有失败的事件），不打扰你。
  private async reactToEvent(adapter: ChannelAdapter, event: EventRecord, emoji: ChannelReactionEmoji): Promise<void> {
    const target = messageRefOf(event.payload);
    const context = await this.context(adapter);
    if (!target || !context || !event.entityKey) {
      this.log(`[channels] ${adapter.id}: could not react to event #${event.seq} (${!target ? "no message reference" : "no connection"})`);
      return;
    }
    const outcome = await this.outbox.perform(adapter, context, {
      key: `react:${event.seq}`, purpose: "reaction", cardId: null,
      request: { action: "react", objectKey: event.entityKey, target, emoji },
    });
    if (outcome.status === "failed") this.log(`[channels] ${adapter.id}: the reaction to event #${event.seq} failed: ${outcome.error ?? "unknown"}`);
  }

  // 代你拒绝（没有接 Lead 时授权表的结论）：用固定的话回。卡变成「已代回」。
  private async refuse(adapter: ChannelAdapter, cardId: number, seq: number): Promise<void> {
    const card = getChannelCard(this.db, cardId);
    if (!card || card.state !== "open" || card.lastSeq !== seq) return;
    await this.sendRefusal(adapter, card, seq);
    this.cardsChanged([card.id]);
  }

  // 用固定的话拒绝：带「auto-reply for 你」的署名，留撤回窗口（没有接 Lead 时的授权表、Lead 的固定拒绝都用它）。
  private sendRefusal(adapter: ChannelAdapter, card: ChannelCard, seq: number): Promise<ChannelOutboundOutcome | null> {
    return this.sendReply(adapter, card, "auto_reply", {
      revokeWindowMs: AUTHORITY_REVOKE_WINDOW_MS,
      outgoing: {
        key: `refuse:card:${card.id}:seq:${seq}`, by: "auto", fromDraft: false,
        ...autoReplyDisclosure(this.assistantFor(adapter), this.ownerNameFor(adapter), AUTHORITY_REFUSAL_TEXT),
      },
    });
  }

  /**
   * 还没有卡的消息（record 时记了 cardPending），请求 A 问完以后按授权表定开不开卡（用户 2026-10-21：先判断要不要回，再开卡）：
   *   - 不打扰：不开卡。记 channel.reply.not_needed（digest 级，在「Lead 动态」里看得到），这条消息的处置记成 no_action。
   *   - 回表情：不开卡。在后台回表情，处置记成 auto_handled。
   *   - 代你拒绝：开一张不推送的新卡，在后台用固定的话回。这个对话已经有开着的卡时改成问你。
   *   - 提醒你：开卡并推送。代你说一句（收尾）：交给 Lead 时开卡，不推送；没有接 Lead 时回表情（回不了时不打扰你），
   *     不起草（工单 06 删了起草器）。要干活、问你、告诉你：开卡，按投递方式推送。
   *   - 请求 A 没有回答（decided 是 null）：开卡。
   * 每个决定都记 channel.authority.decided（和开卡、不开卡在同一个事务里，settleStalePendingCards 靠它认出定过的）。
   * 已经有卡包着这条消息（例如别的消息先开了卡）时什么也不做。返回这条消息所在的、没结束的卡（不开卡时是 null）和实际的结论。
   */
  private settlePendingCard(
    adapter: ChannelAdapter, seq: number, given: AuthorityDecision | null,
  ): { card: ChannelCard | null; action: AuthorityAction | null } {
    const db = this.db;
    const event = getEvent(db, seq);
    const pending = event ? pendingCardOf(event.payload) : null;
    if (!event || !pending || !event.entityKey) return { card: null, action: null };
    const objectKey = event.entityKey;
    // 交给 Lead 时不在这里起草：Lead 看了上下文自己写（reply_to_source、notify_user 带的草稿），或者回表情、不回。
    const viaLead = this.leadRoutes(given?.action ?? null);
    // 没有接 Lead 时没有人写收尾的那一句：回个表情（来源回不了表情时不打扰你）。
    const decided: AuthorityDecision | null = given && !viaLead && given.action.kind === "closing_reply"
      ? {
        ...given,
        action: adapter.capabilities.react === true && messageRefOf(event.payload)
          ? { kind: "react", emoji: closingReaction(given.action.closing, this.reactionOf(adapter.id, seq)), reason: `${given.action.reason}：回个表情` }
          : { kind: "skip", reason: `${given.action.reason}，这个来源也回不了表情：不打扰你` },
      }
      : given;
    const at = this.now();
    const outcome = db.transaction((): { card: ChannelCard | null; push: boolean; action: AuthorityAction | null } => {
      if (this.coveredByCard(objectKey, seq)) {
        // 后到的消息先判断完、先开了卡：这一条并进去（卡从它算起，消息数加一）。它要推送而卡还没推过时补推。
        const open = getOpenChannelCard(db, objectKey);
        if (!open || open.firstSeq <= seq) return { card: open ?? null, push: false, action: null };
        const push = pending.delivery === "push_card" && open.delivery !== "push_card";
        const merged = updateChannelCard(db, open.id, {
          firstSeq: seq, messageCount: open.messageCount + 1, delivery: strongerDelivery(open.delivery, pending.delivery),
        }, { at }) ?? open;
        return { card: merged, push, action: null };
      }
      const action = decided?.action ?? null;
      if (decided && action && (action.kind === "skip" || (action.kind === "react" && !viaLead))) {
        this.recordAuthority(adapter, event, null, decided, action, at);
        if (action.kind === "react") {
          setEventDisposition(db, seq, "auto_handled", { by: "assistant", standingOrder: decided.order, action: "react", emoji: action.emoji }, at);
          return { card: null, push: false, action };
        }
        const sender = event.payload.sender as { name?: unknown } | undefined;
        const name = typeof sender?.name === "string" ? sender.name : "对方";
        const laneLabel = typeof event.payload.laneLabel === "string" ? event.payload.laneLabel : objectKey;
        const excerpt = oneLine(typeof event.payload.text === "string" ? event.payload.text : "", 80);
        const intake = this.intakeOf(adapter.id, seq);
        const needsReply = typeof intake?.needsReply === "number" ? intake.needsReply : null;
        appendEvent(db, {
          source: "system", sourceRef: notNeededRef(seq), kind: CHANNEL_EVENT_KINDS.replyNotNeeded, entityKey: objectKey,
          correlationId: `channel:${objectKey}`, level: "digest", causationId: String(seq), occurredAt: at.toISOString(),
          payload: {
            channel: adapter.id, forSeq: seq, needsReply, askKind: typeof intake?.askKind === "string" ? intake.askKind : null,
            reason: action.reason,
            summary: `${name}在${laneLabel}：「${excerpt}」助手判断不用你回（${action.reason}），没有开卡`,
          },
        });
        setEventDisposition(db, seq, "no_action", { by: "assistant", reason: "no_reply_needed", needsReply }, at);
        return { card: null, push: false, action };
      }
      // 提醒你的推送；代你说一句、代你拒绝的不推送（代你做了，摘要里有）。
      // 交给 Lead 的回表情也开一张不推送的卡：Lead 在卡上决定，卡上留下谁回了哪个表情。
      const delivery: ChannelDeliveryMode = action?.kind === "remind" ? "push_card"
        : action?.kind === "closing_reply" || action?.kind === "refuse" || action?.kind === "react" ? "card" : pending.delivery;
      const opened = this.openPendingCardNow(adapter, event, { ...pending, delivery }, at);
      // 代你拒绝只用在新开的卡上：这个对话已经有开着的卡时，自动回复会把那张卡也结束掉，改成问你。
      const effective: AuthorityAction | null = action?.kind === "refuse" && !opened.created
        ? { kind: "ask", reason: `这个对话已经有一张卡在等你（${action.reason}）` }
        : action;
      if (decided && effective) this.recordAuthority(adapter, event, opened.card?.id ?? null, decided, effective, at);
      return { card: opened.card, push: opened.push, action: effective };
    })();
    const lane = getChannelLane(db, objectKey);
    if (lane) this.refreshLaneSummary(lane);
    const action = outcome.action;
    if (action?.kind === "react" && !viaLead) this.later(() => this.reactToEvent(adapter, event, action.emoji), `reaction to event #${seq}`);
    if (outcome.card) {
      // 交给 Lead 的不在这里推送：由 Lead 决定怎么告诉你（落地计划 B）。
      if (outcome.push && !this.leadRoutes(action)) this.pushCard(adapter, outcome.card, "new");
      this.cardsChanged([outcome.card.id]);
      const cardId = outcome.card.id;
      if (action?.kind === "refuse" && !viaLead) this.later(() => this.refuse(adapter, cardId, seq), `refusal on card #${cardId}`);
      // 判断的时候用户已经在来源里自己说了话：开卡以后照样判断那句话回答了没有（卡开之前它没有卡可以对）。
      const own = db.prepare(
        `SELECT seq FROM events WHERE source = ? AND entity_key = ? AND seq > ?
           AND json_valid(payload) AND json_extract(payload, '$.role') = 'self_reply'
         ORDER BY seq DESC LIMIT 1`,
      ).get(adapter.id, objectKey, seq) as { seq: number } | undefined;
      if (own) this.later(() => this.judgeOwnReply(adapter, cardId, own.seq), `own reply #${own.seq}`);
    }
    return { card: outcome.card, action };
  }

  // 请求 A 选的表情（没有、不认识时是 null）。
  private reactionOf(source: string, seq: number): ChannelReactionEmoji | null {
    const reaction = this.intakeOf(source, seq)?.reaction;
    return (CHANNEL_REACTION_EMOJIS as readonly unknown[]).includes(reaction) ? reaction as ChannelReactionEmoji : null;
  }

  // 开卡：这个对话已经有没结束的卡时把这条消息并进去（和 record 里一样），否则开一张新卡。调用方负责事务。
  // created：开的是新卡（不是并进已有的卡）。
  private openPendingCardNow(
    adapter: ChannelAdapter, event: EventRecord, pending: { delivery: ChannelDeliveryMode; replyTarget: Record<string, string> }, at: Date,
  ): { card: ChannelCard | null; push: boolean; created: boolean } {
    const db = this.db;
    const objectKey = event.entityKey!;
    const lane = getChannelLane(db, objectKey);
    if (!lane) return { card: null, push: false, created: false };
    const payloadSender = event.payload.sender as { id?: unknown; name?: unknown; trust?: unknown } | undefined;
    const sender = {
      id: typeof payloadSender?.id === "string" ? payloadSender.id : "",
      name: typeof payloadSender?.name === "string" ? payloadSender.name : "对方",
      trust: isSenderTrust(payloadSender?.trust) ? payloadSender.trust : "unknown" as SenderTrust,
    };
    // 判断的时候对方改了这条消息（spec D6）：卡上是改以后的话。
    const excerpt = oneLine(this.mergedMessage(adapter.id, event).text, EXCERPT_MAX);
    const open = getOpenChannelCard(db, objectKey);
    const card = open
      ? updateChannelCard(db, open.id, {
        state: "open", snoozedUntil: null, lastSeq: event.seq, messageCount: open.messageCount + 1, sender, excerpt,
        replyTarget: pending.replyTarget, delivery: strongerDelivery(open.delivery, pending.delivery), gate: null, draft: null,
      }, { at })!
      : openChannelCard(db, {
        laneId: lane.id, source: adapter.id, objectKey, delivery: pending.delivery, seq: event.seq, sender, excerpt,
        replyTarget: pending.replyTarget, at,
      });
    return { card, push: pending.delivery === "push_card", created: !open };
  }

  // 这条消息已经有卡管着：有一张卡包着它（first_seq ≤ seq ≤ last_seq），或者这个对话里后来的消息开过卡（这一条已经旧了）。
  private coveredByCard(objectKey: string, seq: number): boolean {
    return this.db.prepare(
      "SELECT 1 FROM channel_cards WHERE object_key = ? AND (last_seq >= ?) LIMIT 1",
    ).get(objectKey, seq) !== undefined;
  }

  /**
   * 每一拍：还没有定开不开卡的消息（cardPending，没有卡包着它，也没有授权表的决定、channel.reply.not_needed），收到超过
   * pendingCardGraceMs 以后补上（例如问请求 A 的时候 daemon 重启了）。请求 A 已经回答的按授权表定；没有回答的直接开卡
   * （不再问，宁可多问用户）。只看最近一天的消息。
   */
  private settleStalePendingCards(): number[] {
    const db = this.db;
    const now = this.now().getTime();
    const changed: number[] = [];
    const unsettled = `json_valid(e.payload) AND json_type(e.payload, '$.cardPending') = 'object'
           AND NOT EXISTS (SELECT 1 FROM events d WHERE d.source = 'system' AND d.source_ref = 'channel-reply-not-needed:' || e.seq)
           AND NOT EXISTS (SELECT 1 FROM events a WHERE a.source = 'system' AND a.source_ref = 'channel-authority:' || e.seq)
           AND NOT EXISTS (SELECT 1 FROM channel_cards c WHERE c.object_key = e.entity_key AND c.last_seq >= e.seq)`;
    for (const adapter of this.options.registry.list()) {
      const from = this.pendingScanFrom.get(adapter.id) ?? 0;
      const rows = db.prepare(
        `SELECT e.seq FROM events e
         WHERE e.source = ? AND e.seq > ? AND ${unsettled}
           AND json_extract(e.payload, '$.cardPending.at') >= ? AND json_extract(e.payload, '$.cardPending.at') <= ?
         ORDER BY e.seq LIMIT 20`,
      ).all(adapter.id, from, new Date(now - DAY_MS).toISOString(), new Date(now - this.pendingCardGraceMs).toISOString()) as Array<{ seq: number }>;
      for (const { seq } of rows) {
        const event = getEvent(db, seq);
        const intake = this.intakeOf(adapter.id, seq);
        const decided = event && intake ? this.authorityFor(adapter, event, intake) : null;
        const settled = this.settlePendingCard(adapter, seq, decided);
        const card = settled.card;
        if (card) {
          changed.push(card.id);
          if (this.leadRoutes(settled.action)) {
            const request = {
              intent: decided?.intent ?? null, action: settled.action?.kind ?? "ask", handbook: decided?.handbook ?? null,
              reason: settled.action?.reason ?? "收件判断丢了（例如判断时 daemon 重启了）",
            };
            // 先拼上下文包（要等几项，在后台），再交给 Lead。
            this.packing.add(seq);
            this.later(async () => {
              try {
                this.requestLead(adapter, card.id, seq, request, await this.contextPackFor(adapter, card.id, seq));
              } finally {
                this.packing.delete(seq);
              }
            }, `lead request for event #${seq}`);
          }
        }
      }
      // 水位线：最早一条还没定的消息之前的都定了（一天以前的不再管）；都定了时走到最新的事件。这几次查询是同步的，
      // 中间插不进新事件，所以用全部事件里最大的 seq 也不会漏掉这个来源的。
      const oldest = db.prepare(
        `SELECT MIN(e.seq) AS seq FROM events e WHERE e.source = ? AND e.seq > ? AND ${unsettled}
           AND json_extract(e.payload, '$.cardPending.at') >= ?`,
      ).get(adapter.id, from, new Date(now - DAY_MS).toISOString()) as { seq: number | null };
      const latest = db.prepare("SELECT MAX(seq) AS seq FROM events").get() as { seq: number | null };
      this.pendingScanFrom.set(adapter.id, oldest.seq !== null ? oldest.seq - 1 : Math.max(from, latest.seq ?? 0));
    }
    return changed;
  }

  // 「正在处理」的一句（代查、子 agent 工单都用）：幂等键按卡和消息，回复改写它（落地计划 A3）。返回发送的 promise。
  private sendStatusNotice(adapter: ChannelAdapter, card: ChannelCard, forSeq: number, question: string, playbook: string): Promise<void> {
    const key = `handling:card:${card.id}:seq:${forSeq}`;
    const sending: Promise<void> = (async () => {
      try {
        const verb = await judgeHandlingVerb({
          question, playbook: playbook === "review" ? "review" : "lookup", model: this.smartModelNow(),
          timeoutMs: Math.max(this.options.intakeTimeoutMs ?? CHANNEL_INTAKE_TIMEOUT_MS, 1),
        });
        const notice = handlingNotice(this.assistantFor(adapter), isHandlingVerb(verb) ? verb : defaultHandlingVerb(playbook));
        const context = await this.context(adapter);
        if (!context) {
          this.log(`[channels] ${adapter.id}: no connection; the handling notice on card #${card.id} was not sent`);
          return;
        }
        const outcome = await this.outbox.perform(adapter, context, {
          key, purpose: "handling_notice", cardId: card.id,
          request: { action: "reply", objectKey: card.objectKey, target: card.replyTarget, text: notice.text, parts: notice.parts },
        });
        if (outcome.status === "failed") {
          this.log(`[channels] ${adapter.id}: the handling notice on card #${card.id} was not sent: ${outcome.error ?? "unknown"}`);
        }
      } catch (error) {
        this.log(`[channels] ${adapter.id}: the handling notice on card #${card.id} failed: ${errorText(error)}`);
      }
    })();
    // idle() 也等它（测试、停机）。
    this.statusNotices.set(card.id, sending);
    this.background.add(sending);
    void sending.finally(() => {
      if (this.statusNotices.get(card.id) === sending) this.statusNotices.delete(card.id);
      this.background.delete(sending);
    });
    return sending;
  }

  // 原文里的 PR。只留作用域要的三项（作用域是严格 schema），按 schema 的上限检查：不合格的当成认不出。
  private pullRequestOf(text: string): { owner: string; repo: string; number: number } | null {
    let found: { owner: unknown; repo: unknown; number: unknown } | null;
    try {
      found = this.options.pullRequestOf?.(text) ?? null;
    } catch (error) {
      this.log(`[channels] could not read a pull request from the message: ${errorText(error)}`);
      return null;
    }
    if (!found) return null;
    const { owner, repo, number } = found;
    const name = (value: unknown): value is string => typeof value === "string" && value.length >= 1 && value.length <= 100;
    return name(owner) && name(repo) && typeof number === "number" && Number.isInteger(number) && number >= 1 ? { owner, repo, number } : null;
  }

  /**
   * 用户自己在来源里说的话（工单 04 第 7 条）：问 SmartModel 这句话是不是回答了对方。回答了，卡「别处已处理」；
   * 只是说收到、稍等（或者问不成），卡留着，标成「你在来源里回复过」（replying_self），不再推送。代查照常进行。
   */
  private async judgeOwnReply(adapter: ChannelAdapter, cardId: number, seq: number): Promise<void> {
    const db = this.db;
    const card = getChannelCard(db, cardId);
    const event = getEvent(db, seq);
    if (!card || !event || !(CHANNEL_CARD_OPEN_STATES as readonly ChannelCardState[]).includes(card.state)) return;
    const lane = getChannelLaneById(db, card.laneId);
    const asked = (lane?.context ?? []).filter((message) => message.role === "them" && (message.seq === null || message.seq < seq))
      .slice(-3).map((message) => message.text).join("\n");
    const judged = await judgeSelfReply({
      request: asked || card.excerpt, reply: typeof event.payload.text === "string" ? event.payload.text : "",
      model: this.smartModelNow(), timeoutMs: Math.max(this.options.selfReplyTimeoutMs ?? CHANNEL_SELF_REPLY_TIMEOUT_MS, 1),
    });
    const now = this.now();
    const at = now.toISOString();
    const changed = db.transaction(() => {
      const fresh = getChannelCard(db, cardId);
      // 问的时候对方又来了新消息：用户这句话回答的是旧的内容，卡跟着新消息走。
      if (!fresh || !(CHANNEL_CARD_OPEN_STATES as readonly ChannelCardState[]).includes(fresh.state) || fresh.lastSeq > seq) return null;
      const detail = { seq, answered: judged.answered, probability: judged.probability, ...(judged.error ? { error: clipEventText(judged.error, 200) } : {}) };
      if (judged.answered === true) {
        const updated = updateChannelCard(db, fresh.id, {
          state: "resolved_elsewhere", resolvedAt: at, snoozedUntil: null,
          resolution: { by: "user", action: "replied_in_source", at, detail },
        }, { at: now })!;
        this.disposeCardEvents(fresh, "resolved_elsewhere", { by: "user", via: adapter.id, seq, cardId: fresh.id });
        // 你在来源里自己回答了：卡上打过分的草稿你没用（校准的标签）。
        this.labelReply(fresh, "rewritten", now);
        return updated;
      }
      const updated = updateChannelCard(db, fresh.id, {
        state: "replying_self", snoozedUntil: null, resolution: { by: "user", action: "replied_in_source", at, detail },
      }, { at: now })!;
      this.disposeCardEvents(fresh, "deferred", { by: "user", via: adapter.id, seq, cardId: fresh.id, answered: judged.answered });
      return updated;
    })();
    if (!changed) return;
    this.closePendingRequest(changed, "user");
    this.refreshLaneOf(changed);
    this.cardsChanged([changed.id]);
    // 你在来源里自己回了：「正在处理」不再是真的。
    await this.settleStatusNotices(changed.id);
  }

  // 给这张卡的事件记处置：这张卡的入站事件（firstSeq 到 lastSeq），和它们到时限升级出来的事件。
  // 只覆盖还没有处置的，和 OVERWRITABLE 里的处置（Lead 看过的、暂时搁着的）。
  private disposeCardEvents(card: ChannelCard, disposition: EventDisposition, detail: Record<string, unknown>): void {
    const placeholders = OVERWRITABLE.map(() => "?").join(", ");
    this.db.prepare(
      `UPDATE events SET disposition = ?, disposition_detail = ?, disposed_at = ?
       WHERE correlation_id = ? AND seq >= ?
         AND ((source = ? AND seq <= ?) OR kind = 'event.escalated')
         AND (disposition IS NULL OR disposition IN (${placeholders}))`,
    ).run(
      disposition, JSON.stringify(detail), this.now().toISOString(), `channel:${card.objectKey}`, card.firstSeq,
      card.source, card.lastSeq, ...OVERWRITABLE,
    );
    // 这张卡还排着、Lead 还没处理的消息事件（统一消息事件 spec D6，工单 10）：卡结束了，它也结束，Lead 不再处理。
    // 稍后再提醒不算结束，照旧排着。Lead 已经看过、处理过的不改。
    if (disposition === "deferred") return;
    this.db.prepare(
      `UPDATE events SET disposition = ?, disposition_detail = ?, disposed_at = ?
       WHERE kind = ? AND correlation_id = ? AND json_valid(payload) AND json_extract(payload, '$.cardId') = ? AND disposition IS NULL`,
    ).run(disposition, JSON.stringify(detail), this.now().toISOString(), MESSAGE_EVENT_KIND, `channel:${card.objectKey}`, card.id);
  }

  /**
   * 这张卡上最近一条发出去、还没被改写或撤回的状态消息（「正在处理」，落地计划 A3）的引用。没有时是 null。
   * 认法只看出站的记账：幂等键以 handling: 开头的是状态消息；改写（edit）和撤回（retract）过的引用算用掉了。
   */
  private openStatusMessage(cardId: number): Record<string, string> | null {
    return this.openStatusNotices(cardId).at(-1)?.remoteRef ?? null;
  }

  /** 这张卡上发出去、还没被改写或撤回的状态消息（旧的在前）：幂等键和引用。认法同 openStatusMessage。 */
  private openStatusNotices(cardId: number): Array<{ key: string; remoteRef: Record<string, string> }> {
    const rows = this.db.prepare(
      `SELECT payload FROM events WHERE source = 'system' AND kind = ? AND json_valid(payload) AND json_extract(payload, '$.cardId') = ?
       ORDER BY seq`,
    ).all(CHANNEL_EVENT_KINDS.outboundCompleted, cardId) as Array<{ payload: string }>;
    const keyOf = (ref: Record<string, string>) => JSON.stringify(Object.entries(ref).sort(([a], [b]) => a.localeCompare(b)));
    const notices: Array<{ key: string; remoteRef: Record<string, string> }> = [];
    const used = new Set<string>();
    for (const row of rows) {
      const payload = JSON.parse(row.payload) as { key?: unknown; action?: unknown; remoteRef?: Record<string, string> };
      if (!payload.remoteRef || typeof payload.key !== "string") continue;
      if (payload.key.startsWith("handling:") && payload.action === "reply") notices.push({ key: payload.key, remoteRef: payload.remoteRef });
      else if (payload.action === "edit" || payload.action === "retract") used.add(keyOf(payload.remoteRef));
    }
    return notices.filter((notice) => !used.has(keyOf(notice.remoteRef)));
  }

  /**
   * 「正在处理」该不该收掉：卡结束了（回复改写过的那条已经不算挂着）、你说会自己回、这张卡最新的工单交给你了（没有回复）。
   * 工单还在跑、回复正在发、草稿等你确认（你发出时改写它）时留着。
   */
  private noticeOutlived(card: ChannelCard): boolean {
    if (!(CHANNEL_CARD_OPEN_STATES as readonly ChannelCardState[]).includes(card.state)) return true;
    if (card.sent?.status === "pending" || this.sending.has(card.id)) return false;
    if (card.state === "replying_self") return true;
    const lookup = getLatestLookupForCard(this.db, card.id);
    if (!lookup || isActiveLookupState(lookup.state)) return false;
    return lookup.reply?.decision === "hand_over";
  }

  /** 删掉这张卡上已经不是真的「正在处理」（noticeOutlived）。同一个幂等键，删过的不再删；失败够了次数的不再试。不抛错。 */
  private async settleStatusNotices(cardId: number): Promise<void> {
    const card = getChannelCard(this.db, cardId);
    const adapter = card ? this.options.registry.get(card.source) : undefined;
    if (!card || !adapter?.capabilities.retract || !this.noticeOutlived(card)) return;
    const notices = this.openStatusNotices(card.id)
      .filter((notice) => this.outbox.failures(adapter.id, `retract:${notice.key}`) < this.maxAttempts);
    if (!notices.length) return;
    const context = await this.context(adapter);
    if (!context) return;
    for (const notice of notices) {
      const outcome = await this.outbox.perform(adapter, context, {
        key: `retract:${notice.key}`, purpose: "retract", cardId: card.id,
        request: { action: "retract", objectKey: card.objectKey, target: notice.remoteRef },
      });
      if (outcome.status === "failed") {
        this.log(`[channels] ${adapter.id}: could not delete the status message of card #${card.id}: ${outcome.error ?? "unknown"}`);
      }
    }
  }

  /** 每一拍：最近 24 小时发出去的「正在处理」里，还挂着、已经不是真的那些（删失败了、daemon 重启了）。有界、幂等。 */
  private async settleLeftoverNotices(): Promise<void> {
    const since = new Date(this.now().getTime() - DAY_MS).toISOString();
    const rows = this.db.prepare(
      `SELECT DISTINCT json_extract(payload, '$.cardId') AS cardId FROM events
       WHERE source = 'system' AND kind = ? AND occurred_at >= ? AND json_valid(payload)
         AND json_extract(payload, '$.action') = 'reply' AND json_extract(payload, '$.key') LIKE 'handling:%'
       LIMIT 200`,
    ).all(CHANNEL_EVENT_KINDS.outboundCompleted, since) as Array<{ cardId: number | null }>;
    for (const { cardId } of rows) {
      if (typeof cardId === "number") await this.settleStatusNotices(cardId);
    }
  }

  // ref：发出去的消息在来源里的编号。来源推回这条消息时，上下文包按它认出是同一条（文字可能换了格式）。
  private laneMessage(card: ChannelCard, role: "me" | "assistant", text: string, at: string, ref?: string): void {
    const lane = getChannelLaneById(this.db, card.laneId);
    if (!lane) return;
    const next = recordChannelLaneMessage(this.db, {
      source: card.source, objectKey: card.objectKey, label: lane.label,
      message: { at, seq: null, role, sender: role === "me" ? "你" : "系统代你", text, ...(ref ? { ref } : {}) },
    });
    this.refreshLaneSummary(next);
  }

  /**
   * 一条道的一行摘要（spec D10）：「<n> 条消息，卡 #<id> <状态>，<代查状态>」。只有结构化的事实，不带外部的原文，
   * 也不带发出去的文字：Lead 要看内容时用 read_channel_conversation 读对话。
   */
  private refreshLaneSummary(lane: ChannelLane): void {
    const card = listChannelCardsForObject(this.db, lane.objectKey).at(-1);
    let summary: string;
    if (!card) {
      summary = lane.context.length ? `只记录（${lane.context.length} 条消息），没有卡` : "没有消息";
    } else {
      summary = [
        `${card.messageCount} 条消息`,
        `卡 #${card.id} ${cardStateLabel(card)}`,
        lookupStateLabel(getLatestLookupForCard(this.db, card.id)),
      ].join("，");
    }
    const latest = this.latestMessageNote(lane, card);
    setChannelLaneSummary(this.db, lane.objectKey, latest ? `${summary}，${latest}` : summary, this.now());
  }

  // 别人发来的最新一条还没进卡时，它现在怎样（先判断要不要用户回，再开卡）：判断不用回、回了表情，或者还在判断。进了卡时是 null。
  private latestMessageNote(lane: ChannelLane, card: ChannelCard | undefined): string | null {
    const seq = [...lane.context].reverse().find((message) => message.role === "them" && message.seq !== null)?.seq ?? null;
    if (seq === null || (card && card.lastSeq >= seq)) return null;
    const skipped = this.db.prepare("SELECT 1 FROM events WHERE source = 'system' AND source_ref = ?").get(notNeededRef(seq));
    if (skipped) return "最新一条助手判断不用你回";
    const reacted = this.db.prepare(
      "SELECT json_extract(payload, '$.emoji') AS emoji FROM events WHERE source = 'system' AND source_ref = ? AND json_extract(payload, '$.action') = 'react'",
    ).get(authorityRef(seq));
    if (reacted) {
      const emoji = (reacted as { emoji?: unknown }).emoji;
      return `最新一条系统回了表情${typeof emoji === "string" ? ` :${emoji}:` : ""}，不用你回`;
    }
    const event = getEvent(this.db, seq);
    return event && pendingCardOf(event.payload) ? "最新一条正在判断要不要你回" : null;
  }

  private refreshLaneOf(card: Pick<ChannelCard, "laneId">): void {
    const lane = getChannelLaneById(this.db, card.laneId);
    if (lane) this.refreshLaneSummary(lane);
  }

  // note：Lead 写给用户的一句话（notify_user 的 title），代替原文摘录作为推送的正文。
  private pushCard(adapter: ChannelAdapter, card: ChannelCard, reason: "new" | "snooze" | "lookup", note: string | null = null): void {
    if (!this.options.push) return;
    if (reason !== "new" && card.delivery !== "push_card" && card.delivery !== "card") return;
    try {
      this.options.push({
        cardId: card.id,
        title: `${adapter.label} · ${card.sender.name}${reason === "snooze" ? "（稍后提醒）" : reason === "lookup" ? "（代查有结果）" : ""}`,
        body: note ? clipEventText(note, 300) : card.excerpt,
      });
    } catch (error) {
      this.log(`[channels] push for card #${card.id} failed: ${errorText(error)}`);
    }
  }

  private cardsChanged(ids: number[]): void {
    if (!ids.length) return;
    try {
      this.options.onCardsChanged?.(ids);
    } catch (error) {
      this.log(`[channels] cards-changed hook failed: ${errorText(error)}`);
    }
  }
}

// 请求 A 的事件的 source_ref：一条消息只判断一次。
const intakeRef = channelIntakeRef;
// 「不用回」的事件的 source_ref：一条消息只记一次（settleStalePendingCards 按它认出已经定了）。
const notNeededRef = (seq: number) => `channel-reply-not-needed:${seq}`;
// 授权表的决定（channel.authority.decided）：一条消息一个。
const authorityRef = (seq: number) => `channel-authority:${seq}`;
/** 请求 A 的 needs_reply 低于它时，新消息不开卡。 */
export const NO_REPLY_BELOW = 0.3;

// 事件里记的「还没开的卡」（record 的 cardPending：投递方式、回复的位置、记下的时间）。不是这个形状时是 null。
function pendingCardOf(payload: Record<string, unknown>): { delivery: ChannelDeliveryMode; replyTarget: Record<string, string> } | null {
  const pending = payload.cardPending as { delivery?: unknown; replyTarget?: unknown } | undefined;
  if (!pending || typeof pending !== "object") return null;
  if (pending.delivery !== "card" && pending.delivery !== "push_card") return null;
  const target = pending.replyTarget;
  if (!target || typeof target !== "object") return null;
  const replyTarget = Object.fromEntries(Object.entries(target as Record<string, unknown>).filter(([, value]) => typeof value === "string")) as Record<string, string>;
  return { delivery: pending.delivery, replyTarget };
}

// 这条消息自己在来源里的引用（payload 的 messageRef，回表情的目标）。没有或者不合格时是 null。
function messageRefOf(payload: Record<string, unknown> | undefined): Record<string, string> | null {
  const ref = payload?.messageRef;
  if (!ref || typeof ref !== "object" || Array.isArray(ref)) return null;
  const entries = Object.entries(ref as Record<string, unknown>);
  if (!entries.length || entries.some(([, value]) => typeof value !== "string")) return null;
  return Object.fromEntries(entries) as Record<string, string>;
}

// 授权表对一条消息的决定：请求 A 认出的意图、结论、依据（常设指令的编号和版本）。
interface AuthorityDecision {
  intent: ChannelIntent | null;
  action: AuthorityAction;
  order: { id: string; version: number };
  // 按交接说明的结论（handbook-decision.ts）：起作用的一句、压过它的上限或底线、Lead 的上限。
  handbook: HandbookDecision;
}

// 收件判断选的一句：编号在现在的交接说明里找（用户删了这一句时按兜底）；第 7 版以前的判断按旧意图对应的第一句。
function situationOfIntake(handbook: ChannelHandbook, picked: unknown, askKind: unknown): HandbookSituation {
  const byId = (id: string) => handbook.situations.find((situation) => situation.id === id);
  const fallback = byId(HANDBOOK_FALLBACK_ID)!;
  if (typeof picked === "string") return byId(picked) ?? fallback;
  const legacy = isChannelIntent(askKind) ? AUTHORITY_INTENT_SITUATIONS[askKind][0] : undefined;
  return (legacy ? byId(legacy) : undefined) ?? fallback;
}

const REPLY_CHECK_CACHE_MAX = 500;

const AUTHORITY_ACTION_LABELS: Record<AuthorityAction["kind"], string> = {
  skip: "不打扰", react: "回表情", refuse: "代你拒绝", remind: "提醒你", closing_reply: "代你说一句", work: "要干活", ask: "问你",
  tell: "告诉你",
};

// 库里的时间有两种写法：ISO（带 T 和时区），和 SQLite 的 datetime('now')（UTC 的 'YYYY-MM-DD HH:MM:SS'）。
function dbTime(value: string): number {
  return Date.parse(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? `${value.replace(" ", "T")}Z` : value);
}

// Lead 的决定的 source_ref：同一条消息的同一步只定一次。交回的结果（reply）按那一次交回定：重派以后又交回的结果是新的一次
// （2026-11-02）。以前的 reply 决定不带交回的编号（legacyReplyDecidedRef），照旧算数。
const leadDecidedRef = (stage: ChannelLeadStage, forSeq: number, seq: number) =>
  stage === "reply" ? `channel-lead-decided:reply:${forSeq}:${seq}` : `channel-lead-decided:${stage}:${forSeq}`;
const legacyReplyDecidedRef = (forSeq: number) => `channel-lead-decided:reply:${forSeq}`;
const pullRequestKey = (pr: { owner: string; repo: string; number: number }) => `${pr.owner}/${pr.repo}#${pr.number}`.toLowerCase();
// 同一条消息多派的一张工单（另一个 PR，或者交回以后重派以外的情况）：按 Run 记。
const extraDispatchRef = (forSeq: number, runId: number) => `channel-lead-dispatched:${forSeq}:run:${runId}`;
// 一条消息最多派这么多张子 agent 工单（每个 PR 一张，加上失败以后的重派）。再多就开普通工单。
export const CHANNEL_MAX_TASKS_PER_MESSAGE = 6;
// 派不了时 Lead 的下一步（AGENTS.md：新的拒绝要说 Lead 下一步做什么）。
const DISPATCH_NEXT_STEP = "下一步：要再查、再评，用 create_task 开一张普通工单（PR 评审用 template=pr_review），做完自己核对结果再回对方；"
  + "要先回对方一句，用 reply_to_source；要用户决定，用 notify_user";

/** 话里去掉一个 PR 的两种写法（github.com/<owner>/<repo>/pull/<n> 和 <owner>/<repo>#<n>），不分大小写。后面紧跟数字的不算同一个 PR。 */
function withoutPullRequest(text: string, pr: { owner: string; repo: string; number: number }): string {
  let rest = text;
  for (const form of [`github.com/${pr.owner}/${pr.repo}/pull/${pr.number}`, `${pr.owner}/${pr.repo}#${pr.number}`]) {
    const needle = form.toLowerCase();
    let out = "";
    let from = 0;
    // 按原文的位置比：整段转小写以后，个别字母的长度会变，位置就对不上了。
    for (let at = 0; at + needle.length <= rest.length; at += 1) {
      if (rest.slice(at, at + needle.length).toLowerCase() !== needle) continue;
      const next = rest.charAt(at + needle.length);
      if (next >= "0" && next <= "9") continue;
      out += `${rest.slice(from, at)} `;
      from = at + needle.length;
      at = from - 1;
    }
    rest = out + rest.slice(from);
  }
  return rest;
}
// 消息事件（统一消息事件 spec D1）：按来源、这条消息和并进来的最后一次编辑。并进一次编辑就是新的一条。
const messageEventRef = (source: string, seqs: readonly number[]) => `channel-message:${source}:${seqs[0]}:${seqs.at(-1)}`;
// 子 agent 工单的回调引用：结果交回时找到卡和消息。
const taskRef = (cardId: number, forSeq: number) => `card:${cardId}:seq:${forSeq}`;
const isGrantIntent = (value: unknown): value is GrantIntent => (GRANT_INTENTS as readonly unknown[]).includes(value);

// 读一个交给 Lead 的请求（统一消息事件工单 05）：消息事件（intake）或者交回 Lead 的子 agent 结果（reply）。不合格时是 null。
function leadRequestOf(seq: number, kind: string, raw: string): LeadRequest | null {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  const { cardId, forSeq } = payload;
  if (typeof cardId !== "number" || typeof forSeq !== "number") return null;
  if (kind === MESSAGE_EVENT_KIND) {
    const inbound = payload.inbound && typeof payload.inbound === "object" ? payload.inbound as Record<string, unknown> : {};
    const ceiling = payload.ceiling && typeof payload.ceiling === "object" ? payload.ceiling as Record<string, unknown> : {};
    if (typeof payload.source !== "string") return null;
    return {
      seq, event: seq, channel: payload.source, cardId, forSeq, stage: "intake", intent: isChannelIntent(inbound.intent) ? inbound.intent : null,
      action: typeof ceiling.authority === "string" ? ceiling.authority : "ask", reason: "",
      objects: Array.isArray(payload.objects) ? payload.objects as ChannelLeadObject[] : [],
      bound: ceiling.bound && typeof ceiling.bound === "object" ? ceiling.bound as IntentGrantBound : null,
      handbook: handbookOfCeiling(ceiling),
    };
  }
  if (typeof payload.channel !== "string") return null;
  return {
    seq, event: typeof payload.messageEvent === "number" ? payload.messageEvent : null, channel: payload.channel, cardId, forSeq,
    stage: "reply", intent: isChannelIntent(payload.intent) ? payload.intent : null,
    action: typeof payload.decision === "string" ? payload.decision : "ask_user", reason: typeof payload.reason === "string" ? payload.reason : "",
    objects: [], bound: null, handbook: null,
  };
}

// 消息事件的权限上限里交接说明的部分（同 channel.situation.repicked 的 payload）。没有时是 null。
function handbookOfCeiling(ceiling: Record<string, unknown>): LeadRequest["handbook"] {
  const situation = ceiling.situation && typeof ceiling.situation === "object" ? ceiling.situation as Record<string, unknown> : null;
  if (!situation || typeof situation.id !== "string" || !isHandbookMode(ceiling.final)) return null;
  const abilities = Array.isArray(ceiling.abilities)
    ? ceiling.abilities.filter((ability): ability is HandbookAbility => (HANDBOOK_ABILITIES as readonly unknown[]).includes(ability)) : [];
  return {
    situation: { id: situation.id, text: typeof situation.text === "string" ? situation.text : situation.id }, final: ceiling.final, abilities,
    ruleChange: ceiling.ruleChange === true,
  };
}

// Lead 自己写的回复能不能直接发（用户 2026-10-30 定 D2）：只有放手可以。婉拒只能发固定的拒绝（refuseForLead 另有检查）。
const replyAllowed = (final: HandbookMode): boolean => final === "auto";

// 交给 Lead 的消息事件里写的下一步（按授权表的结论，只是建议）：Lead 能用的通用工具（统一消息事件 spec D6、D8，工单 05）。
function leadNextStep(action: string): string {
  const draft = "推给用户、告诉用户时都要带你写的草稿（闲聊也一样）";
  switch (action) {
    case "work":
      return "要干活：缺省用 dispatch_agent_task 派子 agent（event 填这条消息事件；权限由代码按授权表算，你只能收窄；"
        + "链接不在这条消息里时先看上下文包，补上 PR 或仓库），不要推给用户；派完活不用再 record_disposition，卡等结果交回再结束；"
        + "你自己就能答准的用 reply_to_source 回复；"
        + `真要用户决定的用 notify_user 推给他，${draft}`;
    case "react":
    case "closing_reply":
      return "收尾的消息：先看上下文包里前面说了什么，再定：react_channel_message（event 填这条消息事件）回一个合适的表情，"
        + "建议的可以换（例如用户刚请对方帮忙、对方答应了，回 heart）；或者 reply_to_source 代用户说一句；不用回的用 record_disposition（no_action）";
    case "refuse":
      return "授权表认为对方在要敏感信息。先看原话：真是在要敏感信息，用 reply_to_source（refusal=true，不写 text）用固定的话拒绝，"
        + "再告诉用户（在会话里说一句；用户不在、事情要紧时用 notify_user，不带 event）；不要自己写拒绝的话。"
        + `只是提到用户的电脑、提醒用户做事的，照常处理。${draft}`;
    case "tell":
      return "对方多半在接着回答用户刚在这个对话里说的话，用户在等这个答案：在用户的对话里转告他，"
        + `再用 record_disposition（told_user）记下；这一条不能派活。${draft}`;
    default:
      return "你能做的直接做（例如照对方说的给别人发消息），做完用 reply_to_source 回复对方；要用户决定的用 notify_user 推给他，"
        + `或者在会话里告诉他再用 record_disposition（told_user）记下；不用回的用 record_disposition（no_action）。${draft}`;
  }
}

const pctText = (value: number | null) => (value === null ? "?" : `${Math.round(value * 100)}%`);

// 派了活还没交回时给 Lead 的说明（record_disposition、回复、回表情的结果里）。
function awaitingTaskNote(cardId: number, task: { itemId: number | null; runId: number }): string {
  return `卡 #${cardId} 已经派了活（子 agent 工单 ${task.itemId ? `#${task.itemId}` : `Run #${task.runId}`}），卡等结果交回再结束：`
    + "结果交回以后，信心够就代用户回复，不够会交给你";
}

function intakeSummary(result: ChannelIntakeResult): string {
  if (result.status !== "answered") return "收件判断没有做成（快模型不可用、超时或出错），不代查";
  const rules = result.ruleChange !== null && result.ruleChange >= CHANNEL_RULE_CHANGE_FLAG
    ? `，${channelRuleChangeNotice(result.ruleChangeKinds, "zh")}` : "";
  const by = result.fallback ? `，决策模型没有回答（${clipEventText(result.fallback.reason, 80)}），由 ${result.backend ?? "LLM"} 判断` : "";
  return `收件判断：按「${result.situation}」（意图 ${result.askKind}，置信度 ${pctText(result.askConfidence)}）`
    + `${result.target ? `，仓库 ${result.target.repo}` : ""}${rules}${by}`;
}

function replySummary(decision: string, requester: string, reasons: readonly string[]): string {
  const head = decision === "auto_send" ? `代查的结果可以自动回复${requester}`
    : decision === "ask_user" ? `代查的结果放在卡上，等你决定怎样回复${requester}`
    : `代查没有查到（或者失败），交给你回复${requester}`;
  return reasons.length ? `${head}：${reasons.slice(0, 3).join("；")}` : head;
}

// 卡的状态（道的一行摘要用，不带原文）。
function cardStateLabel(card: ChannelCard): string {
  switch (card.state) {
    case "open":
      return `在${CHANNEL_DELIVERY_LABELS[card.delivery]}里等用户处理${card.draft ? "（已附草稿）" : ""}`;
    case "snoozed":
      return `用户选了稍后（${card.snoozedUntil ? clock(card.snoozedUntil) : ""} 再提醒）`;
    case "replying_self":
      return card.resolution?.action === "replied_in_source" ? "用户在来源里回复过，卡还开着" : "用户说会自己回复";
    case "replied":
      return "用户已回复";
    case "auto_replied":
      return `系统已代回${card.revokeUntil ? `（${clock(card.revokeUntil)} 前可以撤回）` : ""}`;
    case "resolved_elsewhere":
      return "用户已经在来源里回答了，卡已结束";
    case "dismissed":
      return "用户选了不回复";
    case "handled":
      return "卡上的事已经照用户的话做完";
    case "left_to_user":
      return "用户说会自己回复，卡已结束";
  }
}

// 代查的状态（道的一行摘要用）。
function lookupStateLabel(lookup: ChannelLookup | undefined): string {
  if (!lookup) return "没有代查";
  switch (lookup.state) {
    case "queued": return `代查 #${lookup.id} 排队中`;
    case "running": return `代查 #${lookup.id} 进行中`;
    case "denied": return "没有代查";
    case "cancelled": return `代查 #${lookup.id} 已停止`;
    case "failed": return `代查 #${lookup.id} 失败`;
    case "finished": {
      const decision = lookup.reply?.decision;
      const found = lookup.result?.found === "yes" ? "查到了" : lookup.result?.found === "partial" ? "查到一部分" : "没查到";
      if (decision === "auto_send") return `代查 #${lookup.id} ${found}，已按信心代回`;
      if (decision === "ask_user") return `代查 #${lookup.id} ${found}，结果和草稿在卡上等用户决定`;
      if (decision === "hand_over") return `代查 #${lookup.id} ${found}，交给用户`;
      return `代查 #${lookup.id} ${found}，正在核对`;
    }
  }
}

// 动作的记账要在事务里：appendEvent 只能在调用方的事务里运行。
function recordActionInTransaction(db: Db, write: () => unknown): void {
  db.transaction(write)();
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// 存进卡里的署名和正文：和 text 一样截断（正文最多 CHANNEL_CARD_TEXT_MAX + 200 个字，署名一行最多 300 个字）。
// 把一条要发出去的回复里的邮箱脱敏：完整的一条和正文都要（署名里没有邮箱）。
function maskOutgoing(outgoing: OutgoingReply): { text: string; parts?: OutgoingReply["parts"]; masked: number } {
  const text = maskEmails(outgoing.text);
  const body = outgoing.parts?.body ? maskEmails(outgoing.parts.body) : null;
  return {
    text: text.text,
    ...(outgoing.parts ? { parts: { byline: outgoing.parts.byline, body: body ? body.text : outgoing.parts.body } } : {}),
    masked: text.masked,
  };
}

function clipParts(parts: { byline: string; body: string | null }): { byline: string; body: string | null } {
  return { byline: clipEventText(parts.byline, 300), body: parts.body === null ? null : clipEventText(parts.body, CHANNEL_CARD_TEXT_MAX + 200) };
}

export function createChannelHub(options: ChannelHubOptions): ChannelHub {
  return new ChannelHub(options);
}

