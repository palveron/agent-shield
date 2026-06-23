// src/stdio-transport.mjs
// Robust JSON-RPC-over-stdio framing for MCP. Pure + injectable (no global
// mocking) — same pattern as openclaw-config.mjs: the caller passes `onMessage`
// + `write` in, tests feed strings and capture writes.
//
// MCP stdio is newline-delimited JSON (NDJSON): one JSON object per line, no
// embedded newlines. Some legacy clients use LSP-style Content-Length framing.
// We detect the framing from the first non-blank bytes and MIRROR it on every
// response, so we interoperate with either client without configuration.

/**
 * Create a stdio transport that frames JSON-RPC messages in both NDJSON
 * (default) and Content-Length (legacy tolerance) and mirrors the detected
 * input framing on outgoing messages.
 *
 * @param {object} deps
 * @param {(msg: any) => void} deps.onMessage  Called with each parsed message.
 * @param {(chunk: string) => void} deps.write Sinks a fully-framed output chunk.
 * @param {(err: Error, raw: string) => void} [deps.onParseError] Invalid JSON —
 *        the read loop reports it and keeps running (never crashes).
 * @returns {{ push(chunk: string): void, send(payload: any): void, readonly framing: ('ndjson'|'content-length'|null) }}
 */
export function createStdioTransport({ onMessage, write, onParseError }) {
  let buffer = '';
  let framing = null; // 'ndjson' | 'content-length' — locked in on first message

  function detect(buf) {
    return /^Content-Length:/i.test(buf.replace(/^\s*/, '')) ? 'content-length' : 'ndjson';
  }

  function push(chunk) {
    buffer += chunk;
    if (framing === null && buffer.trim().length > 0) framing = detect(buffer);
    if (framing === 'content-length') drainContentLength();
    else if (framing === 'ndjson') drainNdjson();
  }

  function drainNdjson() {
    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      let line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1); // tolerate CRLF
      if (line.trim()) deliver(line);
    }
  }

  function drainContentLength() {
    while (true) {
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) break;
      const m = buffer.slice(0, headerEnd).match(/Content-Length:\s*(\d+)/i);
      if (!m) {
        buffer = buffer.slice(headerEnd + 4); // skip a header block we can't size
        continue;
      }
      const len = parseInt(m[1], 10);
      const start = headerEnd + 4;
      if (buffer.length < start + len) break; // body not fully arrived yet
      deliver(buffer.slice(start, start + len));
      buffer = buffer.slice(start + len);
    }
  }

  function deliver(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (e) {
      onParseError?.(e, raw); // never crash the loop on malformed input
      return;
    }
    onMessage(msg);
  }

  function send(payload) {
    // JSON.stringify never emits raw newlines, so the NDJSON invariant (one
    // object per line) always holds.
    const json = JSON.stringify(payload);
    if (framing === 'content-length') {
      write(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n` + json);
    } else {
      write(json + '\n'); // NDJSON default — also used before the first message
    }
  }

  return {
    push,
    send,
    get framing() {
      return framing;
    },
  };
}
