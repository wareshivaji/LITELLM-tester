// Package sse parses Server-Sent Events as a pure incremental machine.
//
// No HTTP, no timers, no I/O: bytes go in with the time they arrived and frames
// come out. That separation is why the same parser serves both the code reading
// the gateway's stream and the code reading the lab's relay of it — a second
// implementation would be a second set of bugs.
//
// Ported from `packages/client/src/sse.ts` and verified against the same golden
// fixtures its 20 TypeScript tests use. Three details are easy to get wrong and
// all three have bitten this codebase:
//
//   - **Decode incrementally.** A multi-byte UTF-8 character can straddle two
//     network reads. Go's `utf8.DecodeRune` on a partial buffer returns
//     RuneError, so the tail has to be carried forward rather than decoded.
//   - **A frame ends at a blank line**, not at a read boundary. One read can
//     carry three frames or a third of one.
//   - **Keep malformed frames.** A payload that is not JSON is a finding about
//     the gateway, so it is recorded with Parsed absent rather than dropped.
package sse

import (
	"encoding/json"
	"strings"
	"unicode/utf8"
)

const doneSentinel = "[DONE]"

// Chunk is one frame. Field names match the TypeScript `StreamChunk` so the
// golden fixtures compare directly.
type Chunk struct {
	Seq int     `json:"seq"`
	T   float64 `json:"t"`
	// Raw is the joined `data:` lines, newline-separated.
	Raw string `json:"raw"`
	// Event is the `event:` field when present.
	Event string `json:"event,omitempty"`
	// Parsed is set only when Raw was JSON. Absent is meaningful.
	Parsed json.RawMessage `json:"parsed,omitempty"`
	// Done marks the `[DONE]` sentinel.
	Done bool `json:"done,omitempty"`
	// Incomplete marks a frame the stream was cut in the middle of.
	Incomplete bool `json:"incomplete,omitempty"`
	// Comment marks a `:` keep-alive line.
	Comment bool `json:"comment,omitempty"`
}

// Parser accumulates bytes and emits frames.
//
// Not safe for concurrent use: one parser belongs to one stream, and sharing
// one across streams would interleave two conversations into nonsense.
type Parser struct {
	buffer  strings.Builder
	partial []byte // bytes of an incomplete UTF-8 rune, carried to the next read
	seq     int
}

// Push feeds one network read. t is milliseconds since the request started.
func (p *Parser) Push(b []byte, t float64) []Chunk {
	// Prepend whatever was left mid-rune last time, then hold back a trailing
	// incomplete rune rather than decoding it into RuneError. Decoding each
	// read independently is how a multi-byte character gets corrupted.
	data := b
	if len(p.partial) > 0 {
		data = append(append([]byte{}, p.partial...), b...)
		p.partial = nil
	}
	if cut := incompleteTail(data); cut > 0 {
		p.partial = append([]byte{}, data[len(data)-cut:]...)
		data = data[:len(data)-cut]
	}
	p.buffer.WriteString(string(data))
	return p.drain(t)
}

// PushText feeds already-decoded text, for tests and non-byte sources.
func (p *Parser) PushText(s string, t float64) []Chunk {
	p.buffer.WriteString(s)
	return p.drain(t)
}

// Flush ends the stream. Any trailing bytes become an Incomplete frame,
// because a stream cut mid-frame is exactly the kind of thing worth seeing.
func (p *Parser) Flush(t float64) []Chunk {
	if len(p.partial) > 0 {
		// An unterminated rune at end of stream is itself damage; emit the
		// bytes rather than silently discarding them.
		p.buffer.WriteString(string(p.partial))
		p.partial = nil
	}
	frames := p.drain(t)
	rest := strings.TrimSpace(p.buffer.String())
	p.buffer.Reset()
	if rest != "" {
		c := p.parseFrame(rest, t)
		c.Incomplete = true
		frames = append(frames, c)
	}
	return frames
}

// incompleteTail returns how many trailing bytes form a partial UTF-8 rune.
func incompleteTail(b []byte) int {
	// A rune is at most 4 bytes, so only the last 3 can be incomplete.
	for back := 1; back <= 3 && back <= len(b); back++ {
		r, size := utf8.DecodeLastRune(b[len(b)-back:])
		if r == utf8.RuneError && size <= 1 {
			// Could be a lead byte of a longer sequence — check whether the
			// full remaining tail decodes.
			if !utf8.Valid(b[len(b)-back:]) {
				continue
			}
		}
		break
	}
	// Walk back to the last rune start and test whether it completes.
	for back := 1; back <= 4 && back <= len(b); back++ {
		c := b[len(b)-back]
		if c&0xC0 != 0x80 { // a rune start byte
			need := runeLen(c)
			if need > back {
				return back // incomplete
			}
			return 0
		}
	}
	return 0
}

func runeLen(lead byte) int {
	switch {
	case lead&0x80 == 0x00:
		return 1
	case lead&0xE0 == 0xC0:
		return 2
	case lead&0xF0 == 0xE0:
		return 3
	case lead&0xF8 == 0xF0:
		return 4
	}
	return 1
}

// frameEnd finds the end of the first complete frame. Handles LF and CRLF.
func frameEnd(buf string) (index, length int, ok bool) {
	lf := strings.Index(buf, "\n\n")
	crlf := strings.Index(buf, "\r\n\r\n")
	if lf == -1 && crlf == -1 {
		return 0, 0, false
	}
	if crlf != -1 && (lf == -1 || crlf < lf) {
		return crlf, 4, true
	}
	return lf, 2, true
}

func (p *Parser) drain(t float64) []Chunk {
	frames := []Chunk{}
	for {
		buf := p.buffer.String()
		idx, length, ok := frameEnd(buf)
		if !ok {
			break
		}
		text := buf[:idx]
		rest := buf[idx+length:]
		p.buffer.Reset()
		p.buffer.WriteString(rest)
		if strings.TrimSpace(text) == "" {
			continue
		}
		frames = append(frames, p.parseFrame(text, t))
	}
	return frames
}

func (p *Parser) parseFrame(text string, t float64) Chunk {
	var dataLines []string
	event := ""
	comment := false

	for _, line := range strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n") {
		if line == "" {
			continue
		}
		if strings.HasPrefix(line, ":") {
			comment = true
			dataLines = append(dataLines, strings.TrimSpace(line[1:]))
			continue
		}
		colon := strings.Index(line, ":")
		field := line
		value := ""
		if colon != -1 {
			field = line[:colon]
			value = line[colon+1:]
			// Per the spec a single space after the colon is delimiter, not
			// data. Trimming all leading space would corrupt indented content.
			value = strings.TrimPrefix(value, " ")
		}
		switch field {
		case "data":
			dataLines = append(dataLines, value)
		case "event":
			event = value
		}
		// `id` and `retry` are unused by every surface here; ignored on purpose.
	}

	raw := strings.Join(dataLines, "\n")
	c := Chunk{Seq: p.seq, T: t, Raw: raw}
	p.seq++
	if event != "" {
		c.Event = event
	}
	if comment {
		c.Comment = true
	}

	if raw == doneSentinel {
		c.Done = true
		return c
	}
	if !comment && raw != "" {
		trimmed := strings.TrimLeft(raw, " \t\n\r")
		if strings.HasPrefix(trimmed, "{") || strings.HasPrefix(trimmed, "[") {
			if json.Valid([]byte(raw)) {
				c.Parsed = json.RawMessage(raw)
			}
			// Left unparsed on purpose when invalid — the malformed frame IS
			// the finding, and dropping it would hide a gateway defect.
		}
	}
	return c
}
