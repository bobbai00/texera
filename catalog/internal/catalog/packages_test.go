package catalog

import (
	"reflect"
	"testing"

	"github.com/apache/texera/catalog/internal/api"
)

// A package is known by the name pip compares: whatever its case, separators or version.
func TestAPackageIsKnownByItsName(t *testing.T) {
	for requirement, name := range map[string]string{
		"pandas":                      "pandas",
		" Scikit_Learn>=1.5":          "scikit-learn",
		"zope.interface==6":           "zope-interface",
		"pyarrow[pandas]":             "pyarrow",
		"numpy ; python_version>'3'":  "numpy",
		"mylib @ https://x.org/a.whl": "mylib",
	} {
		if got := packageName(requirement); got != name {
			t.Errorf("%q: %q, want %q", requirement, got, name)
		}
	}
}

// What a node lists is one environment: the same packages in any order and spacing are the same
// key; another list is another key; no packages ask for none.
func TestTheSamePackagesAreTheSameEnvironment(t *testing.T) {
	node := func(packages ...string) *api.ComputingNodeSpec { return &api.ComputingNodeSpec{Packages: &packages} }
	a := environmentFor(node("pandas", " humanize==4.11.0", "pandas"))
	b := environmentFor(node("humanize==4.11.0", "pandas"))
	if a == nil || b == nil || a.Key != b.Key || !reflect.DeepEqual(a.Packages, []string{"humanize==4.11.0", "pandas"}) {
		t.Fatalf("one list, one environment: %+v %+v", a, b)
	}
	if c := environmentFor(node("pandas")); c.Key == a.Key {
		t.Errorf("another list is another environment: %s", c.Key)
	}
	if environmentFor(node()) != nil || environmentFor(nil) != nil {
		t.Error("no packages ask for no environment")
	}
}

// A package is recorded as the unit installed it; one the unit did not say stays as asked.
func TestPackagesArePinnedAsInstalled(t *testing.T) {
	installed := []string{"pandas==2.2.3", "scikit-learn==1.5.2", "joblib==1.4"}
	got := pinned([]string{"pandas", "Scikit_Learn>=1", "git+https://x.org/repo.git"}, &installed)
	if want := []string{"pandas==2.2.3", "scikit-learn==1.5.2", "git+https://x.org/repo.git"}; !reflect.DeepEqual(got, want) {
		t.Errorf("pinned: %v, want %v", got, want)
	}
	if got := pinned([]string{"pandas"}, nil); !reflect.DeepEqual(got, []string{"pandas"}) {
		t.Errorf("nothing installed: %v", got)
	}
}
