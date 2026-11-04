package kube

import (
	"context"
	"testing"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes/fake"

	"github.com/apache/texera/catalog/internal/api"
	"github.com/apache/texera/catalog/internal/ports"
)

func TestEndpointReconcilesAndTerminateDeletes(t *testing.T) {
	ctx := context.Background()
	client := fake.NewSimpleClientset()
	p := NewWithClient(client, Options{Namespace: "texera2", Image: "texera/computing-unit-master:test", Env: map[string]string{"STORAGE_S3_ENDPOINT": "http://rustfs:9000"}})
	memory, cpu, image := "3Gi", "500m", "texera/engine:custom"
	spec := api.ComputingUnitSpec{
		Provider:       api.UnitProviderKubernetes,
		Engine:         &api.EngineSpec{Image: &image},
		ComputingNodes: &[]api.ComputingNodeSpec{{Name: "master", Role: api.ComputingNodeSpecRoleMaster, Memory: &memory, Cpu: &cpu}},
	}
	rid := "0b7a1c2d-0000-4000-8000-000000000001"
	reads := 0
	identity := func(context.Context) (ports.Workload, error) {
		reads++
		return ports.Workload{ClientID: "unit-" + rid, Secret: "s3cret", Subject: "sa"}, nil
	}
	url, err := p.Endpoint(ctx, rid, spec, identity)
	if err != nil || url != "http://unit-"+rid+".texera2:8085" {
		t.Fatalf("endpoint: %s %v", url, err)
	}
	if _, err := p.Endpoint(ctx, rid, spec, identity); err != nil {
		t.Fatalf("a second call must be idempotent: %v", err)
	}
	if reads != 1 {
		t.Fatalf("the identity is read once, when the Secret is made: %d reads", reads)
	}
	secret, err := client.CoreV1().Secrets("texera2").Get(ctx, "unit-"+rid, metav1.GetOptions{})
	if err != nil || secret.StringData["client-secret"] != "s3cret" || secret.StringData["client-id"] != "unit-"+rid {
		t.Fatalf("the identity Secret: %v %v", secret, err)
	}
	d, err := client.AppsV1().Deployments("texera2").Get(ctx, "unit-"+rid, metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	c := d.Spec.Template.Spec.Containers[0]
	if c.Image != image || c.Resources.Requests.Memory().String() != "3Gi" || c.Resources.Requests.Cpu().String() != "500m" {
		t.Fatalf("the spec's image and master node resources: %s %v", c.Image, c.Resources.Requests)
	}
	found, fromSecret := false, false
	for _, e := range c.Env {
		if e.Name == "STORAGE_S3_ENDPOINT" && e.Value == "http://rustfs:9000" {
			found = true
		}
		if e.Name == "STORAGE_ICEBERG_CATALOG_REST_CLIENT_SECRET" && e.ValueFrom != nil && e.ValueFrom.SecretKeyRef != nil && e.ValueFrom.SecretKeyRef.Name == "unit-"+rid {
			fromSecret = true
		}
	}
	if !found || !fromSecret {
		t.Fatalf("the engine's env: %v", c.Env)
	}
	if _, err := client.CoreV1().Services("texera2").Get(ctx, "unit-"+rid, metav1.GetOptions{}); err != nil {
		t.Fatal(err)
	}
	// A changed spec rolls the Deployment; an unchanged one is left alone.
	updates := func() int {
		n := 0
		for _, a := range client.Actions() {
			if a.GetVerb() == "update" && a.GetResource().Resource == "deployments" {
				n++
			}
		}
		return n
	}
	if updates() != 0 {
		t.Fatalf("no update before the spec changed: %d", updates())
	}
	bigger, newer := "4Gi", "texera/engine:newer"
	changed := api.ComputingUnitSpec{
		Provider:       api.UnitProviderKubernetes,
		Engine:         &api.EngineSpec{Image: &newer},
		ComputingNodes: &[]api.ComputingNodeSpec{{Name: "master", Role: api.ComputingNodeSpecRoleMaster, Memory: &bigger, Cpu: &cpu}},
	}
	if _, err := p.Endpoint(ctx, rid, changed, identity); err != nil {
		t.Fatal(err)
	}
	d, err = client.AppsV1().Deployments("texera2").Get(ctx, "unit-"+rid, metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	c = d.Spec.Template.Spec.Containers[0]
	if c.Image != newer || c.Resources.Requests.Memory().String() != "4Gi" || updates() != 1 {
		t.Fatalf("the changed spec reaches the deployment: %s %v (%d updates)", c.Image, c.Resources.Requests, updates())
	}
	if _, err := p.Endpoint(ctx, rid, changed, identity); err != nil || updates() != 1 {
		t.Fatalf("the same spec again is not an update: %v (%d updates)", err, updates())
	}
	if _, err := p.Endpoint(ctx, rid, api.ComputingUnitSpec{Provider: api.UnitProviderStatic}, identity); err == nil {
		t.Fatal("a static spec is not this provider's")
	}
	if err := p.Terminate(ctx, rid, spec); err != nil {
		t.Fatal(err)
	}
	if _, err := client.AppsV1().Deployments("texera2").Get(ctx, "unit-"+rid, metav1.GetOptions{}); err == nil {
		t.Fatal("the deployment must be gone")
	}
	if _, err := client.CoreV1().Secrets("texera2").Get(ctx, "unit-"+rid, metav1.GetOptions{}); err == nil {
		t.Fatal("the secret must be gone")
	}
	if err := p.Terminate(ctx, rid, spec); err != nil {
		t.Fatalf("terminating twice is fine: %v", err)
	}
}
