# Fixtures

Sanitized real session files, one directory per agent per observed format version:

```
testdata/fixtures/<agent>/<format-version>/
    session-*.jsonl        # native payload (sanitized!)
    expected-*.json        # golden: canonical IR the parser must produce
```

Rules:

- **Never commit an unsanitized transcript.** Strip real paths outside the
  fixture project, all tokens/keys, personal data. Run `baton doctor
  --scan <file>` (P9) or manual review before adding.
- `<format-version>` matches the adapter's `FormatVersion()` that parses it.
- Golden files are regenerated only deliberately (`go test ./... -update`),
  never to silence a failing test.
