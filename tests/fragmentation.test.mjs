/**
 * fragmentation.test.mjs
 *
 * Security and correctness tests for frag's fragmentation + encryption model.
 *
 * Scenarios covered:
 *  1. Crypto primitives – encrypt/decrypt roundtrip, random IV, auth-tag integrity
 *  2. Two-server setup – each server's fragment alone is insufficient to decrypt
 *  3. Three-server setup – every strict subset of servers is insufficient to decrypt
 *  4. Multiple clients in a shared chat – all messages delivered; no server subset leaks plaintext
 *  5. Chat isolation – cross-chat key attempts fail; different chats stay isolated
 *  6. Five-server setup – all single, double, triple, and four-server subsets cannot decrypt
 *
 * Run with:  node --test tests/fragmentation.test.mjs
 * Or:        npm test
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const { default: Crypto } = await import(join(__dirname, '..', 'frontend', 'js', 'crypto.js'));

// ── Mock Server ──────────────────────────────────────────────────────────────

/**
 * Simulates a frag backend server node.
 * Stores fragments in memory, indexed by chat_id and message_id.
 */
class MockServer {
  constructor(id, label) {
    this.id = id;
    this.label = label;
    this._fragments = [];
  }

  /** Persist a fragment (mirrors POST /api/fragments). */
  postFragment(fragment) {
    this._fragments.push({ ...fragment });
    return { ok: true };
  }

  /** Return fragments for a chat since a timestamp (mirrors GET /api/fragments). */
  getFragments(chatId, since = 0) {
    return this._fragments.filter(
      f => f.chat_id === chatId && f.timestamp >= since,
    );
  }

  /** Return all fragments belonging to a specific message (mirrors GET /api/fragments/:id/all). */
  getMessageFragments(messageId) {
    return this._fragments.filter(f => f.message_id === messageId);
  }
}

// ── Mock Client ──────────────────────────────────────────────────────────────

/**
 * Simulates a frag frontend client.
 * Handles encryption, fragmentation, and reassembly identically to app.js.
 *
 * @param {string}       id       – unique identifier for this client
 * @param {MockServer[]} servers  – ordered list of servers for this chat
 * @param {string}       chatId   – shared chat identifier
 * @param {string}       keyB64   – shared AES-GCM key (base64)
 */
class MockClient {
  constructor(id, servers, chatId, keyB64) {
    this.id = id;
    this.servers = servers;
    this.chatId = chatId;
    this.keyB64 = keyB64;
    this.identityHash = null;
    this.lastSince = 0;
    this.receivedMessages = [];
  }

  async init() {
    this.identityHash = await Crypto.generateIdentityHash();
  }

  /**
   * Encrypt a message, split across servers, and post each fragment.
   * Returns { messageId, chunks, encryptedB64 } for test inspection.
   */
  async sendMessage(text) {
    const key = await Crypto.importKey(this.keyB64);
    const encryptedB64 = await Crypto.encrypt(key, text);
    const chunks = Crypto.splitPayload(encryptedB64, this.servers.length);
    const messageId = crypto.randomUUID();
    const timestamp = Math.floor(Date.now() / 1000);

    this.servers.forEach((server, i) => {
      server.postFragment({
        id: `${messageId}-${i}`,
        message_id: messageId,
        chat_id: this.chatId,
        sender_hash: this.identityHash,
        payload: chunks[i],
        ttl: 0,
        timestamp,
      });
    });

    return { messageId, chunks, encryptedB64 };
  }

  /**
   * Poll all servers for new fragments, reassemble complete messages, and
   * attempt decryption – mirroring pollActiveChat() in app.js.
   *
   * Returns the newly decrypted messages (may be empty if none are complete).
   */
  async pollMessages() {
    const N = this.servers.length;
    const key = await Crypto.importKey(this.keyB64);

    // Gather fragments grouped by message_id; server index encodes position.
    const byMessage = {};
    this.servers.forEach((server, serverIdx) => {
      for (const frag of server.getFragments(this.chatId, this.lastSince)) {
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

    const newMessages = [];
    for (const [messageId, info] of Object.entries(byMessage)) {
      // Skip already-received messages.
      if (this.receivedMessages.some(m => m.id === messageId)) continue;
      // Require all N fragments before attempting reassembly.
      if (info.fragments.size < N) continue;

      // Collect chunks in server order; skip if any position is missing.
      let complete = true;
      const ordered = [];
      for (let i = 0; i < N; i++) {
        if (!info.fragments.has(i)) { complete = false; break; }
        ordered.push(info.fragments.get(i));
      }
      if (!complete) continue;

      const reassembled = Crypto.joinPayload(ordered);
      let text;
      try {
        text = await Crypto.decrypt(key, reassembled);
      } catch {
        text = null;
      }

      const msg = {
        id: messageId,
        sender: info.sender,
        text,
        timestamp: info.timestamp,
      };
      this.receivedMessages.push(msg);
      newMessages.push(msg);
    }

    return newMessages;
  }
}

// ── Attacker helper ──────────────────────────────────────────────────────────

/**
 * Simulate an attacker who has compromised a subset of servers.
 * Collects each compromised server's fragment for the given message (in the
 * order the servers are provided) and attempts to decrypt.
 *
 * Throws if decryption fails – which is the expected outcome for any proper
 * subset of servers or when the wrong key is used.
 *
 * @param {MockServer[]} compromisedServers – subset of servers the attacker controls
 * @param {string}       messageId
 * @param {string}       chatId
 * @param {string}       keyB64   – key the attacker will try (correct or not)
 */
async function attackerDecrypt(compromisedServers, messageId, chatId, keyB64) {
  const key = await Crypto.importKey(keyB64);

  const chunks = compromisedServers
    .map(server => {
      const frag = server.getMessageFragments(messageId).find(f => f.chat_id === chatId);
      return frag ? frag.payload : null;
    })
    .filter(Boolean);

  if (chunks.length === 0) throw new Error('No fragments available');

  const reassembled = Crypto.joinPayload(chunks);
  return Crypto.decrypt(key, reassembled); // throws on auth-tag failure
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Crypto primitives', () => {
  it('encrypt → decrypt roundtrip produces the original plaintext', async () => {
    const key = await Crypto.generateKey();
    const plaintext = 'Hello, frag!';
    const ciphertext = await Crypto.encrypt(key, plaintext);
    const recovered = await Crypto.decrypt(key, ciphertext);
    assert.equal(recovered, plaintext);
  });

  it('each encryption uses a unique random IV (ciphertexts differ)', async () => {
    const key = await Crypto.generateKey();
    const c1 = await Crypto.encrypt(key, 'same plaintext');
    const c2 = await Crypto.encrypt(key, 'same plaintext');
    assert.notEqual(c1, c2, 'Two encryptions of the same plaintext must differ');
  });

  it('decryption with the wrong key throws', async () => {
    const key1 = await Crypto.generateKey();
    const key2 = await Crypto.generateKey();
    const ciphertext = await Crypto.encrypt(key1, 'secret');
    await assert.rejects(() => Crypto.decrypt(key2, ciphertext));
  });

  it('tampered ciphertext fails AES-GCM auth-tag verification', async () => {
    const key = await Crypto.generateKey();
    const ciphertext = await Crypto.encrypt(key, 'tamper me');
    // Corrupt the last few base64 characters.
    const tampered = ciphertext.slice(0, -6) + 'AAAAAA';
    await assert.rejects(() => Crypto.decrypt(key, tampered));
  });

  it('splitPayload / joinPayload roundtrip is lossless for n = 2..5', () => {
    const payload = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/==';
    for (const n of [2, 3, 4, 5]) {
      const chunks = Crypto.splitPayload(payload, n);
      assert.equal(chunks.length, n, `Expected ${n} chunks`);
      assert.equal(Crypto.joinPayload(chunks), payload, `Roundtrip failed for n=${n}`);
    }
  });

  it('identity hash is a 64-character hex string (SHA-256)', async () => {
    const hash = await Crypto.generateIdentityHash();
    assert.match(hash, /^[0-9a-f]{64}$/);
  });

  it('two identity hashes are unique', async () => {
    const h1 = await Crypto.generateIdentityHash();
    const h2 = await Crypto.generateIdentityHash();
    assert.notEqual(h1, h2);
  });
});

// ── Two-server fragmentation ──────────────────────────────────────────────────

describe('Two-server setup: message interception security', () => {
  let serverA, serverB, chatId, keyB64, messageId;
  const PLAINTEXT = 'Confidential message – two-server setup';

  before(async () => {
    serverA = new MockServer('2s-a', 'Server A');
    serverB = new MockServer('2s-b', 'Server B');

    const key = await Crypto.generateKey();
    keyB64 = await Crypto.exportKey(key);
    chatId = crypto.randomUUID();

    const sender = new MockClient('sender-2s', [serverA, serverB], chatId, keyB64);
    await sender.init();
    ({ messageId } = await sender.sendMessage(PLAINTEXT));
  });

  it('legitimate receiver with both servers decrypts correctly', async () => {
    const receiver = new MockClient('rx-2s', [serverA, serverB], chatId, keyB64);
    await receiver.init();
    const msgs = await receiver.pollMessages();
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].text, PLAINTEXT);
  });

  it('attacker with only Server A cannot reconstruct the message', async () => {
    await assert.rejects(() => attackerDecrypt([serverA], messageId, chatId, keyB64));
  });

  it('attacker with only Server B cannot reconstruct the message', async () => {
    await assert.rejects(() => attackerDecrypt([serverB], messageId, chatId, keyB64));
  });

  it('attacker with both servers but the wrong key cannot decrypt', async () => {
    const wrongKey = await Crypto.generateKey();
    const wrongKeyB64 = await Crypto.exportKey(wrongKey);
    await assert.rejects(() => attackerDecrypt([serverA, serverB], messageId, chatId, wrongKeyB64));
  });
});

// ── Three-server fragmentation ────────────────────────────────────────────────

describe('Three-server setup: message interception security', () => {
  let servers, chatId, keyB64, messageId;
  const PLAINTEXT = 'Confidential message – three-server setup';

  before(async () => {
    servers = [
      new MockServer('3s-0', 'Server 0'),
      new MockServer('3s-1', 'Server 1'),
      new MockServer('3s-2', 'Server 2'),
    ];

    const key = await Crypto.generateKey();
    keyB64 = await Crypto.exportKey(key);
    chatId = crypto.randomUUID();

    const sender = new MockClient('sender-3s', servers, chatId, keyB64);
    await sender.init();
    ({ messageId } = await sender.sendMessage(PLAINTEXT));
  });

  it('legitimate receiver with all three servers decrypts correctly', async () => {
    const receiver = new MockClient('rx-3s', servers, chatId, keyB64);
    await receiver.init();
    const msgs = await receiver.pollMessages();
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].text, PLAINTEXT);
  });

  it('attacker with only Server 0 cannot decrypt', async () => {
    await assert.rejects(() => attackerDecrypt([servers[0]], messageId, chatId, keyB64));
  });

  it('attacker with only Server 1 cannot decrypt', async () => {
    await assert.rejects(() => attackerDecrypt([servers[1]], messageId, chatId, keyB64));
  });

  it('attacker with only Server 2 cannot decrypt', async () => {
    await assert.rejects(() => attackerDecrypt([servers[2]], messageId, chatId, keyB64));
  });

  it('attacker with Servers 0 and 1 (missing Server 2) cannot decrypt', async () => {
    await assert.rejects(() =>
      attackerDecrypt([servers[0], servers[1]], messageId, chatId, keyB64));
  });

  it('attacker with Servers 0 and 2 (missing Server 1) cannot decrypt', async () => {
    await assert.rejects(() =>
      attackerDecrypt([servers[0], servers[2]], messageId, chatId, keyB64));
  });

  it('attacker with Servers 1 and 2 (missing Server 0) cannot decrypt', async () => {
    await assert.rejects(() =>
      attackerDecrypt([servers[1], servers[2]], messageId, chatId, keyB64));
  });

  it('attacker with all three servers but wrong key cannot decrypt', async () => {
    const wrongKey = await Crypto.generateKey();
    const wrongKeyB64 = await Crypto.exportKey(wrongKey);
    await assert.rejects(() => attackerDecrypt(servers, messageId, chatId, wrongKeyB64));
  });
});

// ── Multiple clients in a shared chat ────────────────────────────────────────

describe('Multiple clients in a shared three-server chat', () => {
  let servers, chatId, keyB64;
  let clientAlice, clientBob, clientCarol;

  const CONVERSATION = [
    { sender: 'alice', text: 'Hello from Alice!' },
    { sender: 'bob',   text: 'Hi Alice, Bob here.' },
    { sender: 'carol', text: 'Carol joining the chat.' },
    { sender: 'alice', text: 'Welcome, Carol!' },
    { sender: 'bob',   text: 'Great to have you here, Carol.' },
  ];

  before(async () => {
    servers = [
      new MockServer('mc-0', 'Shared Server 0'),
      new MockServer('mc-1', 'Shared Server 1'),
      new MockServer('mc-2', 'Shared Server 2'),
    ];

    const key = await Crypto.generateKey();
    keyB64 = await Crypto.exportKey(key);
    chatId = crypto.randomUUID();

    clientAlice = new MockClient('alice', servers, chatId, keyB64);
    clientBob   = new MockClient('bob',   servers, chatId, keyB64);
    clientCarol = new MockClient('carol', servers, chatId, keyB64);

    await Promise.all([clientAlice.init(), clientBob.init(), clientCarol.init()]);

    // Send all messages in order.
    const clients = { alice: clientAlice, bob: clientBob, carol: clientCarol };
    for (const { sender, text } of CONVERSATION) {
      await clients[sender].sendMessage(text);
    }
  });

  it('each server holds exactly one fragment per message (5 fragments total)', () => {
    for (const server of servers) {
      assert.equal(
        server.getFragments(chatId, 0).length,
        CONVERSATION.length,
        `${server.label} should hold ${CONVERSATION.length} fragments`,
      );
    }
  });

  it('any client that joins the chat receives all messages in full', async () => {
    const rxDave = new MockClient('dave', servers, chatId, keyB64);
    await rxDave.init();
    const msgs = await rxDave.pollMessages();
    assert.equal(msgs.length, CONVERSATION.length);

    const receivedTexts = msgs.map(m => m.text).sort();
    const expectedTexts = CONVERSATION.map(m => m.text).sort();
    assert.deepEqual(receivedTexts, expectedTexts);
  });

  it('all received messages decrypt to non-null plaintext', async () => {
    const rxEve = new MockClient('eve', servers, chatId, keyB64);
    await rxEve.init();
    const msgs = await rxEve.pollMessages();
    for (const msg of msgs) {
      assert.notEqual(msg.text, null, `Message ${msg.id} failed to decrypt`);
    }
  });

  it('compromising any single server exposes no complete message', async () => {
    for (const compromised of servers) {
      for (const frag of compromised.getFragments(chatId, 0)) {
        await assert.rejects(
          () => attackerDecrypt([compromised], frag.message_id, chatId, keyB64),
          `Single-server intercept of ${compromised.label} must not yield plaintext`,
        );
      }
    }
  });

  it('compromising any two servers still exposes no complete message', async () => {
    for (let i = 0; i < servers.length; i++) {
      for (let j = i + 1; j < servers.length; j++) {
        const pair = [servers[i], servers[j]];
        for (const frag of servers[i].getFragments(chatId, 0)) {
          await assert.rejects(
            () => attackerDecrypt(pair, frag.message_id, chatId, keyB64),
            `Two-server intercept [${i},${j}] must not yield plaintext`,
          );
        }
      }
    }
  });

  it('all server fragments combined but wrong key exposes no plaintext', async () => {
    const wrongKey = await Crypto.generateKey();
    const wrongKeyB64 = await Crypto.exportKey(wrongKey);
    for (const frag of servers[0].getFragments(chatId, 0)) {
      await assert.rejects(
        () => attackerDecrypt(servers, frag.message_id, chatId, wrongKeyB64),
        `All fragments + wrong key must not yield plaintext for message ${frag.message_id}`,
      );
    }
  });
});

// ── Chat isolation ────────────────────────────────────────────────────────────

describe('Chat isolation: cross-chat key attempts fail', () => {
  let servers, chat1Id, chat2Id, key1B64, key2B64;

  before(async () => {
    servers = [
      new MockServer('iso-0', 'Isolation Server 0'),
      new MockServer('iso-1', 'Isolation Server 1'),
    ];

    const key1 = await Crypto.generateKey();
    const key2 = await Crypto.generateKey();
    key1B64 = await Crypto.exportKey(key1);
    key2B64 = await Crypto.exportKey(key2);
    chat1Id = crypto.randomUUID();
    chat2Id = crypto.randomUUID();

    const c1 = new MockClient('c1', servers, chat1Id, key1B64);
    const c2 = new MockClient('c2', servers, chat2Id, key2B64);
    await Promise.all([c1.init(), c2.init()]);
    await c1.sendMessage('Private message in chat 1');
    await c2.sendMessage('Private message in chat 2');
  });

  it('a client in chat1 only receives chat1 messages', async () => {
    const rx1 = new MockClient('rx1', servers, chat1Id, key1B64);
    await rx1.init();
    const msgs = await rx1.pollMessages();
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].text, 'Private message in chat 1');
  });

  it('a client in chat2 only receives chat2 messages', async () => {
    const rx2 = new MockClient('rx2', servers, chat2Id, key2B64);
    await rx2.init();
    const msgs = await rx2.pollMessages();
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].text, 'Private message in chat 2');
  });

  it('chat1 key cannot decrypt chat2 fragments', async () => {
    const chat2Frag = servers[0].getFragments(chat2Id, 0)[0];
    assert.ok(chat2Frag, 'chat2 should have a fragment on server 0');
    await assert.rejects(
      () => attackerDecrypt(servers, chat2Frag.message_id, chat2Id, key1B64),
      'chat1 key must not decrypt chat2 messages',
    );
  });

  it('chat2 key cannot decrypt chat1 fragments', async () => {
    const chat1Frag = servers[0].getFragments(chat1Id, 0)[0];
    assert.ok(chat1Frag, 'chat1 should have a fragment on server 0');
    await assert.rejects(
      () => attackerDecrypt(servers, chat1Frag.message_id, chat1Id, key2B64),
      'chat2 key must not decrypt chat1 messages',
    );
  });
});

// ── Five-server setup ─────────────────────────────────────────────────────────

describe('Five-server setup: exhaustive subset interception tests', () => {
  let servers, chatId, keyB64, messageId;
  const PLAINTEXT = 'Maximum-distribution message across five independent servers';

  before(async () => {
    servers = Array.from({ length: 5 }, (_, i) =>
      new MockServer(`5s-${i}`, `Server ${i}`),
    );

    const key = await Crypto.generateKey();
    keyB64 = await Crypto.exportKey(key);
    chatId = crypto.randomUUID();

    const sender = new MockClient('sender-5s', servers, chatId, keyB64);
    await sender.init();
    ({ messageId } = await sender.sendMessage(PLAINTEXT));
  });

  it('legitimate receiver with all five servers decrypts correctly', async () => {
    const receiver = new MockClient('rx-5s', servers, chatId, keyB64);
    await receiver.init();
    const msgs = await receiver.pollMessages();
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].text, PLAINTEXT);
  });

  it('every single-server subset (5 cases) cannot decrypt', async () => {
    for (let i = 0; i < 5; i++) {
      await assert.rejects(
        () => attackerDecrypt([servers[i]], messageId, chatId, keyB64),
        `Server ${i} alone must not be sufficient`,
      );
    }
  });

  it('every two-server subset (10 cases) cannot decrypt', async () => {
    for (let i = 0; i < 5; i++) {
      for (let j = i + 1; j < 5; j++) {
        await assert.rejects(
          () => attackerDecrypt([servers[i], servers[j]], messageId, chatId, keyB64),
          `Servers [${i},${j}] must not be sufficient`,
        );
      }
    }
  });

  it('every three-server subset (10 cases) cannot decrypt', async () => {
    for (let i = 0; i < 5; i++) {
      for (let j = i + 1; j < 5; j++) {
        for (let k = j + 1; k < 5; k++) {
          await assert.rejects(
            () => attackerDecrypt([servers[i], servers[j], servers[k]], messageId, chatId, keyB64),
            `Servers [${i},${j},${k}] must not be sufficient`,
          );
        }
      }
    }
  });

  it('every four-server subset (5 cases, N-1) cannot decrypt', async () => {
    for (let skip = 0; skip < 5; skip++) {
      const subset = servers.filter((_, idx) => idx !== skip);
      await assert.rejects(
        () => attackerDecrypt(subset, messageId, chatId, keyB64),
        `Four servers (missing ${skip}) must not be sufficient`,
      );
    }
  });

  it('all five fragments combined but wrong key cannot decrypt', async () => {
    const wrongKey = await Crypto.generateKey();
    const wrongKeyB64 = await Crypto.exportKey(wrongKey);
    await assert.rejects(
      () => attackerDecrypt(servers, messageId, chatId, wrongKeyB64),
    );
  });
});
