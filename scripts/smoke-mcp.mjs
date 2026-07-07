#!/usr/bin/env node
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const smokeDir = mkdtempSync(join(tmpdir(), "local-websearch-mcp-smoke-"));
const cacheDbPath = join(smokeDir, "websearch_cache.db");
const child = spawn(process.execPath, ["build/index.js"], {
  cwd: process.cwd(),
  stdio: ["pipe", "pipe", "pipe"],
  env: {
    ...process.env,
    CACHE_DB_PATH: process.env.CACHE_DB_PATH ?? cacheDbPath,
    SEARCH_PROVIDERS: process.env.SEARCH_PROVIDERS ?? "duckduckgo",
    ENABLE_CROSSLINGUAL: process.env.ENABLE_CROSSLINGUAL ?? "false",
  },
});

let nextId = 1;
let stdout = "";
let stderr = "";
const pending = new Map();

const timeout = setTimeout(() => {
  child.kill();
  fail(`MCP smoke timed out.\n${stderr}`);
}, 15_000);

child.stdout.on("data", (chunk) => {
  stdout += chunk.toString("utf8");
  let newlineIndex = stdout.indexOf("\n");

  while (newlineIndex !== -1) {
    const line = stdout.slice(0, newlineIndex).trim();
    stdout = stdout.slice(newlineIndex + 1);
    newlineIndex = stdout.indexOf("\n");

    if (!line) continue;

    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      fail(`Invalid JSON-RPC line: ${line}\n${error instanceof Error ? error.message : String(error)}`);
    }

    const waiter = pending.get(message.id);
    if (waiter) {
      pending.delete(message.id);
      waiter(message);
    }
  }
});

child.stderr.on("data", (chunk) => {
  stderr += chunk.toString("utf8");
});

child.on("exit", (code) => {
  if (code !== null && code !== 0 && pending.size > 0) {
    fail(`MCP server exited with code ${code}.\n${stderr}`);
  }
});

try {
  const init = await request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: {
      name: "local-websearch-mcp-smoke",
      version: "1.0.0",
    },
  });
  assertNoError(init, "initialize");

  notify("notifications/initialized", {});

  const tools = await request("tools/list", {});
  assertNoError(tools, "tools/list");
  const toolNames = tools.result.tools.map((tool) => tool.name).sort();
  assertIncludes(toolNames, "web_search", "tools/list");
  assertIncludes(toolNames, "fetch_content", "tools/list");
  assertIncludes(toolNames, "server_status", "tools/list");

  const status = await request("tools/call", {
    name: "server_status",
    arguments: {},
  });
  assertNoError(status, "server_status");
  const statusText = status.result.content?.[0]?.text ?? "";
  JSON.parse(statusText);

  const blockedFetch = await request("tools/call", {
    name: "fetch_content",
    arguments: {
      url: "http://127.0.0.1/",
    },
  });
  if (blockedFetch.result?.isError !== true) {
    fail("fetch_content did not block localhost during smoke test.");
  }

  clearTimeout(timeout);
  child.kill();
  await once(child, "exit").catch(() => undefined);
  rmSync(smokeDir, { recursive: true, force: true });
  console.log(`MCP smoke passed: ${toolNames.join(", ")}`);
} catch (error) {
  child.kill();
  fail(error instanceof Error ? error.message : String(error));
}

function request(method, params) {
  const id = nextId++;
  const message = {
    jsonrpc: "2.0",
    id,
    method,
    params,
  };

  child.stdin.write(`${JSON.stringify(message)}\n`);
  return new Promise((resolve) => pending.set(id, resolve));
}

function notify(method, params) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
}

function assertNoError(response, label) {
  if (response.error) {
    fail(`${label} failed: ${JSON.stringify(response.error)}`);
  }
}

function assertIncludes(values, expected, label) {
  if (!values.includes(expected)) {
    fail(`${label} missing ${expected}; got ${values.join(", ")}`);
  }
}

function fail(message) {
  clearTimeout(timeout);
  rmSync(smokeDir, { recursive: true, force: true });
  console.error(message);
  process.exit(1);
}
