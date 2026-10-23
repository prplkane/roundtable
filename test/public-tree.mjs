// The public tree's allowlist, shared by test/public-tree.test.js and the dev-only export.
// Published, in the public repository and in the npm package where package.json says so.
export const PUBLIC = [
  /^\.github\/(CODEOWNERS|dependabot\.yml|pull_request_template\.md|workflows\/[\w.-]+\.yml)$/,
  /^\.gitignore$/,
  /^(AGENTS|CHANGELOG|CONTRIBUTING|README|SECURITY)\.md$/,
  /^LICENSE$/,
  /^package\.json$/,
  /^docs\/workflow\.md$/,
  /^scripts\/[\w.-]+\.mjs$/,
  /^src\/[\w./-]+\.(js|html|css|svg)$/,
  /^test\/[\w./-]+\.(js|mjs)$/,
];
// The development repository only; never exported (internal/export-public.mjs).
export const DEV_ONLY = [/^internal\//];
