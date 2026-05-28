// Package newtronc is the sole HTTP client of newtron-server in the newtcon
// codebase.
//
// This file defines the wire-mirror structs that reflect newtron's HTTP
// response JSON shapes byte-for-byte (verified against
// ../newtron/pkg/newtron/types.go lines 55–88,
// ../newtron/pkg/newtron/device/sonic/types.go lines 28–44 and 106–132).
//
// These types are NEVER exported beyond the newtronc package —
// internal/handlers consumes the translated DTOs from internal/types/.
// This is the substrate-translation boundary per CLAUDE.md
// §newtron API Consumption Rule: "No copy-paste of newtron internal types —
// newtcon defines its own DTOs in internal/types/ that match newtron's HTTP
// responses." The mirror is a copy of the WIRE JSON SHAPE, not the Go type
// (hence it lives in newtronc and does not escape).
//
// Verified substrate (pkg/newtron/types.go; last checked 2026-05-27):
//
//	WriteResult.Changes   []sonic.ConfigChange  — newtron#11 landed
//	WriteResult.PerWrite  []sonic.PerSubstrateOp — newtron#19 landed
//	VerificationFailedError 409 + data:*WriteResult — newtron#21 landed
package newtronc

import "time"

// WriteResult mirrors the JSON wire shape of newtron's WriteResult
// (../newtron/pkg/newtron/types.go lines 55–64).
//
// Field-for-field match against json tags in newtron source:
//
//	Preview     string               `json:"preview,omitempty"`
//	Changes     []sonic.ConfigChange `json:"changes,omitempty"`
//	PerWrite    []sonic.PerSubstrateOp `json:"per_write,omitempty"`
//	ChangeCount int                  `json:"change_count"`
//	Applied     bool                 `json:"applied"`
//	Verified    bool                 `json:"verified"`
//	Saved       bool                 `json:"saved"`
//	Verification *VerificationResult `json:"verification,omitempty"`
type WriteResult struct {
	Preview      string              `json:"preview,omitempty"`
	Changes      []ConfigChange      `json:"changes,omitempty"`
	PerWrite     []PerSubstrateOp    `json:"per_write,omitempty"`
	ChangeCount  int                 `json:"change_count"`
	Applied      bool                `json:"applied"`
	Verified     bool                `json:"verified"`
	Saved        bool                `json:"saved"`
	Verification *VerificationResult `json:"verification,omitempty"`
}

// ConfigChange mirrors sonic.ConfigChange
// (../newtron/pkg/newtron/device/sonic/types.go lines 29–35).
//
//	Table  string            `json:"table"`
//	Key    string            `json:"key"`
//	Type   ChangeType        `json:"type"`   (string alias: "add","modify","delete")
//	Fields map[string]string `json:"fields,omitempty"`
type ConfigChange struct {
	Table  string            `json:"table"`
	Key    string            `json:"key"`
	Type   string            `json:"type"`
	Fields map[string]string `json:"fields,omitempty"`
}

// PerSubstrateOp mirrors sonic.PerSubstrateOp
// (../newtron/pkg/newtron/device/sonic/types.go lines 106–132).
//
//	Seq            int               `json:"seq"`
//	Kind           string            `json:"kind"`
//	Table          string            `json:"table,omitempty"`
//	Key            string            `json:"key,omitempty"`
//	Fields         map[string]string `json:"fields,omitempty"`
//	Result         string            `json:"result"`
//	DeviceResponse string            `json:"device_response,omitempty"`
//	At             time.Time         `json:"at"`
type PerSubstrateOp struct {
	Seq            int               `json:"seq"`
	Kind           string            `json:"kind"`
	Table          string            `json:"table,omitempty"`
	Key            string            `json:"key,omitempty"`
	Fields         map[string]string `json:"fields,omitempty"`
	Result         string            `json:"result"`
	DeviceResponse string            `json:"device_response,omitempty"`
	At             time.Time         `json:"at"`
}

// VerificationResult mirrors newtron's VerificationResult
// (../newtron/pkg/newtron/types.go lines 67–71).
//
//	Passed int                 `json:"passed"`
//	Failed int                 `json:"failed"`
//	Errors []VerificationError `json:"errors,omitempty"`
type VerificationResult struct {
	Passed int                 `json:"passed"`
	Failed int                 `json:"failed"`
	Errors []VerificationError `json:"errors,omitempty"`
}

// VerificationError mirrors newtron's VerificationError
// (../newtron/pkg/newtron/types.go lines 80–87).
//
// DeviceResponse is the verbatim device-side reply — NEVER dropped.
// Per operator-philosophy invariant #7 and DESIGN_PRINCIPLES_NEWTRON §14.
//
//	Table          string `json:"table"`
//	Key            string `json:"key"`
//	Field          string `json:"field"`
//	Expected       string `json:"expected"`
//	Actual         string `json:"actual"`
//	DeviceResponse string `json:"device_response,omitempty"`
type VerificationError struct {
	Table          string `json:"table"`
	Key            string `json:"key"`
	Field          string `json:"field"`
	Expected       string `json:"expected"`
	Actual         string `json:"actual"`
	DeviceResponse string `json:"device_response,omitempty"`
}

// VerifyFailure carries the typed payload of a newtron 409 VerificationFailedError.
// Per API_CONTRACT.md lines 1799–1816 and newtron#21 (commit f6b64d8):
// newtron's writeError emits the standard envelope PLUS data:*WriteResult
// when errors.As detects VerificationFailedError. This type captures that
// decoded payload.
//
// A *VerifyFailure return is NOT a Go error — it is a typed substrate carrier.
// The write landed (WriteResult.Applied == true); the post-deliver verify
// re-read disagreed. Handlers surface this on the 200 path with
// verify.state:"failed" per API_CONTRACT.md lines 3519–3539.
type VerifyFailure struct {
	WriteResult *WriteResult
	Message     string
}
