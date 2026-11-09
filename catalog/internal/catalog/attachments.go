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

package catalog

import (
	"context"
	"maps"

	"github.com/google/uuid"

	"github.com/apache/texera/catalog/internal/api"
	"github.com/apache/texera/catalog/internal/auth"
	"github.com/apache/texera/catalog/internal/kinds"
	"github.com/apache/texera/catalog/internal/store"
)

// attachmentLabel marks a dataset as a file attached to a chat, by the chat's rid. It is a dataset
// so that everything that reads files can read it, a workflow included, but the chat's own: no
// list shows it, and it goes with the chat unless something still uses it or someone keeps it.
const attachmentLabel = "texera.attachment"

// KeepAttachment makes a file attached to a chat a dataset of the project: listed like any other,
// and no longer the chat's to take with it.
func (s *Service) KeepAttachment(ctx context.Context, caller *auth.Caller, k kinds.Kind, rid uuid.UUID, in api.KeepAttachment) (*store.Resource, error) {
	r, err := s.Get(ctx, caller, &k, rid)
	if err != nil {
		return nil, err
	}
	if _, attached := r.Labels[attachmentLabel]; !attached {
		return nil, Conflict("not_attached", r.Name+" is a dataset of the project already", nil)
	}
	labels := maps.Clone(r.Labels)
	delete(labels, attachmentLabel)
	return s.UpdateMetadata(ctx, caller, MetadataInput{RID: rid, Name: in.Name, Description: in.Description, Labels: labels})
}

// dropAttachments deletes what was attached to a chat and never kept, as the chat goes. What a
// workflow still reads stays: its version would otherwise name a file that is gone.
func (s *Service) dropAttachments(ctx context.Context, chat *store.Resource) error {
	attached, err := s.Store.ListResources(ctx, store.ResourceFilter{Kind: "dataset", Labels: map[string]string{attachmentLabel: chat.RID.String()}, Limit: 1000})
	if err != nil {
		return err
	}
	for i := range attached {
		deps, err := s.Store.Dependents(ctx, attached[i].RID, 0)
		if err != nil {
			return err
		}
		if len(deps) > 0 {
			continue
		}
		if err := s.Store.DeleteResource(ctx, attached[i].RID); err != nil {
			return wrap(err, "dataset")
		}
	}
	return nil
}
