// kind_resolver.go — given a URL slug, resolve the newtron kind name
// + per-verb paths used to forward CRUD requests.
//
// Schema is the source of truth: at first use, the resolver fetches
// /newtron/v1/schema/all (one HTTP round-trip) and caches the slug →
// SchemaMeta map for the process lifetime. legacySpecKindMap is the
// safety net used only when newtron is unreachable at boot.
//
// As of newtron #242, every registered kind has a schema (including
// PrefixListSpec); legacySpecKindMap stays for unreachable-newtron
// resilience, not for kind coverage.
//
// Single source of truth means a new kind newtron registers becomes
// authorable through newtcon-server with no code change.
package handlers

import (
	"context"
	"encoding/json"
	"strings"
	"sync"

	"github.com/aldrin-isaac/newtcon/internal/newtronc"
	"github.com/aldrin-isaac/newtcon/internal/types"
)

// kindResolver answers "given URL slug X, what does newtron want for
// create/update/delete?". Lazy-loaded; thread-safe.
type kindResolver struct {
	client *newtronc.Client
	mu     sync.RWMutex
	cache  map[string]kindEntry // keyed by URL slug
	loaded bool
}

// kindEntry carries the resolved metadata for one URL slug. Either
// from a real schema fetch or synthesised from the legacy specKindMap
// fallback.
type kindEntry struct {
	// newtronKind is the singular newtron verb suffix (e.g. "service"
	// for "create-service"). Held separately so the existing networkPost
	// call shape stays the same.
	newtronKind string
	// schema is the full SchemaMeta when available; empty when the
	// entry was synthesised from the legacy specKindMap fallback.
	schema types.SchemaMeta
}

// legacySpecKindMap mirrors the historical hand-typed slug → newtron
// singular mapping. Used as a safety net when /schema/all is
// unreachable at first request — keeps the basic CRUD verbs working
// against a newtron that's reachable for spec ops but happens to fail
// on the schema endpoint.
//
// Every entry here is also covered by the schema; the schema-derived
// map wins (see ensureLoaded). When this map is empty, the resolver
// has no fallback — that's fine, but until we trust the schema
// endpoint as bullet-proof, the safety net stays.
var legacySpecKindMap = map[string]string{
	"services":       "service",
	"ipvpns":         "ipvpn",
	"macvpns":        "macvpn",
	"qos-policies":   "qos-policy",
	"filters":        "filter",
	"prefix-lists":   "prefix-list",
	"route-policies": "route-policy",
	"profiles":       "profile",
	"zones":          "zone",
}

func newKindResolver(c *newtronc.Client) *kindResolver {
	return &kindResolver{
		client: c,
		cache:  make(map[string]kindEntry),
	}
}

// lookup returns the entry for a slug, lazy-loading the schema cache
// on first call. Returns ok=false when the slug isn't covered by the
// schema OR the legacy fallback — caller should 404.
func (r *kindResolver) lookup(ctx context.Context, slug string) (kindEntry, bool) {
	r.ensureLoaded(ctx)
	r.mu.RLock()
	defer r.mu.RUnlock()
	e, ok := r.cache[slug]
	return e, ok
}

func (r *kindResolver) ensureLoaded(ctx context.Context) {
	r.mu.RLock()
	loaded := r.loaded
	r.mu.RUnlock()
	if loaded {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.loaded {
		return
	}
	r.loaded = true // mark even on error so we don't retry every request

	// Step 1 — schema-derived entries. Fetch every kind's full
	// SchemaMeta in one round-trip via /schema/all (newtron #242), then
	// keep only the top-level kinds (those with a list path), since
	// embedded / sub-rule kinds aren't addressable by URL slug.
	if payload, err := r.client.FetchAllSchemas(ctx); err == nil {
		var env struct {
			Schemas []types.SchemaMeta `json:"schemas"`
		}
		if err := json.Unmarshal(payload, &env); err == nil {
			for _, meta := range env.Schemas {
				if meta.Paths.List == "" {
					continue
				}
				slug := pathTail(meta.Paths.List)
				if slug == "" {
					continue
				}
				newtronKind := deriveNewtronVerb(meta.Paths.Create)
				r.cache[slug] = kindEntry{newtronKind: newtronKind, schema: meta}
			}
		}
	}

	// Step 2 — legacy fallback entries for slugs the schema doesn't
	// cover (or for the whole map if the schema fetch failed). We
	// don't overwrite schema-derived entries with legacy ones — the
	// schema is authoritative.
	for slug, kind := range legacySpecKindMap {
		if _, hit := r.cache[slug]; hit {
			continue
		}
		r.cache[slug] = kindEntry{newtronKind: kind}
	}
}

// pathTail returns the last URL path segment.
//
//	pathTail("/newtron/v1/networks/{netID}/ipvpns")   → "ipvpns"
//	pathTail("/foo/bar")                              → "bar"
func pathTail(p string) string {
	idx := strings.LastIndex(p, "/")
	if idx < 0 {
		return ""
	}
	return p[idx+1:]
}

// deriveNewtronVerb extracts the singular newtron verb suffix from a
// paths.create path:
//
//	"/newtron/v1/networks/{netID}/create-service" → "service"
//	"" or unparseable → ""
//
// This is what CreateSpec / UpdateSpec / DeleteSpec take as the kind
// argument — the existing newtronc client builds "create-<kind>" etc.,
// so we just hand it the singular suffix.
func deriveNewtronVerb(createPath string) string {
	tail := pathTail(createPath)
	const prefix = "create-"
	if strings.HasPrefix(tail, prefix) {
		return tail[len(prefix):]
	}
	return tail
}
