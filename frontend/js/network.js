/**
 * network.js – HTTP client for frag backend nodes
 *
 * Each server has a URL and an auth token.
 * All API calls are JSON; errors throw a NetworkError.
 */

export class NetworkError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'NetworkError';
    this.status = status;
  }
}

const Network = (() => {
  const TIMEOUT_MS = 15000;

  // ── Low-level fetch wrapper ───────────────────────────────────────────────────

  async function request(serverUrl, token, method, path, body = null) {
    const url = serverUrl.replace(/\/$/, '') + path;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const opts = {
      method,
      signal: controller.signal,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    };
    if (body !== null) opts.body = JSON.stringify(body);

    let resp;
    try {
      resp = await fetch(url, opts);
    } catch (err) {
      clearTimeout(timer);
      if (err.name === 'AbortError') throw new NetworkError('Request timed out', 0);
      throw new NetworkError(`Network error: ${err.message}`, 0);
    }
    clearTimeout(timer);

    if (resp.status === 204) return null; // no content
    const text = await resp.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }

    if (!resp.ok) {
      throw new NetworkError(
        data.error || `HTTP ${resp.status}`,
        resp.status,
      );
    }
    return data;
  }

  // ── Public API ────────────────────────────────────────────────────────────────

  /** GET /health – returns {status, version} or throws. */
  async function healthCheck(serverUrl, token) {
    return request(serverUrl, token, 'GET', '/health');
  }

  /**
   * POST /api/fragments – store one fragment on a server.
   * @param {object} server  - {url, token}
   * @param {object} fragment - {id, message_id, chat_id, sender_hash,
   *                             fragment_index, total_fragments, payload, ttl}
   */
  async function postFragment(server, fragment) {
    return request(server.url, server.token, 'POST', '/api/fragments', fragment);
  }

  /**
   * GET /api/fragments?chat_id=X[&since=Y]
   * Returns array of fragment objects.
   */
  async function getFragments(server, chatId, since = 0) {
    const qs = `?chat_id=${encodeURIComponent(chatId)}&since=${since}`;
    return request(server.url, server.token, 'GET', `/api/fragments${qs}`);
  }

  /**
   * GET /api/fragments/:message_id/all
   * Returns all fragments belonging to a message.
   */
  async function getMessageFragments(server, messageId) {
    return request(server.url, server.token, 'GET',
      `/api/fragments/${encodeURIComponent(messageId)}/all`);
  }

  /**
   * DELETE /api/fragments/:id
   */
  async function deleteFragment(server, fragmentId) {
    return request(server.url, server.token, 'DELETE',
      `/api/fragments/${encodeURIComponent(fragmentId)}`);
  }

  return {
    healthCheck,
    postFragment,
    getFragments,
    getMessageFragments,
    deleteFragment,
    NetworkError,
  };
})();

export default Network;
