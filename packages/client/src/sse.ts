/**
 * Server-Sent Events parsing, as a pure incremental machine.
 *
 * No fetch, no timers, no I/O: you push bytes in with the time they arrived
 * and get frames out. That matters because two places need it — the lab
 * backend parsing the gateway's stream, and the browser parsing the backend's
 * relay of it — and a second implementation would be a second set of bugs.
 *
 * Three details that are easy to get wrong and do bite:
 *
 *  - **Decode incrementally.** A multi-byte UTF-8 character can straddle two
 *    network reads. `TextDecoder` with `{stream: true}` holds the partial
 *    sequence; decoding each read independently corrupts it.
 *  - **A frame is terminated by a blank line**, not by a read boundary. One
 *    read can carry three frames or a third of one.
 *  - **Keep malformed frames.** A frame whose payload is not JSON is a finding
 *    about the gateway, so it is recorded with `parsed` absent rather than
 *    dropped.
 */

import type { StreamChunk } from './types.js';

const DONE_SENTINEL = '[DONE]';

/** Finds the end of the first complete frame, or -1. Handles LF and CRLF. */
function frameBoundary(buffer: string): { index: number; length: number } | null {
  const lf = buffer.indexOf('\n\n');
  const crlf = buffer.indexOf('\r\n\r\n');
  if (lf === -1 && crlf === -1) return null;
  if (crlf !== -1 && (lf === -1 || crlf < lf)) return { index: crlf, length: 4 };
  return { index: lf, length: 2 };
}

export class SSEParser {
  private buffer = '';
  private readonly decoder = new TextDecoder('utf-8');
  private seq = 0;

  /** Feed one network read. `t` is ms since the request started. */
  push(bytes: Uint8Array, t: number): StreamChunk[] {
    this.buffer += this.decoder.decode(bytes, { stream: true });
    return this.drain(t);
  }

  /** Feed text directly — for tests and for already-decoded sources. */
  pushText(text: string, t: number): StreamChunk[] {
    this.buffer += text;
    return this.drain(t);
  }

  /**
   * Call once the stream has ended. Emits any trailing bytes as an
   * `incomplete` frame, because a stream cut mid-frame is exactly the kind of
   * thing worth seeing.
   */
  flush(t: number): StreamChunk[] {
    this.buffer += this.decoder.decode();
    const frames = this.drain(t);
    const rest = this.buffer.trim();
    this.buffer = '';
    if (rest.length > 0) {
      const chunk = this.parseFrame(rest, t);
      chunk.incomplete = true;
      frames.push(chunk);
    }
    return frames;
  }

  private drain(t: number): StreamChunk[] {
    const frames: StreamChunk[] = [];
    for (;;) {
      const boundary = frameBoundary(this.buffer);
      if (boundary === null) break;
      const text = this.buffer.slice(0, boundary.index);
      this.buffer = this.buffer.slice(boundary.index + boundary.length);
      if (text.trim().length === 0) continue;
      frames.push(this.parseFrame(text, t));
    }
    return frames;
  }

  private parseFrame(text: string, t: number): StreamChunk {
    const dataLines: string[] = [];
    let event: string | undefined;
    let comment = false;

    for (const rawLine of text.split(/\r?\n/)) {
      if (rawLine.length === 0) continue;
      if (rawLine.startsWith(':')) {
        comment = true;
        dataLines.push(rawLine.slice(1).trim());
        continue;
      }
      const colon = rawLine.indexOf(':');
      const field = colon === -1 ? rawLine : rawLine.slice(0, colon);
      // Per the spec a single space after the colon is part of the delimiter.
      const value = colon === -1 ? '' : rawLine.slice(colon + 1).replace(/^ /, '');
      if (field === 'data') dataLines.push(value);
      else if (field === 'event') event = value;
      // `id` and `retry` are not used by any surface here; ignored on purpose.
    }

    const raw = dataLines.join('\n');
    const chunk: StreamChunk = { seq: this.seq++, t, raw };
    if (event !== undefined) chunk.event = event;
    if (comment) chunk.comment = true;

    if (raw === DONE_SENTINEL) {
      chunk.done = true;
      return chunk;
    }
    if (!comment && raw.length > 0) {
      const trimmed = raw.trimStart();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try {
          chunk.parsed = JSON.parse(raw);
        } catch {
          // Left unparsed on purpose — a malformed frame is the finding.
        }
      }
    }
    return chunk;
  }
}
