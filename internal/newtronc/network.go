// Network-level list and write endpoints. List endpoints proxy newtron's
// GET /networks/{netID}/{kind} reads (plural per docs/newtron/api.md
// §URL Path Style, PR #113). Write endpoints proxy newtron's RPC-style
// POST /networks/{netID}/create-<kind> and POST /networks/{netID}/delete-<kind>
// (verbs stay singular), plus sub-rule verbs for the four spec types that
// support child rules.
package newtronc

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sort"
)

// listNames is the shared helper for every network-level list endpoint.
// Newtron returns {"data":["name1","name2"],"error":""} for all of them.
func (c *Client) listNames(ctx context.Context, network, kind string) ([]string, error) {
	url := fmt.Sprintf("%s/networks/%s/%s", c.newtronBase(), network, kind)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, &UnavailableError{Cause: fmt.Sprintf("building request: %v", err)}
	}
	req.Header.Set("Accept", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, &UnavailableError{Cause: err.Error()}
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, &UnavailableError{Cause: fmt.Sprintf("reading response body: %v", err)}
	}

	if err := classifyResponse(resp.StatusCode, body, http.StatusOK); err != nil {
		return nil, err
	}

	var apiResp newtronAPIResponse
	if err := json.Unmarshal(body, &apiResp); err != nil {
		return nil, &UnavailableError{Cause: fmt.Sprintf("decoding envelope: %v", err)}
	}
	if apiResp.Error != "" {
		return nil, &UnavailableError{Cause: apiResp.Error}
	}

	// Newtron's list shape varies across kinds: services / zones / profiles return
	// ["name", ...], while ipvpns / macvpns return {"name": {...}} (or {} when
	// empty). Try array first, fall back to extracting object keys (sorted).
	var names []string
	if err := json.Unmarshal(apiResp.Data, &names); err == nil {
		return names, nil
	}
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(apiResp.Data, &obj); err == nil {
		out := make([]string, 0, len(obj))
		for k := range obj {
			out = append(out, k)
		}
		sort.Strings(out)
		return out, nil
	}
	return nil, &UnavailableError{Cause: fmt.Sprintf("decoding name list for %s: unrecognised shape", kind)}
}

// Per newtron docs/newtron/api.md §URL Path Style, all collection-noun paths
// are plural (PR #113). The kind argument is the URL segment, not a Go type
// name — it must match the live route in pkg/newtron/api/handler.go.

func (c *Client) ListIPVPNs(ctx context.Context, network string) ([]string, error) {
	return c.listNames(ctx, network, "ipvpns")
}

func (c *Client) ListMACVPNs(ctx context.Context, network string) ([]string, error) {
	return c.listNames(ctx, network, "macvpns")
}

func (c *Client) ListQoSPolicies(ctx context.Context, network string) ([]string, error) {
	return c.listNames(ctx, network, "qos-policies")
}

func (c *Client) ListFilters(ctx context.Context, network string) ([]string, error) {
	return c.listNames(ctx, network, "filters")
}

func (c *Client) ListPrefixLists(ctx context.Context, network string) ([]string, error) {
	return c.listNames(ctx, network, "prefix-lists")
}

func (c *Client) ListRoutePolicies(ctx context.Context, network string) ([]string, error) {
	return c.listNames(ctx, network, "route-policies")
}

func (c *Client) ListProfiles(ctx context.Context, network string) ([]string, error) {
	// Newtron PR #206 (2026-06-17) renamed the route from /profiles to /nodes;
	// PR #320 then renamed the type DeviceProfile→NodeSpec and the write verbs
	// to create-/update-/delete-node. A node's spec lives under nodes/. newtcon
	// now uses "nodes" as the spec-kind slug throughout (operator-vocabulary
	// alignment) — the method name ListProfiles is retained internally only.
	return c.listNames(ctx, network, "nodes")
}

func (c *Client) ListZones(ctx context.Context, network string) ([]string, error) {
	return c.listNames(ctx, network, "zones")
}

func (c *Client) ListPlatforms(ctx context.Context, network string) ([]string, error) {
	return c.listNames(ctx, network, "platforms")
}

// SpecInstances proxies GET /networks/{netID}/spec-instances (newtron #287):
// the flat cross-scope inventory — [{kind, name, scope, scope_instance}, ...],
// one entry per definition (a name appears once per scope it's defined at).
// Returns the raw "data" payload for the frontend to render directly.
func (c *Client) SpecInstances(ctx context.Context, network string) (json.RawMessage, error) {
	url := fmt.Sprintf("%s/networks/%s/spec-instances", c.newtronBase(), network)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, &UnavailableError{Cause: fmt.Sprintf("building request: %v", err)}
	}
	req.Header.Set("Accept", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, &UnavailableError{Cause: err.Error()}
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, &UnavailableError{Cause: fmt.Sprintf("reading response body: %v", err)}
	}
	if err := classifyResponse(resp.StatusCode, body, http.StatusOK); err != nil {
		return nil, err
	}
	var apiResp newtronAPIResponse
	if err := json.Unmarshal(body, &apiResp); err != nil {
		return nil, &UnavailableError{Cause: fmt.Sprintf("decoding envelope: %v", err)}
	}
	if apiResp.Error != "" {
		return nil, &UnavailableError{Cause: apiResp.Error}
	}
	return apiResp.Data, nil
}

// ============================================================================
// Write helpers
// ============================================================================

// networkPost sends POST /newtron/v1/networks/{netID}/{verb} with the given
// JSON body. On 200/201 it returns the decoded "data" field as RawMessage.
//
// Error mapping mirrors newtron's RPC conventions:
//   - 400 → *ValidationError (invalid input)
//   - 404 → *NotFoundError (network or referenced spec not found)
//   - 409 → *ConflictError (drift guard or reference conflict)
//   - 5xx / transport failure → *UnavailableError
func (c *Client) networkPost(ctx context.Context, network, verb string, body any) (json.RawMessage, error) {
	b, err := json.Marshal(body)
	if err != nil {
		return nil, &UnavailableError{Cause: fmt.Sprintf("marshalling request: %v", err)}
	}
	url := fmt.Sprintf("%s/networks/%s/%s", c.newtronBase(), network, verb)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(b))
	if err != nil {
		return nil, &UnavailableError{Cause: fmt.Sprintf("building request: %v", err)}
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, &UnavailableError{Cause: err.Error()}
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, &UnavailableError{Cause: fmt.Sprintf("reading response body: %v", err)}
	}

	if err := classifyResponse(resp.StatusCode, respBody, http.StatusOK, http.StatusCreated); err != nil {
		return nil, err
	}

	var apiResp newtronAPIResponse
	if err := json.Unmarshal(respBody, &apiResp); err != nil {
		return nil, &UnavailableError{Cause: fmt.Sprintf("decoding envelope: %v", err)}
	}
	if apiResp.Error != "" {
		// Newtron-side error reported in the envelope body (not via HTTP status).
		return nil, &ValidationError{StatusCode: resp.StatusCode, Body: respBody}
	}
	return apiResp.Data, nil
}

// ============================================================================
// Spec create / delete — nine spec types
// ============================================================================

// CreateSpec sends POST /network/{netID}/create-<kind> with the given body.
// kind is the newtron URL segment (e.g. "service", "ipvpn", "qos-policy").
// Returns the decoded "data" field ({"name": "<name>"}) on success.
func (c *Client) CreateSpec(ctx context.Context, network, kind string, body any) (json.RawMessage, error) {
	return c.networkPost(ctx, network, "create-"+kind, body)
}

// DeleteSpec sends POST /network/{netID}/delete-<kind> with {"name": name}.
// A non-empty scope (+ scopeInstance) targets a zone/node override rather than
// the network base — newtron's delete-<kind> takes the scope selector in the
// body, mirroring create-<kind>.
func (c *Client) DeleteSpec(ctx context.Context, network, kind, name, scope, scopeInstance string, force bool) error {
	body := map[string]string{"name": name}
	if scope != "" {
		body["scope"] = scope
	}
	if scopeInstance != "" {
		body["scope_instance"] = scopeInstance
	}
	// force cascades active topology bindings (newtron #319) — passed as a query.
	verb := "delete-" + kind
	if force {
		verb += "?force=true"
	}
	_, err := c.networkPost(ctx, network, verb, body)
	return err
}

// UpdateSpec sends POST /network/{netID}/update-<kind> with the given body.
// kind is the newtron URL segment (e.g. "service", "ipvpn", "profile") —
// the singular create-/delete-/update- verb suffix, NOT the plural URL
// collection name.
//
// Body shape mirrors create-<kind>: name identifies the existing spec;
// other fields are the new top-level values. Sub-collections (qos
// queues, filter rules, route-policy statements) are preserved by newtron
// and managed via their own add-X / remove-X endpoints — DO NOT include
// them in update-<kind> request bodies.
//
// Returns the decoded "data" field on success ({"name": "<name>"} today;
// shape may grow additively per DESIGN_PRINCIPLES_NEWTRON §46).
func (c *Client) UpdateSpec(ctx context.Context, network, kind string, body any) (json.RawMessage, error) {
	return c.networkPost(ctx, network, "update-"+kind, body)
}

// ============================================================================
// QoS queue sub-rules
// ============================================================================

// AddQoSQueue sends POST /network/{netID}/add-qos-queue.
// Substrate: handler.go line 76.
func (c *Client) AddQoSQueue(ctx context.Context, network string, body any) (json.RawMessage, error) {
	return c.networkPost(ctx, network, "add-qos-queue", body)
}

// RemoveQoSQueue sends POST /network/{netID}/remove-qos-queue.
// Substrate: handler.go line 77.
func (c *Client) RemoveQoSQueue(ctx context.Context, network string, policy string, queueID int) error {
	_, err := c.networkPost(ctx, network, "remove-qos-queue", map[string]any{
		"policy":   policy,
		"queue_id": queueID,
	})
	return err
}

// ============================================================================
// Filter rule sub-rules
// ============================================================================

// AddFilterRule sends POST /network/{netID}/add-filter-rule.
// Substrate: handler.go line 80.
func (c *Client) AddFilterRule(ctx context.Context, network string, body any) (json.RawMessage, error) {
	return c.networkPost(ctx, network, "add-filter-rule", body)
}

// RemoveFilterRule sends POST /network/{netID}/remove-filter-rule.
// Substrate: handler.go line 81.
//
// Body field renamed `sequence` → `seq` per newtron PR #214 (2026-06-17)
// to align with the spec types + Add request types that already used `seq`.
func (c *Client) RemoveFilterRule(ctx context.Context, network, filter string, seq int) error {
	_, err := c.networkPost(ctx, network, "remove-filter-rule", map[string]any{
		"filter": filter,
		"seq":    seq,
	})
	return err
}

// ============================================================================
// Prefix list entry sub-rules
// ============================================================================

// AddPrefixListEntry sends POST /network/{netID}/add-prefix-list-entry.
// Substrate: handler.go line 84.
func (c *Client) AddPrefixListEntry(ctx context.Context, network string, body any) (json.RawMessage, error) {
	return c.networkPost(ctx, network, "add-prefix-list-entry", body)
}

// RemovePrefixListEntry sends POST /network/{netID}/remove-prefix-list-entry.
// Substrate: handler.go line 85.
func (c *Client) RemovePrefixListEntry(ctx context.Context, network, prefixList, prefix string) error {
	_, err := c.networkPost(ctx, network, "remove-prefix-list-entry", map[string]string{
		"prefix_list": prefixList,
		"prefix":      prefix,
	})
	return err
}

// ============================================================================
// Route policy rule sub-rules
// ============================================================================

// AddRoutePolicyRule sends POST /network/{netID}/add-route-policy-rule.
// Substrate: handler.go line 88.
func (c *Client) AddRoutePolicyRule(ctx context.Context, network string, body any) (json.RawMessage, error) {
	return c.networkPost(ctx, network, "add-route-policy-rule", body)
}

// RemoveRoutePolicyRule sends POST /network/{netID}/remove-route-policy-rule.
// Substrate: handler.go line 89.
//
// Body field renamed `sequence` → `seq` per newtron PR #214 (2026-06-17).
func (c *Client) RemoveRoutePolicyRule(ctx context.Context, network, policy string, seq int) error {
	_, err := c.networkPost(ctx, network, "remove-route-policy-rule", map[string]any{
		"policy": policy,
		"seq":    seq,
	})
	return err
}

// ============================================================================
// Per-item sub-rule update (newtcon#173.B + #173.C)
// ============================================================================
//
// Newtron PRs #215/216/217 shipped per-item update verbs for the three
// sub-rule families with editable non-key fields. The shape is
// `POST /update-X` with the identifier in the body — same pattern as
// Add/Remove. The renumber field (new_seq / new_queue_id) lets the row
// move within its parent collection in the same call.
//
// Prefix-list entries are not part of this family: a prefix-list entry
// has no fields beyond its key (the prefix CIDR), so newtron #239 deleted
// `update-prefix-list-entry` outright. Operators rename a prefix by
// `remove-prefix-list-entry` + `add-prefix-list-entry`.
//
// Newtcon's handler layer wraps these as PUT to the identified path for
// a more REST-ish surface; the conversion happens at the handler.

// UpdateFilterRule sends POST /network/{netID}/update-filter-rule. Body
// carries {filter, seq, ...rule_fields, new_seq?} per newtron PR #215.
func (c *Client) UpdateFilterRule(ctx context.Context, network string, body any) (json.RawMessage, error) {
	return c.networkPost(ctx, network, "update-filter-rule", body)
}

// UpdateRoutePolicyRule sends POST /network/{netID}/update-route-policy-rule.
// Body carries {policy, seq, ...rule_fields, new_seq?} per newtron PR #216.
func (c *Client) UpdateRoutePolicyRule(ctx context.Context, network string, body any) (json.RawMessage, error) {
	return c.networkPost(ctx, network, "update-route-policy-rule", body)
}

// UpdateQoSQueue sends POST /network/{netID}/update-qos-queue. Body
// carries {policy, queue_id, ...queue_fields, new_queue_id?} per newtron PR #217.
func (c *Client) UpdateQoSQueue(ctx context.Context, network string, body any) (json.RawMessage, error) {
	return c.networkPost(ctx, network, "update-qos-queue", body)
}

// ShowSpec returns the full newtron payload for a single spec instance.
// Returns the decoded "data" field as RawMessage — callers forward it
// verbatim to keep the substrate honest (no field stripping, no rename).
//
// kind is the URL path segment, which is plural for every spec type:
// "services" / "profiles" / "zones" / "qos-policies" / etc. Do not pass the
// singular create-/delete- verb suffix (e.g. "profile") — newtron's mux
// will 404. The handler caller in internal/handlers/network.go passes the
// plural form from the (url, newtronKind) pair.
func (c *Client) ShowSpec(ctx context.Context, network, kind, name string) (json.RawMessage, error) {
	url := fmt.Sprintf("%s/networks/%s/%s/%s", c.newtronBase(), network, kind, name)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, &UnavailableError{Cause: fmt.Sprintf("building request: %v", err)}
	}
	req.Header.Set("Accept", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, &UnavailableError{Cause: err.Error()}
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, &UnavailableError{Cause: fmt.Sprintf("reading response body: %v", err)}
	}

	if err := classifyResponse(resp.StatusCode, body, http.StatusOK); err != nil {
		return nil, err
	}

	var apiResp newtronAPIResponse
	if err := json.Unmarshal(body, &apiResp); err != nil {
		return nil, &UnavailableError{Cause: fmt.Sprintf("decoding envelope: %v", err)}
	}
	if apiResp.Error != "" {
		return nil, &UnavailableError{Cause: apiResp.Error}
	}
	return apiResp.Data, nil
}
