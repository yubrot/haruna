# `claude-code` Scene Fixtures

Test fixtures for `claude-code` Scene regression tests. Each `.yml` is a
`haruna record`able procedure script; each `.dump` is the recorded output.

Scripts use `claude` with instruction files that direct Claude Code to
produce predictable output. Instruction files are in `instructions/`.

All wait conditions use `wait: { stable: ... }` instead of content-based
matching (`wait: { content: ... }`), since Claude Code's display format
may change across versions.

## Prerequisites

- Claude Code CLI (`claude`) must be installed and authenticated
- API access: Scripts that involve Claude responses (all except `idle.yml` and `mode-cycle.yml`)
  consume API calls on the authenticated account
- Network access: `fetch-permission.yml` requires internet to fetch
  https://yubrot.github.io/
- Permission mode: Claude Code must be in its default permission mode (prompts
  for tool use). The `permission.yml` and `fetch-permission.yml` scripts rely on
  permission prompts appearing. If Claude Code is configured with auto-approve
  for example, those scripts will not capture the permission UI correctly
