// A minimal, dependency-free MCP client over stdio (newline-delimited
// JSON-RPC 2.0). It speaks only what the nightly check needs: initialize,
// tools/list and tools/call. The server is spawned with an environment of
// PATH and HOME only, and killed — with its whole process group — when the
// check ends or its time box runs out.

import { spawn } from "node:child_process";

export const PROTOCOL_VERSION = "2025-06-18";
export const CLIENT_INFO = { name: "SatoHub-templates-ci", version: "1.0" };

/** The only environment a third-party server is given. */
export function bareEnv(src = process.env) {
  const env = {};
  for (const k of ["PATH", "HOME"]) if (src[k]) env[k] = src[k];
  return env;
}

export function startServer(command, args, { cwd, env = bareEnv(), stderrLimit = 4000 } = {}) {
  const child = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], detached: true });
  let buf = "";
  let stderr = "";
  let nextId = 1;
  const pending = new Map();
  let exited = null;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id !== undefined && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(Object.assign(new Error(msg.error.message ?? "rpc error"), { rpc: msg.error }));
        else resolve(msg.result);
      }
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (c) => { stderr = (stderr + c).slice(-stderrLimit); });
  child.on("exit", (code, signal) => {
    exited = { code, signal };
    for (const { reject } of pending.values()) reject(new Error(`server exited (${code ?? signal}) ${stderr.slice(-400)}`));
    pending.clear();
  });
  child.on("error", (e) => {
    exited = { code: -1, signal: null };
    for (const { reject } of pending.values()) reject(e);
    pending.clear();
  });

  function send(obj) {
    if (exited) throw new Error("server has exited");
    child.stdin.write(JSON.stringify(obj) + "\n");
  }
  function request(method, params) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      try { send({ jsonrpc: "2.0", id, method, params }); } catch (e) { pending.delete(id); reject(e); }
    });
  }
  async function initialize() {
    const r = await request("initialize", { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    return r;
  }
  async function listTools() {
    const tools = [];
    let cursor;
    for (let page = 0; page < 20; page++) {
      const r = await request("tools/list", cursor ? { cursor } : {});
      tools.push(...(r?.tools ?? []));
      cursor = r?.nextCursor;
      if (!cursor) break;
    }
    return tools;
  }
  function callTool(name, args) {
    return request("tools/call", { name, arguments: args });
  }
  function stop() {
    if (exited) return;
    try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* gone */ } }
  }
  return { initialize, listTools, callTool, stop, get stderr() { return stderr; }, get pid() { return child.pid; } };
}
