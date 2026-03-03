/**
 * Discord channel — bridges scene events to a Discord text channel
 * and forwards Discord messages back to the PTY as text input.
 *
 * @module
 */

import { Client, Events, GatewayIntentBits, type Message } from "discord.js";
import { parseSceneInput, type SceneInput } from "../../scene/interface.ts";
import { SequentialQueue } from "../../util/async.ts";
import { Scheduler } from "../../util/scheduler.ts";
import type { Channel, Frame, SendSceneInput } from "../interface.ts";
import { applySceneEvent, emptyPostState, type PendingOp, type PostState } from "../post-state.ts";
import { type DiscordMessage, discordFormatter } from "./formatting.ts";

/** Maps Unicode number emoji to their numeric values (1–9). */
const emojiToNumber: Record<string, number> = {
  "1️⃣": 1,
  "2️⃣": 2,
  "3️⃣": 3,
  "4️⃣": 4,
  "5️⃣": 5,
  "6️⃣": 6,
  "7️⃣": 7,
  "8️⃣": 8,
  "9️⃣": 9,
};

/** Options for creating a {@link DiscordChannel}. */
export interface DiscordChannelOptions {
  /** Discord bot token. */
  token: string;
  /** Discord channel ID (text channel or thread). */
  channel: string;
  /**
   * User ID filter. `["*"]` allows all users. `["!123"]` denies `123`.
   * Other entries are an allow-list of user IDs.
   */
  allowUsers: string[];
  /** Whether to accept messages from other bots. Messages from self are always ignored. Defaults to `false`. */
  allowOtherBots: boolean;
  /** Require bot @mention to accept input; mention prefix is stripped before forwarding. */
  requireMention: boolean;
  /** Whether to forward echo messages (user input echoed by the TUI). Defaults to `false`. */
  echo: boolean;
}

/**
 * Bidirectional Discord channel using discord.js.
 *
 * Posts formatted scene events to a Discord text channel and injects
 * user messages from Discord into the PTY as text input.
 * Supports streaming updates via message editing and indicator display.
 */
export class DiscordChannel implements Channel {
  readonly name = "discord";
  private readonly options: DiscordChannelOptions;
  private client: Client | null = null;
  private send: SendSceneInput | null = null;

  /** Pure output state (lastPost + pending ops). */
  private state: PostState<DiscordMessage> = emptyPostState<DiscordMessage>();
  /** Discord message ID of the most recently posted message (set after API success). */
  private currentMessageId: string | null = null;
  /** Cached Discord message object for editing/deleting. */
  private currentMessage: Message | null = null;
  private readonly scheduler: Scheduler;
  private readonly opQueue: SequentialQueue;

  /** Cached bot user ID (resolved from client.user at ready). */
  private botUserId: string | null = null;

  /**
   * Create a new DiscordChannel.
   *
   * @param options - Discord connection configuration
   */
  constructor(options: DiscordChannelOptions) {
    this.options = options;
    this.scheduler = new Scheduler({
      debounceMs: 100,
      minIntervalMs: 1000,
      callback: () => this.run(),
    });
    this.opQueue = new SequentialQueue({
      onError: (e) =>
        console.error(`[haruna][${this.name}] op failed: ${e instanceof Error ? e.message : e}`),
    });
  }

  /**
   * Initialize the Discord client, register event listeners,
   * and log in with the bot token.
   *
   * @param send - Callback for injecting text input into the PTY
   */
  async start(send: SendSceneInput | null): Promise<void> {
    this.send = send;

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions,
      ],
    });

    const client = this.client;
    const readyPromise = new Promise<void>((resolve) => {
      client.once(Events.ClientReady, (readyClient) => {
        this.botUserId = readyClient.user.id;
        resolve();
      });
    });

    const targetChannel = this.options.channel;

    this.client.on(Events.MessageReactionAdd, (reaction, user) => {
      if (reaction.message.channelId !== targetChannel) return;
      if (reaction.message.id !== this.currentMessageId) return;

      const lastPost = this.state.lastPost;
      if (lastPost?.type !== "question" && lastPost?.type !== "permission") return;

      const emoji = reaction.emoji.name;
      if (!emoji) return;
      const num = emojiToNumber[emoji];
      if (num === undefined || num > lastPost.optionCount) return;

      if (this.botUserId && user.id === this.botUserId) return;
      if (!this.isUserAllowed(user.id)) return;

      this.send?.({ type: "select", index: num - 1 });
    });

    this.client.on(Events.MessageCreate, (message) => {
      if (message.system) return;
      if (message.channelId !== targetChannel) return;
      if (!message.content) return;

      const userId = message.author.id;

      // Always ignore messages from self
      if (this.botUserId && userId === this.botUserId) return;

      // Bot filter
      if (!this.options.allowOtherBots && message.author.bot) return;

      if (!this.isUserAllowed(userId)) return;

      let text = message.content;

      // Mention filter
      if (this.options.requireMention) {
        if (!(this.botUserId && text.includes(`<@${this.botUserId}>`))) {
          return;
        }
        text = text.replace(new RegExp(`<@${this.botUserId}>\\s*`, "g"), "").trim();
      }

      if (!text) return;

      const input = this.resolveInput(text);
      if (input) this.send?.(input);
    });

    await this.client.login(this.options.token);
    await readyPromise;
  }

  /**
   * Flush pending operations, destroy the Discord client, and release resources.
   */
  async stop(): Promise<void> {
    this.scheduler.flush();
    for (const op of this.state.pendingOps) {
      this.opQueue.enqueue(() => this.executeOp(op));
    }
    this.state = { ...this.state, pendingOps: [] };
    await this.opQueue.drain();
    this.scheduler.dispose();
    await this.client?.destroy();
    this.client = null;
    this.send = null;
    this.state = emptyPostState<DiscordMessage>();
    this.currentMessageId = null;
    this.currentMessage = null;
    this.botUserId = null;
  }

  /**
   * Whether there are any unsent messages.
   */
  get hasPending(): boolean {
    return this.scheduler.isActive;
  }

  /**
   * Format and post scene events to the Discord channel.
   *
   * @param frame - The frame containing events to post
   */
  receive(frame: Frame): void {
    for (const event of frame.events) {
      this.state = applySceneEvent(this.state, event, this.options.echo, discordFormatter);
    }
    if (this.state.pendingOps.length > 0) this.scheduler.schedule();
  }

  /**
   * Dequeue the next pending operation and enqueue it for execution.
   */
  private run(): void {
    const [op, ...rest] = this.state.pendingOps;
    if (!op) return;
    this.state = { ...this.state, pendingOps: rest };
    this.opQueue.enqueue(async () => {
      await this.executeOp(op);
      if (this.state.pendingOps.length > 0) this.scheduler.schedule();
    });
  }

  /**
   * Execute a single API operation against the Discord client.
   *
   * @param op - The operation to execute
   */
  private async executeOp(op: PendingOp<DiscordMessage>): Promise<void> {
    if (!this.client) return;

    switch (op.type) {
      case "post": {
        try {
          const channel = await this.client.channels.fetch(this.options.channel);
          if (!channel || !("send" in channel)) break;
          const sent = await channel.send(op.message);
          this.currentMessageId = sent.id;
          this.currentMessage = sent;
        } catch (error: unknown) {
          console.error(
            `[haruna][${this.name}] failed to post message: ${error instanceof Error ? error.message : error}`,
          );
        }
        break;
      }
      case "update": {
        if (!this.currentMessage) break;
        try {
          await this.currentMessage.edit(op.message);
        } catch (error: unknown) {
          console.error(
            `[haruna][${this.name}] failed to update message: ${error instanceof Error ? error.message : error}`,
          );
        }
        break;
      }
      case "delete": {
        if (!this.currentMessage) break;
        try {
          await this.currentMessage.delete();
        } catch (error: unknown) {
          console.error(
            `[haruna][${this.name}] failed to delete message: ${error instanceof Error ? error.message : error}`,
          );
        }
        this.currentMessageId = null;
        this.currentMessage = null;
        break;
      }
    }
  }

  /**
   * Convert user text into a {@link SceneInput}.
   *
   * When the text is a bare number (1-based) that falls within the option range of
   * the most recent question or permission prompt, it is converted into a
   * `select` input. Otherwise it is treated as plain text.
   *
   * @param text - Sanitized message text from the user
   * @returns Parsed SceneInput, or `null` if invalid
   */
  private resolveInput(text: string): SceneInput | null {
    const lastPost = this.state.lastPost;
    if (
      (lastPost?.type === "question" || lastPost?.type === "permission") &&
      lastPost.optionCount > 0 &&
      /^\d+$/.test(text)
    ) {
      const num = Number.parseInt(text, 10);
      if (num >= 1 && num <= lastPost.optionCount) {
        return parseSceneInput({ type: "select", index: num - 1 });
      }
    }
    return parseSceneInput({ type: "text", content: text });
  }

  /**
   * Check whether a user ID passes the `allowUsers` filter.
   *
   * @param userId - The Discord user ID
   * @returns `true` if the user is allowed
   */
  private isUserAllowed(userId: string): boolean {
    const rules = this.options.allowUsers;
    if (rules.includes(`!${userId}`)) return false;
    if (rules.includes("*")) return true;
    return rules.includes(userId);
  }
}
