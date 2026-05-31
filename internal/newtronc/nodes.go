// Package newtronc is the sole HTTP client of newtron-server in the newtcon
// codebase. CLAUDE.md §newtron API Consumption Rule: all newtron HTTP traffic
// originates here; no other package may construct an http.Client or call
// http.Get/http.Post against newtron-server's address.
//
// This file implements node-level and topology proxy calls. Every method
// proxies one newtron endpoint verbatim and returns the decoded "data" field
// as json.RawMessage so handlers can forward it without field stripping.
//
// Newtron substrate verified against pkg/newtron/api/handler.go buildMux():
//   - Line 47: "GET /network/{netID}/topology"
//   - Lines 102-116: all node read endpoints
//   - Lines 150-152: CONFIG_DB endpoints
package newtronc

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
)

// nodeGet is the shared helper for every node-level GET endpoint that proxies
// newtron verbatim. It builds the URL from the path fragments, executes the
// request, and returns the decoded "data" field as RawMessage.
//
// The path argument must begin with "/" and be relative to baseURL — e.g.
// "/network/default/node/switch1/info".
func (c *Client) nodeGet(ctx context.Context, path string) (json.RawMessage, error) {
	url := c.baseURL + path
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

// Topology calls GET /network/{netID}/topology and returns the full topology
// payload (devices + links + interfaces).
//
// Substrate: pkg/newtron/api/handler.go line 47.
func (c *Client) Topology(ctx context.Context, network string) (json.RawMessage, error) {
	return c.nodeGet(ctx, fmt.Sprintf("/network/%s/topology", network))
}

// NodeInfo calls GET /network/{netID}/node/{device}/info.
//
// Substrate: pkg/newtron/api/handler.go line 102.
func (c *Client) NodeInfo(ctx context.Context, network, device string) (json.RawMessage, error) {
	return c.nodeGet(ctx, fmt.Sprintf("/network/%s/node/%s/info", network, device))
}

// NodeHealth calls GET /network/{netID}/node/{device}/health.
//
// Substrate: pkg/newtron/api/handler.go line 114.
func (c *Client) NodeHealth(ctx context.Context, network, device string) (json.RawMessage, error) {
	return c.nodeGet(ctx, fmt.Sprintf("/network/%s/node/%s/health", network, device))
}

// NodeInterfaces calls GET /network/{netID}/node/{device}/interface.
//
// Substrate: pkg/newtron/api/handler.go line 103.
func (c *Client) NodeInterfaces(ctx context.Context, network, device string) (json.RawMessage, error) {
	return c.nodeGet(ctx, fmt.Sprintf("/network/%s/node/%s/interface", network, device))
}

// NodeInterface calls GET /network/{netID}/node/{device}/interface/{name}.
//
// Substrate: pkg/newtron/api/handler.go line 104.
func (c *Client) NodeInterface(ctx context.Context, network, device, name string) (json.RawMessage, error) {
	return c.nodeGet(ctx, fmt.Sprintf("/network/%s/node/%s/interface/%s", network, device, name))
}

// NodeInterfaceBinding calls GET /network/{netID}/node/{device}/interface/{name}/binding.
//
// Substrate: pkg/newtron/api/handler.go line 105.
func (c *Client) NodeInterfaceBinding(ctx context.Context, network, device, name string) (json.RawMessage, error) {
	return c.nodeGet(ctx, fmt.Sprintf("/network/%s/node/%s/interface/%s/binding", network, device, name))
}

// NodeVLANs calls GET /network/{netID}/node/{device}/vlan.
//
// Substrate: pkg/newtron/api/handler.go line 106.
func (c *Client) NodeVLANs(ctx context.Context, network, device string) (json.RawMessage, error) {
	return c.nodeGet(ctx, fmt.Sprintf("/network/%s/node/%s/vlan", network, device))
}

// NodeVRFs calls GET /network/{netID}/node/{device}/vrf.
//
// Substrate: pkg/newtron/api/handler.go line 108.
func (c *Client) NodeVRFs(ctx context.Context, network, device string) (json.RawMessage, error) {
	return c.nodeGet(ctx, fmt.Sprintf("/network/%s/node/%s/vrf", network, device))
}

// NodeACLs calls GET /network/{netID}/node/{device}/acl.
//
// Substrate: pkg/newtron/api/handler.go line 110.
func (c *Client) NodeACLs(ctx context.Context, network, device string) (json.RawMessage, error) {
	return c.nodeGet(ctx, fmt.Sprintf("/network/%s/node/%s/acl", network, device))
}

// NodeLAGs calls GET /network/{netID}/node/{device}/lag.
//
// Substrate: pkg/newtron/api/handler.go line 115.
func (c *Client) NodeLAGs(ctx context.Context, network, device string) (json.RawMessage, error) {
	return c.nodeGet(ctx, fmt.Sprintf("/network/%s/node/%s/lag", network, device))
}

// NodeNeighbors calls GET /network/{netID}/node/{device}/neighbor.
//
// Substrate: pkg/newtron/api/handler.go line 116.
func (c *Client) NodeNeighbors(ctx context.Context, network, device string) (json.RawMessage, error) {
	return c.nodeGet(ctx, fmt.Sprintf("/network/%s/node/%s/neighbor", network, device))
}

// NodeBGPStatus calls GET /network/{netID}/node/{device}/bgp/status.
//
// Substrate: pkg/newtron/api/handler.go line 112.
func (c *Client) NodeBGPStatus(ctx context.Context, network, device string) (json.RawMessage, error) {
	return c.nodeGet(ctx, fmt.Sprintf("/network/%s/node/%s/bgp/status", network, device))
}

// NodeEVPNStatus calls GET /network/{netID}/node/{device}/evpn/status.
//
// Substrate: pkg/newtron/api/handler.go line 113.
func (c *Client) NodeEVPNStatus(ctx context.Context, network, device string) (json.RawMessage, error) {
	return c.nodeGet(ctx, fmt.Sprintf("/network/%s/node/%s/evpn/status", network, device))
}

// NodeConfigDB calls GET /network/{netID}/node/{device}/configdb.
//
// Substrate: pkg/newtron/api/handler.go line 150.
func (c *Client) NodeConfigDB(ctx context.Context, network, device string) (json.RawMessage, error) {
	return c.nodeGet(ctx, fmt.Sprintf("/network/%s/node/%s/configdb", network, device))
}

// NodeConfigDBTable calls GET /network/{netID}/node/{device}/configdb/{table}.
//
// Substrate: pkg/newtron/api/handler.go line 151.
func (c *Client) NodeConfigDBTable(ctx context.Context, network, device, table string) (json.RawMessage, error) {
	return c.nodeGet(ctx, fmt.Sprintf("/network/%s/node/%s/configdb/%s", network, device, table))
}

// NodeConfigDBEntry calls GET /network/{netID}/node/{device}/configdb/{table}/{key}.
//
// Substrate: pkg/newtron/api/handler.go line 152.
func (c *Client) NodeConfigDBEntry(ctx context.Context, network, device, table, key string) (json.RawMessage, error) {
	return c.nodeGet(ctx, fmt.Sprintf("/network/%s/node/%s/configdb/%s/%s", network, device, table, key))
}
