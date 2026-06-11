package newtronc_test

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/aldrin-isaac/newtcon/internal/newtronc"
)

// writeTestCAPEM mints a self-signed CA cert and writes it to caPath in PEM
// form. Returns the path written. Failure t.Fatal's.
func writeTestCAPEM(t *testing.T, caPath string) string {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("generating key: %v", err)
	}
	tmpl := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "newtronc-test-ca"},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(time.Hour),
		KeyUsage:              x509.KeyUsageCertSign,
		BasicConstraintsValid: true,
		IsCA:                  true,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatalf("creating cert: %v", err)
	}
	buf := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	if err := os.WriteFile(caPath, buf, 0o600); err != nil {
		t.Fatalf("writing PEM: %v", err)
	}
	return caPath
}

func TestBuildTLSConfig_Defaults(t *testing.T) {
	cfg, err := newtronc.BuildTLSConfig("", false)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg != nil {
		t.Fatalf("expected nil (Go default = system roots), got %#v", cfg)
	}
}

func TestBuildTLSConfig_CACert(t *testing.T) {
	caPath := writeTestCAPEM(t, filepath.Join(t.TempDir(), "ca.pem"))
	cfg, err := newtronc.BuildTLSConfig(caPath, false)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg == nil || cfg.RootCAs == nil {
		t.Fatalf("expected non-nil config with RootCAs populated, got %#v", cfg)
	}
	if cfg.InsecureSkipVerify {
		t.Errorf("InsecureSkipVerify must remain false when CA cert is configured")
	}
}

func TestBuildTLSConfig_SkipVerify(t *testing.T) {
	cfg, err := newtronc.BuildTLSConfig("", true)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg == nil || !cfg.InsecureSkipVerify {
		t.Fatalf("expected InsecureSkipVerify=true, got %#v", cfg)
	}
	if cfg.RootCAs != nil {
		t.Errorf("RootCAs must remain nil when only skipVerify is configured")
	}
}

func TestBuildTLSConfig_CACertWinsOverSkipVerify(t *testing.T) {
	caPath := writeTestCAPEM(t, filepath.Join(t.TempDir(), "ca.pem"))
	cfg, err := newtronc.BuildTLSConfig(caPath, true)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg == nil || cfg.RootCAs == nil {
		t.Fatalf("expected RootCAs populated when CA cert is set, got %#v", cfg)
	}
	if cfg.InsecureSkipVerify {
		t.Errorf("CA cert must win over skipVerify; InsecureSkipVerify should be false")
	}
}

func TestBuildTLSConfig_MissingFile(t *testing.T) {
	_, err := newtronc.BuildTLSConfig(filepath.Join(t.TempDir(), "absent.pem"), false)
	if err == nil {
		t.Fatal("expected error for missing file, got nil")
	}
}

func TestBuildTLSConfig_FileWithoutCerts(t *testing.T) {
	junk := filepath.Join(t.TempDir(), "junk.pem")
	if err := os.WriteFile(junk, []byte("not a certificate"), 0o600); err != nil {
		t.Fatalf("writing junk file: %v", err)
	}
	_, err := newtronc.BuildTLSConfig(junk, false)
	if err == nil {
		t.Fatal("expected error for file without certs, got nil")
	}
}

// TestWithTLSConfig_AppliedToTransport verifies that the option installs the
// supplied *tls.Config onto the client's outbound transport.
func TestWithTLSConfig_AppliedToTransport(t *testing.T) {
	caPath := writeTestCAPEM(t, filepath.Join(t.TempDir(), "ca.pem"))
	cfg, err := newtronc.BuildTLSConfig(caPath, false)
	if err != nil {
		t.Fatalf("BuildTLSConfig: %v", err)
	}
	c := newtronc.New("https://example.invalid", newtronc.WithTLSConfig(cfg))

	tr := newtronc.InnerTransportFor(c)
	httpTr, ok := tr.(*http.Transport)
	if !ok {
		t.Fatalf("expected *http.Transport, got %T", tr)
	}
	if httpTr.TLSClientConfig == nil {
		t.Fatal("TLSClientConfig was not set by WithTLSConfig")
	}
	if httpTr.TLSClientConfig.RootCAs == nil {
		t.Errorf("expected RootCAs to be set on the transport's TLSClientConfig")
	}
}

// TestWithTLSConfig_NilNoOp verifies that passing nil is a no-op (preserves
// whatever the constructor left in place — Go's default transport behaviour).
func TestWithTLSConfig_NilNoOp(t *testing.T) {
	c := newtronc.New("https://example.invalid", newtronc.WithTLSConfig(nil))
	tr := newtronc.InnerTransportFor(c)
	httpTr, ok := tr.(*http.Transport)
	if !ok {
		t.Fatalf("expected *http.Transport, got %T", tr)
	}
	if httpTr.TLSClientConfig != nil && httpTr.TLSClientConfig.RootCAs != nil {
		t.Errorf("nil cfg must not install RootCAs; got %#v", httpTr.TLSClientConfig)
	}
}
