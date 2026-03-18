#pragma once
#include <string>
#include <functional>
#include "server.hpp"
#include "database.hpp"
#include "auth.hpp"

// ── App context ───────────────────────────────────────────────────────────────
struct AppContext {
    Database& db;
    Auth&     auth;
    size_t    max_payload_bytes;
};

// ── Handler registrations ─────────────────────────────────────────────────────

// GET /health
// Returns {"status":"ok","version":"1.0.0"}
Handler make_health_handler();

// POST /api/fragments
// Body: JSON fragment object
// Requires Authorization header
Handler make_post_fragment_handler(AppContext& ctx);

// GET /api/fragments?chat_id=X[&since=Y]
// Requires Authorization header
Handler make_get_fragments_handler(AppContext& ctx);

// GET /api/fragments/:message_id/all
// Returns all fragments for a message_id
Handler make_get_message_fragments_handler(AppContext& ctx);

// DELETE /api/fragments/:id
// Requires Authorization header
Handler make_delete_fragment_handler(AppContext& ctx);

// Register all routes on the given server.
void register_routes(HttpServer& server, AppContext& ctx);
