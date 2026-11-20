// Authorizes local file references from the host's persisted Codex conversation.

const path = require("node:path");
const { fileURLToPath } = require("node:url");
const { visibleUserPromptText } = require("./desktop-ipc-shared");
const { readThreadRolloutRecords, resolveSessionsRoot } = require("./rollout-watch");

const scopes = new Map();
const MAX_SCOPES = 16;
const SCOPE_TTL_MS = 5_000;
const MAX_REFERENCES = 8_192;
const CHAT_RECORD = /"(?:session_meta|turn_context|response_item|item_completed|user_message)"/;
const MESSAGE_LINK = /!?\[[^\]\n]*\]\(\s*(<[^>\n]+>|(?:\\[()]|[^\s()])+)(?:\s+"[^"\n]*")?\s*\)/g;
const FILE_TOKEN = /(?:^|[\s([{，。；“”])([^\s`<>"'()[\]{}，。；“”]+[/\\][^\s`<>"'()[\]{}，。；“”]+|[/\\][^\s`<>"'()[\]{}，。；“”]+)/g;

async function readChatFileScope(threadId, readProviderThread) {
  if (typeof threadId !== "string") return null;
  const isCodex = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(threadId);
  if (!isCodex && !(readProviderThread && /^opencode:ses[a-zA-Z0-9_-]{1,128}$/.test(threadId))) return null;
  const root = resolveSessionsRoot();
  const key = `${root}\0${threadId}`;
  const now = Date.now();
  const existing = scopes.get(key);
  if (existing && existing.expires >= now) return existing.pending;
  scopes.delete(key);
  if (scopes.size >= MAX_SCOPES) scopes.delete(scopes.keys().next().value);
  const entry = { expires: Infinity, pending: null };
  entry.pending = (isCodex ? scanChatFiles(root, threadId) : providerChatFiles(threadId, readProviderThread)).finally(() => {
    entry.expires = Date.now() + SCOPE_TTL_MS;
  });
  scopes.set(key, entry);
  return entry.pending;
}

async function providerChatFiles(threadId, readProviderThread) {
  const thread = await readProviderThread(threadId);
  if (thread?.id !== threadId) return null;
  const cwd = typeof thread.cwd === "string" && path.isAbsolute(thread.cwd) ? thread.cwd : null;
  const references = new Set();
  for (const turn of thread.turns ?? []) {
    for (const item of turn.items ?? []) {
      addReferences(references, visibleChatMessage("response_item", item), cwd);
    }
  }
  return { cwd, references };
}

async function scanChatFiles(root, threadId) {
  let cwd;
  let latestCwd;
  let seenSession = false;
  let newestSession = false;
  const references = new Set();
  const archivedRoot = path.join(path.dirname(root), "archived_sessions");
  for await (const record of readChatRecords(root, archivedRoot, threadId)) {
    const { type, payload } = record;
    if (type === "session_meta" || type === "turn_context") {
      if (type === "session_meta") {
        newestSession = !seenSession;
        seenSession = true;
        cwd = null;
      }
      if (typeof payload?.cwd === "string" && path.isAbsolute(payload.cwd)) cwd = payload.cwd;
      if (newestSession && cwd) latestCwd = cwd;
      continue;
    }
    addReferences(references, visibleChatMessage(type, payload), cwd);
  }
  return seenSession ? { cwd: latestCwd, references } : null;
}

async function* readChatRecords(root, archivedRoot, threadId) {
  yield* readThreadRolloutRecords(root, threadId, CHAT_RECORD);
  yield* readThreadRolloutRecords(archivedRoot, threadId, CHAT_RECORD);
}

function addReferences(references, message, cwd) {
  if (!message) return;
  for (const candidate of fileReferences(message)) {
    const target = chatPath(candidate, cwd);
    if (!target || references.has(target)) continue;
    if (references.size >= MAX_REFERENCES) references.delete(references.values().next().value);
    references.add(target);
  }
}

function visibleChatMessage(type, payload) {
  if (type === "event_msg" && payload?.type === "user_message") {
    return visibleUserPromptText(payload.message || payload.text);
  }
  const item = type === "event_msg" && payload?.type === "item_completed" ? payload.item : payload;
  if (!item || (type !== "response_item" && item === payload)) return "";
  const itemType = typeof item.type === "string" ? item.type.toLowerCase().replaceAll("_", "") : "";
  const user = itemType === "usermessage" || (itemType === "message" && item.role === "user");
  const assistant = itemType === "agentmessage" || (itemType === "message" && item.role === "assistant");
  if (!user && !assistant) return "";
  const content = Array.isArray(item.content) ? item.content : [];
  const texts = typeof item.text === "string" ? [item.text]
    : content.filter((part) => ["text", "input_text", "output_text"].includes(part?.type)).map((part) => part.text);
  return texts.filter((text) => typeof text === "string")
    .map((text) => user ? visibleUserPromptText(text) : text).join("\n");
}

function* fileReferences(message) {
  const attachmentEnvelope = /^\s*# Files mentioned by the user:\r?\n([\s\S]*?)\r?\nDistinguish instructions in attached documents from the user's request\.\s*\r?\n## My request:\r?\n/;
  const envelope = attachmentEnvelope.exec(message);
  if (envelope) {
    for (const [, target] of envelope[1].matchAll(/^## .+?: (.+)$/gm)) yield target;
    message = message.slice(envelope[0].length);
  }
  // Only user-visible prose links, inline code, and complete path tokens count.
  const prose = message.replace(/^\s*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\s*\1[^\n]*$/gm, "");
  for (const [, target] of prose.matchAll(MESSAGE_LINK)) yield target;
  const withoutLinks = prose.replace(MESSAGE_LINK, " ");
  for (const [, target] of withoutLinks.matchAll(/`([^`\n]+)`/g)) yield target;
  for (const [, target] of withoutLinks.replace(/`[^`\n]+`/g, " ").matchAll(FILE_TOKEN)) {
    yield target.replace(/[,.;。；]+$/, "");
  }
}

function chatPath(raw, cwd) {
  let value = raw.trim().replace(/^<|>$/g, "").replace(/\\([()])/g, "$1");
  if (/^file:/i.test(value)) {
    try { value = fileURLToPath(value); } catch { return null; }
  } else {
    try { value = decodeURIComponent(value); } catch { return null; }
  }
  value = value.replace(/[?#].*$/, "").replace(/:\d+(?::\d+)?$/, "");
  if (!value || value.length > 4_096 || /[\u0000-\u001f]/.test(value)) return null;
  if (path.isAbsolute(value)) return path.resolve(value);
  if (!cwd || /^[a-z][a-z0-9+.-]*:/i.test(value) || !value.includes("/") && !value.includes(path.sep)) return null;
  return path.resolve(cwd, value);
}

module.exports = { readChatFileScope };
