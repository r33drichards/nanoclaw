// Reconciler for NanoAgent: stamps a SandboxTemplate, optional
// SandboxWarmPool, and a per-agent NetworkPolicy.
//
// Reconciliation flow:
//
//  1. Resolve image tag (NanoAgent.spec.imageTag, falling back to the
//     controller's --default-agent-image flag). Error → status.Ready=False.
//  2. Build a SandboxTemplate PodSpec from NanoAgent.spec and create or
//     update it under the name `ncl-<nanoagent-name>`.
//  3. Build the per-agent NetworkPolicy (default-deny egress + OneCLI +
//     Postgres + DNS allows). Skip when --network-policy-managed=false.
//  4. If NanoAgent.spec.warmPool.replicas > 0, create or update a
//     matching SandboxWarmPool.
//  5. Set NanoAgent.status to reflect resolvedImageTag, sandboxTemplateRef,
//     warmPoolRef, and a Ready condition.
package controller

import (
	"context"
	"fmt"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"

	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
	"sigs.k8s.io/controller-runtime/pkg/log"
)

// NanoAgentReconciler reconciles a NanoAgent into agent-sandbox primitives.
type NanoAgentReconciler struct {
	client.Client
	Scheme *runtime.Scheme
	Config Config
}

// Reconcile materializes the desired state for a NanoAgent.
func (r *NanoAgentReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	logger := log.FromContext(ctx).WithValues("nanoagent", req.NamespacedName)

	agent := &unstructured.Unstructured{}
	agent.SetGroupVersionKind(NanoAgentGVK)
	if err := r.Get(ctx, req.NamespacedName, agent); err != nil {
		if apierrors.IsNotFound(err) {
			// CR deleted — owner references cascade-delete the children.
			return ctrl.Result{}, nil
		}
		return ctrl.Result{}, err
	}

	// 1+2. Build and apply the SandboxTemplate.
	template, err := buildSandboxTemplate(agent, r.Config)
	if err != nil {
		logger.Error(err, "build SandboxTemplate")
		_ = r.setNotReady(ctx, agent, "BuildFailed", err.Error())
		return ctrl.Result{}, nil
	}
	setOwnerRef(template, agent)
	ensureSpecAnnotation(template)
	if err := r.applyUnstructured(ctx, template); err != nil {
		logger.Error(err, "apply SandboxTemplate")
		return ctrl.Result{}, err
	}

	// 3. NetworkPolicy.
	if np := buildNetworkPolicy(agent, r.Config); np != nil {
		setOwnerRef(np, agent)
		ensureSpecAnnotation(np)
		if err := r.applyUnstructured(ctx, np); err != nil {
			logger.Error(err, "apply NetworkPolicy")
			return ctrl.Result{}, err
		}
	}

	// 4. Optional SandboxWarmPool.
	pool, err := buildSandboxWarmPool(agent, template.GetName())
	if err != nil {
		logger.Error(err, "build SandboxWarmPool")
		_ = r.setNotReady(ctx, agent, "BuildFailed", err.Error())
		return ctrl.Result{}, nil
	}
	if pool != nil {
		setOwnerRef(pool, agent)
		ensureSpecAnnotation(pool)
		if err := r.applyUnstructured(ctx, pool); err != nil {
			logger.Error(err, "apply SandboxWarmPool")
			return ctrl.Result{}, err
		}
	}

	// 5. Status.
	if err := r.setReady(ctx, agent, template, pool); err != nil {
		logger.Error(err, "update status")
		return ctrl.Result{}, err
	}
	return ctrl.Result{}, nil
}

func (r *NanoAgentReconciler) applyUnstructured(ctx context.Context, desired *unstructured.Unstructured) error {
	current := &unstructured.Unstructured{}
	current.SetGroupVersionKind(desired.GroupVersionKind())
	op, err := controllerutil.CreateOrUpdate(ctx, r.Client, current, func() error {
		// Copy spec, labels, annotations, owner refs from desired onto current.
		// metadata.resourceVersion etc. is preserved.
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

func (r *NanoAgentReconciler) setReady(ctx context.Context, agent, template, pool *unstructured.Unstructured) error {
	status := map[string]interface{}{
		"sandboxTemplateRef": template.GetName(),
		"resolvedImageTag":   extractImageFromTemplate(template),
		"conditions": []interface{}{
			conditionTrue(ConditionReady, "Reconciled", "SandboxTemplate applied"),
		},
	}
	if pool != nil {
		status["warmPoolRef"] = pool.GetName()
	}
	return r.patchStatus(ctx, agent, status)
}

func (r *NanoAgentReconciler) setNotReady(ctx context.Context, agent *unstructured.Unstructured, reason, msg string) error {
	status := map[string]interface{}{
		"conditions": []interface{}{
			conditionFalse(ConditionReady, reason, msg),
		},
	}
	return r.patchStatus(ctx, agent, status)
}

func (r *NanoAgentReconciler) patchStatus(ctx context.Context, agent *unstructured.Unstructured, status map[string]interface{}) error {
	current := &unstructured.Unstructured{}
	current.SetGroupVersionKind(NanoAgentGVK)
	if err := r.Get(ctx, client.ObjectKeyFromObject(agent), current); err != nil {
		return err
	}
	current.Object["status"] = status
	return r.Status().Update(ctx, current)
}

// SetupWithManager registers the reconciler with the manager. NanoAgent
// CRDs come in as unstructured.Unstructured; the controller watches
// SandboxTemplate / SandboxWarmPool / NetworkPolicy as owned resources
// (owner-ref propagation triggers reconcile on child changes).
func (r *NanoAgentReconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		Named("nanoagent").
		For(unstructuredFor(NanoAgentGVK)).
		Owns(unstructuredFor(SandboxTemplateGVK)).
		Owns(unstructuredFor(SandboxWarmPoolGVK)).
		Owns(networkPolicyUnstructured()).
		Complete(r)
}

// ────────────────────────────── helpers ──────────────────────────────

func networkPolicyUnstructured() *unstructured.Unstructured {
	u := &unstructured.Unstructured{}
	u.SetAPIVersion("networking.k8s.io/v1")
	u.SetKind("NetworkPolicy")
	return u
}

func mergeMap(a, b map[string]string) map[string]string {
	out := make(map[string]string, len(a)+len(b))
	for k, v := range a {
		out[k] = v
	}
	for k, v := range b {
		out[k] = v
	}
	return out
}

func extractImageFromTemplate(t *unstructured.Unstructured) string {
	spec, _ := t.Object["spec"].(map[string]interface{})
	pt, _ := spec["podTemplate"].(map[string]interface{})
	ps, _ := pt["spec"].(map[string]interface{})
	containers, _ := ps["containers"].([]interface{})
	if len(containers) == 0 {
		return ""
	}
	c0, _ := containers[0].(map[string]interface{})
	if img, ok := c0["image"].(string); ok {
		return img
	}
	return ""
}

func conditionTrue(t, reason, msg string) map[string]interface{} {
	return map[string]interface{}{
		"type":               t,
		"status":             "True",
		"reason":             reason,
		"message":            msg,
		"lastTransitionTime": metav1.Now().Format("2006-01-02T15:04:05Z"),
	}
}

func conditionFalse(t, reason, msg string) map[string]interface{} {
	return map[string]interface{}{
		"type":               t,
		"status":             "False",
		"reason":             reason,
		"message":            msg,
		"lastTransitionTime": metav1.Now().Format("2006-01-02T15:04:05Z"),
	}
}
