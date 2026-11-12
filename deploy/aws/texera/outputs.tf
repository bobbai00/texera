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

output "public_url" {
  value = local.cluster.public_url
}

output "namespace" {
  value = local.cluster.namespace
}

output "image_tag" {
  value = var.image_tag
}

# Each person's password, by name: `deploy.sh passwords` shows them, `deploy.sh check` signs in
# with them.
output "sign_in" {
  value = module.overlay.sign_in
}

output "passwords" {
  sensitive = true
  value     = { for name, password in random_password.person : name => password.result }
}

# What deploy.sh needs to load the model key and to run the checks as a service.
output "secrets" {
  sensitive = true
  value = {
    keycloak_admin_password = random_password.keycloak_admin.result
    services_client_secret  = random_password.services_client.result
    unit_client_secret      = random_password.unit_client.result
    biomcp_key              = random_password.biomcp_key.result
    secrets_token           = random_password.secrets_token.result
  }
}
