// kind_resolver.go — given a URL slug, resolve the newtron kind name
// + per-verb paths used to forward CRUD requests.
//
// Schema is the source of truth: at first use, the resolver walks
// newtron's /api/schema and caches the slug → SchemaMeta map for the
// process lifetime. Static specKindMap remains as a fallback when
// newtron is unreachable at boot or doesn't yet describe a kind
// (e.g. prefix-lists has no PrefixListSpec schema today).
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
// singular mapping. Used when the schema endpoint is unreachable at
// boot OR for slugs newtron doesn't expose via /api/schema today
// (prefix-lists). When newtron's schema covers every kind, this map
// can be dropped.
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

	// Step 1 — schema-derived entries. Walk every kind newtron exposes;
	// keep only the top-level kinds (those with a list path), since
	// embedded / sub-rule kinds aren't addressable by URL slug.
	if payload, err := r.client.FetchSchemaKinds(ctx); err == nil {
		var env struct {
			Kinds []types.SchemaKindSummary `json:"kinds"`
		}
		if err := json.Unmarshal(payload, &env); err == nil {
			for _, s := range env.Kinds {
				metaPayload, err := r.client.FetchSchema(ctx, s.Kind)
				if err != nil {
					continue
				}
				var meta types.SchemaMeta
				if err := json.Unmarshal(metaPayload, &meta); err != nil {
					continue
				}
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
