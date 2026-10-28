# Changelog

## Unreleased

### Security and usage

- Require HTTPS for hosted endpoints, including names with private-address-like prefixes.
  Limit decoded API responses, including errors, to 1 MiB.
- Check budgets before every provider attempt, including retries and fallback chairmen.
  Reserve for concurrent calls and the verdict; refused calls add no usage.
- Recheck the wall-clock deadline after a retry delay, before dispatching another provider call.
- Carry the saved cumulative cost into resumed CLI calls so a server restart does not charge it twice.
- Keep missing token counts unknown and block further calls to that vendor under a token cap,
  including after restart. Show unknown or partial totals while retaining reported costs.
- Make preflight reads cached-only. Authenticate refreshes, share overlapping checks, and
  bound concurrent work, queue size and cache size.
- Send a Content-Security-Policy, `nosniff` and a no-referrer policy with every response, so
  only the server's own scripts can run in the page that holds the launch token.
- Pin CI actions to commit IDs and make the dependency-update cooldown explicit.

### Records and recovery

- Add Delete and Clear finished with confirmation and protection for active sessions. Keep
  exported files and usage statistics after cleanup. Default history to the OS user-data folder,
  outside the checkout, and allow one server per data folder.
- Make Stop cancel the whole review, including automatic and manually requested verdicts.
  Keep Stop visible during synthesis and distinguish cancellation from successful completion.
  Cancel active calls even if a transcript write fails; fatal engine errors cancel them too.
- Add Finish with verdict after the first usable round, so ending discussion and aborting the
  whole review are separate choices in the board and agent client.
- Keep agent-submitted notes distinct from human notes in the board, prompts, replay and exports.
- Ignore explicit no-question placeholders when deciding whether to pause. Preserve the blind
  round pause and questions that still need an answer, without another model call.
- Recover an incomplete final transcript line with an exact backup before appending.
  Show recovery notices; keep corrupt completed records visible and block further writes.
- Preserve Resume notes before the first round and Stop notes entered during a round.
  Honor Stop without waiting for another input gate and prevent further seat retries.
- Retain the original chairman's model, effort and profile when requesting a missing verdict.
  Restore the human decision and reason on reload.

### Local operation and interface

- Mark session opening and completion with the chairman seat's pixel gavel and a quiet generated sound, with
  separate endings for a verdict, no verdict and a failure. Add a sound toggle. Keep the gavel out
  of saved-review replay and the JSON agent client, and keep the card still under reduced motion.
  Events a board missed while its connection was down now arrive as new, so a review that ends
  during the drop still shows its ending.
- Give the JSON agent client a `board` link in every result with a review id, so an agent can
  hand a person the page to watch. Add a small-review recipe for lenses, moods, effort, model
  and context fields to `agent --help` and the workflow guide.
- Put delayed hover explanations on text labels. Separate positions from arguments, emphasize
  rejection words, and collapse usage into quota bars with expandable details.
- Collect questions and answers in one area, combine identical questions without a model call,
  and wait for final-round answers before the verdict. Reject stale-round submissions.
- Close discussion controls when rounds end. Explain Stop, provider timeout and review expiry
  separately, including expiry while waiting for input; retain those reasons on replay.
- Add JSON agent commands for setup checks, estimates, start, bounded waits, answers and recovery.
  Keep launch tokens in memory and require explicit actions for calls. Shorten response targets.
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
- **The `roundtable` command** starts the board and opens it in your browser (as
  `npx @prplkane/roundtable` once the package is published); `doctor` shows what your machine
  can seat.
