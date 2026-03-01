/**
 * Slack channel — bridges scene events to a Slack channel via Socket Mode
 * and forwards Slack messages back to the PTY as text input.
 *
 * @module
 */

import { App } from "@slack/bolt";
import { parseSceneInput } from "../../scene/interface.ts";
import { Scheduler } from "../../util/scheduler.ts";
import type { Channel, Frame, SendSceneInput } from "../interface.ts";
import { applySceneEvent, emptyPostState, type PendingOp, type PostState } from "./state.ts";

/** Options for creating a {@link SlackChannel}. */
export interface SlackChannelOptions {
  /** Slack app-level token (`xapp-…`) for Socket Mode. */
  appToken: string;
  /** Slack bot token (`xoxb-…`) for Web API calls. */
  botToken: string;
  /** Slack channel ID to post messages to. */
  channel: string;
  /** Message `ts` — confine both listening and posting to this thread. */
  thread?: string;
  /**
   * User ID filter. `["*"]` allows all users. `["!U123"]` denies `U123`.
   * Other entries are an allow-list of user IDs.
   */
  allowUsers: string[];
  /** Whether to accept messages from other bot users. Messages from self are always ignored. Defaults to `false`. */
  allowOtherBots: boolean;
  /** Require bot @mention to accept input; mention prefix is stripped before forwarding. */
  requireMention: boolean;
  /** Whether to forward echo messages (user input echoed by the TUI). Defaults to `false`. */
  echo: boolean;
  /** Bot user ID (`U…`). When provided, skips the `auth.test` API call at start. */
  botUser?: string;
}

/**
 * Bidirectional Slack channel using Socket Mode.
 *
 * Posts formatted scene events to a Slack channel via `chat.postMessage`
 * and injects user messages from Slack into the PTY as text input.
 * Supports streaming updates via `chat.update` and indicator display.
 */
export class SlackChannel implements Channel {
  readonly name = "slack";
  private readonly options: SlackChannelOptions;
  private app: App | null = null;
  private send: SendSceneInput | null = null;

  /** Pure output state (lastPost + pending ops). */
  private state: PostState = emptyPostState;
  /** Slack message `ts` of the most recently posted message (set after API success). */
  private currentTs: string | null = null;
  private readonly scheduler: Scheduler;
  /** In-flight API operation promise, if any. */
  private runningOp: Promise<void> | null = null;

  /** Cached bot user ID (resolved via `auth.test` at start). */
  private botUserId: string | null = null;

  /**
   * Create a new SlackChannel.
   *
   * @param options - Slack connection configuration
   */
  constructor(options: SlackChannelOptions) {
    this.options = options;
    this.scheduler = new Scheduler({
      debounceMs: 100,
      minIntervalMs: 1000, // adjust to rate limit
      callback: () => this.run(),
    });
  }

  /**
   * Initialize the Slack Bolt app, register message listeners,
   * and open the Socket Mode WebSocket connection.
   *
   * @param send - Callback for injecting text input into the PTY
   */
  async start(send: SendSceneInput | null): Promise<void> {
    this.send = send;

    this.app = new App({
      token: this.options.botToken,
      appToken: this.options.appToken,
      socketMode: true,
    });

    // Resolve bot user ID before opening the socket so the self-message
    // filter is active from the very first message.
    if (this.options.botUser) {
      this.botUserId = this.options.botUser;
    } else {
      try {
        const authResult = await this.app.client.auth.test();
        this.botUserId = (authResult.user_id as string) ?? null;
      } catch (error: unknown) {
        console.error(
          `[haruna][${this.name}] failed to resolve bot user ID: ${error instanceof Error ? error.message : error}`,
        );
      }
    }

    if (this.options.requireMention && !this.botUserId) {
      console.error(
        `[haruna][${this.name}] requireMention is enabled but bot user ID is unknown; all messages will be rejected`,
      );
    }

    const targetChannel = this.options.channel;
    const targetThread = this.options.thread;

    this.app.message(async ({ message }) => {
      // Skip subtypes (edits, joins, etc.)
      if (message.subtype) return;
      if (!("text" in message) || !message.text) return;
      // Only relay messages from the configured channel
      if (message.channel !== targetChannel) return;

      // Thread filter: when thread is set, only accept messages in that thread
      if (targetThread) {
        const msgThreadTs = "thread_ts" in message ? (message.thread_ts as string) : undefined;
        const msgTs = "ts" in message ? (message.ts as string) : undefined;
        if (msgThreadTs !== targetThread && msgTs !== targetThread) return;
      }

      // User filter
      const userId = "user" in message ? (message.user as string) : undefined;
      const hasBotId = "bot_id" in message && !!message.bot_id;

      // Always ignore messages from self
      if (this.botUserId && userId === this.botUserId) return;

      // Bot filter (other bots only — self is already excluded above)
      if (!this.options.allowOtherBots && hasBotId) return;

      if (!this.isUserAllowed(userId)) return;

      let text = message.text;

      // Mention filter
      if (
        this.options.requireMention &&
        !(this.botUserId && text.includes(`<@${this.botUserId}>`))
      ) {
        return;
      }

      text = text.replace(new RegExp(`<@${this.botUserId}>\\s*`, "g"), "").trim();
      if (!text) return;

      const input = parseSceneInput({ type: "text", content: text });
      if (input) this.send?.(input);
    });

    await this.app.start();
  }

  /**
   * Close the Socket Mode WebSocket connection and release resources.
   */
  async stop(): Promise<void> {
    while (this.state.pendingOps.length > 0 || this.runningOp) {
      this.scheduler.flush();
      if (this.runningOp) await this.runningOp;
    }
    this.scheduler.dispose();
    await this.app?.stop();
    this.app = null;
    this.send = null;
    this.state = emptyPostState;
    this.currentTs = null;
    this.botUserId = null;
  }

  /**
   * Format and post scene events to the Slack channel.
   *
   * Handles `message_created`, `last_message_updated`, and `indicator_changed`
   * events with proper state tracking for streaming updates.
   * Other formattable events are posted as new messages.
   *
   * @param frame - The frame containing events to post
   */
  receive(frame: Frame): void {
    for (const event of frame.events) {
      this.state = applySceneEvent(this.state, event, this.options.echo);
    }
    if (this.state.pendingOps.length > 0) this.scheduler.schedule();
  }

  /**
   * Kick off processing the next operation. Guards against re-entry;
   * after the operation completes, re-schedules if more ops remain.
   */
  private run(): void {
    if (this.runningOp) return;
    const [op, ...rest] = this.state.pendingOps;
    if (!op) return;
    this.state = { ...this.state, pendingOps: rest };
    this.runningOp = this.executeOp(op).finally(() => {
      this.runningOp = null;
      if (this.state.pendingOps.length > 0) this.scheduler.schedule();
    });
  }

  /**
   * Execute a single API operation against the Slack client.
   *
   * @param op - The operation to execute
   */
  private async executeOp(op: PendingOp): Promise<void> {
    const client = this.app?.client;
    if (!client) return;

    switch (op.type) {
      case "post": {
        try {
          const res = await client.chat.postMessage({
            channel: this.options.channel,
            ...(this.options.thread && { thread_ts: this.options.thread }),
            blocks: op.message.blocks,
            text: op.message.text,
          });
          this.currentTs = (res.ts as string) ?? null;
        } catch (error: unknown) {
          console.error(
            `[haruna][${this.name}] failed to post message: ${error instanceof Error ? error.message : error}`,
          );
        }
        break;
      }
      case "update": {
        if (!this.currentTs) break;
        try {
          await client.chat.update({
            channel: this.options.channel,
            ts: this.currentTs,
            blocks: op.message.blocks,
            text: op.message.text,
          });
        } catch (error: unknown) {
          console.error(
            `[haruna][${this.name}] failed to update message: ${error instanceof Error ? error.message : error}`,
          );
        }
        break;
      }
      case "delete": {
        if (!this.currentTs) break;
        try {
          await client.chat.delete({
            channel: this.options.channel,
            ts: this.currentTs,
          });
        } catch (error: unknown) {
          console.error(
            `[haruna][${this.name}] failed to delete message: ${error instanceof Error ? error.message : error}`,
          );
        }
        this.currentTs = null;
        break;
      }
    }
  }

  /**
   * Check whether a user ID passes the `allowUsers` filter.
   *
   * - `["*"]` allows all users.
   * - `["!U123"]` denies `U123` (deny entries start with `!`).
   * - Other entries form an allow-list; only listed IDs are accepted.
   *
   * @param userId - The Slack user ID, or `undefined` for messages without a user
   * @returns `true` if the user is allowed
   */
  private isUserAllowed(userId: string | undefined): boolean {
    const rules = this.options.allowUsers;
    if (userId && rules.includes(`!${userId}`)) return false;
    if (rules.includes("*")) return true;
    return !!(userId && rules.includes(userId));
  }
}
