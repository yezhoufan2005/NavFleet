/**
 * 告警外发的共享契约（Phase 16D-1）。
 *
 * 这里只放**两个前端也会渲染的形状** —— 生效渠道概览（只读「外发」页，16D-2）与发送记录。
 * 路由选择、渠道正文构造、重试与真正的出站发送都是**后端独有**逻辑，留在 `backend/src/notify/`，
 * 不进这个两个前端都 import 的包（同 `PublicUser` 与 `UserRecord` 的分家理由：把只有服务端用得上
 * 的东西放进来，等于邀请前端去够它）。
 *
 * **红线（照搬 Alertmanager 那批立的规矩）**：出厂零配置 = 不外发、也不编造成功。
 * `DEFAULT_NOTIFY_CONFIG` 的 `channels` 是空的，所以没有 `notify.json` 的部署一条都不会发。渠道的
 * 端点 URL（企业微信/钉钉群机器人 URL 本身就含密钥）**不落在这里、也不落在 `notify.json`**：配置里只
 * 记一个环境变量名 `urlEnv`，真正的 URL 由后端在发送时从 env 取。配置目录对进程可读、会热重载并记
 * 日志，密钥绝不该待在那儿。
 */

import type { Severity } from "./index";
import type { RuleScope } from "./alertRules";

/**
 * 内建的出站渠道类型。三者都是「HTTP POST 一个 JSON」，用全局 `fetch` 即可，无需新依赖。邮件
 * （nodemailer 直连 SMTP）是 16D-2 的事，届时并入这个联合。
 */
export type NotifyChannelType = "webhook" | "wecom" | "dingtalk";

/** 出站渠道类型的全集，供校验与 UI 遍历（顺序即展示顺序）。 */
export const NOTIFY_CHANNEL_TYPES: readonly NotifyChannelType[] = [
  "webhook",
  "wecom",
  "dingtalk",
];

/** 严重度全集，供「渠道订阅哪些严重度」的默认与校验使用（与 `Severity` 保持同步）。 */
export const NOTIFY_SEVERITIES: readonly Severity[] = [
  "critical",
  "warning",
  "notice",
];

/**
 * 一个出站渠道的配置（`notify.json` 的一条）。
 *
 * `severities` 决定这个渠道接收哪些严重度的告警——文件里缺省=全部三档，显式列则只发所列（想让一个
 * 渠道只收 critical 就写 `["critical"]`）。`scope` 复用规则引擎的作用范围语义：缺省/空=全车队，列了
 * 就按设备/编队/标签的并集匹配。
 */
export interface NotifyChannelConfig {
  /** 部署内唯一，用于发送记录归集与只读页展示。 */
  id: string;
  type: NotifyChannelType;
  /** 停用的渠道永不发送，也不产生发送记录。 */
  enabled: boolean;
  /**
   * 持有端点 URL 的**环境变量名**（不是 URL 本身）。发送时后端读 `process.env[urlEnv]`；该变量为空
   * 视为该渠道未就绪——静默跳过、不发也不记一条失败（只读页的 `configured` 会显示未就绪）。
   */
  urlEnv: string;
  /** 接收哪些严重度。解析后总是完整数组；空数组=什么都不发（显式停订）。 */
  severities: Severity[];
  /** 接收哪些设备的告警。缺省/空=全车队。 */
  scope?: RuleScope;
}

export interface NotifyConfig {
  channels: NotifyChannelConfig[];
}

/** 出厂默认：**没有渠道**。这是「零配置不外发」红线的落点。 */
export const DEFAULT_NOTIFY_CONFIG: NotifyConfig = { channels: [] };

/**
 * 一次发送尝试的结局。只记真正发起过 HTTP 的尝试：`sent`（2xx）与 `failed`（超时/网络错/非 2xx，且
 * 已用尽重试）。「渠道启用但 env 未配」不发也不记——那是配置状态，由只读页的 `configured` 表达，不该
 * 每来一条告警就往记录里灌一条噪声。
 */
export type NotifySendStatus = "sent" | "failed";

/** 一条发送记录（`notify_log` 集合的一行；只读「外发」页与可观测性据此渲染）。 */
export interface NotifySendRecord {
  /** ISO-8601 发送时刻。 */
  ts: string;
  /** `${deviceId}:${alertId}`，与 `StoredAlert.eventKey` 同构，便于回链告警。 */
  eventKey: string;
  channelId: string;
  channelType: NotifyChannelType;
  deviceId: string;
  alertId: string;
  severity: string;
  title: string;
  status: NotifySendStatus;
  /** 末次尝试的 HTTP 状态码；从未拿到响应（网络错/超时）时为 null。 */
  httpStatus: number | null;
  /** 实际发起的尝试次数（含重试）。 */
  attempts: number;
  /** 末次尝试耗时（毫秒）；无则 null。 */
  latencyMs: number | null;
  /** 失败原因摘要；成功为 null。 */
  error: string | null;
}

/**
 * 只读「外发」页展示的生效渠道视图——`NotifyChannelConfig` 去掉 `urlEnv`、补一个 `configured`
 * 布尔。**永不携带 URL**：只告诉运维「这个渠道启用了、且它的端点 env 配好了」，不泄露含密钥的地址。
 */
export interface NotifyChannelView {
  id: string;
  type: NotifyChannelType;
  enabled: boolean;
  severities: Severity[];
  scope?: RuleScope;
  /** `urlEnv` 指向的环境变量是否已设为非空值。 */
  configured: boolean;
}
