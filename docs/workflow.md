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

## 2. Install and log in to each vendor

Seat only the vendors you have a subscription for. One vendor is enough: you can seat it
several times.

### Claude (Anthropic)

```bash
npm install -g @anthropic-ai/claude-code
```

On Windows you can use `winget install Anthropic.ClaudeCode` instead. Then log in once:

```bash
claude
```

Inside the program, type `/login`, finish the sign-in in the browser, then exit with `/exit`.

### Codex (OpenAI)

```bash
npm install -g @openai/codex
```

```bash
codex login
```

A browser opens. Sign in with the ChatGPT account that holds your subscription.

### Antigravity (Google)

Live Antigravity seats require **Allow limited isolation for Antigravity** in the review
settings (`options.allowLimitedIsolation: true` in an agent request). The option and consent
requirement are also in `roundtable agent --help`. Session rules deny documented tools, but
the CLI cannot disable all shared customizations or MCP discovery.
Use another provider if that limitation is unsuitable. Reported tool activity still stops
the seat without a retry. Claude and Codex require their isolation flags to be supported;
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

### Check what this machine can seat

```bash
npm run doctor
```

For each vendor it prints where the CLI was found, its version, the models and thinking levels
you can pick, and the remaining quota where the vendor reports one. Nothing is spent. To also
confirm each login with one tiny call, add `--live`:

```bash
npm run doctor -- --live
```

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
| Model | Under the vendor name on the card. The list is grouped by the plan your CLI reports (for example "On your plan (Max)"); models your plan does not include, or that bill usage credits, are listed apart. Antigravity lists each model once and its effort pips choose the variant. "other id…" takes any id. Lighter models draw less quota. A model the vendor has retired is refused with what to use instead. |
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
- Use different lenses to test different assumptions. Agreement between seats is not evidence
  that their shared assumptions are correct.

### Set the limits

- **Critique rounds**: rounds after the blind first one. Start with one and increase it only
  when another round is useful.
- **Auto-continue (s)**: after a round, the board waits this long for you, then moves on. A
  click or keystroke requests a pause. **Countdown held** confirms the server paused it; if
  the request fails, the board reports that the countdown may still be running.
- **Wall clock (min)**: a hard stop.
- **Memory**: leave on `stateless`. Each round is a fresh call with the field notes, the seat's
  own last reply and the others' replies. This avoids resending the full conversation, but
  token use and cost still vary. `resume` retains a conversation and can grow the context each
  round. Neither setting controls the provider's logging or retention policy.
- **Unattended**, off by default: the table never waits for you. The pause after the blind
  round is skipped, and the seats are told that nobody answers questions, so they state what
  they would have asked as an assumption instead; the question line leaves their contract, which
  also keeps its tokens out of every call. Turn it on only for a review nobody will watch;
  otherwise leave it off, so the board can stop for you and play its waiting sound.
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
hatched), the vendor's live windows where it reports them, and an optional cap. Antigravity
reports no remaining credits, so you can track the figure from its credits page in its card.

On the running board, usage starts collapsed. Each account shows its lowest reported percentage
remaining and a small bar, with the window and reading age. Missing figures say **not reported**.
Open **Usage details** for per-seat tokens, costs and timing, grouped by account with each
account's live windows. A **+** after a total means some calls reported nothing; a dash means
the CLI reports no cost. Rounds fold once a review finishes, so the conclusion leads.

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

1. **Round 0 is blind.** Every seat answers at once without seeing the others. The board then
   always waits for you. This is the best moment to step in: correct a wrong assumption, add a
   fact, answer a seat's question. Type in the bar at the bottom and press **Continue**, or just
   press Continue.
   Click a card's head to fold it to its seat and stance, and again to read the reply. The round in
   progress opens by itself; a fold you make stays until the review changes.
2. **Critique rounds.** Each seat sees the others' replies under their lens names and argues.
   Between rounds the countdown runs; type to hold it.
3. **Questions for you.** Answer in one area above the replies. Identical questions share a field
   and list every seat that asked (name, lens and mood); distinct questions stay separate. Send all answers together, add
   a general note, or continue with unknowns left blank. Final-round questions also wait before
   the verdict. Explicit no-question placeholders such as `None.` or `none, treat available
   hours as an explicit unknown` do not create a pause. Ambiguous wording still waits for you.
   No extra model call is used to collect or filter questions.
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

The board shows a **Conclusion**: the answer first, then its reasons, the main reservation and
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
set CODEX_HOME=C:\Users\<you>\AppData\Local\roundtable\homes\work\codex
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

### Optional research before discussion

Enable **Research first with Codex** to gather web evidence before the blind replies. Enter
a separate **Public search question** and review it for private details. Only this question
goes into research; your field notes and discussion notes are sent later to the selected seats.
The first Codex seat supplies the research model, effort and login profile; if there is none,
a Codex chairman supplies them, otherwise the installed CLI uses its default model and login.
This is one additional subscription call, included in the quota projection and vendor budget.
The setup estimate also reserves 12,000 input tokens for shared evidence in each discussion
and verdict call. After research, admission checks use the saved source bundle's UTF-8 size
divided by three as an additive token estimate, including resumed conversations and repairs.
Measured dollar baselines are adjusted for that extra input. These are conservative planning
allowances, not exact token counts or guaranteed spending limits.

Set **Search limit** (1–8 reported operations) and **Time limit** (30–600 seconds). An operation
can contain several queries or page visits, and can begin before Codex reports it. Roundtable
stops the call when a reported operation exceeds the limit; it cannot undo upstream work or
guarantee a provider billing ceiling. Local commands, files, MCP and delegation remain forbidden.

The board saves up to eight sources with URLs, excerpts, publication dates where reported,
and the time the bundle was gathered. Citations and excerpts are supplied by Codex, not
independently verified by Roundtable. Every seat and the chairman gets the identical saved
bundle, with tools disabled during discussion. The source panel, agent state, field-notes
file and Markdown export include it. Research spending appears as **Codex · shared research**.

Research failure or interruption ends the review before discussion. Check the details and
provider usage before explicitly starting a new review. Resume never repeats unfinished
research; completed bundles are reused without refetching pages.
The agent state reports a fixed failure description and safe progress fields; open the board
for the original provider error details. Saved failures receive the same filtering.

For the agent client, add this to the request's `options` (leave it out to keep research off):

```json
{
  "research": {
    "query": "Public evidence for a staged release",
    "maxSearches": 4,
    "timeoutMs": 120000
  }
}
```

Use the JSON client for coding agents. It returns one compact object per command and waits for
input instead of answering questions automatically. From a checkout:

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

When `wait` returns `waiting`, use its question IDs and round number in an answer file:

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
`--seconds`). It does not continue a round. With `"unattended": true` in `options` the review
never pauses: `wait` only ever returns at completion, and the seats assume instead of asking. Read `status`, answer only from supplied facts, and
ask the user for missing facts. Empty answers leave questions open. Stale-round answers fail
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
  "options": { "critiqueRounds": 0, "memory": "stateless", "budget": { "claude": { "tokens": 120000 } } }
}
```

### A small review, and how to choose its settings

The cost of a review is the number of calls, not the length of the request. Each seat call
carries the provider's own overhead before the field notes arrive, so one more seat or round
costs far more than one more sentence of context. `agent --help` repeats this recipe:

- **Size.** Two seats, `critiqueRounds` 0, `memory` stateless and a budget per vendor. That is
  three calls: two seats and the verdict. Add a seat or a round only when the user asks for
  depth.
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

### Error logs

Provider failure **Details** show whether output arrived, the last observed stage, elapsed
and idle time, and the exit code when available. A timeout after reasoning is evidence that
the call started; it does not identify why the provider stalled. Save the error log before
retrying. A complete usage report received before the stall still counts, while missing
usage continues to block capped calls. Timeouts are never automatically retried.

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
| An API seat shows "could not reach" or an HTTP status | Nothing listens at that URL (start the local server, check the port and the `/v1` suffix), or the endpoint refused the call (`401` a wrong key, `402`/`429` no credit or a limit, `404` a model id the server does not know). The seat's card quotes the server's own words. |
| A red "out" banner on the board | A vendor ran out of quota or lost its login mid-debate. Its seats are skipped from then on (no call, no tokens). If fewer than two seats are left, the debate stops and the chairman writes from what was said. |
| A seat shows "no reply" in red | Its call failed this round; the card gives a next step, with the CLI's own words under "details". Network failures may retry once if the budget and time limit allow it. The others carry on. |
| The verdict failed, or was not written | **Write the verdict with** a vendor of your choice, under the bar. If the chairman's vendor ran out, another one is preselected. |
| "reconnecting" banner | The board lost the server. The debate keeps running there; the board catches up when the connection is back. The banner clears even while waiting for input with no new events. |
| A seat is "re-prompted" | Its reply broke the format. It gets one format repair. Tool activity instead stops the seat without a retry. |
| "address already in use" | Another server is on that port. Stop it, or start with a different `PORT`. |
| The board says the debate is unknown | The server was restarted. Reopen the address; the board replays from disk and offers Resume. |
| A vendor's remaining quota shows nothing | Antigravity never reports it; type the figure from its credits page. Codex shows only a weekly window on some plans. |

## Where things live

| what | where |
|---|---|
| Live debates (transcript, field notes, verdict) | `live/` in the Roundtable user-data folder, unless `ROUNDTABLE_DEBATES_DIR` is set |
| Demo debates | `demo/` in the same user-data folder, unless the override is set |
| Retained usage statistics | `_usage.json` in the data folder; counters and model IDs, without review text |
| Measured quota rates and entered pool figures | `_calibration.json` and `_pools.json` in the live data folder; demo names include `.fake` |
| Saved setup preferences | browser local storage, separate for each host and port |
| Account profiles | `%LOCALAPPDATA%\roundtable\homes` on Windows, `~/Library/Application Support/roundtable/homes` on macOS, `~/.local/share/roundtable/homes` on Linux |
| Decision records you exported | the folder you chose |

The user-data folder is `%LOCALAPPDATA%\Roundtable` on Windows,
`~/Library/Application Support/Roundtable` on macOS, and `$XDG_DATA_HOME/roundtable` on Linux
(or `~/.local/share/roundtable` when XDG_DATA_HOME is unset). It stays the same across checkout
changes. An absolute `ROUNDTABLE_DEBATES_DIR` selects another location; use distinct paths for
demo and live data. Only one server can use a data folder at a time, even on different ports.

The live diagnostic check (`doctor --live`) keeps its working files under `_doctor/` in the
same live folder. The headless discussion script reads calibration from that folder too.

### Delete and clear history

Use **Delete** beside a saved session, then confirm its title. Interrupted sessions can be
deleted individually. **Clear finished** confirms the number of finished or stopped sessions
selected (up to 1,000 per batch); it leaves running and interrupted sessions alone. The server
rechecks the selection, including a session that started writing a new verdict after the list
loaded. A stale selection is refused before any selected session is removed.

Deleting removes the local transcript, recovery copies and seat working files. It does not
remove files you exported, quota calibration or usage statistics. Token estimates retain the
recorded calls after cleanup and restart. A statistics-write failure prevents deletion. Open
tabs showing a deleted session return to the list. Corrupt records must be repaired first so
their reported usage can be retained. Browser preferences and provider histories are separate.

### Move older history out of a checkout

Stop every server using the old data folder. Before starting this version, move the entire
old `debates/` folder to the user-data folder's `live/` directory, and `debates-fake/` to `demo/`
if needed. Preserve all contents, including calibration, pools, diagnostics and recovery files.
Verify that the destination is unused and outside the checkout; do not overwrite an existing
history folder. You can instead move to a new folder and select it with `ROUNDTABLE_DEBATES_DIR`.
Start the server and check **Local data and backups** and the saved-session count. Existing
checkout history is reported when detected; it is never silently merged or deleted at startup.

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
