// Package uri is the grammar of resource names. A name is the resource's REST path with the
// `texera://` scheme in place of the API prefix:
//
//	texera://{plural}/{rid}
//	texera://{plural}/{rid}@{vno}
//	texera://{plural}/{rid}/{subresource...}
//	texera://workflows/{rid}/executions/{eid}/operators/{operatorID}/ports/{portID}
//	texera://settings
//
// `@vno` names a version and may only follow the resource's rid. A nested kind (executions)
// follows its parent's rid with its own collection and rid. Everything after the resource
// and its version is the subresource path, kept verbatim. The grammar reads the kind table,
// so a new kind needs no change here.
package uri

import (
	"errors"
	"fmt"
	"strconv"
	"strings"

	"github.com/google/uuid"

	"github.com/apache/texera/catalog/internal/kinds"
)

// Scheme is the URI scheme of resource names.
const Scheme = "texera://"

// Ref is a parsed name.
type Ref struct {
	// Kind is the resource's kind; for a nested name the nested kind (execution).
	Kind kinds.Kind
	// Rid is the resource's id; empty for the settings singleton.
	Rid string
	// Parent is the parent's rid of a nested name (the workflow of an execution).
	Parent string
	// Vno is the version, 0 when the name has none.
	Vno int
	// Subresource is the path after the resource and its version, without a leading slash.
	Subresource string
}

// ErrInvalid is wrapped by every parse error.
var ErrInvalid = errors.New("invalid resource uri")

// Is reports whether s looks like a resource name.
func Is(s string) bool { return strings.HasPrefix(s, Scheme) }

// Parse parses a name.
func Parse(s string) (Ref, error) {
	if !Is(s) {
		return Ref{}, fmt.Errorf("%w: %q does not start with %s", ErrInvalid, s, Scheme)
	}
	rest := strings.TrimPrefix(s, Scheme)
	segs := strings.Split(rest, "/")
	if len(segs) == 0 || segs[0] == "" {
		return Ref{}, fmt.Errorf("%w: %q names no collection", ErrInvalid, s)
	}
	kind, ok := kinds.ByPlural(segs[0])
	if !ok {
		return Ref{}, fmt.Errorf("%w: %q is not a collection", ErrInvalid, segs[0])
	}
	r := Ref{Kind: kind}
	i := 1
	if kind.Singleton {
		r.Subresource = strings.Join(segs[i:], "/")
		return r, nil
	}
	if len(segs) < 2 || segs[1] == "" {
		return Ref{}, fmt.Errorf("%w: %q names no %s", ErrInvalid, s, kind.Name)
	}
	rid, vno, err := splitVersion(segs[1])
	if err != nil {
		return Ref{}, err
	}
	r.Rid, r.Vno = rid, vno
	i = 2
	// A nested child: {childPlural}/{childRid} right after the parent's rid.
	if vno == 0 && len(segs) >= i+2 {
		if child, ok := kinds.ByPlural(segs[i]); ok && child.Nested && child.Parent == kind.Name {
			childRid, childVno, err := splitVersion(segs[i+1])
			if err != nil {
				return Ref{}, err
			}
			r = Ref{Kind: child, Rid: childRid, Parent: rid, Vno: childVno}
			i += 2
		}
	}
	if len(segs) > i {
		// `/versions/{vno}` is the REST spelling of `@vno`.
		if segs[i] == "versions" && len(segs) > i+1 && r.Vno == 0 {
			n, err := strconv.Atoi(segs[i+1])
			if err != nil || n <= 0 {
				return Ref{}, fmt.Errorf("%w: version %q", ErrInvalid, segs[i+1])
			}
			r.Vno = n
			i += 2
		}
		for _, seg := range segs[i:] {
			if seg == "" {
				return Ref{}, fmt.Errorf("%w: empty path segment in %q", ErrInvalid, s)
			}
		}
		r.Subresource = strings.Join(segs[i:], "/")
	}
	if r.Vno != 0 && !r.Kind.Versioned {
		return Ref{}, fmt.Errorf("%w: %s is not versioned", ErrInvalid, r.Kind.Name)
	}
	return r, nil
}

func splitVersion(seg string) (string, int, error) {
	rid, v, hasVersion := strings.Cut(seg, "@")
	if _, err := uuid.Parse(rid); err != nil {
		return "", 0, fmt.Errorf("%w: %q is not a resource id", ErrInvalid, rid)
	}
	if !hasVersion {
		return rid, 0, nil
	}
	n, err := strconv.Atoi(v)
	if err != nil || n <= 0 {
		return "", 0, fmt.Errorf("%w: version %q", ErrInvalid, v)
	}
	return rid, n, nil
}

// Of names a resource.
func Of(kind kinds.Kind, rid string) Ref { return Ref{Kind: kind, Rid: rid} }

// Nested names a nested resource under its parent.
func Nested(kind kinds.Kind, parent, rid string) Ref {
	return Ref{Kind: kind, Rid: rid, Parent: parent}
}

// Resource returns the name without version and subresource.
func (r Ref) Resource() Ref { return Ref{Kind: r.Kind, Rid: r.Rid, Parent: r.Parent} }

// WithVersion returns the name pinned to a version.
func (r Ref) WithVersion(vno int) Ref {
	r.Vno = vno
	return r
}

// With returns the name with a subresource path.
func (r Ref) With(subresource ...string) Ref {
	r.Subresource = strings.Join(subresource, "/")
	return r
}

// String prints the name.
func (r Ref) String() string { return Scheme + r.path() }

// Path returns the REST path under the API prefix, with `/versions/{vno}` for a version.
func (r Ref) Path(prefix string) string {
	var b strings.Builder
	b.WriteString(strings.TrimSuffix(prefix, "/"))
	b.WriteString("/")
	b.WriteString(r.Kind.Plural)
	if r.Kind.Singleton {
		if r.Subresource != "" {
			b.WriteString("/" + r.Subresource)
		}
		return b.String()
	}
	if r.Parent != "" {
		parent, _ := kinds.ByName(r.Kind.Parent)
		b.Reset()
		b.WriteString(strings.TrimSuffix(prefix, "/"))
		b.WriteString("/" + parent.Plural + "/" + r.Parent + "/" + r.Kind.Plural)
	}
	b.WriteString("/" + r.Rid)
	if r.Vno != 0 {
		b.WriteString("/versions/" + strconv.Itoa(r.Vno))
	}
	if r.Subresource != "" {
		b.WriteString("/" + r.Subresource)
	}
	return b.String()
}

func (r Ref) path() string {
	var b strings.Builder
	if r.Parent != "" {
		parent, _ := kinds.ByName(r.Kind.Parent)
		b.WriteString(parent.Plural + "/" + r.Parent + "/")
	}
	b.WriteString(r.Kind.Plural)
	if r.Kind.Singleton {
		if r.Subresource != "" {
			b.WriteString("/" + r.Subresource)
		}
		return b.String()
	}
	b.WriteString("/" + r.Rid)
	if r.Vno != 0 {
		b.WriteString("@" + strconv.Itoa(r.Vno))
	}
	if r.Subresource != "" {
		b.WriteString("/" + r.Subresource)
	}
	return b.String()
}

// Extract returns every resource name found in a JSON document, keyed by the JSON pointer
// of the string that held it. Malformed names are skipped: the reference extractor records
// what resolves, validation reports what does not.
func Extract(doc any) map[string]Ref {
	out := map[string]Ref{}
	var walk func(v any, pointer string)
	walk = func(v any, pointer string) {
		switch x := v.(type) {
		case string:
			if Is(x) {
				if r, err := Parse(x); err == nil {
					out[pointer] = r
				}
			}
		case map[string]any:
			for k, child := range x {
				walk(child, pointer+"/"+escapePointer(k))
			}
		case []any:
			for i, child := range x {
				walk(child, pointer+"/"+strconv.Itoa(i))
			}
		}
	}
	walk(doc, "")
	return out
}

func escapePointer(s string) string {
	return strings.ReplaceAll(strings.ReplaceAll(s, "~", "~0"), "/", "~1")
}
