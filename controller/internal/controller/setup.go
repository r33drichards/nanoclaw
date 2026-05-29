// Package controller wires the per-CRD reconcilers into the manager.
//
// The reconcilers are stubs at this stage — they log and return success.
// The structure is sized to grow into:
//
//   - NanoAgentReconciler: NanoAgent → SandboxTemplate (+ optional
//     SandboxWarmPool) + NetworkPolicy.
//   - NanoSessionReconciler: NanoSession → SandboxClaim (idle = replicas
//     0, active = replicas 1). Watches SandboxClaim status to update
//     NanoSession.status.phase.
//   - NanoApprovalReconciler: TTL'd approval cleanup; surfacing of stuck
//     approvals as events.
//   - HousekeepingReconciler: GC of completed NanoSessions, orphan
//     SandboxClaim reap, image-tag resolution caching.
package controller

import (
	ctrl "sigs.k8s.io/controller-runtime"
)

// Config bundles flag-driven settings for the reconcilers.
type Config struct {
	Namespace            string
	DefaultAgentImage    string
	OneCliService        string
	PostgresHost         string
	NetworkPolicyManaged bool
	AllowEgressOneCli    bool
	AllowEgressPostgres  bool
}

// SetupWithManager registers all NanoClaw reconcilers.
func SetupWithManager(mgr ctrl.Manager, cfg Config) error {
	if err := (&NanoAgentReconciler{
		Client: mgr.GetClient(),
		Scheme: mgr.GetScheme(),
		Config: cfg,
	}).SetupWithManager(mgr); err != nil {
		return err
	}
	if err := (&NanoSessionReconciler{
		Client: mgr.GetClient(),
		Scheme: mgr.GetScheme(),
		Config: cfg,
	}).SetupWithManager(mgr); err != nil {
		return err
	}
	return nil
}
