# Technical Guide

A deep-dive into why frag is built the way it is.

---

## Goals

| Goal | Design choice |
|---|---|
| No single point of trust | Messages fragmented across *N* independent servers |
| Strong confidentiality | AES-GCM-256 end-to-end encryption (keys never leave the browser) |
| Minimal attack surface | No accounts, no central directory, no JS framework |
| Deployable anywhere | C++ binary with two external files (SQLite3 + system libs) |
| Cross-platform | POSIX-socket backend with `#ifdef _WIN32` Winsock2 path; CMake build |

---

## Backend

### Language: C++17

C++ provides:
- **Zero-overhead abstractions** – the binary is small and starts instantly.
- **No runtime** – no JVM, no Node.js, no Python interpreter.
- **C compatibility** – SQLite3's C API integrates directly.

The tradeoff is verbosity, especially for HTTP parsing, which is managed by
keeping the parser intentionally minimal (only what frag needs).

### Dependencies

| Library | Why | How included |
|---|---|---|
| **SQLite3** | Embedded relational storage with WAL mode | System package (`libsqlite3-dev`) or CMake auto-fetch of amalgamation |

There are deliberately no third-party HTTP frameworks. The HTTP/1.1 server
(`server.cpp`) is ~200 lines and handles exactly:
- GET, POST, DELETE, OPTIONS methods
- Content-Length body reading
- Route matching with `:param` path variables
- CORS preflight (OPTIONS → 204)
- One thread per connection (detached `std::thread`)

The JSON serialiser (`handlers.cpp`) is hand-written because the payloads are
simple and known in advance, avoiding a JSON library dependency entirely.

### HTTP server design

```
accept()
   └─ std::thread::detach
        └─ read_and_parse()   ← loops recv() until \r\n\r\n + Content-Length bytes
        └─ match_pattern()    ← /api/fragments/:id style matching
        └─ handler(req)       ← returns HttpResponse
        └─ build_response()   ← constructs HTTP/1.1 response string
        └─ send()
        └─ close()
```

Connections are short-lived (HTTP/1.0 close semantics) to keep state minimal.

### Why raw POSIX sockets instead of a library like mongoose?

**Benefits of raw sockets:**
- **Zero additional dependencies** — the binary compiles with only a C++17
  compiler and SQLite3. No vendored library to audit, update, or trust.
- **Auditability** — the entire HTTP parse path is ~200 lines of straightforward
  C++ that any contributor can read in one sitting. There are no hidden
  abstractions that could contain bugs or backdoors.
- **Deployment simplicity** — a single statically-linked binary runs on any
  Linux/macOS/Windows machine with no extra shared libraries.

**Risks of raw sockets and mitigations:**

| Risk | Mitigation in frag |
|---|---|
| Buffer overflow in request reading | `MAX_REQUEST_BYTES` cap (2 MB) on the recv loop |
| Path traversal (`/../`) | No file serving at all — every path maps to an explicit API route; unmatched paths return 404 |
| Malformed / incomplete requests | Parsing is defensive: missing fields return 400, recv has a 30-second timeout |
| Slowloris (connection kept open) | `SO_RCVTIMEO` socket option drops stalled connections after 30 s |
| HTTP request smuggling | Only `Content-Length` framing is supported; `Transfer-Encoding: chunked` is deliberately ignored |

A production hardening step (roadmap) would add TLS termination in front of the
binary (nginx, Caddy) rather than implementing TLS in the server itself — that
keeps the frag binary minimal while using a battle-tested TLS implementation.

### Database schema

```sql
CREATE TABLE fragments (
    id           TEXT PRIMARY KEY,
    message_id   TEXT NOT NULL,
    chat_id      TEXT NOT NULL,
    sender_hash  TEXT NOT NULL,
    payload      TEXT NOT NULL,
    timestamp    INTEGER NOT NULL,  -- Unix seconds (set by server on arrival)
    ttl          INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_frag_chat  ON fragments(chat_id, timestamp);
CREATE INDEX idx_frag_msg   ON fragments(message_id);
```

WAL mode is enabled for better concurrent read performance (multiple readers,
one writer at a time). A background thread runs `purge_expired()` on a
configurable interval to delete fragments where `ttl > 0 AND timestamp + ttl <= now`.

### Authentication

Token auth via `Authorization: Bearer <token>` header. Tokens are plain strings
stored in `config.json`; the server keeps them in a `std::vector<std::string>`.
Multiple tokens are supported to enable rotation (add new, remove old).

There are no per-user accounts. The *chat_id* (stored in config.json of all
participants) acts as the access namespace.

---

## Frontend

### Language: Vanilla ES6+ modules

No framework (React, Vue, etc.) and no build step. Reasons:
- **Auditability**: users can inspect the source directly in their browser.
- **Longevity**: no `npm audit` alerts, no dependency rot.
- **Security**: smaller surface area; WebCrypto is a browser built-in.

The three logical concerns map to three modules:

| Module | Responsibility |
|---|---|
| `crypto.js` | Key generation, AES-GCM encrypt/decrypt, payload split/join |
| `network.js` | Typed fetch wrappers for each backend endpoint |
| `app.js` | Application state, business logic, localStorage persistence |
| `ui.js` | DOM manipulation, event wiring, rendering |

### Encryption design

**Algorithm**: AES-GCM with a 256-bit key.
- GCM provides authenticated encryption – tampering with ciphertext is detected.
- The 96-bit IV is randomly generated per message (crypto.getRandomValues).
- The IV is prepended to the ciphertext before base64 encoding.

**Key lifecycle**:
1. Chat creator calls `crypto.subtle.generateKey` → CryptoKey object.
2. Key is exported as raw bytes → base64 string → stored in `localStorage`.
3. Participants import the same base64 string → identical CryptoKey.
4. The key never leaves the browser (no server ever sees it).

### Message fragmentation

**Why encrypt first, then split?**

The encrypt-then-split order is the only correct choice for authenticated encryption:

- Encrypting the whole message first means AES-GCM's authentication tag covers
  the *entire* ciphertext. Any tamper with any fragment is detected at decrypt time.
- If you split first then encrypt each chunk independently, you get N separate
  auth tags but lose the guarantee that the *assembled* message is authentic —
  a malicious server could substitute a different valid-looking chunk and the
  per-chunk MAC wouldn't catch cross-chunk substitution attacks.
- Splitting first also means the server sees plaintext fragment *boundaries*
  before encryption, which leaks structural information.

```
plaintext
  │ Crypto.encrypt(key, plaintext)
  ▼
[IV(12) || ciphertext || auth-tag]  ← single ArrayBuffer, tamper-evident as a whole
  │ bufToBase64()
  ▼
base64-encoded encrypted blob (string)
  │ Crypto.splitPayload(b64, N)   ← N = server count from chat config
  ▼
[chunk_0, chunk_1, ..., chunk_{N-1}]
  │ POST chunk[i] to servers[i]
  ▼
Server i stores: { message_id, payload: chunk_i }
  (no fragment_index or total_fragments stored)
```

**Why not store `fragment_index` / `total_fragments`?**

Storing the position and count on each server leaks metadata:

- A server operator (or an adversary who compromises one node) can trivially
  learn how many servers are in the chat (`total_fragments`) and where this
  piece fits in the sequence. That narrows the topology significantly.
- It is unnecessary: *both* sender and receiver hold the same ordered server
  list from the shared chat config. The sender posts `chunk[i]` to `servers[i]`;
  the receiver fetches from each server and `results[serverIndex]` is the chunk
  for that position. No positional metadata needs to cross the wire.

Reassembly:

```
Parallel GET from all N servers  →  results[0..N-1]
  │ group by message_id; position = server index
  ▼
For each message_id where all N server slots have a payload:
  ├─ ordered = [results[0][msg], results[1][msg], ..., results[N-1][msg]]
  ├─ Crypto.joinPayload(ordered)  ← simple string concatenation
  ├─ base64ToBuf()
  └─ Crypto.decrypt(key, …)
        └─ TextDecoder.decode()
              └─ plaintext displayed
```

A message where any server slot is missing is silently skipped until the
missing server comes back online.

### Polling

The frontend polls each chat's servers every 5 seconds using `setInterval`.
Each call fetches fragments with `since=lastTimestamp` to avoid re-fetching old
data. This is a simple long-short-poll approach. A proper WebSocket or
Server-Sent Events upgrade is on the roadmap.

### State persistence

`localStorage` stores:
- `identity` – `{hash}` object.
- `servers` – array of `{id, url, token, label}` (tokens stored in clear text in
  the browser's local storage – this is the browser's own trust boundary).
- `chats` – array including `keyB64` (the AES key).
- `nicknames` – hash → display name map.

In-memory only:
- Assembled message objects (re-fetched from servers on page reload).

---

## Fragmentation security analysis

Assumptions:
- N servers, each operated by independent parties in different jurisdictions.
- Messages encrypted with AES-GCM-256 before fragmentation.
- Each server sees only 1/N of the ciphertext of any message.

An adversary who compromises a single server gets:
- A set of base64 strings of approximately `len(ciphertext) / N` bytes each.
- The `chat_id`, `sender_hash`, `message_id`, and `timestamp` metadata.
- **No** decrypted content (requires both the other fragments *and* the key).

An adversary who compromises all N servers gets:
- The complete ciphertext.
- Still **no** key → AES-GCM-256 is computationally infeasible to brute-force.

Metadata leakage remains:
- `sender_hash` is visible per fragment (can be mitigated by cover traffic).
- Timing correlations between fragment arrivals reveal message boundaries.
- `message_id` links fragments on different servers (resolvable with onion routing
  or by having each server see different message IDs – roadmap).

---

## Cross-platform build notes

### Linux / macOS
```
cmake -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build
```

### Windows (MSVC via Visual Studio)
```
cmake -B build -G "Visual Studio 17 2022"
cmake --build build --config Release
```
The `ws2_32` library is linked automatically on Windows via `CMakeLists.txt`.

### Raspberry Pi / ARM
The code uses only `int`/`int64_t` widths and standard POSIX headers, making it
portable to ARM Linux out of the box.

### Static binary
```
cmake -B build -DCMAKE_BUILD_TYPE=Release -DFRAG_STATIC=ON
cmake --build build
```
Produces a self-contained binary with no external dependencies (links SQLite3
statically too, when using the bundled amalgamation).

---

## Adding a new API endpoint

1. Declare a `make_<name>_handler(AppContext&)` function in `handlers.hpp`.
2. Implement it in `handlers.cpp` following the existing pattern.
3. Register it in `register_routes()` at the bottom of `handlers.cpp`.
4. Add a corresponding `Network.<name>()` call in `frontend/js/network.js`.
