// One row per vendor. Everything the adapters need to know about a vendor lives here.
//
//  kind        'cli': the vendor's own CLI on the user's subscription (the normal seat);
//              'api': an OpenAI-compatible HTTP endpoint the user names per seat (endpoint.js).
//              Every card and record says which, so a seat's billing is never a surprise.
// Field paths are the CLIs' own JSON output; a change in a CLI's output shows up here first.
//
//  binary      name on PATH (resolved to a real .exe or an npm bin script, no shell)
//  npmBin      fallback when the PATH entry is an npm .cmd shim: run this script with node
//  args        fixed argv for a fresh headless call
//  resume      argv for continuing a session; (id, base) => full argv, where base is `args`
//              (or `stdinArgs` in stream mode); codex replaces the subcommand, the others append
//  model       argv for a model override; (id) => argv (inserted before a trailing "-")
//  effort      argv for a reasoning-effort override; (level) => argv
//  effortLevels  levels the CLI accepts (source named per vendor); the UI offers only these
//  effortInModel  regex: when the chosen model id already carries the level, skip `effort`
//  modelHints  ids the CLI is known to accept, offered as suggestions (free text still allowed)
//  pool        what the vendor's quota is drawn against, shown as the strip's group header
//  promptVia   'stdin' | 'argv-or-stdin' (argv unless the prompt is long)
//  output      'json' (one object) | 'jsonl' (one object per line)
//  paths       dot paths into the parsed output: text, sessionId, usage.*, cost, quota
//  costIsCumulative  true when the CLI reports cost for the whole session on resume
//  cacheSemantics  how the CLI's input figure relates to its cache-read figure: 'subset' (input
//              already includes cached input), 'additive' (input is the uncached part only), or
//              'unknown'. Roundtable's `usage.input` always means uncached input (common.js
//              normaliseUsage), so a 'subset' vendor has cacheRead taken off.
//  quota       'per-call' (rides on each reply) | 'app-server' (separate read) | null
//  usageUrl    the vendor's own usage page, shown in the strip when no live figure exists
//  colour      seat colour name from the signature-design accent table
//  readOnly    the flag that keeps the agent from touching files (for the README)
//  home        { env }: the environment variable that moves the CLI's local state directory
//              (settings, history, memories, credentials). Used only for a seat with a named
//              `account` profile, whose directory lives under the OS user-data dir (spawn.js
//              profileHome) and which the user logs in themselves. Nothing is ever copied into
//              it. Without a profile the seat shares the CLI's real state directory.
//  usedTools   (parsed output) => boolean: did the agent reach for a tool or run a command.
//              Roundtable is for thinking, not doing; the engine treats tool use as a contract
//              violation (one re-prompt, then the seat fails for the round). For jsonl output
//              it receives the event list, for json output the object.
//  isolation   what keeps an instance from inheriting shared context.
//              Every instance also runs in its own empty working directory (store.seatDir), so
//              no project file, project memory or project entry is shared between instances.

// Codex features that hand the model a tool (codex features list, CLI 0.162.1). Unknown names
// are ignored by the CLI, so a renamed feature degrades to the wrapper's after-the-fact check.
const CODEX_TOOL_FEATURES = ['shell_tool', 'unified_exec', 'apps', 'plugins', 'browser_use', 'browser_use_external',
  'computer_use', 'in_app_browser', 'image_generation', 'view_image', 'multi_agent', 'skill_search', 'tool_suggest',
  'goals', 'sleep_tool', 'hooks'];
export const CODEX_NO_TOOLS = ['-c', 'mcp_servers={}', '-c', 'web_search="disabled"',
  ...CODEX_TOOL_FEATURES.flatMap((f) => ['-c', `features.${f}=false`])];

export const ADAPTERS = {
  claude: {
    kind: 'cli',
    label: 'Claude',
    binary: 'claude',
    // stream-json (not json) so the rate_limit_event line arrives; --verbose is required for it.
    // The final "result" line has the same shape the json mode printed.
    // --setting-sources local: only settings in the (empty) working directory are loaded, so the
    // user-level settings.json (hooks, output style, plugins) stays out.
    // --strict-mcp-config with no --mcp-config: no MCP server at all. Without it the user's
    // claude.ai connectors still reached the seat (8 tools despite --tools "") and their schemas
    // cost about 3.4k input tokens per call.
    // Not --exclude-dynamic-system-prompt-sections: it helps only identical prompts. In a real
    // two-seat, two-round debate it cut the shared cached part from 2,156 to 1,230 tokens and
    // raised the cost by about 15%.
    args: ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'plan',
      '--tools', '', '--disable-slash-commands', '--setting-sources', 'local', '--strict-mcp-config'],
    // `--bare` would also skip CLAUDE.md discovery and auto-memory, but it skips keychain reads
    // too and can report "not logged in", so isolation is by working directory.
    home: { env: 'CLAUDE_CONFIG_DIR' },
    isolation: 'empty cwd per instance, --setting-sources local; own CLAUDE_CONFIG_DIR only for a seat with a named account profile; --bare unusable with keychain login',
    resume: (id, base) => [...base, '--resume', id],
    model: (m) => ['--model', m],
    effort: (e) => ['--effort', e],
    effortLevels: ['low', 'medium', 'high'], // `claude --help`: "--effort <level>"
    modelHints: ['opus', 'sonnet', 'haiku'],  // aliases `--model` accepts
    pool: 'Anthropic subscription',
    promptVia: 'stdin',
    output: 'jsonl',
    paths: {
      text: ['result', 'result'],
      sessionId: ['result', 'session_id'],
      input: ['result', 'usage.input_tokens'],
      cacheRead: ['result', 'usage.cache_read_input_tokens'],
      cacheWrite: ['result', 'usage.cache_creation_input_tokens'],
      output: ['result', 'usage.output_tokens'],
      thinking: ['result', 'usage.output_tokens_details.thinking_tokens'],
      cost: ['result', 'total_cost_usd'],
      quota: ['rate_limit_event', 'rate_limit_info'],
      isError: ['result', 'is_error'], // a usage limit or a lapsed login comes back as an error result
    },
    costIsCumulative: true,
    cacheSemantics: 'additive', // input_tokens is often 2 next to thousands of cache reads
    // a tool_use content block in any assistant message, or more than one turn in the result
    usedTools: (events) => events.some((e) => e.type === 'assistant' && (e.message?.content || []).some((c) => c?.type === 'tool_use'))
      || events.some((e) => e.type === 'result' && typeof e.num_turns === 'number' && e.num_turns > 1),
    quota: 'per-call', // see quota.js
    usageUrl: 'https://claude.ai/settings/usage',
    colour: 'rust',
    readOnly: '--permission-mode plan',
  },

  codex: {
    kind: 'cli',
    label: 'Codex',
    binary: 'codex',
    npmBin: ['@openai/codex', 'bin/codex.js'],
    // project_doc_max_bytes=0 stops AGENTS.md discovery (global ~/.codex/AGENTS.md included).
    // NO_TOOLS: no MCP server (the user's config enables node_repl, which runs JavaScript outside
    // the shell sandbox), no web search, and no tool-bearing feature, shell included, so a seat
    // has nothing to call before the wrapper ever looks. All as -c so resume takes them too.
    args: ['exec', '--json', '--sandbox', 'read-only', '--skip-git-repo-check', '-c', 'project_doc_max_bytes=0', ...CODEX_NO_TOOLS, '-'],
    // `exec resume` does not accept --sandbox; the same policy goes through -c.
    resume: (id) => ['exec', 'resume', id, '--json', '--skip-git-repo-check',
      '-c', 'sandbox_mode="read-only"', '-c', 'project_doc_max_bytes=0', ...CODEX_NO_TOOLS, '-'],
    home: { env: 'CODEX_HOME' },
    isolation: 'empty cwd per instance, -c project_doc_max_bytes=0; own CODEX_HOME only for a seat with a named account profile',
    model: (m) => ['-m', m],
    // Same path as the sandbox policy on resume: one argv element, TOML-quoted.
    effort: (e) => ['-c', `model_reasoning_effort="${e}"`],
    effortLevels: ['low', 'medium', 'high', 'xhigh'], // replaced by enabled-reasoning-efforts from ~/.codex/config.toml (catalogue.js)
    modelHints: [], // filled from `model =` in ~/.codex/config.toml; the CLI has no list command
    pool: 'ChatGPT subscription',
    promptVia: 'stdin',
    output: 'jsonl',
    // jsonl: [event type that carries the value, path inside it, optional filter]
    paths: {
      text: ['item.completed', 'item.text', { 'item.type': 'agent_message' }],
      sessionId: ['thread.started', 'thread_id'],
      input: ['turn.completed', 'usage.input_tokens'],
      cacheRead: ['turn.completed', 'usage.cached_input_tokens'],
      cacheWrite: ['turn.completed', 'usage.cache_write_input_tokens'],
      output: ['turn.completed', 'usage.output_tokens'],
      thinking: ['turn.completed', 'usage.reasoning_output_tokens'],
      cost: null, // not reported headless
      quota: null, // not in exec --json; read separately, see quota.js
    },
    costIsCumulative: false,
    cacheSemantics: 'subset', // the Codex protocol computes uncached input as input - cached
    // any completed item that is not the message or its reasoning: command_execution, file
    // changes, MCP tool calls, web searches
    usedTools: (events) => events.some((e) => /^item\.(completed|started)$/.test(e.type) && e.item?.type && !['agent_message', 'reasoning'].includes(e.item.type)),
    quota: 'app-server',
    usageUrl: 'https://chatgpt.com/settings/usage',
    colour: 'olive',
    readOnly: '--sandbox read-only',
  },

  agy: {
    kind: 'cli',
    label: 'Antigravity',
    binary: 'agy',
    args: ['--output-format', 'json', '--mode', 'plan', '--disable-slash-commands'],
    home: null, // no documented environment variable for agy's state directory
    isolation: 'empty cwd per instance; no flag found to skip GEMINI.md discovery and no state-directory variable',
    resume: (id, base) => [...base, '--conversation', id],
    model: (m) => ['--model', m],
    effort: (e) => ['--effort', e],
    effortLevels: ['low', 'medium', 'high'], // `agy --help`: "--effort (low|medium|high)"
    effortInModel: /-(low|medium|high)$/,    // `agy models` ids end in the level: gemini-4-argon-high
    modelHints: [], // filled from `agy models` (catalogue.js)
    pool: 'Google AI credits (every id in the agy catalogue, Claude and GPT-OSS included, draws from it)',
    // `-p=<prompt>` on argv; above ARGV_LIMIT chars switch to stream-json on stdin
    // (Windows command lines cap at 32k).
    promptVia: 'argv-or-stdin',
    argvFlag: '-p=',
    stdinArgs: ['--output-format', 'stream-json', '--input-format', 'stream-json',
      '--mode', 'plan', '--disable-slash-commands'],
    stdinWrap: (prompt) => JSON.stringify({ event: 'user', message: { role: 'user', content: prompt } }) + '\n',
    output: 'json',
    paths: {
      text: 'response',
      sessionId: 'conversation_id',
      input: 'usage.input_tokens',
      cacheRead: 'usage.cache_read_tokens',
      cacheWrite: null,
      output: 'usage.output_tokens',
      thinking: 'usage.thinking_tokens',
      cost: null, // not reported headless
      quota: null, // /usage is an interactive panel only
    },
    costIsCumulative: false,
    cacheSemantics: 'unknown', // two identical 12k prompts reported no cache read
    // more than one turn, or a tool the headless mode had to deny
    usedTools: (obj) => (typeof obj?.num_turns === 'number' && obj.num_turns > 1) || (Array.isArray(obj?.denied_actions) && obj.denied_actions.length > 0),
    quota: null,
    usageUrl: 'https://antigravity.google/g1-activity', // the CLI's own "AI credits activity" link
    colour: 'teal',
    readOnly: '--mode plan',
  },
  // An OpenAI-compatible endpoint: self-hosted (Ollama, LM Studio, vLLM, llama.cpp) or a
  // pay-per-token API (DeepSeek, Moonshot, OpenAI). No binary, no argv: endpoint.js speaks HTTP.
  // The base URL, the model and the NAME of the key's environment variable are seat fields; the
  // pool is one per endpoint host (seats.js hostKey), so one host's failure benches only itself.
  api: {
    kind: 'api',
    label: 'API endpoint',
    binary: null, args: [], resume: null, model: null,
    home: null,
    isolation: 'stateless HTTP requests; Roundtable does not manage a remote thread or control provider retention',
    effort: null, // reasoning_effort in the request body, sent only when the seat sets a level
    effortLevels: ['low', 'medium', 'high'], // OpenAI reasoning_effort values; a server that lacks the field answers 400
    modelHints: [], // the user names the model; the board offers no list for an arbitrary endpoint
    pool: 'the endpoint itself: pay-per-token on a hosted API, your own hardware when self-hosted',
    promptVia: null,
    output: 'json',
    paths: { cost: null, quota: null }, // nothing is priced, so a dollar cap is refused (validate.js)
    costIsCumulative: false,
    cacheSemantics: 'subset', // prompt_tokens includes the cached part (OpenAI cached_tokens, DeepSeek prompt_cache_hit_tokens)
    usedTools: null, // endpoint.js: any tool_calls in the reply (no tools are offered)
    quota: null,
    usageUrl: null,
    colour: 'steel',
    readOnly: 'no tools in the request',
  },
};

// A vendor whose seats draw on separate pools per account: a CLI with a state directory
// (named login profiles), or an endpoint vendor (one pool per host). Pool keys (seats.poolKey)
// carry the account only for these.
export const poolsByAccount = (a) => !!a?.home || a?.kind === 'api';

export const ARGV_LIMIT = 24000;
