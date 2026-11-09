// Exercise pending MCP waits while temporary abort signals are collected.
import '../../scripts/mcp.mjs';
setInterval(() => global.gc(), 25).unref();
