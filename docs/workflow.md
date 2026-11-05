# Using Roundtable

Set up providers, run a review, and export a decision record. For data handling and the
limits of the security controls, see [SECURITY.md](../SECURITY.md).

Export into a dedicated project folder. Aliases to protected directories and linked record
or index files are refused; a refusal leaves the destination's existing contents intact.

API endpoints receive the credential you configure. Known echoes of that credential are
removed from new replies and errors before saving; this cannot prevent a chosen endpoint
from retaining or deliberately encoding it. Older records are not automatically edited.

Replies and discussion notes reach later seats as quoted input records identified by source
and round. Their original wording is retained. Duplicate contract headers trigger the normal
format correction; ordinary Markdown inside a reply is allowed. Quoting does not guarantee
that a model will ignore misleading instructions in another seat's content.

## 1. What you need

- **Node 22 or newer.** Check with `node --version`.
- **At least one supported CLI**, logged in with your subscription. CLI seats use that login;
  they do not need an API key. OpenAI-compatible endpoints are optional and use their own
  credentials and billing (section 7b).
- **A browser**, for the board. Any modern one.

Get the code and check it runs:

```bash
git clone https://github.com/prplkane/roundtable.git
cd roundtable
npm test
```

There are no dependencies to install.

### Connect an assistant for every project

Install once with `npm install -g @prplkane/roundtable`, then run
`roundtable setup --client codex`. To install a local checkout, run `npm pack`, then
`npm install -g` with the generated `.tgz` filename. Install the archive, since
`npm install -g .` can create a link to the checkout that breaks when it moves.
Setup points at the installed package, not the project where you next ask for a review.

Choose `--client claude`, `--client agy`, repeat `--client`, or use `--client all` to connect
all three. This explicitly installs a user-level MCP connection and the bundled Roundtable
skill. No npm install hook changes assistant settings. Restart the assistant or reload its
MCP connections after setup, then ask it to use Roundtable from any project.

| Assistant | MCP configuration | Workflow skill |
| --- | --- | --- |
| Codex | `~/.codex/config.toml` | `~/.codex/skills/roundtable/SKILL.md` |
| Claude Code | `~/.claude.json` | `~/.claude/skills/roundtable/SKILL.md` |
| Antigravity app / CLI | `~/.gemini/config/mcp_config.json` | `~/.gemini/config/skills/roundtable/SKILL.md` |

Codex uses `CODEX_HOME` when set. Claude uses `CLAUDE_CONFIG_DIR` when set, with
`.claude.json` and `skills/roundtable/SKILL.md` inside that directory. `--home <directory>`
selects an isolated test home and ignores both overrides. Antigravity's current app, CLI and
IDE use the [shared configuration directory](https://antigravity.google/docs/mcp);
the presence of an older `~/.gemini/antigravity/mcp_config.json` does not select it.
For an older IDE, check the path shown by its MCP manager before configuring it manually.
Setup preserves unrelated settings and comments in Codex's TOML, including dotted and
quoted keys and multiline strings. It refuses an existing unmanaged Roundtable entry,
an edited managed entry or skill,
invalid configuration JSON, and linked configuration files. Resolve a conflict explicitly;
setup does not overwrite custom edits. A private receipt under `~/.roundtable/integrations.json`
records paths and hashes for checking, updating and removal. No configuration contents or
credentials are copied into it. Missing managed files can be repaired by rerunning setup,
or removed with `--remove`; present files with custom edits remain protected.
Rerun setup after a package update to refresh the skill. Changing a profile override requires
removing the old managed connection with its original profile first.

```bash
roundtable setup --client all --check
roundtable setup --client codex --remove
```

`--check` reads the installed files and verifies their recorded hashes, MCP script and Node executable;
it makes no model call. To test without a provider, use `--fake` with setup, or run
`roundtable mcp --fake`. This uses the separate demo board on port 4748. Updates preserve
the saved mode and port. Use setup's `--live` to switch explicitly to live port 4747, or
`--fake` to switch to demo port 4748. `--port N` selects another
loopback port; `roundtable mcp --no-start` requires an already running board. Every server
needs its own data directory when more than one runs in the same mode (see Local data).

The MCP adapter starts the board in the background when a tool needs it and leaves it
running when a chat disconnects, so question timers and reviews continue. Starting the board
checks provider status but starts no review. It never opens the browser. Use the returned
board link to view or stop a review. The existing loopback token protects writes, and the
adapter never prints it. Normal review content is returned to the assistant that invoked it.
An unrelated service, incompatible API, different package version or wrong demo/live mode
on the selected port is refused. An explicit `ROUNDTABLE_DEBATES_DIR` must match the running
board. A lightweight health endpoint checks this without waiting for provider catalogues;
temporary readiness failures are retried within 35 seconds, without retrying review writes.
Configure the host's tool timeout to at least 90 seconds if it supports that setting:
a wait can include two bounded state reads as well as the requested event wait.

If an assistant says Roundtable is unavailable, run setup's `--check`, reload its connections,
and confirm `roundtable_guide` appears among its tools. The installed skill also explains the
`roundtable agent` CLI fallback. The repository's `AGENTS.md` does not install anything in
other projects. Do not substitute ordinary subagents and call their result a Roundtable review.

After an update, finish active reviews, run `roundtable server restart` (add `--fake` or
`--port N` for that board), reload the assistant's MCP connection and refresh the browser.
`roundtable server status` inspects the board; `stop` stops it. Stop/restart requires the
launch token and matching server instance, and refuses active reviews or other writes.
It never cancels a review to perform an update. Older boards without the health API must be
stopped from their original terminal with Ctrl+C, or by stopping their known server process.
Refreshing the browser alone does not reload server code.

### First connection on Linux

Run these steps as the user who runs your assistant. Setup is once per machine and assistant
profile, not once per project. Roundtable has no separate account or login.

1. Check `node --version` and `npm --version`. Node must be 22 or newer.
2. Install Roundtable globally:

   ```bash
   npm install -g @prplkane/roundtable
   roundtable --help
   ```

   This installs a copy; no checkout is required. For a source snapshot before its npm release,
   use `npm install -g https://github.com/prplkane/roundtable/archive/refs/heads/main.tar.gz`.
   If `roundtable` is not found, add the
   `bin` directory under `npm prefix -g` to your shell's `PATH`. Use a user-owned Node/npm
   installation; run assistant setup as your ordinary user.
3. Install and sign in to the providers you want to seat, using section 2. For Codex:

   ```bash
   npm install -g @openai/codex
   codex login
   roundtable doctor
   ```

   Finish the browser login. One provider is enough for multiple seats. Doctor checks
   setup without a model call; `--live` additionally makes probe calls.
4. Register the connection and skill for your assistant:

   ```bash
   roundtable setup --client codex
   roundtable setup --client codex --check
   ```

   Replace `codex` with `claude` or `agy`, or use `all`. The check should report
   `"ok": true` and `"connected": true` for the selected client. It verifies files and
   executable paths; the assistant must still load the connection.
5. Restart the assistant or reload its MCP connections. For Codex, run `codex mcp list`,
   then open Codex in any project and use `/mcp` to check that Roundtable is available.
   Ask it to call `roundtable_guide` and `roundtable_status` without starting a review.
6. Ask for a first review: "Use Roundtable with two seats and one critique round to review
   this decision. Ask me questions when needed, auto-continue if I do not answer, and wait
   for the chairman." Include your decision, alternatives and constraints.

Setup writes the installed Node and MCP script paths into the assistant's user configuration
and copies the workflow skill. On reload, the assistant launches that script and discovers
the 11 tools over stdio. The first tool that needs the board starts it locally in the background
on port 4747. Roundtable invokes the provider CLIs with their existing logins only when the
requested action needs them. There is no Roundtable cloud connection or API key to enter.
Keep the provider CLI executables on the assistant's `PATH`; after changing a Node version or
moving its installation, rerun setup and reload the assistant.

To check the workflow without a provider account, use `roundtable setup --client codex --fake`
before restarting the assistant and request a scripted demo review. This uses port 4748 and
makes no model calls. Switch back with `roundtable setup --client codex --live` and reload again.
The browser is optional for MCP: open `http://localhost:4747` after a live tool has started
the board, or run `roundtable fake` for a foreground demo. If the board is already running in
the background, open its URL instead of starting a second server.

Foreground board startup and top-level help show the app's pixel logo tile in orchid, with
the wordmark and installed version beside it. The tile is drawn with half-block characters,
so it needs a UTF-8 terminal; other locales, and `ROUNDTABLE_ASCII=1`, get the wordmark
alone. Narrow terminals use a short title, `NO_COLOR=1` removes color, and redirected
output, CI, `TERM=dumb`, MCP and JSON commands omit it.

## 2. Install and log in to each vendor

Seat only the vendors you have a subscription for. One vendor is enough: you can seat it
several times.

### Provider availability and network access

Some vendors, products or models are unavailable in certain regions or account plans.
Check the vendor's current requirements for the service you use:

- **OpenAI:** [ChatGPT supported countries](https://help.openai.com/en/articles/7947663-chatgpt-supported-countries)
  for a ChatGPT login, or [API supported countries](https://help.openai.com/en/articles/5347006-openai-api-supported-countries-and-territories)
  for an OpenAI API endpoint.
- **Anthropic:** [supported regions](https://www.anthropic.com/supported-countries).
- **Google Antigravity:** [geographical availability in the FAQ](https://antigravity.google/docs/faq).

Choose a provider available to your account and region. A supported location and successful
login do not guarantee reliable replies: local networks, proxies, VPN settings or regional
provider infrastructure can still interrupt a connection. A route-specific failure alone
does not establish an intentional regional or IP restriction.

Roundtable leaves your VPN, proxy and DNS configuration unchanged. For repeated stalls, use
the [connection checks](#regional-availability-and-stalled-connections) below.

### Claude (Anthropic)

```bash
npm install -g @anthropic-ai/claude-code
```

On Windows you can use `winget install Anthropic.ClaudeCode` instead. Then log in once:

```bash
claude
```

Inside the program, type `/login`, finish the sign-in in the browser, then exit with `/exit`.

Roundtable reads Claude's remaining quota with `claude -p /usage`, which the CLI answers itself,
with no model call and no conversation. It reads when the server starts, on **Refresh status**,
after each Claude reply and when a debate ends, from an empty folder with a seat's lockdown
(no tools, no MCP servers, safe mode) but with slash commands on, which `/usage` needs. Only the session, weekly and per-model weekly limit lines are kept; the activity summary
the same answer prints (requests, sessions, skills, MCP servers) is discarded and never saved.
If a proven-free read has no limit lines, the last known figure or a reply's quota is kept;
the next normal read can recover without restarting. Missing limits do not establish the
account's billing method or login state. If no figure is available, the card says **quota unavailable**.
If an answer is not proven to be a local command with no turn, tokens or cost, or the read
gets no answer within 30 seconds, Roundtable stops reading Claude quota until the server
restarts and says so on the console.

### Codex (OpenAI)

```bash
npm install -g @openai/codex
```

```bash
codex login
```

A browser opens. Sign in with the ChatGPT account that holds your subscription.

### Antigravity (Google)

**Read this first: your Google account.** Google's
[Antigravity FAQ](https://antigravity.google/docs/faq) describes headless `agy -p` as meant
"for direct scripting and CI workflows". It says wrapping `agy` inside third-party coding
agents or applications is not supported under consumer plans, and that using third-party
software to access Antigravity violates its Terms of Service and can lead to suspension or
termination of the account. Roundtable is a third-party application that runs `agy -p` for
each Antigravity seat, chairman and searcher, and reads `agy models`, `/usage` and `/credits`
for the board. It cannot tell which plan a login is on. Decide whether that suits your
account before you continue; Claude, Codex or an API endpoint can take every role instead.

So nothing is sent to `agy` until you acknowledge this:

- **On the board**, a card set to Antigravity says **Account risk: read before using
  Antigravity**. It opens the notice; **I understand, use it** records your acknowledgment
  in the data folder (`_terms.json`), once for every board and later starts. Until then the
  card's lamp reads **held**, **Open the table** opens the notice instead of the table, and
  the server reads neither Antigravity's model list nor its quota. The same notice, opened
  again from **Account risk acknowledged · review**, has **Withdraw**: no new background read
  starts, and a review already running keeps its calls. When Google's wording is checked
  again and the notice changes, the board asks again.
- **An agent request** must send `options.acknowledgeTermsRisk: true` whenever a seat, the
  chairman or the searcher is on Antigravity, and only once the person has agreed. An
  acknowledgment on the board does not answer for an agent; the agent cannot record one
  either. `roundtable agent status` shows the notice and its link under `providers[].terms`.
  Without the option, a live server refuses the request, and the Antigravity adapter refuses
  any call made without it.
- **The diagnostic command** sends nothing to `agy` without `--acknowledge-terms-risk`: no
  model list, no quota read, no live call. Only `agy --version` still runs.

A review saved before this notice existed can be resumed once the board has acknowledged it.
The demo shows and asks the same and records the answer in the demo folder; it calls nothing.

Antigravity cannot be fully sealed off: it still loads your shared Antigravity customizations
and discovers your MCP servers, and its web search cannot be switched off. Roundtable denies
its file, command, URL and MCP tools and stops the call, without a retry, at the first tool it
reports. A seat, chairman or searcher card set to Antigravity has a compact **Warnings** control
(**Review required** before the terms acknowledgment). Expand it to read **Limited isolation**
and the account notice; choosing Antigravity accepts limited isolation. An agent request must send
`options.allowLimitedIsolation: true` (also in `roundtable agent --help`), or the server
refuses Antigravity. Use another provider if that is unsuitable. Claude and Codex require their isolation flags to be supported;
an older CLI fails with an update instruction instead of a weaker fallback.
Invalid, incomplete or oversized provider streams also stop that seat for the review;
reported spending is retained, and the failed session is not reused.
The optional live diagnostic command uses the separate `--allow-limited-isolation` flag
for the same consent; without it, `doctor --live` skips Antigravity's model call.

The `agy` command comes with the Antigravity IDE. Install the IDE and sign in there. If `agy`
is not found in a terminal afterwards, let it set up your PATH:

```bash
agy install
```

Run `agy --version` to check that the command is available. Roundtable uses `agy` for the
Google seat.

Roundtable reads Antigravity's remaining quota with `agy -p /usage`, which the CLI answers
itself, with no model call and no conversation (agy 1.1.11 or later), and only once its terms
notice is acknowledged (above). It reads when the server
starts, on **Refresh status**, after each Antigravity reply and when a debate ends. A read that
gives no answer within 30 seconds counts as a timeout. The limits come per model group (Gemini;
Claude and GPT; Gemini 4 Argon on some plans), each with a weekly window and usually a 5-hour
one, and a seat counts only the group its model draws on. A seat on the default model counts
every group. If an answer ever shows a turn, tokens or a conversation, or the read times out,
Roundtable stops reading Antigravity quota until the server restarts and says so on the console.
With a successful read it also asks `agy -p /credits`, at most every ten minutes, for the AI
credits that take over once a group's limits are used up; the usage table shows them as
"AI credits left". The same check and stop apply to that answer.
The same groups decide who sits out when a call reports a used-up quota during a debate: only
the seats whose model draws on that group are skipped, and the others keep answering. A seat
on the default model, or a CLI that is logged out, takes the whole Antigravity login out.

### Check what this machine can seat

```bash
npm run doctor
```

For each vendor it prints where the CLI was found, its version, the models and thinking levels
you can pick, and the remaining quota where the vendor reports one. Nothing is spent, but this
does not test whether a model reply can complete over your current connection. To also check
each available CLI with one tiny model call, add `--live` (this uses provider quota):

```bash
npm run doctor -- --live
```

Antigravity's model list, quota and live call stay **held** in this output until you add
`--acknowledge-terms-risk`, which is the same acknowledgment as on the board (see the
Antigravity notice above); its live call also needs `--allow-limited-isolation`.

A vendor that says "logged in NO" needs the login step above again.

## 3. Open the board

The board is a web page served by a small local server. Its assets load locally. Live debates
send field notes and relevant replies through the CLIs or API endpoints you selected.

```bash
npm start -- --no-open
```

Open http://localhost:4747. This is the normal launch command for a local checkout. Omit
`-- --no-open` to open the browser automatically from an interactive terminal. Stop the
server with Ctrl+C in that terminal; any CLI it started is stopped with it. Once the package
is published to npm, `npx @prplkane/roundtable` will start it without a clone.

**Try it first without spending anything.** The fake board runs the same screens with scripted
seats:

```bash
npm run fake -- --no-open
```

Open http://localhost:4748. The header and notice say **Demo**: replies and usage are scripted,
with no model calls. The normal server says **Live** and uses the selected providers' quota
or billing. Use the demo to learn the flow and show the tool to someone.

To use another port, set `PORT` before starting, for example
`PORT=5000 npm start -- --no-open` (PowerShell: set `$env:PORT='5000'`, then run the normal
launch command). An existing `PORT` value also overrides the demo port. The startup terminal
prints the actual address, mode and data folder. **Local data and backups** on the setup screen
shows the same folder and links to this guide.

The first screen lists the debates on this machine, newest first: whether each is live,
interrupted or finished, what was recommended or accepted, and its size and cost. Click one to
open its board; **Debates** in the header brings you back, and the browser's Back button works
too. Each board has its own address, so you can bookmark it. Below the list is a new debate; the
bar at the bottom shows how many calls and tokens the table you are setting up is projected to
take, next to **Open the table**.

### A first live test drive

1. Run `npm run doctor`, then start the live board and check that its header says **Live**.
   Use **Refresh status** and resolve any login or installation errors first.
2. Use a small, non-sensitive decision with two clear options. Choose two seats with different
   lenses. For the first run, use a provider you have already verified; both seats may use it.
3. Choose a modest model and low effort, **zero critique rounds**, **stateless** memory and a
   **10-minute** wall clock. Set a token cap with room for two initial replies and the verdict.
   The cap is an admission check, not a billing guarantee. Zero critique rounds still makes
   those three calls, plus any retry.
4. Open the table, read both positions, add a short note at the human gate and continue to the
   verdict. Accept or override the recommendation, then reload and check the saved decision.
5. Create an empty folder and export into it. In a separate demo review, try Stop and restart/recovery.
   Use **Save error log** if anything fails, and note the last action you took.

The stabilization pass included a live Claude Sonnet review at low effort. Other providers
have offline test coverage and should get their own small live trial before a larger review.

## 4. Run a debate

### Write the field notes

Fill in:

- **Decision**: one question, answerable.
- **Options**: at least two, one chip each. Press Enter in a chip to add the next, Backspace in
  an empty one to remove it. Each is numbered (opt-1, opt-2) as the seats will see it; a seat may
  still propose its own, written as "other: …".
- **Constraints**: what any answer must live within.
- **More context** (folded; its title counts the fields you filled): evidence known, evidence assumed,
  reversibility, deadline, and **Export to**, a folder in your codebase where the decision record
  is written the moment the verdict is ready (see step 6). Seats see only these notes in round 0,
  so include the facts they need to assess the options.

### Seat the agents

Each card is one seat, an independent agent with its own session. Click any value on a card to
change it. The card's colour is its vendor's; the small picture shows its mood; the round lamp
says what is known about its quota (green ready, yellow nearly used, red used up, grey not
checked yet).

| field | what it does |
|---|---|
| Vendor | Claude, Codex or Antigravity, or **API endpoint** (section 7b). Pick the same vendor more than once if you like. Next to it, a tag says what kind of seat it is: `CLI · subscription`, `API · local` or `API · pay-per-token`. |
| Lens | The angle this seat argues from, for example "risk", "cost", "the clinician". Must be unique: it is the only name the other seats ever see. |
| Mood | How it argues. `grill` (the default) attacks assumptions and demands evidence. `steelman` states each option at its best first. `builder` judges by what it takes to ship. `contrarian` takes the least popular side. `custom` takes your own sentence. |
| Model | Under the vendor name on the card, with stronger model families first. Names carry only **default** and **lightest** notes; the CLI decides model access. This is a broad capability order, not a benchmark comparison across vendors. Antigravity lists each model once and its effort pips choose the variant. **Custom model ID…** opens a text field and keeps your selection while you edit; enter an ID or choose a listed model before starting. Terra requires Codex CLI 0.159 or later. A retired model is refused with what to use instead. |
| Effort | The thinking level, as pips: click one to set it, click the last filled one again for the CLI's default. Higher thinks longer and draws more. |
| Login profile | Behind "Login profile" on the card. Leave empty to use your normal login; fill in only to seat a second account of the same CLI (step 7). |

First use starts with **two seats and one critique round**: normally two blind replies, two
critique replies and one verdict, before any retries. The first status check prefers ready
default logins; if only one vendor is ready, it fills both seats with different lenses. If no
vendor is known ready, two editable choices remain and their lamps explain the state. Editing
a seat stops this automatic first-use selection. Saved seats are preserved.

Use **+ Add seat** for more. Two or three seats are enough for most questions. Opening a table
saves its field notes, seats, limits, memory, chairman choices and budgets in this browser for
this address. These preferences return on reload; unsent edits are not automatically saved.

Added seats start with a distinct, editable lens. Restored seats with an empty lens get a
starter perspective and a notice to review it. If you clear a lens, reuse another seat's lens,
or leave a custom mood blank, **Open the table** highlights and focuses that field before
any model call. Your draft stays in place.

Hover over the Lens, Mood, Effort or round-setting label for about a second for an explanation.
You can also focus the label with the keyboard or tap it. Hints appear after a deliberate delay,
remain open while you read them, and close with Escape or a tap outside. The Mood hint
explains the selected approach. New agent replies use a brief text reveal; saved replies
appear in full. The interface respects your device's reduced-motion setting.

Below the seats is the **chairman**: a fresh session that did not argue. It reads every round
and writes the verdict, sceptically (agreement between seats is not evidence; it recommends
none when every option rests on assumptions). It does not decide: you accept an option after the
verdict. It can have its own vendor, model and effort.

For a playful board session, choose a custom mood and enter `cat` (or `meow`) or `alien`
(or `ufo`). These optional personas use the lightest configured model and low effort, with a
60,000-token seat cap. They keep the reply format but prioritize the character over useful
analysis. Use the ordinary moods for decision reviews. API clients treat these words as plain
custom text.

### How seats stay independent

- Every CLI seat has its own session and working folder, `debates/<slug>/seats/<id>/`.
  Roundtable does not run the seat in the project you are reviewing. CLI-specific discovery
  of instructions and settings still applies; these controls are not a sandbox.
- Claude seats load no user-level settings (`--setting-sources local`); Codex seats skip
  `AGENTS.md` discovery, the global one included.
- Other seats and the chairman identify a seat by its lens. Roundtable omits vendor and model
  labels from the prompts; each seat receives its own mood instructions.
- Still shared: the CLI's own state folder (login, local history) unless the seat has a login
  profile, and whatever the vendor applies to every request from your account.
- Codex ignores your user configuration, so a default model or effort in that file does not
  control the seat. Choose both explicitly to reproduce a review. CLI resolution follows PATH
  order across native binaries and npm installations, including on Windows.
- Codex seats use a short decision-review base prompt instead of general coding instructions.
  Parent Codex app routing/session variables are removed before starting CLIs or reading quota.
  Login profiles and inherited network restrictions are preserved. This also applies when a
  coding agent launches Roundtable as a background server.
- Use different lenses to test different assumptions. Agreement between seats is not evidence
  that their shared assumptions are correct.

### Set the limits

- **Critique rounds**: rounds after the blind first one. Start with one and increase it only
  when another round is useful.
- **Review window (s)**: a short correction window between rounds with no questions, including
  the blind first round. The default is 15 seconds; it continues without a click.
- **Answer window (s)**: when a seat asks a question, wait up to 120 seconds by default, then
  continue with the missing facts still unknown. A countdown is shown beside the questions
  and in the bottom bar. Writing an answer or note, or choosing **More time**, renews this
  window within the overall wall clock. Clicking elsewhere does not hold the review.
  Drafts are never submitted automatically. If an extension fails, the board reports it.
- **Wall clock (min)**: a hard stop.
- **Memory**: leave on `stateless`. Each round is a fresh call with the field notes, the seat's
  own last reply and the others' replies. This avoids resending the full conversation, but
  token use and cost still vary. `resume` retains a conversation and can grow the context each
  round. Neither setting controls the provider's logging or retention policy.
- **Unattended**, off by default: the table never waits for you. The window after the blind
  round is skipped, and the seats are told that nobody answers questions, so they state what
  they would have asked as an assumption instead; the question line leaves their contract, which
  also keeps its tokens out of every call. Turn it on only for a review nobody will watch;
  otherwise leave it off, so the board can collect answers and play its question sound.
  These modes work both in the browser and through an agent. Use unattended for a background
  job with no reply channel; an agent in a live chat can present the questions to its user.
- **Budget caps**, in the quota panel: an optional token or dollar ceiling per vendor. The
  engine checks projected usage before each round and every provider attempt, including network
  retries, re-prompts and a fallback chairman. It counts reported usage and calls still in
  flight, and keeps room for the verdict. A refused retry fails that seat for the round; a
  refused round stops the debate. Calls can consume more than their estimates, so a cap is an
  admission check rather than a guaranteed final bill.
  A dollar cap needs a dollar estimate; without one it blocks calls. A saved dollar cap stays
  visible so you can clear it and use a token cap while dollar estimates are unavailable.
  If a call omits usable token counts, further calls to that vendor are blocked when it has a
  token cap, including retries, re-prompts and the chairman. This also applies after a restart.
  Calls already in flight can finish. A chairman on another vendor can still write the verdict
  if its own checks pass.
  Every discussion seat also has an automatic limit of 400,000 tokens per review. If its reported
  spend plus the next projected call exceeds the limit, or any earlier call has missing or partial
  usage, that seat sits out. The board says **seat cap** for a projected crossing, or **usage unknown**
  for missing counts, and other seats can continue. When recorded, the earlier timeout or
  interruption is shown. Unknown spending does not mean the cap was measured as exhausted;
  check the earlier failure and provider usage before starting more work. This check
  applies to retries and resumed reviews too. An in-flight call can exceed its projection; the cap
  blocks subsequent calls. The chairman is governed by the vendor budget, not a discussion seat's
  cap. Without a vendor token cap, unknown usage does not block the chairman.
  The board, history and exports label missing counts **unknown** and mixed totals **partial**;
  reported dollar costs remain available even when token counts are missing. Explicit zero
  counts remain zero. Older transcripts that already saved fabricated zeros cannot be repaired
  automatically from those records.

### Read the quota picture

The **Quota picture** under the seats starts folded; its title lists each account's projected
tokens. Open it for one card per vendor account: what each seat is likely to draw in this
debate as one bar segment per seat (seats of one vendor in steps of its colour, the chairman
hatched), the vendor's live windows where it reports them, and an optional cap. Antigravity's
windows are named by group ("Gemini 5h", "Claude and GPT 7d"), and its card shows the groups its
seats' models draw on. When it reports no window, you can track the figure from its credits
page in its card.

On the running board, usage starts collapsed. Each account shows its lowest reported percentage
remaining and a small bar, with the window and reading age. Missing figures say **not reported**.
Open **Usage details** for per-seat tokens, costs and timing, grouped by account with each
account's live windows. A **+** after a total means some calls reported nothing; a dash means
the CLI reports no cost. Rounds fold once a review finishes, so the conclusion leads.

These statistics describe your own agents' calls in Roundtable and are calculated and stored
on your machine. Roundtable has no telemetry or analytics service and sends no usage data to
its developers. Provider quota readings describe your account and may also include activity
outside Roundtable. Your selected providers receive the prompts needed for live reviews;
their data handling is separate.

Codex reports cumulative tokens when resuming a thread. Roundtable charges only the increase
since that seat's last reading and keeps the original totals under `usage.raw`. A missing or
decreasing baseline is unknown spending, not zero. Recovering an interrupted review starts new
provider threads and resets this baseline while retaining earlier spending. Older saved totals
are not rewritten automatically.

### Open the table and take part

Press **Open the table**.

A small pixel gavel strikes once when a new session opens and once when it ends. The card and
a quiet sound say which ending it was: a verdict is ready, you stopped the review, the session
closed without a verdict, or it failed. Stop uses a short descending cue, never the success cue.
The gavel does not delay requests or block controls. Saved reviews and replayed
history stay still and silent. Reduced-motion settings show the card without movement.
**Sound: on** in the header turns the sounds off or back on, and this browser remembers the
choice. Sounds are generated in the page; no audio files are loaded. When the board is in a
background tab, only the sound plays, so you hear when a long review finishes. The browser plays
nothing until you have clicked or typed on the page once. The JSON agent client loads neither the
animation nor the sounds.

1. **Round 0 is blind.** Every seat answers at once without seeing the others. A timed window
   lets you correct a wrong assumption, add a fact, or answer a seat's question, including when
   the seats already agree. Use **Continue** to move on immediately, or let the timer expire.
   Questions get the longer answer window; a round with no question uses the review window.
   Each reply card starts folded to its seat and position, including in the round still coming
   in; click its head to read the reply, and again to fold it. A card you open stays open until
   the review changes.
2. **Critique rounds.** Each seat sees the others' replies under their lens names and argues.
   Between rounds the countdown runs; writing a note requests more time. A finished final round
   without questions goes straight to the verdict.
3. **Questions for you.** Answer in one area above the replies. Identical questions share a field
   and list every seat that asked (name, lens and mood); distinct questions stay separate. Send all answers together, add
   a general note, or continue with unknowns left blank. Final-round questions also get the
   answer window before the verdict. With no response, the review continues automatically and
   records that the questions went unanswered; silence never supplies facts or accepts a result.
   The browser tab title and a sound draw attention to questions without taking keyboard focus.
   Explicit no-question placeholders such as `None.` or `none, treat available
   hours as an explicit unknown` do not create an answer window. Ambiguous wording still gets one.
   No extra model call is used to collect or filter questions.
   Every submitted answer is shared with all seats in the next round and with the chairman,
   even if only one seat asked. This gives every seat the same corrections and constraints.
   The initial blind replies stay independent; answers do not rewrite earlier replies.
4. **Finish with verdict** ends discussion and sends the collected replies to the chairman.
   It becomes available after a complete round has a usable reply. Unfinished seat calls are
   cancelled; their reported usage is kept. With **0 critique rounds**, round 0 still runs, so
   the chairman has the blind replies to assess. Before any round finishes, only Stop is available.
5. **Stop** aborts all work, including the chairman. So does typing `/stop`.

Cards with the same position share an outer box, so agreement is visible at a glance. Each
card has a small dot for what the seat is doing (grey idle, blinking amber thinking, green
replied, red failed) and a faint tint for its position (with the majority, against it, its own
stance, or passed).

Each card separates its position, disagreements, new points and assumptions. Red emphasis marks
literal rejection or negation words inside disagreement sections; green marks agreement.
The labels and text carry the meaning too. These colors are reading aids, not sentiment scores.

The debate also stops by itself when all seats agree, all pass, a round changes nothing, the
round limit or wall clock is reached, or a budget cap would be crossed.

**Stop** saves your note, cancels this review's CLI processes and endpoint requests, and prevents
all further calls, including the chairman, retries and fallbacks. The button stays available
while a verdict is being written, including one started later with **Write**. Completed replies
and reported usage are kept. The board says **Review stopped**. To get a verdict afterward,
request it explicitly with **Write**. A natural stop such as consensus still writes its verdict.
Stop saves the general note without submitting question drafts, and works even if the table
has moved past the questions you were viewing. No verdict is requested without usable replies.
Cancelled calls say why they stopped. A provider timeout is shown separately from the review's
overall time limit. Waiting for your input counts toward that limit; the answer area shows the
remaining time. If it expires, the board says that no answer was assumed.

### The verdict

The board shows a **Conclusion**: the recommended option first, in bold uppercase, then the
answer, its reasons, the main reservation and
what could change it. A missing goal or fact that could change the answer must be stated as a
condition, with **Clarification needed from you** below it. These questions are for you; a
finished review does not wait for answers or start another call automatically. Optional further
exploration, final panel positions and run details are under **Discussion details**. Panel
positions count the seats' final eligible replies; agreement is not a confidence score.

The chairman can give a nuanced or combined answer to a reflective question. If no single
listed option fits, it can recommend `none` and explain the conclusion. **Record your decision**
then starts with "none of these" selected. You still make the decision.

**Copy result** copies the readable conclusion, reasons, reservations and follow-up questions,
without the transcript, usage figures or local paths. If clipboard access is blocked, a selected
text box lets you copy manually. **Export record** keeps the full structured decision record.
Older saved verdicts still display; their unclassified questions remain visible as **Questions
for you**. They are not silently treated as optional. Updated wording applies to new reviews;
opening an old review does not regenerate it or spend tokens.

The stored verdict keeps `RECOMMENDATION`, `DISSENT`, `KILL_CRITERIA` and `OPEN_QUESTIONS`.
The first recommendation line remains an option id or `none`. New question bullets use
`NEEDED:` or `OPTIONAL:` within `OPEN_QUESTIONS`; an absent item uses `None.`. These are
presentation hints, not new required fields or retry conditions. The transcript, field notes
and verdict remain in `debates/<date-and-question>/`.

When discussion ends, its comment controls close. The board first says **writing verdict**, then
**Review finished** or **Review ended · no verdict**. **Record your decision** opens a separate
form; its note records your choice and is not sent to the agents.

If the verdict was skipped or failed, **Write** requests it separately, subject to the existing
budget. Choosing the original CLI chairman keeps its model, effort and login profile; the
selector shows those settings. Choosing another CLI vendor uses that vendor's defaults.

If the server stops in the middle of a debate, start it again and reopen the same address. The
board replays what happened and offers **Resume**.
This includes Ctrl+C and normal server shutdown: they interrupt the review, without recording
a human Stop. Shutdown closes event streams and waits briefly for cancelled calls to save
their reported spending. If discussion had already ended, **Write** requests its missing verdict.

Resume after an interruption starts fresh provider conversations using completed rounds and
all saved notes. This avoids reusing unsaved content left in an old provider thread. It can
resend more input during recovery; ordinary uninterrupted Resume-memory rounds still reuse
their conversation. Spending from discarded partial rounds continues to count.
Stopping a verdict records synthesis cancellation separately from why the discussion ended.

Every provider call first saves a dispatch record. If the server stops before the result is
saved, that call's usage is **unknown**, not zero. Resume keeps that uncertainty: vendor caps
and automatic seat caps can refuse further work. Check the provider's own usage before
deciding how to continue. Stopping the server first stops its engines, so cancellation cannot
start a new chairman request.

If a storage error stops a running review, fix disk space or permissions and then use
**Resume**, or **Write** when discussion already finished. The server waits for cancelled
turns to settle before offering recovery. Recovery never starts a call automatically.

A note entered when resuming before round 0 is saved as **Before round 0**. It reaches the
restarted blind calls, subsequent stateless calls and the chairman, and remains in replay and
exports. The original field notes stay unchanged.

If a write was interrupted in the final line, the board shows the complete records and a
recovery notice. Opening history does not change the file. Before the next write, Roundtable
saves a byte-for-byte `transcript.recovery-<id>.jsonl` backup beside the original, then restores
the complete prefix. The notice remains on replay and in exported records. A valid final row
without a newline is preserved too. The incomplete row cannot be reconstructed, and any usage
inside it may be missing; check the provider's own usage before relying on a cap after recovery.

A corrupt completed line is different: the list says **needs repair**, names the line, and
blocks resume and export. Restore `transcript.jsonl` from a known good backup and restart the
server. Keep the damaged file until you have checked the restored record; recovery never
silently skips a corrupt completed line.

Unreadable pool or calibration settings are also preserved. Restore the affected JSON file
from a known good copy and restart before saving settings. A failed read is not an empty file.
History lists reuse small summaries for unchanged transcripts; old replay bodies are evicted
when no review or connected board needs them. Reopening an evicted review reads it from disk.

## 5. Keep the cost low

- Start with two seats and zero critique rounds: three planned calls, including the verdict.
  One critique round with three seats makes seven calls before retries.
- Lighter models (Sonnet, Flash) or lower effort for seats that only need to poke holes.
- Spend the effort on the chairman instead: one step above the seats is one call's worth of
  extra thinking, on the call that decides.
- A light chairman: it makes the longest single call.
- Keep memory on `stateless`.
- Set a budget cap per vendor when you are near a limit.

The prompts ask for roughly 140 words per seat and 220 for the verdict, and discourage repeated
questions and field notes. These are writing targets, not enforced output limits. Actual usage
also includes CLI overhead, reasoning and retries. Shorter visible replies do not guarantee the
same reduction in billed tokens. No reasoning settings or budgets are changed automatically.

## 6. Export the decision into your codebase

So that your coding agents can read what was decided, even inside a sandbox that only sees the
repository, export the debate as a decision record:

- In the board, press **Export record** on the verdict panel and give a folder, for example
  `C:\code\my-app\docs\decisions` or `~/code/my-app/docs/decisions`. The folder is remembered
  next time. **Choose…** beside the field opens your system's folder dialog instead of typing:
  the Windows folder browser, the macOS folder chooser, or zenity or kdialog on Linux. Without
  one of those on Linux, type the path. The dialog waits up to ten minutes; if it cannot open or
  times out, the board shows an error and you can still enter the path manually.
- Or set **Export to** in the field notes before the debate; it has the same **Choose…** button.
- Or from a terminal:

  ```bash
  npm run export -- <debate folder name> <target folder>
  ```

The folder must already exist. Each debate becomes one markdown file with the question, field
notes, the final position of each seat, the recommendation, dissent, kill criteria, open
questions, your notes and the usage. The same folder gets a `README.md` index of every record
(`DECISIONS.md` instead when the folder already has a README that roundtable did not write).
Roundtable only ever replaces files it wrote; anything else in the way is refused.
On Linux and macOS, replacements preserve the existing record and index permission bits.
New files use normal file permissions filtered by your shell's umask, including in shared folders.

A record says **recommended** until you decide. Open **Record your decision** under the verdict. **Your decision** has the
chairman's pick preselected; choose it, another option or "none of these", add a line on why if
you like, and press **Accept**. The record then says **accepted**, names your choice and the
recommendation side by side, and is written again if the debate has an Export to folder.
Point your agents at that folder in their instructions, for example a line in `AGENTS.md`:
"Read docs/decisions/README.md before changing anything a decision covers."

## 7. A second account for a seat (optional)

By default every seat of a vendor uses your one login, the same as two terminal windows would.
To give a seat a different account, give it a profile name in the **Account** field, then log
that profile in once:

```bash
npm run doctor -- --profile work
```

It prints the exact commands for each vendor, for example on Windows:

```
set CODEX_HOME=C:\Users\<you>\.roundtable\homes\work\codex
codex login
```

Run them in a terminal and sign in with the other account. Roundtable never copies your login
files; each profile is logged in by you. Antigravity has no way to keep a separate profile, so
its seats always use the IDE's account.

## 7b. An API endpoint as a seat (optional)

The CLIs on your subscriptions are the main path. If you also want a model the CLIs do not
offer, or one running on your own hardware, seat an **API endpoint**: any server that speaks
the OpenAI chat-completions API.

| field | what it does |
|---|---|
| Endpoint | The base URL, ending in `/v1`. Presets: Ollama (`http://localhost:11434/v1`), LM Studio, vLLM, llama.cpp server, DeepSeek (`https://api.deepseek.com/v1`), Moonshot/Kimi (`https://api.moonshot.ai/v1`; China keys use `api.moonshot.cn`), OpenAI. Any other URL works. Plain `http` is accepted for local names and private IP literals (`localhost`, `10.0.0.5`, `192.168.0.9`, `.local`, a bare LAN name); a hosted API must be `https`. A name such as `10.api.example.com` still requires HTTPS. |
| Key var | For a hosted API: the **name** of the environment variable that holds your key, for example `DEEPSEEK_API_KEY`. Not the key. Set the variable in the shell you start roundtable from; a preset fills in its usual name. A local server needs none. |
| Model | Required: the endpoint has no default. Type the id the server knows (`llama3`, `deepseek-chat`, `kimi-k2`...). |
| Effort | Sent as `reasoning_effort` only when you set a pip; a server without that field answers 400, so leave it on default for most local servers. |

Only valid environment-variable names are saved in browser preferences. Invalid values are
also removed from older saved drafts when the page loads. Keep the actual key in the server's
environment; the Key var field is never a place to paste it.

What is different from a CLI seat:

- **Billing is the endpoint's.** A hosted API bills per token to the account whose key you
  named; a local server costs your hardware. The tag on the card, `API · pay-per-token` or
  `API · local`, is there so this is never a surprise. The strip shows tokens but no dollar
  figure (the endpoint does not report one), so a dollar cap is refused for it; a token cap works.
- **The key is sent to the endpoint you choose.** Roundtable reads the
  variable at call time and sends it as a bearer to the URL you named, with redirects refused.
  Roundtable does not deliberately add it to transcripts, logs or the board. Provider response
  and error text can be displayed and recorded, so use an endpoint you trust not to echo it.
- **The lamp cannot check reachability.** Before the first call the lamp says only whether the
  URL passes the rules and whether the named variable is set. Roundtable sends no probe: a
  probe would mean this server fetching a URL the page named, with the key attached, which a
  hostile web page could abuse. The first real call is the check; a failure shows on the card
  like a CLI's would (`could not reach`, `401`, and so on).
- **Stateless requests only.** Roundtable sends a fresh request and does not manage a remote
  conversation for endpoints, so `memory: resume` is refused when an endpoint sits at the table.
  This describes Roundtable's requests, not what the endpoint stores or retains.
- **One pool per host.** Two seats on `localhost:11434` share a pool; a seat on DeepSeek has
  its own. A host that fails (wrong key, no credit, nothing listening) benches only its own seats.
  The token cap, though, is per vendor: one cap covers every endpoint seat at the table.
- **A short rate limit is waited out once.** A `429` whose `Retry-After` asks for 30 seconds
  or less (the delay past which `agy` stops waiting on its own server) is waited out, and the
  call is sent once more, provided the wait ends before the review's wall clock does. Stop and
  finish end the wait at once. A `429` with no `Retry-After`, with a longer one, or a second
  `429` after the wait benches the host like no credit does, so a used-up quota is never called
  round after round. A `429` counts as zero tokens, since the server refused the request before
  the model ran. A CLI seat needs none of this: its CLI waits out such delays itself.
- **No tools are offered** in the request. A reply that carries `tool_calls`, a legacy
  `function_call`, or a tool finish reason stops that seat for the review. Its answer is
  excluded from later discussion; its reported spending still counts.
- **Response size is bounded.** The complete response body, including JSON metadata, must fit
  within 1 MiB after decompression. A larger success or error response is cancelled and the
  card reports the limit; it is not retried as a network failure. Reduce the endpoint's output
  length if a legitimate reply reaches this limit.

The chairman can be an endpoint too; its card takes the same fields. The decision record
names the endpoint on each seat's line (`API http://localhost:11434/v1`) and on the chairman's.

## 8. Run a debate without the browser

### Optional searcher before discussion

The **searcher** gathers web evidence once, before the blind replies. It never argues or votes.
Press **+ Add searcher** under the seats to add its card, next to the chairman's; its × removes it.
By default its visible **Query** follows your question and candidate options. It investigates
facts for and against them; it does not recommend an answer. Choose **Custom query** to edit
the draft or enter an exact question. A custom query stays unchanged when you edit the review.
Only the displayed query goes to the searcher: other context and discussion answers are excluded.
Review it for private details. The same decision question is useful when you need outside
evidence; leave the searcher off when you already have the facts you want the seats to reason from.
The card has its own vendor,
model, effort and login profile, like the chairman's. Pick the vendor whose pool has room:
Claude, Codex or Antigravity. There is one searcher and one call, on that vendor only. A new
searcher, or one moved to another vendor, starts on that vendor's lightest model at low
effort, since finding and quoting sources needs little reasoning. Each CLI searches with every
other tool kept off: Codex turns on only its web search, Claude gets WebSearch as its only
tool, and Antigravity, whose web search is always on, keeps its other tools denied. An
Antigravity searcher has the same limited isolation as an Antigravity seat, and its card says
so. It also needs the same terms acknowledgment (see Antigravity under section 2), and an
agent request with an Antigravity searcher sends `acknowledgeTermsRisk: true` too. An API endpoint
has no search tool and is not offered.
This is one additional subscription call, included in the quota projection and vendor budget.
The setup estimate also reserves 12,000 input tokens for shared evidence in each discussion
and verdict call. After research, admission checks use the saved source bundle's UTF-8 size
divided by three as an additive token estimate, including resumed conversations and repairs.
Measured dollar baselines are adjusted for that extra input. These are conservative planning
allowances, not exact token counts or guaranteed spending limits.

Set its **Limits**: searches (1–8 reported operations) and time (30–600 seconds). An operation
can contain several queries or page visits, and can begin before the CLI reports it. A Codex
searcher is asked to make one operation carrying up to that many queries, and another only
when the first returned nothing usable: each further operation resends everything gathered so
far and is one more request that can stall, so this keeps its input near a single search's
(about 22k tokens) instead of growing with each one. Roundtable
stops the call when a reported operation exceeds the limit; it cannot undo upstream work or
guarantee a provider billing ceiling. Claude also reports how many searches it ran when the
call ends, and a count over the limit fails the research. Claude runs each search on a small
model of its own; those tokens are included in the searcher's usage. Claude's WebSearch returns
titles, links and that model's summary without opening the pages (WebFetch stays off), so its
excerpts are shorter than Codex's. Local commands, files, MCP and delegation remain forbidden.

While the searcher works, the review state reads **Searcher at work** and the sources panel
shows its eye moving down a column of results (still, with reduced motion).

The board saves up to eight sources with URLs, excerpts, publication dates where reported,
and the time the bundle was gathered. A date that is not a real `YYYY-MM-DD` date (a month
only, a year only, "unknown") is saved as not reported; the source itself is kept. Citations and excerpts are supplied by the searcher's provider, not
independently verified by Roundtable. Every seat and the chairman gets the identical saved
bundle, with tools disabled during discussion. The source panel, agent state, field-notes
file and Markdown export include it. Its spending appears as the **searcher** row in Usage
details and a **searcher** segment in the quota picture.

If the searcher repeats a URL, Roundtable keeps one citation in first-seen order. The first
title and publication date are kept; distinct excerpts are appended only when the complete
combined text fits 1,200 characters. All entries must still pass validation, including
duplicates, and the response must contain at most eight entries before deduplication.
Different query strings and fragments remain distinct URLs. This cleanup is local and makes
no extra model call; repeated sources do not discard an otherwise usable search result.

A Codex search can stop making progress in two ways. Most often one of its requests, the search
or the answer after it, streams nothing: at low effort (the searcher's default) Codex reconnects
after 15 seconds of silence, as any light Codex call does (see Error logs), and each reconnect
resends only that request, so a finished search is kept. Less often a search starts and nothing
more arrives while its process remains open, so no silence limit fires. Roundtable stops a Codex
searcher call that makes no progress for 40 seconds (a "Reconnecting" notice counts as progress,
since those reconnects are bounded) and starts it once more if at least 30 seconds of the
searcher's time limit remain; a call whose reconnects were all used up is started once more the
same way. This recovery does not identify or fix the cause of the stall. Both attempts share one
limit, both are
recorded, and the stalled one's usage stays unknown, since Codex reports none for it. The retry
is a fresh call with its own search limit, so one research step can run up to twice the
configured number of searches; each attempt's row in the record says how many it ran. A stall
is noticed after 40 seconds and a retry needs 30 more, so a time limit under about 75 seconds
leaves no room for one. A Codex token cap can also refuse the retry, since the stalled attempt's
spending is unknown.

Research failure or interruption ends the review before discussion. Check the details and
provider usage before explicitly starting a new review. Resume never repeats unfinished
research; completed bundles are reused without refetching pages.
The agent state reports a fixed failure description and safe progress fields; open the board
for the original provider error details. Saved failures receive the same filtering.

For the agent client, add this to the request's `options` (leave it out to keep research off).
`vendor` (`codex`, `claude` or `agy`; Codex when left out), `model`, `effort` and `account` set
the searcher; without the last three it runs that vendor's lightest model at low effort on your
usual login:

```json
{
  "research": {
    "vendor": "codex",
    "query": "Public evidence for a staged release",
    "maxSearches": 4,
    "timeoutMs": 120000,
    "model": "gpt-6-luna",
    "effort": "low"
  }
}
```

Use the JSON client for coding agents. It returns one compact object per command and exposes
timed question windows without answering for the person. From a checkout:

```bash
npm start -- --no-open
node src/cli.js agent status --refresh
node src/cli.js agent check --input review.json
node src/cli.js agent start --input review.json
node src/cli.js agent wait --id <review-id>
```

Installed packages use `roundtable agent` with the same arguments. Add `--port <number>` to
target another local server. `status --refresh` checks installed CLIs and cached account state;
`check` validates the request and estimates its size. Neither makes a model call. `start`,
`answer`, `resume` and `verdict` can cause calls under the review's existing limits.

Connected assistants use the same client through MCP. Start with `roundtable_guide` and
`roundtable_status`, then `roundtable_check` and `roundtable_start` with `{ "review": ... }`.
`roundtable_wait` takes `{ "id": "<review-id>" }`; after displaying questions it also takes
`afterRound`. `roundtable_answer` takes `{ "id": "...", "round": 0, "answers": [...] }`.
`roundtable_hold`, `roundtable_finish`, `roundtable_stop`, `roundtable_resume` and
`roundtable_verdict` expose the corresponding controls. All tools have typed input schemas
and return matching JSON text and `structuredContent`. No acceptance or export tool is exposed.

MCP replies identify `service: "roundtable"`; a started review has an id and board URL.
`nextAction` includes tool names and arguments for the question handoff. `completed` is true
only when the review is done **and** the chairman's verdict is ready. A returned id, completed
seat turn or timed-out wait is not completion. Keep waiting through `running` and `verdict`.
If synthesis failed, was skipped or the review was interrupted, report that limitation instead
of writing a replacement recommendation. `depth` reports planned critique rounds, attempted
rounds and completed rounds (including separate critique counts). A completed round has a
reply entry for every seat and at least one usable reply; an all-failed, invalid, PASS-only
or prohibited-tool round is attempted, not completed. Mixed rounds may still contain failed
seats, so report those limitations alongside depth. Report actual depth:
consensus can stop early, and zero critique rounds means the seats did not answer each other.

When `nextAction.type` is `ask_user`, the coordinator must actually ask `gate.questions`:

1. Use the host's available question/input tool. If there is no form, ask in normal chat.
   Combine overlapping questions when useful, while retaining their IDs. A raw JSON dump
   alone is not the question handoff.
2. Tell the person when `gate.autoContinueAt` expires and that the review will continue with
   unanswered facts still unknown. Use only supplied facts; do not fill missing answers yourself.
3. If the person needs more time, send `agent hold --id <review-id> --input file` with
   `{ "round": 0 }`. This renews the configured answer window, bounded by the wall clock.
   Do not use it as a background keepalive. `nextAction.extend` provides the command and input.
4. With an asynchronous input tool, run `nextAction.waitCommand` while the prompt is pending.
   It uses `wait --after-round <round>` to wait for another step without repeatedly returning
   the same question. A timed-out read returns `nextAction.type: "await_user"`; keep the existing
   prompt and wait again. When its window closes, report the outcome. Silence is not consent.
5. Before submitting a reply, read `agent status --id <review-id>`. If the round has advanced,
   keep the user's reply and explain that it was not submitted. Do not attach it to different
   question IDs or start another review automatically.

`nextAction.answerTemplate` and `nextAction.command` give the answer shape and agent subcommand.
Prefix subcommands with `node src/cli.js` from a checkout, or `roundtable` when installed.
Use the current question IDs and round number in an answer file:

```json
{ "round": 0, "answers": [{ "id": "q1", "text": "The deadline can move by a week." }], "message": "Keep the trial reversible." }
```

```bash
node src/cli.js agent answer --id <review-id> --input answers.json
node src/cli.js agent wait --id <review-id>
node src/cli.js agent status --id <review-id>
```

Every result with a review id also carries `board`, a link to that review on the local server.
A person can open it in a browser to watch the review, answer questions or read the verdict
while the agent keeps working. An agent should offer the link, not open it. Use the server that
is already running; start one only when `status` cannot reach it.

`wait` returns at a question or completion, or after 25 seconds (configurable from 1 to 30 with
`--seconds`). Reading never extends or continues a round; the server owns the timer. A timed
checkpoint with no questions has `nextAction.type: "wait"`; keep waiting instead of asking for
an empty confirmation. With `"unattended": true` in `options` the review
never pauses: `wait` returns progress or completion, and the seats assume instead of asking.
In attended reviews, read `status`, answer only from supplied facts, and ask for missing facts.
Empty answers leave questions open. Stale-round answers fail
without being sent. Writes are never retried automatically. Use `stop` to abort all calls,
`resume` for an interrupted review, or `verdict` to request a missing verdict. Acceptance and
export stay explicit user decisions.

The readable board conclusion does not change the agent response or verdict contract. Read the
original verdict sections and option id as before; `NEEDED:` and `OPTIONAL:` inside
`OPEN_QUESTIONS` distinguish material unknowns from further exploration. They do not reopen a
finished review. Ask the user for missing facts before starting any requested follow-up.

Use `agent finish` when the user wants to end discussion and get a verdict. It requires a
completed round with a usable reply and can start a chairman call. Use `agent stop` to abort
everything. The current state's `actions` list tells you when `finish` is available.

Notes sent through `agent answer`, `agent finish`, `agent stop` and `agent resume` are labelled **Agent note**
on the board. Notes you enter there keep **You said**. Prompts and exported records name the
source as **Agent coordinator** or **Human**, including after reload. Direct API clients should
send `"source":"agent"` with automated notes; an omitted source defaults to `human`.
Older notes without a source keep their original human label; their author cannot be recovered.

The client reads the launch token from the loopback page and holds it in memory, or uses
`ROUNDTABLE_TOKEN` when supplied. It never prints or stores the token. `--input -` accepts JSON
on stdin. Keep real request and answer files outside a public repository.

`review.json` uses the same shape as the board. Select providers reported ready by `status`:

```json
{
  "fieldNotes": {
    "decision": "Should we ship sync behind a flag?",
    "options": ["Ship it", "Wait", "Data model only"],
    "constraints": "One developer, three months."
  },
  "seats": [
    { "vendor": "claude", "lens": "risk", "mood": { "preset": "grill" }, "model": "sonnet", "effort": "low" },
    { "vendor": "claude", "lens": "cost", "mood": { "preset": "builder" }, "model": "sonnet", "effort": "low" }
  ],
  "chairman": { "vendor": "claude", "model": "sonnet", "effort": "medium" },
  "options": { "critiqueRounds": 1, "memory": "stateless", "budget": { "claude": { "tokens": 120000 } } }
}
```

Attended requests can set `options.autoContinueMs` (default 15000) and `options.questionWaitMs`
(default 120000), each from 100 to 600000 milliseconds. Both are ignored in unattended mode.
The overall wall clock remains a hard limit, including response windows and extensions.

### Choose the review depth

The cost of a review is the number of calls, not the length of the request. Each seat call
carries the provider's own overhead before the field notes arrive, so one more seat or round
costs far more than one more sentence of context. `agent --help` repeats this recipe:

- **Size.** Normally use two seats, `critiqueRounds` 1 (the engine default), `memory` stateless
  and a budget per vendor: up to five calls before any repairs. Use zero critique rounds for
  a requested quick comparison and disclose that the seats will not respond to each other.
  Two critique rounds can suit a requested deep review or several consequential trade-offs,
  within the person's time and budget. Consensus may end early. Do not automatically start
  a second review or exceed agreed limits because disagreement remains.
- **Lenses.** Give every seat a different lens, taken from what the decision could get wrong:
  risk, cost, evidence, reversibility, long-term effects, user impact. Two seats with the same
  lens mostly agree, which wastes a call.
- **Moods.** Pair one sceptical seat (`grill`) with one practical seat (`builder`). Use
  `steelman` when the user already leans one way, and `contrarian` when the seats would
  otherwise agree too early.
- **Effort and model.** `effort` low and the lightest model that `status` lists for the seats.
  Give the chairman one effort step more than the seats (medium when they run low): it judges
  the arguments rather than counting them, and at low effort it tends to dismiss the hardest
  objection in a word. Raise one seat, not all, when the decision is hard to reverse.
- **Context.** `constraints`, `known`, `assumed`, `reversibility` and `deadline` go into every
  prompt. Fill them only with facts the user stated. A guess belongs under `assumed`, never
  under `known`, and an empty field is better than an invented one.
- **Agreement.** When `gate.reopenCalls` appears, every seat already agrees. Answers with empty
  text and no message go straight to the verdict. Any answer text or message runs one more
  round, at that many calls. Send text only when it could change a position. A fact that only
  confirms what the seats said can wait for the verdict.

A seat that writes more bullets than the format allows is trimmed to the limit instead of being
asked again. The full reply text stays on the board.

The older `npm run debate -- --token <hex> < review.json` runner is still available for
unattended scripts. It automatically continues through questions; use `agent` for interactive
reviews that need answers. The startup line supplies its token, or use `ROUNDTABLE_TOKEN`.

## 9. When something goes wrong

Failed Start, Continue, Resume, Stop, acceptance and export requests show an error beside the
action. The board keeps your note or target path until the request is acknowledged and blocks
duplicate submissions while it is pending. Keyboard focus stays on an effort control when its
value changes. The effort squares have larger click targets than their visible marks.

A connection error or a 15-second action-request timeout does not prove the server rejected
the action: it may already be running or saved. Roundtable does not retry these writes
automatically. Check the current board or recent history before retrying. This browser timeout
does not cancel model work on the server. If the page reports an expired launch token, copy
unsent notes and reload. A failed history load says **unavailable**, with **Retry history**;
it does not claim your records are gone. A setup-load failure offers **Reload**.

### Known issues

Each entry carries the date it was written, so a stale one shows. An entry leaves when a
release can show it no longer applies.

**Codex calls can stall** (noted 2026-11-04; seen since late October 2026). A Codex request
sometimes streams nothing for a long time after it is accepted, or a web search starts and never
returns. It happens on every Codex model, for seats and the searcher alike, and with a direct
`codex exec` call on the same account and network, so it is not specific to Roundtable's
settings. What you see: a **Reconnecting** notice on the card, a reconnect count on the reply,
a searcher started once more, or a reply that takes 15 to 30 seconds longer than usual.

What Roundtable does: streams Codex replies over WebSocket, so a response that never starts is
caught; reconnects a silent low-effort call after 15 seconds of silence, up to five times;
counts a searcher's reconnects as progress and starts the searcher once more when its call made
no progress for 40 seconds; asks the Codex searcher for one search call carrying its queries.

What it cannot do: once the reconnects are used up, Codex falls back to HTTPS, where a response
that never starts is bounded only by the call limit. Seats at medium effort and above keep the
longer idle limit (95 seconds at the default call limit), so a silent stall there costs more. A
seat whose request stays busy without progress has no watchdog; only the call limit ends it.

If a review keeps stalling: seat another vendor for that round, keep the searcher at low effort,
keep the call limit at its default rather than raising it, and follow the connection checks
below. Save the error log if you report it.

### Regional availability and stalled connections

A provider can accept a connection and then stop delivering the reply. Repeated reconnects,
partial replies or timeouts can therefore occur even with a valid login and a green status
lamp. Increasing the time limit or retrying does not establish that the connection is healthy.

1. Check the vendor's current regional availability and service status for your product and
   account. You can choose another available vendor for a seat or chairman.
2. Compare a small direct CLI call using the same account, terminal and network. A real model
   call uses quota. If it also stalls outside Roundtable, investigate the provider or network
   path before changing review limits. A successful direct call alone does not rule out an
   intermittent connection problem.
3. If needed, temporarily compare another network you normally use, then restore your settings.
   Keep this a diagnostic comparison, not a requirement to enable a VPN for every user.
   Save the Roundtable error log and record the OS, Node and CLI versions, failure time and
   whether the direct call also failed. Exclude credentials and private review content.

### Error logs

Codex calls disable analytics and telemetry exports, shell snapshots and unlimited connection
retries for that process only. After a complete answer and valid usage arrive, Roundtable gives
the CLI one second to exit and then terminates a stuck process while preserving the result.
It continues checking tool policy and stream validity during that grace period. A partial
answer, missing usage or a failed turn cannot use this shortcut. Timeouts before completion
remain failures with unknown spending where the provider reported none. Ordinary seat and
chairman timeouts are not retried automatically; the searcher's bounded restart is described
above. Search and reconnect stages in the error details help distinguish these from slow
model replies. These controls do not guarantee the provider's availability.

A Codex reply streams over WebSocket through a provider entry Roundtable names per call, pointing
at the same ChatGPT backend with the same login. A response can take minutes to start; over
WebSocket the idle limit runs from the moment the request is sent, so that wait is caught like a
silent stream. When the stream stays silent for the idle limit, (call limit − 15 s) ÷ 3, between
10 s and 300 s: 95 s at the default five-minute call limit, the CLI reconnects and starts the
answer again, at most twice; once those are used up the call fails as a stalled connection,
before the call limit. The provider may charge interrupted attempts without including them in
the reported usage. Raising the call limit also lengthens the idle limit, allowing more time for
silent reasoning at high effort. A call at low effort (or none or minimal) answers within
seconds once its request streams, so it reconnects after 15 seconds of silence instead, at most
five times (the derived limit when a tight call limit makes that shorter). Once the reconnects
are used up over WebSocket, the CLI falls back to HTTPS for the rest of the call, where the idle
timer starts only after response headers; a WebSocket that does not open within 10 seconds does
the same. Roundtable's overall call limit still bounds the process. Every reconnect is counted,
including the first WebSocket retry that Codex leaves out of its events (Roundtable reads it from
Codex's retry log): a reply that came after one carries a
**reconnected ×N** mark on its card, and the count is saved with the attempt, where failure
details, error logs and the agent state show it. The markdown transcript does not carry it.

Provider failure **Details** show whether output arrived, the last observed stage, elapsed
and idle time, and the exit code when available. A timeout after reasoning is evidence that
the call started; it does not identify why the provider stalled. Save the error log before
retrying. A complete usage report received before the stall still counts, while missing
usage continues to block capped calls. Ordinary seat and chairman timeouts are not
automatically retried.

Errors include a reference such as `RT-0123456789abcdef`. **Save error log**, available on
setup and review screens, downloads a JSON file you can share for diagnosis. Note what you
were doing and the reference ID. Nothing is sent to an assistant or maintainer automatically.
An assistant working in your local checkout can inspect the same log when you ask it to.

Server, provider, storage and browser failures are recorded in `_diagnostics/` inside the
active data folder. Two rotating files hold up to 512 KiB total; the server accepts at most
120 entries per minute and reports omitted entries in the download. Logs survive restarts.
They contain fixed error categories, action names, reference IDs, provider names, timestamps,
app/runtime versions and source line numbers. They exclude prompts, replies, titles, account
names, model IDs, URLs, credentials, raw error messages and personal filesystem paths.
Transcripts and terminal output are separate and can contain private review data.

If the server is unreachable, the browser keeps up to 20 sanitized events in this tab's
session storage and retries diagnostic delivery. They survive a reload, but closing the tab
can discard unsent entries. A download includes entries still waiting to be saved. If the
page says it cannot write the log, check disk space and data-folder permissions. You can
delete `_diagnostics/` while the server is stopped without deleting reviews.

Before a debate, each seat card's round lamp says whether that seat can take a call, checked
for free (no model call): green ready, yellow nearly out of quota or unknown, red not installed,
not logged in or out of quota (with the reset time), grey not checked yet. **Open the table**
names any red seat and asks once more before it starts.

Use **Refresh status** after signing in or changing an account. It runs free status checks,
shows when they finish, and reports a failed refresh. Results are reused for a minute unless
you refresh explicitly; repeated explicit refreshes within five seconds reuse the same check.
Overlapping requests for one pool share work. At most two pool checks run at once, with twelve
running or queued; if busy, try Refresh status again shortly. API endpoint checks validate the
URL and key-variable presence without sending a request to the endpoint.

For local scripts, `GET /api/preflight?pools=claude,codex` only reads cached snapshots: it never
launches a CLI, even with `?fresh`. `checkedAt: null` means no check yet; `stale: true` means
there is no current snapshot. Refresh with an authenticated JSON `POST /api/preflight`, using
`{"pools":["claude","codex"],"fresh":true}` and the launch token in `x-roundtable-token`.

| what you see | what to do |
|---|---|
| A seat's lamp is red: "not logged in" | Run the command it names (`claude /login`, `codex login`) in a terminal. |
| A seat's lamp is red: "quota used up" | Wait for the reset it shows, use another vendor for that seat, or seat a second account (step 7). |
| `doctor` says a CLI is not found | Install it (step 2) or fix your PATH; for `agy`, run `agy install`. |
| An API seat's lamp is red: "… is not set in the environment" | Set that variable in the shell you start roundtable from (`set DEEPSEEK_API_KEY=…` on Windows, `export …` elsewhere) and start it again. The board cannot read it for you. |
| An API seat shows "could not reach" or an HTTP status | Nothing listens at that URL (start the local server, check the port and the `/v1` suffix), or the endpoint refused the call (`401` a wrong key, `402` no credit, `429` a quota or a rate limit that one short wait did not lift, `404` a model id the server does not know). The seat's card quotes the server's own words. |
| A red "out" banner on the board | A vendor ran out of quota or lost its login mid-debate. Its seats are skipped from then on (no call, no tokens). For Antigravity the banner can name one model group ("Antigravity · Gemini 4 Argon out"): only seats on that group's models are skipped. If fewer than two seats are left, the debate stops and the chairman writes from what was said. |
| A seat shows "no reply" in red | Its call failed this round; the card gives a next step, with the CLI's own words under "details". Network failures may retry once if the budget and time limit allow it. The others carry on. |
| The verdict failed, or was not written | **Write the verdict with** a vendor of your choice, under the bar. If the chairman's vendor ran out, another one is preselected. |
| "reconnecting" banner | The board lost the server. The debate keeps running there; the board catches up when the connection is back. The banner clears even while waiting for input with no new events. |
| A seat is "re-prompted" | Its reply broke the format. It gets one format repair. Tool activity instead stops the seat without a retry. |
| A seat is "reconnected ×1" | Its provider connection went silent for the idle limit and the CLI started the answer again. The reply is complete; the interrupted attempt may have been charged without appearing in usage. Repeated marks on one vendor point at the provider, not at the seat. |
| "address already in use" | Another server is on that port. Stop it, or start with a different `PORT`. |
| The board says the debate is unknown | The server was restarted. Reopen the address; the board replays from disk and offers Resume. |
| A vendor's remaining quota shows nothing | Use **Refresh status**. A free read without limits leaves quota unavailable or keeps the last figure; it does not disable later reads or require a model call. Claude and Antigravity use their CLI's `/usage`; Codex uses its account rate-limit command and may show only a weekly window. Antigravity needs agy 1.1.11 or later, a sign-in and the account acknowledgment. If the console says quota reads are off, restart after checking that the CLI answers its local usage command without a model turn. |

## Where things live

| what | where |
|---|---|
| Live debates (transcript, field notes, verdict) | `live/` in the Roundtable user-data folder, unless `ROUNDTABLE_DEBATES_DIR` is set |
| Demo debates | `demo/` in the same user-data folder, unless the override is set |
| Retained usage statistics | `_usage.json` in the data folder; counters and model IDs, without review text |
| Measured quota rates and entered pool figures | `_calibration.json` and `_pools.json` in the live data folder; demo names include `.fake` |
| Your acknowledgment of Antigravity's terms notice | `_terms.json` in the live data folder (`_terms.fake.json` in the demo folder): when, and which notice |
| Saved setup preferences | browser local storage, separate for each host and port |
| Account profiles | `%USERPROFILE%\.roundtable\homes` on Windows, `~/Library/Application Support/roundtable/homes` on macOS, `~/.local/share/roundtable/homes` on Linux |
| Decision records you exported | the folder you chose |

The user-data folder is `%USERPROFILE%\.roundtable` on Windows,
`~/Library/Application Support/Roundtable` on macOS, and `$XDG_DATA_HOME/roundtable` on Linux
(or `~/.local/share/roundtable` when XDG_DATA_HOME is unset). It stays the same across checkout
changes. On Windows it is not under AppData: Windows redirects the AppData writes of anything
started from a packaged app, such as the Claude or Codex desktop app and the terminals they
open, into a private copy for that app, so each app would see its own history. An absolute `ROUNDTABLE_DEBATES_DIR` selects another location; use distinct paths for
demo and live data. Only one server can use a data folder at a time, even on different ports.

The live diagnostic check (`doctor --live`) keeps its working files under `_doctor/` in the
same live folder. The headless discussion script reads calibration from that folder too.

### Delete and clear history

Use **Delete** beside a saved session, then confirm its title. **Clear** confirms the number
of finished and interrupted sessions selected (up to 1,000 per batch); running sessions are
kept, including those waiting for your answers. The server rechecks the selection, including
a session that started writing a new verdict after the list
loaded. A stale selection is refused before any selected session is removed.

Deleting removes the local transcript, recovery copies and seat working files. It does not
remove files you exported, quota calibration or usage statistics. Token estimates retain the
recorded calls after cleanup and restart. A statistics-write failure prevents deletion. Open
tabs showing a deleted session return to the list without a deletion banner. Corrupt records
must be repaired first so their reported usage can be retained. Browser preferences and
provider histories are separate.

### Move older history

Older versions kept history in a checkout's `debates/` folder, and on Windows in
`%LOCALAPPDATA%\Roundtable`. A server started from a packaged app wrote that AppData folder into
the app's private copy instead, under `%LOCALAPPDATA%\Packages\<app>\LocalCache\Local\Roundtable`,
so one machine can hold several copies with different reviews. At startup Roundtable lists every
such folder that holds a review the current data folder lacks, in the terminal and under
**Local data and backups**. It never moves, merges or deletes them itself.

To move them, stop every server using an old folder. Move each review folder (the dated ones
with a `transcript.jsonl`) into `live/`, or into `demo/` for `debates-fake/` and the old `demo/`
folders. If a folder with the same name is already in the destination, do not replace it: leave
the old one where it is and compare the two. When the destination has no
`_calibration.json`, `_usage.json` or `_pools.json` yet, move the old one too; otherwise keep the
destination's. Usage is recounted from the moved reviews at startup, and quota rates relearn as
debates run. Start the server and check that the old folders are no longer listed and the
saved-session count is right. A folder whose reviews have all been moved is not listed again.
You can instead move everything to a new folder and select it with `ROUNDTABLE_DEBATES_DIR`.

### Back up and restore

1. Check the actual data folder in **Local data and backups** or the startup terminal. Stop
   every Roundtable server using that folder with Ctrl+C before copying it.
2. Copy the **entire folder** to a private backup location. Include `transcript.jsonl`, any
   `transcript.recovery-*.jsonl` files, field notes, verdicts, calibration/pool files and seat
   folders. Keep exported decision folders separately if you need them too. These files can
   contain private prompts and responses.
3. To test a restore, copy the backup into a **new, empty directory**. Keep the original data
   folder unchanged. Set `ROUNDTABLE_DEBATES_DIR` to the restored copy and use a spare port.

For a synthetic backup on PowerShell, replace the example path with your restored demo folder:

```powershell
$env:ROUNDTABLE_DEBATES_DIR='C:\roundtable-restore\demo'
$env:PORT='4750'
npm run fake -- --no-open
```

For bash or zsh:

```bash
ROUNDTABLE_DEBATES_DIR='/path/to/restored-demo' PORT=4750 npm run fake -- --no-open
```

Open http://localhost:4750. Confirm the data folder, open a saved debate, check its notes,
verdict and human decision, then export to a new test folder. A live backup uses
`npm start -- --no-open` instead. Reading history does not start model calls; Resume and
Write the verdict can. Stop the restore server when finished. Use a fresh terminal for normal
launches so the temporary environment settings do not redirect your next session.

Browser preferences and provider logins are not part of this backup. The restored debates
contain their own saved configuration. A new browser address starts with fresh preferences;
sign in through the vendor's own CLI if its login is missing. Do not copy login files as part
of a debate restore.
