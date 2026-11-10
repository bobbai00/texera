# Licensed to the Apache Software Foundation (ASF) under one
# or more contributor license agreements.  See the NOTICE file
# distributed with this work for additional information
# regarding copyright ownership.  The ASF licenses this file
# to you under the Apache License, Version 2.0 (the
# "License"); you may not use this file except in compliance
# with the License.  You may obtain a copy of the License at
#
#   http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing,
# software distributed under the License is distributed on an
# "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
# KIND, either express or implied.  See the License for the
# specific language governing permissions and limitations
# under the License.

# The cluster, from ../cluster's state. With a shared backend, read the same place here.
data "terraform_remote_state" "cluster" {
  backend = "local"
  config = {
    path = "${path.module}/../cluster/terraform.tfstate"
  }
}

locals {
  cluster = data.terraform_remote_state.cluster.outputs
}

provider "aws" {
  region = local.cluster.region
}

data "aws_eks_cluster" "this" {
  name = local.cluster.cluster_name
}

# The cluster's API, as the AWS CLI signs in to it: a kubeconfig for the provider alone.
locals {
  kubeconfig = yamlencode({
    apiVersion        = "v1"
    kind              = "Config"
    "current-context" = local.cluster.cluster_name
    clusters = [{
      name = local.cluster.cluster_name
      cluster = {
        server                       = data.aws_eks_cluster.this.endpoint
        "certificate-authority-data" = data.aws_eks_cluster.this.certificate_authority[0].data
      }
    }]
    contexts = [{
      name    = local.cluster.cluster_name
      context = { cluster = local.cluster.cluster_name, user = local.cluster.cluster_name }
    }]
    users = [{
      name = local.cluster.cluster_name
      user = {
        exec = {
          apiVersion      = "client.authentication.k8s.io/v1beta1"
          command         = "aws"
          args            = ["eks", "get-token", "--cluster-name", local.cluster.cluster_name, "--region", local.cluster.region, "--output", "json"]
          interactiveMode = "Never"
        }
      }
    }]
  })
}

provider "kustomization" {
  kubeconfig_raw = local.kubeconfig
}

# The deployment's own secrets, in place of the dev stack's values (deploy/kubernetes/texera.yaml).
# The secret store's token is chosen here so that the catalog and the store's init job agree on it.
resource "random_password" "keycloak_admin" {
  length  = 24
  special = false
}

resource "random_password" "services_client" {
  length  = 32
  special = false
}

resource "random_password" "unit_client" {
  length  = 32
  special = false
}

resource "random_password" "biomcp_key" {
  length  = 32
  special = false
}

resource "random_password" "lakekeeper_encryption" {
  length  = 32
  special = false
}

resource "random_password" "secrets_token" {
  length  = 32
  special = false
}

module "overlay" {
  source = "./overlay"

  namespace                  = local.cluster.namespace
  public_url                 = local.cluster.public_url
  repositories               = local.cluster.repositories
  image_digests              = var.image_digests
  region                     = local.cluster.region
  kms_key_id                 = local.cluster.openbao_kms_key_id
  openbao_service_account    = local.cluster.openbao_service_account
  lakekeeper_service_account = local.cluster.lakekeeper_service_account
  datasets_bucket            = local.cluster.datasets_bucket
  lake_bucket                = local.cluster.lake_bucket
  lake_role_arn              = local.cluster.lake_role_arn
  lake_external_id           = local.cluster.lake_external_id
  login_logo                 = var.login_logo
  postgres_storage           = var.postgres_storage
  secrets = {
    keycloak_admin_password   = random_password.keycloak_admin.result
    services_client_secret    = random_password.services_client.result
    unit_client_secret        = random_password.unit_client.result
    biomcp_key                = random_password.biomcp_key.result
    lakekeeper_encryption_key = random_password.lakekeeper_encryption.result
    secrets_token             = random_password.secrets_token.result
  }
}

# The namespace first; then the two objects made of generated values, which the render leaves
# out (overlay/main.tf); then everything else, workloads waited for.
resource "kustomization_resource" "p0" {
  for_each = module.overlay.ids_prio[0]
  manifest = module.overlay.manifests[each.value]
}

locals {
  labels = { "app.kubernetes.io/part-of" = "texera" }
}

resource "kustomization_resource" "clients" {
  manifest = jsonencode({
    apiVersion = "v1"
    kind       = "Secret"
    metadata   = { name = "texera2-clients", namespace = local.cluster.namespace, labels = local.labels }
    type       = "Opaque"
    stringData = {
      "services-client-secret"    = random_password.services_client.result
      "unit-client-secret"        = random_password.unit_client.result
      "biomcp-key"                = random_password.biomcp_key.result
      "keycloak-admin-password"   = random_password.keycloak_admin.result
      "lakekeeper-encryption-key" = random_password.lakekeeper_encryption.result
      "secrets-token"             = random_password.secrets_token.result
    }
  })
  depends_on = [kustomization_resource.p0]
}

resource "kustomization_resource" "realm" {
  manifest = jsonencode({
    apiVersion = "v1"
    kind       = "ConfigMap"
    metadata   = { name = "keycloak-realm", namespace = local.cluster.namespace, labels = local.labels }
    data       = { "texera-realm.json" = module.overlay.realm }
  })
  depends_on = [kustomization_resource.p0]
}

resource "kustomization_resource" "p1" {
  for_each = module.overlay.ids_prio[1]
  manifest = module.overlay.manifests[each.value]
  wait     = true
  timeouts {
    create = "30m"
    update = "30m"
    delete = "15m"
  }
  depends_on = [kustomization_resource.p0, kustomization_resource.clients, kustomization_resource.realm]
}

resource "kustomization_resource" "p2" {
  for_each   = module.overlay.ids_prio[2]
  manifest   = module.overlay.manifests[each.value]
  depends_on = [kustomization_resource.p1]
}
