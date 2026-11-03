package store

import (
	"encoding/json"
	"time"

	"github.com/google/uuid"
)

// Principal is a user, an agent or a group.
type Principal struct {
	PID         uuid.UUID
	Kind        string
	DisplayName string
	Subject     *string
	Email       *string
	SponsorPID  *uuid.UUID
	CreatedAt   time.Time
}

// Origin records the chat turn that produced a resource or version.
type Origin struct {
	Conversation uuid.UUID
	Seq          int64
}

// Resource is the envelope row; the kind-specific spec is JSON.
type Resource struct {
	RID           uuid.UUID
	Kind          string
	Name          string
	Description   *string
	ParentRID     *uuid.UUID
	Visibility    string
	Labels        map[string]string
	Spec          json.RawMessage
	Status        json.RawMessage
	HeadVno       int32
	OwnerPID      uuid.UUID
	CreatedByPID  uuid.UUID
	OnBehalfOfPID *uuid.UUID
	Origin        *Origin
	CreatedAt     time.Time
	UpdatedAt     time.Time
	DeletedAt     *time.Time
}

// Version is one immutable version of a resource.
type Version struct {
	RID           uuid.UUID
	Vno           int32
	ContentKind   string
	ContentRef    *string
	Content       json.RawMessage
	Message       *string
	CreatedByPID  uuid.UUID
	OnBehalfOfPID *uuid.UUID
	Origin        *Origin
	CreatedAt     time.Time
}

// Grant is a relation between a principal and a resource.
type Grant struct {
	RID       uuid.UUID
	PID       uuid.UUID
	Relation  string
	CreatedAt time.Time
}

// OutboxEntry is a pending OpenFGA tuple write.
type OutboxEntry struct {
	ID       int64
	Op       string
	Object   string
	Relation string
	Subject  string
}

// Message is one append-only conversation message.
type Message struct {
	ConversationRID uuid.UUID
	Seq             int64
	Role            string
	AuthorPID       uuid.UUID
	OnBehalfOfPID   *uuid.UUID
	Parts           json.RawMessage
	CreatedAt       time.Time
}

// Agent is the agent-specific row of a principal.
type Agent struct {
	PID             uuid.UUID
	TemplateRID     uuid.UUID
	TemplateVno     int32
	SpawnedByPID    *uuid.UUID
	ConversationRID *uuid.UUID
	EID             *uuid.UUID
	Opid            *string
	Lifetime        string
	Status          string
	CreatedAt       time.Time
}

// Execution is one run of a workflow version on a unit.
type Execution struct {
	EID           uuid.UUID
	Name          *string
	WorkflowRID   uuid.UUID
	WorkflowVno   int32
	EnvRID        *uuid.UUID
	EnvVno        *int32
	CuRID         uuid.UUID
	ActorPID      uuid.UUID
	OnBehalfOfPID *uuid.UUID
	Origin        *Origin
	Parameters    json.RawMessage
	Status        string
	Error         json.RawMessage
	Operators     json.RawMessage
	CreatedAt     time.Time
	StartedAt     *time.Time
	FinishedAt    *time.Time
}

// VersionRef names a resource version.
type VersionRef struct {
	RID uuid.UUID
	Vno int32
}

// PortResult is one output table of an execution.
type PortResult struct {
	EID        uuid.UUID
	Opid       string
	Port       string
	TableID    *string
	SnapshotID *string
	TupleCount *int64
	Bytes      *int64
	Hash       *string
}

// PortEdge is the consumes relation between ports.
type PortEdge struct {
	EID      uuid.UUID
	Opid     string
	Port     string
	FromEID  uuid.UUID
	FromOpid string
	FromPort string
}

// PortInput is a source port and the dataset version file it read.
type PortInput struct {
	EID  uuid.UUID
	Opid string
	Port string
	RID  uuid.UUID
	Vno  int32
	Path string
}

// VersionEdge is the resource-level lineage roll-up.
type VersionEdge struct {
	From VersionRef
	To   VersionRef
	Kind string
	EID  *uuid.UUID
}

// StagedFile is a dataset file uploaded but not yet committed.
type StagedFile struct {
	RID         uuid.UUID
	Path        string
	Size        int64
	SHA256      *string
	ContentType *string
	ObjectKey   string
	UploadedAt  time.Time
}

// ResourceFilter narrows a resource search.
type ResourceFilter struct {
	Kind      string
	ParentRID *uuid.UUID
	Query     string
	// Origin restricts to resources produced in a conversation.
	Origin *uuid.UUID
	// ReadableBy restricts to resources the principal has a direct grant on, is the owner of,
	// or that are public. The PDP remains the authority; this is the listing pre-filter.
	ReadableBy *uuid.UUID
	Limit      int
	Offset     int
}
