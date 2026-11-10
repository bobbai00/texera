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

# The stack's secret store, OpenBao, keeps its data on a volume and unseals itself with this
# KMS key, through the pod identity of its service account. Nobody holds an unseal key.
resource "aws_kms_key" "openbao" {
  description             = "${var.name}: unseals OpenBao, the stack's secret store"
  enable_key_rotation     = true
  deletion_window_in_days = 7
}

resource "aws_kms_alias" "openbao" {
  name          = "alias/${var.name}-openbao"
  target_key_id = aws_kms_key.openbao.key_id
}

data "aws_iam_policy_document" "openbao_kms" {
  statement {
    actions   = ["kms:Encrypt", "kms:Decrypt", "kms:DescribeKey"]
    resources = [aws_kms_key.openbao.arn]
  }
}

resource "aws_iam_role" "openbao" {
  name               = "${var.name}-openbao"
  assume_role_policy = data.aws_iam_policy_document.pod_assume.json
}

resource "aws_iam_role_policy" "openbao" {
  name   = "unseal"
  role   = aws_iam_role.openbao.id
  policy = data.aws_iam_policy_document.openbao_kms.json
}

resource "aws_eks_pod_identity_association" "openbao" {
  cluster_name    = aws_eks_cluster.this.name
  namespace       = local.namespace
  service_account = local.openbao_service_account
  role_arn        = aws_iam_role.openbao.arn
  depends_on      = [aws_eks_addon.pod_identity]
}
