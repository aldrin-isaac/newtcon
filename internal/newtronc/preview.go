// Package newtronc is the sole HTTP client of newtron-server in the newtcon
// codebase.
//
// This file implements the dry-run-apply call to newtron-server and the
// ChangeSet projection helper.
// Verified substrate:
//
//	POST /network/{netID}/node/{device}/interface/{name}/apply-service
//	  with ?dry_run=true → Execute:false per handler.go:262 execOpts()
//	  handler: pkg/newtron/api/handler.go:173 handleApplyService
//
// All newtron interaction in this file goes through c.httpClient. No other
// package in newtcon may call newtron-server.
package newtronc

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/aldrin-isaac/newtcon/internal/types"
)

// applyServiceRequest is the body newtron-server expects on
// POST .../interface/{name}/apply-service.
// Verified against pkg/newtron/api/handler_interface.go handleApplyService.
type applyServiceRequest struct {
	Service string         `json:"service"`
	Params  map[string]any `json:"params,omitempty"`
}

// DryRunApplyService calls
//
//	POST {baseURL}/network/{network}/node/{node}/interface/{iface}/apply-service?dry_run=true
//
// and returns the typed WriteResult from newtron's response data field.
//
// Returned errors:
//   - *ValidationError — newtron 400 (schema rejection or precondition failure)
//   - *ConflictError   — newtron 409 (drift_refusal; NOT VerificationFailedError
//     on the dry-run path — verify does not run on dry-run)
//   - *UnavailableError — newtron 5xx or transport error
func (c *Client) DryRunApplyService(ctx context.Context, network, node, iface, service string, params map[string]any) (*WriteResult, error) {
	url := fmt.Sprintf("%s/network/%s/node/%s/interface/%s/apply-service?dry_run=true",
		c.baseURL, network, node, iface)

	body, err := json.Marshal(applyServiceRequest{Service: service, Params: params})
	if err != nil {
		return nil, &UnavailableError{Cause: fmt.Sprintf("marshaling request: %v", err)}
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
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
	case resp.StatusCode == http.StatusOK:
		// fall through to decode
	case resp.StatusCode == http.StatusBadRequest:
		return nil, &ValidationError{StatusCode: resp.StatusCode, Body: respBody}
	case resp.StatusCode == http.StatusNotFound:
		return nil, &NotFoundError{StatusCode: resp.StatusCode, Body: respBody}
	case resp.StatusCode == http.StatusConflict:
		// dry_run=true cannot produce VerificationFailedError — deliver stage
		// is skipped. Any 409 on the dry-run path is drift_refusal.
		return nil, &ConflictError{StatusCode: resp.StatusCode, Body: respBody}
	case resp.StatusCode >= 500:
		return nil, &UnavailableError{StatusCode: resp.StatusCode, Cause: string(respBody)}
	default:
		return nil, &UnavailableError{
			StatusCode: resp.StatusCode,
			Cause:      fmt.Sprintf("unexpected status %d: %s", resp.StatusCode, string(respBody)),
		}
	}

	var apiResp newtronAPIResponse
	if err := json.Unmarshal(respBody, &apiResp); err != nil {
		return nil, &UnavailableError{Cause: fmt.Sprintf("decoding newtron response: %v", err)}
	}
	if apiResp.Error != "" {
		return nil, &ValidationError{StatusCode: resp.StatusCode, Body: respBody}
	}

	var wr WriteResult
	if err := json.Unmarshal(apiResp.Data, &wr); err != nil {
		return nil, &UnavailableError{Cause: fmt.Sprintf("decoding WriteResult: %v", err)}
	}
	return &wr, nil
}

// ProjectChangeSet translates a WriteResult's Changes slice into a
// ChangeSetDTO using the grouping rules from API_CONTRACT.md §ChangeSet
// (typed) lines 1582–1657:
//
//   - Entries with Table == "NEWTRON_INTENT" → intent_records[] (regardless of Type)
//   - Type ∈ {"add","modify"} → writes[]
//   - Type == "delete" → deletes[]
//
// Fields on the ChangeEntry are typed as any to honour the contract's
// null-value future semantics (lines 1598–1601). For writes/intent_records,
// Fields is map[string]string cast to any. For whole-row deletes (no fields),
// Fields is nil. For field-level deletes (newtron currently does not emit
// these — v1 sees whole-row only), Fields would be []string; the shape
// supports it.
func ProjectChangeSet(wr *WriteResult, network string) types.ChangeSetDTO {
	cs := types.ChangeSetDTO{
		Writes:        []types.ChangeEntry{},
		Deletes:       []types.ChangeEntry{},
		IntentRecords: []types.ChangeEntry{},
		RationaleRef: types.RationaleRef{
			Substrate: "newtron/docs/DESIGN_PRINCIPLES_NEWTRON.md#11-the-changeset-is-the-universal-contract",
			Principle: "docs/operator-philosophy.md#1-no-black-boxes",
		},
	}
	for _, c := range wr.Changes {
		entry := types.ChangeEntry{
			Table: c.Table,
			Key:   c.Key,
		}
		if c.Fields != nil {
			// Represent fields as map[string]any for contract compatibility.
			m := make(map[string]any, len(c.Fields))
			for k, v := range c.Fields {
				m[k] = v
			}
			entry.Fields = m
		}

		if strings.EqualFold(c.Table, "NEWTRON_INTENT") {
			cs.IntentRecords = append(cs.IntentRecords, entry)
			continue
		}
		switch c.Type {
		case "add", "modify":
			cs.Writes = append(cs.Writes, entry)
		case "delete":
			cs.Deletes = append(cs.Deletes, entry)
		}
	}
	return cs
}
