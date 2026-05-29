// Reconciler for NanoSession: materializes a SandboxClaim from the
// NanoAgent referenced in the session's spec, and aligns the underlying
// Sandbox with the session's lifecycle phase.
//
// Reconciliation flow:
//
//  1. Resolve NanoAgent via spec.agentRef. Missing → status.Ready=False.
//  2. If status.phase ∈ {Pending, Active, Idle} and no SandboxClaim
//     exists, create one referencing the agent's SandboxTemplate.
//  3. If status.phase ∈ {Completed, Failed}, delete the SandboxClaim.
//  4. Update NanoSession status with sandboxClaimRef.
//
// The host owns NanoSession.status.phase — it transitions the phase
// based on inbound message activity (Postgres-driven, LISTEN-fed). The
// controller reacts.
package controller

import (
	"context"
	"fmt"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"

	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
	"sigs.k8s.io/controller-runtime/pkg/log"
)

type NanoSessionReconciler struct {
	client.Client
	Scheme *runtime.Scheme
	Config Config
}

func (r *NanoSessionReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	logger := log.FromContext(ctx).WithValues("nanosession", req.NamespacedName)

	session := &unstructured.Unstructured{}
	session.SetGroupVersionKind(NanoSessionGVK)
	if err := r.Get(ctx, req.NamespacedName, session); err != nil {
		if apierrors.IsNotFound(err) {
			return ctrl.Result{}, nil
		}
		return ctrl.Result{}, err
	}

	spec, _ := session.Object["spec"].(map[string]interface{})
	agentRef, _ := spec["agentRef"].(string)
	if agentRef == "" {
		return ctrl.Result{}, r.setNotReady(ctx, session, "MissingAgentRef", "spec.agentRef is required")
	}

	// 1. Resolve NanoAgent.
	agent := &unstructured.Unstructured{}
	agent.SetGroupVersionKind(NanoAgentGVK)
	if err := r.Get(ctx, types.NamespacedName{Namespace: session.GetNamespace(), Name: agentRef}, agent); err != nil {
		if apierrors.IsNotFound(err) {
			return ctrl.Result{}, r.setNotReady(ctx, session, "AgentNotFound",
				fmt.Sprintf("nanoagent %q not found in namespace %q", agentRef, session.GetNamespace()))
		}
		return ctrl.Result{}, err
	}

	phase := readPhase(session)
	claimName := "ncl-" + session.GetName()

	// 3. Terminal phases: GC the claim and clear status.sandboxClaimRef.
	if phase == "Completed" || phase == "Failed" {
		if err := r.deleteClaimIfExists(ctx, session.GetNamespace(), claimName); err != nil {
			logger.Error(err, "delete SandboxClaim")
			return ctrl.Result{}, err
		}
		return ctrl.Result{}, r.patchStatus(ctx, session, map[string]interface{}{
			"phase":         phase,
			"sandboxClaimRef": "",
			"conditions": []interface{}{
				conditionTrue(ConditionReady, "Terminal", "session reached terminal phase; claim reaped"),
			},
		})
	}

	// 2. Build + apply the SandboxClaim.
	claim, err := buildSandboxClaim(session, agent.GetName())
	if err != nil {
		return ctrl.Result{}, r.setNotReady(ctx, session, "BuildFailed", err.Error())
	}
	setOwnerRef(claim, session)
	ensureSpecAnnotation(claim)
	if err := r.applyUnstructured(ctx, claim); err != nil {
		logger.Error(err, "apply SandboxClaim")
		return ctrl.Result{}, err
	}

	// 4. Status.
	return ctrl.Result{}, r.patchStatus(ctx, session, map[string]interface{}{
		"phase":           phase,
		"sandboxClaimRef": claim.GetName(),
		"conditions": []interface{}{
			conditionTrue(ConditionReady, "Reconciled", "SandboxClaim applied"),
		},
	})
}

func (r *NanoSessionReconciler) applyUnstructured(ctx context.Context, desired *unstructured.Unstructured) error {
	current := &unstructured.Unstructured{}
	current.SetGroupVersionKind(desired.GroupVersionKind())
	op, err := controllerutil.CreateOrUpdate(ctx, r.Client, current, func() error {
		current.SetLabels(mergeMap(current.GetLabels(), desired.GetLabels()))
		current.SetAnnotations(mergeMap(current.GetAnnotations(), desired.GetAnnotations()))
		current.SetOwnerReferences(desired.GetOwnerReferences())
		current.Object["spec"] = desired.Object["spec"]
		return nil
	})
	if err != nil {
		return fmt.Errorf("apply %s/%s: %w", desired.GetKind(), desired.GetName(), err)
	}
	if op != controllerutil.OperationResultNone {
		log.FromContext(ctx).Info("applied", "kind", desired.GetKind(), "name", desired.GetName(), "op", op)
	}
	return nil
}

func (r *NanoSessionReconciler) deleteClaimIfExists(ctx context.Context, ns, name string) error {
	claim := &unstructured.Unstructured{}
	claim.SetGroupVersionKind(SandboxClaimGVK)
	claim.SetNamespace(ns)
	claim.SetName(name)
	if err := r.Delete(ctx, claim); err != nil && !apierrors.IsNotFound(err) {
		return err
	}
	return nil
}

func (r *NanoSessionReconciler) setNotReady(ctx context.Context, session *unstructured.Unstructured, reason, msg string) error {
	return r.patchStatus(ctx, session, map[string]interface{}{
		"conditions": []interface{}{
			conditionFalse(ConditionReady, reason, msg),
		},
	})
}

func (r *NanoSessionReconciler) patchStatus(ctx context.Context, session *unstructured.Unstructured, status map[string]interface{}) error {
	current := &unstructured.Unstructured{}
	current.SetGroupVersionKind(NanoSessionGVK)
	if err := r.Get(ctx, client.ObjectKeyFromObject(session), current); err != nil {
		return err
	}
	// Preserve any existing status fields the host writes (e.g. pendingMessages).
	existing, _ := current.Object["status"].(map[string]interface{})
	if existing == nil {
		existing = map[string]interface{}{}
	}
	for k, v := range status {
		existing[k] = v
	}
	existing["lastActive"] = metav1.Now().Format("2006-01-02T15:04:05Z")
	current.Object["status"] = existing
	return r.Status().Update(ctx, current)
}

// readPhase returns the current session phase from status.phase, defaulting
// to "Pending" for new sessions the host hasn't touched yet.
func readPhase(session *unstructured.Unstructured) string {
	status, _ := session.Object["status"].(map[string]interface{})
	if p, ok := status["phase"].(string); ok && p != "" {
		return p
	}
	return "Pending"
}

func (r *NanoSessionReconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		Named("nanosession").
		For(unstructuredFor(NanoSessionGVK)).
		Owns(unstructuredFor(SandboxClaimGVK)).
		Complete(r)
}
