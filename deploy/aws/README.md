<!--
  ~ Licensed to the Apache Software Foundation (ASF) under one
  ~ or more contributor license agreements.  See the NOTICE file
  ~ distributed with this work for additional information
  ~ regarding copyright ownership.  The ASF licenses this file
  ~ to you under the Apache License, Version 2.0 (the
  ~ "License"); you may not use this file except in compliance
  ~ with the License.  You may obtain a copy of the License at
  ~
  ~   http://www.apache.org/licenses/LICENSE-2.0
  ~
  ~ Unless required by applicable law or agreed to in writing,
  ~ software distributed under the License is distributed on an
  ~ "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
  ~ KIND, either express or implied.  See the License for the
  ~ specific language governing permissions and limitations
  ~ under the License.
-->

# Texera 2.0 on AWS

Everything the local cluster runs (`deploy/kubernetes`), on EKS, from one command:

```
deploy/aws/deploy.sh up            # the cluster, the images, the stack, the model key; prints the URL
deploy/aws/deploy.sh check         # the scenarios and Playwright against the public URL
deploy/aws/deploy.sh status        # pods, services, jobs, volumes
deploy/aws/deploy.sh kubectl ...   # kubectl in the stack's namespace
deploy/aws/deploy.sh down          # remove the stack; the cluster stays
deploy/aws/deploy.sh destroy       # remove everything
```

Two Terraform root modules, applied in order by `deploy.sh`:

| Module | Makes |
|---|---|
| `cluster/` | A VPC of its own (public and private subnets in three zones, one NAT gateway), the EKS cluster (access by IAM, managed add-ons only: VPC CNI, kube-proxy, CoreDNS, Pod Identity, EBS CSI), one managed node group of Graviton nodes in the private subnets, an ECR repository per image, two S3 buckets (the catalog's dataset files, the lake's tables) with the roles and pod identities that reach them, the KMS key that unseals the secret store, a network load balancer to the gateway's node port, and, when a domain is given, the certificate and the DNS name. |
| `texera/` | The stack: `deploy/kubernetes` through a kustomize overlay for the cloud (`texera/overlay`), applied as Terraform resources. The overlay points the images at the registry by digest, puts the public URL where the base has `localhost:28088`, replaces the dev stack's secrets with generated ones, renders the config maps `k8s.sh` makes from the dev stack's files, puts S3 where the base has RustFS, sizes the volumes on EBS, and runs OpenBao with a volume and the KMS seal instead of dev mode. |

`deploy.sh up` is `cluster` (Terraform), `images` (`docker build` for the nodes' architecture and
`docker push`, the digests written to `texera/images.auto.tfvars.json`), `stack` (Terraform, then
wait for the gateway) and `model-key`. Each is a command of its own for a rerun: new images are
`deploy.sh images && deploy.sh stack`; a changed manifest, `deploy.sh stack`. The stack's apply
waits for every workload to be ready (30 minutes at most); a workload that never is fails the
apply and stays unrecorded, and `deploy.sh stack` adopts such objects into the state on its next
run, so a fix is a rerun.

## Prerequisites

| Tool | Why |
|---|---|
| `aws` (CLI v2), signed in to the account | Terraform's credentials, `aws eks get-token` for kubectl, the registry login |
| `terraform` 1.10 or later | both modules |
| `docker` | building and pushing the images |
| `kubectl`, `jq`, `curl`, `git` | `deploy.sh` |

The account needs to create a VPC, an EKS cluster, IAM roles, ECR repositories, S3 buckets, a
KMS key and a load balancer; nothing is created outside the region (`us-east-2` by default). The model key
comes from `ANTHROPIC_API_KEY` or `TEXERA_ENV_FILE` (a `.env` with `ANTHROPIC_API_KEY=...`), as
for the local stacks; `TEXERA2_LOGIN_LOGO` puts a deployment's own logo on the sign-in pages.

## The public URL, the domain and the certificate

Without a domain the stack answers over HTTP on the load balancer's own name, which Terraform
prints (`public_url`). To give it a name and HTTPS, set two variables in `cluster/` (a
`terraform.tfvars`, or `TF_VAR_domain_name` and `TF_VAR_hosted_zone_name`):

```
domain_name      = "texera.example.edu"
hosted_zone_name = "example.edu"          # a public Route 53 zone in the account
```

With those, `cluster/dns.tf` requests an ACM certificate validated by a record in the zone,
`ingress.tf` adds a TLS listener on 443 with it and sends port 80 to a listener of the gateway
that only redirects, and the name becomes an alias of the load balancer. The public URL becomes
`https://texera.example.edu`, the issuer of every token.

The public URL is configured into the stack: the gateway checks it as the issuer, Keycloak's
realm sends the app back to it, Lakekeeper reads the identity provider from it. It can change
after the first deployment, and nothing people made is touched: `deploy.sh cluster` with the
new variables, then `deploy.sh stack`, which sees the address changed, restarts what read the
old one and gives the realm's app client the new one (Keycloak imports its realm only once, so
that is done with its admin CLI, in its pod).

A deployment people use needs the domain. A browser gives a page Web Crypto (which the sign-in's
PKCE and the app's identifiers use) only at a secure address: `https://`, or `http://localhost`.
Over plain HTTP on the load balancer's name the API answers, `verify.py` and the API scenarios
pass, but nobody can sign in with a browser: the sign-in page says so.

## What differs from the local cluster, and why

- **Secrets.** `deploy/kubernetes/texera.yaml`'s `texera2-clients` carries the dev stack's values;
  here Terraform generates them (`random_password`) and the realm is rendered with the same, so
  the service clients, Keycloak's administrator, the bio server's key and Lakekeeper's encryption
  key are this deployment's own. The Secret and the realm's config map are built by
  `texera/main.tf` rather than rendered by kustomize, since a render that took values made at
  apply time could not be planned; the overlay drops the base's Secret.
  `terraform -chdir=deploy/aws/texera output -json secrets` shows them. Postgres keeps the dev
  values: it is reachable only inside the namespace.
- **The object store is S3, and nobody holds a key to it.** The base runs RustFS; here the
  overlay drops it and the cluster module makes two buckets. The catalog reaches the datasets
  bucket as itself, through the pod identity of its `catalog` service account (its S3 settings
  name the region and no endpoint or key, `TEXERA_S3_*`). The lake's warehouses are AWS
  profiles: Lakekeeper, through the pod identity of its `lakekeeper` account, may only assume
  the warehouse role (`lake_role_arn`, by an external id), which has the lake bucket; it reads
  and writes through that role and vends credentials to the units from it, downscoped to the
  tables they work on, as it vends them from the dev stack's store. The units hold no key: they
  read dataset files by the presigned URLs the catalog gives them and write results through the
  vended credentials. (A project's own warehouse on another store still takes an endpoint and a
  key, as before.)
- **The secret store persists.** OpenBao runs with a file store on an EBS volume and an `awskms`
  seal: the cluster's KMS key, used through the pod identity of the `openbao` service account.
  The init job initializes it once, over its API, keeps the recovery key in the Secret
  `openbao-recovery`, mints the catalog's token (`texera2-clients`' `secrets-token`, root policy
  like the dev stack's) and revokes the one initialization returned. The model key is not loaded
  by the job but by `deploy.sh model-key`, through the store's CLI in its pod, from stdin: it is
  in no manifest, state file or Secret, and the store keeps it across restarts.
- **The way in.** The load balancer is Terraform's, made before the stack, so the public URL is
  known when the stack is configured, and TLS is a listener and a certificate rather than a change
  inside the cluster. It sends to the gateway Service's node port 30088 on every node (the base's
  own `NodePort`); client addresses are not preserved, so the nodes' security group only admits
  the VPC. Lakekeeper reaches the issuer by the public name like any client, so the socat sidecar
  the local cluster needs for `localhost` is removed.
- **Volumes.** A default `gp3` storage class (encrypted, bound where the pod lands); Postgres 20 GB
  (`texera/variables.tf`), OpenBao 10 GB. Volume claims are made at the first deployment; a
  bigger size afterwards is an edit of the PVC, which the class allows. A pod that runs as its
  own user gets its volume through `fsGroup`, since a fresh volume belongs to root.
- **Nodes.** Graviton (`m7g.2xlarge`, 8 CPUs and 32 GB, two of them) by default: the images are
  built on Apple silicon for arm64, and every third-party image ships arm64. `node_instance_type`
  and `node_architecture` go together; `deploy.sh images` builds for the latter. Pods cannot reach
  the instance metadata (hop limit 1), so a computing unit's Python cannot use the node's role;
  what needs AWS (the EBS driver, OpenBao) has a pod identity. A unit of the Large profile asks
  for 8 CPUs and needs a bigger node.
- **Images by digest.** The overlay sets each image to `repository@sha256:...` from
  `texera/images.auto.tfvars.json`, so a tag pushed again is still a change and `IfNotPresent`
  is safe. The images are built without attestations: those are made anew by every build, and
  would give an image that did not change a new digest, starting every workload again at
  every deployment. As built, only what changed is rolled.

## Cost

At the defaults, while it runs: the EKS control plane ($0.10/h), two `m7g.2xlarge` ($0.33/h
each), one NAT gateway ($0.045/h plus traffic), the load balancer ($0.0225/h plus use), the
volumes (30 GB of gp3, a few dollars a month), S3 by use, and the key ($1 a month): roughly $600
a month in `us-east-2`. `deploy.sh down` keeps the cluster and stops nothing of that;
`deploy.sh destroy` removes everything, the buckets with what they hold (the KMS key is
scheduled for deletion in seven days; the log group goes at once).

## State and access

Terraform's state is local, in `cluster/` and `texera/` (gitignored), on the machine that
deploys; `texera/main.tf` reads `cluster/`'s outputs from its state file. For a shared state,
add a backend to both `versions.tf` and point the `terraform_remote_state` at it. `deploy.sh`
writes kubectl's access to a kubeconfig of its own (`~/.kube/texera2-aws.yaml`, or
`TEXERA2_AWS_KUBECONFIG`) and never the default one. The IAM principal that applies `cluster/`
administers the cluster; `admin_principal_arns` adds others.

Another machine can work on the deployment too. It needs a clone of this branch, the tools
above, AWS credentials of a principal the cluster admits, and three files git does not carry,
copied from the machine that deployed: `cluster/terraform.tfstate`, `texera/terraform.tfstate`
and `texera/images.auto.tfvars.json`. The state holds the generated secrets in plain text, so
it is copied over SSH and never committed. `deploy.sh` makes `.terraform/` and the kubeconfig
again. A deployment with its own logo needs `TEXERA2_LOGIN_LOGO` there too, or the next
`deploy.sh stack` puts the default back. `deploy.sh plan` says "No changes" for both modules
when the copy is right; do that first, since `deploy.sh up` or `cluster` without the state would
build a second deployment beside this one. A state file has no lock between machines, so apply
from one at a time and carry the state along, or make it shared as above. On a machine of
another architecture, `deploy.sh images` needs Docker's emulation of the nodes' one
(`docker run --privileged --rm tonistiigi/binfmt --install arm64`).

## Checking it

`deploy.sh check` runs `bin/texera-2-0/test.sh cluster` against the public URL: the end-to-end
scenarios of `tests/e2e` that do not need a model or the Compose host (the cluster scenarios
included: a unit made as a resource becomes a Deployment, its Secret, its Service), then
Playwright without the model. The tests take this deployment's client secrets from the
environment (`TEXERA_E2E_SERVICES_CLIENT_SECRET` and the lake's), which `deploy.sh check` sets
from Terraform's outputs; the one scenario that puts a warehouse on the deployment's own store
with its key is skipped, since this store has no key. For kubectl by hand: `deploy.sh kubectl
get pods`.

The demo's project goes onto the deployment as onto any stack, and is checked there against a
stack known to be right (`bin/texera-2-0/examples/diabetes`):

```
python3 bin/texera-2-0/examples/diabetes/load.py --data ~/texera-diabetes --gw <public URL> --sign-in-page
python3 bin/texera-2-0/examples/diabetes/verify.py --data ~/texera-diabetes --gw <public URL> --against http://localhost:28088
```

## Left for later

RDS for Postgres; more than one replica of the services; a node group for units, scaled on
demand; a token for the catalog scoped to its mount rather than the root policy; an identity
for the units' large-binary values, which the engine writes to a bucket of its own with a key
(`STORAGE_S3_*`) and so cannot write here.
