// Package newtronc is the sole HTTP client of newtron-server in the newtcon
// codebase.
//
// This file implements the execute (non-dry-run) apply call to newtron-server
// and the PerWrite + Verification translation helpers.
// Verified substrate:
//
//	POST /network/{netID}/node/{device}/interface/{name}/apply-service
//	  without ?dry_run → Execute:true per handler.go:262 execOpts()
//	  VerificationFailedError 409 + data:*WriteResult per newtron#21 (f6b64d8)
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
)

// ExecuteApplyService calls
//
//	POST {baseURL}/network/{network}/node/{node}/interface/{iface}/apply-service
//
// (no dry_run param — Execute:true).
//
// Return semantics (three exclusive cases):
//
//  1. (*WriteResult, nil, nil) — newtron returned 200; the apply ran to completion.
//     WriteResult.Applied is true; WriteResult.Verification may be non-nil if verify
//     completed on the 200 path (not expected when newtron returns 200 on success —
//     the verify-failure path uses 409 per newtron#21).
//
//  2. (nil, *VerifyFailure, nil) — newtron returned 409 with
//     data:*WriteResult in the envelope, indicating VerificationFailedError.
//     The write LANDED (VerifyFailure.WriteResult.Applied == true); the
//     post-deliver re-read disagreed. This is NOT a Go error; callers surface
//     it on the 200 HTTP response path with verify.state:"failed" per
//     API_CONTRACT.md lines 3519–3539.
//
//  3. (nil, nil, error) — any other failure. error is one of *ValidationError,
//     *ConflictError (drift_refusal), *UnavailableError, or *NotFoundError.
func (c *Client) ExecuteApplyService(ctx context.Context, network, node, iface, service string, params map[string]any) (*WriteResult, *VerifyFailure, error) {
	url := fmt.Sprintf("%s/network/%s/node/%s/interface/%s/apply-service",
		c.baseURL, network, node, iface)

	body, err := json.Marshal(applyServiceRequest{Service: service, Params: params})
	if err != nil {
		return nil, nil, &UnavailableError{Cause: fmt.Sprintf("marshaling request: %v", err)}
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return nil, nil, &UnavailableError{Cause: fmt.Sprintf("building request: %v", err)}
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, nil, &UnavailableError{Cause: err.Error()}
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, nil, &UnavailableError{Cause: fmt.Sprintf("reading response body: %v", err)}
	}

	switch {
	case resp.StatusCode == http.StatusOK:
		// fall through to decode
	case resp.StatusCode == http.StatusBadRequest:
		return nil, nil, &ValidationError{StatusCode: resp.StatusCode, Body: respBody}
	case resp.StatusCode == http.StatusNotFound:
		return nil, nil, &NotFoundError{StatusCode: resp.StatusCode, Body: respBody}
	case resp.StatusCode == http.StatusConflict:
		// 409 has two cases:
		//   a) VerificationFailedError — data:*WriteResult present in the envelope
		//   b) drift_refusal — data is absent
		// Discriminate by attempting to decode the data field as *WriteResult.
		vf, isDriftRefusal, decErr := decodeConflict409(respBody)
		if decErr != nil {
			return nil, nil, &UnavailableError{
				StatusCode: resp.StatusCode,
				Cause:      fmt.Sprintf("decoding 409 body: %v", decErr),
			}
		}
		if isDriftRefusal {
			return nil, nil, &ConflictError{StatusCode: resp.StatusCode, Body: respBody}
		}
		return nil, vf, nil
	case resp.StatusCode >= 500:
		return nil, nil, &UnavailableError{StatusCode: resp.StatusCode, Cause: string(respBody)}
	default:
		return nil, nil, &UnavailableError{
			StatusCode: resp.StatusCode,
			Cause:      fmt.Sprintf("unexpected status %d: %s", resp.StatusCode, string(respBody)),
		}
	}

	var apiResp newtronAPIResponse
	if err := json.Unmarshal(respBody, &apiResp); err != nil {
		return nil, nil, &UnavailableError{Cause: fmt.Sprintf("decoding newtron response: %v", err)}
	}
	if apiResp.Error != "" {
		return nil, nil, &ValidationError{StatusCode: resp.StatusCode, Body: respBody}
	}

	var wr WriteResult
	if err := json.Unmarshal(apiResp.Data, &wr); err != nil {
		return nil, nil, &UnavailableError{Cause: fmt.Sprintf("decoding WriteResult: %v", err)}
	}
	return &wr, nil, nil
}

// decodeConflict409 attempts to discriminate a 409 body between
// VerificationFailedError (data:*WriteResult) and drift_refusal (no data).
//
// Returns (VerifyFailure, false, nil) on a VerificationFailedError.
// Returns (nil, true, nil)           on a drift_refusal (no data field, or data is null).
// Returns (nil, false, err)          when the body cannot be parsed at all.
//
// Per API_CONTRACT.md lines 1799–1816 and newtron#21 (commit f6b64d8):
// writeError emits the standard envelope PLUS data:*WriteResult when
// errors.As detects VerificationFailedError. We decode the data field as
// *WriteResult; if Applied:true is present, it is a VerificationFailedError.
func decodeConflict409(body []byte) (*VerifyFailure, bool, error) {
	var apiResp newtronAPIResponse
	if err := json.Unmarshal(body, &apiResp); err != nil {
		return nil, false, fmt.Errorf("json decode: %w", err)
	}

	// If data is missing or null, this is a drift_refusal.
	if len(apiResp.Data) == 0 || string(apiResp.Data) == "null" {
		return nil, true, nil
	}

	var wr WriteResult
	if err := json.Unmarshal(apiResp.Data, &wr); err != nil {
		// If we can't decode the data as WriteResult, treat as drift_refusal
		// (the data field exists but isn't a WriteResult).
		return nil, true, nil
	}

	// Discriminate: VerificationFailedError implies Applied:true (the write
	// landed per newtron#21 envelope contract) and Verification != nil
	// with failed > 0.
	if wr.Applied && wr.Verification != nil && wr.Verification.Failed > 0 {
		return &VerifyFailure{
			WriteResult: &wr,
			Message:     apiResp.Error,
		}, false, nil
	}

	// data is present but doesn't look like a VerificationFailedError.
	// Treat as drift_refusal (conservative).
	return nil, true, nil
}
