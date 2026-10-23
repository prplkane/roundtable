# Security

Roundtable runs on your machine and talks to nothing but the vendor CLIs you installed.

## What it touches, and what it does not

- **Credentials: none.** Roundtable never reads, copies or stores a login. It runs each vendor's
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
- **An API endpoint seat is the one case where Roundtable itself sends a request.** You name a
  base URL, a model and the *name* of the environment variable holding the key (never the key;
  a pasted key is refused on shape). At call time the key is read from the environment you
  started Roundtable from and sent as a bearer to that URL only, with redirects refused. It is
  not stored, not logged, not written to the transcript, not shown on the board, not put in an
  error message. Plain `http` is accepted only for this machine or a private network; a hosted
  API must be `https`. The pre-flight sends no probe to the endpoint (a probe from a route any
  local page can reach would let a page choose where the key goes); the first real call is the
  check. Such a seat bills the endpoint's account, and its card says `API · pay-per-token`.
- **Network: only the CLIs' own traffic** to their vendors, plus the endpoint traffic above for
  seats you configured that way. The server listens on `127.0.0.1`.
- **On disk, under `debates/`:** one folder per debate with the transcript (field notes, replies,
  your notes, usage figures), `field-notes.md` and `verdict.md`; plus the calibration and pool
  figures. The folder is gitignored. A CLI's raw output is kept in memory for the duration of a
  call and never written.
- **Tools: none for the seats.** Claude seats run with no tool and no MCP server; Codex seats with
  the sandbox read-only, no MCP server, no web search and no tool feature; Antigravity seats in
  plan mode, which denies what they request. Any tool use a CLI still reports fails the seat.
  The flags per CLI are in `src/adapters/config.js`.

## The local HTTP boundary

A page from any site can try to reach `localhost`. So every request must name this server in
`Host`, and a present `Origin` must be this server's page; every request that changes anything
is `POST`, `application/json`, at most 256 KB, and must carry the launch token printed on the
server's startup line (the served page gets it in a meta tag). Every field is typed and bounded
(`src/validate.js`). Exports write only into files Roundtable wrote (a signature in the record's
front matter, a marked region in the index) and refuse the home directory and filesystem roots.

## Reporting

Open an issue, or, for something you would rather not post, email the address on the GitHub
profile of the maintainer. Say what you found and how to reproduce it.
