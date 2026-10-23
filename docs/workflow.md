# Using roundtable

A step-by-step guide for running a debate, from a fresh machine to a decision record in your
codebase. What the tool touches on your machine, and what it never does, is in
[SECURITY.md](../SECURITY.md).

## 1. What you need

- **Node 22 or newer** (20 is end of life). Check with `node --version`.
- **At least one of the three agent CLIs**, logged in with your own subscription. Roundtable
  never asks for an API key and never sees your password. It only starts the CLIs you already
  use, the way you would in a terminal. (An OpenAI-compatible endpoint can take a seat too,
  section 7b; that is a choice you make per seat, and the card says so.)
- **A browser**, for the board. Any modern one.

Get the code and check it runs:

```bash
git clone <this repo> roundtable
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

The `agy` command comes with the Antigravity IDE. Install the IDE and sign in there. If `agy`
is not found in a terminal afterwards, let it set up your PATH:

```bash
agy install
```

On Windows the binary usually sits in `C:\Tools\agy\bin`. Run `agy` once in a terminal to
confirm it opens signed in, then exit. Gemini CLI was retired in June 2026; the Google seat is
always `agy`.

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

The board is a web page served by a small local server. Nothing leaves your machine except the
CLIs' own traffic to their vendors.

```bash
npm start
```

The board opens in your browser by itself (or open http://localhost:4747; `--no-open` keeps the
browser closed). Stop the server with Ctrl+C in that terminal; any CLI it started is stopped
with it. Without a clone, `npx @prplkane/roundtable` does the same.

**Try it first without spending anything.** The fake board runs the same screens with scripted
seats:

```bash
npm run fake
```

Open http://localhost:4748. Use it to learn the flow, and to show the tool to someone.

To use another port, set `PORT` before starting, for example `PORT=5000 npm start`
(PowerShell: `$env:PORT=5000; npm start`).

The first screen lists the debates on this machine, newest first: whether each is live,
interrupted or finished, what was recommended or accepted, and its size and cost. Click one to
open its board; **Debates** in the header brings you back, and the browser's Back button works
too. Each board has its own address, so you can bookmark it. Below the list is a new debate; the
bar at the bottom shows how many calls and tokens the table you are setting up is projected to
take, next to **Open the table**.

## 4. Run a debate

### Write the field notes

This is your part, and the most useful part. Fill in:

- **Decision**: one question, answerable.
- **Options**: at least two, one chip each. Press Enter in a chip to add the next, Backspace in
  an empty one to remove it. Each is numbered (opt-1, opt-2) as the seats will see it; a seat may
  still propose its own, written as "other: …".
- **Constraints**: what any answer must live within.
- **More context** (collapsed until you open it or fill it): evidence known, evidence assumed,
  reversibility, deadline, and **Export to**, a folder in your codebase where the decision record
  is written the moment the verdict is ready (see step 6). Seats see only these notes in round 0,
  so what you leave out, they will guess.

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

Use **+ Add seat** for more. Two or three seats are enough for most questions.

Below the seats is the **chairman**: a fresh session that did not argue. It reads every round
and writes the verdict, sceptically (agreement between seats is not evidence; it recommends
none when every option rests on assumptions). It does not decide: you accept an option after the
verdict. It can have its own vendor, model and effort.

### How seats stay independent

- Every seat has its own CLI session and runs in its own empty working folder,
  `debates/<slug>/seats/<id>/`. Your projects' `CLAUDE.md`, `AGENTS.md` and `GEMINI.md`, project
  memory and project settings are never in a seat's context.
- Claude seats load no user-level settings (`--setting-sources local`); Codex seats skip
  `AGENTS.md` discovery, the global one included.
- Other seats and the chairman see a seat only by its lens. Vendor, model and mood are never in
  any prompt, so no seat can defer to "the Claude one".
- Still shared: the CLI's own state folder (login, local history) unless the seat has a login
  profile, and whatever the vendor applies to every request from your account.
- Two seats on the same model with the same mood tend to converge. Give them different lenses
  and moods; that is the lever.

### Set the limits

- **Critique rounds**: rounds after the blind first one. One or two is usually enough; most real
  debates agreed by round one.
- **Auto-continue (s)**: after a round, the board waits this long for you, then moves on. Any
  click or keystroke holds it.
- **Wall clock (min)**: a hard stop.
- **Memory**: leave on `stateless`. Each round is a fresh call with the field notes, the seat's
  own last reply and the others' replies, so the cost per round stays flat. `resume` re-sends
  the whole conversation every round and costs more each round.
- **Budget caps**, in the quota panel: an optional token or dollar ceiling per vendor. The
  debate stops before a call that would cross it.

### Read the quota picture

The panel under the seats shows one block per vendor account. It lists what each seat is
likely to draw in this debate, stacked in the seat's colour, the vendor's live remaining
window where it reports one, and the measured share each seat would take. Antigravity reports
no remaining credits, so you can type the figure from its credits page into its block.

### Open the table and take part

Press **Open the table**.

1. **Round 0 is blind.** Every seat answers at once without seeing the others. The board then
   always waits for you. This is the best moment to step in: correct a wrong assumption, add a
   fact, answer a seat's question. Type in the bar at the bottom and press **Continue**, or just
   press Continue.
2. **Critique rounds.** Each seat sees the others' replies under their lens names and argues.
   Between rounds the countdown runs; type to hold it.
3. **Questions for you.** When a seat needs a fact only you have, the board stops and shows the
   question. Answer in the bar.
4. **Stop** ends the debate at any time. So does typing `/stop`.

Cards with the same position share an outer box, so agreement is visible at a glance. Each
card has a small dot for what the seat is doing (grey idle, blinking amber thinking, green
replied, red failed) and a faint tint for its position (with the majority, against it, its own
stance, or passed).

The debate also stops by itself when all seats agree, all pass, a round changes nothing, the
round limit or wall clock is reached, or a budget cap would be crossed.

### The verdict

The chairman writes the recommendation, the tally per seat, the strongest dissent, kill
criteria (what would prove the decision wrong) and open questions. Everything is saved in
`debates/<date-and-question>/`: the transcript, the field notes and the verdict.

If the server stops in the middle of a debate, start it again and reopen the same address. The
board replays what happened and offers **Resume**.

## 5. Keep the cost low

- One or two critique rounds, not more.
- Two or three seats.
- Lighter models (Sonnet, Flash) or lower effort for seats that only need to poke holes.
- A light chairman: it makes the longest single call.
- Keep memory on `stateless`.
- Set a budget cap per vendor when you are near a limit.

## 6. Export the decision into your codebase

So that your coding agents can read what was decided, even inside a sandbox that only sees the
repository, export the debate as a decision record:

- In the board, press **Export record** on the verdict panel and give a folder, for example
  `C:\code\my-app\docs\decisions` or `~/code/my-app/docs/decisions`. The folder is remembered
  next time.
- Or set **Export to** in the field notes before the debate.
- Or from a terminal:

  ```bash
  npm run export -- <debate folder name> <target folder>
  ```

The folder must already exist. Each debate becomes one markdown file with the question, field
notes, the final position of each seat, the recommendation, dissent, kill criteria, open
questions, your notes and the usage. The same folder gets a `README.md` index of every record
(`DECISIONS.md` instead when the folder already has a README that roundtable did not write).
Roundtable only ever replaces files it wrote; anything else in the way is refused.

A record says **recommended** until you decide. Under the verdict, **Your decision** has the
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
| Endpoint | The base URL, ending in `/v1`. Presets: Ollama (`http://localhost:11434/v1`), LM Studio, vLLM, llama.cpp server, DeepSeek (`https://api.deepseek.com/v1`), Moonshot/Kimi (`https://api.moonshot.ai/v1`; China keys use `api.moonshot.cn`), OpenAI. Any other URL works. Plain `http` is accepted only for this machine or a private network (`localhost`, `10.`, `192.168.`, `.local`, a bare LAN name); a hosted API must be `https`. |
| Key var | For a hosted API: the **name** of the environment variable that holds your key, for example `DEEPSEEK_API_KEY`. Not the key. Set the variable in the shell you start roundtable from; a preset fills in its usual name. A local server needs none. |
| Model | Required: the endpoint has no default. Type the id the server knows (`llama3`, `deepseek-chat`, `kimi-k2`...). |
| Effort | Sent as `reasoning_effort` only when you set a pip; a server without that field answers 400, so leave it on default for most local servers. |

What is different from a CLI seat:

- **Billing is the endpoint's.** A hosted API bills per token to the account whose key you
  named; a local server costs your hardware. The tag on the card, `API · pay-per-token` or
  `API · local`, is there so this is never a surprise. The strip shows tokens but no dollar
  figure (the endpoint does not report one), so a dollar cap is refused for it; a token cap works.
- **The key never leaves your environment except to that endpoint.** Roundtable reads the
  variable at call time and sends it as a bearer to the URL you named, with redirects refused.
  It is not stored, not written to the transcript, not shown on the board, not put in an
  error message.
- **The lamp cannot check reachability.** Before the first call the lamp says only whether the
  URL passes the rules and whether the named variable is set. Roundtable sends no probe: a
  probe would mean this server fetching a URL the page named, with the key attached, which a
  hostile web page could abuse. The first real call is the check; a failure shows on the card
  like a CLI's would (`could not reach`, `401`, and so on).
- **Stateless only.** An endpoint keeps no thread, so `memory: resume` is refused when an
  endpoint sits at the table. Stateless is the default and the cheaper mode anyway.
- **One pool per host.** Two seats on `localhost:11434` share a pool; a seat on DeepSeek has
  its own. A host that fails (wrong key, no credit, nothing listening) benches only its own seats.
  The token cap, though, is per vendor: one cap covers every endpoint seat at the table.
- **No tools are offered** in the request. A reply that carries `tool_calls` anyway is treated
  like a CLI reaching for a tool: one re-prompt, then the seat fails for the round.

The chairman can be an endpoint too; its card takes the same fields. The decision record
names the endpoint on each seat's line (`API http://localhost:11434/v1`) and on the chairman's.

## 8. Run a debate without the browser

Agents and scripts can run a debate headless against a running server:

```bash
npm start
```

The server prints a token on its startup line (`roundtable: http://localhost:4747  token
<hex>`). Every request that changes something must carry it, so pass it on:

```bash
npm run debate -- --token <hex> --rounds 1 --note "Your note for round 0" < debate.json
```

`ROUNDTABLE_TOKEN=<hex>` in the environment works too. Without it the server answers 401.

`debate.json` is the same thing the board sends:

```json
{
  "fieldNotes": {
    "decision": "Should we ship sync behind a flag?",
    "options": ["Ship it", "Wait", "Data model only"],
    "constraints": "One developer, three months.",
    "exportTo": "C:\\code\\my-app\\docs\\decisions"
  },
  "seats": [
    { "vendor": "claude", "lens": "risk", "mood": { "preset": "grill" }, "model": "sonnet" },
    { "vendor": "codex", "lens": "cost", "mood": { "preset": "builder" }, "effort": "low" }
  ],
  "chairman": { "vendor": "claude", "model": "sonnet" },
  "options": { "critiqueRounds": 1, "memory": "stateless", "budget": { "claude": { "usd": 1 } } }
}
```

The script answers each gate after a short pause, sends your note at round 0, and prints every
reply, the usage per seat and the quota readings.

## 9. When something goes wrong

Before a debate, each seat card's round lamp says whether that seat can take a call, checked
for free (no model call): green ready, yellow nearly out of quota or unknown, red not installed,
not logged in or out of quota (with the reset time), grey not checked yet. **Open the table**
names any red seat and asks once more before it starts.

| what you see | what to do |
|---|---|
| A seat's lamp is red: "not logged in" | Run the command it names (`claude /login`, `codex login`) in a terminal. |
| A seat's lamp is red: "quota used up" | Wait for the reset it shows, use another vendor for that seat, or seat a second account (step 7). |
| `doctor` says a CLI is not found | Install it (step 2) or fix your PATH; for `agy`, run `agy install`. |
| An API seat's lamp is red: "… is not set in the environment" | Set that variable in the shell you start roundtable from (`set DEEPSEEK_API_KEY=…` on Windows, `export …` elsewhere) and start it again. The board cannot read it for you. |
| An API seat shows "could not reach" or an HTTP status | Nothing listens at that URL (start the local server, check the port and the `/v1` suffix), or the endpoint refused the call (`401` a wrong key, `402`/`429` no credit or a limit, `404` a model id the server does not know). The seat's card quotes the server's own words. |
| A red "out" banner on the board | A vendor ran out of quota or lost its login mid-debate. Its seats are skipped from then on (no call, no tokens). If fewer than two seats are left, the debate stops and the chairman writes from what was said. |
| A seat shows "no reply" in red | Its call failed this round; the card says why in one line, with the CLI's own words under "details". A network failure was already retried once. The others carry on. |
| The verdict failed, or was not written | **Write the verdict with** a vendor of your choice, under the bar. If the chairman's vendor ran out, another one is preselected. |
| "reconnecting" banner | The board lost the server. The debate keeps running there; the board catches up when the connection is back. |
| A seat is "re-prompted" | Its reply broke the format or it tried to use a tool. It gets one retry. |
| "address already in use" | Another server is on that port. Stop it, or start with a different `PORT`. |
| The board says the debate is unknown | The server was restarted. Reopen the address; the board replays from disk and offers Resume. |
| A vendor's remaining quota shows nothing | Antigravity never reports it; type the figure from its credits page. Codex shows only a weekly window on some plans. |

## Where things live

| what | where |
|---|---|
| Debates (transcript, field notes, verdict) | `debates/` in this folder, never committed |
| Measured quota rates | `debates/_calibration.json` |
| Account profiles | `%LOCALAPPDATA%\roundtable\homes` on Windows, `~/Library/Application Support/roundtable/homes` on macOS, `~/.local/share/roundtable/homes` on Linux |
| Decision records you exported | the folder you chose |
