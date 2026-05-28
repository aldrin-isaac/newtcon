// Package handlers contains one file per resource family served by
// newtcon-server.
//
// This file implements the in-memory preview store with 5-minute TTL and
// single-use consumption semantics. The store is shared by the preview and
// apply handlers.
//
// Memory bound: the store is bounded by (request rate × 5 min TTL). For v1
// single-operator usage, the in-memory approach is sufficient. The inline GC
// (called from Put and Take) prevents unbounded growth without a background
// goroutine. A future high-volume path (Workbench batch preview) may need a
// background GC goroutine; that is a post-ship concern.
package handlers

import (
	"sync"
	"time"

	"github.com/aldrin-isaac/newtcon/internal/newtronc"
	"github.com/aldrin-isaac/newtcon/internal/types"
)

// PreviewEntry stores the original request and the WriteResult returned by
// newtron's dry-run call. The WriteResult is the substrate the apply handler
// needs to call ExecuteApplyService with the same parameters.
type PreviewEntry struct {
	// Request is the original PreviewRequest captured at preview time.
	Request types.PreviewRequest
	// WriteResult is the dry-run output from newtronc. The apply handler uses
	// this to project the apply response; the request parameters are used to
	// re-call ExecuteApplyService.
	WriteResult *newtronc.WriteResult
	// ExpiresAt is the wall-clock time after which this entry must not be consumed.
	// API_CONTRACT.md §POST /api/preview line 1476: "valid for 5 minutes."
	ExpiresAt time.Time
	// IssuedAt is recorded so precondition_failure.condition_details can report it.
	IssuedAt time.Time
}

// PreviewStore is a goroutine-safe in-memory store for preview entries.
//
// It enforces two invariants:
//  1. TTL: entries expire after the configured duration (default 5 minutes).
//  2. Single-use: Take removes the entry, enforcing the preview→apply flow.
//     A second apply with the same preview_id returns !ok.
type PreviewStore struct {
	mu      sync.Mutex
	entries map[string]*PreviewEntry
	ttl     time.Duration
	clock   func() time.Time
}

// NewPreviewStore creates a PreviewStore with the given TTL and clock.
// Pass time.Now for production; inject a controlled clock in tests.
func NewPreviewStore(ttl time.Duration, clock func() time.Time) *PreviewStore {
	return &PreviewStore{
		entries: make(map[string]*PreviewEntry),
		ttl:     ttl,
		clock:   clock,
	}
}

// Put stores an entry under id. It runs an inline GC pass to sweep expired
// entries before inserting.
func (s *PreviewStore) Put(id string, entry *PreviewEntry) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.gc()
	s.entries[id] = entry
}

// Take retrieves and removes the entry for id.
//
// Returns (*PreviewEntry, true)  when the entry exists and has not expired.
// Returns (nil, false)           when the entry is missing, expired, or already consumed.
//
// Single-use: the entry is deleted on a successful Take. A second call with
// the same id returns (nil, false) regardless of the original TTL.
//
// An inline GC pass runs after removal to bound memory.
func (s *PreviewStore) Take(id string) (*PreviewEntry, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.gc()

	entry, ok := s.entries[id]
	if !ok {
		return nil, false
	}
	if s.clock().After(entry.ExpiresAt) {
		// Entry is expired — treat as not found and clean it up.
		delete(s.entries, id)
		return nil, false
	}
	delete(s.entries, id)
	return entry, true
}

// GC sweeps expired entries. Callers may invoke this directly; it is also
// called inline from Put and Take. Exported so the handler can call it
// explicitly in tests.
func (s *PreviewStore) GC() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.gc()
}

// gc is the internal (locked) GC implementation.
func (s *PreviewStore) gc() {
	now := s.clock()
	for id, entry := range s.entries {
		if now.After(entry.ExpiresAt) {
			delete(s.entries, id)
		}
	}
}
