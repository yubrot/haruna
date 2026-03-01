# Slack Channel

Connects haruna to a Slack channel via
[Socket Mode](https://api.slack.com/apis/socket-mode). Scene events (messages,
questions, permission prompts) are posted as Block Kit messages, and user
messages from Slack are forwarded to the PTY as text input.

```yaml
channels:
  # Short form (all defaults)
  # In this form, tokens default to the corresponding environment variables.
  - slack

  # Detailed form (all properties with defaults shown)
  - type: slack
    appToken: ${SLACK_APP_TOKEN} # REQUIRED
    botToken: ${SLACK_BOT_TOKEN} # REQUIRED
    botUser: ${SLACK_BOT_USER} # skips auth.test API call if provided
    channel: ${SLACK_CHANNEL} # REQUIRED
    thread: ${SLACK_THREAD}
    allowUsers: "*" # "*" | list of user IDs
    allowOtherBots: false
    requireMention: false
    echo: false
```

### Properties

| Property         | Default            | Description                                                                        |
| ---------------- | ------------------ | ---------------------------------------------------------------------------------- |
| `appToken`       | `$SLACK_APP_TOKEN` | REQUIRED: Slack app-level token (`xapp-…`) for Socket Mode                         |
| `botToken`       | `$SLACK_BOT_TOKEN` | REQUIRED: Slack bot token (`xoxb-…`) for Web API calls                             |
| `botUser`        | `$SLACK_BOT_USER`  | Bot user ID (`U…`). When provided, skips the `auth.test` API call at start         |
| `channel`        | `$SLACK_CHANNEL`   | REQUIRED: Slack channel ID for listening and posting                               |
| `thread`         | `$SLACK_THREAD`    | Message `ts` — if set, confine both listening and posting to this thread           |
| `allowUsers`     | `"*"` (allow all)  | User ID filter; string or list of strings. `"*"` allows all, `"!"` prefix denies   |
| `allowOtherBots` | `false`            | Accept messages from other bot users. Messages from self are always ignored        |
| `requireMention` | `false`            | Require bot @mention to accept input; mention prefix is stripped before forwarding |
| `echo`           | `false`            | Forward echo messages (user input echoed by the TUI)                               |

### `allowUsers` examples

```yaml
# Allow all users (default)
allowUsers: "*"

# Allow specific users only
allowUsers:
  - U0123ABCDE
  - U9876ZYXWV

# Allow all except specific users
allowUsers:
  - "*"
  - "!U0123ABCDE"
```

### Thread mode

Confine the bot to a specific thread by setting `thread` to the parent
message's `ts` value:

```yaml
channels:
  - type: slack
    channel: ${SLACK_CHANNEL}
    thread: ${SLACK_THREAD}
```

When `thread` is set, the bot only reads and posts messages within that thread.

## Slack App Setup

1. **Create a Slack App** at <https://api.slack.com/apps> — choose
   _"From scratch"_.

2. **Enable Socket Mode**
   - Go to **Settings > Socket Mode** and toggle it on.
   - Generate an **app-level token** with the `connections:write` scope.
     This is the `appToken` (`xapp-…`).

3. **Add Bot Token Scopes**
   - Go to **Features > OAuth & Permissions > Scopes > Bot Token Scopes** and
     add:
     - `chat:write` — post and update messages
     - `reactions:write` — add emoji reactions
   - The following scopes are not yet required but may be used in the future:
     - `channels:read` — resolve channel metadata
     - `files:read` — access shared files
     - `files:write` — upload files
     - `users:read` — resolve user display names
     - `chat:write.customize` — send messages with a customized username and avatar

4. **Subscribe to Events**
   - Go to **Features > Event Subscriptions** and toggle on.
   - Under **Subscribe to bot events**, add:
     - `message.channels` — messages in public channels
     - `message.groups` — messages in private channels (if needed)
     - `reaction_added` — emoji reaction added to a message
     - `reaction_removed` — emoji reaction removed from a message
   - Subscribing to these events automatically adds the corresponding
     `channels:history` / `groups:history` / `reactions:read` bot token scopes.
   - The following events are not yet required but may be subscribed to in the future:
     - `file_shared` — detect files shared by users
     - `app_mention` — lightweight alternative to filtering mentions from `message.*`
     - `member_joined_channel` / `member_left_channel` — detect bot added/removed from channel

5. **Install the App** to your workspace
   - Go to **Settings > Install App** and click _"Install to Workspace"_.
   - Copy the **Bot User OAuth Token** (`xoxb-…`). This is the `botToken`.

6. **Invite the bot** to the target channel
   - In Slack, open the channel and run `/invite @YourBotName`.

7. **Find the channel ID**
   - Right-click the channel name → _"View channel details"_ → the ID is at
     the bottom of the dialog (e.g. `C0123ABCDE`).
