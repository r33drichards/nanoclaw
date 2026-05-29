package controller

import (
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
)

// unstructuredFor returns an empty Unstructured with its GVK preset.
// Use it when handing types to controller-runtime's For() / Owns() / Watches().
func unstructuredFor(gvk schema.GroupVersionKind) *unstructured.Unstructured {
	u := &unstructured.Unstructured{}
	u.SetGroupVersionKind(gvk)
	return u
}

// GroupVersionKinds for the unstructured types the controller manipulates.
// Switch to typed clients once we add code generation; until then,
// unstructured.Unstructured is the lightest path that compiles immediately.

var (
	NanoAgentGVK = schema.GroupVersionKind{
		Group:   "nanoclaw.io",
		Version: "v1alpha1",
		Kind:    "NanoAgent",
	}
	NanoMessagingGroupGVK = schema.GroupVersionKind{
		Group:   "nanoclaw.io",
		Version: "v1alpha1",
		Kind:    "NanoMessagingGroup",
	}
	NanoWiringGVK = schema.GroupVersionKind{
		Group:   "nanoclaw.io",
		Version: "v1alpha1",
		Kind:    "NanoWiring",
	}
	NanoSessionGVK = schema.GroupVersionKind{
		Group:   "nanoclaw.io",
		Version: "v1alpha1",
		Kind:    "NanoSession",
	}

	SandboxTemplateGVK = schema.GroupVersionKind{
		Group:   "extensions.agents.x-k8s.io",
		Version: "v1beta1",
		Kind:    "SandboxTemplate",
	}
	SandboxClaimGVK = schema.GroupVersionKind{
		Group:   "extensions.agents.x-k8s.io",
		Version: "v1beta1",
		Kind:    "SandboxClaim",
	}
	SandboxWarmPoolGVK = schema.GroupVersionKind{
		Group:   "extensions.agents.x-k8s.io",
		Version: "v1beta1",
		Kind:    "SandboxWarmPool",
	}
)

// Labels and annotations the controller stamps onto its outputs.
const (
	LabelManagedBy     = "app.kubernetes.io/managed-by"
	LabelManagedByVal  = "nanoclaw-controller"
	LabelAgentRef      = "nanoclaw.io/agent-ref"
	LabelSessionRef    = "nanoclaw.io/session-ref"
	LabelAgentGroupID  = "nanoclaw.io/agent-group-id"
	AnnotationSpecHash = "nanoclaw.io/spec-hash"

	// ConditionReady is set on NanoAgent/NanoSession when downstream
	// agent-sandbox objects are observed Ready.
	ConditionReady = "Ready"
)
