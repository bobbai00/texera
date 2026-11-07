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
// resources: the dev stack's unit and the profile it is made from, the catalog's MCP server and the
// bio add-on, the credentials and the model endpoint, the shipped skills and the agent. It
// makes the platform's project what this release ships: a built-in whose shipped spec changed
// gets a new version authored by the platform, and one an older release shipped is removed.
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

	// What this start ships, by rid, and the kinds it ships.
	shipped, seeded := map[uuid.UUID]bool{}, map[string]bool{}
	ensure := func(kind, name, desc string, spec any, status any) (*store.Resource, error) {
		r, err := s.ensureBuiltin(ctx, caller, project, kind, name, desc, spec, status)
		if err == nil {
			shipped[r.RID], seeded[kind] = true, true
		}
		return r, err
	}

	// The platform's profile: a node of 2 GB with the Python libraries most analyses use. The
	// deployment's unit is made from it.
	memory, packages := "2Gi", []string{"pandas", "numpy", "scikit-learn"}
	profile, err := ensure("profile", "python-default", "2 GB with pandas, numpy and scikit-learn", api.ProfileSpec{Memory: &memory, Packages: &packages}, nil)
	if err != nil {
		return err
	}
	madeFrom := api.Uri(URI(profile).WithVersion(profile.HeadVno).String())

	// The ladder the agent offers: sizes for data work, and for models on CPU or on a GPU.
	// Each says, when read, whether this deployment can start it: Compose starts no unit from
	// a profile, and a cluster without GPUs no GPU unit.
	data := []string{"pandas", "numpy", "pyarrow", "scipy", "scikit-learn", "statsmodels"}
	ml := append(append([]string{}, data...), "torch", "xgboost", "onnxruntime")
	for _, rung := range []struct {
		name, description, cpu, memory string
		gpu                            int32
		packages                       []string
	}{
		{"Small", "2 CPUs and 4 GB for data work: exploring, tables under a million rows", "2", "4Gi", 0, data},
		{"Medium", "4 CPUs and 8 GB for data work: most analyses", "4", "8Gi", 0, data},
		{"Large", "8 CPUs and 16 GB for data work: big tables, many workers per operator", "8", "16Gi", 0, data},
		{"ML", "4 CPUs and 12 GB with PyTorch, xgboost and onnxruntime: models on CPU", "4", "12Gi", 0, ml},
		{"GPU", "4 CPUs, 12 GB and a GPU with PyTorch: training and fast inference", "4", "12Gi", 1, ml},
	} {
		spec := api.ProfileSpec{Cpu: &rung.cpu, Memory: &rung.memory, Packages: &rung.packages}
		if rung.gpu > 0 {
			spec.Gpu = &rung.gpu
		}
		if _, err := ensure("profile", rung.name, rung.description, spec, nil); err != nil {
			return err
		}
	}

	var unitURI string
	if s.Config.StaticUnitEndpoint != "" {
		spec := api.ComputingUnitSpec{
			Provider:       api.UnitProviderStatic,
			Endpoint:       &s.Config.StaticUnitEndpoint,
			ComputingNodes: &[]api.ComputingNodeSpec{{Name: "master", Role: api.ComputingNodeSpecRoleMaster, Profile: &madeFrom, Memory: &memory, Packages: &packages}},
		}
		if s.Config.StaticUnitClientID != "" {
			spec.ClientId = &s.Config.StaticUnitClientID
		}
		unit, err := ensure("computing-unit", s.Config.StaticUnitName, "The computing unit of this deployment", spec, nil)
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
	// The platform's warehouse, where an execution keeps its results unless something names
	// another. Its storage is looked at on every start: the store's address may have changed.
	warehouse, err := ensure("warehouse", s.Config.Warehouse, "The warehouse of this deployment", api.WarehouseSpec{}, api.WarehouseStatus{Name: &s.Config.Warehouse})
	if err != nil {
		return err
	}
	if err := s.provisionWarehouse(ctx, warehouse); err != nil {
		return fmt.Errorf("the platform's warehouse: %w", err)
	}
	// An execution of a release that had one warehouse kept its results in this one.
	if n, err := s.Store.FillExecutionWarehouse(ctx, URI(warehouse).String()); err != nil {
		return err
	} else if n > 0 {
		s.Log.Info("executions given their warehouse", "executions", n)
	}

	catalogMcp, err := ensure("mcp-server", "catalog", "The Texera MCP server: every resource with its versions, lineage and sharing, dataset files, operators, computing units, and building and running workflows",
		api.McpServerSpec{Url: s.ownMcpURL()}, nil)
	if err != nil {
		return err
	}

	modelCred, err := ensure("credential", "anthropic-platform", "The platform's Anthropic API key, loaded into the secret store by the deployment",
		api.CredentialSpec{Kind: api.CredentialKindApiKey, Scope: strPtrOf("api.anthropic.com")}, api.CredentialStatus{SecretPath: &s.Config.ModelSecretPath})
	if err != nil {
		return err
	}
	s.refreshSecretStatus(ctx, modelCred)

	bioKeyPath := "platform/biomcp"
	bioCred, err := ensure("credential", "biomcp-key", "The API key of the platform's bio MCP server",
		api.CredentialSpec{Kind: api.CredentialKindApiKey, Scope: strPtrOf("bio-mcp")}, api.CredentialStatus{SecretPath: &bioKeyPath})
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
		api.McpServerSpec{Url: s.Config.BioMcpURL, Headers: &map[string]string{"X-API-Key": "credential:" + URI(bioCred).String() + "#value"}}, nil)
	if err != nil {
		return err
	}

	model, err := ensure("model-endpoint", "anthropic-platform", "The platform's model: "+s.Config.ModelName,
		api.ModelEndpointSpec{Provider: api.ModelProviderAnthropic, Model: s.Config.ModelName, Credential: uriPtr(URI(modelCred).String()), MaxOutputTokens: int32Ptr(8192)}, nil)
	if err != nil {
		return err
	}

	skills, err := shippedSkills()
	if err != nil {
		return err
	}
	skillURIs := map[string]string{}
	for _, sk := range skills {
		r, err := ensure("skill", sk.Name, sk.Description, api.SkillSpec{Name: sk.Name, Description: sk.Description, Body: sk.Body}, nil)
		if err != nil {
			return err
		}
		skillURIs[sk.Name] = URI(r).String()
	}

	// One agent is the entry to every chat. It mounts the catalog's own server, its basic
	// tools, and the bio add-on, and loads every shipped skill on demand. It answers every kind
	// of question, so a reply without a tool call is its answer.
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
			McpServers: &[]api.McpBinding{{Server: api.Uri(URI(catalogMcp).String())}, {Server: api.Uri(URI(bioMcp).String())}},
			Loop:       &api.LoopSpec{Answer: &free},
		}, nil)
	if err != nil {
		return err
	}
	retired, err := s.retire(ctx, project, sys.PID, shipped, seeded)
	if err != nil {
		return err
	}

	settings := api.SettingsSpec{Branding: api.Branding{Name: s.Config.BrandName}, Defaults: api.Defaults{AgentTemplate: uriPtr(URI(agent).String()), ModelEndpoint: uriPtr(URI(model).String()), Profile: uriPtr(URI(profile).String()), Warehouse: uriPtr(URI(warehouse).String())}}
	if unitURI != "" {
		settings.Defaults.ComputingUnit = uriPtr(unitURI)
	}
	if err := s.ensureSettings(ctx, caller, settings, retired); err != nil {
		return err
	}
	s.Relay.Flush(ctx)
	return nil
}

// retire removes from the platform's project what the platform made there and this release no
// longer ships, and returns their URIs. What named one falls back: a chat to the platform's
// agent, the settings' default to the shipped one. Only the kinds the seed ships are looked at:
// the engine's operators are kept by the sync that reads them from a unit, and what someone
// else made there before the project was closed to them is theirs.
func (s *Service) retire(ctx context.Context, project *store.Resource, platform uuid.UUID, shipped map[uuid.UUID]bool, seeded map[string]bool) (map[string]bool, error) {
	retired := map[string]bool{}
	for kind := range seeded {
		made, err := s.Store.ListResources(ctx, store.ResourceFilter{Kind: kind, ParentRID: &project.RID, OwnerPID: &platform, Limit: 500})
		if err != nil {
			return nil, err
		}
		for i := range made {
			old := &made[i]
			if shipped[old.RID] {
				continue
			}
			if err := s.Store.DeleteResource(ctx, old.RID); err != nil {
				return nil, fmt.Errorf("retire %s %s: %w", kind, old.Name, err)
			}
			retired[URI(old).String()] = true
			s.Log.Info("built-in retired", "kind", kind, "name", old.Name, "rid", old.RID)
		}
	}
	return retired, nil
}

// The platform's project: what it is called and what it says it holds.
const (
	systemProjectName        = "Built-in"
	systemProjectDescription = "What the platform ships: the agent, its skills and MCP servers, the model endpoint, the default computing unit and its profile, and the engine's operators. Everyone can use them; they change with a release."
)

// ensureSystemProject returns the platform's project, creating it at the first start. It is
// the one place that says what is built in: a resource is built in when it lives here. The
// project is public and usable by everyone, and what is in it is theirs through it.
func (s *Service) ensureSystemProject(ctx context.Context, caller *auth.Caller) (*store.Resource, error) {
	pid := caller.PID()
	rs, err := s.Store.ListResources(ctx, store.ResourceFilter{Kind: "project", OwnerPID: &pid, Labels: map[string]string{"texera.system": "true"}, Limit: 1})
	if err != nil {
		return nil, err
	}
	name, desc := systemProjectName, systemProjectDescription
	if len(rs) == 0 {
		r, _, err := s.Store.CreateResource(ctx, store.NewResource{Kind: "project", Name: name, Description: &desc, OwnerPID: pid, CreatedByPID: pid, Visibility: "public", Labels: map[string]string{"texera.system": "true"}})
		if err != nil {
			return nil, err
		}
		s.Log.Info("seeded the system project", "rid", r.RID)
		return r, nil
	}
	r := &rs[0]
	if r.Name != name || r.Description == nil || *r.Description != desc {
		return s.Store.UpdateMetadata(ctx, store.MetadataUpdate{RID: r.RID, Name: &name, Description: &desc})
	}
	return r, nil
}

// ensureBuiltin creates a built-in in the platform's project, or makes the one that is there
// what the release ships: its description, and a new version when the shipped spec changed.
func (s *Service) ensureBuiltin(ctx context.Context, caller *auth.Caller, project *store.Resource, kind, name, desc string, spec any, status any) (*store.Resource, error) {
	k, ok := kinds.ByName(kind)
	if !ok {
		return nil, fmt.Errorf("unknown kind %s", kind)
	}
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
		r, _, err := s.Create(ctx, caller, CreateInput{Kind: k, Name: name, Description: &desc, Parent: &project.RID, Spec: specJSON, Status: statusJSON, Owner: &owner})
		if err != nil {
			return nil, fmt.Errorf("seed %s %s: %w", kind, name, err)
		}
		s.Log.Info("seeded", "kind", kind, "name", name, "rid", r.RID)
		return r, nil
	}
	r := &existing[0]
	if r.Description == nil || *r.Description != desc {
		if r, err = s.Store.UpdateMetadata(ctx, store.MetadataUpdate{RID: r.RID, Description: &desc}); err != nil {
			return nil, fmt.Errorf("describe %s %s: %w", kind, name, err)
		}
	}
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

// ensureSettings creates the settings, or fills what the deployment has not set. A default
// that names a retired built-in gives way to the shipped one; an administrator's own choice stays.
func (s *Service) ensureSettings(ctx context.Context, caller *auth.Caller, spec api.SettingsSpec, retired map[string]bool) error {
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
			if (*dst == nil || **dst == "" || retired[string(**dst)]) && src != nil {
				*dst = src
				changed = true
			}
		}
		fill(&current.Defaults.AgentTemplate, spec.Defaults.AgentTemplate)
		fill(&current.Defaults.ComputingUnit, spec.Defaults.ComputingUnit)
		fill(&current.Defaults.Profile, spec.Defaults.Profile)
		fill(&current.Defaults.Warehouse, spec.Defaults.Warehouse)
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
