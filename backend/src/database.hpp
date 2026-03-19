#pragma once
#include <string>
#include <vector>
#include <optional>
#include <functional>
#include <stdexcept>
#include <cstdint>
#include "sqlite3.h"
#include "utils.hpp"

struct Fragment {
    std::string id;
    std::string message_id;
    std::string chat_id;
    std::string sender_hash;
    std::string payload;    // base64-encoded encrypted chunk
    int64_t     timestamp{0};
    int64_t     ttl{0};     // 0 = never expire, else seconds-to-live from timestamp
    // Fragment ordering is implied by which server holds the fragment.
    // The sender posts chunk[i] to servers[i]; the receiver reads results[i]
    // from servers[i]. Storing position metadata here would leak the total
    // server count to anyone monitoring a single node.
};

class Database {
public:
    explicit Database(const std::string& path);
    ~Database();

    // Non-copyable
    Database(const Database&) = delete;
    Database& operator=(const Database&) = delete;

    // Store a fragment. Returns false if it already exists.
    bool insert_fragment(const Fragment& frag);

    // Fetch fragments for a chat, optionally after a given timestamp.
    std::vector<Fragment> get_fragments(const std::string& chat_id,
                                        int64_t since = 0) const;

    // Fetch all fragments belonging to a specific message.
    std::vector<Fragment> get_message_fragments(const std::string& message_id) const;

    // Delete a single fragment by id.
    bool delete_fragment(const std::string& id);

    // Remove fragments whose (timestamp + ttl) <= now and ttl > 0.
    int purge_expired();

    // Count total stored fragments.
    int64_t get_fragment_count() const;

private:
    sqlite3* db_{nullptr};

    void exec(const std::string& sql);
    void init_schema();

    // Helper to bind and step a prepared statement safely.
    template<typename Binder>
    void with_stmt(const char* sql, Binder binder) const;
};
