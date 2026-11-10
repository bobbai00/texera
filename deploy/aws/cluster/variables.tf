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

variable "region" {
  type        = string
  default     = "us-east-2"
  description = "The region everything is made in."
}

variable "name" {
  type        = string
  default     = "texera2"
  description = "The cluster's name, and the prefix of everything else."
}

variable "kubernetes_version" {
  type        = string
  default     = "1.37"
  description = "The EKS Kubernetes version; the add-ons take their default versions for it."
}

variable "vpc_cidr" {
  type        = string
  default     = "10.42.0.0/16"
  description = "The network. Public subnets take /20s from its start, private ones /19s from its second half."
}

variable "availability_zones" {
  type        = number
  default     = 3
  description = "How many zones the network spans; EKS needs at least two."
}

variable "node_instance_type" {
  type        = string
  default     = "m7g.2xlarge"
  description = "The worker nodes: 8 CPUs and 32 GB each by default, Graviton (arm64). The stack's own images are built for the node architecture by deploy.sh; the third-party images ship both."
}

variable "node_architecture" {
  type        = string
  default     = "arm64"
  description = "The instance type's architecture, arm64 or x86_64: it picks the node image and how deploy.sh builds the stack's images."
  validation {
    condition     = contains(["arm64", "x86_64"], var.node_architecture)
    error_message = "node_architecture is arm64 or x86_64."
  }
}

variable "node_count" {
  type = object({
    min     = number
    desired = number
    max     = number
  })
  default     = { min = 1, desired = 2, max = 4 }
  description = "How many worker nodes. A computing unit of the Large profile needs a node with 8 free CPUs."
}

variable "node_disk_gb" {
  type        = number
  default     = 50
  description = "Each node's disk: the engine image alone is over a gigabyte."
}

variable "cluster_log_types" {
  type        = list(string)
  default     = ["api", "audit", "authenticator"]
  description = "Control plane logs kept in CloudWatch for 30 days."
}

variable "admin_principal_arns" {
  type        = list(string)
  default     = []
  description = "IAM principals, besides the one that creates the cluster, who administer it."
}

variable "domain_name" {
  type        = string
  default     = ""
  description = "The stack's public name, e.g. texera.example.edu, with hosted_zone_name. Empty: the stack answers on the load balancer's own name over HTTP. Set: a certificate is issued and validated, the name points at the load balancer, HTTPS is served and HTTP redirects to it."
}

variable "hosted_zone_name" {
  type        = string
  default     = ""
  description = "The Route 53 public zone domain_name belongs to, e.g. example.edu."
  validation {
    condition     = var.domain_name == "" || var.hosted_zone_name != ""
    error_message = "domain_name needs hosted_zone_name, the Route 53 zone that holds it."
  }
}

variable "tags" {
  type        = map(string)
  default     = {}
  description = "Tags on everything, besides the stack's own."
}
