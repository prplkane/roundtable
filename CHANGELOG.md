# Changelog

## 0.6.5

### Agent API

- Say who wrote each answer: every answer to `roundtable_answer` or `agent answer` takes
  `from: "user"` or `from: "assistant"`, and a missing `from` counts as `assistant`. A submission made
  only of the user's own answers reaches the board as "You said, via your assistant", and the
  seats and the exported record as the human's answer relayed by the assistant; anything else
  stays an agent note whose answer lines say whose words they are. The declaration is the
  assistant's and is shown, not verified.
- Deadlines readable without arithmetic: `deadlineAt` and `gate.autoContinueAt` (epoch
  milliseconds) now come with `deadlineAtIso`, `secondsUntilDeadline`, `autoContinueAtIso`
  and `secondsUntilAutoContinue`; `roundtable_hold` returns the same pair for the renewed
  window.

## 0.6.4

### Terminal

- Report only the provider CLIs found on this machine: `roundtable doctor` lists missing ones
  in a single line instead of a block each (`--vendor <name>` still shows the full block), and
  foreground startup prints a `providers:` line in the seat colours instead of a failed quota
  read for every CLI that is not installed.
- Always print how to open the board and that Ctrl+C stops it, including with `--no-open`.
- Say plainly when the port cannot be taken: in use, or a sandbox that forbids a local server
  (`EPERM`), with the `roundtable server start` way out. The MCP tools and `roundtable server
  start` report that last line within seconds instead of waiting out the readiness timeout,
  while two hosts starting the board at once both get the one that won the port.
- Blink the block cursor beside the wordmark where the terminal allows blinking text, and show
  vendor names in their seat colours.

## 0.6.3

### Assistant integration

- Add `roundtable setup` to connect user-level MCP tools and a workflow skill for Codex,
  Claude Code and Antigravity across projects. Include checks and removal, preserve unrelated
  settings and refuse to overwrite edited entries. No automatic npm install hook is added.
- Add a dependency-free stdio MCP adapter using the existing JSON client. Start a hidden
  local board on demand, expose questions and bounded extensions, and keep reviews running
  when the host disconnects. Report completion only after a ready chairman verdict.
- Recommend one critique round for normal agent reviews and reserve zero for quick
  comparisons. Report actual completed rounds so agents cannot mistake blind positions
  for a discussion. Bundle the skill in the npm payload and test installation outside a checkout.
- Count attempted rounds separately from rounds with usable replies, so failed critiques do
  not inflate review depth. Share the HTTP client and validation bounds between MCP and CLI;
  remove the subprocess watchdog that could interrupt a valid long wait.
- Check server health without waiting for provider catalogues; retry transient readiness
  errors and refuse incompatible versions, modes or explicit storage directories. Add idle-only
  server status/start/stop/restart commands for installed updates.
- Preserve all unmanaged TOML declaration forms, literal dollar strings, selected modes and
  ports. Honor Claude profile overrides, check the Node executable and repair missing managed
  files. Test a real npm archive installation after moving its source checkout.

### Review workflow

- Make attended checkpoints finite in both the browser and agent client: 15 seconds for a
  correction window and two minutes for a question by default, configurable separately.
  An unanswered window continues with unknowns intact; it never supplies an answer or accepts
  the recommendation. The hard wall clock still applies.
- Replace permanent holds on incidental browser clicks with bounded extensions while writing
  or requesting More time. Show question countdowns, draw attention in the tab title, and
  retain automatic-continuation notices after reload.
- Return an explicit question handoff, answer template, deadline and commands to coordinating
  agents. Add `agent hold` for a bounded extension and `wait --after-round` to await a response
  without asking the same question again. Empty checkpoints need no user confirmation.

### Documentation

- Add Linux first-connection steps, including a direct GitHub archive install, assistant
  registration, discovery checks and a provider-free demo.
- Show the app's pixel logo tile in interactive help and foreground startup, drawn with half
  blocks in the orchid and aubergine of the board header, with the wordmark and installed
  version beside it. Respect terminal width, UTF-8 support and `NO_COLOR`; keep redirected
  output and machine protocols undecorated.
- Add a Known issues entry to the guide, linked from the README: Codex calls can stall, what
  Roundtable does about it and what it cannot do.

## 0.6.2

- Simplify model names to default and lightest annotations, removing inferred plan restrictions.
- Let Claude's next quota refresh recover after a free `/usage` answer without limits.
  Keep the safeguards for answers that may have called a model.
- Show the latest quota on every provider card and replace the first-call promise with
  "quota unavailable" when no figure is known.
- Make Clear include interrupted sessions as well as finished ones. Running reviews and
  reviews waiting for input remain protected, with the full selection checked before deletion.
- Remove deletion success banners from the history list.
- Clarify that usage statistics describe your own agents' Roundtable calls, stay on your
  machine, and are not sent to Roundtable's developers. Document restarting after updates.
- Take the version shown in the board footer and sent in the Codex app-server handshake from
  `package.json`; both still said 0.6.1.

### Review fixes

- Stream Codex replies over WebSocket, so a response that never starts is caught. A request
  can be held for minutes before its response starts (one traced call: 173 seconds). Over SSE,
  Codex starts its idle timer only once response headers arrive, so that wait had no limit short
  of Roundtable's call limit; over WebSocket the timer starts when the request is sent. Against a
  local server that never answers, SSE waited until it was killed, while WebSocket reconnected at
  each idle limit. On the real backend, 18 WebSocket calls at low, medium and high effort all
  answered, with no reconnect on a healthy call; the three stalls were resent at their idle
  limit. After its reconnects Codex falls back to HTTPS for the rest of the call, where the wait
  for response headers is again bounded only by the call limit, and a WebSocket that does not
  open within 10 seconds does the same. Reconnects are now counted from Codex's retry log too,
  since its events leave out the first WebSocket retry.
- Reconnect a silent Codex request after 15 seconds instead of up to 95. Each request a Codex
  call makes either streams within a few seconds or stays silent, on every model and search mode
  tried, through `codex exec` and `codex app-server` alike, with or without Roundtable's
  settings. A Codex seat, chairman or searcher at low effort (or none or minimal) now reconnects
  after 15 seconds of silence, up to five times, and a reconnect resends only the silent request.
  This does not make stalls rarer (in testing, 15, 35 and 60 second limits each saw one or two
  slow calls in eight); it makes a silent one cost about 15 seconds instead of 95 for a seat at
  the default call limit, where stalled low-effort seats took 101 to 220 seconds. Other efforts
  keep the limit derived from the call limit, since a request that reasons longer may stay silent
  while healthy (GPT-6.1 Sol at high effort sent no stream events for 15 to 17 seconds).
- Count a Codex searcher's reconnect notices as progress, and start once more a searcher call
  whose reconnects all failed. The reconnects are bounded, and a reconnect keeps a finished
  search, so stopping the call at a reconnect threw that search away. The fresh attempt follows
  the 0.6.1 rules: at least 30 seconds must remain, and both attempts share the time limit.
- Keep a search whose sources include a date the searcher could not give as a real `YYYY-MM-DD`
  date. One such date (a month only, a year only, "unknown") used to reject the whole source
  bundle and stop the review before discussion; that source's date is now saved as not reported
  and the other sources keep theirs.

### Security and usage

- Ask a Codex searcher for one search call carrying several queries. Each further call is another
  request that can stall, and it resends everything gathered so far: input grew from about 22k
  tokens for one search to 103k for four. In testing, one call returned as many sources (3 on
  average) at 23k input tokens on average instead of 35k, with a median of 13 seconds instead of
  41. The search limit is unchanged: a second call is still allowed when the first returned
  nothing usable. Claude and Antigravity search one query per call and get no such hint.

## 0.6.1

### Security and usage

- Require acknowledgment of Antigravity's account-risk notice before provider calls, model
  lists or quota reads. Google's [FAQ](https://antigravity.google/docs/faq) says third-party
  wrappers are unsupported under consumer plans and third-party access can lead to account
  suspension or termination. The board records the acknowledgment locally; it can be
  withdrawn and is requested again when the notice is updated.
- **Upgrading Antigravity workflows:** agent requests now need
  `options.acknowledgeTermsRisk: true`, after the person agrees. `doctor` needs
  `--acknowledge-terms-risk` for anything beyond `agy --version`. These are separate from
  limited-isolation consent. See the [setup guide](docs/workflow.md#antigravity-google).

### Review fixes

- Restore GPT-6.1 Terra in the Codex picker and order model families from stronger to lighter,
  keeping plan restrictions visible. Custom model IDs remain editable instead of reverting to Default.
- Align card controls and effort indicators; put provider warnings in an expandable row.
  Refresh the status after an account notice is acknowledged or withdrawn.
- Start the searcher query from the question and options, with a preview and an editable custom query.
  Other context and discussion answers stay out of research.
- Put the chairman's recommended option above its answer in bold uppercase. Rename history's
  cleanup action to Clear; its confirmation still identifies the finished sessions to remove.

- Stop a Codex searcher call after 40 seconds without progress and allow one fresh attempt
  when at least 30 seconds remain. Both attempts share the searcher's time limit and are
  recorded. Reconnect notices do not count as progress. Missing usage from the first attempt
  remains unknown and can block the second under a token cap. Each attempt has its own
  search-operation limit. This bounds recovery; it does not repair a failing network route.

### Documentation

- Explain provider regional availability, the limits of login/status checks, and how to
  investigate stalled connections. Clarify that Roundtable leaves VPN, proxy and DNS settings
  unchanged; network comparisons are optional diagnostics.
- Clarify that Codex's stream-idle timer does not cover every connection stage. Roundtable's
  overall call limit still applies while the CLI waits for a response to begin.

## 0.6.0

### Review fixes

- Keep successful research when the searcher repeats a source URL. Repeated URLs become one
  citation, with distinct excerpts combined when they fit the existing limit. Every record
  still passes URL, date and length checks; no extra model call is made to repair duplicates.
- Offer each Codex model only the effort levels it takes. The Luna models stop at `max`
  (`codex debug models`), but every Codex model was offered `ultra`. The pips, the chairman's
  effort list and the server's check now follow the chosen model, and picking a model that
  does not take the chosen level returns the seat to the CLI's default.

### Security and usage

- Read Claude's remaining quota with `claude -p /usage`, which the CLI answers itself with no
  model call, at start, on Refresh status, after each Claude reply and when a debate ends. Claude
  no longer shows "not reported" until its first reply after every server start, and its
  per-model weekly limit (for example "7d Fable") now appears beside the session and weekly
  ones. Only the limit lines are kept; the local activity summary in the same answer is
  discarded. A reply's own figure stands in when the read gives nothing. An answer that shows a
  turn, tokens or a cost, one with no plan limits (API-key billing), or a read that times out
  stops further reads until restart. Calibration now treats reset times a few minutes apart as
  the same window, since `/usage` prints them to the minute.
- Read Antigravity's remaining quota with `agy -p /usage`, which the CLI answers itself with no
  model call. Its limits come per model group (Gemini; Claude and GPT; Gemini 4 Argon on some
  plans), and the seat lamps, the quota line and the quota picture show the windows of the
  group each seat's model draws on, with the used share and the reset time. An answer that
  shows a turn, tokens or a conversation, or a read that times out, stops further reads until
  the server restarts, so a CLI change can cost one call, never one per reply. Measured quota
  rates for Antigravity are kept per model and only against that model's group.
- Bench only the used-up Antigravity model group, not the whole login: when an Argon seat
  reports a used-up quota, the Gemini and Claude seats on the same login keep answering. A
  seat on the default model, whose group cannot be told, and a logged-out CLI still take the
  whole login out, as for every other vendor.
- Keep Roundtable's calls out of each CLI's own history. Claude seats now pass
  `--no-session-persistence` and Codex seats `--ephemeral`, so a stateless seat, chairman or
  searcher call no longer leaves a session, prompts included, under `~/.claude/projects` or
  `~/.codex/sessions`. Only seats in resume memory, whose next round continues the session,
  still save it. Antigravity has no such flag.
- Read Antigravity's AI credits with `agy -p /credits`, which the CLI answers itself with no
  model call, beside the `/usage` read and at most every ten minutes. The usage table shows
  "AI credits left", which you previously had to type in from the credits page.

### Local operation and interface

- Keep Windows history and login profiles in `%USERPROFILE%\.roundtable` instead of
  `%LOCALAPPDATA%\Roundtable`. Windows redirects the AppData writes of anything started from a
  packaged app, such as the Claude or Codex desktop app and their terminals, into a private copy
  per app, so each app saw its own history and its own one-server lock. At startup Roundtable
  now lists every older folder that still holds a review the data folder lacks: a checkout's
  `debates/`, the earlier AppData folder and each packaged app's copy of it. It never moves them
  itself. A login profile made under the earlier AppData default keeps working until it is moved.
- Stream Codex replies over SSE with an idle limit that fits inside the call limit and two
  reconnects, through a provider entry named per call that points at the same ChatGPT backend
  with the same login. The built-in provider offers no idle or reconnect setting, and the CLI's
  documented stream-idle default equals the default call limit, so a stalled reply ran the full
  five minutes before failing; it now reconnects after 95 seconds at that limit and fails sooner
  once the reconnects are used up. That a custom provider may use the ChatGPT login is not documented;
  `SECURITY.md` names both ways a future CLI could react. Every reconnect is counted into the
  attempt's saved progress and shown as a "reconnected ×N" mark on the reply card, in failure
  details, error logs and the agent state, so a recovered stall stays visible.
- Wait out an API endpoint's short rate limit once instead of benching its host for the rest of
  the debate. A `429` whose `Retry-After` asks for 30 seconds or less, the delay `agy` itself
  waits out, is retried once after that wait when it ends before the wall clock does. Without
  `Retry-After`, with a longer one, or at a second `429` the host is benched as before; `402`
  and every other status are unchanged. A `429` now counts as zero tokens, since the server
  refused the request before the model ran, so a seat's token cap no longer blocks the retry or
  later rounds as unknown spending. Stop, finish and the wall clock end a retry's wait at once,
  for this wait and a network failure's, and a retry is skipped when another seat benched the
  same login during the wait. The limited attempt is recorded with the kind `throttled`.

## 0.5.0

### Security and usage

- Fix the Antigravity tool guard for CLI 1.4, which reports each tool as a `step_update` with
  the tool inside it. The guard read only the older shapes, so a tool that no Antigravity
  permission rule can deny, its web search, went unnoticed. Any reported tool step now stops
  the seat at once, as it does for Claude and Codex.

### Local operation and interface

- Move a reply card as it opens and folds: the body under its seat and position unrolls over
  the board's base motion time and rolls up a little faster before the card folds. Reduced
  motion opens and folds it at once. The card head is also a button, so Enter or Space opens
  and folds it, and focus stays on it while other replies land.
- Codex calls disable analytics/telemetry uploads and unlimited connection retries. A valid
  completed answer with measured usage survives a CLI that hangs during shutdown; incomplete
  answers still fail without a timeout retry. Search and reconnect stages appear in diagnostics.
- Treat Codex warning items as diagnostics instead of tool use, and surface a failed turn's
  provider error promptly. Unknown tools remain blocked. Resolve npm and native CLIs in PATH
  order so a later desktop binary cannot replace the terminal's selected installation.
- Stop presenting Codex defaults from user configuration that isolated calls ignore. Keep
  model and effort choices explicit when reproducibility matters.
- Keep parent Codex app routing and session variables out of child CLIs and quota reads.
  Use a shorter decision-review base prompt for Codex instead of its coding-agent prompt;
  the tool restrictions remain unchanged. The temporary instruction file is removed after
  each call, including failures.
- Charge Codex resume calls by the increase in session token counters. Previous rounds are no
  longer counted again against usage and budget caps. Missing or decreasing baselines remain
  unknown; fresh sessions start their accounting from zero.
- Show the chairman at work: while the verdict call runs, the Conclusion panel draws a pixel
  sheet being written under a quill instead of staying hidden. Reduced motion shows a still page.
- Keep a round or detail the person folded or opened across redraws; before, every server
  event reopened the latest round and closed everything else.
- Give the option columns their own grid, so two options fill the row with no blank third
  column beside them when a note or the thinking strip is present.
- Move reported quota to one quiet line above the board; the question now heads the review
  state, the conclusion and the rounds directly.
- Show a plain boot screen when setup takes longer than a moment: the logo in pixels, its
  ring breathing slowly in and out while a light runs round the seats, and one line of text.
- Box only the main controls. Row Delete appears on hover or focus (always on touch), Show all
  and Clear finished are quiet text at the foot of the debates list, the review state and CLI
  seats are unboxed, recommended states take their colour, and partial token sums show "+".
- Fewer controls in the header: Compact is gone; each reply card starts folded to its seat and
  position, even in the round that is still coming in, and opens by a click on its head;
  theme and sound are pixel icons; Save error log moved to the status line. The debates list
  folds and the browser remembers it.
- Lead the board with the question as its heading and the review state as a small tag beside
  it. Usage details is a toggle that never moves; its table groups seats under one line per
  account, right-aligns numbers and marks partial sums with "+" as the debates list does.
- Start every fold closed: debates, More context, the Quota picture, login profiles, and rounds
  once a review is finished. More context spans the panel; run settings take the width they
  need. Quota cards share one layout, with a shade per seat and a hatched chairman in the bar.
- Rework the paper theme on night's structure: a faint plum page, white fields with visible
  borders, seat colours closer to night's hues at text contrast, softer position tints.
- Make research a visible role, the **searcher**: a card added with **+ Add searcher** beside
  the chairman, with an open pixel eye as its mark. It has its own vendor, model,
  effort and login profile instead of borrowing the first Codex seat's. Pick Claude, Codex or
  Antigravity on its card; it starts on that vendor's lightest model at low effort, and agent
  requests may set all four in `options.research` (Codex when no vendor is named). Claude
  searches with WebSearch as its only tool, and its own search count and search-model tokens
  are included; on Antigravity any tool but its web search stops it. It
  replaces the research panel and its switch, and is named on the board, in Usage details and in
  the quota picture. While it works the review state reads "Searcher at work" and the sources
  panel shows its eye moving down a column of results, lighting the ones it keeps; with reduced
  motion the picture stays still. Its card title and Effort carry a help tip, the README's
  "How a review works" names it as an optional step, and the chairman's Effort has the tip too.
- Show Antigravity's limited isolation on the card that runs on it, seat, chairman or searcher:
  one warning line whose tip says in three sentences what cannot be sealed off, what Roundtable
  denies and stops, and that choosing Antigravity accepts it. Choosing it there is the consent
  the board sends, so there is no separate switch and no refusal when the table opens. Agent
  requests still send `allowLimitedIsolation: true`; without it the server refuses Antigravity.
- Fix a stray brace in the stylesheet that dropped the quota readout grid, and debate titles
  squeezed to one letter at medium widths.

## 0.4.0

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
