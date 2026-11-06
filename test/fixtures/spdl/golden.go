//go:build ignore

// Copyright (c) 2026 The Speedle Authors
// SPDX-License-Identifier: UPL-1.0

// golden.go runs the real Speedle SPDL parser (teramoby/speedle-plus pkg/pdl)
// on every statement in corpus.json and writes golden.json, which
// test/spdl-golden.test.ts uses to check the TypeScript port in src/manage/spdl.ts.
//
// Run it from the root of a speedle-plus checkout (see README.md in this folder):
//
//	go run /path/to/speedle-mcp/test/fixtures/spdl/golden.go \
//	  < /path/to/speedle-mcp/test/fixtures/spdl/corpus.json \
//	  > /path/to/speedle-mcp/test/fixtures/spdl/golden.json
package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"

	"github.com/teramoby/speedle-plus/pkg/eval/condition"
	"github.com/teramoby/speedle-plus/pkg/pdl"
)

type corpus struct {
	Entries []struct {
		Source string `json:"source"`
		Spdl   string `json:"spdl"`
	} `json:"entries"`
}

type result struct {
	OK bool `json:"ok"`
	// Body is the JSON body ParsePolicy / ParseRolePolicy produced, without "id".
	Body map[string]any `json:"body,omitempty"`
	// Reason is the first line of the error message.
	Reason string `json:"reason,omitempty"`
	// Position is the byte offset the error indicator points at, or null when
	// the parser reports no position.
	Position *int `json:"position"`
	// Condition is true when the statement failed only because its condition
	// does not compile (condition.Check).
	Condition bool `json:"condition,omitempty"`
}

type entry struct {
	Source     string `json:"source"`
	Spdl       string `json:"spdl"`
	Policy     result `json:"policy"`
	RolePolicy result `json:"rolePolicy"`
}

type golden struct {
	SpeedlePlus string  `json:"speedlePlus"`
	Entries     []entry `json:"entries"`
}

func toResult(reader io.Reader, err error) result {
	if err == nil {
		var body map[string]any
		if decodeErr := json.NewDecoder(reader).Decode(&body); decodeErr != nil {
			panic(decodeErr)
		}
		delete(body, "id")
		return result{OK: true, Body: body}
	}
	msg := err.Error()
	r := result{Reason: strings.SplitN(msg, "\n", 2)[0]}
	var condErr *condition.Error
	r.Condition = errors.As(err, &condErr) || strings.HasPrefix(r.Reason, "Invalid condition: ")
	if errors.As(err, &condErr) {
		r.Reason = condErr.Reason
		return r
	}
	if i := strings.LastIndex(msg, "\n"); i >= 0 && strings.HasSuffix(msg, "^") {
		pos := len(msg) - i - 2
		r.Position = &pos
	}
	return r
}

func main() {
	var in corpus
	if err := json.NewDecoder(os.Stdin).Decode(&in); err != nil {
		fmt.Fprintln(os.Stderr, "read corpus:", err)
		os.Exit(1)
	}
	commit, err := exec.Command("git", "rev-parse", "HEAD").Output()
	if err != nil {
		fmt.Fprintln(os.Stderr, "git rev-parse HEAD (run this from a speedle-plus checkout):", err)
		os.Exit(1)
	}
	out := golden{SpeedlePlus: strings.TrimSpace(string(commit)), Entries: []entry{}}
	for _, e := range in.Entries {
		_, pr, perr := pdl.ParsePolicy(e.Spdl, "n")
		_, rr, rerr := pdl.ParseRolePolicy(e.Spdl, "n")
		out.Entries = append(out.Entries, entry{
			Source: e.Source, Spdl: e.Spdl, Policy: toResult(pr, perr), RolePolicy: toResult(rr, rerr),
		})
	}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(out); err != nil {
		panic(err)
	}
	os.Stdout.Write(buf.Bytes())
}
