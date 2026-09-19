/**
 * qoder-cli-bridge — official-CLI fallback for models the native protocol
 * path cannot serve (notably `qfmodel`, which Qoder's gateway blocks for
 * non-IDE sessions with 406 "Session blocked").
 *
 * Spawns the official `qodercn` CLI in print mode (`-f stream-json`), feeds it
 * the rendered conversation and re-emits its text as OpenAI-style SSE chunks —
 * the same shape chatCore consumes from native executors.
 *
 * The spawned binary is the fixed literal "qodercn" (no env override) — this
 * module must never execute a caller-controlled path.
 *
 * Environment:
 *   QODER_CLI_FALLBACK   "0"/"false" disables the bridge (default: enabled)
 *   QODER_CLI_MAX_CONCURRENT  max concurrent CLI children (default: 1 — the
 *                         CLI child is a full node process; keep it low on
 *                         small VPS instances)
 *   QODER_CLI_TIMEOUT_MS child timeout (default: 120000)
 */
import { spawn } from "node:child_process";

const CLI_BIN = "qodercn";

export const CLI_BRIDGE_MODELS = ["qfmodel"];

const MODEL_DISPLAY_NAMES = {
  qfmodel: "Qwen3.8-Flash",
  qmodel_38max: "Qwen3.8-Max",
  qmodel_latest: "Qwen3.7-Max",
  qmodel: "Qwen3.7-Plus",
  gfmodel: "GLM-5.3-Flash",
  gmodel: "GLM-5.3",
  kmodel_latest: "Kimi-K3",
  kmodel: "Kimi-K2.7-Code",
  dmodel: "DeepSeek-V4-Pro",
  dfmodel: "DeepSeek-V4-Flash",
  mmodel: "MiniMax-M3",
  auto: "Auto",
};

const MAX_CONCURRENT = Math.max(1, parseInt(process.env.QODER_CLI_MAX_CONCURRENT || "1", 10) || 1);
const TIMEOUT_MS = Math.max(15000, parseInt(process.env.QODER_CLI_TIMEOUT_MS || "120000", 10) || 120000);

// Simple FIFO semaphore — the CLI child is a heavy node process; on small
// instances parallel spawns OOM the box.
let active9 = 0;
const queue9 = [];
function acquire() {
  if (active9 < MAX_CONCURRENT) { active9++; return Promise.resolve(); }
  return new Promise((resolve) => queue9.push(() => { active9++; resolve(); }));
}
function release() {
  active9--;
  const next = queue9.shift();
  if (next) next();
}

function contentToText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        if (typeof p === "string") return p;
        if (p && typeof p.text === "string") return p.text;
        return "";
      })
      .join("");
  }
  return content == null ? "" : String(content);
}

export function renderPrompt(messages) {
  const parts = [];
  let lastUser = "";
  for (const m of messages || []) {
    const text = contentToText(m.content);
    if (!text) continue;
    if (m.role === "system") parts.push(`[System]\n${text}`);
    else if (m.role === "assistant") parts.push(`[Assistant]\n${text}`);
    else if (m.role === "user") { parts.push(`[User]\n${text}`); lastUser = text; }
    else parts.push(`[${m.role}]\n${text}`);
  }
  // The CLI treats -p as the user turn; closing reminder keeps multi-turn
  // renderings from being answered as if the transcript were the question.
  const bodyText = parts.join("\n\n");
  return lastUser && parts.length > 1 ? `${bodyText}\n\n[User]\n${lastUser}` : bodyText || "hi";
}

function runCli({ displayName, prompt, pat, onText, log }) {
  return new Promise((resolve, reject) => {
    const child = spawn(CLI_BIN, ["-p", prompt, "-m", displayName, "-f", "stream-json", "--tools", ""], {
      env: {
        ...process.env,
        QODERCN_PERSONAL_ACCESS_TOKEN: pat || process.env.QODERCN_PERSONAL_ACCESS_TOKEN || "",
        NO_BROWSER: "1",
        CI: "1",
        HOME: "/app/data-home",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let buffer = "";
    let emitted = "";
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      err ? reject(err) : resolve();
    };
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      finish(new Error(`qodercn timeout after ${TIMEOUT_MS}ms`));
    }, TIMEOUT_MS);

    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("{")) continue;
        try {
          const evt = JSON.parse(trimmed);
          if (evt.type === "assistant" && evt.message) {
            const content = evt.message.content;
            if (Array.isArray(content)) {
              for (const part of content) {
                if (part && typeof part.text === "string" && part.text) {
                  if (part.text.startsWith(emitted) && part.text.length > emitted.length) {
                    const delta = part.text.slice(emitted.length);
                    emitted = part.text;
                    onText(delta);
                  } else if (!part.text.startsWith(emitted)) {
                    onText(part.text);
                    emitted = part.text;
                  }
                }
              }
            }
          }
          if (evt.type === "result") {
            const resultText = typeof evt.result === "string" ? evt.result : "";
            if (resultText && !emitted.startsWith(resultText) && resultText.length > emitted.length) {
              onText(resultText.slice(emitted.length));
              emitted = resultText;
            }
          }
        } catch {}
      }
    });

    child.stderr.on("data", (d) => {
      const t = d.toString();
      if (log?.debug && t.trim()) log.debug("QODER-CLI", t.trim().slice(0, 150));
    });

    child.on("error", (e) => finish(e));
    child.on("close", (code) => {
      if (code !== 0 && !emitted) finish(new Error(`qodercn exited ${code}`));
      else finish(null);
    });
  });
}

/**
 * Bridge entry. Returns the same {response, url, headers, transformedBody}
 * shape native executors return, with an SSE body carrying the CLI output.
 */
export async function cliBridgeExecute({ model, upstreamBody, credentials, log }) {
  const displayName = MODEL_DISPLAY_NAMES[model] || model;
  const prompt = renderPrompt(upstreamBody?.messages);
  const pat = credentials?.apiKey || process.env.QODERCN_PERSONAL_ACCESS_TOKEN || "";
  const id = `chatcmpl-cli-${Date.now().toString(36)}`;

  await acquire();
  try {
    const deltas = [];
    await runCli({
      displayName,
      prompt,
      pat,
      log,
      onText: (delta) => deltas.push(delta),
    });

    const enc = new TextEncoder();
    const openaiStream = new ReadableStream({
      start(controller) {
        const send = (obj) => controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));
        send({ id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] });
        for (const d of deltas) {
          if (d) send({ id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: { content: d }, finish_reason: null }] });
        }
        send({ id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
        controller.enqueue(enc.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });

    const response = new Response(openaiStream, {
      status: 200,
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
    });
    return { response, url: `cli-bridge://qodercn/${displayName}`, headers: {}, transformedBody: null };
  } finally {
    release();
  }
}

export default cliBridgeExecute;
