# Roundtable

Local decision reviews with Claude, Codex and Antigravity. Give each seat a perspective,
compare blind positions and critique rounds, then accept or override the chairman's
recommendation. Export the discussion and your decision as Markdown.

Uses your existing CLI logins. Node 22 or newer; no runtime dependencies. Optional
OpenAI-compatible endpoints support local models and hosted APIs with separate billing.

## Quick start

Try the demo from a local checkout. It uses scripted replies and makes no model calls.

```bash
git clone https://github.com/prplkane/roundtable.git
cd roundtable
npm test
npm run fake -- --no-open
```

Open [localhost:4748](http://localhost:4748/). For a live review, install and log in to at
least one supported CLI, then run:

```bash
npm run doctor
npm start -- --no-open
```

Open [localhost:4747](http://localhost:4747/). The header distinguishes **Demo** from **Live**.
First use starts with two seats and one critique round; both seats can use the same vendor.
See the [user guide](docs/workflow.md) for provider setup and a complete walkthrough.

Without a checkout, use `npx @prplkane/roundtable fake` or `npx @prplkane/roundtable`.
These commands use the published npm version, which may lag the repository. They accept
`--port <n>` and `--no-open`; checkout commands use the `PORT` environment variable.

## The review workflow

- **Independent positions.** Two to eight seats, each with its own lens, mood, model and
  effort. The first round is blind; later rounds compare the replies.
- **Human input.** The board waits after the first round and when a seat asks a question.
  Add a note, continue, or stop. The chairman recommends; you make the final choice.
- **Bounded execution.** Round and time limits, usage estimates, and budget checks before
  each provider attempt, including retries. Missing token usage blocks further calls to
  that vendor when a token cap is set. Running calls can exceed estimates.
- **Recoverable records.** Reopen saved reviews after a restart. Interrupted final writes
  retain an exact backup before recovery; corrupt completed records require repair.
- **Markdown exports.** Keep the recommendation, dissent, human decision, notes and reported
  usage together in a decision record, with an index for your codebase.

## Data and security

The server listens on loopback. The page loads locally; live reviews send your notes and
relevant replies to the selected providers. Stateless requests do not control provider
retention. CLI tool restrictions depend on the installed CLI and are not an OS sandbox.

Live records default to `debates/` in the installation folder; demo records use
`debates-fake/`. Set `ROUNDTABLE_DEBATES_DIR` to keep a stable data location. **Local data
and backups** on the setup screen shows the active folder. Stop the server before copying
that entire folder for backup. Records and browser preferences may contain private context.

Read [SECURITY.md](SECURITY.md) for credentials, billing, endpoint restrictions and the local
HTTP boundary. Budget checks use estimates and reported usage; they are not guaranteed
billing ceilings.

For a first live run, follow the [test-drive steps](docs/workflow.md#a-first-live-test-drive).
If something fails, use **Save error log** and note the reference ID. Diagnostic logs stay
local and exclude review text, credentials and personal paths.

## Commands

| Command | Purpose |
| --- | --- |
| `npm start` | Live board on port 4747; opens a browser from an interactive terminal |
| `npm run fake` | Scripted demo on port 4748 |
| `npm run doctor` | Inspect installed providers, versions and available status without model calls |
| `npm run doctor -- --live` | Add one small model call per CLI provider |
| `npm run debate -- --token <hex> --rounds 1 < debate.json` | Run a review against an existing server without the board |
| `npm run export -- <debate> <folder>` | Export a decision record and update its index |
| `npm test` | Offline unit and integration tests; no vendor CLI or model call |

## Documentation

- [User guide](docs/workflow.md): setup, limits, backup, recovery, profiles and troubleshooting
- [Security](SECURITY.md): data handling, restrictions and private vulnerability reporting
- [Contributing](CONTRIBUTING.md): development, tests and review requirements
- [Changelog](CHANGELOG.md): changes by version

## Licence

[MIT](LICENSE).
