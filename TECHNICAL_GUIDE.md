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

### Database schema

```sql
CREATE TABLE fragments (
    id               TEXT PRIMARY KEY,
    message_id       TEXT NOT NULL,
    chat_id          TEXT NOT NULL,
    sender_hash      TEXT NOT NULL,
    fragment_index   INTEGER NOT NULL,
    total_fragments  INTEGER NOT NULL,
    payload          TEXT NOT NULL,
    timestamp        INTEGER NOT NULL,  -- Unix seconds (set by server on arrival)
    ttl              INTEGER NOT NULL DEFAULT 0
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

```
plaintext
  │ Crypto.encrypt(key, plaintext)
  ▼
[IV(12) || ciphertext || auth-tag]  ← single ArrayBuffer
  │ bufToBase64()
  ▼
base64-encoded encrypted blob (string)
  │ Crypto.splitPayload(b64, N)   ← N = server count
  ▼
[chunk_0, chunk_1, ..., chunk_{N-1}]
  │ POST each chunk to servers[i]
  ▼
Server i stores:  { message_id, fragment_index: i, total_fragments: N, payload: chunk_i }
```

Reassembly:

```
GET fragments from all N servers
  │ group by message_id
  ▼
For each complete message (all N chunks present):
  ├─ sort by fragment_index
  ├─ Crypto.joinPayload(chunks)  ← simple string concatenation
  ├─ base64ToBuf()
  └─ Crypto.decrypt(key, …)
        └─ TextDecoder.decode()
              └─ plaintext displayed
```

A message with fewer than `total_fragments` chunks present is silently skipped
until the missing server(s) come back online.

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
