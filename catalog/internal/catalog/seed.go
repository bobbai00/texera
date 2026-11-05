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

// The agent the platform ships, in the same form: the frontmatter is its card, the body its
// system prompt. The file is the source of truth; a changed file is a new version of the
// template at the next start, and a turn runs the newest version.
//
//go:embed agents/texera-agent.md
var agentFile []byte

var (
	leadingComment = regexp.MustCompile(`(?s)\A\s*<!--.*?-->\s*`)
	frontmatter    = regexp.MustCompile(`(?s)\A---\r?\n(.*?)\r?\n---\r?\n`)
)

// shipped is a file the platform ships: its frontmatter's name and description, and its body.
type shipped struct {
	Name, Description, Body string
}

// parseShipped reads one shipped file: the license comment is dropped, the frontmatter must
// give a name and a description, and the rest is the body.
func parseShipped(file string, data []byte) (shipped, error) {
	content := leadingComment.ReplaceAllString(string(data), "")
	m := frontmatter.FindStringSubmatch(content)
	if m == nil {
		return shipped{}, fmt.Errorf("%s: no frontmatter", file)
	}
	out := shipped{Body: strings.TrimSpace(content[len(m[0]):])}
	for _, line := range strings.Split(m[1], "\n") {
		key, value, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		value = strings.Trim(strings.TrimSpace(value), `"'`)
		switch strings.TrimSpace(key) {
		case "name":
			out.Name = value
		case "description":
			out.Description = value
		}
	}
	if out.Name == "" || out.Description == "" {
		return shipped{}, fmt.Errorf("%s: the frontmatter needs name and description", file)
	}
	if out.Body == "" {
		return shipped{}, fmt.Errorf("%s: no body", file)
	}
	return out, nil
}

func shippedSkills() ([]shipped, error) {
	names, err := fs.Glob(skillFiles, "skills/*.md")
	if err != nil {
		return nil, err
	}
	sort.Strings(names)
	var out []shipped
	for _, name := range names {
		data, err := skillFiles.ReadFile(name)
		if err != nil {
			return nil, err
		}
		sk, err := parseShipped(name, data)
		if err != nil {
			return nil, err
		}
		out = append(out, sk)
	}
	return out, nil
}

// shippedAgent is the platform's agent: its card and its system prompt.
func shippedAgent() (shipped, error) {
	return parseShipped("agents/texera-agent.md", agentFile)
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

	// One agent is the entry to every chat. It mounts the platform's dataflow server and the bio
	// add-on (the catalog server is every agent's), and loads every shipped skill on demand. It
	// answers every kind of question, so a reply without a tool call is its answer.
	card, err := shippedAgent()
	if err != nil {
		return err
	}
	var allSkills []string
	for _, sk := range skills {
		allSkills = append(allSkills, skillURIs[sk.Name])
	}
	free := api.LoopSpecAnswerFree
	agent, err := ensure("agent-template", card.Name, card.Description,
		api.AgentTemplateSpec{
			Card:       api.AgentCard{Name: card.Name, Description: card.Description},
			Model:      api.Uri(URI(model).String()),
			Prompt:     card.Body,
			Skills:     uris(allSkills...),
			McpServers: &[]api.McpBinding{{Server: api.Uri(URI(dataflowMcp).String())}, {Server: api.Uri(URI(bioMcp).String())}},
			Loop:       &api.LoopSpec{Answer: &free},
		}, nil, nil)
	if err != nil {
		return err
	}
	// Agents an older release shipped stay, so the chats that use them keep working; they are no
	// longer anybody's default.
	retired, err := s.retiredAgents(ctx, project, agent)
	if err != nil {
		return err
	}

	settings := api.SettingsSpec{Branding: api.Branding{Name: s.Config.BrandName}, Defaults: api.Defaults{AgentTemplate: uriPtr(URI(agent).String()), Environment: uriPtr(envURI), ModelEndpoint: uriPtr(URI(model).String())}}
	if unitURI != "" {
		settings.Defaults.ComputingUnit = uriPtr(unitURI)
	}
	if err := s.ensureSettings(ctx, caller, settings, retired); err != nil {
		return err
	}
	s.Relay.Flush(ctx)
	return nil
}

// retiredAgents lists, by URI, the built-in agent templates the platform no longer ships.
func (s *Service) retiredAgents(ctx context.Context, project *store.Resource, shippedAgent *store.Resource) (map[string]bool, error) {
	builtins, err := s.Store.ListResources(ctx, store.ResourceFilter{Kind: "agent-template", ParentRID: &project.RID, Labels: map[string]string{"texera.builtin": "true"}, Limit: 200})
	if err != nil {
		return nil, err
	}
	retired := map[string]bool{}
	for i := range builtins {
		if builtins[i].RID != shippedAgent.RID {
			retired[URI(&builtins[i]).String()] = true
		}
	}
	return retired, nil
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

// ensureSettings creates the settings, or fills what the deployment has not set. retiredAgents
// are agent templates that may no longer be the default: the shipped one takes their place.
func (s *Service) ensureSettings(ctx context.Context, caller *auth.Caller, spec api.SettingsSpec, retiredAgents map[string]bool) error {
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
		if current.Defaults.AgentTemplate != nil && retiredAgents[string(*current.Defaults.AgentTemplate)] {
			current.Defaults.AgentTemplate = spec.Defaults.AgentTemplate
			changed = true
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
