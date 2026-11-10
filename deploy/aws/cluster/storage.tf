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

# The object store is S3: one bucket for the catalog's blobs (dataset files, by content), one for
# the lake's tables. Nobody holds a key. The catalog reaches its bucket as itself, through the
# pod identity of its service account. The lake reaches its bucket, and vends credentials to the
# units for the tables they work on, through a role it alone may assume, by an external id; the
# role has the bucket. New buckets are private; the account's policy forbids the explicit
# public-access block, so none is set.

resource "aws_s3_bucket" "datasets" {
  bucket        = "${var.name}-datasets-${data.aws_caller_identity.this.account_id}"
  force_destroy = true
}

resource "aws_s3_bucket" "lake" {
  bucket        = "${var.name}-lake-${data.aws_caller_identity.this.account_id}"
  force_destroy = true
}

# The catalog's identity: its bucket, and nothing else.
data "aws_iam_policy_document" "catalog" {
  statement {
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:AbortMultipartUpload", "s3:ListMultipartUploadParts"]
    resources = ["${aws_s3_bucket.datasets.arn}/*"]
  }
  statement {
    actions   = ["s3:ListBucket", "s3:GetBucketLocation", "s3:ListBucketMultipartUploads"]
    resources = [aws_s3_bucket.datasets.arn]
  }
}

resource "aws_iam_role" "catalog" {
  name               = "${var.name}-catalog"
  assume_role_policy = data.aws_iam_policy_document.pod_assume.json
}

resource "aws_iam_role_policy" "catalog" {
  name   = "datasets"
  role   = aws_iam_role.catalog.id
  policy = data.aws_iam_policy_document.catalog.json
}

resource "aws_eks_pod_identity_association" "catalog" {
  cluster_name    = aws_eks_cluster.this.name
  namespace       = local.namespace
  service_account = local.catalog_service_account
  role_arn        = aws_iam_role.catalog.arn
  depends_on      = [aws_eks_addon.pod_identity]
}

# The lake's identity may only assume the warehouse role; the warehouse role has the bucket.
resource "random_uuid" "lake_external_id" {}

resource "aws_iam_role" "lakekeeper" {
  name               = "${var.name}-lakekeeper"
  assume_role_policy = data.aws_iam_policy_document.pod_assume.json
}

data "aws_iam_policy_document" "lakekeeper" {
  statement {
    actions   = ["sts:AssumeRole", "sts:TagSession"]
    resources = [aws_iam_role.lake_warehouse.arn]
  }
}

resource "aws_iam_role_policy" "lakekeeper" {
  name   = "assume-the-warehouse-role"
  role   = aws_iam_role.lakekeeper.id
  policy = data.aws_iam_policy_document.lakekeeper.json
}

resource "aws_eks_pod_identity_association" "lakekeeper" {
  cluster_name    = aws_eks_cluster.this.name
  namespace       = local.namespace
  service_account = local.lakekeeper_service_account
  role_arn        = aws_iam_role.lakekeeper.arn
  depends_on      = [aws_eks_addon.pod_identity]
}

# The lake's session carries the tags the pod identity gave it, which every role it assumes
# from there must accept (sts:TagSession); the external id is a condition of assuming alone,
# since that action's evaluation does not see it.
data "aws_iam_policy_document" "lake_warehouse_trust" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "AWS"
      identifiers = [aws_iam_role.lakekeeper.arn]
    }
    condition {
      test     = "StringEquals"
      variable = "sts:ExternalId"
      values   = [random_uuid.lake_external_id.result]
    }
  }
  statement {
    actions = ["sts:TagSession"]
    principals {
      type        = "AWS"
      identifiers = [aws_iam_role.lakekeeper.arn]
    }
  }
}

data "aws_iam_policy_document" "lake_warehouse" {
  statement {
    actions   = ["s3:*"]
    resources = ["${aws_s3_bucket.lake.arn}/*"]
  }
  statement {
    actions   = ["s3:ListBucket", "s3:GetBucketLocation", "s3:ListBucketMultipartUploads"]
    resources = [aws_s3_bucket.lake.arn]
  }
}

resource "aws_iam_role" "lake_warehouse" {
  name               = "${var.name}-lake-warehouse"
  assume_role_policy = data.aws_iam_policy_document.lake_warehouse_trust.json
}

resource "aws_iam_role_policy" "lake_warehouse" {
  name   = "lake"
  role   = aws_iam_role.lake_warehouse.id
  policy = data.aws_iam_policy_document.lake_warehouse.json
}
