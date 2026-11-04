// credential: metadata about a secret whose value lives in the secret store. The value is
// written through `secret` and never read back; a lease hands it to a run or a turn.
import "@typespec/http";
import "@typespec/rest";
import "@typespec/openapi";
import "../../common.tsp";
import "../core.tsp";

using Http;
using Rest;
using OpenAPI;

namespace Texera.Catalog;

enum CredentialKind {
  apiKey: "api_key",
  bearerToken: "bearer_token",
  basic,
  oauthClient: "oauth_client",
  cloudRole: "cloud_role",
  kubeconfig,
}

model CredentialSpec {
  kind: CredentialKind;
  @doc("What the credential is for, free text, e.g. the provider or host.")
  scope?: string;
}

model CredentialStatus {
  hasSecret: boolean;
  rotatedAt?: utcDateTime;
  @doc("Where the value lives in the secret store; set by the platform, never a value.")
  secretPath?: string;
}

@doc("The secret's fields, e.g. {value} for an API key, {username, password} for basic.")
model SetSecret {
  fields: Record<string>;
}

model LeaseRequest {
  @doc("What the lease is for: an execution or a conversation turn URI; recorded on the lease.")
  purpose: Uri;
}

model Lease {
  lease: string;
  fields: Record<string>;
  expiresAt: utcDateTime;
}

@extension("x-texera-kind", #{ kind: "credential", plural: "credentials", versioned: false, content: "spec", parent: "project" })
model Credential is Typed<CredentialSpec, CredentialStatus>;
model CredentialPage is Page<Credential>;
model CreateCredential is Create<CredentialSpec>;
model UpdateCredential is UpdateSpec<CredentialSpec>;

namespace Routes {
  @route("/credentials")
  interface Credentials extends KindRoutes<Credential, CredentialPage, CreateCredential, UpdateCredential> {
    @doc("Write the secret; replaces the previous value.")
    @put
    @route("/{rid}/secret")
    @extension("x-texera-permission", "rotate")
    setSecret(@path rid: Rid, @body body: SetSecret): void | Error;

    @doc("Lease the secret for a run or a turn; the use is logged.")
    @post
    @route("/{rid}/lease")
    @extension("x-texera-permission", "use")
    lease(@path rid: Rid, @body body: LeaseRequest): Created<Lease> | Error;
  }
}
