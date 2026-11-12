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

output "ids_prio" {
  description = "The rendered resources' ids in three sets: namespaces first, then everything, then webhooks."
  value       = data.kustomization_overlay.texera.ids_prio
}

output "manifests" {
  description = "Each rendered resource as JSON, by id."
  value       = data.kustomization_overlay.texera.manifests
}

output "people" {
  description = "Who signs in with a password: the root module generates one for each."
  value       = local.people
}

output "sign_in" {
  description = "How people sign in, as the realm is rendered with: deploy.sh gives a realm that is already up the same."
  value       = local.sign_in
}

output "realm" {
  description = "The realm Keycloak imports, rendered for this deployment: the root module makes its config map."
  sensitive   = true
  value       = local.realm
}
