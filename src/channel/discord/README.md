# Discord Channel

Connects haruna to a Discord text channel via
[discord.js](https://discord.js.org/). Scene events (messages, questions,
permission prompts) are posted as Markdown messages, and user messages from
Discord are forwarded to the PTY as text input.

```yaml
channels:
  # Short form (all defaults)
  # In this form, token defaults to the corresponding environment variable.
  - discord

  # Detailed form (all properties with defaults shown)
  - type: discord
    token: ${DISCORD_TOKEN} # REQUIRED
    channel: ${DISCORD_CHANNEL} # REQUIRED
    allowUsers: "*" # "*" | list of user IDs
    allowOtherBots: false
    requireMention: false
    echo: false
```

### Properties

| Property         | Default            | Description                                                                        |
| ---------------- | ------------------ | ---------------------------------------------------------------------------------- |
| `token`          | `$DISCORD_TOKEN`   | REQUIRED: Discord bot token                                                        |
| `channel`        | `$DISCORD_CHANNEL` | REQUIRED: Discord channel ID for listening and posting                             |
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
  - "123456789012345678"
  - "987654321098765432"

# Allow all except specific users
allowUsers:
  - "*"
  - "!123456789012345678"
```

### Reaction input

When a question or permission prompt is active, users can respond by adding
a number emoji reaction (1️⃣–9️⃣) to the bot's most recent message. The
bot maps the emoji to the corresponding option index.

## Discord Bot Setup

1. **Create a Discord Application** at <https://discord.com/developers/applications>
   — click _"New Application"_.

2. **Create a Bot**
   - Go to **Bot** in the sidebar.
   - Click _"Reset Token"_ (or _"Copy"_ if first time) to get the bot token.
     This is the `token` value.

3. **Enable Privileged Intents**
   - On the **Bot** page, under **Privileged Gateway Intents**, enable:
     - **Message Content Intent** — required to read message text
   - The following intents are not yet required but may be used in the future:
     - **Server Members Intent**

4. **Generate an Invite URL**
   - Go to **OAuth2 > OAuth2 URL Generator**.
   - Under **Scopes**, select `bot`.
   - Under **Bot Permissions**, select:
     - `Send Messages`
     - `Read Message History`
     - `Add Reactions`
     - `Manage Messages` (for editing/deleting bot messages)
     - `Send Messages in Threads` (for posting in threads; threads are channels in Discord)
   - The following permissions are not yet required but may be used in the future:
     - `Embed Links` — rich embeds in messages
     - `Attach Files` — upload files and images
     - `Create Public Threads` — create threads per session
   - Copy the generated URL and open it in a browser to add the bot to
     your server.

5. **Enable Developer Mode** (to find channel IDs)
   - In Discord: **Settings > Advanced > Developer Mode** → toggle on.
   - Right-click a channel → _"Copy Channel ID"_. This is the `channel` value.

> **Note**: Discord IDs (channel IDs, user IDs) are 64-bit integers that
> exceed JavaScript's `Number.MAX_SAFE_INTEGER`. Always **quote them as
> strings** in YAML to avoid silent precision loss:
>
> ```yaml
> channel: "1234567890123456789"   # correct
> channel: 1234567890123456789     # WRONG — silently truncated by YAML parser
> ```
