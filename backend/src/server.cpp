#include "server.hpp"
#include "utils.hpp"
#include <cstring>
#include <sstream>
#include <algorithm>
#include <stdexcept>
#include <thread>
#include <iostream>

#ifdef _WIN32
  #include <winsock2.h>
  #include <ws2tcpip.h>
  using socket_t = SOCKET;
  #define SOCK_INVALID INVALID_SOCKET
  static void close_sock(socket_t s) { closesocket(s); }
#else
  #include <sys/socket.h>
  #include <netinet/in.h>
  #include <arpa/inet.h>
  #include <unistd.h>
  using socket_t = int;
  #define SOCK_INVALID (-1)
  static void close_sock(socket_t s) { close(s); }
#endif

static constexpr size_t MAX_REQUEST_BYTES = 2 * 1024 * 1024; // 2 MB
static constexpr int    RECV_TIMEOUT_SEC  = 30;

// ── Lifecycle ─────────────────────────────────────────────────────────────────

HttpServer::HttpServer(int port, std::string cors_origin)
    : port_(port), cors_origin_(std::move(cors_origin)) {
#ifdef _WIN32
    WSADATA wsa;
    WSAStartup(MAKEWORD(2, 2), &wsa);
#endif
}

HttpServer::~HttpServer() {
    stop();
#ifdef _WIN32
    WSACleanup();
#endif
}

void HttpServer::add_route(const std::string& method,
                           const std::string& pattern,
                           Handler handler) {
    routes_.push_back({method, pattern, std::move(handler)});
}

// ── Start / Stop ──────────────────────────────────────────────────────────────

void HttpServer::start() {
    server_fd_ = (int)socket(AF_INET, SOCK_STREAM, 0);
    if (server_fd_ == SOCK_INVALID)
        throw std::runtime_error("socket() failed");

    int opt = 1;
#ifdef _WIN32
    setsockopt((socket_t)server_fd_, SOL_SOCKET, SO_REUSEADDR,
               (const char*)&opt, sizeof(opt));
#else
    setsockopt(server_fd_, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));
#endif

    sockaddr_in addr{};
    addr.sin_family      = AF_INET;
    addr.sin_addr.s_addr = INADDR_ANY;
    addr.sin_port        = htons((uint16_t)port_);

    if (bind(server_fd_, (sockaddr*)&addr, sizeof(addr)) < 0)
        throw std::runtime_error("bind() failed on port " + std::to_string(port_));
    if (listen(server_fd_, SOMAXCONN) < 0)
        throw std::runtime_error("listen() failed");

    running_ = true;
    std::cout << "[frag] Server listening on port " << port_ << "\n" << std::flush;

    while (running_) {
        sockaddr_in client_addr{};
        socklen_t   client_len = sizeof(client_addr);
        int client_fd = (int)accept(server_fd_, (sockaddr*)&client_addr, &client_len);
        if (client_fd < 0) {
            if (!running_) break;
            continue;
        }
        std::thread([this, client_fd]() {
            try { handle_connection(client_fd); }
            catch (const std::exception& e) {
                std::cerr << "[frag] Connection error: " << e.what() << "\n";
            }
            close_sock(client_fd);
        }).detach();
    }
}

void HttpServer::stop() {
    running_ = false;
    if (server_fd_ != SOCK_INVALID) {
        close_sock(server_fd_);
        server_fd_ = SOCK_INVALID;
    }
}

// ── Connection handler ────────────────────────────────────────────────────────

void HttpServer::handle_connection(int client_fd) const {
    HttpRequest req = read_and_parse(client_fd);

    // CORS preflight
    if (req.method == "OPTIONS") {
        HttpResponse resp = HttpResponse::no_content();
        std::string raw = build_response(resp);
        send(client_fd, raw.c_str(), (int)raw.size(), 0);
        return;
    }

    // Route matching
    HttpResponse resp = HttpResponse::not_found();
    bool method_matched = false;

    for (const auto& route : routes_) {
        std::unordered_map<std::string, std::string> params;
        if (!match_pattern(route.pattern, req.path, params)) continue;

        if (route.method != "*" && route.method != req.method) {
            method_matched = true; // path matched but wrong method
            continue;
        }
        auto mutable_req = req;
        mutable_req.path_params = std::move(params);
        resp = route.handler(mutable_req);
        method_matched = false; // handled
        goto send_response;
    }
    if (method_matched) resp = HttpResponse::method_not_allowed();

send_response:
    std::string raw = build_response(resp);
    send(client_fd, raw.c_str(), (int)raw.size(), 0);
}

// ── Request reading & parsing ─────────────────────────────────────────────────

HttpRequest HttpServer::read_and_parse(int client_fd) const {
    // Set a receive timeout so we don't block forever
#ifdef _WIN32
    DWORD tv = RECV_TIMEOUT_SEC * 1000;
    setsockopt((socket_t)client_fd, SOL_SOCKET, SO_RCVTIMEO,
               (const char*)&tv, sizeof(tv));
#else
    struct timeval tv{RECV_TIMEOUT_SEC, 0};
    setsockopt(client_fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
#endif

    std::string raw;
    raw.reserve(4096);
    char buf[8192];

    bool   headers_done  = false;
    size_t content_length = 0;
    size_t headers_end    = 0;

    while (raw.size() < MAX_REQUEST_BYTES) {
        ssize_t n = recv(client_fd, buf, sizeof(buf), 0);
        if (n <= 0) break;
        raw.append(buf, n);

        if (!headers_done) {
            size_t pos = raw.find("\r\n\r\n");
            if (pos != std::string::npos) {
                headers_done = true;
                headers_end  = pos + 4;
                // Extract Content-Length (case-insensitive search in header section)
                std::string hdr_section = utils::to_lower(raw.substr(0, headers_end));
                size_t cl_pos = hdr_section.find("\r\ncontent-length:");
                if (cl_pos != std::string::npos) {
                    size_t val_start = cl_pos + 17; // length of "\r\ncontent-length:"
                    size_t val_end   = hdr_section.find("\r\n", val_start);
                    std::string cl_str = utils::trim(hdr_section.substr(
                        val_start, val_end - val_start));
                    try { content_length = std::stoull(cl_str); }
                    catch (...) { content_length = 0; }
                }
            }
        }
        if (headers_done && raw.size() >= headers_end + content_length) break;
    }

    // ── Parse ────────────────────────────────────────────────────────────────
    HttpRequest req;
    if (raw.empty()) return req;

    // Request line
    size_t line_end = raw.find("\r\n");
    if (line_end == std::string::npos) return req;

    std::string request_line = raw.substr(0, line_end);
    size_t m_end = request_line.find(' ');
    if (m_end == std::string::npos) return req;
    req.method = request_line.substr(0, m_end);

    size_t p_start = m_end + 1;
    size_t p_end   = request_line.find(' ', p_start);
    if (p_end == std::string::npos) p_end = request_line.size();
    std::string raw_path = request_line.substr(p_start, p_end - p_start);

    size_t qpos = raw_path.find('?');
    if (qpos != std::string::npos) {
        req.path        = utils::url_decode(raw_path.substr(0, qpos));
        req.query_params = parse_query(raw_path.substr(qpos + 1));
    } else {
        req.path = utils::url_decode(raw_path);
    }

    // Headers
    size_t pos = line_end + 2;
    while (pos < raw.size()) {
        size_t end = raw.find("\r\n", pos);
        if (end == std::string::npos || end == pos) break;
        std::string header = raw.substr(pos, end - pos);
        size_t colon = header.find(':');
        if (colon != std::string::npos) {
            std::string key = utils::to_lower(utils::trim(header.substr(0, colon)));
            std::string val = utils::trim(header.substr(colon + 1));
            req.headers[key] = val;
        }
        pos = end + 2;
    }

    // Body
    if (headers_end > 0 && raw.size() > headers_end) {
        req.body = raw.substr(headers_end);
    }

    return req;
}

// ── Response builder ──────────────────────────────────────────────────────────

std::string HttpServer::build_response(const HttpResponse& resp) const {
    std::string status_map;
    // Use the resp's status_text if provided; fall back to a default.
    std::string status_text = resp.status_text.empty() ? "OK" : resp.status_text;

    std::ostringstream out;
    out << "HTTP/1.1 " << resp.status_code << " " << status_text << "\r\n";
    out << "Content-Type: "   << resp.content_type << "; charset=utf-8\r\n";
    out << "Content-Length: " << resp.body.size()  << "\r\n";
    out << "Connection: close\r\n";
    out << "Access-Control-Allow-Origin: "  << cors_origin_ << "\r\n";
    out << "Access-Control-Allow-Methods: GET, POST, DELETE, OPTIONS\r\n";
    out << "Access-Control-Allow-Headers: Content-Type, Authorization\r\n";
    out << "\r\n";
    out << resp.body;
    return out.str();
}

// ── Pattern matching ──────────────────────────────────────────────────────────

bool HttpServer::match_pattern(const std::string& pattern,
                               const std::string& path,
                               std::unordered_map<std::string, std::string>& params) {
    auto pp = utils::split(pattern, '/');
    auto cp = utils::split(path, '/');
    if (pp.size() != cp.size()) return false;
    for (size_t i = 0; i < pp.size(); ++i) {
        if (!pp[i].empty() && pp[i][0] == ':') {
            params[pp[i].substr(1)] = cp[i];
        } else if (pp[i] != cp[i]) {
            return false;
        }
    }
    return true;
}

std::unordered_map<std::string, std::string>
HttpServer::parse_query(const std::string& qs) {
    std::unordered_map<std::string, std::string> result;
    for (const auto& pair : utils::split(qs, '&')) {
        size_t eq = pair.find('=');
        if (eq == std::string::npos) {
            result[utils::url_decode(pair)] = "";
        } else {
            result[utils::url_decode(pair.substr(0, eq))] =
                utils::url_decode(pair.substr(eq + 1));
        }
    }
    return result;
}
