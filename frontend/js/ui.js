/**
 * ui.js – DOM rendering layer for frag
 *
 * Depends on App (app.js) for all data and actions.
 * No external UI libraries – uses vanilla DOM APIs.
 */

import App from './app.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function qs(sel, root = document) { return root.querySelector(sel); }
function qsAll(sel, root = document) { return [...root.querySelectorAll(sel)]; }

function createElement(tag, attrs = {}, children = []) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'className') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function')
      el.addEventListener(k.slice(2).toLowerCase(), v);
    else el.setAttribute(k, v);
  }
  for (const child of children) {
    if (typeof child === 'string') el.appendChild(document.createTextNode(child));
    else if (child) el.appendChild(child);
  }
  return el;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function showModal(id) { qs(`#${id}`)?.classList.remove('hidden'); }
function hideModal(id) { qs(`#${id}`)?.classList.add('hidden'); }

function toast(msg, type = 'info') {
  const container = qs('#toast-container');
  if (!container) return;
  const el = createElement('div', { className: `toast toast-${type}` }, [msg]);
  container.appendChild(el);
  setTimeout(() => el.classList.add('show'), 10);
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, 3500);
}

// ── Identity panel ────────────────────────────────────────────────────────────

function renderIdentity(identity) {
  const el = qs('#identity-hash');
  if (el) el.textContent = identity.hash;
}

function initIdentityPanel() {
  qs('#btn-copy-hash')?.addEventListener('click', () => {
    const hash = App.getIdentity()?.hash || '';
    navigator.clipboard?.writeText(hash).then(() => toast('Hash copied!', 'success'))
      .catch(() => toast('Copy failed – select manually', 'error'));
  });

  qs('#btn-import-hash')?.addEventListener('click', () => showModal('modal-import-identity'));
  qs('#import-identity-cancel')?.addEventListener('click', () => hideModal('modal-import-identity'));
  qs('#import-identity-form')?.addEventListener('submit', e => {
    e.preventDefault();
    const input = qs('#import-hash-value');
    try {
      App.importIdentity(input.value.trim());
      toast('Identity imported!', 'success');
      hideModal('modal-import-identity');
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}

// ── Server list ───────────────────────────────────────────────────────────────

function renderServers(servers) {
  const list = qs('#server-list');
  if (!list) return;
  list.innerHTML = '';
  if (servers.length === 0) {
    list.innerHTML = '<li class="empty-state">No servers added yet.</li>';
    return;
  }
  for (const s of servers) {
    const status = s.online === true ? '🟢' : s.online === false ? '🔴' : '⚪';
    const li = createElement('li', { className: 'server-item' }, [
      createElement('span', { className: 'server-status' }, [status]),
      createElement('span', { className: 'server-label', title: s.url }, [s.label || s.url]),
      createElement('button', {
        className: 'btn-icon danger',
        title: 'Remove server',
        onClick: () => {
          if (confirm(`Remove server "${s.label || s.url}"?`)) {
            App.removeServer(s.id);
          }
        },
      }, ['✕']),
    ]);
    list.appendChild(li);
  }
}

function initServerPanel() {
  qs('#btn-add-server')?.addEventListener('click', () => showModal('modal-add-server'));
  qs('#add-server-cancel')?.addEventListener('click', () => hideModal('modal-add-server'));

  qs('#add-server-form')?.addEventListener('submit', async e => {
    e.preventDefault();
    const url   = qs('#server-url').value.trim();
    const token = qs('#server-token').value.trim();
    const label = qs('#server-label').value.trim();
    try {
      const server = App.addServer({ url, token, label });
      toast(`Server "${server.label}" added.`, 'success');
      hideModal('modal-add-server');
      qs('#add-server-form').reset();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  qs('#btn-check-servers')?.addEventListener('click', async () => {
    toast('Checking servers…', 'info');
    await App.checkAllServers();
    toast('Server check complete.', 'success');
  });
}

// ── Chat list ─────────────────────────────────────────────────────────────────

function renderChatList(chats) {
  const list = qs('#chat-list');
  if (!list) return;
  list.innerHTML = '';
  if (chats.length === 0) {
    list.innerHTML = '<li class="empty-state">No chats yet. Create one!</li>';
    return;
  }
  for (const chat of chats) {
    const isActive = chat.id === App.activeChatId;
    const li = createElement('li', {
      className: `chat-item${isActive ? ' active' : ''}`,
      onClick: () => openChat(chat.id),
    }, [
      createElement('span', { className: 'chat-name' }, [chat.name]),
      createElement('span', { className: 'chat-server-count' },
        [`${chat.serverIds.length} server${chat.serverIds.length !== 1 ? 's' : ''}`]),
    ]);
    list.appendChild(li);
  }
}

function initChatPanel() {
  qs('#btn-new-chat')?.addEventListener('click', () => {
    populateServerCheckboxes();
    showModal('modal-new-chat');
  });

  qs('#new-chat-cancel')?.addEventListener('click', () => hideModal('modal-new-chat'));
  qs('#btn-import-chat')?.addEventListener('click', () => showModal('modal-import-chat'));
  qs('#import-chat-cancel')?.addEventListener('click', () => hideModal('modal-import-chat'));

  qs('#new-chat-form')?.addEventListener('submit', async e => {
    e.preventDefault();
    const name = qs('#chat-name').value.trim();
    const checked = qsAll('#new-chat-servers input[type=checkbox]:checked');
    const serverIds = checked.map(el => el.value);
    try {
      await App.createChat({ name, serverIds });
      toast(`Chat "${name}" created.`, 'success');
      hideModal('modal-new-chat');
      qs('#new-chat-form').reset();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  qs('#import-chat-form')?.addEventListener('submit', async e => {
    e.preventDefault();
    const json = qs('#import-chat-json').value.trim();
    try {
      const chat = await App.importChat(json);
      toast(`Chat "${chat.name}" imported.`, 'success');
      hideModal('modal-import-chat');
      qs('#import-chat-form').reset();
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}

function populateServerCheckboxes() {
  const container = qs('#new-chat-servers');
  if (!container) return;
  container.innerHTML = '';
  const servers = App.getServers();
  if (servers.length === 0) {
    container.innerHTML = '<p class="empty-state">Add servers first.</p>';
    return;
  }
  for (const s of servers) {
    const label = createElement('label', { className: 'server-checkbox' }, [
      createElement('input', { type: 'checkbox', name: 'servers', value: s.id }),
      s.label || s.url,
    ]);
    container.appendChild(label);
  }
}

// ── Chat view ─────────────────────────────────────────────────────────────────

async function openChat(chatId) {
  App.setActiveChat(chatId);
  App.stopPolling();

  const chat = App.getActiveChat();
  if (!chat) return;

  // Update header
  const header = qs('#chat-header-name');
  if (header) header.textContent = chat.name;

  const exportBtn = qs('#btn-export-chat');
  if (exportBtn) exportBtn.dataset.chatId = chat.id;

  const removeChatBtn = qs('#btn-remove-chat');
  if (removeChatBtn) removeChatBtn.dataset.chatId = chat.id;

  qs('#chat-placeholder')?.classList.add('hidden');
  qs('#chat-view')?.classList.remove('hidden');

  renderMessages(App.messages[chat.id] || []);

  // Poll immediately then start interval
  await App.pollActiveChat().catch(() => {});
  App.startPolling(5000);
}

function renderMessages(msgs) {
  const list = qs('#message-list');
  if (!list) return;
  list.innerHTML = '';
  const myHash = App.getIdentity()?.hash;
  const sorted = [...msgs].sort((a, b) => a.timestamp - b.timestamp);
  for (const msg of sorted) {
    renderMessage(msg, myHash, list);
  }
  list.scrollTop = list.scrollHeight;
}

function renderMessage(msg, myHash, container) {
  const isMine = msg.sender_hash === myHash;
  const senderName = isMine ? 'You' : App.displayName(msg.sender_hash);
  const time = new Date(msg.timestamp * 1000).toLocaleTimeString([], {
    hour: '2-digit', minute: '2-digit',
  });
  const div = createElement('div', { className: `message ${isMine ? 'mine' : 'theirs'}` }, [
    createElement('div', { className: 'message-meta' }, [
      createElement('span', { className: 'message-sender' }, [senderName]),
      createElement('span', { className: 'message-time' }, [time]),
    ]),
    createElement('div', { className: 'message-text' }, [msg.text]),
    msg.status === 'partial'
      ? createElement('div', { className: 'message-warning' }, ['⚠ partial delivery'])
      : null,
  ]);
  // Right-click to set nickname for sender (not self)
  if (!isMine) {
    div.addEventListener('contextmenu', e => {
      e.preventDefault();
      const current = App.getNickname(msg.sender_hash) || '';
      const name = prompt(`Set nickname for ${msg.sender_hash.slice(0, 8)}…`, current);
      if (name !== null) {
        App.setNickname(msg.sender_hash, name);
        toast('Nickname saved.', 'success');
        renderMessages(App.messages[App.activeChatId] || []);
      }
    });
  }
  container?.appendChild(div);
}

function initChatView() {
  qs('#message-form')?.addEventListener('submit', async e => {
    e.preventDefault();
    const input = qs('#message-input');
    const text = input.value.trim();
    if (!text) return;
    const ttl = parseInt(qs('#message-ttl')?.value || '0', 10);
    input.value = '';
    try {
      const result = await App.sendMessage(text, ttl);
      if (result?.warning) toast(result.warning, 'warning');
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  qs('#btn-export-chat')?.addEventListener('click', () => {
    const chatId = qs('#btn-export-chat').dataset.chatId;
    if (!chatId) return;
    try {
      const json = App.exportChat(chatId);
      qs('#export-chat-output').value = json;
      showModal('modal-export-chat');
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  qs('#export-chat-close')?.addEventListener('click', () => hideModal('modal-export-chat'));

  qs('#btn-copy-export')?.addEventListener('click', () => {
    const val = qs('#export-chat-output').value;
    navigator.clipboard?.writeText(val).then(() => toast('Copied!', 'success'))
      .catch(() => toast('Copy failed', 'error'));
  });

  qs('#btn-remove-chat')?.addEventListener('click', () => {
    const chatId = qs('#btn-remove-chat').dataset.chatId;
    if (!chatId) return;
    const chat = App.getChats().find(c => c.id === chatId);
    if (confirm(`Delete chat "${chat?.name}"?`)) {
      App.removeChat(chatId);
      qs('#chat-view')?.classList.add('hidden');
      qs('#chat-placeholder')?.classList.remove('hidden');
      toast('Chat removed.', 'success');
    }
  });
}

// ── App-level event wiring ────────────────────────────────────────────────────

function wireAppEvents() {
  App.on('identityReady', identity => renderIdentity(identity));
  App.on('serverUpdate', servers => renderServers(servers));
  App.on('chatUpdate', chats => renderChatList(chats));

  App.on('message', ({ chatId, message }) => {
    if (chatId !== App.activeChatId) return;
    const list = qs('#message-list');
    if (!list) return;
    const myHash = App.getIdentity()?.hash;
    renderMessage(message, myHash, list);
    list.scrollTop = list.scrollHeight;
  });
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

async function boot() {
  wireAppEvents();
  initIdentityPanel();
  initServerPanel();
  initChatPanel();
  initChatView();

  try {
    await App.init();
    // Initial renders
    renderServers(App.getServers());
    renderChatList(App.getChats());
  } catch (err) {
    toast(`Startup error: ${err.message}`, 'error');
  }
}

document.addEventListener('DOMContentLoaded', boot);

export { boot };
