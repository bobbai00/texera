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

# deploy.sh writes image_tag and image_digests to images.auto.tfvars.json as it pushes.

variable "image_tag" {
  type        = string
  description = "The build the images carry, for reading: the commit, as deploy.sh tags them."
}

variable "image_digests" {
  type        = map(string)
  description = "Each image's digest in its repository, by image name. Pods run images by digest, so a tag pushed again does not go unnoticed."
}

variable "login_logo" {
  type        = string
  default     = ""
  description = "A PNG for the sign-in pages instead of Texera's logo (k8s.sh takes TEXERA2_LOGIN_LOGO)."
}

variable "postgres_storage" {
  type        = string
  default     = "20Gi"
  description = "The database volume. Volumes are made at the first deployment; a larger size afterwards is a change to the PVC, not here."
}
