# `shell` Scene Fixtures

Test fixtures for `shell` Scene regression tests. Each `.yml` is a
`haruna record`able procedure script; each `.dump` is the recorded output.

Most scripts use `bash --norc --noprofile` with `PS1="$ "` for
deterministic output. Some (e.g. `tab-completion.yml`) use `zsh`.
