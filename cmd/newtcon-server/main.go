// Package main is the newtcon-server entry point.
//
// Flag parsing, newtronc client construction, and HTTP server startup.
// HTTP routing and middleware are in [internal/server]; handler logic is in
// [internal/handlers]. See CLAUDE.md §File Ownership Map for the binding
// file-to-concern assignments.
//
// Build command (per CLAUDE.md §Build Convention):
//
//	go build -o bin/newtcon-server ./cmd/newtcon-server
package main

import (
	"flag"
	"log"
	"net/http"
	"os"
	"time"

	"github.com/aldrin-isaac/newtcon/internal/newtronc"
	"github.com/aldrin-isaac/newtcon/internal/server"
)

func main() {
	addr := flag.String("addr", "127.0.0.1:8080", "listen address for newtcon-server")
	newtronURL := flag.String("newtron-url", "", "newtron-server base URL (e.g., http://127.0.0.1:9090)")
	newtronTimeout := flag.Duration("newtron-timeout", 10*time.Second, "per-request timeout for newtron-server calls")
	flag.Parse()

	nc := newtronc.New(*newtronURL, newtronc.WithTimeout(*newtronTimeout))

	cfg := server.Config{
		NewtronClient: nc,
		NewtronURL:    *newtronURL,
	}

	handler := server.NewRouter(cfg)

	srv := &http.Server{
		Addr:              *addr,
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
	}

	log.Printf("newtcon-server listening on %s (newtron-url=%q newtron-timeout=%s)",
		*addr, *newtronURL, *newtronTimeout)
	if err := srv.ListenAndServe(); err != nil {
		log.Printf("server exited: %v", err)
		os.Exit(1)
	}
}
