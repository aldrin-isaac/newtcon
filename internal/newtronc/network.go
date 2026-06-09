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

	switch {
	case resp.StatusCode == http.StatusOK:
	case resp.StatusCode == http.StatusNotFound:
		return nil, &NotFoundError{StatusCode: resp.StatusCode, Body: body}
	case resp.StatusCode >= 500:
		return nil, &UnavailableError{StatusCode: resp.StatusCode, Cause: string(body)}
	default:
		return nil, &UnavailableError{StatusCode: resp.StatusCode, Cause: string(body)}
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
	return c.listNames(ctx, network, "profiles")
}

func (c *Client) ListZones(ctx context.Context, network string) ([]string, error) {
	return c.listNames(ctx, network, "zones")
}

func (c *Client) ListPlatforms(ctx context.Context, network string) ([]string, error) {
	return c.listNames(ctx, network, "platforms")
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

	switch {
	case resp.StatusCode == http.StatusOK || resp.StatusCode == http.StatusCreated:
		// OK — fall through to decode.
	case resp.StatusCode == http.StatusBadRequest:
		return nil, &ValidationError{StatusCode: resp.StatusCode, Body: respBody}
	case resp.StatusCode == http.StatusNotFound:
		return nil, &NotFoundError{StatusCode: resp.StatusCode, Body: respBody}
	case resp.StatusCode == http.StatusConflict:
		return nil, &ConflictError{StatusCode: resp.StatusCode, Body: respBody}
	case resp.StatusCode >= 500:
		return nil, &UnavailableError{StatusCode: resp.StatusCode, Cause: string(respBody)}
	default:
		return nil, &UnavailableError{StatusCode: resp.StatusCode, Cause: string(respBody)}
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
func (c *Client) DeleteSpec(ctx context.Context, network, kind, name string) error {
	_, err := c.networkPost(ctx, network, "delete-"+kind, map[string]string{"name": name})
	return err
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
func (c *Client) RemoveFilterRule(ctx context.Context, network, filter string, sequence int) error {
	_, err := c.networkPost(ctx, network, "remove-filter-rule", map[string]any{
		"filter":   filter,
		"sequence": sequence,
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
func (c *Client) RemoveRoutePolicyRule(ctx context.Context, network, policy string, sequence int) error {
	_, err := c.networkPost(ctx, network, "remove-route-policy-rule", map[string]any{
		"policy":   policy,
		"sequence": sequence,
	})
	return err
}

// ShowSpec returns the full newtron payload for a single spec instance.
// Returns the decoded "data" field as RawMessage — callers forward it
// verbatim to keep the substrate honest (no field stripping, no rename).
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

	switch {
	case resp.StatusCode == http.StatusOK:
	case resp.StatusCode == http.StatusNotFound:
		return nil, &NotFoundError{StatusCode: resp.StatusCode, Body: body}
	case resp.StatusCode >= 500:
		return nil, &UnavailableError{StatusCode: resp.StatusCode, Cause: string(body)}
	default:
		return nil, &UnavailableError{StatusCode: resp.StatusCode, Cause: string(body)}
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
