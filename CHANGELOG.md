# Changelog

## Unreleased

- Add optional Codex web research before discussion, with an explicit public search question,
  time limit and reported search-operation limit. Save one cited evidence bundle for every
  seat, recovery and export; show research spending separately. Failures stop before discussion,
  interrupted research never automatically reruns, and debate tools remain disabled.
  Project safe research fields in agent snapshots, including older saved failures. Include
  shared source context in setup estimates and admission checks for discussion and verdicts.

- Save safe provider progress on timeout, cancellation and failure, including first output,
  last stage, idle time and byte counts. Show it in failure details and diagnostic downloads;
  preserve complete usage received before a stalled exit without retrying unknown spending.

- Enforce the provider tool guard on every discussion and verdict call, including recovered
  reviews. Stop reported tool activity without a repair; retain spending and exclude rejected
  text from later prompts. Inspect bounded CLI streams while running, strengthen Claude and
  Codex isolation flags, send Antigravity prompts on stdin and require explicit consent to
  Antigravity's remaining isolation limits with session-only tool denial rules.
  Invalid, incomplete or oversized streams stop the seat without retry or session reuse.
  Agent help documents Antigravity's explicit consent option and remaining isolation limits.

- Clear the board's reconnecting state as soon as its event stream reconnects, including
  while waiting for human input with no new events to replay.

- Explain when an earlier timeout or interruption left a seat's spending unknown. Show that
  cause on the blocked reply and distinguish unknown usage from a projected cap crossing.

- Recover interrupted discussions in fresh provider sessions seeded with completed rounds
  and saved notes, retaining earlier spending and deadlines. Preserve discussion completion
  reasons when a later verdict is cancelled.

- Resolve protected export directories through filesystem aliases, refuse linked record/index
  files, and exclusively create temporary files. Public exports now require an empty staging
  directory (an existing `.git` is preserved) and never delete destination contents.
  Preserve existing export/index permission bits on POSIX; new files respect the process umask.

- Redact known endpoint credentials from decoded replies and error excerpts before recording
  them. Endpoint configuration continues to belong to the trusted local user.

- Quote peer replies, repair text and discussion notes as attributed input records. Reject
  duplicate reply and verdict headers while preserving ordinary Markdown in content.

- Preserve Resume on server shutdown without recording a human Stop; close event streams and
  retain cancelled-call spending. Accept emphasis around whole reply and verdict header lines
  while preserving punctuation inside option labels.

### Review fixes

- Normalize replies, verdict headers, option punctuation and persona parentheticals in linear
  time, including adversarial whitespace and Unicode input. Preserve exact option labels
  ending in quotes, stars or punctuation before applying formatting tolerance.
- Flush a dispatch intent before every provider call; unfinished attempts remain unknown
  after restart and cannot bypass admission caps. Settled calls are counted once.
- Stop engines before cancelling server calls and refuse dispatch during shutdown.
- Rebuild failed reviews after cancelled turns settle so repaired storage can resume without
  restarting the server. Keep unknown spend and transcript-recovery warnings.
- Read history summaries asynchronously, cache unchanged records, bound inactive replays and
  avoid adding global pool/quota events to idle finished records.
- Remove invalid key-variable values before saving or restoring browser preferences.
- Preserve unreadable pool/calibration files, report their failure and block writes until
  repair and restart; replace valid settings atomically.

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

- Treat an expired input pause as final even when its timer fires before the overall deadline
  timer. Do not start a chairman call after the pause expires.

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

- Present the final answer and its reasons before supporting detail. Distinguish material
  clarifications from optional questions, and collapse panel positions and run metadata.
- Add Copy result with a manual clipboard fallback. Keep the agent verdict contract and full
  exports unchanged; old reviews remain readable without another model call.
- Ask for a direct, conditional conclusion when important facts are missing, and allow a
  nuanced synthesis for reflective questions. Do not manufacture questions or thresholds.

- Keep optional cat and alien personas in the public build, with their prompts and artwork in
  a readable catalogue. The public-tree test checks the catalogue before publication.
- Add preview status and clear feedback and support links to the README.
- Lay out a round as one column per option, in option order, from the first reply on. A reply
  lands at the foot of its column and nothing else moves; seats still thinking wait in a strip
  under the columns. Before, cards regrouped as each reply arrived and the page jumped.
- Tint a card against the majority as soon as replies arrive (provisional, "so far" in the
  tooltip) and settle the tint at the end of the round, instead of colouring only then.
- Show one banner with a **Reload** button when the board belongs to an earlier server
  session, and stop retrying from that page. Before, a board left open across a restart
  reported a page error and retried its diagnostics every 15 seconds, refused each time.
- Tell the chairman of an unattended review that any seat question is still open, so it lands
  under its open questions instead of reading as agreement.
- Recommend the chairman one effort step above the seats, in the agent recipe and the guide:
  the verdict is the call that decides, and a low-effort chairman dismisses the hardest
  objection in a word.
- Play a distinct rising cue when the table stops for you (after the blind round and for a
  seat's question), so a review left in another tab can call you back. The gavel sounds stay
  for opening and ending.
- Add an **Unattended** switch to the round settings, off by default: the review skips every
  pause, and the seats are told to state what they would have asked as assumptions instead of
  asking, since nobody answers; the question line leaves their contract, so its tokens leave
  every call too. For a review nobody will watch. The JSON client takes it as
  `options.unattended`.
- Explain each mood on hover: the mood list, the mood on a reply card and the mood of a seat
  that asked a question all carry its one-line description.
- Add a **Compact** switch in the header: every card folds to its seat and stance, so a round
  reads as who chose what; a click on a card opens that reply. The switch is remembered.
- Name every seat that asked a question above its answer field (name, lens and mood, with a
  persona's avatar), not only the lens. Seats still see each other by lens only.
- Show the effort a blank seat really runs at when the CLI's own default is known:
  "default (max)" for Codex, read from its config.
- Optional personas on Antigravity run on the lightest Gemini the account lists (Flash Lite
  where offered, otherwise Flash at low), instead of a fixed id.

- Seats and the chairman reply in the language of the decision; section headers stay English.
- Add **Choose…** beside both export fields: it opens the system's own folder dialog, so the
  folder no longer has to be typed.
- Give a chairman whose first attempt held no recommendation the whole question again on its
  retry. Before, a stateless retry carried only the format errors, so it could not know the
  decision it was judging.
- Use the same external data folder for live diagnostic workspaces and headless calibration
  reads as for saved reviews. Respect `ROUNDTABLE_DEBATES_DIR` in both commands.
- Reduce the demo quick start to clone, enter the folder and start the board.

- Mark session opening and completion with the chairman seat's pixel gavel and a quiet generated sound, with
  separate endings for a verdict, no verdict and a failure. Add a sound toggle. Keep the gavel out
  of saved-review replay and the JSON agent client, and keep the card still under reduced motion.
  Events a board missed while its connection was down now arrive as new, so a review that ends
  during the drop still shows its ending.
- Give the JSON agent client a `board` link in every result with a review id, so an agent can
  hand a person the page to watch. Add a small-review recipe for lenses, moods, effort, model
  and context fields to `agent --help` and the workflow guide.
- Redraw the grill, steelman, builder, contrarian and chairman icons, and the session gavel with them.
- Add per-seat token limits. Missing or partial usage blocks further calls for that seat,
  including retries and resumed reviews; other seats can continue.
- Select Haiku 4.5 by its explicit model id instead of the `haiku` alias.
- Keep the folder picker available while its dialog is open, and distinguish cancellation from
  a timeout or launch failure. Errors are visible beside the export field.
- Trim a reply with too many DISAGREE or NEW bullets to the limit instead of re-prompting the
  seat; the extra call cost more than the lost bullet. Show agents `gate.reopenCalls` when the
  seats already agree at round 0, so answering only reopens the table when it could change a
  position.
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
