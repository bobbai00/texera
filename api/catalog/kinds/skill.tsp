// skill: a document an agent loads on demand (SKILL.md), versioned as a whole.
import "@typespec/http";
import "@typespec/rest";
import "@typespec/openapi";
import "../../common.tsp";
import "../core.tsp";

using Http;
using Rest;
using OpenAPI;

namespace Texera.Catalog;

model SkillSpec {
  @doc("The name the agent loads it by.")
  name: string;
  @doc("When to load it; shown to the agent in its skill index.")
  description: string;
  @doc("The skill's body, Markdown.")
  body: string;
}

model SkillStatus {}

@extension("x-texera-kind", #{ kind: "skill", plural: "skills", versioned: true, content: "spec", parent: "project" })
model Skill is Typed<SkillSpec, SkillStatus>;
model SkillPage is Page<Skill>;
model CreateSkill is Create<SkillSpec>;
model UpdateSkill is UpdateSpec<SkillSpec>;
model SkillVersion is TypedVersion<SkillSpec>;
model SkillVersionPage is Page<VersionSummary>;

namespace Routes {
  @route("/skills")
  interface Skills
    extends VersionedKindRoutes<Skill, SkillPage, CreateSkill, UpdateSkill, SkillVersion, SkillVersionPage> {}
}
