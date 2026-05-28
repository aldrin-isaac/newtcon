package handlers

import (
	"testing"
	"time"

	"github.com/aldrin-isaac/newtcon/internal/newtronc"
	"github.com/aldrin-isaac/newtcon/internal/types"
)

// fixedClock returns a clock that always returns t.
func fixedClock(t time.Time) func() time.Time {
	return func() time.Time { return t }
}

// makeDummyEntry returns a PreviewEntry with the given expiry.
func makeDummyEntry(expiresAt time.Time) *PreviewEntry {
	return &PreviewEntry{
		Request:     types.PreviewRequest{Operation: "apply", Service: "transit"},
		WriteResult: &newtronc.WriteResult{Applied: false, ChangeCount: 1},
		ExpiresAt:   expiresAt,
		IssuedAt:    expiresAt.Add(-5 * time.Minute),
	}
}

func TestPreviewStore_PutTakeRoundtrip(t *testing.T) {
	now := time.Date(2026, 5, 28, 12, 0, 0, 0, time.UTC)
	store := NewPreviewStore(5*time.Minute, fixedClock(now))

	entry := makeDummyEntry(now.Add(5 * time.Minute))
	store.Put("abc-123", entry)

	got, ok := store.Take("abc-123")
	if !ok {
		t.Fatal("Take: expected ok=true, got false")
	}
	if got.Request.Service != "transit" {
		t.Errorf("Take: Request.Service = %q, want %q", got.Request.Service, "transit")
	}
}

func TestPreviewStore_TakeOnce(t *testing.T) {
	now := time.Date(2026, 5, 28, 12, 0, 0, 0, time.UTC)
	store := NewPreviewStore(5*time.Minute, fixedClock(now))

	entry := makeDummyEntry(now.Add(5 * time.Minute))
	store.Put("abc-once", entry)

	// First Take succeeds.
	_, ok := store.Take("abc-once")
	if !ok {
		t.Fatal("first Take: expected ok=true")
	}
	// Second Take with same ID fails — single-use semantics.
	_, ok = store.Take("abc-once")
	if ok {
		t.Fatal("second Take: expected ok=false (single-use consumed)")
	}
}

func TestPreviewStore_ExpiredEntryNotTakeable(t *testing.T) {
	base := time.Date(2026, 5, 28, 12, 0, 0, 0, time.UTC)
	clk := fixedClock(base)
	store := NewPreviewStore(5*time.Minute, clk)

	// Entry already expired at the time we store it.
	entry := makeDummyEntry(base.Add(-1 * time.Second))
	store.Put("exp-id", entry)

	// Advance clock past expiry (clock is fixed, entry was already past expiry).
	_, ok := store.Take("exp-id")
	if ok {
		t.Fatal("Take: expected ok=false for expired entry")
	}
}

func TestPreviewStore_GCRemovesExpired(t *testing.T) {
	base := time.Date(2026, 5, 28, 12, 0, 0, 0, time.UTC)

	// Use a mutable clock so we can advance it.
	var clkTime time.Time
	clkTime = base
	clock := func() time.Time { return clkTime }

	store := NewPreviewStore(5*time.Minute, clock)

	// Put two entries: one expires in 1s, one in 10 min.
	store.Put("expires-soon", makeDummyEntry(base.Add(time.Second)))
	store.Put("long-lived", makeDummyEntry(base.Add(10*time.Minute)))

	// Advance clock by 2 seconds — "expires-soon" is now stale.
	clkTime = base.Add(2 * time.Second)

	// GC should remove "expires-soon".
	store.GC()

	// "long-lived" should still be takeable.
	_, ok := store.Take("long-lived")
	if !ok {
		t.Fatal("long-lived entry should still be available after GC")
	}

	// "expires-soon" should be gone.
	_, ok = store.Take("expires-soon")
	if ok {
		t.Fatal("expired entry should be removed after GC")
	}
}

func TestPreviewStore_UnknownIDReturnsFalse(t *testing.T) {
	now := time.Now()
	store := NewPreviewStore(5*time.Minute, fixedClock(now))

	_, ok := store.Take("does-not-exist")
	if ok {
		t.Fatal("Take on unknown id should return false")
	}
}
