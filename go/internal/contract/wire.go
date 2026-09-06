package contract

import (
	"fmt"
	"regexp"
	"strings"
)

// The wire name: what the model is shown, and what a refusal names.
//
// It appears in NO API response — both MCP endpoints, the mcp_list_tools item
// and mcp_call all report the upstream name — so an admin reading a
// policy_block refusal has no API path to the identifier in it. Deriving it is
// the only way to show it.
//
// Every constant below is transcribed from internal/mcp/loop.go and checked by
// TestGatewaySourceHasNotDrifted. See GatewayFacts in sourcecheck.go.
const (
	wireSeparator  = "__"
	maxWireNameLen = 64
)

var toolNameSanitizer = regexp.MustCompile(`[^a-zA-Z0-9_-]`)

// ServerSlug is the gateway's server-name slug: lowercase, keep [a-z0-9],
// collapse any run of other characters to a single underscore, trim the ends.
func ServerSlug(serverName string) string {
	var b strings.Builder
	prevSep := false
	for _, r := range strings.ToLower(strings.TrimSpace(serverName)) {
		switch {
		case (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9'):
			b.WriteRune(r)
			prevSep = false
		case b.Len() > 0 && !prevSep:
			b.WriteByte('_')
			prevSep = true
		}
	}
	return strings.Trim(b.String(), "_")
}

// WireName is the name the model sees, or a note saying why it cannot be
// derived exactly.
//
// Two cases refuse rather than guess, because a plausible-looking wrong name is
// worse than an honest gap: it gets pasted into a forced-call test and fails
// for the wrong reason.
type WireName struct {
	Name string `json:"name,omitempty"`
	Slug string `json:"slug"`
	Note string `json:"note,omitempty"`
}

// WireNameFor derives one tool's wire name. slugIsAmbiguous must be true when
// another server in the same listing produces the same slug — the gateway then
// appends a digest of id|name|url that cannot be computed from here.
func WireNameFor(serverName, toolName string, slugIsAmbiguous bool) WireName {
	slug := ServerSlug(serverName)
	if slug == "" {
		return WireName{Slug: slug, Note: "server name has no usable characters; the gateway falls back to its id"}
	}
	if slugIsAmbiguous {
		return WireName{
			Slug: slug,
			Note: fmt.Sprintf("another server shares the slug %q, so the gateway appends a digest that cannot be derived here", slug),
		}
	}
	name := slug + wireSeparator + toolNameSanitizer.ReplaceAllString(toolName, "_")
	if len(name) > maxWireNameLen {
		return WireName{Slug: slug, Note: "over 64 characters, so the gateway truncates and appends a digest"}
	}
	return WireName{Name: name, Slug: slug}
}
