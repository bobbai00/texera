// Licensed to the Apache Software Foundation (ASF) under one
// or more contributor license agreements.  See the NOTICE file
// distributed with this work for additional information
// regarding copyright ownership.  The ASF licenses this file
// to you under the Apache License, Version 2.0 (the
// "License"); you may not use this file except in compliance
// with the License.  You may obtain a copy of the License at
//
//   http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing,
// software distributed under the License is distributed on an
// "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
// KIND, either express or implied.  See the License for the
// specific language governing permissions and limitations
// under the License.

package s3cas

import (
	"context"
	"strings"
	"testing"
	"time"
)

var digest = "sha256:" + strings.Repeat("a", 64)

func TestWithAKeyTheStoreIsReachedByItAndPresignedAtThePublicEndpoint(t *testing.T) {
	b, err := New(Options{Endpoint: "http://store:9000", PublicEndpoint: "http://localhost:19001", Region: "us-east-1", AccessKey: "the-key", SecretKey: "secret", Bucket: "datasets", PathStyle: true})
	if err != nil {
		t.Fatal(err)
	}
	url, err := b.Presign(context.Background(), digest, "a.csv", time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(url, "http://localhost:19001/datasets/blobs/sha256/aa/") || !strings.Contains(url, "the-key") {
		t.Fatalf("the presigned URL: %s", url)
	}
}

func TestWithoutAKeyTheStoreIsReachedAsTheProcessAtTheRegionsOwnS3(t *testing.T) {
	// Whoever the process runs as: here, what the environment says.
	t.Setenv("AWS_ACCESS_KEY_ID", "chain-key")
	t.Setenv("AWS_SECRET_ACCESS_KEY", "chain-secret")
	t.Setenv("AWS_EC2_METADATA_DISABLED", "true")
	b, err := New(Options{Region: "us-east-2", Bucket: "texera-datasets"})
	if err != nil {
		t.Fatal(err)
	}
	url, err := b.Presign(context.Background(), digest, "a.csv", time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(url, "https://texera-datasets.s3.us-east-2.amazonaws.com/blobs/sha256/aa/") || !strings.Contains(url, "chain-key") {
		t.Fatalf("the presigned URL: %s", url)
	}
}
