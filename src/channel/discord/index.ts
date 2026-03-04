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
  /** Text channel for posting new messages (resolved at start). */
  private targetChannel: { send(content: string): Promise<Message> } | null = null;
  /** Discord Message objects for the most recently posted logical message (set after API success). */
  private currentMessages: Message[] = [];
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
      const lastMsg = this.currentMessages[this.currentMessages.length - 1];
      if (!lastMsg || reaction.message.id !== lastMsg.id) return;

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
      if (
        this.options.requireMention &&
        !(this.botUserId && text.includes(`<@${this.botUserId}>`))
      ) {
        return;
      }

      if (this.botUserId) text = text.replaceAll(`<@${this.botUserId}>`, "");
      text = text.trim();

      if (!text) return;

      const input = this.resolveInput(text);
      if (input) this.send?.(input);
    });

    await this.client.login(this.options.token);

    try {
      const fetched = await this.client.channels.fetch(this.options.channel);
      if (fetched && "send" in fetched) {
        this.targetChannel = fetched as { send(content: string): Promise<Message> };
      }
    } catch (error: unknown) {
      console.error(
        `[haruna][${this.name}] failed to fetch channel: ${error instanceof Error ? error.message : error}`,
      );
    }

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
    this.targetChannel = null;
    this.currentMessages = [];
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
   * For `post` and `update`, the messages array may contain multiple items
   * that are sent/updated/deleted individually to respect platform limits.
   *
   * @param op - The operation to execute
   */
  private async executeOp(op: PendingOp<DiscordMessage>): Promise<void> {
    const channel = this.targetChannel;
    if (!channel) return;

    switch (op.type) {
      case "post": {
        try {
          const sent: Message[] = [];
          for (const msg of op.messages) {
            sent.push(await channel.send(msg));
          }
          this.currentMessages = sent;
        } catch (error: unknown) {
          console.error(
            `[haruna][${this.name}] failed to post message: ${error instanceof Error ? error.message : error}`,
          );
        }
        break;
      }
      case "update": {
        try {
          const prev = this.currentMessages;
          const next = op.messages;
          const updated: Message[] = [];
          for (let i = 0; i < next.length; i++) {
            const msg = next[i] as DiscordMessage;
            if (i < prev.length) {
              const existing = prev[i] as Message;
              await existing.edit(msg);
              updated.push(existing);
            } else {
              updated.push(await channel.send(msg));
            }
          }
          for (let i = next.length; i < prev.length; i++) {
            const surplus = prev[i] as Message;
            await surplus.delete();
          }
          this.currentMessages = updated;
        } catch (error: unknown) {
          console.error(
            `[haruna][${this.name}] failed to update message: ${error instanceof Error ? error.message : error}`,
          );
        }
        break;
      }
      case "delete": {
        try {
          for (const msg of this.currentMessages) {
            await msg.delete();
          }
        } catch (error: unknown) {
          console.error(
            `[haruna][${this.name}] failed to delete message: ${error instanceof Error ? error.message : error}`,
          );
        }
        this.currentMessages = [];
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
