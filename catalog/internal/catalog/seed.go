package catalog

import (
	"context"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"maps"
	"regexp"
	"sort"
	"strings"

	"github.com/google/uuid"

	"github.com/apache/texera/catalog/internal/api"
	"github.com/apache/texera/catalog/internal/auth"
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

// Seed creates the platform principal and Texera, the project every project inherits from, and
// brings into Texera what this release ships: the profiles and the deployment's unit made from
// one, the warehouse, the catalog's MCP server and the bio add-on, the credentials and the model
// endpoint, the skills and the agent. Texera's admins may change or delete any of it, and a
// release leaves what they did as it is (release.go). Texera's settings get the shipped defaults
// where its admins have set none.
func (s *Service) Seed(ctx context.Context) error {
	sys, _, err := s.Store.EnsureUser(ctx, "system:texera", "Texera", "")
	if err != nil {
		return err
	}
	caller := &auth.Caller{Principal: sys, Service: true}
	root, err := s.ensureRoot(ctx, caller)
	if err != nil {
		return err
	}
	// Texera is open to everyone: what it holds is usable by all, its unit, credentials and
	// model endpoint among them. Written on every start; the authorizer ignores duplicates.
	if err := s.Store.SetEveryone(ctx, root.RID, "user", true); err != nil {
		return err
	}
	s.mu.Lock()
	s.system, s.root = sys, root
	s.mu.Unlock()

	// What this start ships, by kind and name.
	ships := map[string]map[string]bool{}
	ship := func(kind, name, description string, spec any, status any) (*store.Resource, error) {
		if ships[kind] == nil {
			ships[kind] = map[string]bool{}
		}
		ships[kind][name] = true
		in := shipment{kind: kind, name: name, description: description, spec: mustJSON(spec)}
		if status != nil {
			in.status = mustJSON(status)
		}
		return s.ship(ctx, caller, in)
	}
	uriOf := func(r *store.Resource) *api.Uri {
		if r == nil {
			return nil
		}
		return uriPtr(URI(r).String())
	}

	// scikit-learn is pinned: a model saved with joblib loads only in a scikit-learn close to the
	// one it was fitted with (one fitted with 1.7 does not load in 1.9), so every unit the release
	// makes runs the one the teams fit their models with, which the dev stack's Python has too.
	const fitsModels = "scikit-learn==1.7.2"
	// The profile the deployment's unit is made from: a node of 2 CPUs and 2 GB with the Python
	// libraries most analyses use.
	cpu, memory, packages := "2", "2Gi", []string{"pandas", "numpy", fitsModels}
	profile, err := ship("profile", "python-default", "2 CPUs and 2 GB with pandas, numpy and scikit-learn", api.ProfileSpec{Cpu: &cpu, Memory: &memory, Packages: &packages}, nil)
	if err != nil {
		return err
	}

	// The ladder the agent offers: sizes for data work, and for models on CPU or on a GPU.
	// Each says, when read, whether this deployment can start it: a cluster without GPUs starts
	// no GPU unit, and on Compose a unit from a profile is the deployment's own unit.
	data := []string{"pandas", "numpy", "pyarrow", "scipy", fitsModels, "statsmodels"}
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
		if _, err := ship("profile", rung.name, rung.description, spec, nil); err != nil {
			return err
		}
	}

	var unit *store.Resource
	if s.Config.StaticUnitEndpoint != "" && profile != nil {
		madeFrom := api.Uri(URI(profile).WithVersion(profile.HeadVno).String())
		spec := api.ComputingUnitSpec{
			Provider:       api.UnitProviderStatic,
			Endpoint:       &s.Config.StaticUnitEndpoint,
			ComputingNodes: &[]api.ComputingNodeSpec{{Name: "master", Role: api.ComputingNodeSpecRoleMaster, Profile: &madeFrom, Cpu: &cpu, Memory: &memory, Packages: &packages}},
		}
		if s.Config.StaticUnitClientID != "" {
			spec.ClientId = &s.Config.StaticUnitClientID
		}
		if unit, err = ship("computing-unit", s.Config.StaticUnitName, "The computing unit of this deployment", spec, nil); err != nil {
			return err
		}
		if unit != nil {
			// The client's subject is looked up on every start: the identity provider may have
			// been recreated since the unit was seeded.
			var current api.ComputingUnitSpec
			if err := json.Unmarshal(unit.Spec, &current); err != nil {
				return err
			}
			identity, err := s.unitIdentityFor(ctx, unit, current)
			if err != nil {
				return fmt.Errorf("the deployment's unit's identity: %w", err)
			}
			if identity != nil {
				if err := s.recordUnitIdentity(ctx, unit, identity); err != nil {
					return err
				}
			}
		}
	}
	// The deployment's warehouse, where an execution keeps its results unless something names
	// another. Its storage is looked at on every start: the store's address may have changed.
	warehouse, err := ship("warehouse", s.Config.Warehouse, "The warehouse of this deployment", api.WarehouseSpec{}, api.WarehouseStatus{Name: &s.Config.Warehouse})
	if err != nil {
		return err
	}
	if warehouse != nil {
		s.mu.Lock()
		s.warehouse = warehouse.RID
		s.mu.Unlock()
		if err := s.provisionWarehouse(ctx, warehouse); err != nil {
			return fmt.Errorf("the deployment's warehouse: %w", err)
		}
		// An execution of a release that had one warehouse kept its results in this one.
		if n, err := s.Store.FillExecutionWarehouse(ctx, URI(warehouse).String()); err != nil {
			return err
		} else if n > 0 {
			s.Log.Info("executions given their warehouse", "executions", n)
		}
	}

	catalogMcp, err := ship("mcp-server", "catalog", "The Texera MCP server: every resource with its versions, lineage and sharing, dataset files, operators, computing units, and building and running workflows",
		api.McpServerSpec{Url: s.ownMcpURL()}, nil)
	if err != nil {
		return err
	}

	modelCred, err := ship("credential", "anthropic-platform", "The deployment's Anthropic API key, loaded into the secret store by the deployment",
		api.CredentialSpec{Kind: api.CredentialKindApiKey, Scope: strPtrOf("api.anthropic.com")}, api.CredentialStatus{SecretPath: &s.Config.ModelSecretPath})
	if err != nil {
		return err
	}
	if modelCred != nil {
		s.refreshSecretStatus(ctx, modelCred)
	}

	bioKeyPath := "platform/biomcp"
	bioCred, err := ship("credential", "biomcp-key", "The API key of the deployment's bio MCP server",
		api.CredentialSpec{Kind: api.CredentialKindApiKey, Scope: strPtrOf("bio-mcp")}, api.CredentialStatus{SecretPath: &bioKeyPath})
	if err != nil {
		return err
	}
	var bioMcp *store.Resource
	if bioCred != nil {
		if s.Config.BioMcpKey != "" {
			if _, err := s.Secrets.Get(ctx, bioKeyPath); errors.Is(err, ports.ErrSecretNotFound) {
				if err := s.Secrets.Put(ctx, bioKeyPath, map[string]string{"value": s.Config.BioMcpKey}); err != nil {
					s.Log.Warn("seed bio key", "err", err)
				}
			}
		}
		s.refreshSecretStatus(ctx, bioCred)
		if bioMcp, err = ship("mcp-server", "biomcp", "The bio MCP server: PubMed, citation networks, genes, variants, proteins and clinical significance",
			api.McpServerSpec{Url: s.Config.BioMcpURL, Headers: &map[string]string{"X-API-Key": "credential:" + URI(bioCred).String() + "#value"}}, nil); err != nil {
			return err
		}
	}

	var model *store.Resource
	if modelCred != nil {
		if model, err = ship("model-endpoint", "anthropic-platform", "The deployment's model: "+s.Config.ModelName,
			api.ModelEndpointSpec{Provider: api.ModelProviderAnthropic, Model: s.Config.ModelName, Credential: uriOf(modelCred), MaxOutputTokens: int32Ptr(8192)}, nil); err != nil {
			return err
		}
	}

	skills, err := shippedSkills()
	if err != nil {
		return err
	}
	var skillURIs []string
	for _, sk := range skills {
		r, err := ship("skill", sk.Name, sk.Description, api.SkillSpec{Name: sk.Name, Description: sk.Description, Body: sk.Body}, nil)
		if err != nil {
			return err
		}
		if r != nil {
			skillURIs = append(skillURIs, URI(r).String())
		}
	}

	// One agent is the entry to every chat. It mounts the catalog's own server, its basic
	// tools, and the bio add-on, and loads every shipped skill on demand. It answers every kind
	// of question, so a reply without a tool call is its answer.
	card, err := shippedAgent()
	if err != nil {
		return err
	}
	var agent *store.Resource
	if model != nil && catalogMcp != nil {
		servers := []api.McpBinding{{Server: api.Uri(URI(catalogMcp).String())}}
		if bioMcp != nil {
			servers = append(servers, api.McpBinding{Server: api.Uri(URI(bioMcp).String())})
		}
		free := api.LoopSpecAnswerFree
		if agent, err = ship("agent-template", card.Name, card.Description,
			api.AgentTemplateSpec{
				Card:       api.AgentCard{Name: card.Name, Description: card.Description},
				Model:      api.Uri(URI(model).String()),
				Prompt:     card.Body,
				Skills:     uris(skillURIs...),
				McpServers: &servers,
				Loop:       &api.LoopSpec{Answer: &free},
			}, nil); err != nil {
			return err
		}
	}

	gone := map[string]bool{}
	for _, kind := range []string{"profile", "computing-unit", "warehouse", "mcp-server", "credential", "model-endpoint", "skill", "agent-template"} {
		went, err := s.unship(ctx, kind, ships[kind])
		if err != nil {
			return err
		}
		maps.Copy(gone, went)
	}

	return s.fillRootSettings(ctx, caller, api.ProjectSpec{
		Branding: &api.Branding{Name: &s.Config.BrandName},
		// No model: a chat's agent brings its own unless a chat or a project chooses another.
		Defaults: &api.ProjectDefaults{AgentTemplate: uriOf(agent), ComputingUnit: uriOf(unit), Profile: uriOf(profile), Warehouse: uriOf(warehouse)},
	}, gone)
}

// Texera: what it is called and what it says it holds, when it is made.
const (
	rootName        = "Texera"
	rootDescription = "Texera itself, which every project inherits from: the agent and its skills, the engine's operators, the profiles, the computing unit and the warehouse of this deployment. Its settings are every project's unless the project sets its own."
)

// ensureRoot returns Texera, making it at the first start: a public project the platform owns,
// marked as the root. Its admins rename and describe it as they like.
func (s *Service) ensureRoot(ctx context.Context, caller *auth.Caller) (*store.Resource, error) {
	pid := caller.PID()
	rs, err := s.Store.ListResources(ctx, store.ResourceFilter{Kind: "project", OwnerPID: &pid, Labels: map[string]string{rootLabel: "true"}, Limit: 1})
	if err != nil {
		return nil, err
	}
	if len(rs) > 0 {
		return &rs[0], nil
	}
	desc := rootDescription
	r, _, err := s.Store.CreateResource(ctx, store.NewResource{Kind: "project", Name: rootName, Description: &desc, OwnerPID: pid, CreatedByPID: pid, Visibility: "public", Labels: map[string]string{rootLabel: "true"}})
	if err != nil {
		return nil, err
	}
	s.Log.Info("made Texera, the project every project inherits from", "rid", r.RID)
	return r, nil
}

// fillRootSettings gives Texera's settings what this release ships where its admins have set
// nothing, and a default that named what no longer ships gives way to what does. What its admins
// chose stays.
func (s *Service) fillRootSettings(ctx context.Context, caller *auth.Caller, shipped api.ProjectSpec, gone map[string]bool) error {
	root := s.Root()
	var current api.ProjectSpec
	_ = json.Unmarshal(root.Spec, &current)
	changed := false
	if current.Branding == nil {
		current.Branding = &api.Branding{}
	}
	if current.Branding.Name == nil || strings.TrimSpace(*current.Branding.Name) == "" {
		current.Branding.Name = shipped.Branding.Name
		changed = true
	}
	if current.Defaults == nil {
		current.Defaults = &api.ProjectDefaults{}
	}
	fill := func(dst **api.Uri, src *api.Uri) {
		if (*dst == nil || **dst == "" || gone[string(**dst)]) && src != nil {
			*dst = src
			changed = true
		}
	}
	fill(&current.Defaults.AgentTemplate, shipped.Defaults.AgentTemplate)
	fill(&current.Defaults.ComputingUnit, shipped.Defaults.ComputingUnit)
	fill(&current.Defaults.Profile, shipped.Defaults.Profile)
	fill(&current.Defaults.Warehouse, shipped.Defaults.Warehouse)
	if !changed {
		return nil
	}
	updated, _, err := s.UpdateSpec(ctx, caller, projectKind, UpdateSpecInput{RID: root.RID, Spec: mustJSON(current)})
	if err != nil {
		return fmt.Errorf("Texera's settings: %w", err)
	}
	s.mu.Lock()
	s.root = updated
	s.mu.Unlock()
	return nil
}

// shippedWarehouse is the warehouse the release ships, on the deployment's own store.
func (s *Service) shippedWarehouse() uuid.UUID {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.warehouse
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
