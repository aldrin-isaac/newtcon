package newtronc

import "net/http"

// TransportFor returns the underlying transport of c.httpClient. Test-only;
// exported from a _test.go file so it does not leak into the public API.
func TransportFor(c *Client) http.RoundTripper {
	return c.httpClient.Transport
}
