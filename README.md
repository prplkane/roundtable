# Roundtable

Roundtable runs structured decision reviews with multiple AI models. Provide a question,
options and constraints; the models take independent positions, critique the alternatives
and produce a recommendation. You can answer questions, add context and record your own
decision alongside the result.

Use it to compare technical approaches, review a product decision or examine a plan from
different perspectives. The browser interface runs locally, and a JSON command-line client
supports the same workflow for agents and scripts.

Usage statistics describe your own agents' calls in Roundtable and stay on your machine.
Roundtable has no telemetry or analytics service and sends no usage data to its developers.

You can also choose **AgentLink (ACP)** for seats and the chairman, then enter a saved
AgentLink profile name. Roundtable speaks standard ACP to the centrally installed
launcher; AgentLink owns bridge installation and updates. This path uses stateless
memory and has the selected profile's permissions and billing. See
[AgentLink setup and limits](docs/workflow.md#7c-agentlink-acp-profiles-optional).

**Requirements:** Node.js 22 or newer. No runtime dependencies. Live reviews use installed
Claude, Codex or Antigravity CLIs, or an OpenAI-compatible endpoint for a local or hosted model.

**Provider availability:** some vendors or models are unavailable in certain regions. Regional
network paths can also interrupt replies even when login succeeds. Check the
[availability and network guidance](docs/workflow.md#provider-availability-and-network-access)
before your first live review.

**Status:** early preview for developers. Feedback from real workflows is welcome. What does not
work well yet is listed under [Known issues](docs/workflow.md#known-issues).

## How a review works

1. **Define the decision.** Add the alternatives, known facts and constraints. Choose two to
   eight participants, called seats, and give each a perspective such as risk, cost or evidence.
   Seats can use different models or share the same provider.
2. **Gather sources first (optional).** Add a searcher: one extra call, on the provider you
   pick. Its query starts from your question and options; review it or write a custom query.
   Every seat and the chairman then read the same cited sources. Other context and discussion
   answers stay out of research. The searcher never argues or votes.
3. **Collect independent positions.** Each seat answers before seeing the others' responses.
   The board then pauses for your input.
4. **Discuss the differences.** A critique round lets seats review the previous replies and
   revise their positions. Questions appear together so you can answer them in one place.
5. **Review the recommendation.** A designated chairman summarizes the discussion and its
   disagreements. Accept the recommendation or record a different decision, then export the
   record as Markdown.

## Quick start

### Connect your assistant once

Install Roundtable globally, then connect your assistant:

```bash
npm install -g @prplkane/roundtable
roundtable setup --client codex
```

Use `--client claude`, `--client agy`, or `--client all` for the other supported assistants.
Restart the assistant or reload its MCP connections. In any project, ask **"Use Roundtable
to review this decision."** The installed MCP tools start the local board as needed, return
questions to the coordinating assistant, and wait for the chairman's recommendation.
You do not need to open this repository or start a browser for each review.

Setup installs a user-level workflow skill and MCP connection. `roundtable setup --client codex
--check` checks it; `--remove` removes its unchanged entries. After updating Roundtable, rerun
setup to refresh the skill, and use `roundtable server restart` once active reviews finish.
No checkout is needed. To install a local checkout instead, run `npm pack` there and
`npm install -g` with the printed `.tgz` filename; `npm install -g .` can create a link
back to the checkout that breaks when it moves.
See [assistant setup](docs/workflow.md#connect-an-assistant-for-every-project)
for paths, demo mode and troubleshooting, or the [Linux walkthrough](docs/workflow.md#first-connection-on-linux).
For a source snapshot before its npm release, use
`npm install -g https://github.com/prplkane/roundtable/archive/refs/heads/main.tar.gz`.

Interactive `roundtable --help`, `roundtable` and `roundtable fake` show the app's pixel logo
tile in orchid, with the wordmark, a blinking cursor and the installed version beside it, then
the provider CLIs found on this machine in their seat colors. Narrow terminals and terminals
without UTF-8 use a short title; `NO_COLOR=1` disables color. Redirected output, CI, dumb
terminals, MCP and JSON commands omit the decoration.

### Try the demo

The demo uses scripted replies. It needs no provider account and makes no model calls.

```bash
git clone https://github.com/prplkane/roundtable.git
cd roundtable
npm run fake
```

The board opens at [localhost:4748](http://localhost:4748/). If no browser window appears,
open that address yourself. The header identifies the session as **Demo**. Press Ctrl+C in
the terminal to stop the server.

### Run a live review

Install and sign in to a supported CLI, or configure an OpenAI-compatible endpoint using
the [provider setup guide](docs/workflow.md). CLI seats use your existing logins; hosted API
endpoints have separate billing.

**Antigravity and your Google account:** Google's [Antigravity FAQ](https://antigravity.google/docs/faq)
says wrapping `agy` inside third-party applications is not supported under consumer plans,
and that third-party access can lead to suspension or termination of the account. Roundtable
runs `agy -p` in that way. It sends nothing to `agy`, not even a model-list or quota read,
until you acknowledge this once on an Antigravity card; an agent request must send
`options.acknowledgeTermsRisk: true` itself. Check your plan's terms, or use another provider.

```bash
npm run doctor
npm start
```

Open [localhost:4747](http://localhost:4747/). The header identifies the session as **Live**.
Start with two seats and one critique round; see the [first test-drive checklist](docs/workflow.md#a-first-live-test-drive)
for a complete walkthrough. `npm run doctor` checks setup without making model calls.

After updating, stop the running server with Ctrl+C, run `npm start` again and refresh the
page. Refreshing the browser alone does not load an updated server or model list.

## Controls and limits

| Control | Behavior |
| --- | --- |
| Answer questions | Add context before the discussion continues. Your notes, answers your assistant relayed for you, and the assistant's own notes are labelled separately. |
| Finish with verdict | End the discussion and request a recommendation from the completed replies. Available after a usable round. |
| Stop | Cancel the discussion and any active chairman call. Saved replies and reported usage remain. |
| Delete / Clear | Remove finished and interrupted history while protecting running sessions. Exports and local usage statistics are retained. |

Set round, time and provider budget limits before starting. Budget checks run before each
attempt, including retries. If a provider omits token usage while a token cap is set, further
calls to that provider are blocked. Calls already running can exceed estimates; these checks
are not guaranteed billing ceilings.

## Records and privacy

- **Local storage:** history is saved outside the checkout in the OS user-data folder, with
  separate live and demo directories. The board shows the active location under **Local data
  and backups**. Stop the server before copying or moving that folder.
- **Recovery and export:** saved reviews can be reopened after a restart. Interrupted writes
  retain a backup before recovery. Markdown exports include the recommendation, dissent,
  human decision, notes and reported usage.
- **Provider access:** live reviews send relevant notes and replies to the selected providers.
  Local storage and stateless requests do not control provider retention. CLI tool restrictions
  depend on the installed CLI and are not an operating-system sandbox.

Records, exports and browser preferences may contain private context. See [SECURITY.md](SECURITY.md)
for credentials, billing, endpoint restrictions and the local HTTP boundary. If a request
fails, use **Save error log** and keep its reference ID; diagnostic logs stay local and omit
review text, credentials and personal paths.

## Automation and commands

```bash
node src/cli.js agent --help
```

The JSON client provides `status`, `check`, `start`, `wait` and `answer` commands, plus controls
to finish or stop a review. Questions remain paused until answered, explicitly skipped or
their answer window expires (two minutes by default). Silence continues with unknowns intact.
See the [agent workflow](docs/workflow.md#8-run-a-debate-without-the-browser)
for request examples and response fields.

| Command | Purpose |
| --- | --- |
| `npm run fake` | Open the scripted demo on port 4748. |
| `npm start` | Open the live board on port 4747. |
| `npm run doctor` | Check installed providers and available status without model calls. |
| `roundtable setup --client all` | Connect MCP tools and the skill across projects for Codex, Claude and AGY. |
| `roundtable server status` | Inspect the background board; `stop` and `restart` refuse active reviews. |
| `roundtable mcp` | Serve the agent workflow over MCP stdio. |
| `npm run export -- <debate> <folder>` | Export a decision record and update its index. |
| `npm test` | Run offline unit and integration tests, without vendor CLIs or model calls. |

## Documentation

- [User guide](docs/workflow.md): setup, providers, limits, backup, recovery and troubleshooting
- [Security](SECURITY.md): data handling and private vulnerability reporting
- [Contributing](CONTRIBUTING.md): development and review requirements
- [Changelog](CHANGELOG.md): changes by version

## Feedback and support

Ask questions, report bugs or suggest changes through [GitHub Issues](https://github.com/prplkane/roundtable/issues).
For a bug, include your OS, Node and provider CLI versions, steps to reproduce, and the error
reference if available. Exclude credentials and private review content. Support is best effort.
Report security issues through the [private reporting channel](https://github.com/prplkane/roundtable/security/advisories/new).

If Roundtable is useful to you, consider starring the repository.
Maintained by [prplkane](https://github.com/prplkane).

## License

[MIT](LICENSE).
