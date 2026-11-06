// Package kube is the Kubernetes adapter of ports.UnitProvider: a computing unit whose spec
// says provider kubernetes becomes one Secret holding its identity, one Deployment of the
// engine image and one Service in the catalog's namespace, named after the unit's rid.
// Endpoint reconciles them on every call, so a unit that was lost comes back and a changed
// spec (image, memory, cpu) rolls the Deployment, and Terminate deletes them.
package kube

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	apiequality "k8s.io/apimachinery/pkg/api/equality"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/intstr"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"

	"github.com/apache/texera/catalog/internal/api"
	"github.com/apache/texera/catalog/internal/ports"
)

const (
	port       = 8085
	managedBy  = "texera-catalog"
	labelRID   = "texera.apache.org/unit"
	labelApp   = "app.kubernetes.io/name"
	labelOwner = "app.kubernetes.io/managed-by"
	// The identity Secret's keys, read by the engine as its catalog client.
	keyClientID     = "client-id"
	keyClientSecret = "client-secret"
	envClientID     = "STORAGE_ICEBERG_CATALOG_REST_CLIENT_ID"
	envClientSecret = "STORAGE_ICEBERG_CATALOG_REST_CLIENT_SECRET"
	// The GPUs a node reserves, as NVIDIA's device plugin names them.
	gpuResource corev1.ResourceName = "nvidia.com/gpu"
)

// Options configure the units the adapter creates.
type Options struct {
	// Namespace the units live in; the catalog's own.
	Namespace string
	// Image of the engine when the unit's spec names none.
	Image string
	// Memory the master node requests when the spec names none, e.g. 2Gi.
	Memory string
	// Env the engine needs to reach the lake and the identity provider.
	Env map[string]string
}

type Provider struct {
	client kubernetes.Interface
	opts   Options
}

// New connects in-cluster, or through the kubeconfig KUBECONFIG or ~/.kube/config names.
func New(opts Options) (*Provider, error) {
	cfg, err := rest.InClusterConfig()
	if err != nil {
		path := os.Getenv("KUBECONFIG")
		if path == "" {
			home, _ := os.UserHomeDir()
			path = filepath.Join(home, ".kube", "config")
		}
		cfg, err = clientcmd.BuildConfigFromFlags("", path)
		if err != nil {
			return nil, fmt.Errorf("kubernetes: %w", err)
		}
	}
	client, err := kubernetes.NewForConfig(cfg)
	if err != nil {
		return nil, err
	}
	return NewWithClient(client, opts), nil
}

// NewWithClient is for tests and for a caller that has a client already.
func NewWithClient(client kubernetes.Interface, opts Options) *Provider {
	if opts.Memory == "" {
		opts.Memory = "2Gi"
	}
	return &Provider{client: client, opts: opts}
}

func name(rid string) string { return "unit-" + strings.ToLower(rid) }

// Endpoint makes sure the unit's Secret, Deployment and Service exist and returns the
// Service URL. The Secret is written from the identity only when it is missing.
func (p *Provider) Endpoint(ctx context.Context, rid string, spec api.ComputingUnitSpec, identity ports.WorkloadSource) (string, error) {
	if spec.Provider != api.UnitProviderKubernetes {
		return "", fmt.Errorf("provider %q is not kubernetes", spec.Provider)
	}
	n := name(rid)
	secrets := p.client.CoreV1().Secrets(p.opts.Namespace)
	if _, err := secrets.Get(ctx, n, metav1.GetOptions{}); apierrors.IsNotFound(err) {
		if identity == nil {
			return "", fmt.Errorf("unit %s has no identity to run with", rid)
		}
		w, err := identity(ctx)
		if err != nil {
			return "", fmt.Errorf("identity of unit %s: %w", rid, err)
		}
		if _, err := secrets.Create(ctx, p.secret(rid, w), metav1.CreateOptions{}); err != nil && !apierrors.IsAlreadyExists(err) {
			return "", fmt.Errorf("create secret %s: %w", n, err)
		}
	} else if err != nil {
		return "", err
	}
	deployments := p.client.AppsV1().Deployments(p.opts.Namespace)
	desired := p.deployment(rid, spec)
	existing, err := deployments.Get(ctx, n, metav1.GetOptions{})
	switch {
	case apierrors.IsNotFound(err):
		if _, err := deployments.Create(ctx, desired, metav1.CreateOptions{}); err != nil && !apierrors.IsAlreadyExists(err) {
			return "", fmt.Errorf("create deployment %s: %w", n, err)
		}
	case err != nil:
		return "", err
	case drifted(existing, desired):
		// The spec changed: the Deployment rolls to it.
		existing.Spec.Replicas = desired.Spec.Replicas
		existing.Spec.Template = desired.Spec.Template
		if _, err := deployments.Update(ctx, existing, metav1.UpdateOptions{}); err != nil {
			return "", fmt.Errorf("update deployment %s: %w", n, err)
		}
	}
	services := p.client.CoreV1().Services(p.opts.Namespace)
	if _, err := services.Get(ctx, n, metav1.GetOptions{}); apierrors.IsNotFound(err) {
		if _, err := services.Create(ctx, p.service(rid), metav1.CreateOptions{}); err != nil && !apierrors.IsAlreadyExists(err) {
			return "", fmt.Errorf("create service %s: %w", n, err)
		}
	} else if err != nil {
		return "", err
	}
	return fmt.Sprintf("http://%s.%s:%d", n, p.opts.Namespace, port), nil
}

// Terminate deletes the unit's Deployment, Service and Secret.
func (p *Provider) Terminate(ctx context.Context, rid string, _ api.ComputingUnitSpec) error {
	n := name(rid)
	if err := p.client.AppsV1().Deployments(p.opts.Namespace).Delete(ctx, n, metav1.DeleteOptions{}); err != nil && !apierrors.IsNotFound(err) {
		return fmt.Errorf("delete deployment %s: %w", n, err)
	}
	if err := p.client.CoreV1().Services(p.opts.Namespace).Delete(ctx, n, metav1.DeleteOptions{}); err != nil && !apierrors.IsNotFound(err) {
		return fmt.Errorf("delete service %s: %w", n, err)
	}
	if err := p.client.CoreV1().Secrets(p.opts.Namespace).Delete(ctx, n, metav1.DeleteOptions{}); err != nil && !apierrors.IsNotFound(err) {
		return fmt.Errorf("delete secret %s: %w", n, err)
	}
	return nil
}

func (p *Provider) secret(rid string, w ports.Workload) *corev1.Secret {
	return &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{Name: name(rid), Namespace: p.opts.Namespace, Labels: p.labels(rid)},
		StringData: map[string]string{keyClientID: w.ClientID, keyClientSecret: w.Secret},
	}
}

func (p *Provider) labels(rid string) map[string]string {
	return map[string]string{labelApp: name(rid), labelRID: rid, labelOwner: managedBy}
}

func (p *Provider) deployment(rid string, spec api.ComputingUnitSpec) *appsv1.Deployment {
	image := p.opts.Image
	if spec.Engine != nil && spec.Engine.Image != nil && *spec.Engine.Image != "" {
		image = *spec.Engine.Image
	}
	requests, limits := corev1.ResourceList{}, corev1.ResourceList{}
	memory, cpu, gpu := p.opts.Memory, "", int32(0)
	if spec.ComputingNodes != nil {
		for _, n := range *spec.ComputingNodes {
			if n.Role == api.ComputingNodeSpecRoleMaster {
				if n.Memory != nil && *n.Memory != "" {
					memory = *n.Memory
				}
				if n.Cpu != nil && *n.Cpu != "" {
					cpu = *n.Cpu
				}
				if n.Gpu != nil {
					gpu = *n.Gpu
				}
			}
		}
	}
	if q, err := resource.ParseQuantity(memory); err == nil {
		requests[corev1.ResourceMemory] = q
	}
	if cpu != "" {
		if q, err := resource.ParseQuantity(cpu); err == nil {
			requests[corev1.ResourceCPU] = q
		}
	}
	// A GPU is an extended resource: reserved by its limit, which is also its request.
	if gpu > 0 {
		limits[gpuResource] = *resource.NewQuantity(int64(gpu), resource.DecimalSI)
	} else {
		limits = nil
	}
	env := []corev1.EnvVar{{Name: "TEXERA_UNIT_PORT", Value: fmt.Sprint(port)}}
	for k, v := range p.opts.Env {
		env = append(env, corev1.EnvVar{Name: k, Value: v})
	}
	// The identity comes from the unit's Secret, never from the pod spec.
	for envName, key := range map[string]string{envClientID: keyClientID, envClientSecret: keyClientSecret} {
		env = append(env, corev1.EnvVar{Name: envName, ValueFrom: &corev1.EnvVarSource{
			SecretKeyRef: &corev1.SecretKeySelector{LocalObjectReference: corev1.LocalObjectReference{Name: name(rid)}, Key: key},
		}})
	}
	// In a fixed order, so a reconcile compares like with like.
	sort.Slice(env, func(i, j int) bool { return env[i].Name < env[j].Name })
	replicas := int32(1)
	labels := p.labels(rid)
	return &appsv1.Deployment{
		ObjectMeta: metav1.ObjectMeta{Name: name(rid), Namespace: p.opts.Namespace, Labels: labels},
		Spec: appsv1.DeploymentSpec{
			Replicas: &replicas,
			Selector: &metav1.LabelSelector{MatchLabels: map[string]string{labelApp: name(rid)}},
			Template: corev1.PodTemplateSpec{
				ObjectMeta: metav1.ObjectMeta{Labels: labels},
				Spec: corev1.PodSpec{
					Containers: []corev1.Container{{
						Name:            "unit",
						Image:           image,
						ImagePullPolicy: corev1.PullIfNotPresent,
						Env:             env,
						Ports:           []corev1.ContainerPort{{ContainerPort: port}},
						ReadinessProbe: &corev1.Probe{
							ProbeHandler:     corev1.ProbeHandler{HTTPGet: &corev1.HTTPGetAction{Path: "/api/health", Port: intstr.FromInt(port)}},
							PeriodSeconds:    5,
							FailureThreshold: 60,
						},
						Resources: corev1.ResourceRequirements{Requests: requests, Limits: limits},
					}},
				},
			},
		},
	}
}

// drifted reports whether what the spec asks for differs from what runs: the image, the
// requests, the environment or the replica count. Only the fields the catalog sets count,
// since the API server fills in defaults the desired object does not carry.
func drifted(existing, desired *appsv1.Deployment) bool {
	have, want := existing.Spec.Template.Spec.Containers, desired.Spec.Template.Spec.Containers
	if len(have) != len(want) {
		return true
	}
	for i := range want {
		if have[i].Image != want[i].Image ||
			!apiequality.Semantic.DeepEqual(have[i].Resources.Requests, want[i].Resources.Requests) ||
			!apiequality.Semantic.DeepEqual(have[i].Resources.Limits, want[i].Resources.Limits) ||
			!apiequality.Semantic.DeepEqual(have[i].Env, want[i].Env) {
			return true
		}
	}
	return !apiequality.Semantic.DeepEqual(existing.Spec.Replicas, desired.Spec.Replicas)
}

func (p *Provider) service(rid string) *corev1.Service {
	return &corev1.Service{
		ObjectMeta: metav1.ObjectMeta{Name: name(rid), Namespace: p.opts.Namespace, Labels: p.labels(rid)},
		Spec: corev1.ServiceSpec{
			Selector: map[string]string{labelApp: name(rid)},
			Ports:    []corev1.ServicePort{{Name: "http", Port: port, TargetPort: intstr.FromInt(port)}},
		},
	}
}
