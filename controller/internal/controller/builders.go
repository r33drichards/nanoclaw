package controller

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

// buildSandboxTemplate produces a SandboxTemplate from a NanoAgent.
//
// The SandboxTemplate's PodSpec is built from:
//   - the agent's resolved image tag (spec.imageTag or the controller's
//     --default-agent-image)
//   - env: PGHOST, PGUSER, PGPASSWORD (Secret ref), PGDATABASE,
//     ONECLI_URL, NANOCLAW_AGENT_GROUP_ID
//   - per-MCP-server env mapping
//   - cliScope and other simple scalar config
//
// NetworkPolicy is emitted as a sibling resource (see buildNetworkPolicy)
// rather than baked into the template — agent-sandbox's NetworkPolicy
// support is geared at egress allow-listing the controller maintains.
func buildSandboxTemplate(agent *unstructured.Unstructured, cfg Config) (*unstructured.Unstructured, error) {
	spec, ok := agent.Object["spec"].(map[string]interface{})
	if !ok {
		return nil, fmt.Errorf("nanoagent %s missing spec", agent.GetName())
	}

	imageTag := stringOr(spec, "imageTag", cfg.DefaultAgentImage)
	if imageTag == "" {
		return nil, fmt.Errorf("nanoagent %s has no imageTag and controller has no --default-agent-image", agent.GetName())
	}
	assistantName := stringOr(spec, "assistantName", agent.GetName())
	provider := stringOr(spec, "provider", "claude")
	model := stringOr(spec, "model", "")
	effort := stringOr(spec, "effort", "")
	cliScope := stringOr(spec, "cliScope", "group")

	env := []map[string]interface{}{
		{
			"name": "NANOCLAW_AGENT_GROUP_ID",
			"value": agent.GetName(),
		},
		{
			"name":  "NANOCLAW_AGENT_PROVIDER",
			"value": provider,
		},
		{
			"name":  "ASSISTANT_NAME",
			"value": assistantName,
		},
		{
			"name":  "NANOCLAW_CLI_SCOPE",
			"value": cliScope,
		},
		{
			"name":  "PGHOST",
			"value": cfg.PostgresHost,
		},
		{
			"name":  "PGUSER",
			"value": "nanoclaw_agent",
		},
		{
			"name": "PGPASSWORD",
			"valueFrom": map[string]interface{}{
				"secretKeyRef": map[string]interface{}{
					"name": "nanoclaw-pg-agent",
					"key":  "password",
				},
			},
		},
		{
			"name":  "ONECLI_URL",
			"value": fmt.Sprintf("http://%s.%s.svc.cluster.local:8080", cfg.OneCliService, onecliNamespace(cfg, agent)),
		},
	}
	if model != "" {
		env = append(env, map[string]interface{}{"name": "NANOCLAW_MODEL", "value": model})
	}
	if effort != "" {
		env = append(env, map[string]interface{}{"name": "NANOCLAW_EFFORT", "value": effort})
	}

	template := &unstructured.Unstructured{}
	template.SetGroupVersionKind(SandboxTemplateGVK)
	template.SetName("ncl-" + agent.GetName())
	template.SetNamespace(agent.GetNamespace())
	template.SetLabels(map[string]string{
		LabelManagedBy:    LabelManagedByVal,
		LabelAgentRef:     agent.GetName(),
		LabelAgentGroupID: agent.GetName(),
	})
	template.Object["spec"] = map[string]interface{}{
		"envVarsInjectionPolicy":   "Allowed",
		"networkPolicyManagement":  "Unmanaged", // we author our own NetworkPolicy
		"service":                  true,
		"podTemplate": map[string]interface{}{
			"metadata": map[string]interface{}{
				"labels": map[string]interface{}{
					LabelAgentRef:     agent.GetName(),
					LabelAgentGroupID: agent.GetName(),
				},
			},
			"spec": map[string]interface{}{
				"automountServiceAccountToken": false,
				"containers": []interface{}{
					map[string]interface{}{
						"name":            "agent-runner",
						"image":           imageTag,
						"imagePullPolicy": "IfNotPresent",
						"env":             toInterfaceSlice(env),
					},
				},
			},
		},
	}
	return template, nil
}

// buildSandboxWarmPool returns the SandboxWarmPool corresponding to
// spec.warmPool.replicas. Returns nil if no warm pool is requested.
func buildSandboxWarmPool(agent *unstructured.Unstructured, templateName string) (*unstructured.Unstructured, error) {
	spec, _ := agent.Object["spec"].(map[string]interface{})
	wpRaw, ok := spec["warmPool"].(map[string]interface{})
	if !ok {
		return nil, nil
	}
	replicas := int64(0)
	switch v := wpRaw["replicas"].(type) {
	case int64:
		replicas = v
	case float64:
		replicas = int64(v)
	case int:
		replicas = int64(v)
	}
	if replicas <= 0 {
		return nil, nil
	}

	pool := &unstructured.Unstructured{}
	pool.SetGroupVersionKind(SandboxWarmPoolGVK)
	pool.SetName("ncl-" + agent.GetName())
	pool.SetNamespace(agent.GetNamespace())
	pool.SetLabels(map[string]string{
		LabelManagedBy: LabelManagedByVal,
		LabelAgentRef:  agent.GetName(),
	})
	pool.Object["spec"] = map[string]interface{}{
		"replicas":            replicas,
		"sandboxTemplateRef":  map[string]interface{}{"name": templateName},
		"updateStrategy":      "OnReplenish",
	}
	return pool, nil
}

// buildSandboxClaim produces the SandboxClaim that materializes a
// NanoSession. The claim references the agent's SandboxTemplate and
// carries per-session env (NANOCLAW_SESSION_ID).
func buildSandboxClaim(session *unstructured.Unstructured, agentName string) (*unstructured.Unstructured, error) {
	claim := &unstructured.Unstructured{}
	claim.SetGroupVersionKind(SandboxClaimGVK)
	claim.SetName("ncl-" + session.GetName())
	claim.SetNamespace(session.GetNamespace())
	claim.SetLabels(map[string]string{
		LabelManagedBy:   LabelManagedByVal,
		LabelSessionRef:  session.GetName(),
		LabelAgentRef:    agentName,
	})
	claim.Object["spec"] = map[string]interface{}{
		"sandboxTemplateRef": map[string]interface{}{"name": "ncl-" + agentName},
		"additionalPodMetadata": map[string]interface{}{
			"labels": map[string]interface{}{
				LabelSessionRef: session.GetName(),
				LabelAgentRef:   agentName,
			},
			"annotations": map[string]interface{}{
				"nanoclaw.io/session-id": session.GetName(),
			},
		},
		"env": []interface{}{
			map[string]interface{}{"name": "NANOCLAW_SESSION_ID", "value": session.GetName()},
		},
		"lifecycle": map[string]interface{}{
			"ttlSecondsAfterFinished": int64(60),
		},
	}
	return claim, nil
}

// buildNetworkPolicy returns the per-agent NetworkPolicy. Default-deny
// egress with explicit allows for DNS, OneCLI, Postgres, and any hosts
// the operator listed in NanoAgent.spec.allowedEgress.
//
// Note: NetworkPolicy egress rules use podSelector or namespaceSelector
// (in-cluster) or ipBlock (CIDR). Hostnames in allowedEgress are
// emitted as a comment-only note for the user — the resulting policy
// covers only the OneCLI/Postgres/DNS allows. Hostname-based egress
// requires Cilium FQDN policies or a sidecar; out of scope here.
func buildNetworkPolicy(agent *unstructured.Unstructured, cfg Config) *unstructured.Unstructured {
	if !cfg.NetworkPolicyManaged {
		return nil
	}
	np := &unstructured.Unstructured{}
	np.SetAPIVersion("networking.k8s.io/v1")
	np.SetKind("NetworkPolicy")
	np.SetName("ncl-" + agent.GetName())
	np.SetNamespace(agent.GetNamespace())
	np.SetLabels(map[string]string{
		LabelManagedBy: LabelManagedByVal,
		LabelAgentRef:  agent.GetName(),
	})

	egress := []interface{}{
		// DNS
		map[string]interface{}{
			"to": []interface{}{
				map[string]interface{}{
					"namespaceSelector": map[string]interface{}{},
					"podSelector": map[string]interface{}{
						"matchLabels": map[string]interface{}{"k8s-app": "kube-dns"},
					},
				},
			},
			"ports": []interface{}{
				map[string]interface{}{"protocol": "UDP", "port": int64(53)},
				map[string]interface{}{"protocol": "TCP", "port": int64(53)},
			},
		},
	}
	if cfg.AllowEgressOneCli {
		egress = append(egress, map[string]interface{}{
			"to": []interface{}{
				map[string]interface{}{
					"podSelector": map[string]interface{}{
						"matchLabels": map[string]interface{}{
							"app.kubernetes.io/name":      "nanoclaw",
							"app.kubernetes.io/component": "onecli",
						},
					},
				},
			},
			"ports": []interface{}{
				map[string]interface{}{"protocol": "TCP", "port": int64(8080)},
			},
		})
	}
	if cfg.AllowEgressPostgres {
		egress = append(egress, map[string]interface{}{
			"to": []interface{}{
				map[string]interface{}{
					"podSelector": map[string]interface{}{
						"matchLabels": map[string]interface{}{
							"cnpg.io/cluster": "nanoclaw-pg",
						},
					},
				},
			},
			"ports": []interface{}{
				map[string]interface{}{"protocol": "TCP", "port": int64(5432)},
			},
		})
	}

	np.Object["spec"] = map[string]interface{}{
		"podSelector": map[string]interface{}{
			"matchLabels": map[string]interface{}{
				LabelAgentRef: agent.GetName(),
			},
		},
		"policyTypes": []interface{}{"Egress"},
		"egress":      egress,
	}
	return np
}

// specHash returns a deterministic content hash of an unstructured spec.
// Used as an annotation so reconcile can detect drift without diffing
// the full object tree.
func specHash(obj *unstructured.Unstructured) string {
	specRaw := obj.Object["spec"]
	b, err := json.Marshal(specRaw)
	if err != nil {
		return ""
	}
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// ensureSpecAnnotation sets AnnotationSpecHash on an object. Call after
// building the desired state, before CreateOrUpdate.
func ensureSpecAnnotation(obj *unstructured.Unstructured) {
	ann := obj.GetAnnotations()
	if ann == nil {
		ann = map[string]string{}
	}
	ann[AnnotationSpecHash] = specHash(obj)
	obj.SetAnnotations(ann)
}

// setOwnerRef sets a single OwnerReference on the child pointing at the
// parent. Controller=true so cascade delete reaps the child when the
// parent is deleted.
func setOwnerRef(child, parent *unstructured.Unstructured) {
	t := true
	child.SetOwnerReferences([]metav1.OwnerReference{{
		APIVersion:         parent.GetAPIVersion(),
		Kind:               parent.GetKind(),
		Name:               parent.GetName(),
		UID:                parent.GetUID(),
		Controller:         &t,
		BlockOwnerDeletion: &t,
	}})
}

// stringOr returns m[key] as a string if present, otherwise fallback.
func stringOr(m map[string]interface{}, key, fallback string) string {
	v, ok := m[key].(string)
	if !ok || v == "" {
		return fallback
	}
	return v
}

// onecliNamespace prefers the controller's configured namespace
// (typically the chart release namespace where OneCLI is deployed) and
// falls back to the agent's namespace when the controller runs
// cluster-wide.
func onecliNamespace(cfg Config, agent *unstructured.Unstructured) string {
	if cfg.Namespace != "" {
		return cfg.Namespace
	}
	return agent.GetNamespace()
}

func toInterfaceSlice(in []map[string]interface{}) []interface{} {
	out := make([]interface{}, len(in))
	for i, v := range in {
		out[i] = v
	}
	return out
}
