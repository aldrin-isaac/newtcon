package server

import (
	"crypto/rand"
	"fmt"
)

// newUUID returns a random UUID v4 string in the canonical
// "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx" format (RFC 4122 §4.4).
//
// The function panics if crypto/rand is unavailable — an unrecoverable
// condition on any supported platform. Callers may treat the panic as a
// server-startup failure; the Recovery middleware does not handle panics
// from middleware initialization.
func newUUID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(fmt.Sprintf("newtcon: crypto/rand unavailable: %v", err))
	}
	// Set version 4 (random).
	b[6] = (b[6] & 0x0f) | 0x40
	// Set variant bits (RFC 4122 §4.1.1).
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x",
		b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}
