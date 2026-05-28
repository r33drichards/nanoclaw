// Reconciler for NanoAgent: stamps a SandboxTemplate, optional
// SandboxWarmPool, and a per-agent NetworkPolicy.
//
// Stub at this stage — emits a log line and returns. The reconciliation
// flow it will implement:
//
//  1. Resolve image tag (NanoAgent.spec.imageTag, falling back to the
//     controller's --default-agent-image flag).
//  2. Build a SandboxTemplate PodSpec from
//     NanoAgent.spec.{provider,model,effort,packages,mcpServers,…}.
//     Inject env: PGHOST/PGUSER/PGPASSWORD (via secretRef),
//     ONECLI_URL, NANOCLAW_SESSION_ID (via Downward API).
//  3. If NanoAgent.spec.warmPool.replicas > 0, create or update the
//     matching SandboxWarmPool.
//  4. If NetworkPolicyManaged, stamp a NetworkPolicy whose pod-selector
//     matches the SandboxTemplate's labels, allowing egress to OneCLI,
//     Postgres, DNS, and NanoAgent.spec.allowedEgress.
//  5. Set NanoAgent.status.{sandboxTemplateRef,warmPoolRef,resolvedImageTag}
//     and a Ready condition.
package controller

import (
	"context"

	"k8s.io/apimachinery/pkg/runtime"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/log"
)

// NanoAgentReconciler reconciles a NanoAgent into agent-sandbox primitives.
type NanoAgentReconciler struct {
	client.Client
	Scheme *runtime.Scheme
	Config Config
}

// Reconcile is the entry point. Stub — TODO: build SandboxTemplate etc.
func (r *NanoAgentReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	logger := log.FromContext(ctx).WithValues("nanoagent", req.NamespacedName)
	logger.V(1).Info("reconcile (stub)")
	return ctrl.Result{}, nil
}

// SetupWithManager registers the reconciler. The For() target will switch
// to a typed NanoAgent struct once we generate client code from the CRD.
func (r *NanoAgentReconciler) SetupWithManager(_ ctrl.Manager) error {
	// TODO: register watches on nanoagents.nanoclaw.io once the typed
	// scheme registration is added. Use unstructured.Unstructured wired
	// to apiVersion/Kind for now if we want to test the loop.
	return nil
}
