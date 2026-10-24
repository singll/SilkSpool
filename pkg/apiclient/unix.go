package apiclient

import (
	"context"
	"net"
	"net/http"
)

// NewUnixClient returns a client for the local `spool serve --socket` endpoint.
// It only configures the Unix-socket transport; the HTTP methods are generated
// from api/openapi.yaml.
func NewUnixClient(socketPath string) *Client {
	dialer := &net.Dialer{}
	transport := &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return dialer.DialContext(ctx, "unix", socketPath)
		},
	}
	return &Client{
		BaseURL:    "http://localhost",
		HTTPClient: &http.Client{Transport: transport},
	}
}

// WithToken returns a copy of the client with a bearer token configured.
func (c *Client) WithToken(token string) *Client {
	clone := *c
	clone.Token = token
	return &clone
}
