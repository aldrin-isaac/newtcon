// Network-level list endpoints: returns the names of each spec type defined
// in a newtron network. All are proxied verbatim from newtron's
// GET /network/{netID}/{kind} endpoints (handler.go lines 30-66).
package newtronc

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
)

// listNames is the shared helper for every network-level list endpoint.
// Newtron returns {"data":["name1","name2"],"error":""} for all of them.
func (c *Client) listNames(ctx context.Context, network, kind string) ([]string, error) {
	url := fmt.Sprintf("%s/network/%s/%s", c.baseURL, network, kind)
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

	var names []string
	if err := json.Unmarshal(apiResp.Data, &names); err != nil {
		return nil, &UnavailableError{Cause: fmt.Sprintf("decoding name list for %s: %v", kind, err)}
	}
	return names, nil
}

func (c *Client) ListIPVPNs(ctx context.Context, network string) ([]string, error) {
	return c.listNames(ctx, network, "ipvpn")
}

func (c *Client) ListMACVPNs(ctx context.Context, network string) ([]string, error) {
	return c.listNames(ctx, network, "macvpn")
}

func (c *Client) ListQoSPolicies(ctx context.Context, network string) ([]string, error) {
	return c.listNames(ctx, network, "qos-policy")
}

func (c *Client) ListFilters(ctx context.Context, network string) ([]string, error) {
	return c.listNames(ctx, network, "filter")
}

func (c *Client) ListPrefixLists(ctx context.Context, network string) ([]string, error) {
	return c.listNames(ctx, network, "prefix-list")
}

func (c *Client) ListRoutePolicies(ctx context.Context, network string) ([]string, error) {
	return c.listNames(ctx, network, "route-policy")
}

func (c *Client) ListProfiles(ctx context.Context, network string) ([]string, error) {
	return c.listNames(ctx, network, "profile")
}

func (c *Client) ListZones(ctx context.Context, network string) ([]string, error) {
	return c.listNames(ctx, network, "zone")
}

func (c *Client) ListPlatforms(ctx context.Context, network string) ([]string, error) {
	return c.listNames(ctx, network, "platform")
}
