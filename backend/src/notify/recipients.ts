/**
 * Resolve an email channel's recipients to a deduped list of addresses (Phase 16D-2a). Pure.
 *
 * A channel names recipients two ways: `recipients` (inline) and `groups` (names into
 * `NotifyConfig.groups`). Each recipient is a literal `email` or a `user` reference — a username
 * whose address is looked up in the users collection via the injected (async) resolver, and
 * **skipped if that user has no email**. Recipients only matter for the `email` channel; HTTP
 * channels target a URL and never call this.
 */
import type { NotifyChannelConfig, NotifyConfig, NotifyRecipient } from "@navfleet/shared";

export const resolveRecipients = async (
  channel: Pick<NotifyChannelConfig, "recipients" | "groups">,
  groups: NotifyConfig["groups"],
  resolveUserEmail: (username: string) => Promise<string | null>,
): Promise<string[]> => {
  const groupMap = groups ?? {};
  const refs: NotifyRecipient[] = [
    ...(channel.recipients ?? []),
    ...(channel.groups ?? []).flatMap((name) => groupMap[name] ?? []),
  ];

  const out = new Set<string>();
  for (const ref of refs) {
    if (ref.email && ref.email.trim()) {
      out.add(ref.email.trim());
    } else if (ref.user) {
      const email = await resolveUserEmail(ref.user);
      if (email && email.trim()) {
        out.add(email.trim());
      }
    }
  }
  return [...out];
};
