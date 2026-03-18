#include "handlers.hpp"
#include "utils.hpp"
#include <sstream>
#include <stdexcept>
#include <iostream>

// ── Tiny JSON reader helpers ──────────────────────────────────────────────────
// We avoid pulling in nlohmann/json to keep deps minimal; the API surface is
// small enough that simple string scanning works reliably here.

namespace json_read {

static std::string extract_string(const std::string& json, const std::string& key) {
    // Find "key":"value" or "key": "value"
    std::string pattern = "\"" + key + "\"";
    size_t kpos = json.find(pattern);
    if (kpos == std::string::npos) return {};
    size_t colon = json.find(':', kpos + pattern.size());
    if (colon == std::string::npos) return {};
    size_t vstart = json.find('"', colon + 1);
    if (vstart == std::string::npos) return {};
    ++vstart;
    std::string val;
    for (size_t i = vstart; i < json.size(); ++i) {
        char c = json[i];
        if (c == '\\' && i + 1 < json.size()) {
            char nc = json[++i];
            switch (nc) {
                case '"':  val += '"';  break;
                case '\\': val += '\\'; break;
                case 'n':  val += '\n'; break;
                case 'r':  val += '\r'; break;
                case 't':  val += '\t'; break;
                default:   val += nc;   break;
            }
        } else if (c == '"') {
            break;
        } else {
            val += c;
        }
    }
    return val;
}

static long long extract_int(const std::string& json, const std::string& key,
                              long long default_val = 0) {
    std::string pattern = "\"" + key + "\"";
    size_t kpos = json.find(pattern);
    if (kpos == std::string::npos) return default_val;
    size_t colon = json.find(':', kpos + pattern.size());
    if (colon == std::string::npos) return default_val;
    size_t vstart = colon + 1;
    while (vstart < json.size() && (json[vstart] == ' ' || json[vstart] == '\t'))
        ++vstart;
    try { return std::stoll(json.substr(vstart)); }
    catch (...) { return default_val; }
}

} // namespace json_read

// ── JSON builder helpers ──────────────────────────────────────────────────────
namespace json_build {

static std::string fragment_to_json(const Fragment& f) {
    std::ostringstream o;
    o << "{"
      << "\"id\":\""              << utils::json_escape(f.id)            << "\","
      << "\"message_id\":\""      << utils::json_escape(f.message_id)    << "\","
      << "\"chat_id\":\""         << utils::json_escape(f.chat_id)       << "\","
      << "\"sender_hash\":\""     << utils::json_escape(f.sender_hash)   << "\","
      << "\"fragment_index\":"    << f.fragment_index                     << ","
      << "\"total_fragments\":"   << f.total_fragments                    << ","
      << "\"payload\":\""         << utils::json_escape(f.payload)       << "\","
      << "\"timestamp\":"         << f.timestamp                          << ","
      << "\"ttl\":"               << f.ttl
      << "}";
    return o.str();
}

static std::string fragments_array(const std::vector<Fragment>& frags) {
    std::string out = "[";
    for (size_t i = 0; i < frags.size(); ++i) {
        if (i) out += ",";
        out += fragment_to_json(frags[i]);
    }
    out += "]";
    return out;
}

} // namespace json_build

// ── Auth check helper ─────────────────────────────────────────────────────────
static bool is_authorized(const HttpRequest& req, const Auth& auth) {
    auto it = req.headers.find("authorization");
    if (it == req.headers.end()) return false;
    return auth.verify(it->second);
}

// ── Handlers ─────────────────────────────────────────────────────────────────

Handler make_health_handler() {
    return [](const HttpRequest&) -> HttpResponse {
        return HttpResponse::ok("{\"status\":\"ok\",\"version\":\"1.0.0\"}");
    };
}

Handler make_post_fragment_handler(AppContext& ctx) {
    return [&ctx](const HttpRequest& req) -> HttpResponse {
        if (!is_authorized(req, ctx.auth))
            return HttpResponse::unauthorized();

        if (req.body.empty())
            return HttpResponse::bad_request("empty body");

        if (req.body.size() > ctx.max_payload_bytes)
            return HttpResponse::payload_too_large();

        Fragment f;
        f.id              = json_read::extract_string(req.body, "id");
        f.message_id      = json_read::extract_string(req.body, "message_id");
        f.chat_id         = json_read::extract_string(req.body, "chat_id");
        f.sender_hash     = json_read::extract_string(req.body, "sender_hash");
        f.fragment_index  = (int)json_read::extract_int(req.body, "fragment_index");
        f.total_fragments = (int)json_read::extract_int(req.body, "total_fragments", 1);
        f.payload         = json_read::extract_string(req.body, "payload");
        f.ttl             = json_read::extract_int(req.body, "ttl", 0);

        if (f.id.empty())           return HttpResponse::bad_request("missing id");
        if (f.message_id.empty())   return HttpResponse::bad_request("missing message_id");
        if (f.chat_id.empty())      return HttpResponse::bad_request("missing chat_id");
        if (f.sender_hash.empty())  return HttpResponse::bad_request("missing sender_hash");
        if (f.payload.empty())      return HttpResponse::bad_request("missing payload");
        if (f.total_fragments <= 0) return HttpResponse::bad_request("invalid total_fragments");
        if (f.fragment_index < 0 || f.fragment_index >= f.total_fragments)
            return HttpResponse::bad_request("fragment_index out of range");

        f.timestamp = utils::now_seconds();
        // Auto-generate id if client sent empty (already checked above)
        // We trust the client's fragment id to allow deduplication.

        try {
            bool inserted = ctx.db.insert_fragment(f);
            if (!inserted) {
                // Already exists – idempotent success
                return HttpResponse::ok("{\"ok\":true,\"duplicate\":true}");
            }
        } catch (const std::exception& e) {
            std::cerr << "[frag] DB error on insert: " << e.what() << "\n";
            return HttpResponse::server_error("db error");
        }
        return HttpResponse::created("{\"ok\":true,\"id\":\"" +
                                     utils::json_escape(f.id) + "\"}");
    };
}

Handler make_get_fragments_handler(AppContext& ctx) {
    return [&ctx](const HttpRequest& req) -> HttpResponse {
        if (!is_authorized(req, ctx.auth))
            return HttpResponse::unauthorized();

        auto it = req.query_params.find("chat_id");
        if (it == req.query_params.end() || it->second.empty())
            return HttpResponse::bad_request("missing chat_id query param");

        std::string chat_id = it->second;
        int64_t since = 0;
        auto sit = req.query_params.find("since");
        if (sit != req.query_params.end() && !sit->second.empty()) {
            try { since = std::stoll(sit->second); }
            catch (...) { since = 0; }
        }

        try {
            auto frags = ctx.db.get_fragments(chat_id, since);
            return HttpResponse::ok(json_build::fragments_array(frags));
        } catch (const std::exception& e) {
            std::cerr << "[frag] DB error on get: " << e.what() << "\n";
            return HttpResponse::server_error("db error");
        }
    };
}

Handler make_get_message_fragments_handler(AppContext& ctx) {
    return [&ctx](const HttpRequest& req) -> HttpResponse {
        if (!is_authorized(req, ctx.auth))
            return HttpResponse::unauthorized();

        auto it = req.path_params.find("message_id");
        if (it == req.path_params.end() || it->second.empty())
            return HttpResponse::bad_request("missing message_id");

        try {
            auto frags = ctx.db.get_message_fragments(it->second);
            return HttpResponse::ok(json_build::fragments_array(frags));
        } catch (const std::exception& e) {
            std::cerr << "[frag] DB error on get_message: " << e.what() << "\n";
            return HttpResponse::server_error("db error");
        }
    };
}

Handler make_delete_fragment_handler(AppContext& ctx) {
    return [&ctx](const HttpRequest& req) -> HttpResponse {
        if (!is_authorized(req, ctx.auth))
            return HttpResponse::unauthorized();

        auto it = req.path_params.find("id");
        if (it == req.path_params.end() || it->second.empty())
            return HttpResponse::bad_request("missing id");

        try {
            bool deleted = ctx.db.delete_fragment(it->second);
            if (!deleted) return HttpResponse::not_found();
        } catch (const std::exception& e) {
            std::cerr << "[frag] DB error on delete: " << e.what() << "\n";
            return HttpResponse::server_error("db error");
        }
        return HttpResponse::no_content();
    };
}

// ── Route registration ────────────────────────────────────────────────────────

void register_routes(HttpServer& server, AppContext& ctx) {
    server.add_route("GET",    "/health",                         make_health_handler());
    server.add_route("POST",   "/api/fragments",                  make_post_fragment_handler(ctx));
    server.add_route("GET",    "/api/fragments",                  make_get_fragments_handler(ctx));
    server.add_route("GET",    "/api/fragments/:message_id/all",  make_get_message_fragments_handler(ctx));
    server.add_route("DELETE", "/api/fragments/:id",              make_delete_fragment_handler(ctx));
}
