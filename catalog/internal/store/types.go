package store

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"time"

	"github.com/google/uuid"
)

// Principal is a person or a group.
type Principal struct {
	PID         uuid.UUID
	Kind        string
	DisplayName string
	Subject     *string
	Email       *string
	Preferences json.RawMessage
	CreatedAt   time.Time
	UpdatedAt   time.Time
}

// Origin is the chat turn a resource or version came from.
type Origin struct {
	Conversation uuid.UUID `json:"conversation"`
	Turn         string    `json:"turn"`
	Template     string    `json:"template,omitempty"`
}

// Resource is the envelope row of any kind.
type Resource struct {
	RID         uuid.UUID
	Kind        string
	Name        string
	Description *string
	ParentRID   *uuid.UUID
	ProjectRID  *uuid.UUID
	// BaseRID is, for a project, the project it inherits from; nil for Texera and other kinds.
	BaseRID      *uuid.UUID
	OwnerPID     uuid.UUID
	Visibility   string
	Labels       map[string]string
	Spec         json.RawMessage
	Status       json.RawMessage
	HeadVno      int
	Etag         string
	CreatedByPID uuid.UUID
	Origin       *Origin
	CreatedAt    time.Time
	UpdatedAt    time.Time
}

// Version is an immutable snapshot of a resource's content.
type Version struct {
	RID          uuid.UUID
	Vno          int
	ContentKind  string
	Digest       string
	Content      json.RawMessage
	Message      *string
	CreatedByPID uuid.UUID
	// Contributors are the people whose edits the version holds, when more than one made it.
	Contributors []uuid.UUID
	Origin       *Origin
	CreatedAt    time.Time
}

// Grant is a direct relation of a principal on a resource.
type Grant struct {
	RID       uuid.UUID
	PID       uuid.UUID
	Relation  string
	CreatedAt time.Time
}

// OutboxEntry is a tuple write or delete waiting for the relay.
type OutboxEntry struct {
	ID       int64
	Op       string
	Object   string
	Relation string
	Subject  string
}

// Edge is one arrow of the reference and lineage graph.
type Edge struct {
	From         string
	Relation     string
	To           string
	FromRID      uuid.UUID
	ToRID        *uuid.UUID
	Field        *string
	ExecutionRID *uuid.UUID
	Attrs        json.RawMessage
	At           time.Time
}

// Blob is a content-addressed file.
type Blob struct {
	SHA256      string
	Size        int64
	ContentType *string
	CreatedAt   time.Time
}

// StagedFile is a file uploaded but not yet committed.
type StagedFile struct {
	RID         uuid.UUID
	Path        string
	SHA256      string
	Size        int64
	ContentType *string
	UploadedAt  time.Time
}

// Message is one entry of a conversation.
type Message struct {
	ConversationRID uuid.UUID
	Seq             int64
	Turn            *string
	Role            string
	AuthorPID       uuid.UUID
	// For an assistant message, what wrote it: the template version, the model endpoint, and
	// the MCP servers its turn mounted.
	Template      *string
	ModelEndpoint *string
	McpServers    []string
	Parts         json.RawMessage
	CreatedAt     time.Time
	UpdatedAt     *time.Time
}

// Lease records that a credential's secret was handed out.
type Lease struct {
	Lease         uuid.UUID
	CredentialRID uuid.UUID
	PID           uuid.UUID
	Purpose       string
	CreatedAt     time.Time
	ExpiresAt     time.Time
	RevokedAt     *time.Time
}

// Canonical returns the canonical JSON of a document: keys sorted, no insignificant space.
func Canonical(doc json.RawMessage) ([]byte, error) {
	var v any
	if err := json.Unmarshal(doc, &v); err != nil {
		return nil, err
	}
	return json.Marshal(v)
}

// DigestOf returns the sha256 digest of a document's canonical JSON.
func DigestOf(doc json.RawMessage) (string, error) {
	c, err := Canonical(doc)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(c)
	return "sha256:" + hex.EncodeToString(sum[:]), nil
}

func newEtag() string { return uuid.NewString() }
