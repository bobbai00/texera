package catalog

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/google/uuid"

	"github.com/apache/texera/catalog/internal/api"
	"github.com/apache/texera/catalog/internal/auth"
	"github.com/apache/texera/catalog/internal/authz"
	"github.com/apache/texera/catalog/internal/kinds"
	"github.com/apache/texera/catalog/internal/store"
	"github.com/apache/texera/catalog/internal/uri"
)

// What a chat runs with. A chat stores choices and nothing else: its agent, the model the agent
// uses, the computing unit its executions prefer, its add-on MCP servers. Each is optional, and a new
// chat stores none. A turn runs with the chat's choice, else the project's, else the agent's own
// or the platform's default. A choice that names something gone, or something the caller may
// not use, is passed over and reported, so a chat shared with someone who lacks its owner's
// rights still works for them.
//
// This file is the one place that decides it. The runtime builds a turn from the answer, the
// app shows it, and a run in the chat takes its unit from the same rule.

// McpPath is where the catalog serves its own MCP server, under its public URL.
const McpPath = "/mcp/catalog"

var (
	projectKind, _       = kinds.ByName("project")
	modelEndpointKind, _ = kinds.ByName("model-endpoint")
	mcpServerKind, _     = kinds.ByName("mcp-server")
	credentialKind, _    = kinds.ByName("credential")
)

// ChatSettings is what a turn of a conversation runs with, for the caller.
func (s *Service) ChatSettings(ctx context.Context, caller *auth.Caller, rid uuid.UUID) (*api.ChatSettings, error) {
	conv, err := s.Get(ctx, caller, &conversationKind, rid)
	if err != nil {
		return nil, err
	}
	return s.chatSettings(ctx, caller, conv)
}

// NewChatSettings is what a turn of a chat not started yet would run with in a project.
func (s *Service) NewChatSettings(ctx context.Context, caller *auth.Caller, project uuid.UUID) (*api.ChatSettings, error) {
	p, err := s.Get(ctx, caller, &projectKind, project)
	if err != nil {
		return nil, err
	}
	return s.resolveChat(ctx, caller, api.ConversationSpec{}, p)
}

func (s *Service) chatSettings(ctx context.Context, caller *auth.Caller, conv *store.Resource) (*api.ChatSettings, error) {
	var chat api.ConversationSpec
	if err := json.Unmarshal(conv.Spec, &chat); err != nil || conv.ProjectRID == nil {
		return nil, Invalid("the conversation's spec is not one", nil)
	}
	// The chat's project is read without a permission check: someone a chat is shared with
	// works in it whether or not the whole project is theirs to read.
	project, err := s.Store.GetResource(ctx, *conv.ProjectRID)
	if err != nil {
		return nil, wrap(err, "project")
	}
	return s.resolveChat(ctx, caller, chat, project)
}

// choice is what one level names for a setting.
type choice struct {
	uri  *api.Uri
	from api.SettingSource
}

// chatResolver resolves the settings of one chat for one caller, keeping what it passes over.
type chatResolver struct {
	s       *Service
	ctx     context.Context
	caller  *auth.Caller
	skipped []api.SkippedSetting
}

func (s *Service) resolveChat(ctx context.Context, caller *auth.Caller, chat api.ConversationSpec, project *store.Resource) (*api.ChatSettings, error) {
	r := &chatResolver{s: s, ctx: ctx, caller: caller}
	var inProject api.ProjectSpec
	_ = json.Unmarshal(project.Spec, &inProject)
	platform := s.settingsSpec(ctx).Defaults

	agent, chosen := r.first(api.SkippedSettingSettingTemplate, r.agent,
		choice{chat.Template, api.SettingSourceChat}, choice{inProject.DefaultAgentTemplate, api.SettingSourceProject}, choice{platform.AgentTemplate, api.SettingSourcePlatform})
	if agent == nil {
		return nil, Conflict("no_agent", "no agent for this chat: neither the chat, its project nor the platform names one the caller may use", nil)
	}
	// The agent at the version a turn runs: the one its URI pins, else the head.
	out := &api.ChatSettings{
		Project: api.ChatProject{Rid: api.Rid(project.RID.String()), Name: project.Name},
		Agent:   api.Setting{Uri: api.Uri(URI(agent).WithVersion(versionOf(agent, *chosen.uri)).String()), Name: agent.Name, From: chosen.from},
	}
	var own api.AgentTemplateSpec
	if err := json.Unmarshal(agent.Spec, &own); err != nil {
		return nil, Invalid(agent.Name+" is not an agent template", nil)
	}

	model, chosen := r.first(api.SkippedSettingSettingModelEndpoint, r.modelEndpoint,
		choice{chat.ModelEndpoint, api.SettingSourceChat}, choice{inProject.DefaultModelEndpoint, api.SettingSourceProject}, choice{&own.Model, api.SettingSourceAgent})
	if model == nil {
		return nil, Conflict("no_model", "no model endpoint for this chat that the caller may use", nil)
	}
	out.ModelEndpoint = settingOf(model, chosen.from)

	if unit, chosen := r.first(api.SkippedSettingSettingComputingUnit, r.computingUnit,
		choice{chat.ComputingUnit, api.SettingSourceChat}, choice{inProject.DefaultComputingUnit, api.SettingSourceProject}, choice{platform.ComputingUnit, api.SettingSourcePlatform}); unit != nil {
		setting := settingOf(unit, chosen.from)
		out.ComputingUnit = &setting
	}

	out.McpServers = r.servers(own, chat, inProject)
	if len(r.skipped) > 0 {
		out.Skipped = &r.skipped
	}
	return out, nil
}

// first returns the first choice that names something the caller may use, with what it names.
func (r *chatResolver) first(setting api.SkippedSettingSetting, usable func(string) (*store.Resource, error), choices ...choice) (*store.Resource, choice) {
	for _, c := range choices {
		if c.uri == nil || strings.TrimSpace(string(*c.uri)) == "" {
			continue
		}
		found, err := usable(string(*c.uri))
		if err != nil {
			r.skip(setting, *c.uri, c.from, err)
			continue
		}
		return found, c
	}
	return nil, choice{}
}

func (r *chatResolver) skip(setting api.SkippedSettingSetting, name api.Uri, from api.SettingSource, err error) {
	reason := err.Error()
	var refused *Error
	if errors.As(err, &refused) {
		switch refused.Code {
		case "forbidden":
			reason = "it is not yours to use"
		case "not_found":
			reason = "it no longer exists"
		default:
			reason = refused.Message
		}
	}
	r.skipped = append(r.skipped, api.SkippedSetting{Setting: setting, Uri: name, From: from, Reason: reason})
}

// agent: an agent template the caller may read.
func (r *chatResolver) agent(name string) (*store.Resource, error) {
	return r.s.resourceByURI(r.ctx, r.caller, name, &templateKind)
}

// modelEndpoint: an endpoint the caller may read, whose credential, when it has one, the
// caller may use; a turn leases it as them.
func (r *chatResolver) modelEndpoint(name string) (*store.Resource, error) {
	endpoint, err := r.s.resourceByURI(r.ctx, r.caller, name, &modelEndpointKind)
	if err != nil {
		return nil, err
	}
	var spec api.ModelEndpointSpec
	if err := json.Unmarshal(endpoint.Spec, &spec); err != nil {
		return nil, Invalid(endpoint.Name+" is not a model endpoint", nil)
	}
	if spec.Credential != nil {
		credential, err := r.s.resourceByURI(r.ctx, r.caller, string(*spec.Credential), &credentialKind)
		if err != nil {
			return nil, err
		}
		if err := r.s.require(r.ctx, r.caller, authz.Use, credential.RID); err != nil {
			return nil, err
		}
	}
	return endpoint, nil
}

// computingUnit: a unit the caller may run on.
func (r *chatResolver) computingUnit(name string) (*store.Resource, error) {
	return r.s.usableUnit(r.ctx, r.caller, name)
}

// usableUnit loads a unit by URI when the caller may run on it.
func (s *Service) usableUnit(ctx context.Context, caller *auth.Caller, name string) (*store.Resource, error) {
	unit, err := s.named(ctx, name, unitKind)
	if err != nil {
		return nil, err
	}
	if err := s.require(ctx, caller, authz.RunOn, unit.RID); err != nil {
		return nil, err
	}
	return unit, nil
}

// server: an MCP server the caller may read.
func (r *chatResolver) server(name string) (*store.Resource, error) {
	return r.s.resourceByURI(r.ctx, r.caller, name, &mcpServerKind)
}

// servers lists what a turn mounts. The platform's own server, when the agent lists it, is
// always there. The add-ons are the chat's when it lists its own, else the agent's and then
// the project's. A server is mounted once, and what the agent may call of it is the agent's
// rule wherever the server is listed.
func (r *chatResolver) servers(agent api.AgentTemplateSpec, chat api.ConversationSpec, project api.ProjectSpec) []api.ServerSetting {
	type listed struct {
		uri   api.Uri
		from  api.SettingSource
		allow *[]string
	}
	var order []listed
	allowed := map[string]*[]string{}
	if agent.McpServers != nil {
		for _, b := range *agent.McpServers {
			order = append(order, listed{b.Server, api.SettingSourceAgent, b.Allow})
			if ref, err := uri.Parse(string(b.Server)); err == nil {
				allowed[ref.Rid] = b.Allow
			}
		}
	}
	ownChoice := chat.McpServers != nil
	if ownChoice {
		for _, name := range *chat.McpServers {
			order = append(order, listed{name, api.SettingSourceChat, nil})
		}
	} else if project.McpServers != nil {
		for _, name := range *project.McpServers {
			order = append(order, listed{name, api.SettingSourceProject, nil})
		}
	}

	platform, addOns := []api.ServerSetting{}, []api.ServerSetting{}
	seen := map[uuid.UUID]bool{}
	for _, l := range order {
		server, err := r.server(string(l.uri))
		if err != nil {
			r.skip(api.SkippedSettingSettingMcpServers, l.uri, l.from, err)
			continue
		}
		own := r.s.ownMcpServer(server)
		if seen[server.RID] || (ownChoice && l.from == api.SettingSourceAgent && !own) {
			continue
		}
		seen[server.RID] = true
		setting := api.ServerSetting{Uri: api.Uri(URI(server).String()), Name: server.Name, From: l.from, Platform: own, Allow: l.allow}
		if setting.Allow == nil {
			setting.Allow = allowed[server.RID.String()]
		}
		if own {
			platform = append(platform, setting)
		} else {
			addOns = append(addOns, setting)
		}
	}
	return append(platform, addOns...)
}

// ownMcpServer reports whether an MCP server resource is the catalog's own: its URL is where
// the catalog serves MCP. A turn reaches it inside the deployment and calls it as the person.
func (s *Service) ownMcpServer(server *store.Resource) bool {
	var spec api.McpServerSpec
	if err := json.Unmarshal(server.Spec, &spec); err != nil {
		return false
	}
	return strings.TrimSuffix(spec.Url, "/") == s.ownMcpURL()
}

func (s *Service) ownMcpURL() string {
	return strings.TrimSuffix(s.Config.PublicURL, "/") + McpPath
}

func settingOf(r *store.Resource, from api.SettingSource) api.Setting {
	return api.Setting{Uri: api.Uri(URI(r).String()), Name: r.Name, From: from}
}

// versionOf is the version a URI names of a resource: the one it pins, else the head.
func versionOf(r *store.Resource, name api.Uri) int {
	if ref, err := uri.Parse(string(name)); err == nil && ref.Vno > 0 {
		return ref.Vno
	}
	return r.HeadVno
}

// chatUnit is the computing unit the chat a call acts in prefers, when the runtime vouches for
// the chat and the caller may run on the unit: a person picks where the executions of a chat
// go, and what an agent runs goes there without having to be told. A unit that is not the caller's to use
// is passed over, as in the chat's settings.
func (s *Service) chatUnit(ctx context.Context, caller *auth.Caller) string {
	if caller.Origin == nil {
		return ""
	}
	conversation, err := s.Store.GetResource(ctx, caller.Origin.Conversation)
	if err != nil || conversation.Kind != conversationKind.Name {
		return ""
	}
	var chat api.ConversationSpec
	if err := json.Unmarshal(conversation.Spec, &chat); err != nil || chat.ComputingUnit == nil {
		return ""
	}
	if _, err := s.usableUnit(ctx, caller, string(*chat.ComputingUnit)); err != nil {
		return ""
	}
	return string(*chat.ComputingUnit)
}
