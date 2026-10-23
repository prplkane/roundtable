# Changelog

## 0.3.0

First public release.

- **Debates between the coding agents you already pay for.** Claude, Codex and Antigravity seats
  on their own subscriptions, any number per vendor, each with its own lens, mood, model and
  thinking level. A blind first round, critique rounds with a fixed reply format, stops for
  consensus, no movement, round limit, wall clock, budget or you.
- **You take part.** The board waits after the blind round, stops for any question a seat asks
  you, and carries your notes into every later round.
- **A sceptical chairman.** A fresh session writes the verdict: a recommendation, the dissent,
  kill criteria and open questions. It recommends; you accept an option on the board.
- **Cost you can see.** Per account: the live remaining quota where the vendor reports one, the
  projected draw per seat, and token or dollar caps that stop a debate before it crosses them.
- **Failures you can read.** Each seat card has a lamp (ready, nearly used, out, not checked)
  from a free pre-flight check. A used-up quota or a lost login benches that account for the
  debate instead of failing every round.
- **API endpoint seats.** An OpenAI-compatible endpoint can take a seat: a local server (Ollama,
  LM Studio, vLLM, llama.cpp) or a pay-per-token API (DeepSeek, Moonshot, OpenAI). Every card and
  record says whether a seat is a CLI on a subscription or an API.
- **Decision records.** Export a debate as a markdown record and an index into any codebase, so
  your coding agents can read what was decided.
- **`npx @prplkane/roundtable`** starts the board and opens it in your browser; `doctor` shows
  what your machine can seat.
