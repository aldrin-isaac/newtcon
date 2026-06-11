// Package newtronc — TLS configuration for outbound calls to newtron-server.
//
// Wire encryption is required by any newtron deployment running with
// --auth-pam-service (L2b/L2c per newtron's auth-design.md): password and
// bearer-token traffic over cleartext defeats the credential boundary. This
// file lets newtcon-server verify newtron-server's TLS cert with the
// platform's system roots by default, or override with a private CA bundle.
package newtronc

import (
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"os"
)

// BuildTLSConfig returns a *tls.Config suitable for an outbound HTTP client
// dialling newtron-server.
//
//   - caCertPath == "" && skipVerify == false → nil (Go's default: system roots)
//   - caCertPath != ""                        → Config{RootCAs: <pool from PEM>}
//   - skipVerify == true                      → Config{InsecureSkipVerify: true}
//     (DEV-ONLY escape hatch; defeats encryption guarantees — callers should
//     log a WARNING)
//
// If both caCertPath and skipVerify are set, the CA cert wins.
func BuildTLSConfig(caCertPath string, skipVerify bool) (*tls.Config, error) {
	if caCertPath != "" {
		pem, err := os.ReadFile(caCertPath)
		if err != nil {
			return nil, fmt.Errorf("reading CA cert %q: %w", caCertPath, err)
		}
		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM(pem) {
			return nil, fmt.Errorf("no PEM certificates found in %q", caCertPath)
		}
		return &tls.Config{RootCAs: pool}, nil
	}
	if skipVerify {
		return &tls.Config{InsecureSkipVerify: true}, nil
	}
	return nil, nil
}
