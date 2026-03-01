# Dump Channel

Records binary snapshots to disk. Useful for creating test fixtures for
scene development (see the
[`haruna-scene-dev` skill](../../../.claude/skills/haruna-scene-dev/SKILL.md)).

```yaml
channels:
  # Short form (all defaults)
  - dump

  # Detailed form
  - type: dump
    dir: ".haruna-dump"
    path: ./my-recording.dump # when set, dir is ignored
```

### Properties

| Property | Default          | Description                                    |
| -------- | ---------------- | ---------------------------------------------- |
| `dir`    | `".haruna-dump"` | Directory for auto-named dump files            |
| `path`   | —                | Explicit file path; when set, `dir` is ignored |

The dump channel is automatically disabled during `haruna replay`.
