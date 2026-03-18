#pragma once
#include <string>
#include <vector>
#include <unordered_set>
#include <algorithm>
#include "utils.hpp"

class Auth {
public:
    explicit Auth(std::vector<std::string> tokens)
        : tokens_(std::move(tokens)) {}

    // Returns true if the Authorization header value is valid.
    // Accepts "Bearer <token>" or raw token.
    [[nodiscard]] bool verify(const std::string& header_value) const {
        if (header_value.empty()) return false;
        std::string token = header_value;
        // Strip "Bearer " prefix (case-insensitive)
        if (utils::to_lower(header_value.substr(0, 7)) == "bearer ") {
            token = utils::trim(header_value.substr(7));
        }
        return std::find(tokens_.begin(), tokens_.end(), token) != tokens_.end();
    }

    [[nodiscard]] bool empty() const { return tokens_.empty(); }

private:
    std::vector<std::string> tokens_;
};
