#pragma once
#include <string>
#include <functional>
#include <vector>
#include <unordered_map>
#include <atomic>

// ── HTTP abstractions ─────────────────────────────────────────────────────────

struct HttpRequest {
    std::string method;
    std::string path;       // decoded, without query string
    std::unordered_map<std::string, std::string> headers;
    std::unordered_map<std::string, std::string> query_params;
    std::unordered_map<std::string, std::string> path_params;
    std::string body;
};

struct HttpResponse {
    int         status_code{200};
    std::string status_text{"OK"};
    std::string content_type{"application/json"};
    std::string body;

    // Factory helpers
    static HttpResponse ok(const std::string& b)
        { return {200, "OK", "application/json", b}; }
    static HttpResponse created(const std::string& b)
        { return {201, "Created", "application/json", b}; }
    static HttpResponse no_content()
        { return {204, "No Content", "application/json", ""}; }
    static HttpResponse bad_request(const std::string& msg)
        { return {400, "Bad Request", "application/json", "{\"error\":\"" + msg + "\"}"}; }
    static HttpResponse unauthorized()
        { return {401, "Unauthorized", "application/json", "{\"error\":\"unauthorized\"}"}; }
    static HttpResponse not_found()
        { return {404, "Not Found", "application/json", "{\"error\":\"not found\"}"}; }
    static HttpResponse method_not_allowed()
        { return {405, "Method Not Allowed", "application/json",
                  "{\"error\":\"method not allowed\"}"}; }
    static HttpResponse payload_too_large()
        { return {413, "Payload Too Large", "application/json",
                  "{\"error\":\"payload too large\"}"}; }
    static HttpResponse server_error(const std::string& msg)
        { return {500, "Internal Server Error", "application/json",
                  "{\"error\":\"" + msg + "\"}"}; }
};

using Handler = std::function<HttpResponse(const HttpRequest&)>;

struct Route {
    std::string method;   // "GET", "POST", etc.  "*" matches all
    std::string pattern;  // e.g. "/api/fragments/:id"
    Handler     handler;
};

// ── HTTP server ───────────────────────────────────────────────────────────────

class HttpServer {
public:
    HttpServer(int port, std::string cors_origin);
    ~HttpServer();

    HttpServer(const HttpServer&) = delete;
    HttpServer& operator=(const HttpServer&) = delete;

    void add_route(const std::string& method,
                   const std::string& pattern,
                   Handler            handler);

    // Blocks until stop() is called.
    void start();
    void stop();

private:
    int         port_;
    std::string cors_origin_;
    std::vector<Route> routes_;
    std::atomic<bool>  running_{false};
    int         server_fd_{-1};

    void        handle_connection(int client_fd) const;
    HttpRequest read_and_parse(int client_fd) const;
    std::string build_response(const HttpResponse& resp) const;

    static bool match_pattern(const std::string& pattern,
                              const std::string& path,
                              std::unordered_map<std::string, std::string>& params);
    static std::unordered_map<std::string, std::string>
        parse_query(const std::string& query_string);
};
