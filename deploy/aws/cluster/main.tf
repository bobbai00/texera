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

provider "aws" {
  region = var.region
  default_tags {
    tags = merge({ Project = var.name, ManagedBy = "terraform" }, var.tags)
  }
}

data "aws_caller_identity" "this" {}

data "aws_availability_zones" "available" {
  state = "available"
  filter {
    name   = "opt-in-status"
    values = ["opt-in-not-required"]
  }
}

locals {
  zones = slice(sort(data.aws_availability_zones.available.names), 0, var.availability_zones)
  # Where ../texera puts the stack, and the service accounts of what needs AWS: the pod
  # identities made here are bound to these names.
  namespace                  = "texera2"
  openbao_service_account    = "openbao"
  catalog_service_account    = "catalog"
  lakekeeper_service_account = "lakekeeper"
  # The stack's own images, one registry repository each (bin/dockerfiles).
  images = ["catalog", "agent-runtime", "live", "frontend", "bio-mcp", "computing-unit-master"]
  tls    = var.domain_name != ""
  # The URL browsers and tokens use: the name when there is one, else the load balancer's.
  public_url = local.tls ? "https://${var.domain_name}" : "http://${aws_lb.this.dns_name}"
  # The gateway Service's node ports (deploy/kubernetes/texera.yaml, and the redirect port
  # ../texera adds): where the load balancer sends traffic.
  app_node_port      = 30088
  redirect_node_port = 30089
}
