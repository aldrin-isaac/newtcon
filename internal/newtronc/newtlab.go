// Package newtronc is the sole HTTP client of newtron-server in the newtcon
// codebase. CLAUDE.md §newtron API Consumption Rule: all newtron/newtlab HTTP
// traffic originates here.
//
// This file implements newtlab-server calls. newtlab-server is co-hosted at
// the same base URL as newtron-server (e.g., http://127.0.0.1:18080) and
// exposes the /newtlab/v1/... route prefix.
//
// Newtlab-server endpoints confirmed at:
//
//	pkg/newtlab/api/handler.go buildHandler()
//	  GET  /newtlab/v1/health
//	  GET  /newtlab/v1/topologies
//	  GET  /newtlab/v1/topologies/{name}/status
//	  POST /newtlab/v1/topologies/{name}/deploy
//	  POST /newtlab/v1/topologies/{name}/destroy
//	  POST /newtlab/v1/topologies/{name}/provision
//	  GET  /newtlab/v1/topologies/{name}/events      ← raw SSE stream
//	  POST /newtlab/v1/topologies/{name}/nodes/{node}/start
//	  POST /newtlab/v1/topologies/{name}/nodes/{node}/stop
//
// Responses use the pkg/httputil APIResponse envelope {"data":…,"error":""}.
// The events endpoint is a raw SSE stream (no envelope).
package newtronc

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
)

// newtlabBase returns the base URL for the newtlab-server route prefix.
func (c *Client) newtlabBase() string {
	return c.baseURL + "/newtlab/v1"
}

// newtlabGet performs a GET request to a newtlab-server path and returns
// the decoded "data" field as json.RawMessage. Follows the same error-mapping
// as nodeGet (UnavailableError for 5xx/transport, NotFoundError for 404,
// ConflictError for 409, ValidationError for 400).
func (c *Client) newtlabGet(ctx context.Context, path string) (json.RawMessage, error) {
	url := c.newtlabBase() + path
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
	case resp.StatusCode == http.StatusBadRequest:
		return nil, &ValidationError{StatusCode: resp.StatusCode, Body: body}
	case resp.StatusCode == http.StatusNotFound:
		return nil, &NotFoundError{StatusCode: resp.StatusCode, Body: body}
	case resp.StatusCode == http.StatusConflict:
		return nil, &ConflictError{StatusCode: resp.StatusCode, Body: body}
	case resp.StatusCode >= 500:
		return nil, &UnavailableError{StatusCode: resp.StatusCode, Cause: string(body)}
	default:
		return nil, &UnavailableError{
			StatusCode: resp.StatusCode,
			Cause:      fmt.Sprintf("unexpected status %d: %s", resp.StatusCode, string(body)),
		}
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

// newtlabPost performs a POST request with an optional JSON body to a
// newtlab-server path. Pass nil body for no-body POSTs. Returns the decoded
// "data" field. Accepts both 200 OK and 202 Accepted as success.
func (c *Client) newtlabPost(ctx context.Context, path string, bodyData any) (int, json.RawMessage, error) {
	var bodyReader io.Reader
	if bodyData != nil {
		b, err := json.Marshal(bodyData)
		if err != nil {
			return 0, nil, &UnavailableError{Cause: fmt.Sprintf("marshalling request: %v", err)}
		}
		bodyReader = bytes.NewReader(b)
	}

	url := c.newtlabBase() + path
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bodyReader)
	if err != nil {
		return 0, nil, &UnavailableError{Cause: fmt.Sprintf("building request: %v", err)}
	}
	if bodyData != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("Accept", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return 0, nil, &UnavailableError{Cause: err.Error()}
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return 0, nil, &UnavailableError{Cause: fmt.Sprintf("reading response body: %v", err)}
	}

	switch {
	case resp.StatusCode == http.StatusOK || resp.StatusCode == http.StatusAccepted:
	case resp.StatusCode == http.StatusBadRequest:
		return resp.StatusCode, nil, &ValidationError{StatusCode: resp.StatusCode, Body: body}
	case resp.StatusCode == http.StatusNotFound:
		return resp.StatusCode, nil, &NotFoundError{StatusCode: resp.StatusCode, Body: body}
	case resp.StatusCode == http.StatusConflict:
		return resp.StatusCode, nil, &ConflictError{StatusCode: resp.StatusCode, Body: body}
	case resp.StatusCode >= 500:
		return resp.StatusCode, nil, &UnavailableError{StatusCode: resp.StatusCode, Cause: string(body)}
	default:
		return resp.StatusCode, nil, &UnavailableError{
			StatusCode: resp.StatusCode,
			Cause:      fmt.Sprintf("unexpected status %d: %s", resp.StatusCode, string(body)),
		}
	}

	var apiResp newtronAPIResponse
	if err := json.Unmarshal(body, &apiResp); err != nil {
		return resp.StatusCode, nil, &UnavailableError{Cause: fmt.Sprintf("decoding envelope: %v", err)}
	}
	if apiResp.Error != "" {
		return resp.StatusCode, nil, &UnavailableError{Cause: apiResp.Error}
	}
	return resp.StatusCode, apiResp.Data, nil
}

// LabListTopologies calls GET /newtlab/v1/topologies and returns the raw
// "data" payload (an array of {"name":string} objects).
//
// Verified: pkg/newtlab/api/topologies.go handleListTopologies
func (c *Client) LabListTopologies(ctx context.Context) (json.RawMessage, error) {
	return c.newtlabGet(ctx, "/topologies")
}

// LabTopologyStatus calls GET /newtlab/v1/topologies/{name}/status and returns
// the raw LabState payload.
//
// Verified: pkg/newtlab/api/topologies.go handleGetStatus
func (c *Client) LabTopologyStatus(ctx context.Context, name string) (json.RawMessage, error) {
	return c.newtlabGet(ctx, fmt.Sprintf("/topologies/%s/status", name))
}

// LabDeployRequest mirrors DeployRequest in pkg/newtlab/api/types.go.
// All fields are optional; the zero value produces a plain deploy with no
// provision pass and no force flag.
type LabDeployRequest struct {
	Provision bool   `json:"provision,omitempty"`
	Force     bool   `json:"force,omitempty"`
	Host      string `json:"host,omitempty"`
	Parallel  int    `json:"parallel,omitempty"`
}

// LabDeploy calls POST /newtlab/v1/topologies/{name}/deploy. Returns the
// upstream HTTP status code (202 Accepted on success) and the raw response
// data payload.
//
// Verified: pkg/newtlab/api/topologies.go handleDeploy
func (c *Client) LabDeploy(ctx context.Context, name string, req LabDeployRequest) (int, json.RawMessage, error) {
	return c.newtlabPost(ctx, fmt.Sprintf("/topologies/%s/deploy", name), req)
}

// LabDestroy calls POST /newtlab/v1/topologies/{name}/destroy. Synchronous.
//
// Verified: pkg/newtlab/api/topologies.go handleDestroy
func (c *Client) LabDestroy(ctx context.Context, name string) (json.RawMessage, error) {
	_, data, err := c.newtlabPost(ctx, fmt.Sprintf("/topologies/%s/destroy", name), nil)
	return data, err
}

// LabProvision calls POST /newtlab/v1/topologies/{name}/provision. Synchronous.
// parallel=0 lets newtlab use its default (1).
//
// Verified: pkg/newtlab/api/topologies.go handleProvision
func (c *Client) LabProvision(ctx context.Context, name string, parallel int) (json.RawMessage, error) {
	path := fmt.Sprintf("/topologies/%s/provision", name)
	if parallel > 0 {
		path += fmt.Sprintf("?parallel=%d", parallel)
	}
	_, data, err := c.newtlabPost(ctx, path, nil)
	return data, err
}

// LabStartNode calls POST /newtlab/v1/topologies/{name}/nodes/{node}/start.
//
// Verified: pkg/newtlab/api/nodes.go handleStartNode
func (c *Client) LabStartNode(ctx context.Context, topology, node string) (json.RawMessage, error) {
	_, data, err := c.newtlabPost(ctx, fmt.Sprintf("/topologies/%s/nodes/%s/start", topology, node), nil)
	return data, err
}

// LabStopNode calls POST /newtlab/v1/topologies/{name}/nodes/{node}/stop.
//
// Verified: pkg/newtlab/api/nodes.go handleStopNode
func (c *Client) LabStopNode(ctx context.Context, topology, node string) (json.RawMessage, error) {
	_, data, err := c.newtlabPost(ctx, fmt.Sprintf("/topologies/%s/nodes/%s/stop", topology, node), nil)
	return data, err
}

// LabEventsRequest is the raw *http.Response for a newtlab SSE events stream.
// The caller is responsible for closing the Body. The response is the raw
// upstream SSE stream — Content-Type: text/event-stream — which the handler
// proxies line-by-line to the connected browser client.
//
// We return *http.Response rather than a decoded type because SSE is a
// streaming protocol: the handler needs the raw body to forward incrementally
// without buffering the whole stream.
//
// Verified: pkg/newtlab/api/events.go handleEvents uses httputil.WriteSSEStream
// which writes SSE frames with Content-Type text/event-stream.
func (c *Client) LabEventsRequest(ctx context.Context, topology string) (*http.Response, error) {
	url := c.newtlabBase() + fmt.Sprintf("/topologies/%s/events", topology)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, &UnavailableError{Cause: fmt.Sprintf("building request: %v", err)}
	}
	req.Header.Set("Accept", "text/event-stream")
	req.Header.Set("Cache-Control", "no-cache")

	// Use a client without timeout — SSE streams are long-lived.
	noTimeoutClient := &http.Client{Transport: c.httpClient.Transport}
	resp, err := noTimeoutClient.Do(req)
	if err != nil {
		return nil, &UnavailableError{Cause: err.Error()}
	}
	if resp.StatusCode != http.StatusOK {
		resp.Body.Close()
		return nil, &UnavailableError{
			StatusCode: resp.StatusCode,
			Cause:      fmt.Sprintf("events stream: unexpected status %d", resp.StatusCode),
		}
	}
	return resp, nil
}
