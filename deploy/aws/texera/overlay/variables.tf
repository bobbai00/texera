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

variable "namespace" {
  type = string
}

variable "public_url" {
  type        = string
  description = "The browser's origin and every token's issuer."
}

variable "repositories" {
  type        = map(string)
  description = "Each image's repository URL, by image name."
}

variable "image_digests" {
  type        = map(string)
  description = "Each image's digest, by image name."
}

variable "region" {
  type = string
}

variable "kms_key_id" {
  type        = string
  description = "The KMS key the secret store unseals with."
}

variable "openbao_service_account" {
  type        = string
  description = "The service account whose pod identity may use the key; this overlay names it openbao."
}

variable "lakekeeper_service_account" {
  type        = string
  description = "The service account whose pod identity may assume the lake's role; this overlay names it lakekeeper."
}

variable "datasets_bucket" {
  type        = string
  description = "The catalog's bucket, on S3."
}

variable "lake_bucket" {
  type        = string
  description = "The lake's bucket, on S3."
}

variable "lake_role_arn" {
  type        = string
  description = "The role the lake assumes for its bucket and vends credentials from."
}

variable "lake_external_id" {
  type        = string
  sensitive   = true
  description = "What the lake presents to assume its role."
}

variable "login_logo" {
  type    = string
  default = ""
}

variable "postgres_storage" {
  type = string
}

variable "secrets" {
  sensitive   = true
  description = "The deployment's values for deploy/kubernetes/texera.yaml's texera2-clients Secret."
  type = object({
    keycloak_admin_password   = string
    services_client_secret    = string
    unit_client_secret        = string
    biomcp_key                = string
    lakekeeper_encryption_key = string
    secrets_token             = string
  })
}

variable "passwords" {
  sensitive   = true
  description = "Each person's password, by name (the `people` output names them): the dev stack's, which are the names themselves, are not used at a public address."
  type        = map(string)
}
