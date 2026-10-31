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
//              violation that stops that seat for the review. For jsonl output
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
const CODEX_ISOLATION = ['--ignore-user-config', '--ignore-rules', '--strict-config'];
// agy's permission rules accept only command, read_file, write_file, read_url, mcp, execute_url and
// unsandboxed (its rule pattern, CLI 1.4.11). Its search_web tool has no rule and cannot be denied
// here: a "search_web(*)" entry is ignored without a warning. The reported-tool guard stops it.
const AGY_DENY_TOOLS = ['--settings', JSON.stringify({ toolPermission: 'strict', permissions: {
  allow: [], ask: [], deny: ['read_file(*)', 'write_file(*)', 'read_url(*)', 'execute_url(*)', 'command(*)', 'mcp(*)'],
} })];
const toolBlock = (block) => ['tool_use', 'server_tool_use', 'mcp_tool_use'].includes(block?.type);

// The searcher (research.js) on one vendor's CLI: web search on, every other tool still off.
//   args(argv)       the fresh-call argv with exactly the search tool allowed; throws when the
//                    flag it rewrites has moved, so a CLI change cannot widen what the call may do
//   searchIds(e)     ids of the search operations one event reports (events may repeat an id)
//   foreignTool      the usedTools check with only the search tool allowed: anything else stops it
//   reported(events) searches the CLI counted itself, when it does
//   usage(events)    token counters that include the search's own model calls, when the CLI
//                    reports those apart from the reply's
const moved = (label) => Object.assign(new Error(`Research needs the supported ${label} restriction flags.`), { code: 'RESEARCH_INVALID' });
const CLAUDE_SEARCH = 'WebSearch';
const claudeBlocks = (events) => events.flatMap((e) => e.type === 'assistant' && Array.isArray(e.message?.content) ? e.message.content.filter(toolBlock)
  : e.type === 'stream_event' && toolBlock(e.event?.content_block) ? [e.event.content_block] : []);
const claudeSearch = (b) => b.type === 'tool_use' && b.name === CLAUDE_SEARCH;
const claudeResult = (events) => events.findLast((e) => e.type === 'result');
const codexSearch = (e) => /^item\.(started|updated|completed)$/.test(e?.type) && e.item?.type === 'web_search';
// any completed item that is not the message or its reasoning: command_execution, file
// changes, MCP tool calls, web searches
const codexTools = (events) => events.some((e) => /^item\.(completed|started|updated)$/.test(e.type) && e.item?.type && !['agent_message', 'reasoning'].includes(e.item.type));
const AGY_SEARCH = 'search_web';
const agyAttempts = (obj) => (typeof obj?.num_turns === 'number' && obj.num_turns > 1) || (Array.isArray(obj?.denied_actions) && obj.denied_actions.length > 0);

// The tools one agy stream event reports, by name. agy 1.4 sends each tool step as
// {event:"step_update", step_update:{step_type:"tool", tool_name, tool_info:{name}}}; earlier
// builds put tool_info or subagent_info on the event itself or under `step`. Fails closed: a tool
// step without a name is '?', and a subagent is 'subagent', so neither can pass as a search.
function agyToolNames(event) {
  if (!event || typeof event !== 'object') return [];
  const names = [];
  for (const s of [event, event.step, event.step_update]) {
    if (!s || typeof s !== 'object') continue;
    if (s.subagent_info != null) names.push('subagent');
    if (s.tool_info == null && s.tool_name == null && s.step_type !== 'tool') continue;
    const own = new Set([s.tool_info?.name, s.tool_name].filter((n) => typeof n === 'string' && n)); // both, if they disagree
    names.push(...(own.size ? own : ['?']));
  }
  return names;
}

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
    // --disallowedTools "mcp__*": `--tools` does not reach MCP tools (CLI reference), so any MCP
    // tool that still loads, a managed server for one, is removed from the context too.
    // Not --exclude-dynamic-system-prompt-sections: it helps only identical prompts. In a real
    // two-seat, two-round debate it cut the shared cached part from 2,156 to 1,230 tokens and
    // raised the cost by about 15%.
    args: ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'plan',
      '--tools', '', '--disallowedTools', 'mcp__*', '--disable-slash-commands', '--setting-sources', 'local', '--strict-mcp-config', '--safe-mode', '--permission-prompts', 'none'],
    // `--bare` would also skip CLAUDE.md discovery and auto-memory, but it skips keychain reads
    // too and can report "not logged in". Safe mode preserves login while ignoring customizations.
    home: { env: 'CLAUDE_CONFIG_DIR' },
    isolation: 'empty cwd per instance; safe mode skips memory, hooks, plugins and customizations while preserving login; no built-in tools or MCP servers',
    resume: (id, base) => [...base, '--resume', id],
    model: (m) => ['--model', m],
    effort: (e) => ['--effort', e],
    effortLevels: ['low', 'medium', 'high'], // `claude --help`: "--effort <level>"
    // Request no extended-thinking budget for hidden-mood seats, which select Haiku 4.5.
    minimalEnv: { MAX_THINKING_TOKENS: '0' },
    modelHints: ['opus', 'sonnet', 'claude-haiku-4-5'],  // use the explicit Haiku model id
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
    usedTools: (events) => claudeBlocks(events).length > 0
      || events.some((e) => e.type === 'result' && typeof e.num_turns === 'number' && e.num_turns > 1),
    // WebSearch alone. Plan mode with nobody to answer a prompt denies it unless it is also
    // pre-approved. Each search is a turn, so the turn count is no signal here; the CLI counts the
    // searches per model (modelUsage), and the search's own Haiku call is reported only there.
    research: {
      args: (args) => {
        const i = args.indexOf('--tools');
        if (i < 0 || args[i + 1] !== '') throw moved('Claude');
        return [...args.slice(0, i), '--tools', CLAUDE_SEARCH, '--allowedTools', CLAUDE_SEARCH, ...args.slice(i + 2)];
      },
      searchIds: (e) => claudeBlocks([e]).filter(claudeSearch).map((b) => b.id),
      foreignTool: (events) => claudeBlocks(events).some((b) => !claudeSearch(b))
        || events.some((e) => e.type === 'result' && Array.isArray(e.permission_denials) && e.permission_denials.some((d) => d?.tool_name !== CLAUDE_SEARCH)),
      reported: (events) => {
        const models = Object.values(claudeResult(events)?.modelUsage || {});
        return models.length && models.every((m) => Number.isSafeInteger(m?.webSearchRequests)) ? models.reduce((n, m) => n + m.webSearchRequests, 0) : undefined;
      },
      usage: (events) => {
        const models = Object.values(claudeResult(events)?.modelUsage || {});
        // a missing required field makes NaN, which usageCounters refuses; thinking is a breakdown
        const sum = (k, optional = false) => models.reduce((n, m) => n + (optional ? m?.[k] ?? 0 : m?.[k]), 0);
        return models.length ? { input: sum('inputTokens'), output: sum('outputTokens'), cacheRead: sum('cacheReadInputTokens'), cacheWrite: sum('cacheCreationInputTokens'), thinking: sum('thinkingTokens', true) } : null;
      },
    },
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
    args: ['exec', '--json', '--sandbox', 'read-only', '--skip-git-repo-check', ...CODEX_ISOLATION, '-c', 'project_doc_max_bytes=0', ...CODEX_NO_TOOLS, '-'],
    // `exec resume` does not accept --sandbox; the same policy goes through -c.
    resume: (id) => ['exec', 'resume', id, '--json', '--skip-git-repo-check',
      ...CODEX_ISOLATION, '-c', 'sandbox_mode="read-only"', '-c', 'project_doc_max_bytes=0', ...CODEX_NO_TOOLS, '-'],
    home: { env: 'CODEX_HOME' },
    isolation: 'empty cwd per instance; user config and rules ignored, strict config, read-only sandbox, tool feature restrictions and reported-tool guard',
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
    usedTools: codexTools,
    // web_search flipped from "disabled" to "live"; one web_search item spans started, updated
    // and completed events with one id.
    research: {
      args: (args) => {
        const i = args.indexOf('web_search="disabled"');
        if (i < 0) throw moved('Codex');
        return [...args.slice(0, i), 'web_search="live"', ...args.slice(i + 1)];
      },
      searchIds: (e) => (codexSearch(e) ? [e.item.id] : []),
      foreignTool: (events) => codexTools(events.filter((e) => !codexSearch(e))),
    },
    quota: 'app-server',
    usageUrl: 'https://chatgpt.com/settings/usage',
    colour: 'olive',
    readOnly: '--sandbox read-only',
  },

  agy: {
    kind: 'cli',
    label: 'Antigravity',
    binary: 'agy',
    // --mode plan is kept for a CLI that honours it, but 1.4.11 ignores it while slash commands
    // are off ("--mode plan has no effect while slash command expansion is disabled"). Slash
    // commands stay off: a field note or a seat's reply must not expand into a skill. What keeps
    // an agy seat read-only is the deny list and the reported-tool guard, not plan mode.
    args: ['--output-format', 'json', '--mode', 'plan', '--disable-slash-commands', ...AGY_DENY_TOOLS],
    limitedIsolation: true,
    home: null, // no documented environment variable for agy's state directory
    isolation: 'limited isolation: session settings deny documented tools; MCP discovery and shared customization loading cannot be disabled',
    resume: (id, base) => [...base, '--conversation', id],
    model: (m) => ['--model', m],
    effort: (e) => ['--effort', e],
    effortLevels: ['low', 'medium', 'high'], // `agy --help`: "--effort (low|medium|high)"
    effortInModel: /-(low|medium|high)$/,    // `agy models` ids end in the level: gemini-4-argon-high
    modelHints: [], // filled from `agy models` (catalogue.js)
    pool: 'Google AI credits (every id in the agy catalogue, Claude and GPT-OSS included, draws from it)',
    // Always stream stdin: prompt text stays off the process command line and intermediate
    // tool events are available even when the final result omits them.
    promptVia: 'stdin',
    argvFlag: '-p=',
    stdinArgs: ['--output-format', 'stream-json', '--input-format', 'stream-json',
      '--mode', 'plan', '--disable-slash-commands', ...AGY_DENY_TOOLS],
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
    // more than one turn, a tool the headless mode had to deny, or any reported tool step
    usedTools: (obj, events = []) => agyAttempts(obj) || events.some((e) => agyToolNames(e).length > 0),
    // search_web is always on (no permission rule reaches it, see AGY_DENY_TOOLS), so the argv
    // stays the seat's. A tool step's ACTIVE and DONE updates share its step_index.
    research: {
      args: (args) => args,
      searchIds: (e) => {
        const names = agyToolNames(e), i = e?.step_update?.step_index;
        return names.length === 1 && names[0] === AGY_SEARCH ? [Number.isSafeInteger(i) ? `step-${i}` : null] : [];
      },
      foreignTool: (obj, events = []) => agyAttempts(obj) || events.some((e) => agyToolNames(e).some((n) => n !== AGY_SEARCH)),
    },
    quota: null,
    usageUrl: 'https://antigravity.google/g1-activity', // the CLI's own "AI credits activity" link
    colour: 'teal',
    readOnly: 'session deny rules for files, commands, URLs and MCP, plus the reported-tool guard (--mode plan is ignored while slash commands are off)',
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
