package kube

import (
	"context"
	"testing"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes/fake"

	"github.com/apache/texera/catalog/internal/api"
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
	url, err := p.Endpoint(ctx, rid, spec)
	if err != nil || url != "http://unit-"+rid+".texera2:8085" {
		t.Fatalf("endpoint: %s %v", url, err)
	}
	if _, err := p.Endpoint(ctx, rid, spec); err != nil {
		t.Fatalf("a second call must be idempotent: %v", err)
	}
	d, err := client.AppsV1().Deployments("texera2").Get(ctx, "unit-"+rid, metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	c := d.Spec.Template.Spec.Containers[0]
	if c.Image != image || c.Resources.Requests.Memory().String() != "3Gi" || c.Resources.Requests.Cpu().String() != "500m" {
		t.Fatalf("the spec's image and master node resources: %s %v", c.Image, c.Resources.Requests)
	}
	found := false
	for _, e := range c.Env {
		if e.Name == "STORAGE_S3_ENDPOINT" && e.Value == "http://rustfs:9000" {
			found = true
		}
	}
	if !found {
		t.Fatalf("the engine's env: %v", c.Env)
	}
	if _, err := client.CoreV1().Services("texera2").Get(ctx, "unit-"+rid, metav1.GetOptions{}); err != nil {
		t.Fatal(err)
	}
	if _, err := p.Endpoint(ctx, rid, api.ComputingUnitSpec{Provider: api.UnitProviderStatic}); err == nil {
		t.Fatal("a static spec is not this provider's")
	}
	if err := p.Terminate(ctx, rid, spec); err != nil {
		t.Fatal(err)
	}
	if _, err := client.AppsV1().Deployments("texera2").Get(ctx, "unit-"+rid, metav1.GetOptions{}); err == nil {
		t.Fatal("the deployment must be gone")
	}
	if err := p.Terminate(ctx, rid, spec); err != nil {
		t.Fatalf("terminating twice is fine: %v", err)
	}
}
