# Roadmap

Future features, known hurdles, and open research questions for frag.

---

## Near-term (v1.x)

### Core functionality

- [ ] **WebSocket / SSE support** – Replace 5-second polling with a push model.
      The backend would keep a connection open and push new fragment notifications
      to connected clients. Reduces latency and server load.

- [x] **Message TTL UI** – Expose the `ttl` field in the send UI so users can
      set per-message expiry (e.g. "delete after 24 hours").

- [ ] **Read receipts** – A lightweight acknowledgement mechanism: a small
      fragment containing only a `{type:"ack", message_id}` payload.

- [ ] **Typing indicators** – Ephemeral presence fragments with TTL = 5 seconds.

- [ ] **File / image transfer** – Chunk binary files using the existing fragment
      mechanism. Frontend adds preview rendering for common MIME types.

### Security hardening

- [x] **Subresource Integrity (SRI)** – `integrity="sha384-…"` attributes are
      added to `<script>` and `<link>` tags in `index.html` so browsers verify
      the JS/CSS hasn't been tampered with. Run `node scripts/generate-sri.js`
      to recompute hashes after any asset change.

- [x] **Content Security Policy (CSP)** – `index.html` ships with a strict CSP
      `<meta>` tag (`script-src 'self'`; `connect-src *` to allow user-configured
      server origins).

- [ ] **Token rotation** – API endpoint to invalidate an old token after adding
      a new one, without downtime.

- [x] **Rate limiting** – Per-IP and per-token request rate caps to prevent
      fragment flooding or enumeration attacks.

- [ ] **Separate `message_id` per server** – Currently all N fragments share the
      same `message_id`, allowing a network observer who can see traffic to all N
      servers to correlate them. Using per-server encrypted identifiers (HMAC of
      real ID + server-specific secret) prevents cross-server linkage.

- [ ] **Cover traffic** – Optionally send dummy fragments at a constant rate so
      timing analysis cannot reveal when real messages are sent.

---

## Medium-term (v2.x)

### Multi-device sync

- [ ] **Encrypted identity backup** – Export the identity hash and per-chat keys
      as a password-protected bundle (PBKDF2 + AES-GCM). Users paste the
      bundle on a new device and enter their passphrase.

- [ ] **Key ratchet / forward secrecy** – Implement a Double Ratchet-style key
      advancement so compromise of the current key does not expose past messages.
      This is the primary cryptographic upgrade for v2.

### Server discovery & setup

- [ ] **Secure server-config sharing** – A one-time-use QR code or short-lived
      URL that encodes connection details (URL + token + chat key), displayed by
      one client and scanned/followed by another. The link expires after first use.

- [ ] **Server health dashboard** – An in-app view showing uptime, fragment
      counts, storage used, and last-seen timestamps per server.

- [ ] **HTTPS / TLS termination guide** – Documentation and example configs for
      terminating TLS in front of the frag binary (nginx, Caddy, Traefik).
      The binary itself does not handle TLS to keep it minimal.

- [ ] **Tor / I2P transport** – Run the backend as a hidden service so the
      server IP is not disclosed in the chat config JSON.

### UX improvements

- [x] **Unread message badges** – Count new fragments received for non-active
      chats and display a badge on the chat list entry.

- [ ] **Search** – Client-side full-text search of decrypted message history
      (stored in an IndexedDB cache).

- [ ] **Offline queue** – Buffer outgoing messages locally (IndexedDB) and
      retry posting fragments when servers come back online.

- [ ] **Emoji reactions** – Small encrypted fragments containing `{type:"react",
      message_id, emoji}`.

---

## Long-term / research

- [ ] **Alternative encryption** – Pluggable cipher suite: allow
      XChaCha20-Poly1305 as an alternative to AES-GCM for hardware without
      AES acceleration.

- [ ] **Post-quantum key exchange** – Use ML-KEM (Kyber) for initial key
      agreement once it is available in WebCrypto.

- [ ] **Onion routing between servers** – Each server only knows the next hop,
      not the origin, using a layered encryption scheme inspired by Tor's cell
      protocol.

- [ ] **Native mobile clients** – Android/iOS apps using the same protocol but
      with background push notifications instead of polling.

- [ ] **Federated server list** – An optional, opt-in DHT or gossip layer where
      servers can announce availability without a central registry.

---

## Known hurdles

| Hurdle | Notes |
|---|---|
| **No forward secrecy today** | The static AES key means past messages are exposed if the key leaks. Double Ratchet is the planned fix. |
| **`message_id` cross-server linkage** | An adversary watching all servers can correlate fragments. Per-server IDs (roadmap) fix this. |
| **No message ordering guarantee** | Fragments from different servers may arrive out of order. The frontend sorts by `timestamp` (server-set), which relies on server clock accuracy. |
| **localStorage trust boundary** | Keys and tokens are stored in `localStorage`, accessible to any JS on the same origin. A dedicated browser extension or native app would provide better key isolation. |
| **No key revocation** | If a chat key is compromised, there is no mechanism to rotate it in-band. Users must create a new chat and share new config. |
| **Server downtime = incomplete messages** | If a server goes down permanently, fragments on it are lost. Replication within a server cluster (primary + replica) would mitigate this. |
| **No spam/abuse prevention** | Any token holder can post arbitrary fragments. Content moderation is out of scope by design but rate limiting helps. |
