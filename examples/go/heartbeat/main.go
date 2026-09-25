// GotYouBro heartbeat client for Go (standard library only).
//
//	GOTYOUBRO_URL=https://gotyoubro.example.com GOTYOUBRO_TOKEN=gyb_... go run ./heartbeat
//	go run ./heartbeat -once          # single heartbeat, e.g. at the end of a cron job
//	GOTYOUBRO_MONITOR=worker go run ./heartbeat   # heartbeat for the "worker" monitor
//
// To use it inside your app, copy SendHeartbeat/StartHeartbeat and call
// StartHeartbeat(ctx, 30*time.Second) once at startup.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"
	"time"
)

type heartbeatResult struct {
	ServiceID   string `json:"serviceId"`
	HealthState string `json:"healthStatus"`
	Recovered   bool   `json:"recovered"`
}

type apiResponse struct {
	Success bool            `json:"success"`
	Data    heartbeatResult `json:"data"`
	Error   struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

var client = &http.Client{Timeout: 10 * time.Second}

// SendHeartbeat sends one heartbeat and returns the service's health state.
func SendHeartbeat(ctx context.Context, baseURL, token string) (*heartbeatResult, error) {
	url := baseURL + "/api/v1/health/heartbeat"
	if monitor := os.Getenv("GOTYOUBRO_MONITOR"); monitor != "" { // optional monitor key
		url += "/" + monitor
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var body apiResponse
	_ = json.NewDecoder(resp.Body).Decode(&body)
	if resp.StatusCode >= 300 {
		return nil, fmt.Errorf("%d %s %s", resp.StatusCode, body.Error.Code, body.Error.Message)
	}
	return &body.Data, nil
}

// StartHeartbeat sends heartbeats until ctx is cancelled. Errors are logged, never fatal.
func StartHeartbeat(ctx context.Context, baseURL, token string, interval time.Duration) {
	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			if res, err := SendHeartbeat(ctx, baseURL, token); err != nil {
				log.Printf("[heartbeat] failed: %v", err) // monitoring must never take your app down
			} else if res.Recovered {
				log.Printf("[heartbeat] %s (recovered)", res.HealthState)
			} else {
				log.Printf("[heartbeat] %s", res.HealthState)
			}
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
		}
	}()
}

func main() {
	once := flag.Bool("once", false, "send a single heartbeat and exit")
	flag.Parse()

	baseURL := strings.TrimRight(getenv("GOTYOUBRO_URL", "http://localhost:6969"), "/")
	token := os.Getenv("GOTYOUBRO_TOKEN")
	if token == "" {
		log.Fatal("Set GOTYOUBRO_TOKEN (and GOTYOUBRO_URL).")
	}

	if *once {
		res, err := SendHeartbeat(context.Background(), baseURL, token)
		if err != nil {
			log.Fatalf("heartbeat failed: %v", err)
		}
		fmt.Println("heartbeat ok:", res.HealthState)
		return
	}

	interval, err := time.ParseDuration(getenv("GOTYOUBRO_INTERVAL", "30") + "s")
	if err != nil {
		log.Fatalf("invalid GOTYOUBRO_INTERVAL: %v", err)
	}
	StartHeartbeat(context.Background(), baseURL, token, interval)
	select {} // keep the standalone program running
}

func getenv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
