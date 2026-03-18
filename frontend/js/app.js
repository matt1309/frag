/**
 * app.js – Core application logic for frag
 *
 * Manages:
 *  - Identity (user hash)
 *  - Server list
 *  - Chat list (each chat = N servers + encryption key + chat_id)
 *  - Message sending (fragment + encrypt)
 *  - Message polling (assemble + decrypt)
 *  - Nicknames (hash → display name, local only)
 */

import Crypto from './crypto.js';
import Network from './network.js';

// ── Persistence helpers ───────────────────────────────────────────────────────

const Store = {
  get(key, fallback = null) {
    try {
      const v = localStorage.getItem(key);
      return v === null ? fallback : JSON.parse(v);
    } catch { return fallback; }
  },
  set(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  },
  remove(key) {
    localStorage.removeItem(key);
  },
};

// ── UUID helper (browser-native if available, else fallback) ──────────────────
function generateId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

// ── App state ─────────────────────────────────────────────────────────────────

const state = {
  identity: null,       // { hash: string }
  servers: [],          // [{ id, url, token, label, online? }]
  chats: [],            // [{ id, name, serverIds, chatId, keyB64, lastSince }]
  nicknames: {},        // { hash: displayName }
  messages: {},         // { chatId: [msg, ...] }   (in-memory, assembled)
  activeChatId: null,   // id of currently open chat
  pollTimer: null,
};

// Callbacks registered by UI layer
const listeners = { message: [], chatUpdate: [], serverUpdate: [], identityReady: [] };

function on(event, cb) {
  if (listeners[event]) listeners[event].push(cb);
}
function emit(event, data) {
  (listeners[event] || []).forEach(cb => { try { cb(data); } catch {} });
}

// ── Identity ──────────────────────────────────────────────────────────────────

async function initIdentity() {
  let saved = Store.get('identity');
  if (!saved || !saved.hash) {
    const hash = await Crypto.generateIdentityHash();
    saved = { hash };
    Store.set('identity', saved);
  }
  state.identity = saved;
  emit('identityReady', state.identity);
  return state.identity;
}

/** Replace the current identity with an imported hash (e.g. from another device). */
function importIdentity(hash) {
  if (!hash || typeof hash !== 'string' || hash.length < 16) throw new Error('Invalid hash');
  state.identity = { hash: hash.toLowerCase().trim() };
  Store.set('identity', state.identity);
  emit('identityReady', state.identity);
}

function getIdentity() { return state.identity; }

// ── Servers ───────────────────────────────────────────────────────────────────

function loadServers() {
  state.servers = Store.get('servers', []);
}

function saveServers() {
  Store.set('servers', state.servers.map(({ id, url, token, label }) =>
    ({ id, url, token, label })));
}

function addServer({ url, token, label }) {
  if (!url || !token) throw new Error('URL and token are required');
  const id = generateId();
  const server = { id, url: url.replace(/\/$/, ''), token, label: label || url };
  state.servers.push(server);
  saveServers();
  emit('serverUpdate', state.servers);
  checkServer(server);
  return server;
}

function removeServer(id) {
  state.servers = state.servers.filter(s => s.id !== id);
  saveServers();
  emit('serverUpdate', state.servers);
}

function getServers() { return state.servers; }

async function checkServer(server) {
  try {
    await Network.healthCheck(server.url, server.token);
    server.online = true;
  } catch {
    server.online = false;
  }
  emit('serverUpdate', state.servers);
}

async function checkAllServers() {
  await Promise.allSettled(state.servers.map(checkServer));
}

// ── Chats ─────────────────────────────────────────────────────────────────────

function loadChats() {
  state.chats = Store.get('chats', []);
}

function saveChats() {
  Store.set('chats', state.chats);
}

async function createChat({ name, serverIds, chatId, keyB64 }) {
  if (!name)              throw new Error('Chat name required');
  if (!serverIds?.length) throw new Error('Select at least one server');

  const id = generateId();
  // Use provided chatId (joining existing chat) or generate one
  const resolvedChatId = chatId || generateId();
  // Use provided key or generate new one
  let resolvedKeyB64 = keyB64;
  if (!resolvedKeyB64) {
    const key = await Crypto.generateKey();
    resolvedKeyB64 = await Crypto.exportKey(key);
  }

  const chat = {
    id,
    name,
    serverIds,
    chatId: resolvedChatId,
    keyB64: resolvedKeyB64,
    lastSince: 0,
  };
  state.chats.push(chat);
  state.messages[chat.id] = [];
  saveChats();
  emit('chatUpdate', state.chats);
  return chat;
}

function removeChat(id) {
  state.chats = state.chats.filter(c => c.id !== id);
  delete state.messages[id];
  if (state.activeChatId === id) state.activeChatId = null;
  saveChats();
  emit('chatUpdate', state.chats);
}

function getChats() { return state.chats; }

function setActiveChat(chatId) {
  state.activeChatId = chatId;
  if (chatId && !state.messages[chatId]) state.messages[chatId] = [];
}

function getActiveChat() {
  return state.chats.find(c => c.id === state.activeChatId) || null;
}

/**
 * Export a chat's connection details as a JSON string.
 * The recipient pastes this into "Import Chat" to connect.
 */
function exportChat(chatId) {
  const chat = state.chats.find(c => c.id === chatId);
  if (!chat) throw new Error('Chat not found');
  const servers = chat.serverIds.map(sid => {
    const s = state.servers.find(sv => sv.id === sid);
    if (!s) throw new Error(`Server ${sid} not found`);
    return { url: s.url, token: s.token, label: s.label };
  });
  return JSON.stringify({
    name: chat.name,
    chatId: chat.chatId,
    keyB64: chat.keyB64,
    servers,
  });
}

/**
 * Import a chat from an exported JSON string.
 * Adds any unknown servers automatically.
 */
async function importChat(jsonStr) {
  let data;
  try { data = JSON.parse(jsonStr); } catch { throw new Error('Invalid JSON'); }
  const { name, chatId, keyB64, servers } = data;
  if (!name || !chatId || !keyB64 || !Array.isArray(servers))
    throw new Error('Missing required fields');

  const serverIds = [];
  for (const s of servers) {
    let existing = state.servers.find(sv => sv.url === s.url && sv.token === s.token);
    if (!existing) {
      existing = addServer({ url: s.url, token: s.token, label: s.label });
    }
    serverIds.push(existing.id);
  }

  return createChat({ name, serverIds, chatId, keyB64 });
}

// ── Nicknames ─────────────────────────────────────────────────────────────────

function loadNicknames() {
  state.nicknames = Store.get('nicknames', {});
}

function setNickname(hash, name) {
  if (name) {
    state.nicknames[hash] = name;
  } else {
    delete state.nicknames[hash];
  }
  Store.set('nicknames', state.nicknames);
}

function getNickname(hash) {
  return state.nicknames[hash] || null;
}

function displayName(hash) {
  return state.nicknames[hash] || hash.slice(0, 8) + '…';
}

// ── Sending messages ──────────────────────────────────────────────────────────

/**
 * Send a plaintext message in the active chat.
 * Encrypts, splits across servers, and POST each fragment.
 * @param {string} text  - Plaintext message to send.
 * @param {number} [ttl] - Seconds until the fragment expires (0 = no expiry).
 */
async function sendMessage(text, ttl = 0) {
  const chat = getActiveChat();
  if (!chat) throw new Error('No active chat');
  if (!state.identity) throw new Error('Identity not initialised');

  const servers = chat.serverIds.map(sid => state.servers.find(s => s.id === sid))
    .filter(Boolean);
  if (servers.length === 0) throw new Error('No servers available for this chat');

  const resolvedTtl = (typeof ttl === 'number' && ttl >= 0) ? Math.floor(ttl) : 0;

  // Encrypt the message text
  const key = await Crypto.importKey(chat.keyB64);
  const encryptedB64 = await Crypto.encrypt(key, text);

  // Split across servers
  const chunks = Crypto.splitPayload(encryptedB64, servers.length);
  const messageId = generateId();
  const now = Math.floor(Date.now() / 1000);

  // Post each chunk to its server (in parallel)
  const posts = servers.map((server, i) => {
    const fragment = {
      id: `${messageId}-${i}`,
      message_id: messageId,
      chat_id: chat.chatId,
      sender_hash: state.identity.hash,
      payload: chunks[i],
      ttl: resolvedTtl,
      // fragment_index and total_fragments are intentionally omitted:
      // position is implied by which server receives the chunk.
    };
    return Network.postFragment(server, fragment);
  });

  // We don't fail hard if some servers are unreachable – let the user know
  const results = await Promise.allSettled(posts);
  const failed = results.filter(r => r.status === 'rejected').length;

  // Optimistically add the message locally
  const msg = {
    id: messageId,
    chat_id: chat.chatId,
    sender_hash: state.identity.hash,
    text,
    timestamp: now,
    status: failed ? 'partial' : 'sent',
  };
  (state.messages[chat.id] || (state.messages[chat.id] = [])).push(msg);
  emit('message', { chatId: chat.id, message: msg });

  if (failed === servers.length) throw new Error('All servers failed – message not sent');
  if (failed > 0)
    return { warning: `${failed}/${servers.length} servers could not be reached.` };
  return { ok: true };
}

// ── Polling / receiving messages ──────────────────────────────────────────────

/** Fetch and decrypt new messages for the active chat. */
async function pollActiveChat() {
  const chat = getActiveChat();
  if (!chat) return;

  const servers = chat.serverIds.map(sid => state.servers.find(s => s.id === sid))
    .filter(Boolean);
  if (servers.length === 0) return;

  const key = await Crypto.importKey(chat.keyB64);

  // Fetch new fragments from all servers in parallel
  const fetches = servers.map(server =>
    Network.getFragments(server, chat.chatId, chat.lastSince)
      .catch(() => []) // ignore unreachable servers
  );
  const results = await Promise.all(fetches);

  // Aggregate all fragments keyed by message_id.
  // results[serverIndex] holds fragments from servers[serverIndex], so the
  // array position encodes the fragment's position in the reassembly order.
  const N = servers.length;
  const byMessage = {};  // message_id → { fragments: Map<serverIndex, payload>, meta }
  results.forEach((frags, serverIdx) => {
    for (const frag of frags) {
      if (!byMessage[frag.message_id]) {
        byMessage[frag.message_id] = {
          sender: frag.sender_hash,
          timestamp: frag.timestamp,
          fragments: new Map(),
        };
      }
      byMessage[frag.message_id].fragments.set(serverIdx, frag.payload);
    }
  });

  let maxTimestamp = chat.lastSince;
  const existing = new Set((state.messages[chat.id] || []).map(m => m.id));

  for (const [messageId, info] of Object.entries(byMessage)) {
    if (existing.has(messageId)) continue;           // already displayed
    if (info.fragments.size < N) continue;           // incomplete – missing fragments from one or more servers

    // Reassemble in server-list order
    const ordered = [];
    for (let i = 0; i < N; i++) {
      if (!info.fragments.has(i)) { ordered.length = 0; break; }
      ordered.push(info.fragments.get(i));
    }
    if (ordered.length === 0) continue;

    const reassembled = Crypto.joinPayload(ordered);
    let text;
    try {
      text = await Crypto.decrypt(key, reassembled);
    } catch {
      text = '[decryption failed]';
    }

    const msg = {
      id: messageId,
      chat_id: chat.chatId,
      sender_hash: info.sender,
      text,
      timestamp: info.timestamp,
      status: 'received',
    };
    (state.messages[chat.id] || (state.messages[chat.id] = [])).push(msg);
    emit('message', { chatId: chat.id, message: msg });

    if (info.timestamp > maxTimestamp) maxTimestamp = info.timestamp;
  }

  if (maxTimestamp > chat.lastSince) {
    chat.lastSince = maxTimestamp;
    saveChats();
  }
}

/** Start auto-polling every `intervalMs` milliseconds. */
function startPolling(intervalMs = 5000) {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = setInterval(() => pollActiveChat().catch(() => {}), intervalMs);
}

function stopPolling() {
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
}

// ── Initialise ────────────────────────────────────────────────────────────────

async function init() {
  loadServers();
  loadChats();
  loadNicknames();
  await initIdentity();
  // Initialise in-memory message store for each saved chat
  for (const chat of state.chats) {
    if (!state.messages[chat.id]) state.messages[chat.id] = [];
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

const App = {
  init,
  on,

  // Identity
  getIdentity,
  importIdentity,

  // Servers
  addServer,
  removeServer,
  getServers,
  checkAllServers,
  checkServer,

  // Chats
  createChat,
  removeChat,
  getChats,
  setActiveChat,
  getActiveChat,
  exportChat,
  importChat,

  // Nicknames
  setNickname,
  getNickname,
  displayName,

  // Messaging
  sendMessage,
  pollActiveChat,
  startPolling,
  stopPolling,

  // Expose raw state for UI reads (read-only intent)
  get messages() { return state.messages; },
  get activeChatId() { return state.activeChatId; },
};

export default App;
