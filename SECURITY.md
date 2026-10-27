# Security

Roundtable runs a loopback server on your machine. Live debates use the vendor CLIs you
installed or API endpoints you explicitly configure; demo mode uses scripted replies.

## Data and execution

- **CLI login files stay with the CLI.** Roundtable does not read or copy those files. It runs each vendor's
  own CLI (`claude`, `codex`, `agy`) as a child process, and that CLI does its own login the way
  it does in your terminal. A test asserts that no source file names a credential file or copies
  one. A second account ("login profile") is an empty directory under the OS user-data folder
  (`%LOCALAPPDATA%\roundtable\homes\<profile>\<vendor>`, `~/Library/Application Support/roundtable/...`,
  `~/.local/share/roundtable/...`) that you log into yourself once; Roundtable only points the
  CLI at it through the variable the CLI documents.
- **Billing: the subscription, unless you say otherwise.** The child's environment is yours minus
  the Claude Code session variables and minus API-key variables (`ANTHROPIC_API_KEY`,
  `OPENAI_API_KEY`, `GEMINI_API_KEY` and the like), so a key left in your shell cannot move a
  debate onto pay-per-token. Set `ROUNDTABLE_API_BILLING=1` to pass them through on purpose.
- **Budget caps check admission, including retries.** Each provider attempt is checked against
  reported usage, calls already in flight, and the projected next call. Seat calls leave room
  for a projected verdict; a fallback chairman is checked against its own vendor's cap.
  Missing or unusable token counts block further calls to that vendor under a token cap,
  including after a restart; already dispatched calls may finish. No cap means no such block.
  Unknown usage and partial totals are labelled, and reported dollar costs are kept separately.
  These checks use estimates and available usage reports, not a provider-enforced billing
  ceiling: a call already running can consume more than projected.
- **An API endpoint seat is the one case where Roundtable itself sends a request.** You name a
  base URL, a model and the *name* of the environment variable holding the key (never the key;
  a pasted key is refused on shape). At call time the key is read from the environment you
  started Roundtable from and sent as a bearer to that URL only, with redirects refused. It is
  not deliberately added to transcripts, logs or the board. Endpoint response and error text
  can be displayed and recorded, so use an endpoint you trust not to echo credentials.
  Plain `http` is accepted for local names and private IP literals; a hosted
  API must be `https`. A DNS name starting with a private-address prefix, such as
  `10.api.example.com`, is still a hosted name and requires HTTPS. Local names rely on your
  network's name resolution. Endpoint responses are limited to **1 MiB of decoded body bytes**,
  including compressed and error responses; an oversized response is cancelled and fails the
  call without a network retry. Preflight sends no probe to the endpoint, even on an authenticated
  refresh; the first real call checks the connection. Such a seat bills the endpoint's account,
  and its card says `API · pay-per-token`.
- **Network:** the browser loads the board, styles and fonts locally; it does not fetch a remote
  font stylesheet. Live provider traffic is the CLIs' own traffic and the endpoint traffic
  above. The server listens on `127.0.0.1`. A debate sends its notes and relevant replies to the
  selected providers. Stateless mode limits the context Roundtable resends; it does not control
  provider logging or retention.
- **On disk:** live data defaults to `debates/` under the installation folder; demo data uses
  `debates-fake/`. `ROUNDTABLE_DEBATES_DIR` overrides that location. Each holds one folder per debate with the transcript (field notes, replies,
  your notes, usage figures), `field-notes.md` and `verdict.md`; plus the calibration and pool
  figures. The default folders are gitignored. A CLI's full raw output is kept in memory during
  a call; selected replies, errors and usage are recorded. Copy the entire data folder while
  the server is stopped to back it up. Exported records and CLI login profiles live separately.
  The browser also retains field notes, seat choices, limits, chairman settings and budgets in
  local storage for that address. Clearing browser data removes those preferences, not server
  records. They can contain private context; use a browser profile you trust.
- **Transcript recovery:** reads never change the transcript. Before appending after an
  incomplete final line, Roundtable saves the exact original as `transcript.recovery-<id>.jsonl`
  beside it and atomically replaces the transcript with its complete prefix and a recovery
  notice. Backups contain the same private debate data and belong in your backup/deletion
  policy. Corrupt completed lines block resume and export until restored from a backup.
- **Tool restrictions depend on the installed CLI.** Claude seats are configured with no tool
  and no MCP server; Codex seats with
  the sandbox read-only, no MCP server, no web search and no tool feature; Antigravity seats in
  plan mode; its MCP servers cannot be disabled by flag. Any tool use a CLI still reports fails
  the seat. The same check applies to the chairman. This is defense in depth, not an OS security
  sandbox provided by Roundtable. The flags per CLI are in `src/adapters/config.js`.

## The local HTTP boundary

A page from any site can try to reach `localhost`. So every request must name this server in
`Host`, and a present `Origin` must be this server's page; every request that changes anything
is `POST`, `application/json`, at most 256 KB, and must carry the launch token printed on the
server's startup line (the served page gets it in a meta tag). Every field is typed and bounded
(`src/validate.js`). Exports write only into files Roundtable wrote (a signature in the record's
front matter, a marked region in the index) and refuse the home directory and filesystem roots.

Preflight `GET` reads cached status only, including when `fresh` is present in the query. Missing
snapshots say not checked; expired snapshots are labelled stale. CLI status and quota refreshes
require authenticated `POST`. Concurrent refreshes share work per pool, with at most two pool
checks running and twelve running or queued in total. Requests beyond that limit receive a busy
status. Results are cached for one minute; forced refreshes have a five-second cooldown per pool.
The cache retains at most 64 completed snapshots. These bounds cover preflight refresh work;
startup catalogue/quota reads and debate calls have their own existing timeouts and controls.

The browser waits up to 15 seconds for ordinary setup/history and action requests. It never
automatically retries a failed write, since a lost response can hide an action already accepted
by the server. This timeout is not a cancellation of a debate or provider call. Pending action
buttons prevent duplicate submissions in that page; they are not a server-side idempotency
guarantee. The launch token remains required for every write, including retries initiated by
the user. Resume notes supplied before the first complete round are also private transcript
data and are included in subsequent prompts, replay and exports.

## Reporting

Use [private vulnerability reporting](https://github.com/prplkane/roundtable/security/advisories/new).
Include the affected version and steps to reproduce the problem. Do not attach credentials,
login files or real debate contents. If private reporting is unavailable, use the contact
method listed on the [maintainer's profile](https://github.com/prplkane).
