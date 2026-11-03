// Licensed to the Apache Software Foundation (ASF) under one
// or more contributor license agreements.  See the NOTICE file
// distributed with this work for additional information
// regarding copyright ownership.  The ASF licenses this file
// to you under the Apache License, Version 2.0 (the
// "License"); you may not use this file except in compliance
// with the License.  You may obtain a copy of the License at
//
//   http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing,
// software distributed under the License is distributed on an
// "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
// KIND, either express or implied.  See the License for the
// specific language governing permissions and limitations
// under the License.

package server

import (
	"context"
	"embed"
	"encoding/json"
	"fmt"
	"io/fs"
	"regexp"
	"sort"
	"strings"

	"github.com/google/uuid"

	"github.com/apache/texera/catalog/internal/api"
	"github.com/apache/texera/catalog/internal/store"
)

// The skills the platform ships, as SKILL.md files: YAML frontmatter (name, description), then
// the instructions the agent loads on demand. In the repository each file starts with the ASF
// license comment, which is not part of the skill.
//
//go:embed skills/*.md
var skillFiles embed.FS

type builtinSkill struct {
	Name, Description string
	// Content is the SKILL.md as stored (a JSON string, like a skill made in the app): the
	// frontmatter and the body, without the license.
	Content string
}

var (
	leadingComment = regexp.MustCompile(`(?s)\A\s*<!--.*?-->\s*`)
	frontmatter    = regexp.MustCompile(`(?s)\A---\r?\n(.*?)\r?\n---\r?\n`)
)

// builtinSkills parses the shipped SKILL.md files, in file-name order.
func builtinSkills() ([]builtinSkill, error) {
	names, err := fs.Glob(skillFiles, "skills/*.md")
	if err != nil {
		return nil, err
	}
	sort.Strings(names)
	out := make([]builtinSkill, 0, len(names))
	for _, name := range names {
		data, err := skillFiles.ReadFile(name)
		if err != nil {
			return nil, err
		}
		content := leadingComment.ReplaceAllString(string(data), "")
		m := frontmatter.FindStringSubmatch(content)
		if m == nil {
			return nil, fmt.Errorf("%s: no frontmatter", name)
		}
		sk := builtinSkill{Content: content}
		for _, line := range strings.Split(m[1], "\n") {
			key, value, ok := strings.Cut(line, ":")
			if !ok {
				continue
			}
			value = strings.Trim(strings.TrimSpace(value), `"'`)
			switch strings.TrimSpace(key) {
			case "name":
				sk.Name = value
			case "description":
				sk.Description = value
			}
		}
		if sk.Name == "" || sk.Description == "" {
			return nil, fmt.Errorf("%s: the frontmatter needs name and description", name)
		}
		out = append(out, sk)
	}
	return out, nil
}

// seedSkills creates the shipped skills, gives one whose shipped content changed a new version
// authored by the platform, and returns their rids in file-name order.
func (s *Server) seedSkills(ctx context.Context, sysPID uuid.UUID,
	create func(kind, name, desc string, spec any, content any, contentKind string) (*store.Resource, error)) ([]string, error) {
	shipped, err := builtinSkills()
	if err != nil {
		return nil, err
	}
	refs := make([]string, 0, len(shipped))
	msg := "updated by the platform"
	for _, sk := range shipped {
		spec := api.SkillSpec{Name: sk.Name, Description: sk.Description}
		r, err := create("skill", sk.Name, sk.Description, spec, sk.Content, "json")
		if err != nil {
			return nil, err
		}
		current := ""
		if r.HeadVno > 0 {
			head, err := s.store.GetVersion(ctx, r.RID, r.HeadVno)
			if err != nil {
				return nil, err
			}
			_ = json.Unmarshal(head.Content, &current)
		}
		if current != sk.Content {
			if _, err := s.store.CreateVersion(ctx, store.NewVersion{RID: r.RID, ContentKind: "json", Content: mustJSON(sk.Content), Message: &msg, CreatedByPID: sysPID}); err != nil {
				return nil, err
			}
			s.log.Info("built-in skill updated", "name", sk.Name, "rid", r.RID)
		}
		if raw := mustJSON(spec); !sameJSON(r.Spec, raw) {
			if _, err := s.store.UpdateSpec(ctx, r.RID, raw); err != nil {
				return nil, err
			}
		}
		refs = append(refs, r.RID.String())
	}
	return refs, nil
}
