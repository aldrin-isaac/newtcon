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

// OutboundTLSOptions carries the inputs BuildTLSConfig consumes. Each field
// is independently optional; the zero value yields a nil *tls.Config (which
// the http.Client treats as "use Go defaults: system roots, no client cert").
//
// CertPath + KeyPath form a client-cert pair for outbound mTLS to newtron-
// server (newtron's --tls-ca path). Both must be set together. Aligns with
// newtron's NEWTRON_TLS_CERT/KEY env-var convention.
type OutboundTLSOptions struct {
	// CAPath is the PEM file with CA roots used to verify newtron-server's
	// server certificate. Empty = Go's default (system roots).
	CAPath string

	// CertPath / KeyPath are the PEM-encoded client cert + private key
	// newtcon-server presents during the TLS handshake to newtron-server.
	// Both must be set together; either empty disables client-cert auth.
	CertPath string
	KeyPath  string

	// SkipVerify disables TLS server-cert verification — DEV ONLY. Callers
	// should log a WARNING. Ignored when CAPath is set (CA cert wins).
	SkipVerify bool
}

// BuildTLSConfig returns a *tls.Config suitable for an outbound HTTP client
// dialling newtron-server, based on the supplied options.
//
//   - All fields zero            → nil (Go's default: system roots, no client cert)
//   - CAPath != ""               → Config{RootCAs: <pool from PEM>}
//   - SkipVerify == true         → Config{InsecureSkipVerify: true}
//     (CA cert wins when both are set)
//   - CertPath + KeyPath != ""   → Config{Certificates: [<pair>]} merged with above
//
// Returns an error if exactly one of CertPath / KeyPath is set, or if any
// PEM file is unreadable / malformed.
func BuildTLSConfig(opts OutboundTLSOptions) (*tls.Config, error) {
	var cfg *tls.Config

	if opts.CAPath != "" {
		pem, err := os.ReadFile(opts.CAPath)
		if err != nil {
			return nil, fmt.Errorf("reading CA cert %q: %w", opts.CAPath, err)
		}
		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM(pem) {
			return nil, fmt.Errorf("no PEM certificates found in %q", opts.CAPath)
		}
		cfg = &tls.Config{RootCAs: pool}
	} else if opts.SkipVerify {
		cfg = &tls.Config{InsecureSkipVerify: true}
	}

	if (opts.CertPath == "") != (opts.KeyPath == "") {
		return nil, fmt.Errorf("newtron client cert/key must be set together (cert=%q key=%q)", opts.CertPath, opts.KeyPath)
	}
	if opts.CertPath != "" {
		pair, err := tls.LoadX509KeyPair(opts.CertPath, opts.KeyPath)
		if err != nil {
			return nil, fmt.Errorf("loading client cert pair: %w", err)
		}
		if cfg == nil {
			cfg = &tls.Config{}
		}
		cfg.Certificates = append(cfg.Certificates, pair)
	}

	return cfg, nil
}
