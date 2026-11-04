package catalog

import (
	"context"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"regexp"
	"sort"
	"strings"

	"github.com/google/uuid"

	"github.com/apache/texera/catalog/internal/api"
	"github.com/apache/texera/catalog/internal/auth"
	"github.com/apache/texera/catalog/internal/kinds"
	"github.com/apache/texera/catalog/internal/ports"
	"github.com/apache/texera/catalog/internal/store"
)

// The skills the platform ships, as SKILL.md files: YAML frontmatter (name, description) and
// the body. Each file starts with the ASF license comment, which is not part of the skill.
//
//go:embed skills/*.md
var skillFiles embed.FS

var (
	leadingComment = regexp.MustCompile(`(?s)\A\s*<!--.*?-->\s*`)
	frontmatter    = regexp.MustCompile(`(?s)\A---\r?\n(.*?)\r?\n---\r?\n`)
)

type shippedSkill struct {
	Name, Description, Body string
}

func shippedSkills() ([]shippedSkill, error) {
	names, err := fs.Glob(skillFiles, "skills/*.md")
	if err != nil {
		return nil, err
	}
	sort.Strings(names)
	var out []shippedSkill
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
		sk := shippedSkill{Body: strings.TrimSpace(content[len(m[0]):])}
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

// Seed creates the platform principal, the system project, the settings, and the built-in
// resources: the dev stack's unit, the default environment, the platform's MCP servers,
// credentials and model endpoint, the shipped skills and the two templates. It is idempotent:
// a built-in whose shipped spec changed gets a new version authored by the platform.
func (s *Service) Seed(ctx context.Context) error {
	sys, _, err := s.Store.EnsureUser(ctx, "system:texera", "Texera", "", true)
	if err != nil {
		return err
	}
	caller := &auth.Caller{Principal: sys, Service: true}
	project, err := s.ensureSystemProject(ctx, caller)
	if err != nil {
		return err
	}
	// Everything under the system project is usable by everyone: the unit, the platform's
	// credentials and model endpoint. Written on every start; the authorizer ignores duplicates.
	if err := s.Store.SetEveryone(ctx, project.RID, "user", true); err != nil {
		return err
	}
	s.mu.Lock()
	s.system, s.systemProject = sys, project
	s.mu.Unlock()

	ensure := func(kind, name, desc string, spec any, status any, labels map[string]string) (*store.Resource, error) {
		return s.ensureBuiltin(ctx, caller, project, kind, name, desc, spec, status, labels)
	}

	var unitURI, envURI string
	if s.Config.StaticUnitEndpoint != "" {
		spec := api.ComputingUnitSpec{Provider: api.UnitProviderStatic, Endpoint: &s.Config.StaticUnitEndpoint}
		if s.Config.StaticUnitClientID != "" {
			spec.ClientId = &s.Config.StaticUnitClientID
		}
		unit, err := ensure("computing-unit", s.Config.StaticUnitName, "The computing unit of this deployment", spec, nil, nil)
		if err != nil {
			return err
		}
		// The client's subject is looked up on every start: the identity provider may have
		// been recreated since the unit was seeded.
		identity, err := s.unitIdentityFor(ctx, unit, spec)
		if err != nil {
			return fmt.Errorf("the static unit's identity: %w", err)
		}
		if identity != nil {
			if err := s.recordUnitIdentity(ctx, unit, identity); err != nil {
				return err
			}
		}
		unitURI = URI(unit).String()
	}
	env, err := ensure("environment", "python-default", "Python with pandas, numpy and scikit-learn",
		api.EnvironmentSpec{Python: &api.PythonEnvironment{Packages: []string{"pandas", "numpy", "scikit-learn"}}}, nil, nil)
	if err != nil {
		return err
	}
	envURI = URI(env).String()

	catalogMcp, err := ensure("mcp-server", "catalog", "The Texera catalog MCP server: search, read and share resources, versions and lineage; create agent templates",
		api.McpServerSpec{Url: s.Config.PublicURL + "/mcp/catalog", Builtin: strPtrOf("catalog")}, nil, nil)
	if err != nil {
		return err
	}
	dataflowMcp, err := ensure("mcp-server", "dataflow", "The Texera dataflow MCP server: operators, workflows, compilation, runs, results and dataset files",
		api.McpServerSpec{Url: s.Config.PublicURL + "/mcp/dataflow", Builtin: strPtrOf("dataflow")}, nil, nil)
	if err != nil {
		return err
	}
	_ = catalogMcp

	modelCred, err := ensure("credential", "anthropic-platform", "The platform's Anthropic API key, loaded into the secret store by the deployment",
		api.CredentialSpec{Kind: api.CredentialKindApiKey, Scope: strPtrOf("api.anthropic.com")}, api.CredentialStatus{SecretPath: &s.Config.ModelSecretPath}, nil)
	if err != nil {
		return err
	}
	s.refreshSecretStatus(ctx, modelCred)

	bioKeyPath := "platform/biomcp"
	bioCred, err := ensure("credential", "biomcp-key", "The API key of the platform's bio MCP server",
		api.CredentialSpec{Kind: api.CredentialKindApiKey, Scope: strPtrOf("bio-mcp")}, api.CredentialStatus{SecretPath: &bioKeyPath}, nil)
	if err != nil {
		return err
	}
	if s.Config.BioMcpKey != "" {
		if _, err := s.Secrets.Get(ctx, bioKeyPath); errors.Is(err, ports.ErrSecretNotFound) {
			if err := s.Secrets.Put(ctx, bioKeyPath, map[string]string{"value": s.Config.BioMcpKey}); err != nil {
				s.Log.Warn("seed bio key", "err", err)
			}
		}
	}
	s.refreshSecretStatus(ctx, bioCred)
	bioMcp, err := ensure("mcp-server", "biomcp", "The bio MCP server: PubMed, citation networks, genes, variants, proteins and clinical significance",
		api.McpServerSpec{Url: s.Config.BioMcpURL, Headers: &map[string]string{"X-API-Key": "credential:" + URI(bioCred).String() + "#value"}}, nil, nil)
	if err != nil {
		return err
	}

	model, err := ensure("model-endpoint", "anthropic-platform", "The platform's model: "+s.Config.ModelName,
		api.ModelEndpointSpec{Provider: api.ModelProviderAnthropic, Model: s.Config.ModelName, Credential: uriPtr(URI(modelCred).String()), MaxOutputTokens: int32Ptr(8192)}, nil, nil)
	if err != nil {
		return err
	}

	skills, err := shippedSkills()
	if err != nil {
		return err
	}
	skillURIs := map[string]string{}
	for _, sk := range skills {
		r, err := ensure("skill", sk.Name, sk.Description, api.SkillSpec{Name: sk.Name, Description: sk.Description, Body: sk.Body}, nil, nil)
		if err != nil {
			return err
		}
		skillURIs[sk.Name] = URI(r).String()
	}

	afterResult := api.LoopSpecAnswerAfterResult
	analyst, err := ensure("agent-template", "Data Analyst", "Analyzes datasets by building and running Texera workflows",
		api.AgentTemplateSpec{
			Card:       api.AgentCard{Name: "Data Analyst", Description: "Answers data questions by building, running and reading Texera workflows over the person's datasets; computes every number it reports."},
			Model:      api.Uri(URI(model).String()),
			Prompt:     dataAnalystPrompt,
			Skills:     uris(skillURIs["texera-workflows"], skillURIs["python-udf"], skillURIs["reading-results"]),
			McpServers: &[]api.McpBinding{{Server: api.Uri(URI(dataflowMcp).String())}},
			Loop:       &api.LoopSpec{Answer: &afterResult},
		}, nil, nil)
	if err != nil {
		return err
	}
	free := api.LoopSpecAnswerFree
	if _, err := ensure("agent-template", "Bio Researcher", "Grounds biomedical research ideas in the literature, genes, variants and proteins",
		api.AgentTemplateSpec{
			Card:       api.AgentCard{Name: "Bio Researcher", Description: "Proposes and grounds biomedical research ideas with PubMed, citation networks, gene, variant and protein lookups; hands data analysis to the Data Analyst."},
			Model:      api.Uri(URI(model).String()),
			Prompt:     bioResearcherPrompt,
			Skills:     uris(skillURIs["literature-review"]),
			McpServers: &[]api.McpBinding{{Server: api.Uri(URI(bioMcp).String())}},
			Handoffs:   uris(URI(analyst).String()),
			Loop:       &api.LoopSpec{Answer: &free},
		}, nil, nil); err != nil {
		return err
	}

	settings := api.SettingsSpec{Branding: api.Branding{Name: s.Config.BrandName}, Defaults: api.Defaults{AgentTemplate: uriPtr(URI(analyst).String()), Environment: uriPtr(envURI), ModelEndpoint: uriPtr(URI(model).String())}}
	if unitURI != "" {
		settings.Defaults.ComputingUnit = uriPtr(unitURI)
	}
	if err := s.ensureSettings(ctx, caller, settings); err != nil {
		return err
	}
	s.Relay.Flush(ctx)
	return nil
}

func (s *Service) ensureSystemProject(ctx context.Context, caller *auth.Caller) (*store.Resource, error) {
	pid := caller.PID()
	rs, err := s.Store.ListResources(ctx, store.ResourceFilter{Kind: "project", OwnerPID: &pid, Labels: map[string]string{"texera.system": "true"}, Limit: 1})
	if err != nil {
		return nil, err
	}
	if len(rs) > 0 {
		return &rs[0], nil
	}
	desc := "The platform's built-in resources: operators, templates, skills, MCP servers, the model endpoint"
	r, _, err := s.Store.CreateResource(ctx, store.NewResource{Kind: "project", Name: s.Config.BrandName, Description: &desc, OwnerPID: pid, CreatedByPID: pid, Visibility: "public", Labels: map[string]string{"texera.system": "true"}})
	if err != nil {
		return nil, err
	}
	s.Log.Info("seeded the system project", "rid", r.RID)
	return r, nil
}

// ensureBuiltin creates a public built-in or updates its spec when the shipped one changed.
func (s *Service) ensureBuiltin(ctx context.Context, caller *auth.Caller, project *store.Resource, kind, name, desc string, spec any, status any, labels map[string]string) (*store.Resource, error) {
	k, ok := kinds.ByName(kind)
	if !ok {
		return nil, fmt.Errorf("unknown kind %s", kind)
	}
	if labels == nil {
		labels = map[string]string{}
	}
	labels["texera.builtin"] = "true"
	specJSON := mustJSON(spec)
	var statusJSON json.RawMessage
	if status != nil {
		statusJSON = mustJSON(status)
	}
	existing, err := s.Store.ListResources(ctx, store.ResourceFilter{Kind: kind, ParentRID: &project.RID, Name: name, Limit: 1})
	if err != nil {
		return nil, err
	}
	if len(existing) == 0 {
		owner := caller.PID()
		r, _, err := s.Create(ctx, caller, CreateInput{Kind: k, Name: name, Description: &desc, Parent: &project.RID, Visibility: "public", Labels: labels, Spec: specJSON, Status: statusJSON, Owner: &owner})
		if err != nil {
			return nil, fmt.Errorf("seed %s %s: %w", kind, name, err)
		}
		s.Log.Info("seeded", "kind", kind, "name", name, "rid", r.RID)
		return r, nil
	}
	r := &existing[0]
	cur, _ := store.Canonical(r.Spec)
	next, _ := store.Canonical(specJSON)
	if string(cur) != string(next) {
		msg := "updated by the platform"
		updated, _, err := s.UpdateSpec(ctx, caller, k, UpdateSpecInput{RID: r.RID, Spec: specJSON, Message: &msg})
		if err != nil {
			return nil, fmt.Errorf("update %s %s: %w", kind, name, err)
		}
		s.Log.Info("built-in updated", "kind", kind, "name", name, "rid", r.RID)
		r = updated
	}
	if statusJSON != nil {
		if r, err = s.Store.MergeStatus(ctx, r.RID, statusJSON); err != nil {
			return nil, err
		}
	}
	return r, nil
}

func (s *Service) ensureSettings(ctx context.Context, caller *auth.Caller, spec api.SettingsSpec) error {
	k, _ := kinds.ByName("settings")
	r, err := s.Store.GetResource(ctx, SettingsRID)
	if err != nil {
		if !store.IsNotFound(err) {
			return err
		}
		normalized, err := s.prepareSpec(ctx, caller, k, "settings", mustJSON(spec))
		if err != nil {
			return err
		}
		rid := SettingsRID
		desc := "The deployment's settings"
		r, _, err = s.Store.CreateResource(ctx, store.NewResource{RID: &rid, Kind: "settings", Name: "settings", Description: &desc, OwnerPID: caller.PID(), CreatedByPID: caller.PID(), Visibility: "public", Spec: normalized})
		if err != nil {
			return err
		}
		s.Log.Info("seeded the settings")
	} else {
		// Fill defaults the deployment has not set, without overriding an administrator's choices.
		var current api.SettingsSpec
		_ = json.Unmarshal(r.Spec, &current)
		changed := false
		if current.Branding.Name == "" {
			current.Branding = spec.Branding
			changed = true
		}
		fill := func(dst **api.Uri, src *api.Uri) {
			if (*dst == nil || **dst == "") && src != nil {
				*dst = src
				changed = true
			}
		}
		fill(&current.Defaults.AgentTemplate, spec.Defaults.AgentTemplate)
		fill(&current.Defaults.Environment, spec.Defaults.Environment)
		fill(&current.Defaults.ComputingUnit, spec.Defaults.ComputingUnit)
		fill(&current.Defaults.ModelEndpoint, spec.Defaults.ModelEndpoint)
		if changed {
			if r, err = s.UpdateSettings(ctx, caller, mustJSON(current), ""); err != nil {
				return err
			}
		}
	}
	s.mu.Lock()
	s.settings = r
	s.mu.Unlock()
	return nil
}

func strPtrOf(s string) *string { return &s }

func uriPtr(s string) *api.Uri {
	u := api.Uri(s)
	return &u
}

func int32Ptr(n int32) *int32 { return &n }

func uris(values ...string) *[]api.Uri {
	out := make([]api.Uri, 0, len(values))
	for _, v := range values {
		if v != "" {
			out = append(out, api.Uri(v))
		}
	}
	return &out
}

var _ = uuid.Nil
