// Human-facing decoration only. Never add it to MCP, JSON commands or redirected output.
const LOGO = String.raw`
         o       o
      .-------------.
   o /               \ o   R O U N D T A B L E
     \               /     Local decision reviews
      '-------------'
         o       o
`;

export function terminalBanner({ isTTY = process.stdout.isTTY, columns = process.stdout.columns ?? 80, env = process.env } = {}) {
  if (!isTTY || env.CI || env.TERM === 'dumb') return '';
  const art = columns < 52 ? '\nRoundtable\n' : LOGO;
  return env.NO_COLOR ? `${art}\n` : `\x1b[36m${art}\x1b[0m\n`;
}
