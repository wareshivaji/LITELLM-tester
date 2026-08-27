import { SSEParser } from '../dist/index.js';

const enc = new TextEncoder();
let pass = 0;
let fail = 0;

function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}\n          expected ${e}\n          actual   ${a}`);
  }
}

console.log('=== P3-01 SSE parser ===');

// 1. A frame split across two reads must not emit until the blank line arrives.
{
  const p = new SSEParser();
  const first = p.push(enc.encode('data: {"a":1}\n'), 0);
  const second = p.push(enc.encode('\n'), 5);
  check('frame split across reads: nothing emitted early', first.length, 0);
  check('frame split across reads: emitted on blank line', second.length, 1);
  check('frame split across reads: payload intact', second[0].parsed, { a: 1 });
  check('frame split across reads: arrival time is the completing read', second[0].t, 5);
}

// 2. Several frames in one read.
{
  const p = new SSEParser();
  const out = p.push(enc.encode('data: {"n":1}\n\ndata: {"n":2}\n\ndata: {"n":3}\n\n'), 1);
  check('three frames in one read', out.map((c) => c.parsed.n), [1, 2, 3]);
  check('sequence numbers increment', out.map((c) => c.seq), [0, 1, 2]);
}

// 3. CRLF line endings.
{
  const p = new SSEParser();
  const out = p.push(enc.encode('data: {"crlf":true}\r\n\r\n'), 0);
  check('CRLF frame parsed', out[0]?.parsed, { crlf: true });
}

// 4. A multi-byte character split across reads — the classic corruption.
{
  const p = new SSEParser();
  const bytes = enc.encode('data: {"t":"café ☕"}\n\n');
  // Split inside the 2-byte é (and again inside the 3-byte ☕).
  const cut = bytes.indexOf(0xc3) + 1;
  const a = p.push(bytes.slice(0, cut), 0);
  const b = p.push(bytes.slice(cut), 1);
  const frames = [...a, ...b];
  check('multi-byte split mid-character: one frame', frames.length, 1);
  check('multi-byte split mid-character: text intact', frames[0]?.parsed?.t, 'café ☕');
}

// 5. A payload that is not JSON is kept, not dropped.
{
  const p = new SSEParser();
  const out = p.push(enc.encode('data: {"unterminated": \n\n'), 0);
  check('malformed JSON: frame still emitted', out.length, 1);
  check('malformed JSON: raw preserved', out[0]?.raw, '{"unterminated": ');
  check('malformed JSON: parsed absent', out[0]?.parsed, undefined);
}

// 6. The [DONE] sentinel.
{
  const p = new SSEParser();
  const out = p.push(enc.encode('data: [DONE]\n\n'), 0);
  check('[DONE] flagged', out[0]?.done, true);
  check('[DONE] not parsed as JSON', out[0]?.parsed, undefined);
}

// 7. Comment / keep-alive lines.
{
  const p = new SSEParser();
  const out = p.push(enc.encode(': ping\n\n'), 0);
  check('comment flagged', out[0]?.comment, true);
}

// 8. A stream cut mid-frame.
{
  const p = new SSEParser();
  p.push(enc.encode('data: {"a":1}\n\ndata: {"b":2}'), 0);
  const out = p.flush(9);
  check('trailing partial frame emitted on flush', out.length, 1);
  check('trailing partial frame flagged incomplete', out[0]?.incomplete, true);
  check('trailing partial frame still parsed', out[0]?.parsed, { b: 2 });
}

// 9. Anthropic-style named events.
{
  const p = new SSEParser();
  const out = p.push(
    enc.encode('event: content_block_delta\ndata: {"type":"content_block_delta"}\n\n'),
    0,
  );
  check('event name captured', out[0]?.event, 'content_block_delta');
}

// 10. Multiple data: lines in one frame join with a newline.
{
  const p = new SSEParser();
  const out = p.push(enc.encode('data: line1\ndata: line2\n\n'), 0);
  check('multi-line data joined', out[0]?.raw, 'line1\nline2');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
