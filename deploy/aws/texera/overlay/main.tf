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

# The cloud overlay over deploy/kubernetes, rendered by kustomize: the base as it is, its images
# from the registry by digest, the deployment's URL in place of the dev value, the config maps
# k8s.sh makes from the dev stack's files, S3 as the object store in place of the base's RustFS
# (the catalog and the lake reach it as themselves, through their pod identities), volumes on
# EBS, and the secret store with a volume and the KMS seal. What is an overlay patch is a
# difference from the local cluster; what is a generator is what k8s.sh does imperatively. The
# two objects that carry generated secrets, the texera2-clients Secret and the realm, are not
# rendered here: a render that took values made at apply time could not be planned. The base's
# Secret is dropped, and the root module builds both from the `realm` output and the secrets
# (../main.tf).

locals {
  stack = "${path.module}/../../../../bin/texera-2-0"
  base  = "${path.module}/../../../kubernetes"
  theme = "${local.stack}/keycloak/themes/texera/login"
  logo  = var.login_logo != "" ? var.login_logo : "${local.theme}/resources/img/texera-logo.png"

  unit_image = "${var.repositories["computing-unit-master"]}@${var.image_digests["computing-unit-master"]}"

  # The gateway config is the dev stack's with the host services replaced by cluster names and
  # the issuer by the public URL, the substitutions k8s.sh makes, plus a listener that only
  # redirects to HTTPS: port 80 of the load balancer is sent there once there is a certificate.
  gateway_dev = file("${local.stack}/envoy/envoy.yaml")
  gateway_services = replace(replace(replace(replace(replace(replace(local.gateway_dev,
    "uri: http://host.docker.internal:8090", "uri: http://catalog:8090"),
    "address: host.docker.internal, port_value: 8090", "address: catalog, port_value: 8090"),
    "address: host.docker.internal, port_value: 23002", "address: agent-runtime, port_value: 23002"),
    "address: host.docker.internal, port_value: 23003", "address: live, port_value: 23003"),
    "address: host.docker.internal, port_value: 23010", "address: bio-mcp, port_value: 23010"),
  "address: host.docker.internal, port_value: 5174", "address: frontend, port_value: 8080")
  gateway = replace(replace(replace(local.gateway_services,
    "issuer: http://localhost:8088/auth/realms/texera", "issuer: ${var.public_url}/auth/realms/texera"),
    local.keycloak_dev, local.keycloak_public),
  "  listeners:\n", "  listeners:\n${local.redirect_listener}")
  # Keycloak at a public address answers for the realm people sign in to and for its pages'
  # files, and for nothing else: its administration (the console, the admin API, the master
  # realm an administrator signs in to) has no route. The dev stack's one route for all of
  # /auth/ becomes those two and a 404 for the rest, which keeps the dev route's own filter
  # settings. An administrator works in Keycloak's pod, as `deploy.sh` does.
  keycloak_dev      = "- match: { prefix: \"/auth/\" }\n                          route: { cluster: keycloak, timeout: 60s }\n"
  keycloak_public   = <<EOT
- match: { path_separated_prefix: "/auth/realms/texera" }
                          route: { cluster: keycloak, timeout: 60s }
                          typed_per_filter_config:
                            envoy.filters.http.ext_authz:
                              "@type": type.googleapis.com/envoy.extensions.filters.http.ext_authz.v3.ExtAuthzPerRoute
                              disabled: true
                        - match: { path_separated_prefix: "/auth/resources" }
                          route: { cluster: keycloak, timeout: 60s }
                          typed_per_filter_config:
                            envoy.filters.http.ext_authz:
                              "@type": type.googleapis.com/envoy.extensions.filters.http.ext_authz.v3.ExtAuthzPerRoute
                              disabled: true
                        - match: { prefix: "/auth/" }
                          direct_response: { status: 404 }
EOT
  redirect_listener = <<EOT
    - name: redirect
      address:
        socket_address: { address: 0.0.0.0, port_value: 8081 }
      filter_chains:
        - filters:
            - name: envoy.filters.network.http_connection_manager
              typed_config:
                "@type": type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager
                stat_prefix: redirect
                route_config:
                  name: redirect
                  virtual_hosts:
                    - name: redirect
                      domains: ["*"]
                      routes:
                        - match: { prefix: "/" }
                          redirect: { https_redirect: true }
                http_filters:
                  - name: envoy.filters.http.router
                    typed_config:
                      "@type": type.googleapis.com/envoy.extensions.filters.http.router.v3.Router
EOT

  # The realm is the dev stack's with the app sent back to the public URL and the service
  # clients given this deployment's secrets, the same the texera2-clients Secret carries.
  realm_dev = jsondecode(file("${local.stack}/keycloak/texera-realm.json"))
  client_secrets = {
    "texera-services" = var.secrets.services_client_secret
    "texera-unit"     = var.secrets.unit_client_secret
  }
  # The people are the dev stack's too, each with this deployment's password instead of their
  # name. `deploy.sh stack` gives a realm that is already up the same people and passwords.
  people = [for user in local.realm_dev.users : user.username if can(user.credentials)]
  # How people sign in at a public address. Nobody registers themselves: the accounts are the
  # deployment's. And a name signed in to with wrong passwords is locked for a while, by
  # Keycloak's own defaults, spelled out: after 30 wrong ones for a minute, a minute more with
  # every 30 after that, fifteen minutes at most; two wrong ones within a second lock it for a
  # minute at once; twelve hours without one start the count again. Nobody is locked for good.
  # `deploy.sh stack` gives a realm that is already up the same.
  sign_in = {
    registrationAllowed          = false
    bruteForceProtected          = true
    permanentLockout             = false
    failureFactor                = 30
    waitIncrementSeconds         = 60
    maxFailureWaitSeconds        = 900
    quickLoginCheckMilliSeconds  = 1000
    minimumQuickLoginWaitSeconds = 60
    maxDeltaTimeSeconds          = 43200
  }
  realm = jsonencode(merge(local.realm_dev, local.sign_in, {
    clients = [for client in local.realm_dev.clients : merge(client,
      { for id, secret in local.client_secrets : "secret" => secret if id == client.clientId },
      { for id in ["texera-app"] : "redirectUris" => ["${var.public_url}/*"] if id == client.clientId },
    )]
    users = [for user in local.realm_dev.users : merge(user,
      can(user.credentials) ? { credentials = [{ type = "password", value = var.passwords[user.username], temporary = false }] } : {},
    )]
  }))

  # The secret store: data on its volume, unsealed by the key through the pod identity.
  openbao_config = <<-EOT
    ui            = false
    disable_mlock = true
    api_addr      = "http://openbao:8200"

    listener "tcp" {
      address     = "0.0.0.0:8200"
      tls_disable = true
    }

    storage "file" {
      path = "/openbao/file"
    }

    seal "awskms" {
      region     = "${var.region}"
      kms_key_id = "${var.kms_key_id}"
    }
  EOT
}

data "kustomization_overlay" "texera" {
  namespace = var.namespace
  resources = [
    local.base,
    "${path.module}/manifests/storage-class.yaml",
    "${path.module}/manifests/openbao-store.yaml",
    "${path.module}/manifests/lakekeeper-identity.yaml",
  ]

  labels {
    pairs             = { "app.kubernetes.io/part-of" = "texera" }
    include_selectors = false
  }

  dynamic "images" {
    for_each = var.repositories
    content {
      name     = "texera/${images.key}"
      new_name = images.value
      digest   = var.image_digests[images.key]
    }
  }

  # The config maps k8s.sh renders from the dev stack's files. The gateway reads its config
  # when it starts, so the config's map is named after what it says: a config that changed is
  # another map, and the gateway starts again with it.
  config_map_generator {
    name     = "gateway-config"
    literals = ["envoy.yaml=${local.gateway}"]
  }

  config_map_generator {
    name = "keycloak-theme"
    files = [
      "theme.properties=${local.theme}/theme.properties",
      "texera.css=${local.theme}/resources/css/texera.css",
      "texera-logo.png=${local.logo}",
    ]
    options {
      disable_name_suffix_hash = true
    }
  }

  config_map_generator {
    name  = "postgres-init"
    files = ["init.sql=${local.stack}/postgres/init.sql"]
    options {
      disable_name_suffix_hash = true
    }
  }

  config_map_generator {
    name     = "openbao-config"
    literals = ["server.hcl=${local.openbao_config}"]
    options {
      disable_name_suffix_hash = true
    }
  }

  # What differs from the local cluster.
  patches {
    patch = templatefile("${path.module}/patches/public.tmpl.yaml", { public_url = var.public_url, unit_image = local.unit_image })
  }
  patches {
    path = "${path.module}/patches/clients.yaml"
  }
  patches {
    patch = templatefile("${path.module}/patches/volume.tmpl.yaml", { name = "postgres", size = var.postgres_storage })
  }
  patches {
    patch = templatefile("${path.module}/patches/store.tmpl.yaml", {
      region        = var.region, datasets_bucket = var.datasets_bucket, lake_bucket = var.lake_bucket,
      lake_role_arn = var.lake_role_arn, lake_external_id = var.lake_external_id,
    })
  }
  patches {
    patch = templatefile("${path.module}/patches/unit-store.tmpl.yaml", { region = var.region })
  }
  patches {
    patch = templatefile("${path.module}/patches/lakekeeper.tmpl.yaml", { region = var.region })
  }
  patches {
    path = "${path.module}/patches/no-rustfs.yaml"
  }
  patches {
    path = "${path.module}/patches/gateway.yaml"
  }
  patches {
    path = "${path.module}/patches/openbao.yaml"
  }
  patches {
    path = "${path.module}/patches/openbao-init.yaml"
  }

  kustomize_options {
    load_restrictor = "none"
  }

  lifecycle {
    precondition {
      condition     = !strcontains(local.gateway, "host.docker.internal") && !strcontains(local.gateway, "localhost:8088")
      error_message = "The gateway config still points at the dev host; update the substitutions here as in bin/texera-2-0/k8s.sh."
    }
    precondition {
      condition     = strcontains(local.gateway, "direct_response: { status: 404 }") && !strcontains(local.gateway, "- match: { prefix: \"/auth/\" }\n                          route:")
      error_message = "The gateway config still routes all of /auth/ to Keycloak, its administration included; update keycloak_dev here to the dev stack's route as bin/texera-2-0/envoy/envoy.yaml has it."
    }
    precondition {
      condition     = var.openbao_service_account == "openbao"
      error_message = "manifests/openbao-store.yaml and patches/openbao.yaml name the service account openbao; the cluster binds the unseal key to ${var.openbao_service_account}."
    }
    precondition {
      condition     = var.lakekeeper_service_account == "lakekeeper"
      error_message = "manifests/lakekeeper-identity.yaml and patches/lakekeeper.tmpl.yaml name the service account lakekeeper; the cluster binds the lake's role to ${var.lakekeeper_service_account}."
    }
  }
}
