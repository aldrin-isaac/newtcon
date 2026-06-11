package newtronc

import "net/http"

// TransportFor returns the underlying transport of c.httpClient. Test-only;
// exported from a _test.go file so it does not leak into the public API.
func TransportFor(c *Client) http.RoundTripper {
	return c.httpClient.Transport
}

// InnerTransportFor peels off the [bearerInjector] wrapper installed by
// [New] and returns the underlying transport (typically *http.Transport
// for production; whatever the caller installed for tests). Test-only.
func InnerTransportFor(c *Client) http.RoundTripper {
	tr := c.httpClient.Transport
	if bi, ok := tr.(*bearerInjector); ok {
		return bi.inner
	}
	return tr
}
