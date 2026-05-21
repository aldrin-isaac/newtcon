// Package main is the newtcon HTTP server entry point.
//
// See ../../CLAUDE.md for the binding ruleset and ../../API_CONTRACT.md
// for the HTTP API definitions.
package main

import (
	"encoding/json"
	"flag"
	"log"
	"net/http"
	"os"
	"time"
)

func main() {
	addr := flag.String("addr", "127.0.0.1:8080", "listen address for newtcon-server")
	newtronURL := flag.String("newtron-url", "", "newtron-server base URL (e.g., http://127.0.0.1:9090)")
	flag.Parse()

	cfg := config{newtronURL: *newtronURL}

	mux := http.NewServeMux()
	mux.HandleFunc("/api/health", cfg.handleHealth)

	srv := &http.Server{
		Addr:              *addr,
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
	}

	log.Printf("newtcon-server listening on %s (newtron-url=%q)", *addr, *newtronURL)
	if err := srv.ListenAndServe(); err != nil {
		log.Printf("server exited: %v", err)
		os.Exit(1)
	}
}

type config struct {
	newtronURL string
}

func (c *config) handleHealth(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"status":  "ok",
		"version": "0.0.0-dev",
		"newtron": map[string]any{
			"url":       c.newtronURL,
			"reachable": false,
			"version":   "",
		},
	})
}
