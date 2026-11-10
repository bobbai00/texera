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

# What ../texera and deploy.sh read.

output "region" {
  value = var.region
}

output "cluster_name" {
  value = aws_eks_cluster.this.name
}

output "cluster_endpoint" {
  value = aws_eks_cluster.this.endpoint
}

output "node_architecture" {
  value = var.node_architecture
}

output "registry" {
  description = "The ECR registry, to log Docker in to."
  value       = "${data.aws_caller_identity.this.account_id}.dkr.ecr.${var.region}.amazonaws.com"
}

output "repositories" {
  description = "Each image's repository URL, by image name."
  value       = { for name, repository in aws_ecr_repository.image : name => repository.repository_url }
}

output "public_url" {
  description = "Where the stack answers: the browser's origin and the issuer of every token."
  value       = local.public_url
}

output "tls" {
  value = local.tls
}

output "load_balancer_dns_name" {
  value = aws_lb.this.dns_name
}

output "openbao_kms_key_id" {
  value = aws_kms_key.openbao.key_id
}

output "namespace" {
  value = local.namespace
}

output "openbao_service_account" {
  value = local.openbao_service_account
}

output "lakekeeper_service_account" {
  value = local.lakekeeper_service_account
}

output "datasets_bucket" {
  description = "The catalog's bucket: dataset files, by content."
  value       = aws_s3_bucket.datasets.bucket
}

output "lake_bucket" {
  description = "The lake's bucket: the warehouses' tables."
  value       = aws_s3_bucket.lake.bucket
}

output "lake_role_arn" {
  description = "The role the lake assumes for the lake bucket, and vends credentials from."
  value       = aws_iam_role.lake_warehouse.arn
}

output "lake_external_id" {
  description = "What the lake presents to assume its role."
  value       = random_uuid.lake_external_id.result
  sensitive   = true
}

output "kubeconfig_command" {
  description = "Writes a kubeconfig for the cluster; deploy.sh keeps it in a file of its own."
  value       = "aws eks update-kubeconfig --name ${aws_eks_cluster.this.name} --region ${var.region}"
}
