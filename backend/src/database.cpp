#include "database.hpp"
#include <stdexcept>
#include <string>
#include <cstring>

// ── Helpers ───────────────────────────────────────────────────────────────────

static void check(int rc, const char* context = "") {
    if (rc != SQLITE_OK && rc != SQLITE_ROW && rc != SQLITE_DONE) {
        throw std::runtime_error(std::string("SQLite error (") + context + "): " +
                                 std::to_string(rc));
    }
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

Database::Database(const std::string& path) {
    int rc = sqlite3_open(path.c_str(), &db_);
    check(rc, "open");
    exec("PRAGMA journal_mode=WAL");
    exec("PRAGMA synchronous=NORMAL");
    exec("PRAGMA foreign_keys=ON");
    init_schema();
}

Database::~Database() {
    if (db_) sqlite3_close(db_);
}

void Database::exec(const std::string& sql) {
    char* err = nullptr;
    int rc = sqlite3_exec(db_, sql.c_str(), nullptr, nullptr, &err);
    if (rc != SQLITE_OK) {
        std::string msg = err ? err : "(unknown)";
        sqlite3_free(err);
        throw std::runtime_error("SQLite exec error: " + msg);
    }
}

void Database::init_schema() {
    exec(R"sql(
        CREATE TABLE IF NOT EXISTS fragments (
            id               TEXT PRIMARY KEY,
            message_id       TEXT NOT NULL,
            chat_id          TEXT NOT NULL,
            sender_hash      TEXT NOT NULL,
            payload          TEXT NOT NULL,
            timestamp        INTEGER NOT NULL,
            ttl              INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_frag_chat
            ON fragments(chat_id, timestamp);
        CREATE INDEX IF NOT EXISTS idx_frag_msg
            ON fragments(message_id);
    )sql");
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

bool Database::insert_fragment(const Fragment& f) {
    const char* sql =
        "INSERT OR IGNORE INTO fragments "
        "(id, message_id, chat_id, sender_hash, payload, timestamp, ttl) "
        "VALUES (?,?,?,?,?,?,?)";
    sqlite3_stmt* stmt = nullptr;
    check(sqlite3_prepare_v2(db_, sql, -1, &stmt, nullptr), "prepare insert");

    sqlite3_bind_text(stmt, 1, f.id.c_str(),           -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 2, f.message_id.c_str(),   -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 3, f.chat_id.c_str(),      -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 4, f.sender_hash.c_str(),  -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 5, f.payload.c_str(),      -1, SQLITE_TRANSIENT);
    sqlite3_bind_int64(stmt, 6, f.timestamp);
    sqlite3_bind_int64(stmt, 7, f.ttl);

    int rc = sqlite3_step(stmt);
    sqlite3_finalize(stmt);
    check(rc, "step insert");
    return sqlite3_changes(db_) > 0;
}

std::vector<Fragment> Database::get_fragments(const std::string& chat_id,
                                               int64_t since) const {
    const char* sql =
        "SELECT id, message_id, chat_id, sender_hash, payload, timestamp, ttl "
        "FROM fragments "
        "WHERE chat_id = ? AND timestamp > ? "
        "ORDER BY timestamp ASC";
    sqlite3_stmt* stmt = nullptr;
    check(sqlite3_prepare_v2(db_, sql, -1, &stmt, nullptr), "prepare get");
    sqlite3_bind_text(stmt, 1, chat_id.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_int64(stmt, 2, since);

    std::vector<Fragment> results;
    while (sqlite3_step(stmt) == SQLITE_ROW) {
        Fragment f;
        auto col_text = [&](int c) -> std::string {
            const char* p = (const char*)sqlite3_column_text(stmt, c);
            return p ? p : "";
        };
        f.id          = col_text(0);
        f.message_id  = col_text(1);
        f.chat_id     = col_text(2);
        f.sender_hash = col_text(3);
        f.payload     = col_text(4);
        f.timestamp   = sqlite3_column_int64(stmt, 5);
        f.ttl         = sqlite3_column_int64(stmt, 6);
        results.push_back(std::move(f));
    }
    sqlite3_finalize(stmt);
    return results;
}

std::vector<Fragment> Database::get_message_fragments(const std::string& message_id) const {
    const char* sql =
        "SELECT id, message_id, chat_id, sender_hash, payload, timestamp, ttl "
        "FROM fragments WHERE message_id = ? ORDER BY timestamp ASC";
        // Note: ordering by timestamp is for display consistency only.
        // Reassembly order is determined by server position in the chat config,
        // not by any field stored here.
    sqlite3_stmt* stmt = nullptr;
    check(sqlite3_prepare_v2(db_, sql, -1, &stmt, nullptr), "prepare get_msg");
    sqlite3_bind_text(stmt, 1, message_id.c_str(), -1, SQLITE_TRANSIENT);

    std::vector<Fragment> results;
    while (sqlite3_step(stmt) == SQLITE_ROW) {
        Fragment f;
        auto col_text = [&](int c) -> std::string {
            const char* p = (const char*)sqlite3_column_text(stmt, c);
            return p ? p : "";
        };
        f.id          = col_text(0);
        f.message_id  = col_text(1);
        f.chat_id     = col_text(2);
        f.sender_hash = col_text(3);
        f.payload     = col_text(4);
        f.timestamp   = sqlite3_column_int64(stmt, 5);
        f.ttl         = sqlite3_column_int64(stmt, 6);
        results.push_back(std::move(f));
    }
    sqlite3_finalize(stmt);
    return results;
}

bool Database::delete_fragment(const std::string& id) {
    const char* sql = "DELETE FROM fragments WHERE id = ?";
    sqlite3_stmt* stmt = nullptr;
    check(sqlite3_prepare_v2(db_, sql, -1, &stmt, nullptr), "prepare delete");
    sqlite3_bind_text(stmt, 1, id.c_str(), -1, SQLITE_TRANSIENT);
    int rc = sqlite3_step(stmt);
    sqlite3_finalize(stmt);
    check(rc, "step delete");
    return sqlite3_changes(db_) > 0;
}

int Database::purge_expired() {
    int64_t now = utils::now_seconds();
    const char* sql =
        "DELETE FROM fragments WHERE ttl > 0 AND (timestamp + ttl) <= ?";
    sqlite3_stmt* stmt = nullptr;
    check(sqlite3_prepare_v2(db_, sql, -1, &stmt, nullptr), "prepare purge");
    sqlite3_bind_int64(stmt, 1, now);
    sqlite3_step(stmt);
    int deleted = sqlite3_changes(db_);
    sqlite3_finalize(stmt);
    return deleted;
}

int64_t Database::get_fragment_count() const {
    const char* sql = "SELECT COUNT(*) FROM fragments";
    sqlite3_stmt* stmt = nullptr;
    check(sqlite3_prepare_v2(db_, sql, -1, &stmt, nullptr), "prepare count");
    int64_t count = 0;
    if (sqlite3_step(stmt) == SQLITE_ROW)
        count = sqlite3_column_int64(stmt, 0);
    sqlite3_finalize(stmt);
    return count;
}
