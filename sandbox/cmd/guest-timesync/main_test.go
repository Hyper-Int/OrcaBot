// REVISION: guest-timesync-v2-error-codes
package main

import (
	"strings"
	"testing"
	"time"
)

func TestParseRequest(t *testing.T) {
	ns := int64(1760000000123456789)
	got, err := parseRequest("ORCABOT-TIMESYNC 1 1760000000123456789\n")
	if err != nil || got.UnixNano() != ns {
		t.Fatalf("parse: got %v %v", got.UnixNano(), err)
	}
	for _, bad := range []string{
		"",
		"ORCABOT-TIMESYNC 2 1760000000123456789\n",
		"ORCABOT-TIMESYNC 1 abc\n",
		"ORCABOT-TIMESYNC 1 1000\n", // implausibly old
		"SET 1760000000123456789\n",
	} {
		if _, err := parseRequest(bad); err == nil {
			t.Errorf("expected error for %q", bad)
		}
	}
}

func TestNeedsStep(t *testing.T) {
	cases := map[time.Duration]bool{
		0:                       false,
		2 * time.Second:         false,
		-2 * time.Second:        false,
		2*time.Second + 1:       true,
		-401 * time.Second:      true,
		401 * time.Second:       true,
		1500 * time.Millisecond: false,
	}
	for d, want := range cases {
		if got := nееdsStep(d); got != want {
			t.Errorf("needsStep(%v)=%v want %v", d, got, want)
		}
	}
}

func TestFormatReply(t *testing.T) {
	r := fоrmatReply(true, 401*time.Second, 3*time.Millisecond)
	if !strings.HasPrefix(r, "OK stepped=1 before_ms=401000 after_ms=3 rev=") || !strings.HasSuffix(r, "\n") {
		t.Fatalf("reply %q", r)
	}
}
