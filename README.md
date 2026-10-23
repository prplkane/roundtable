# Roundtable

A small local tool that runs a bounded debate between the coding agents you already pay for,
Claude, Codex and Antigravity, on their subscriptions. You write the question; the agents argue
in rounds, sceptical by default; you step in where it matters; a chairman writes the verdict;
and the decision lands in your codebase as a plain markdown record your agents can read.

No API key needed. No framework. No dependencies. Node 22 or newer.

The CLIs are the main path. An OpenAI-compatible endpoint can also take a seat (Ollama or
another local server, or a pay-per-token API such as DeepSeek or Moonshot); every card and
every record says which kind a seat is, so a seat that bills per token is never mistaken for
one on a plan. See `docs/workflow.md`, "An API endpoint as a seat".

## Start here

With Node 22 or newer, no clone needed:

```bash
npx @prplkane/roundtable fake     # the board with scripted seats, nothing spent
npx @prplkane/roundtable          # the real board, opened in your browser
npx @prplkane/roundtable doctor   # what this machine can seat
```

From a clone:

```bash
npm test          # runs without any CLI installed
npm run doctor    # what this machine can seat, nothing spent
npm run fake      # the board with scripted seats: http://localhost:4748
npm start         # the real board: http://localhost:4747, opened in your browser
```

Both board commands take `--port <n>` and `--no-open`.

**[docs/workflow.md](docs/workflow.md)** is the user guide: installing and logging in to each
vendor, opening the board, writing field notes, seating agents, taking part in a debate,
keeping cost low, exporting decisions into a codebase, second accounts, headless use, and
troubleshooting.

## What it does

- **Seats are independent agents.** Any number per vendor, each with its own session, its own
  empty working folder, a unique lens, a mood (`grill` by default), a model and a thinking
  level. Seats see each other only by lens, never by vendor.
- **Rounds with rules.** A blind first round, critique rounds with a fixed reply format, one
  retry for a broken reply, and stops for consensus, all-pass, no movement, round limit, wall
  clock, budget, or you.
- **You are a participant, not a courier.** The board always waits after the blind round, stops
  for any question a seat asks you, and otherwise auto-continues unless you touch it.
- **Cost you can see.** Per vendor account: the live remaining window where the vendor reports
  one, the projected draw of each seat for this debate, and caps that stop a debate before it
  crosses them. Rounds are stateless by default, so cost per round stays flat.
- **Decisions you can keep.** `npm run export` writes a decision record and an index into any
  folder of a codebase.
- **No tools, no edits.** Claude seats run with no tool at all (no built-in tool, no MCP
  server). Codex seats run with the sandbox read-only, no MCP server, no web search and no
  tool-bearing feature, shell included. Antigravity seats run in plan mode, which denies what
  they request; its MCP servers cannot be switched off by flag. Any tool use a CLI still reports
  fails the seat for the round, and the chairman is checked the same way. Details per CLI in
  `SECURITY.md`.

## Commands

| command | does |
|---|---|
| `npm start` | serves the board on port 4747 (`PORT` to change) |
| `npm run fake` | the same board with scripted seats on port 4748, no tokens |
| `npm run doctor` | per vendor: binary, version, models, efforts, live quota; `-- --live` adds one tiny call each; `-- --profile <name>` prints how to log a second account in |
| `npm run debate -- --token <hex> --rounds 1 < debate.json` | one debate headless against a running server (the token is on its startup line) |
| `npm run export -- <debate> <folder>` | writes the decision record and refreshes the folder's index |
| `npm test` | unit and integration tests, no CLI needed |

## Documents

| file | for |
|---|---|
| [docs/workflow.md](docs/workflow.md) | using it, step by step |
| [SECURITY.md](SECURITY.md) | what it touches on your machine, credentials, billing, reporting a problem |
| [CONTRIBUTING.md](CONTRIBUTING.md) | how changes are made and merged, including by AI agents |
| [CHANGELOG.md](CHANGELOG.md) | what changed per version |

## Layout

- `src/adapters/` one file per CLI, plus `config.js`, the table of binaries, flags and JSON paths
- `src/engine.js` the round engine; `src/prompts.js` everything a seat is told; `src/contract.js` the reply format
- `src/server.js` the local server, gates, replay and resume; `src/ui/` the board
- `src/estimate.js` projection and calibration; `src/export.js` decision records; `src/doctor.js` the doctor
- `scripts/` the headless debate and export commands; `test/` unit and integration tests
- `debates/` every debate's transcript, field notes and verdict, never committed

## Licence

MIT, see [LICENSE](LICENSE).
