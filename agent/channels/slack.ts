import { connectSlackCredentials } from "@vercel/connect/eve";
import {
  type SlackContext,
  type SlackMessage,
  slackChannel,
} from "eve/channels/slack";

/**
 * Vercel Connect connector UID for the Slack app, resolved to credentials.
 *
 * @remarks
 * One source of truth for the connector, so this channel and any tool that calls the Slack Web API
 * directly share a single bot installation. The token is resolved fresh from Vercel Connect on each
 * call, so rotation is handled server-side and nothing is stored here.
 *
 * @defaultValue `"slack/marketing-team"`, the UID `vercel connect create slack --name
 * marketing-team --triggers` produces (UIDs are `<type>/<name>`). Override with the
 * `SLACK_CONNECTOR` environment variable when your connector uses a different name.
 */
const slackCredentials = connectSlackCredentials(
  process.env.SLACK_CONNECTOR ?? "slack/marketing-team"
);

/**
 * Builds the session auth context from an inbound Slack message.
 *
 * Replaces eve's default derivation, which attaches no auth at all when it
 * cannot parse the message author (common on the Connect webhook payload
 * path, where the author is dropped and messages arrive as
 * `sender_type: unknown`). Tools rely on these attributes to link back to
 * the requester's thread, so the channel and thread coordinates are always
 * stamped; the author is taken from the parsed message when present, with
 * a fallback to the raw event's `user` field.
 */
function slackSessionAuth(message: SlackMessage, onBehalfOfUserId?: string) {
  const rawUser = message.raw.user;
  const userId =
    message.author?.userId ??
    (typeof rawUser === "string" ? rawUser : undefined) ??
    onBehalfOfUserId;
  return {
    attributes: {
      channel_id: message.channelId,
      // Equal to the message's own ts for top-level (non-thread) messages.
      thread_ts: message.threadTs || message.ts,
      ...(userId ? { user_id: userId } : {}),
      ...(message.author?.userName
        ? { user_name: message.author.userName }
        : {}),
      ...(message.teamId ? { team_id: message.teamId } : {}),
    },
    authenticator: "slack-webhook",
    issuer: message.teamId ? `slack:${message.teamId}` : "slack",
    principalId: userId ? `slack:${userId}` : "slack:unknown",
    principalType:
      message.author?.isBot && !onBehalfOfUserId ? "service" : "user",
  };
}

/**
 * This bot's own Slack user ID, resolved once per warm instance via
 * `auth.test`. `undefined` means not yet fetched; failures are not cached so
 * the next message retries.
 */
let cachedBotUserId: string | undefined;

async function resolveBotUserId(
  ctx: SlackContext
): Promise<string | undefined> {
  if (cachedBotUserId) {
    return cachedBotUserId;
  }
  try {
    const res = (await ctx.slack.request("auth.test", {})) as {
      ok?: boolean;
      user_id?: string;
    };
    if (res.ok && res.user_id) {
      cachedBotUserId = res.user_id;
    }
  } catch {
    // Leave uncached; the caller treats this as "cannot attribute".
  }
  return cachedBotUserId;
}

/**
 * First user mentioned in `text` other than the bot itself, or `undefined`.
 * Slack renders mentions as `<@U…>` / `<@W…>` (optionally `<@U…|name>`).
 */
function firstHumanMention(
  text: string,
  botUserId: string
): string | undefined {
  for (const match of text.matchAll(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g)) {
    if (match[1] !== botUserId) {
      return match[1];
    }
  }
}

/**
 * For messages with no human author — Slack Workflow posts that tag the
 * agent to kick off a request — attribute the session to the first user the
 * message mentions besides the bot. Workflow templates must therefore
 * mention the submitter (the "person who submitted" variable) alongside the
 * agent mention; without one, the session stays anonymous and user-scoped
 * connections (e.g. Notion) cannot deliver their sign-in prompt.
 */
async function resolveOnBehalfOfUserId(
  ctx: SlackContext,
  message: SlackMessage
): Promise<string | undefined> {
  if (message.author && !message.author.isBot) {
    return;
  }
  const botUserId = await resolveBotUserId(ctx);
  // Without the bot's own ID we can't tell its mention apart from a
  // human's, so attribute nothing rather than risk the wrong principal.
  if (!botUserId) {
    return;
  }
  return firstHumanMention(message.text, botUserId);
}

async function handleInbound(ctx: SlackContext, message: SlackMessage) {
  try {
    await ctx.thread.startTyping("Thinking...");
  } catch {
    // Typing indicator is a nicety, never a reason to drop the message.
  }
  return {
    auth: slackSessionAuth(
      message,
      await resolveOnBehalfOfUserId(ctx, message)
    ),
  };
}

/**
 * Whether `message.author` is the only human who has ever posted in this
 * thread. Used to keep auto-replies in subscribed threads scoped to the
 * original requester: once anyone else participates, un-mentioned replies
 * stop dispatching, and an explicit @mention remains the way to re-engage.
 *
 * `listParticipants` returns the thread's unique human user ids in
 * first-appearance order, with bot and system messages already excluded, so
 * a single entry matching the author is the whole test.
 *
 * Two limits are worth knowing, because both resolve toward replying rather
 * than staying quiet. It observes at most the first 50 messages of a thread,
 * so a second human who only appears after that is not seen. And a failed
 * refresh keeps the last successful snapshot instead of erroring, so the
 * list can be stale. A thread whose refresh has never succeeded returns an
 * empty list, which fails closed here.
 */
async function isSoleThreadParticipant(
  ctx: SlackContext,
  message: SlackMessage
): Promise<boolean> {
  const authorId = message.author?.userId;
  if (!authorId) {
    return false;
  }
  const participants = await ctx.thread.listParticipants();
  return participants.length === 1 && participants[0] === authorId;
}

/**
 * Slack channel: answers @mentions and DMs, replies in threads, and renders approvals as buttons.
 *
 * @remarks
 * Credentials are brokered by Vercel Connect through the shared {@link slackCredentials}, which
 * supplies both the outbound bot token and inbound webhook verification — there are no Slack
 * secrets to manage in code. Create the connector with
 * `vercel connect create slack --name <name> --triggers`, then register this project's trigger
 * destination at `/eve/v1/slack`.
 *
 * @defaultValue The connector UID falls back to `"slack/marketing-team"` when `SLACK_CONNECTOR` is
 * unset.
 */
export default slackChannel({
  credentials: slackCredentials,
  onAppMention: handleInbound,
  onDirectMessage: handleInbound,
  /**
   * Un-mentioned channel messages (mentions and DMs never reach here — the
   * specialized handlers above take precedence). Auto-reply only in threads
   * with an active session, and only while the original requester is the
   * sole human participant; anyone else joining silences auto-replies, and
   * an explicit @mention remains the way to re-engage.
   */
  async onMessage(ctx, message) {
    if (message.author?.isBot) {
      return null;
    }
    if (!(await ctx.isSubscribed())) {
      return null;
    }
    if (!(await isSoleThreadParticipant(ctx, message))) {
      return null;
    }
    return handleInbound(ctx, message);
  },
  threadContext: { since: "thread-root" },
});
