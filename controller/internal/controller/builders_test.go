package controller

import (
	"testing"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

func newAgent(name string, spec map[string]interface{}) *unstructured.Unstructured {
	a := &unstructured.Unstructured{}
	a.SetGroupVersionKind(NanoAgentGVK)
	a.SetName(name)
	a.SetNamespace("nanoclaw")
	a.Object["spec"] = spec
	return a
}

func TestBuildSandboxTemplate_DefaultsAndEnv(t *testing.T) {
	agent := newAgent("pr-worker", map[string]interface{}{
		"provider":      "claude",
		"model":         "claude-opus-4-7",
		"assistantName": "PR Worker",
	})
	cfg := Config{
		Namespace:         "nanoclaw",
		DefaultAgentImage: "ghcr.io/foo/agent:1",
		OneCliService:     "ncl-onecli",
		PostgresHost:      "ncl-pg-rw",
	}
	tpl, err := buildSandboxTemplate(agent, cfg)
	if err != nil {
		t.Fatalf("buildSandboxTemplate: %v", err)
	}
	if got := tpl.GetName(); got != "ncl-pr-worker" {
		t.Fatalf("template name = %q, want ncl-pr-worker", got)
	}
	if tpl.GroupVersionKind() != SandboxTemplateGVK {
		t.Fatalf("template GVK = %v", tpl.GroupVersionKind())
	}

	img := extractImageFromTemplate(tpl)
	if img != "ghcr.io/foo/agent:1" {
		t.Fatalf("image = %q, want ghcr.io/foo/agent:1", img)
	}

	// Required env present
	env := mustGetEnv(t, tpl)
	mustHaveEnv(t, env, "PGHOST", "ncl-pg-rw")
	mustHaveEnv(t, env, "PGUSER", "nanoclaw_agent")
	mustHaveEnv(t, env, "ASSISTANT_NAME", "PR Worker")
	mustHaveEnv(t, env, "NANOCLAW_AGENT_GROUP_ID", "pr-worker")
	mustHaveEnv(t, env, "NANOCLAW_MODEL", "claude-opus-4-7")
	mustHaveEnv(t, env, "ONECLI_URL", "http://ncl-onecli.nanoclaw.svc.cluster.local:8080")
}

func TestBuildSandboxTemplate_AgentImageOverridesDefault(t *testing.T) {
	agent := newAgent("custom", map[string]interface{}{
		"provider": "claude",
		"imageTag": "registry.example.com/custom:42",
	})
	cfg := Config{DefaultAgentImage: "ghcr.io/foo/agent:1"}
	tpl, err := buildSandboxTemplate(agent, cfg)
	if err != nil {
		t.Fatalf("buildSandboxTemplate: %v", err)
	}
	if got := extractImageFromTemplate(tpl); got != "registry.example.com/custom:42" {
		t.Fatalf("image = %q, want registry.example.com/custom:42", got)
	}
}

func TestBuildSandboxTemplate_ErrorWhenNoImage(t *testing.T) {
	agent := newAgent("oops", map[string]interface{}{"provider": "claude"})
	_, err := buildSandboxTemplate(agent, Config{})
	if err == nil {
		t.Fatal("expected error when no imageTag and no default")
	}
}

func TestBuildSandboxWarmPool_OmittedWhenReplicasZero(t *testing.T) {
	agent := newAgent("idle", map[string]interface{}{
		"provider": "claude",
		"imageTag": "x",
		"warmPool": map[string]interface{}{"replicas": int64(0)},
	})
	p, err := buildSandboxWarmPool(agent, "ncl-idle")
	if err != nil {
		t.Fatalf("buildSandboxWarmPool: %v", err)
	}
	if p != nil {
		t.Fatalf("expected nil WarmPool for replicas=0, got %v", p)
	}
}

func TestBuildSandboxWarmPool_CreatedWhenReplicasPositive(t *testing.T) {
	agent := newAgent("hot", map[string]interface{}{
		"provider": "claude",
		"warmPool": map[string]interface{}{"replicas": int64(3)},
	})
	p, err := buildSandboxWarmPool(agent, "ncl-hot")
	if err != nil {
		t.Fatalf("buildSandboxWarmPool: %v", err)
	}
	if p == nil {
		t.Fatal("expected WarmPool for replicas=3")
	}
	spec, _ := p.Object["spec"].(map[string]interface{})
	if got := spec["replicas"]; got != int64(3) {
		t.Fatalf("replicas = %v, want 3", got)
	}
	ref, _ := spec["sandboxTemplateRef"].(map[string]interface{})
	if got, _ := ref["name"].(string); got != "ncl-hot" {
		t.Fatalf("sandboxTemplateRef.name = %q, want ncl-hot", got)
	}
}

func TestBuildSandboxClaim_RefsTemplate(t *testing.T) {
	session := &unstructured.Unstructured{}
	session.SetGroupVersionKind(NanoSessionGVK)
	session.SetName("sess-abc")
	session.SetNamespace("nanoclaw")
	session.Object["spec"] = map[string]interface{}{
		"agentRef": "pr-worker",
	}
	claim, err := buildSandboxClaim(session, "pr-worker")
	if err != nil {
		t.Fatalf("buildSandboxClaim: %v", err)
	}
	if claim.GetName() != "ncl-sess-abc" {
		t.Fatalf("claim name = %q", claim.GetName())
	}
	spec, _ := claim.Object["spec"].(map[string]interface{})
	ref, _ := spec["sandboxTemplateRef"].(map[string]interface{})
	if got, _ := ref["name"].(string); got != "ncl-pr-worker" {
		t.Fatalf("sandboxTemplateRef.name = %q, want ncl-pr-worker", got)
	}
	env, _ := spec["env"].([]interface{})
	if len(env) == 0 {
		t.Fatal("expected env entries")
	}
	first, _ := env[0].(map[string]interface{})
	if first["name"] != "NANOCLAW_SESSION_ID" {
		t.Fatalf("first env = %v, want NANOCLAW_SESSION_ID", first)
	}
}

func TestBuildNetworkPolicy_DisabledWhenUnmanaged(t *testing.T) {
	agent := newAgent("a", map[string]interface{}{"provider": "claude"})
	np := buildNetworkPolicy(agent, Config{NetworkPolicyManaged: false})
	if np != nil {
		t.Fatalf("expected nil NetworkPolicy when unmanaged")
	}
}

func TestBuildNetworkPolicy_AllowsOneCliAndPostgres(t *testing.T) {
	agent := newAgent("a", map[string]interface{}{"provider": "claude"})
	np := buildNetworkPolicy(agent, Config{
		NetworkPolicyManaged: true,
		AllowEgressOneCli:    true,
		AllowEgressPostgres:  true,
	})
	if np == nil {
		t.Fatal("expected NetworkPolicy")
	}
	spec, _ := np.Object["spec"].(map[string]interface{})
	egress, _ := spec["egress"].([]interface{})
	if len(egress) < 3 {
		t.Fatalf("expected at least 3 egress rules (DNS + OneCLI + Postgres), got %d", len(egress))
	}
}

func TestSpecHash_DeterministicAcrossKeyOrder(t *testing.T) {
	a := &unstructured.Unstructured{Object: map[string]interface{}{}}
	a.Object["spec"] = map[string]interface{}{
		"foo": "bar",
		"baz": "qux",
	}
	b := &unstructured.Unstructured{Object: map[string]interface{}{}}
	b.Object["spec"] = map[string]interface{}{
		"baz": "qux",
		"foo": "bar",
	}
	if specHash(a) != specHash(b) {
		t.Fatal("specHash differs for same content")
	}
}

// ────────────────────── test helpers ──────────────────────

func mustGetEnv(t *testing.T, tpl *unstructured.Unstructured) []interface{} {
	t.Helper()
	spec, _ := tpl.Object["spec"].(map[string]interface{})
	pt, _ := spec["podTemplate"].(map[string]interface{})
	ps, _ := pt["spec"].(map[string]interface{})
	containers, _ := ps["containers"].([]interface{})
	if len(containers) == 0 {
		t.Fatal("no containers")
	}
	c0, _ := containers[0].(map[string]interface{})
	env, _ := c0["env"].([]interface{})
	return env
}

func mustHaveEnv(t *testing.T, env []interface{}, name, want string) {
	t.Helper()
	for _, e := range env {
		m, _ := e.(map[string]interface{})
		if m["name"] == name {
			if m["value"] == want {
				return
			}
			t.Fatalf("env %s = %q, want %q", name, m["value"], want)
		}
	}
	t.Fatalf("env %s not found", name)
}
