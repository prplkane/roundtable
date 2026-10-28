# Roundtable

Roundtable runs structured decision reviews with multiple AI models. Provide a question,
options and constraints; the models take independent positions, critique the alternatives
and produce a recommendation. You can answer questions, add context and record your own
decision alongside the result.

Use it to compare technical approaches, review a product decision or examine a plan from
different perspectives. The browser interface runs locally, and a JSON command-line client
supports the same workflow for agents and scripts.

**Requirements:** Node.js 22 or newer. No runtime dependencies. Live reviews use installed
Claude, Codex or Antigravity CLIs, or an OpenAI-compatible endpoint for a local or hosted model.

**Status:** early preview for developers. Feedback from real workflows is welcome.

## How a review works

1. **Define the decision.** Add the alternatives, known facts and constraints. Choose two to
   eight participants, called seats, and give each a perspective such as risk, cost or evidence.
   Seats can use different models or share the same provider.
2. **Collect independent positions.** Each seat answers before seeing the others' responses.
   The board then pauses for your input.
3. **Discuss the differences.** A critique round lets seats review the previous replies and
   revise their positions. Questions appear together so you can answer them in one place.
4. **Review the recommendation.** A designated chairman summarizes the discussion and its
   disagreements. Accept the recommendation or record a different decision, then export the
   record as Markdown.

## Quick start

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

```bash
npm run doctor
npm start
```

Open [localhost:4747](http://localhost:4747/). The header identifies the session as **Live**.
Start with two seats and one critique round; see the [first test-drive checklist](docs/workflow.md#a-first-live-test-drive)
for a complete walkthrough. `npm run doctor` checks setup without making model calls.

## Controls and limits

| Control | Behavior |
| --- | --- |
| Answer questions | Add context before the discussion continues. Agent notes and your notes are labelled separately. |
| Finish with verdict | End the discussion and request a recommendation from the completed replies. Available after a usable round. |
| Stop | Cancel the discussion and any active chairman call. Saved replies and reported usage remain. |
| Delete / Clear finished | Remove inactive history while protecting running sessions. Exports and usage statistics are retained. |

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
the time limit expires. See the [agent workflow](docs/workflow.md#8-run-a-debate-without-the-browser)
for request examples and response fields.

| Command | Purpose |
| --- | --- |
| `npm run fake` | Open the scripted demo on port 4748. |
| `npm start` | Open the live board on port 4747. |
| `npm run doctor` | Check installed providers and available status without model calls. |
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
