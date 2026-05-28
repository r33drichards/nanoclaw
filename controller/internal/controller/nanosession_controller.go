// Reconciler for NanoSession: materializes a SandboxClaim from the
// NanoAgent referenced in the session's spec, and scales the underlying
// Sandbox between replicas:0 (idle) and replicas:1 (active) based on
// NanoSession.status.phase.
//
// Stub at this stage. Reconciliation flow to implement:
//
//  1. Resolve NanoAgent via spec.agentRef. If missing, fail with reason
//     AgentNotFound.
//  2. If status.phase is Pending|Active and no SandboxClaim exists,
//     create one referencing the NanoAgent's SandboxTemplate.
//  3. If status.phase is Idle and a SandboxClaim exists with
//     replicas:1, scale it to 0 (saves quota when the conversation is
//     dormant).
//  4. If status.phase is Completed|Failed, delete the SandboxClaim.
//  5. Watch SandboxClaim → propagate Ready/ErrImagePull/etc. conditions
//     onto NanoSession.status.
//
// The Postgres row in `sessions` is the single source of truth for
// status.phase — the host updates the CRD status from a LISTEN-driven
// projector goroutine.
package controller

import (
	"context"

	"k8s.io/apimachinery/pkg/runtime"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/log"
)

type NanoSessionReconciler struct {
	client.Client
	Scheme *runtime.Scheme
	Config Config
}

func (r *NanoSessionReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	logger := log.FromContext(ctx).WithValues("nanosession", req.NamespacedName)
	logger.V(1).Info("reconcile (stub)")
	return ctrl.Result{}, nil
}

func (r *NanoSessionReconciler) SetupWithManager(_ ctrl.Manager) error {
	// TODO: watch nanosessions.nanoclaw.io and
	// sandboxclaims.extensions.agents.x-k8s.io.
	return nil
}
