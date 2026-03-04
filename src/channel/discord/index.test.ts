import { beforeEach, describe, expect, mock, test } from "bun:test";
import { frame, waitFor } from "../__testing.ts";
import type { SendSceneInput } from "../interface.ts";
import { DiscordChannel, type DiscordChannelOptions } from "./index.ts";

// Capture event handlers registered via client.on() / client.once()
const registeredHandlers: Record<string, ((...args: unknown[]) => void)[]> = {};

/** Emit a captured event to all registered handlers. */
function emit(event: string, ...args: unknown[]): void {
  for (const handler of registeredHandlers[event] ?? []) {
    handler(...args);
  }
}

/** Simulate the ClientReady event with a bot user. */
function emitReady(botUserId = "BOT_SELF"): void {
  emit("ready", { user: { id: botUserId } });
}

/** Simulate a MessageCreate event. */
function simulateMessage(message: Record<string, unknown>): void {
  emit("messageCreate", message);
}

/** Simulate a MessageReactionAdd event. */
function simulateReaction(reaction: Record<string, unknown>, user: Record<string, unknown>): void {
  emit("messageReactionAdd", reaction, user);
}

const mockSend = mock(() => Promise.resolve({ id: "MSG_1", edit: mockEdit, delete: mockDelete }));
const mockEdit = mock(() => Promise.resolve());
const mockDelete = mock(() => Promise.resolve());
const mockLogin = mock(() => Promise.resolve());
const mockDestroy = mock(() => Promise.resolve());

mock.module("discord.js", () => ({
  Client: class MockClient {
    channels = {
      fetch: mock(() => Promise.resolve({ send: mockSend })),
    };
    on(event: string, handler: (...args: unknown[]) => void) {
      registeredHandlers[event] ??= [];
      registeredHandlers[event].push(handler);
      return this;
    }
    once(event: string, handler: (...args: unknown[]) => void) {
      registeredHandlers[event] ??= [];
      registeredHandlers[event].push(handler);
      return this;
    }
    login = mockLogin;
    destroy = mockDestroy;
  },
  Events: {
    ClientReady: "ready",
    MessageCreate: "messageCreate",
    MessageReactionAdd: "messageReactionAdd",
  },
  GatewayIntentBits: {
    Guilds: 1,
    GuildMessages: 2,
    MessageContent: 4,
    GuildMessageReactions: 8,
  },
}));

const OPTIONS: DiscordChannelOptions = {
  token: "test-token",
  channel: "C123",
  allowUsers: ["*"],
  allowOtherBots: false,
  requireMention: false,
  echo: false,
};

describe("DiscordChannel", () => {
  let channel: DiscordChannel;
  let send: SendSceneInput;

  beforeEach(() => {
    mockSend.mockClear();
    mockEdit.mockClear();
    mockDelete.mockClear();
    mockLogin.mockClear();
    mockDestroy.mockClear();
    for (const key of Object.keys(registeredHandlers)) delete registeredHandlers[key];
    send = mock(() => {});
    channel = new DiscordChannel(OPTIONS);
  });

  test("constructor sets name to discord", () => {
    expect(channel.name).toBe("discord");
  });

  test("start logs in and waits for ready", async () => {
    mockLogin.mockImplementation(() => {
      emitReady();
      return Promise.resolve();
    });
    await channel.start(send);
    expect(mockLogin).toHaveBeenCalledTimes(1);
  });

  test("stop destroys the Discord client", async () => {
    mockLogin.mockImplementation(() => {
      emitReady();
      return Promise.resolve();
    });
    await channel.start(send);
    await channel.stop();
    expect(mockDestroy).toHaveBeenCalledTimes(1);
  });

  test("receive posts formatted events to Discord", async () => {
    mockLogin.mockImplementation(() => {
      emitReady();
      return Promise.resolve();
    });
    await channel.start(send);

    channel.receive(frame([{ type: "message_created", content: ["hello"] }]));
    await channel.stop();

    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend).toHaveBeenCalledWith("hello");
  });

  test("receive skips events that format to null", async () => {
    mockLogin.mockImplementation(() => {
      emitReady();
      return Promise.resolve();
    });
    await channel.start(send);

    channel.receive(frame([{ type: "input_changed", active: true, text: "hello" }]));

    expect(mockSend).not.toHaveBeenCalled();
  });

  test("last_message_updated calls message.edit", async () => {
    mockLogin.mockImplementation(() => {
      emitReady();
      return Promise.resolve();
    });
    await channel.start(send);

    channel.receive(frame([{ type: "message_created", content: ["first"] }]));
    channel.receive(frame([{ type: "last_message_updated", content: ["updated"] }]));
    await channel.stop();

    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockEdit).toHaveBeenCalledTimes(1);
    expect(mockEdit).toHaveBeenCalledWith("updated");
  });

  test("last_message_updated with null content calls message.delete", async () => {
    mockLogin.mockImplementation(() => {
      emitReady();
      return Promise.resolve();
    });
    await channel.start(send);

    channel.receive(frame([{ type: "message_created", content: ["first"] }]));
    channel.receive(frame([{ type: "last_message_updated", content: null }]));
    await channel.stop();

    expect(mockDelete).toHaveBeenCalledTimes(1);
  });

  test("indicator_changed active appends context and calls edit", async () => {
    mockLogin.mockImplementation(() => {
      emitReady();
      return Promise.resolve();
    });
    await channel.start(send);

    channel.receive(frame([{ type: "message_created", content: ["hello"] }]));
    channel.receive(frame([{ type: "indicator_changed", active: true, text: "Thinking..." }]));
    await channel.stop();

    expect(mockEdit).toHaveBeenCalledTimes(1);
    expect(mockEdit).toHaveBeenCalledWith("hello\n> Thinking...");
  });

  test("indicator_changed inactive restores original message via edit", async () => {
    mockLogin.mockImplementation(() => {
      emitReady();
      return Promise.resolve();
    });
    await channel.start(send);

    channel.receive(frame([{ type: "message_created", content: ["hello"] }]));
    channel.receive(frame([{ type: "indicator_changed", active: true, text: "Thinking..." }]));
    channel.receive(frame([{ type: "indicator_changed", active: false, text: "" }]));
    await channel.stop();

    // The two consecutive updates (activate + deactivate) coalesce into one
    expect(mockEdit).toHaveBeenCalledTimes(1);
    expect(mockEdit).toHaveBeenCalledWith("hello");
  });

  test("message_created with active indicator includes indicator", async () => {
    mockLogin.mockImplementation(() => {
      emitReady();
      return Promise.resolve();
    });
    await channel.start(send);

    channel.receive(frame([{ type: "message_created", content: ["first"] }]));
    channel.receive(frame([{ type: "indicator_changed", active: true, text: "Thinking..." }]));
    channel.receive(frame([{ type: "message_created", content: ["second"] }]));
    await channel.stop();

    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(mockSend).toHaveBeenLastCalledWith("second\n> Thinking...");
  });

  test("message_created strips indicator from previous message before posting", async () => {
    mockLogin.mockImplementation(() => {
      emitReady();
      return Promise.resolve();
    });
    await channel.start(send);

    channel.receive(frame([{ type: "message_created", content: ["first"] }]));
    channel.receive(frame([{ type: "indicator_changed", active: true, text: "Thinking..." }]));
    channel.receive(frame([{ type: "message_created", content: ["second"] }]));
    await channel.stop();

    // The indicator activate + strip-indicator updates coalesce into one
    expect(mockEdit).toHaveBeenCalledTimes(1);
    expect(mockEdit).toHaveBeenCalledWith("first");
  });

  test("indicator_changed without prior message does not call edit", async () => {
    mockLogin.mockImplementation(() => {
      emitReady();
      return Promise.resolve();
    });
    await channel.start(send);

    channel.receive(frame([{ type: "indicator_changed", active: true, text: "Thinking..." }]));
    await channel.stop();

    expect(mockEdit).not.toHaveBeenCalled();
  });

  test("question_created posts as new message (not update)", async () => {
    mockLogin.mockImplementation(() => {
      emitReady();
      return Promise.resolve();
    });
    await channel.start(send);

    channel.receive(
      frame([
        {
          type: "question_created",
          question: "Continue?",
          options: [{ label: "Yes" }, { label: "No" }],
        },
      ]),
    );
    await channel.stop();

    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockEdit).not.toHaveBeenCalled();
  });

  test("echo events are skipped when echo is disabled", async () => {
    mockLogin.mockImplementation(() => {
      emitReady();
      return Promise.resolve();
    });
    await channel.start(send);

    channel.receive(frame([{ type: "message_created", content: ["echoed"], echo: true }]));

    expect(mockSend).not.toHaveBeenCalled();
  });

  test("echo events are forwarded when echo is enabled", async () => {
    const ch = new DiscordChannel({ ...OPTIONS, echo: true });
    mockLogin.mockImplementation(() => {
      emitReady();
      return Promise.resolve();
    });
    await ch.start(send);

    ch.receive(frame([{ type: "message_created", content: ["echoed"], echo: true }]));
    await ch.stop();

    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  test("incoming Discord message is forwarded as text input", async () => {
    mockLogin.mockImplementation(() => {
      emitReady();
      return Promise.resolve();
    });
    await channel.start(send);

    simulateMessage({
      system: false,
      channelId: "C123",
      content: "user input",
      author: { id: "U_HUMAN", bot: false },
    });

    expect(send).toHaveBeenCalledWith({ type: "text", content: "user input" });
  });

  test("numeric input after question is forwarded as select", async () => {
    mockLogin.mockImplementation(() => {
      emitReady();
      return Promise.resolve();
    });
    await channel.start(send);

    channel.receive(
      frame([
        {
          type: "question_created",
          question: "Pick one",
          options: [{ label: "A" }, { label: "B" }, { label: "C" }],
        },
      ]),
    );

    simulateMessage({
      system: false,
      channelId: "C123",
      content: "2",
      author: { id: "U_HUMAN", bot: false },
    });

    expect(send).toHaveBeenCalledWith({ type: "select", index: 1 });
  });

  test("numeric input after permission is forwarded as select", async () => {
    mockLogin.mockImplementation(() => {
      emitReady();
      return Promise.resolve();
    });
    await channel.start(send);

    channel.receive(
      frame([
        {
          type: "permission_required",
          command: "rm -rf /tmp",
          options: [{ label: "Allow" }, { label: "Deny" }],
        },
      ]),
    );

    simulateMessage({
      system: false,
      channelId: "C123",
      content: "1",
      author: { id: "U_HUMAN", bot: false },
    });

    expect(send).toHaveBeenCalledWith({ type: "select", index: 0 });
  });

  test("out-of-range numeric input after question is forwarded as text", async () => {
    mockLogin.mockImplementation(() => {
      emitReady();
      return Promise.resolve();
    });
    await channel.start(send);

    channel.receive(
      frame([
        {
          type: "question_created",
          question: "Pick one",
          options: [{ label: "A" }, { label: "B" }],
        },
      ]),
    );

    simulateMessage({
      system: false,
      channelId: "C123",
      content: "3",
      author: { id: "U_HUMAN", bot: false },
    });

    expect(send).toHaveBeenCalledWith({ type: "text", content: "3" });
  });

  test("non-numeric input after question is forwarded as text", async () => {
    mockLogin.mockImplementation(() => {
      emitReady();
      return Promise.resolve();
    });
    await channel.start(send);

    channel.receive(
      frame([
        {
          type: "question_created",
          question: "Pick one",
          options: [{ label: "A" }, { label: "B" }],
        },
      ]),
    );

    simulateMessage({
      system: false,
      channelId: "C123",
      content: "hello",
      author: { id: "U_HUMAN", bot: false },
    });

    expect(send).toHaveBeenCalledWith({ type: "text", content: "hello" });
  });

  test("numeric input after message is forwarded as text (not select)", async () => {
    mockLogin.mockImplementation(() => {
      emitReady();
      return Promise.resolve();
    });
    await channel.start(send);

    channel.receive(frame([{ type: "message_created", content: ["hello"] }]));

    simulateMessage({
      system: false,
      channelId: "C123",
      content: "1",
      author: { id: "U_HUMAN", bot: false },
    });

    expect(send).toHaveBeenCalledWith({ type: "text", content: "1" });
  });

  test("ignores messages from other channels", async () => {
    mockLogin.mockImplementation(() => {
      emitReady();
      return Promise.resolve();
    });
    await channel.start(send);

    simulateMessage({
      system: false,
      channelId: "C_OTHER",
      content: "wrong channel",
      author: { id: "U_HUMAN", bot: false },
    });

    expect(send).not.toHaveBeenCalled();
  });

  test("ignores system messages", async () => {
    mockLogin.mockImplementation(() => {
      emitReady();
      return Promise.resolve();
    });
    await channel.start(send);

    simulateMessage({
      system: true,
      channelId: "C123",
      content: "system message",
      author: { id: "U_HUMAN", bot: false },
    });

    expect(send).not.toHaveBeenCalled();
  });

  test("ignores messages without content", async () => {
    mockLogin.mockImplementation(() => {
      emitReady();
      return Promise.resolve();
    });
    await channel.start(send);

    simulateMessage({
      system: false,
      channelId: "C123",
      content: "",
      author: { id: "U_HUMAN", bot: false },
    });

    expect(send).not.toHaveBeenCalled();
  });

  test("allowUsers denies users not in the allow list", async () => {
    const ch = new DiscordChannel({ ...OPTIONS, allowUsers: ["U_ALLOWED"] });
    mockLogin.mockImplementation(() => {
      emitReady();
      return Promise.resolve();
    });
    await ch.start(send);

    simulateMessage({
      system: false,
      channelId: "C123",
      content: "denied",
      author: { id: "U_OTHER", bot: false },
    });
    expect(send).not.toHaveBeenCalled();

    simulateMessage({
      system: false,
      channelId: "C123",
      content: "allowed",
      author: { id: "U_ALLOWED", bot: false },
    });
    expect(send).toHaveBeenCalledTimes(1);

    await ch.stop();
  });

  test("allowUsers with deny prefix blocks specific users", async () => {
    const ch = new DiscordChannel({ ...OPTIONS, allowUsers: ["*", "!U_BLOCKED"] });
    mockLogin.mockImplementation(() => {
      emitReady();
      return Promise.resolve();
    });
    await ch.start(send);

    simulateMessage({
      system: false,
      channelId: "C123",
      content: "blocked",
      author: { id: "U_BLOCKED", bot: false },
    });
    expect(send).not.toHaveBeenCalled();

    simulateMessage({
      system: false,
      channelId: "C123",
      content: "ok",
      author: { id: "U_GOOD", bot: false },
    });
    expect(send).toHaveBeenCalledTimes(1);

    await ch.stop();
  });

  test("allowOtherBots=false skips bot messages", async () => {
    mockLogin.mockImplementation(() => {
      emitReady();
      return Promise.resolve();
    });
    await channel.start(send);

    simulateMessage({
      system: false,
      channelId: "C123",
      content: "from bot",
      author: { id: "U_BOT", bot: true },
    });
    expect(send).not.toHaveBeenCalled();
  });

  test("allowOtherBots=true accepts messages from other bots", async () => {
    const ch = new DiscordChannel({ ...OPTIONS, allowOtherBots: true });
    mockLogin.mockImplementation(() => {
      emitReady();
      return Promise.resolve();
    });
    await ch.start(send);

    simulateMessage({
      system: false,
      channelId: "C123",
      content: "from bot",
      author: { id: "U_BOT", bot: true },
    });
    expect(send).toHaveBeenCalledTimes(1);

    await ch.stop();
  });

  test("allowOtherBots=true still ignores messages from self", async () => {
    const ch = new DiscordChannel({ ...OPTIONS, allowOtherBots: true });
    mockLogin.mockImplementation(() => {
      emitReady();
      return Promise.resolve();
    });
    await ch.start(send);

    simulateMessage({
      system: false,
      channelId: "C123",
      content: "from self",
      author: { id: "BOT_SELF", bot: true },
    });
    expect(send).not.toHaveBeenCalled();

    await ch.stop();
  });

  test("requireMention=true forwards messages with bot mention", async () => {
    const ch = new DiscordChannel({ ...OPTIONS, requireMention: true });
    mockLogin.mockImplementation(() => {
      emitReady();
      return Promise.resolve();
    });
    await ch.start(send);

    // Message without mention — should be ignored
    simulateMessage({
      system: false,
      channelId: "C123",
      content: "no mention",
      author: { id: "U_HUMAN", bot: false },
    });
    expect(send).not.toHaveBeenCalled();

    // Message with mention — should be forwarded with mention stripped
    simulateMessage({
      system: false,
      channelId: "C123",
      content: "<@BOT_SELF> do something",
      author: { id: "U_HUMAN", bot: false },
    });
    expect(send).toHaveBeenCalledWith({ type: "text", content: "do something" });

    await ch.stop();
  });

  test("requireMention=true with mention-only message is ignored", async () => {
    const ch = new DiscordChannel({ ...OPTIONS, requireMention: true });
    mockLogin.mockImplementation(() => {
      emitReady();
      return Promise.resolve();
    });
    await ch.start(send);

    simulateMessage({
      system: false,
      channelId: "C123",
      content: "<@BOT_SELF>",
      author: { id: "U_HUMAN", bot: false },
    });
    expect(send).not.toHaveBeenCalled();

    await ch.stop();
  });

  test("send=null does not crash on incoming message", async () => {
    mockLogin.mockImplementation(() => {
      emitReady();
      return Promise.resolve();
    });
    await channel.start(null);

    simulateMessage({
      system: false,
      channelId: "C123",
      content: "hello",
      author: { id: "U_HUMAN", bot: false },
    });

    // No crash — just silently ignored
  });

  test("empty allowUsers rejects all users", async () => {
    const ch = new DiscordChannel({ ...OPTIONS, allowUsers: [] });
    mockLogin.mockImplementation(() => {
      emitReady();
      return Promise.resolve();
    });
    await ch.start(send);

    simulateMessage({
      system: false,
      channelId: "C123",
      content: "hello",
      author: { id: "U_ANY", bot: false },
    });
    expect(send).not.toHaveBeenCalled();

    await ch.stop();
  });

  test("emoji reaction 1️⃣ on question sends select input", async () => {
    mockLogin.mockImplementation(() => {
      emitReady();
      return Promise.resolve();
    });
    await channel.start(send);

    channel.receive(
      frame([
        {
          type: "question_created",
          question: "Pick one",
          options: [{ label: "A" }, { label: "B" }, { label: "C" }],
        },
      ]),
    );
    await waitFor(() => !channel.hasPending);

    simulateReaction(
      { message: { channelId: "C123", id: "MSG_1" }, emoji: { name: "1️⃣" } },
      { id: "U_HUMAN" },
    );

    expect(send).toHaveBeenCalledWith({ type: "select", index: 0 });
  });

  test("emoji reaction 9️⃣ selects 9th option", async () => {
    mockLogin.mockImplementation(() => {
      emitReady();
      return Promise.resolve();
    });
    await channel.start(send);

    const options = Array.from({ length: 9 }, (_, i) => ({ label: String(i + 1) }));
    channel.receive(frame([{ type: "question_created", question: "Pick", options }]));
    await waitFor(() => !channel.hasPending);

    simulateReaction(
      { message: { channelId: "C123", id: "MSG_1" }, emoji: { name: "9️⃣" } },
      { id: "U_HUMAN" },
    );

    expect(send).toHaveBeenCalledWith({ type: "select", index: 8 });
  });

  test("emoji reaction on permission sends select input", async () => {
    mockLogin.mockImplementation(() => {
      emitReady();
      return Promise.resolve();
    });
    await channel.start(send);

    channel.receive(
      frame([
        {
          type: "permission_required",
          command: "rm -rf /tmp",
          options: [{ label: "Allow" }, { label: "Deny" }],
        },
      ]),
    );
    await waitFor(() => !channel.hasPending);

    simulateReaction(
      { message: { channelId: "C123", id: "MSG_1" }, emoji: { name: "2️⃣" } },
      { id: "U_HUMAN" },
    );

    expect(send).toHaveBeenCalledWith({ type: "select", index: 1 });
  });

  test("emoji reaction with out-of-range number is ignored", async () => {
    mockLogin.mockImplementation(() => {
      emitReady();
      return Promise.resolve();
    });
    await channel.start(send);

    channel.receive(
      frame([
        {
          type: "question_created",
          question: "Pick",
          options: [{ label: "A" }, { label: "B" }],
        },
      ]),
    );
    await waitFor(() => !channel.hasPending);

    simulateReaction(
      { message: { channelId: "C123", id: "MSG_1" }, emoji: { name: "3️⃣" } },
      { id: "U_HUMAN" },
    );

    expect(send).not.toHaveBeenCalled();
  });

  test("unrelated emoji reaction is ignored", async () => {
    mockLogin.mockImplementation(() => {
      emitReady();
      return Promise.resolve();
    });
    await channel.start(send);

    channel.receive(
      frame([
        {
          type: "question_created",
          question: "Pick",
          options: [{ label: "A" }, { label: "B" }],
        },
      ]),
    );
    await waitFor(() => !channel.hasPending);

    simulateReaction(
      { message: { channelId: "C123", id: "MSG_1" }, emoji: { name: "👍" } },
      { id: "U_HUMAN" },
    );

    expect(send).not.toHaveBeenCalled();
  });

  test("emoji reaction on different channel is ignored", async () => {
    mockLogin.mockImplementation(() => {
      emitReady();
      return Promise.resolve();
    });
    await channel.start(send);

    channel.receive(
      frame([
        {
          type: "question_created",
          question: "Pick",
          options: [{ label: "A" }, { label: "B" }],
        },
      ]),
    );
    await waitFor(() => !channel.hasPending);

    simulateReaction(
      { message: { channelId: "C_OTHER", id: "MSG_1" }, emoji: { name: "1️⃣" } },
      { id: "U_HUMAN" },
    );

    expect(send).not.toHaveBeenCalled();
  });

  test("emoji reaction on non-current message is ignored", async () => {
    mockLogin.mockImplementation(() => {
      emitReady();
      return Promise.resolve();
    });
    await channel.start(send);

    channel.receive(
      frame([
        {
          type: "question_created",
          question: "Pick",
          options: [{ label: "A" }, { label: "B" }],
        },
      ]),
    );
    await waitFor(() => !channel.hasPending);

    simulateReaction(
      { message: { channelId: "C123", id: "MSG_OLD" }, emoji: { name: "1️⃣" } },
      { id: "U_HUMAN" },
    );

    expect(send).not.toHaveBeenCalled();
  });

  test("emoji reaction when lastPost is message (not question/permission) is ignored", async () => {
    mockLogin.mockImplementation(() => {
      emitReady();
      return Promise.resolve();
    });
    await channel.start(send);

    channel.receive(frame([{ type: "message_created", content: ["hello"] }]));
    await waitFor(() => !channel.hasPending);

    simulateReaction(
      { message: { channelId: "C123", id: "MSG_1" }, emoji: { name: "1️⃣" } },
      { id: "U_HUMAN" },
    );

    expect(send).not.toHaveBeenCalled();
  });

  test("emoji reaction from disallowed user is ignored", async () => {
    const ch = new DiscordChannel({ ...OPTIONS, allowUsers: ["U_ALLOWED"] });
    mockLogin.mockImplementation(() => {
      emitReady();
      return Promise.resolve();
    });
    await ch.start(send);

    ch.receive(
      frame([
        {
          type: "question_created",
          question: "Pick",
          options: [{ label: "A" }, { label: "B" }],
        },
      ]),
    );
    await waitFor(() => !ch.hasPending);

    simulateReaction(
      { message: { channelId: "C123", id: "MSG_1" }, emoji: { name: "1️⃣" } },
      { id: "U_DENIED" },
    );

    expect(send).not.toHaveBeenCalled();
    await ch.stop();
  });

  test("emoji reaction from bot itself is ignored", async () => {
    mockLogin.mockImplementation(() => {
      emitReady();
      return Promise.resolve();
    });
    await channel.start(send);

    channel.receive(
      frame([
        {
          type: "question_created",
          question: "Pick",
          options: [{ label: "A" }, { label: "B" }],
        },
      ]),
    );
    await waitFor(() => !channel.hasPending);

    simulateReaction(
      { message: { channelId: "C123", id: "MSG_1" }, emoji: { name: "1️⃣" } },
      { id: "BOT_SELF" },
    );

    expect(send).not.toHaveBeenCalled();
  });

  test("channel.send failure does not break subsequent operations", async () => {
    mockLogin.mockImplementation(() => {
      emitReady();
      return Promise.resolve();
    });
    await channel.start(send);

    mockSend.mockImplementationOnce(() => Promise.reject(new Error("rate_limited")));

    channel.receive(frame([{ type: "message_created", content: ["fail"] }]));
    channel.receive(frame([{ type: "message_created", content: ["ok"] }]));
    await channel.stop();

    // First post fails, second should still be attempted
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  test("question_created strips indicator from previous message", async () => {
    mockLogin.mockImplementation(() => {
      emitReady();
      return Promise.resolve();
    });
    await channel.start(send);

    channel.receive(frame([{ type: "message_created", content: ["msg"] }]));
    channel.receive(frame([{ type: "indicator_changed", active: true, text: "Thinking..." }]));
    channel.receive(
      frame([
        {
          type: "question_created",
          question: "Pick",
          options: [{ label: "A" }],
        },
      ]),
    );
    await channel.stop();

    // The indicator update + strip coalesce into one update restoring the original message
    expect(mockEdit).toHaveBeenCalledTimes(1);
    expect(mockEdit).toHaveBeenCalledWith("msg");
  });
});
