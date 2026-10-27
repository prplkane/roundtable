# Changelog

## Unreleased

### Security and usage

- Require HTTPS for hosted endpoints, including names with private-address-like prefixes.
  Limit decoded API responses, including errors, to 1 MiB.
- Check budgets before every provider attempt, including retries and fallback chairmen.
  Reserve for concurrent calls and the verdict; refused calls add no usage.
- Keep missing token counts unknown and block further calls to that vendor under a token cap,
  including after restart. Show unknown or partial totals while retaining reported costs.
- Make preflight reads cached-only. Authenticate refreshes, share overlapping checks, and
  bound concurrent work, queue size and cache size.
- Pin CI actions to commit IDs and make the dependency-update cooldown explicit.

### Records and recovery

- Recover an incomplete final transcript line with an exact backup before appending.
  Show recovery notices; keep corrupt completed records visible and block further writes.
- Preserve Resume notes before the first round and Stop notes entered during a round.
  Honor Stop without waiting for another input gate and prevent further seat retries.
- Retain the original chairman's model, effort and profile when requesting a missing verdict.
  Restore the human decision and reason on reload.

### Local operation and interface

- Give added seats distinct starter lenses and recover empty lenses in saved drafts. Highlight
  and focus missing or duplicate lenses and empty custom moods before a review starts.
- Explain lenses, moods and round settings with delayed, keyboard-accessible hints. Add a
  gentle reveal for hints and new replies, respect reduced motion, and keep replays still.
- Add local, rotating diagnostic logs and a **Save error log** download. Give failed actions
  reference IDs and next steps; keep pending browser diagnostics through reloads. Exclude
  review content, credentials, URLs and personal paths from the diagnostic data.
- Report failed quota saves and distinguish provider failures from malformed verdicts.
- Show Demo or Live mode, the active data folder, and backup guidance. Default to two seats
  and one critique round; remember saved settings and prefer ready logins on first use.
- Retain drafts after failed requests, explain errors, and prevent duplicate pending actions.
  Add setup/history retries and explicit status refresh; confirm pauses after acknowledgement.
- Improve keyboard focus, effort targets, narrow layouts and space for the action bar.
  Keep saved dollar caps editable when no dollar estimate is available.
- Serve the guide and fonts locally. Clarify setup, billing, tool restrictions and provider
  retention in the documentation and doctor output.

## 0.3.0

First public release.

- **Debates between the coding agents you already pay for.** Claude, Codex and Antigravity seats
  on their own subscriptions, any number per vendor, each with its own lens, mood, model and
  thinking level. A blind first round, critique rounds with a fixed reply format, stops for
  consensus, no movement, round limit, wall clock, budget or you.
- **You take part.** The board waits after the blind round, stops for any question a seat asks
  you, and carries your notes into every later round.
- **A sceptical chairman.** A fresh session writes the verdict: a recommendation, the dissent,
  kill criteria and open questions. It recommends; you accept an option on the board.
- **Usage tracking.** Per account: remaining quota where the vendor reports it, the projected
  draw per seat, and token or dollar caps checked against available usage estimates.
- **Failures you can read.** Each seat card has a lamp (ready, nearly used, out, not checked)
  from a free pre-flight check. A used-up quota or a lost login benches that account for the
  debate instead of failing every round.
- **API endpoint seats.** An OpenAI-compatible endpoint can take a seat: a local server (Ollama,
  LM Studio, vLLM, llama.cpp) or a pay-per-token API (DeepSeek, Moonshot, OpenAI). Every card and
  record says whether a seat is a CLI on a subscription or an API.
- **Decision records.** Export a debate as a markdown record and an index into any codebase, so
  your coding agents can read what was decided.
- **`npx @prplkane/roundtable`** starts the board and opens it in your browser; `doctor` shows
  what your machine can seat.
