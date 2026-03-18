#include "server.hpp"
#include "database.hpp"
#include "auth.hpp"
#include "handlers.hpp"
#include "utils.hpp"

#include <iostream>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>
#include <thread>
#include <chrono>
#include <csignal>
#include <atomic>
#include <stdexcept>

// ── Global stop flag (for signal handling) ────────────────────────────────────
static std::atomic<bool> g_stop{false};

static void on_signal(int) { g_stop = true; }

// ── Simple config reader ──────────────────────────────────────────────────────
// Reads a JSON config file.  We keep it dependency-free.

struct Config {
    int                      port{8080};
    std::vector<std::string> tokens;
    std::string              db_path{"frag.db"};
    std::string              cors_origin{"*"};
    int                      cleanup_interval_sec{3600};
    size_t                   max_payload_bytes{65536};
};

static std::string read_file(const std::string& path) {
    std::ifstream f(path);
    if (!f) throw std::runtime_error("Cannot open file: " + path);
    std::ostringstream ss;
    ss << f.rdbuf();
    return ss.str();
}

static Config load_config(const std::string& path) {
    Config cfg;
    std::string json;
    try { json = read_file(path); }
    catch (...) {
        std::cerr << "[frag] No config file at " << path
                  << "; using defaults.\n";
        return cfg;
    }

    // port
    auto port_pos = json.find("\"port\"");
    if (port_pos != std::string::npos) {
        size_t colon = json.find(':', port_pos);
        if (colon != std::string::npos) {
            try { cfg.port = std::stoi(json.substr(colon + 1)); }
            catch (...) {}
        }
    }

    // tokens array  ["tok1","tok2",...]
    auto tokens_pos = json.find("\"tokens\"");
    if (tokens_pos != std::string::npos) {
        size_t open = json.find('[', tokens_pos);
        size_t close = json.find(']', open);
        if (open != std::string::npos && close != std::string::npos) {
            std::string arr = json.substr(open + 1, close - open - 1);
            size_t p = 0;
            while (p < arr.size()) {
                size_t qs = arr.find('"', p);
                if (qs == std::string::npos) break;
                size_t qe = qs + 1;
                while (qe < arr.size()) {
                    if (arr[qe] == '\\') { qe += 2; continue; }
                    if (arr[qe] == '"')  break;
                    ++qe;
                }
                cfg.tokens.push_back(arr.substr(qs + 1, qe - qs - 1));
                p = qe + 1;
            }
        }
    }

    // db_path
    auto dbpos = json.find("\"db_path\"");
    if (dbpos != std::string::npos) {
        size_t colon = json.find(':', dbpos);
        size_t qs = json.find('"', colon + 1);
        if (qs != std::string::npos) {
            size_t qe = json.find('"', qs + 1);
            if (qe != std::string::npos)
                cfg.db_path = json.substr(qs + 1, qe - qs - 1);
        }
    }

    // cors_origin
    auto corspos = json.find("\"cors_origin\"");
    if (corspos != std::string::npos) {
        size_t colon = json.find(':', corspos);
        size_t qs = json.find('"', colon + 1);
        if (qs != std::string::npos) {
            size_t qe = json.find('"', qs + 1);
            if (qe != std::string::npos)
                cfg.cors_origin = json.substr(qs + 1, qe - qs - 1);
        }
    }

    // cleanup_interval_sec
    auto cipos = json.find("\"cleanup_interval_sec\"");
    if (cipos != std::string::npos) {
        size_t colon = json.find(':', cipos);
        if (colon != std::string::npos) {
            try { cfg.cleanup_interval_sec = std::stoi(json.substr(colon + 1)); }
            catch (...) {}
        }
    }

    // max_payload_bytes
    auto mppos = json.find("\"max_payload_bytes\"");
    if (mppos != std::string::npos) {
        size_t colon = json.find(':', mppos);
        if (colon != std::string::npos) {
            try { cfg.max_payload_bytes = (size_t)std::stoull(json.substr(colon + 1)); }
            catch (...) {}
        }
    }

    return cfg;
}

// ── Entry point ───────────────────────────────────────────────────────────────

int main(int argc, char* argv[]) {
    std::string config_path = "config.json";
    for (int i = 1; i < argc; ++i) {
        std::string arg = argv[i];
        if ((arg == "-c" || arg == "--config") && i + 1 < argc) {
            config_path = argv[++i];
        } else if (arg == "--help" || arg == "-h") {
            std::cout << "Usage: frag-server [-c config.json]\n";
            return 0;
        }
    }

    Config cfg = load_config(config_path);

    if (cfg.tokens.empty()) {
        std::cerr << "[frag] WARNING: No auth tokens configured. "
                     "Server is open to anyone!\n";
    }

    // Initialise subsystems
    try {
        Database db(cfg.db_path);
        Auth     auth(cfg.tokens);
        AppContext ctx{db, auth, cfg.max_payload_bytes};

        // Background cleanup thread
        std::thread cleanup_thread([&]() {
            while (!g_stop) {
                std::this_thread::sleep_for(
                    std::chrono::seconds(cfg.cleanup_interval_sec));
                if (g_stop) break;
                try {
                    int n = db.purge_expired();
                    if (n > 0)
                        std::cout << "[frag] Purged " << n << " expired fragments.\n";
                } catch (const std::exception& e) {
                    std::cerr << "[frag] Cleanup error: " << e.what() << "\n";
                }
            }
        });
        cleanup_thread.detach();

        // Set up signal handlers
        std::signal(SIGINT,  on_signal);
        std::signal(SIGTERM, on_signal);

        // HTTP server
        HttpServer server(cfg.port, cfg.cors_origin);
        register_routes(server, ctx);

        // Run in a separate thread so we can respond to stop signal
        std::thread server_thread([&]() {
            try { server.start(); }
            catch (const std::exception& e) {
                std::cerr << "[frag] Server error: " << e.what() << "\n";
                g_stop = true;
            }
        });

        // Wait for stop signal
        while (!g_stop) {
            std::this_thread::sleep_for(std::chrono::milliseconds(200));
        }
        server.stop();
        if (server_thread.joinable()) server_thread.join();

    } catch (const std::exception& e) {
        std::cerr << "[frag] Fatal: " << e.what() << "\n";
        return 1;
    }

    std::cout << "[frag] Server stopped.\n";
    return 0;
}
