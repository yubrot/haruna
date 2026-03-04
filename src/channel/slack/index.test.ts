import { beforeEach, describe, expect, mock, test } from "bun:test";
import { frame, waitFor } from "../__testing.ts";
import type { SendSceneInput } from "../interface.ts";
import { SlackChannel, type SlackChannelOptions } from "./index.ts";

// Capture the message handler registered via app.message()
let registeredMessageHandler: (args: { message: Record<string, unknown> }) => Promise<void>;

/** Invoke the captured `message` handler. */
async function simulateMessage(message: Record<string, unknown>): Promise<void> {
  const handler = registeredMessageHandler;
  if (!handler) throw new Error("message handler not registered");
  await handler({ message });
}

// Capture event handlers registered via app.event()
const registeredEventHandlers: Record<
  string,
  (args: { event: Record<string, unknown> }) => Promise<void>
> = {};

/** Invoke the captured `reaction_added` handler (asserts it exists). */
async function simulateReaction(event: Record<string, unknown>): Promise<void> {
  const handler = registeredEventHandlers.reaction_added;
  if (!handler) throw new Error("reaction_added handler not registered");
  await handler({ event });
}

const mockPostMessage = mock(() => Promise.resolve({ ok: true, ts: "1234567890.123456" }));
const mockUpdate = mock(() => Promise.resolve({ ok: true }));
const mockDelete = mock(() => Promise.resolve({ ok: true }));
const mockStart = mock(() => Promise.resolve());
const mockStop = mock(() => Promise.resolve());

mock.module("@slack/bolt", () => ({
  App: class MockApp {
    client = {
      auth: { test: mock(() => Promise.resolve({ user_id: "U_BOT_SELF" })) },
      chat: {
        postMessage: mockPostMessage,
        update: mockUpdate,
        delete: mockDelete,
      },
    };
    message(handler: typeof registeredMessageHandler) {
      registeredMessageHandler = handler;
    }
    event(name: string, handler: (typeof registeredEventHandlers)[string]) {
      registeredEventHandlers[name] = handler;
    }
    start = mockStart;
    stop = mockStop;
  },
}));

const OPTIONS: SlackChannelOptions = {
  appToken: "xapp-test",
  botToken: "xoxb-test",
  channel: "C_TARGET",
  allowUsers: ["*"],
  allowOtherBots: false,
  requireMention: false,
  echo: false,
};

describe("SlackChannel", () => {
  let channel: SlackChannel;
  let send: SendSceneInput;

  beforeEach(() => {
    mockPostMessage.mockClear();
    mockUpdate.mockClear();
    mockDelete.mockClear();
    mockStart.mockClear();
    mockStop.mockClear();
    for (const key of Object.keys(registeredEventHandlers)) delete registeredEventHandlers[key];
    send = mock(() => {});
    channel = new SlackChannel(OPTIONS);
  });

  test("start initializes Bolt app and opens socket", async () => {
    await channel.start(send);
    expect(mockStart).toHaveBeenCalledTimes(1);
  });

  test("stop shuts down the Bolt app", async () => {
    await channel.start(send);
    await channel.stop();
    expect(mockStop).toHaveBeenCalledTimes(1);
  });

  test("receive posts formatted events to Slack", async () => {
    await channel.start(send);

    channel.receive(frame([{ type: "message_created", content: ["hello"] }]));
    await channel.stop();

    expect(mockPostMessage).toHaveBeenCalledTimes(1);
    expect(mockPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C_TARGET",
        text: "hello",
      }),
    );
  });

  test("receive skips events that format to null", async () => {
    await channel.start(send);

    channel.receive(frame([{ type: "input_changed", active: true, text: "hello" }]));

    expect(mockPostMessage).not.toHaveBeenCalled();
  });

  test("last_message_updated calls chat.update", async () => {
    await channel.start(send);

    channel.receive(frame([{ type: "message_created", content: ["first"] }]));
    channel.receive(
      frame([
        {
          type: "last_message_updated",
          content: ["updated"],
        },
      ]),
    );
    await channel.stop();

    expect(mockPostMessage).toHaveBeenCalledTimes(1);
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C_TARGET",
        ts: "1234567890.123456",
        text: "updated",
      }),
    );
  });

  test("last_message_updated with null content calls chat.delete", async () => {
    await channel.start(send);

    channel.receive(frame([{ type: "message_created", content: ["first"] }]));
    channel.receive(frame([{ type: "last_message_updated", content: null }]));
    await channel.stop();

    expect(mockDelete).toHaveBeenCalledTimes(1);
    expect(mockDelete).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C_TARGET",
        ts: "1234567890.123456",
      }),
    );
  });

  test("indicator_changed active appends indicator and calls chat.update", async () => {
    await channel.start(send);

    channel.receive(frame([{ type: "message_created", content: ["hello"] }]));
    channel.receive(frame([{ type: "indicator_changed", active: true, text: "Thinking..." }]));
    await channel.stop();

    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        ts: "1234567890.123456",
        blocks: expect.arrayContaining([
          expect.objectContaining({
            type: "context",
            elements: [{ type: "mrkdwn", text: "Thinking..." }],
          }),
        ]),
      }),
    );
  });

  test("indicator_changed inactive removes indicator via chat.update", async () => {
    await channel.start(send);

    channel.receive(frame([{ type: "message_created", content: ["hello"] }]));
    channel.receive(frame([{ type: "indicator_changed", active: true, text: "Thinking..." }]));
    channel.receive(frame([{ type: "indicator_changed", active: false, text: "" }]));
    await channel.stop();

    // The two consecutive updates (activate + deactivate) coalesce into one
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        // Deactivated: should restore the original message (rich_text blocks, no indicator)
        blocks: [
          {
            type: "rich_text",
            elements: [
              {
                type: "rich_text_section",
                elements: [{ type: "text", text: "hello" }],
              },
            ],
          },
        ],
      }),
    );
  });

  test("message_created with active indicator includes indicator", async () => {
    await channel.start(send);

    // Set up indicator first via a message + indicator
    channel.receive(frame([{ type: "message_created", content: ["first"] }]));
    channel.receive(frame([{ type: "indicator_changed", active: true, text: "Thinking..." }]));

    // New message should also include indicator
    channel.receive(frame([{ type: "message_created", content: ["second"] }]));
    await channel.stop();

    expect(mockPostMessage).toHaveBeenCalledTimes(2);
    expect(mockPostMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        blocks: expect.arrayContaining([
          expect.objectContaining({
            type: "context",
            elements: [{ type: "mrkdwn", text: "Thinking..." }],
          }),
        ]),
      }),
    );
  });

  test("message_created strips indicator from previous message before posting", async () => {
    await channel.start(send);

    channel.receive(frame([{ type: "message_created", content: ["first"] }]));
    channel.receive(frame([{ type: "indicator_changed", active: true, text: "Thinking..." }]));
    // Second message should trigger update on the first to remove indicator
    channel.receive(frame([{ type: "message_created", content: ["second"] }]));
    await channel.stop();

    // The indicator activate + strip-indicator updates coalesce into one
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    // The coalesced update should restore the original message without context block
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        ts: "1234567890.123456",
        blocks: [
          {
            type: "rich_text",
            elements: [
              {
                type: "rich_text_section",
                elements: [{ type: "text", text: "first" }],
              },
            ],
          },
        ],
      }),
    );
  });

  test("indicator_changed without prior message does not call update", async () => {
    await channel.start(send);

    channel.receive(frame([{ type: "indicator_changed", active: true, text: "Thinking..." }]));
    await channel.stop();

    expect(mockUpdate).not.toHaveBeenCalled();
  });

  test("question_created posts as new message (not update)", async () => {
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

    expect(mockPostMessage).toHaveBeenCalledTimes(1);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  test("echo events are skipped when echo is disabled", async () => {
    await channel.start(send);

    channel.receive(
      frame([
        {
          type: "message_created",
          content: ["echoed"],
          echo: true,
        },
      ]),
    );

    expect(mockPostMessage).not.toHaveBeenCalled();
  });

  test("incoming Slack message is forwarded as text input", async () => {
    await channel.start(send);

    await simulateMessage({ channel: "C_TARGET", text: "user input" });

    expect(send).toHaveBeenCalledWith({ type: "text", content: "user input" });
  });

  test("numeric input after question is forwarded as select", async () => {
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

    await simulateMessage({ channel: "C_TARGET", text: "2" });

    expect(send).toHaveBeenCalledWith({ type: "select", index: 1 });
  });

  test("numeric input after permission is forwarded as select", async () => {
    await channel.start(send);

    channel.receive(
      frame([
        {
          type: "permission_required",
          command: "rm -rf /",
          options: [{ label: "Allow" }, { label: "Deny" }],
        },
      ]),
    );

    await simulateMessage({ channel: "C_TARGET", text: "1" });

    expect(send).toHaveBeenCalledWith({ type: "select", index: 0 });
  });

  test("out-of-range numeric input after question is forwarded as text", async () => {
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

    await simulateMessage({ channel: "C_TARGET", text: "3" });

    expect(send).toHaveBeenCalledWith({ type: "text", content: "3" });
  });

  test("non-numeric input after question is forwarded as text", async () => {
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

    await simulateMessage({ channel: "C_TARGET", text: "hello" });

    expect(send).toHaveBeenCalledWith({ type: "text", content: "hello" });
  });

  test("numeric input after message is forwarded as text (not select)", async () => {
    await channel.start(send);

    channel.receive(frame([{ type: "message_created", content: ["hello"] }]));

    await simulateMessage({ channel: "C_TARGET", text: "1" });

    expect(send).toHaveBeenCalledWith({ type: "text", content: "1" });
  });

  test("ignores messages from other channels", async () => {
    await channel.start(send);

    await simulateMessage({ channel: "C_OTHER", text: "wrong channel" });

    expect(send).not.toHaveBeenCalled();
  });

  test("ignores messages with subtype", async () => {
    await channel.start(send);

    await simulateMessage({
      channel: "C_TARGET",
      text: "edited",
      subtype: "message_changed",
    });

    expect(send).not.toHaveBeenCalled();
  });

  test("ignores messages without text", async () => {
    await channel.start(send);

    await simulateMessage({ channel: "C_TARGET" });

    expect(send).not.toHaveBeenCalled();
  });

  test("thread option filters messages to the specified thread", async () => {
    const threadChannel = new SlackChannel({
      ...OPTIONS,
      thread: "1111111111.111111",
    });
    await threadChannel.start(send);

    // Message in the thread — should be forwarded
    await simulateMessage({
      channel: "C_TARGET",
      text: "in thread",
      thread_ts: "1111111111.111111",
    });
    expect(send).toHaveBeenCalledTimes(1);

    // Message outside any thread — should be ignored
    (send as ReturnType<typeof mock>).mockClear();
    await simulateMessage({ channel: "C_TARGET", text: "top-level" });
    expect(send).not.toHaveBeenCalled();

    // Thread parent message (ts matches thread) — should be forwarded
    await simulateMessage({
      channel: "C_TARGET",
      text: "parent",
      ts: "1111111111.111111",
    });
    expect(send).toHaveBeenCalledTimes(1);

    await threadChannel.stop();
  });

  test("thread option passes thread_ts to postMessage", async () => {
    const threadChannel = new SlackChannel({
      ...OPTIONS,
      thread: "1111111111.111111",
    });
    await threadChannel.start(send);

    threadChannel.receive(frame([{ type: "message_created", content: ["hello"] }]));
    await threadChannel.stop();

    expect(mockPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        thread_ts: "1111111111.111111",
      }),
    );
  });

  test("allowUsers denies users not in the allow list", async () => {
    const ch = new SlackChannel({
      ...OPTIONS,
      allowUsers: ["U_ALLOWED"],
    });
    await ch.start(send);

    await simulateMessage({ channel: "C_TARGET", text: "denied", user: "U_OTHER" });
    expect(send).not.toHaveBeenCalled();

    await simulateMessage({ channel: "C_TARGET", text: "allowed", user: "U_ALLOWED" });
    expect(send).toHaveBeenCalledTimes(1);

    await ch.stop();
  });

  test("allowUsers with deny prefix blocks specific users", async () => {
    const ch = new SlackChannel({
      ...OPTIONS,
      allowUsers: ["*", "!U_BLOCKED"],
    });
    await ch.start(send);

    await simulateMessage({ channel: "C_TARGET", text: "blocked", user: "U_BLOCKED" });
    expect(send).not.toHaveBeenCalled();

    await simulateMessage({ channel: "C_TARGET", text: "ok", user: "U_GOOD" });
    expect(send).toHaveBeenCalledTimes(1);

    await ch.stop();
  });

  test("allowOtherBots=false skips bot messages", async () => {
    await channel.start(send);

    await simulateMessage({
      channel: "C_TARGET",
      text: "from bot",
      bot_id: "B123",
      user: "U_BOT",
    });
    expect(send).not.toHaveBeenCalled();
  });

  test("allowOtherBots=true accepts messages from other bots", async () => {
    const ch = new SlackChannel({ ...OPTIONS, allowOtherBots: true });
    await ch.start(send);

    await simulateMessage({
      channel: "C_TARGET",
      text: "from bot",
      bot_id: "B123",
      user: "U_BOT",
    });
    expect(send).toHaveBeenCalledTimes(1);

    await ch.stop();
  });

  test("allowOtherBots=true still ignores messages from self", async () => {
    const ch = new SlackChannel({ ...OPTIONS, allowOtherBots: true });
    await ch.start(send);

    await simulateMessage({
      channel: "C_TARGET",
      text: "from self",
      bot_id: "B_SELF",
      user: "U_BOT_SELF",
    });
    expect(send).not.toHaveBeenCalled();

    await ch.stop();
  });

  test("botUser option skips auth.test call", async () => {
    const ch = new SlackChannel({
      ...OPTIONS,
      botUser: "U_EXPLICIT_BOT",
      allowOtherBots: true,
    });
    await ch.start(send);

    // Self-message using the explicit botUser should be ignored
    await simulateMessage({
      channel: "C_TARGET",
      text: "from self",
      bot_id: "B_SELF",
      user: "U_EXPLICIT_BOT",
    });
    expect(send).not.toHaveBeenCalled();

    // Other bot message should be accepted
    await simulateMessage({
      channel: "C_TARGET",
      text: "from other",
      bot_id: "B_OTHER",
      user: "U_OTHER",
    });
    expect(send).toHaveBeenCalledTimes(1);

    await ch.stop();
  });

  test("last_question_updated updates the last question post", async () => {
    await channel.start(send);

    channel.receive(
      frame([
        {
          type: "question_created",
          question: "Which?",
          options: [{ label: "A" }, { label: "B" }],
          selected: 0,
        },
      ]),
    );
    channel.receive(
      frame([
        {
          type: "last_question_updated",
          question: "Which?",
          options: [{ label: "A" }, { label: "B" }],
          selected: 1,
        },
      ]),
    );
    await channel.stop();

    expect(mockPostMessage).toHaveBeenCalledTimes(1);
    expect(mockUpdate).toHaveBeenCalledTimes(1);
  });

  test("last_question_updated without prior question does not update", async () => {
    await channel.start(send);

    channel.receive(
      frame([
        {
          type: "last_question_updated",
          question: "orphan",
          options: [],
        },
      ]),
    );
    await channel.stop();

    expect(mockUpdate).not.toHaveBeenCalled();
  });

  test("question_created resets hasActivePost so indicator update does not target question", async () => {
    await channel.start(send);

    channel.receive(frame([{ type: "message_created", content: ["msg"] }]));
    channel.receive(
      frame([
        {
          type: "question_created",
          question: "Pick",
          options: [{ label: "A" }],
        },
      ]),
    );
    // Indicator change should NOT call update (hasActivePost was reset)
    channel.receive(frame([{ type: "indicator_changed", active: true, text: "Thinking..." }]));
    await channel.stop();

    expect(mockPostMessage).toHaveBeenCalledTimes(2);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  test("message_created after question resets hasActiveQuestion", async () => {
    await channel.start(send);

    channel.receive(
      frame([
        {
          type: "question_created",
          question: "Pick",
          options: [{ label: "A" }],
        },
      ]),
    );
    channel.receive(frame([{ type: "message_created", content: ["msg"] }]));
    // Orphan question update should NOT call update (hasActiveQuestion was reset)
    channel.receive(
      frame([
        {
          type: "last_question_updated",
          question: "Pick",
          options: [{ label: "A" }],
          selected: 0,
        },
      ]),
    );
    await channel.stop();

    expect(mockPostMessage).toHaveBeenCalledTimes(2);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  test("question_created strips indicator from previous message", async () => {
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
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        blocks: [
          {
            type: "rich_text",
            elements: [
              {
                type: "rich_text_section",
                elements: [{ type: "text", text: "msg" }],
              },
            ],
          },
        ],
      }),
    );
  });

  test("requireMention=true forwards messages with bot mention", async () => {
    const ch = new SlackChannel({
      ...OPTIONS,
      requireMention: true,
    });
    await ch.start(send);

    // Message without mention — should be ignored
    await simulateMessage({ channel: "C_TARGET", text: "no mention" });
    expect(send).not.toHaveBeenCalled();

    // Message with mention — should be forwarded with mention stripped
    await simulateMessage({ channel: "C_TARGET", text: "<@U_BOT_SELF> do something" });
    expect(send).toHaveBeenCalledWith({
      type: "text",
      content: "do something",
    });

    await ch.stop();
  });

  test("requireMention=true with mention-only message is ignored", async () => {
    const ch = new SlackChannel({
      ...OPTIONS,
      requireMention: true,
    });
    await ch.start(send);

    await simulateMessage({ channel: "C_TARGET", text: "<@U_BOT_SELF>" });
    expect(send).not.toHaveBeenCalled();

    await ch.stop();
  });

  test("input with control characters is sanitized", async () => {
    await channel.start(send);

    await simulateMessage({ channel: "C_TARGET", text: "hello\x03world\x1bfoo" });

    expect(send).toHaveBeenCalledWith({
      type: "text",
      content: "helloworldfoo",
    });
  });

  test("send=null does not crash on incoming message", async () => {
    await channel.start(null);

    await simulateMessage({ channel: "C_TARGET", text: "hello" });

    // No crash — just silently ignored
  });

  test("empty allowUsers rejects all users", async () => {
    const ch = new SlackChannel({
      ...OPTIONS,
      allowUsers: [],
    });
    await ch.start(send);

    await simulateMessage({ channel: "C_TARGET", text: "hello", user: "U_ANY" });
    expect(send).not.toHaveBeenCalled();

    await ch.stop();
  });

  test("emoji reaction :one: on question sends select input", async () => {
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

    await simulateReaction({
      reaction: "one",
      user: "U_HUMAN",
      item: { type: "message", channel: "C_TARGET", ts: "1234567890.123456" },
    });

    expect(send).toHaveBeenCalledWith({ type: "select", index: 0 });
  });

  test("emoji reaction :nine: selects 9th option", async () => {
    await channel.start(send);

    const options = Array.from({ length: 9 }, (_, i) => ({ label: String(i + 1) }));
    channel.receive(frame([{ type: "question_created", question: "Pick", options }]));
    await waitFor(() => !channel.hasPending);

    await simulateReaction({
      reaction: "nine",
      user: "U_HUMAN",
      item: { type: "message", channel: "C_TARGET", ts: "1234567890.123456" },
    });

    expect(send).toHaveBeenCalledWith({ type: "select", index: 8 });
  });

  test("emoji reaction on permission sends select input", async () => {
    await channel.start(send);

    channel.receive(
      frame([
        {
          type: "permission_required",
          command: "rm -rf /",
          options: [{ label: "Allow" }, { label: "Deny" }],
        },
      ]),
    );
    await waitFor(() => !channel.hasPending);

    await simulateReaction({
      reaction: "two",
      user: "U_HUMAN",
      item: { type: "message", channel: "C_TARGET", ts: "1234567890.123456" },
    });

    expect(send).toHaveBeenCalledWith({ type: "select", index: 1 });
  });

  test("emoji reaction with out-of-range number is ignored", async () => {
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

    await simulateReaction({
      reaction: "three",
      user: "U_HUMAN",
      item: { type: "message", channel: "C_TARGET", ts: "1234567890.123456" },
    });

    expect(send).not.toHaveBeenCalled();
  });

  test("unrelated emoji reaction is ignored", async () => {
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

    await simulateReaction({
      reaction: "thumbsup",
      user: "U_HUMAN",
      item: { type: "message", channel: "C_TARGET", ts: "1234567890.123456" },
    });

    expect(send).not.toHaveBeenCalled();
  });

  test("emoji reaction on different channel is ignored", async () => {
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

    await simulateReaction({
      reaction: "one",
      user: "U_HUMAN",
      item: { type: "message", channel: "C_OTHER", ts: "1234567890.123456" },
    });

    expect(send).not.toHaveBeenCalled();
  });

  test("emoji reaction on non-current message is ignored", async () => {
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

    await simulateReaction({
      reaction: "one",
      user: "U_HUMAN",
      item: { type: "message", channel: "C_TARGET", ts: "9999999999.999999" },
    });

    expect(send).not.toHaveBeenCalled();
  });

  test("emoji reaction when lastPost is message (not question/permission) is ignored", async () => {
    await channel.start(send);

    channel.receive(frame([{ type: "message_created", content: ["hello"] }]));
    await waitFor(() => !channel.hasPending);

    await simulateReaction({
      reaction: "one",
      user: "U_HUMAN",
      item: { type: "message", channel: "C_TARGET", ts: "1234567890.123456" },
    });

    expect(send).not.toHaveBeenCalled();
  });

  test("emoji reaction from disallowed user is ignored", async () => {
    const ch = new SlackChannel({ ...OPTIONS, allowUsers: ["U_ALLOWED"] });
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

    await simulateReaction({
      reaction: "one",
      user: "U_DENIED",
      item: { type: "message", channel: "C_TARGET", ts: "1234567890.123456" },
    });

    expect(send).not.toHaveBeenCalled();
    await ch.stop();
  });

  test("emoji reaction from bot itself is ignored", async () => {
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

    await simulateReaction({
      reaction: "one",
      user: "U_BOT_SELF",
      item: { type: "message", channel: "C_TARGET", ts: "1234567890.123456" },
    });

    expect(send).not.toHaveBeenCalled();
  });

  test("chat.postMessage failure does not break subsequent operations", async () => {
    await channel.start(send);

    mockPostMessage.mockImplementationOnce(() => Promise.reject(new Error("rate_limited")));

    channel.receive(frame([{ type: "message_created", content: ["fail"] }]));
    channel.receive(frame([{ type: "message_created", content: ["ok"] }]));
    await channel.stop();

    // First post fails, second should still be attempted
    expect(mockPostMessage).toHaveBeenCalledTimes(2);
  });

  test("multi-message post sends all messages individually", async () => {
    await channel.start(send);

    // Create content long enough to split into multiple messages
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i}: ${"x".repeat(30)}`);
    channel.receive(frame([{ type: "message_created", content: lines }]));
    await channel.stop();

    // Should have sent multiple messages
    expect(mockPostMessage.mock.calls.length).toBeGreaterThan(1);
  });
});
