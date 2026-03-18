# frag

**Fragmented, end-to-end encrypted distributed chat.**

Messages are split across multiple independent servers so that no single server
holds a readable message. Combine that with strong end-to-end encryption and
the result is a chat system where meaningful surveillance or interception
requires compromising *every* server in a chat *and* having the encryption key.

---

## Quick start

### 1 – Run a backend node (Docker)

```bash
# Clone and enter the repo
git clone https://github.com/matt1309/frag && cd frag/backend

# Copy the example config and set your own token
cp config.example.json config.json
# Edit config.json: change the token and optionally the port

# Build and run with Docker
docker build -t frag-server .
docker run -d -p 8080:8080 -v $(pwd)/data:/app frag-server
```

Or run a three-node cluster with Docker Compose:

```bash
# Edit docker-compose.yml to set unique tokens per node
docker compose up -d
```

### 2 – Run the frontend

The frontend is a static site – no build step required.

```bash
# Serve locally (any static server will do)
cd frag/frontend
npx serve .           # or: python3 -m http.server 3000
```

Open <http://localhost:3000> in your browser.

### 3 – Build the backend from source

Requirements: C++17 compiler, CMake ≥ 3.16, SQLite3 development headers.

```bash
cd frag/backend
cmake -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build --parallel
./build/frag-server -c config.json
```

On Debian/Ubuntu: `sudo apt install libsqlite3-dev`  
On macOS (Homebrew): `brew install sqlite3`  
On Windows: use vcpkg or let CMake fetch the SQLite amalgamation automatically.

---

## Configuration

Edit `backend/config.json` (copied from `config.example.json`):

| Key | Default | Description |
|---|---|---|
| `port` | `8080` | TCP port to listen on |
| `tokens` | `[]` | Array of auth tokens (strings). Empty = no auth ⚠ |
| `db_path` | `"frag.db"` | SQLite database file path |
| `cors_origin` | `"*"` | CORS `Allow-Origin` header value |
| `cleanup_interval_sec` | `3600` | How often expired fragments are purged |
| `max_payload_bytes` | `65536` | Maximum fragment payload size (bytes) |
| `rate_limit_per_ip` | `60` | Maximum requests per IP per minute (0 = disabled) |

**Security**: use long random tokens (≥ 32 characters). Example generation:

```bash
openssl rand -hex 32
```

---

## Using the frontend

### Identity

Your identity is a SHA-256 hash of 32 random bytes, generated on first launch
and stored in `localStorage`. You can:

- **Copy** your hash to share with others (so they can identify your messages).
- **Import** a hash from another device to use the same identity everywhere.

Your identity is entirely local – the server never sees a username, only the
hash in the message metadata.

### Adding servers

Each *frag server node* needs a URL and an auth token (matching `config.json`).

Click **Servers → + Add**, enter the URL (e.g. `http://192.168.1.10:8080`),
paste the token, and optionally give it a human label.

Use **Ping** to verify all servers are reachable.

### Creating a chat

A *chat* is a named group of one or more servers. Messages are split across the
selected servers. A new AES-GCM-256 encryption key is generated automatically.

Click **Chats → + New**, name your chat, tick the servers to use, and click
**Create**.

### Sharing a chat

Click **Export** in the chat header to get a JSON blob containing:
- The list of server URLs and their tokens
- The chat ID (internal topic name used on each server)
- The AES-GCM encryption key (base64)

**Share this only over a secure channel** (Signal, face-to-face, etc.).
The recipient clicks **Chats → Join** and pastes the JSON.

### Sending & receiving

- Type a message and press **Enter** or **Send**.
- The app encrypts, fragments, and posts to all servers automatically.
- New messages are polled every 5 seconds. Partial messages (from a server that
  is temporarily down) are shown with a ⚠ indicator once all fragments arrive.

### Nicknames

Right-click any received message to assign a nickname to the sender's hash.
Nicknames are stored locally only – other users see the same raw hashes.

---

## API reference (backend)

All endpoints except `/health` require `Authorization: Bearer <token>`.

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Health check. No auth required. |
| `POST` | `/api/fragments` | Store one message fragment. |
| `GET` | `/api/fragments?chat_id=X[&since=Y]` | Fetch fragments for a chat. |
| `GET` | `/api/fragments/:message_id/all` | Fetch all fragments for a message. |
| `DELETE` | `/api/fragments/:id` | Delete a fragment by ID. |

### Fragment object

```json
{
  "id":           "uuid-string",
  "message_id":   "uuid-of-parent-message",
  "chat_id":      "uuid-of-chat",
  "sender_hash":  "sha256-hex-string",
  "payload":      "base64-encoded-encrypted-chunk",
  "timestamp":    1700000000,
  "ttl":          0
}
```

Fragment ordering is **positional** — the sender posts chunk `i` to `servers[i]`,
and the receiver reassembles using the position of each server in the shared chat
config. This means no server knows how many total servers the chat uses or where
its chunk sits in the sequence.

`ttl = 0` means the fragment is kept until manually deleted.  
`ttl > 0` means the fragment expires `ttl` seconds after `timestamp`.

---

## Security model

| Threat | Mitigation |
|---|---|
| Server compromise | Messages are encrypted (AES-GCM-256) before leaving the browser. The server stores only ciphertext. |
| Partial server capture | Each server holds only 1/N of each message's encrypted content. |
| Traffic analysis | All fragments for a message carry the same `message_id`. Hiding this requires mixing strategies (roadmap). |
| Token leakage | Use per-chat unique tokens; rotate regularly. |
| Frontend tampering | The frontend is static JS – inspect it in your browser devtools or serve it yourself. Source-confirmation via SRI (roadmap). |

---

## Project structure

```
frag/
├── backend/
│   ├── CMakeLists.txt          C++ build (CMake ≥ 3.16)
│   ├── Dockerfile              Multi-stage build
│   ├── docker-compose.yml      3-node example cluster
│   ├── config.example.json
│   └── src/
│       ├── main.cpp            Entry point & config loading
│       ├── server.hpp/cpp      Minimal HTTP/1.1 server (raw sockets)
│       ├── database.hpp/cpp    SQLite3 wrapper
│       ├── auth.hpp            Token authentication
│       ├── handlers.hpp/cpp    REST API handlers
│       └── utils.hpp           Base64, UUID, string helpers
└── frontend/
    ├── index.html              Single-page app shell
    ├── css/style.css           Dark-theme stylesheet
    └── js/
        ├── crypto.js           WebCrypto AES-GCM + fragmentation
        ├── network.js          Fetch-based API client
        ├── app.js              Application logic & state
        └── ui.js               DOM rendering & event wiring
```
