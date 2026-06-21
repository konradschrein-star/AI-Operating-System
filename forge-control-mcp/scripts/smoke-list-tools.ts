/**
 * Smoke: launches the MCP server as a child, sends a ListTools request over
 * stdio, verifies the 3 expected tools are advertised. No live forge-control
 * needed — ListTools never fetches.
 *
 * Run: npx tsx scripts/smoke-list-tools.ts
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(__dirname, "..", "src", "server.ts");

async function main() {
  const child = spawn("node", ["--import", "tsx", SERVER], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (b) => (stdout += b.toString()));
  child.stderr.on("data", (b) => (stderr += b.toString()));

  // Send a ListTools JSON-RPC request.
  const req = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
  };
  child.stdin.write(JSON.stringify(req) + "\n");

  // Wait briefly for response.
  const deadline = Date.now() + 6_000;
  while (Date.now() < deadline) {
    if (stdout.includes('"id":1')) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill();

  if (!stdout.includes('"id":1')) {
    throw new Error(`no response from server within 6s. stdout=${stdout}\nstderr=${stderr}`);
  }
  // Parse the first complete JSON line that contains the response.
  const line = stdout.split("\n").find((l) => l.includes('"id":1'));
  if (!line) throw new Error("no response line found");
  const resp = JSON.parse(line);
  const tools = resp.result?.tools;
  if (!Array.isArray(tools)) throw new Error("response missing tools array");
  const names = tools.map((t: { name: string }) => t.name).sort();
  const expected = ["memory.list", "memory.note", "memory.search"];
  if (JSON.stringify(names) !== JSON.stringify(expected)) {
    throw new Error(`expected tools ${expected.join(",")}, got ${names.join(",")}`);
  }
  console.log(`[smoke] ListTools returned ${tools.length} tools ✓ (${names.join(", ")})`);

  // Spot-check the schema on memory.search.
  const search = tools.find((t: { name: string }) => t.name === "memory.search");
  if (!search.inputSchema?.properties?.query) {
    throw new Error("memory.search inputSchema missing `query`");
  }
  if (!search.inputSchema?.properties?.category?.enum?.includes("decision")) {
    throw new Error("memory.search category enum missing 'decision'");
  }

  console.log("[smoke] all invariants passed ✓");
}

main().catch((e) => {
  console.error("[smoke] FAILED:", e);
  process.exit(1);
});
