#pragma once
#include <string>
#include <unordered_map>
#include <mutex>
#include <chrono>

/**
 * RateLimiter – simple per-IP sliding-window rate limiter.
 *
 * Each IP address is allowed at most `max_per_minute` requests within any
 * 60-second window.  When the window expires the counter resets.
 *
 * Thread-safe: an internal mutex guards the state table.
 * Setting max_per_minute = 0 disables rate limiting entirely.
 */
class RateLimiter {
public:
    explicit RateLimiter(int max_per_minute = 0) : max_(max_per_minute) {}

    /**
     * Test whether the given IP is allowed to proceed.
     * Updates internal counters as a side-effect.
     * @return true  – request is permitted.
     * @return false – request should be rejected (429 Too Many Requests).
     */
    bool allow(const std::string& ip) {
        if (max_ <= 0) return true; // disabled

        auto now = std::chrono::steady_clock::now();
        std::lock_guard<std::mutex> lock(mutex_);

        auto& entry = table_[ip];
        auto elapsed = std::chrono::duration_cast<std::chrono::seconds>(
            now - entry.window_start).count();

        if (elapsed >= 60) {
            // New window: reset counter
            entry.window_start = now;
            entry.count = 1;
            return true;
        }

        return ++entry.count <= max_;
    }

private:
    struct Entry {
        std::chrono::steady_clock::time_point window_start{};
        int count{0};
    };

    int                                      max_;
    std::mutex                               mutex_;
    std::unordered_map<std::string, Entry>   table_;
};
