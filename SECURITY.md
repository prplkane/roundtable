# Security

Roundtable runs a loopback server on your machine. Live debates use the vendor CLIs you
installed or API endpoints you explicitly configure; demo mode uses scripted replies.

## Data and execution

- **No telemetry or analytics service.** Usage statistics describe your own agents' calls in
  Roundtable. They are calculated and stored on your machine; Roundtable sends no usage
  statistics, review text or diagnostic logs to its developers. Live reviews still send the
  required prompts to your selected providers, whose data handling is separate.
- **CLI login files stay with the CLI.** Roundtable does not read or copy those files. It runs each vendor's
  own CLI (`claude`, `codex`, `agy`) as a child process, and that CLI does its own login the way
  it does in your terminal. A test asserts that no source file names a credential file or copies
  one. A second account ("login profile") is an empty directory under the OS user-data folder
  (`%USERPROFILE%\.roundtable\homes\<profile>\<vendor>`, `~/Library/Application Support/roundtable/...`,
  `~/.local/share/roundtable/...`) that you log into yourself once; Roundtable only points the
  CLI at it through the variable the CLI documents.
- **Billing: the subscription, unless you say otherwise.** The child's environment is yours minus
  Claude Code session variables, parent Codex app routing/session variables and API-key variables (`ANTHROPIC_API_KEY`,
  `OPENAI_API_KEY`, `GEMINI_API_KEY` and the like), so a key left in your shell cannot move a
  debate onto pay-per-token. Set `ROUNDTABLE_API_BILLING=1` to pass them through on purpose.
- **Budget caps check admission, including retries.** Each provider attempt is checked against
  reported usage, calls already in flight, and the projected next call. Seat calls leave room
  for a projected verdict; a fallback chairman is checked against its own vendor's cap.
  Missing or unusable token counts block further calls to that vendor under a vendor token cap,
  including after a restart; already dispatched calls may finish. Discussion seats also have an
  automatic cap of 400,000 tokens per review (60,000 for optional personas). Missing or partial
  usage blocks further calls for that seat. The explanation identifies a recorded timeout or
  interruption without treating missing usage as zero or measured cap exhaustion. The chairman
  follows the vendor budget.
  Unknown usage and partial totals are labelled, and reported dollar costs are kept separately.
  These checks use estimates and available usage reports, not a provider-enforced billing
  ceiling: a call already running can consume more than projected.
  A flushed dispatch record is saved before each call. After an interruption, a dispatch
  without its matching result is unknown usage and cannot silently reset a capped review.
- **An API endpoint seat is the one case where Roundtable itself sends a request.** You name a
  base URL, a model and the *name* of the environment variable holding the key (never the key;
  a pasted key is refused on shape). At call time the key is read from the environment you
  started Roundtable from and sent as a bearer to that URL only, with redirects refused. It is
  not deliberately added to transcripts, logs or the board. Endpoint response and error text
  can be displayed and recorded. Known credential echoes are redacted from decoded replies
  and error excerpts before recording; deliberately encoded copies may evade this filter.
  Existing records are not rewritten. Use an endpoint you trust with the credential.
  Plain `http` is accepted for local names and private IP literals; a hosted
  API must be `https`. A DNS name starting with a private-address prefix, such as
  `10.api.example.com`, is still a hosted name and requires HTTPS. Local names rely on your
  network's name resolution. Endpoint responses are limited to **1 MiB of decoded body bytes**,
  including compressed and error responses; an oversized response is cancelled and fails the
  call without a network retry. Preflight sends no probe to the endpoint, even on an authenticated
  refresh; the first real call checks the connection. Such a seat bills the endpoint's account,
  and its card says `API · pay-per-token`.
- **Cancellation:** Stop cancels this review's owned CLI processes and local endpoint requests,
  including an active chairman. It prevents new rounds, retries, fallback calls and automatic
  synthesis. Saved replies and reported usage remain. A provider may already have processed a
  dispatched request; cancelling locally does not guarantee a billing reversal upstream.
  Server shutdown interrupts active reviews without recording human Stop or starting synthesis.
  Event streams close; settled calls retain reported spending before exit. Unsettled dispatches
  remain unknown on restart. Saved discussions offer Resume, or Write if discussion had ended.
  Finish with verdict is a separate action: it cancels unfinished discussion calls, then permits
  the chairman under the existing budget and time limits. It requires a completed, usable round.
- **Network:** the browser loads the board, styles and fonts locally; it does not fetch a remote
  font stylesheet. Live provider traffic is the CLIs' own traffic and the endpoint traffic
  above. Roundtable leaves VPN, proxy and system DNS configuration unchanged; provider
  availability and regional connectivity remain external requirements. The server listens on
  `127.0.0.1`. A debate sends its notes and relevant replies to the
  selected providers. Stateless mode limits the context Roundtable resends; it does not control
  provider logging or retention.
- **On disk:** history defaults to the OS user-data folder, outside the checkout, with separate
  `live` and `demo` directories. `ROUNDTABLE_DEBATES_DIR` overrides that location. Each holds one folder per debate with the transcript (field notes, replies,
  your notes, usage figures), `field-notes.md` and `verdict.md`; plus the calibration and pool
  figures. Live diagnostic working files use the same data folder. Legacy checkout data
  folders remain gitignored. A CLI's full raw output is kept in memory during
  a call; selected replies, errors and usage are recorded. Copy the entire data folder while
  the server is stopped to back it up. Exported records and CLI login profiles live separately.
  The browser also retains field notes, seat choices, limits, chairman settings and budgets in
  local storage for that address. Clearing browser data removes those preferences, not server
  records. They can contain private context; use a browser profile you trust.
- **History cleanup:** Delete and Clear include finished and interrupted sessions.
  Authenticated requests recheck that none are running or waiting for input. A data-folder
  lock prevents two servers from sharing the same writable history.
  Cleanup refuses linked directories and nested links. It saves `_usage.json` before removing
  transcripts, recovery backups and seat working files. This file keeps usage counters and model
  identifiers under hashed session IDs, without titles, prompts, replies, notes or account paths.
  Exports, quota calibration and provider records are not deleted. This is ordinary file deletion,
  not secure erasure; backups, browser preferences and provider histories are separate.
- **Transcript recovery:** reads never change the transcript. Before appending after an
  incomplete final line, Roundtable saves the exact original as `transcript.recovery-<id>.jsonl`
  beside it and atomically replaces the transcript with its complete prefix and a recovery
  notice. Backups contain the same private debate data and belong in your backup/deletion
  policy. Corrupt completed lines block resume and export until restored from a backup.
  A storage failure cancels and settles active turns before exposing Resume or a missing
  verdict. Repair the storage problem first; recovery never retries a provider call on its own.
  Resuming an interrupted discussion creates fresh provider sessions because old threads can
  contain unsaved work. Completed rounds and saved notes supply their context; all prior spend
  remains in the ledger. Cancelling synthesis preserves the discussion's original stop cause.
- **Local settings:** unreadable calibration or pool JSON is logged and preserved. Restore the
  file and restart before saving changes; writes use temporary files and atomic replacement.
- **Provider output:** reply and verdict normalization uses linear scans, including Markdown
  decorations and optional persona filtering. Browser rendering still treats this as text.
  Later prompts quote replies and notes in records with application-assigned provenance;
  duplicate contract headers fail validation. This improves attribution but does not guarantee
  a model will resist instructions embedded in quoted content. Model output never grants approval.
- **Diagnostic logs:** `_diagnostics/` in the data folder holds at most two 256 KiB files.
  Entries use fixed error/action categories, reference IDs, timestamps, provider names,
  runtime versions, fixed field names, seat numbers and source locations. No raw messages,
  prompts, replies, titles, URLs, account/model identifiers, credentials or personal paths are
  copied into these logs.
  Failed calls also retain bounded timing, byte/event counts, exit outcomes and a fixed last
  stage such as waiting, reasoning or completion. These observations cannot establish an
  upstream service's cause. Complete usage received before a timeout still counts; missing
  usage remains unknown. No automatic timeout retry is added.
  Browser reports and downloads require the same launch token and origin checks as writes;
  reports accept only known categories and bounded numbers. Logging is limited to 120 entries
  per minute. A tab can retain up to 20 sanitized events in session storage until delivered;
  closing it can discard pending events. Logs stay local until you choose to share a download.
  Transcripts, terminal output and provider logs have their own data handling described above.
- **Copy result:** an explicit browser action copies the readable conclusion and questions to
  the system clipboard. Review text is still private content; the clipboard may be visible to
  other applications or managed by your OS clipboard history. No server write or model call is
  made. If access is blocked, the board offers selected text for manual copying.
- **Agent client:** `roundtable agent` connects only to a numeric loopback port. It reads the
  page's launch token into memory for authenticated writes, refuses redirects and does not
  print or persist the token. Setup checks and state reads make no model call. Start, answers,
  resume and verdict requests can make calls under the same budgets and limits as the board.
  Writes are never automatically retried. JSON output contains private review content; treat
  request files, answer files and saved command output like transcripts.
  Attended response windows continue automatically after the configured interval. A timeout
  records unanswered questions; it is not a human note, acceptance or a supplied fact. Reading
  state never extends the window. The authenticated `hold` action grants a bounded extension
  within the overall wall clock, and stale-round answers and extensions are refused. Browser
  drafts are never submitted by a timer. Agent snapshots provide a question handoff and answer
  template; the host agent is responsible for presenting the questions and collecting replies.
  Research snapshots project known fields only: fixed failure descriptions, bounded progress
  and validated source records. Raw CLI error text remains in board/transcript details, not
  the agent snapshot; saved older failures receive the same projection.
  Notes sent by the client carry `source: agent`; board notes default to `source: human`.
  This is declared attribution, not an authenticated identity or proof of human approval.
  It grants no extra permissions. Legacy notes without a source retain their original label.
- **Antigravity can put your Google account at risk.** Google's Antigravity FAQ says wrapping
  `agy` inside third-party applications is not supported under consumer plans, and that
  third-party access violates its Terms of Service and can lead to suspension or termination
  of the account. Roundtable runs `agy -p` as a third-party application and cannot tell which
  plan a login is on. So nothing is sent to `agy`, a call or a background read of its model
  list, quota or credits, until the person acknowledges this: once on the board, recorded in
  the data folder (`_terms.json`, only by the board page itself, never by the agent client),
  or per agent request with `acknowledgeTermsRisk: true`. A live server refuses an Antigravity
  seat, chairman or searcher without it, and the adapter refuses the call. `doctor` needs
  `--acknowledge-terms-risk`. This is separate from the isolation consent below.
- **Tool restrictions depend on the installed CLI.** Claude uses safe mode, an empty tool
  list, no MCP servers, MCP tools removed by name and no permission prompts. Codex ignores user configuration and rules,
  uses strict configuration, a read-only sandbox, no MCP servers, no web search and disabled
  tool features. These flags require a compatible CLI; unsupported options fail without a
  weaker fallback. Antigravity uses session-only deny rules for documented file, command,
  URL and MCP tools. Its web search has no permission rule and cannot be denied, so the guard
  below stops a seat at its first reported tool step, search included. Its shared
  customizations and MCP discovery cannot be disabled either, so live
  Antigravity calls require explicit consent: on the board, choosing Antigravity on a card that
  states the limitation; in an agent request, `allowLimitedIsolation: true`. The server refuses
  Antigravity without it. No saved provider
  settings are changed. All prompts use stdin, not the process command line.
  The mandatory guard terminates an owned CLI when a prohibited tool event is reported,
  stops that seat for the review, retains known or unknown spending and excludes its answer
  from later prompts. It applies to repairs, recovery, API tool replies and the chairman;
  `strictTools: false` is refused and cannot disable it in old records. Streams are bounded
  to 8 MiB combined stdout/stderr and a pending event to 1 MiB. Invalid, incomplete or oversized
  streams stop the seat for the review, discard its session and retain reported spending.
  Codex warning/error items are diagnostics, not tool activity; unknown item types still fail
  closed. A failed turn is rejected immediately. After a validated answer, completion event
  and token counts, a Codex process that does not exit within one second is terminated and its
  result preserved. Output and tool checks continue until termination. No retry is made for
  that completed call, and a truncated tail or subsequent prohibited tool still rejects it.
  Codex telemetry exports, analytics, shell snapshots and unlimited connection retries are
  disabled per call; shared CLI settings and login files are not changed.
  Each Codex call also names a provider entry of its own that points at the same ChatGPT
  backend and uses the same login, so the reply streams over WebSocket with an idle limit
  derived from the call limit ((limit − 15 s) ÷ 3, between 10 s and 300 s) and at most two
  reconnects, or, at low effort (or none or minimal), 15 s and at most five reconnects. Over
  WebSocket that limit runs from the moment the request is sent, so a response the backend never
  starts is caught too; a WebSocket that does not open within 10 s, or whose reconnects run out,
  falls back to HTTPS, where such a wait has no limit short of the call limit. Codex runs with its
  stream-retry warnings on (`RUST_LOG`), so its error output holds one line per retry, which
  Roundtable counts; those lines carry turn ids and the error text, not prompts or replies.
  The built-in provider exposes no idle or reconnect setting, and the CLI's documented
  stream-idle default, 300 s, equals the default call limit, so its own recovery could never run
  before Roundtable ended the call. Every key is in the CLI's configuration reference; that a
  custom provider may use the ChatGPT login is demonstrated, not documented. A CLI that refuses
  it is expected to fail the call with an authentication error, which marks the pool down for
  the review; one that ignores it is expected to fall back to the built-in provider. A reconnect
  starts the answer again, and the interrupted attempt's tokens may be charged by the provider
  without appearing in the reported usage; more reconnects can mean more such attempts.
  Roundtable's overall call limit remains the final bound.
  Codex also receives a short review-specific base prompt through a uniquely created temporary
  file, removed after the call. It contains no field notes or personal context. The tool flags,
  read-only sandbox and reported-tool guard apply independently of these instructions.
  Detection can arrive after an operation has started and cannot undo it. Undisclosed remote
  actions are not observable. These are provider restrictions and detection, not an OS
  security sandbox supplied by Roundtable. Flags are in `src/adapters/config.js`.
- **Optional web research has a separate policy.** Explicit research consent starts one fresh
  call on the chosen searcher's CLI with only its web search allowed; other tool restrictions
  remain. Codex turns on live `web_search`; Claude gets `WebSearch` as its only tool, approved
  for that call; Antigravity, whose search cannot be switched off or on, keeps its deny rules,
  and any reported tool other than `search_web` stops the call. API endpoints cannot search. Only the
  displayed search query goes into that call. The board initially fills it from the decision
  question and options; Custom query lets the person edit it. Other field notes and discussion
  answers are excluded. Search terms and visited pages are handled by the provider, so review
  the query for private details. The local wall clock,
  output limits and reported search-operation limit are enforced. One reported operation can
  contain multiple queries/page visits, and an excess operation may already have started when
  its event arrives. This is not a provider-enforced search or billing ceiling. Research
  spending joins the review's vendor budget and is shown separately from discussion seats.
  Up to eight source URLs, dates and excerpts are saved as provider-supplied, unverified data;
  all returned records are validated before repeated normalized URLs are combined into one
  citation. The first title/date are retained and distinct excerpts are appended only when
  their complete combined text fits the 1,200-character limit. The raw eight-record limit
  still applies; malformed duplicates cannot bypass validation. No repair call is made.
  Every seat and the chairman receives that same bundle. Source text cannot authorize tools
  or human decisions. Failed or interrupted research stops before discussion and is never
  automatically rerun, with one exception: a Codex searcher call that makes no progress for 40
  seconds is stopped and started once more within the same time limit, and both attempts are
  recorded. That retry is a fresh call with its own search-operation limit, so one research
  step can run up to twice the configured count. Completed evidence is reused without
  fetching it again. Ordinary
  discussion and verdict calls always retain the no-tools policy.

## The local HTTP boundary

This is a trusted personal-machine application. Other local users and processes can read the
board and its launch token; loopback is not OS-user authentication. A trusted local client can
select available server environment variables as endpoint credentials and choose destinations.
Do not run it as a shared-host service or under an account with greater authority than its user.

A page from any site can try to reach `localhost`. So every request must name this server in
`Host`, and a present `Origin` must be this server's page; every request that changes anything
is `POST`, `application/json`, at most 256 KB, and must carry the launch token printed on the
server's startup line (the served page gets it in a meta tag). Every field is typed and bounded
(`src/validate.js`). Exports write only into files Roundtable wrote (a signature in the record's
front matter, a marked region in the index) and refuse the home directory and filesystem roots.
Protected-directory checks resolve symlinks and junctions. Record and index destinations must
be regular files or absent; temporary files are created exclusively before atomic replacement.
POSIX replacements preserve existing permission bits; new exports use `0666` filtered by the
process umask. Choose a private export directory or restrictive umask for private decisions.
Every response carries a Content-Security-Policy that lets only this server's own scripts run in
the page, keeps fetches and the event stream same-origin, forbids framing, and disables content
sniffing, so a reply that slipped past the board's escaping could not read the launch token.

Preflight `GET` reads cached status only, including when `fresh` is present in the query. Missing
snapshots say not checked; expired snapshots are labelled stale. CLI status and quota refreshes
require authenticated `POST`. Concurrent refreshes share work per pool, with at most two pool
checks running and twelve running or queued in total. Requests beyond that limit receive a busy
status. Results are cached for one minute; forced refreshes have a five-second cooldown per pool.
The cache retains at most 64 completed snapshots. These bounds cover preflight refresh work;
startup catalogue/quota reads and debate calls have their own existing timeouts and controls.

Claude and Antigravity usage reads must be proven free of model work. A proven-free answer
without limits leaves quota unknown or retains the last figure; the next normal refresh can
try again. An answer that is not proven free, or a timeout, still disables that reader until
restart. No additional retry or polling loop is started.

The browser waits up to 15 seconds for ordinary setup/history and action requests. It never
automatically retries a failed write, since a lost response can hide an action already accepted
by the server. This timeout is not a cancellation of a debate or provider call. Pending action
buttons prevent duplicate submissions in that page; they are not a server-side idempotency
guarantee. The launch token remains required for every write, including retries initiated by
the user. Resume notes supplied before the first complete round are also private transcript
data and are included in subsequent prompts, replay and exports.

The read-only event stream acknowledges reconnects immediately, including when no events
were missed. Reconnecting or replaying a board does not dispatch provider calls.

## Reporting

Use [private vulnerability reporting](https://github.com/prplkane/roundtable/security/advisories/new).
Include the affected version and steps to reproduce the problem. Do not attach credentials,
login files or real debate contents. If private reporting is unavailable, use the contact
method listed on the [maintainer's profile](https://github.com/prplkane).
