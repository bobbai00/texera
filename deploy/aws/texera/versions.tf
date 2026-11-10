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

# The stack on the cluster ../cluster made: deploy/kubernetes, the same manifests the local
# cluster runs, through an overlay for the cloud (./overlay), applied as Terraform resources.
# deploy.sh pushes the images and writes images.auto.tfvars.json before this is applied.
terraform {
  required_version = ">= 1.10"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.72"
    }
    kustomization = {
      source  = "kbst/kustomization"
      version = "~> 0.9.8"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.7"
    }
  }
}
