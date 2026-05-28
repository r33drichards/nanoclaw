#!/usr/bin/env bash
#
# Declarative-mode E2E: spins up a kind cluster, installs prerequisites,
# deploys the NanoClaw chart, applies the example CRs, and asserts that
# the controller materializes agent-sandbox resources correctly.
#
# Currently exercises:
#   - kind cluster bringup
#   - CNPG operator install (Postgres cluster comes Ready)
#   - kubernetes-sigs/agent-sandbox CRDs + controller install
#   - NanoClaw Helm chart install (host, controller, OneCLI, NetworkPolicies)
#   - Apply NanoAgent → controller reconciles SandboxTemplate
#   - Postgres schema is initialized via the CNPG post-init ConfigMap
#
# Deferred (waiting on follow-up commits):
#   - End-to-end message round-trip (host PG read/write of messages_in /
#     messages_out, container LISTEN/NOTIFY wake). The boot sequence still
#     defaults to SQLite; flip to NANOCLAW_DB_BACKEND=postgres + wire the
#     port-by-port async accessor adoption first.
#
# Flags:
#   --cluster NAME    Kind cluster name (default nanoclaw-e2e)
#   --namespace NS    Target namespace (default nanoclaw)
#   --keep            Don't delete the cluster on exit (for debugging)
#   --skip-deploy     Assume the chart is already installed (faster iteration)
#
# Required tools: kind, kubectl, helm, docker (or a kind-compatible runtime).

set -euo pipefail

CLUSTER="nanoclaw-e2e"
NAMESPACE="nanoclaw"
KEEP=0
SKIP_DEPLOY=0

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DEPLOY_DIR="${REPO_ROOT}/deploy"
CHART_DIR="${DEPLOY_DIR}/helm/nanoclaw"
EXAMPLES_DIR="${DEPLOY_DIR}/examples"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --cluster) CLUSTER="$2"; shift 2;;
    --namespace) NAMESPACE="$2"; shift 2;;
    --keep) KEEP=1; shift;;
    --skip-deploy) SKIP_DEPLOY=1; shift;;
    -h|--help) sed -n '/^# /,/^$/p' "$0"; exit 0;;
    *) echo "unknown flag: $1" >&2; exit 2;;
  esac
done

log() { echo -e "\033[1;36m[e2e]\033[0m $*"; }
fail() { echo -e "\033[1;31m[fail]\033[0m $*" >&2; exit 1; }

cleanup() {
  if [[ "$KEEP" -eq 1 ]]; then
    log "skipping cluster delete (--keep)"
    return
  fi
  if kind get clusters 2>/dev/null | grep -qx "$CLUSTER"; then
    log "deleting kind cluster $CLUSTER"
    kind delete cluster --name "$CLUSTER" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

# ────────────────────────────── prereqs ──────────────────────────────

for cmd in kind kubectl helm docker; do
  command -v "$cmd" >/dev/null 2>&1 || fail "missing dependency: $cmd"
done

# ────────────────────────────── cluster ──────────────────────────────

if ! kind get clusters 2>/dev/null | grep -qx "$CLUSTER"; then
  log "creating kind cluster $CLUSTER"
  kind create cluster --name "$CLUSTER" --wait 120s
else
  log "reusing existing kind cluster $CLUSTER"
fi

KUBECONFIG_CTX="kind-${CLUSTER}"
kubectl config use-context "$KUBECONFIG_CTX" >/dev/null

# ────────────────────────────── operators ──────────────────────────────

if [[ "$SKIP_DEPLOY" -eq 0 ]]; then
  log "installing cert-manager (CNPG dependency)"
  kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/v1.14.4/cert-manager.yaml
  kubectl wait --for=condition=Available --timeout=180s deployment -n cert-manager --all

  log "installing CloudNativePG operator"
  kubectl apply --server-side -f \
    https://raw.githubusercontent.com/cloudnative-pg/cloudnative-pg/release-1.24/releases/cnpg-1.24.0.yaml
  kubectl wait --for=condition=Available --timeout=180s \
    deployment -n cnpg-system cnpg-controller-manager

  log "installing agent-sandbox CRDs + controller"
  kubectl apply -k github.com/kubernetes-sigs/agent-sandbox/config/default
  # The agent-sandbox controller's deployment selector varies by release;
  # wait on the CRDs being established instead.
  kubectl wait --for=condition=Established --timeout=120s \
    crd/sandboxes.agents.x-k8s.io \
    crd/sandboxtemplates.extensions.agents.x-k8s.io \
    crd/sandboxclaims.extensions.agents.x-k8s.io \
    crd/sandboxwarmpools.extensions.agents.x-k8s.io
fi

# ────────────────────────────── nanoclaw CRDs ──────────────────────────────

log "installing NanoClaw CRDs"
kubectl apply -f "${DEPLOY_DIR}/crds/"
kubectl wait --for=condition=Established --timeout=60s \
  crd/nanoagents.nanoclaw.io \
  crd/nanomessaginggroups.nanoclaw.io \
  crd/nanowirings.nanoclaw.io \
  crd/nanosessions.nanoclaw.io \
  crd/nanoapprovals.nanoclaw.io \
  crd/nanousers.nanoclaw.io

# ────────────────────────────── controller image ──────────────────────────────

if [[ "$SKIP_DEPLOY" -eq 0 ]]; then
  log "building NanoClaw controller image"
  ( cd "${REPO_ROOT}/controller" && docker build -t nanoclaw-controller:e2e . )
  kind load docker-image nanoclaw-controller:e2e --name "$CLUSTER"
fi

# ────────────────────────────── helm install ──────────────────────────────

if [[ "$SKIP_DEPLOY" -eq 0 ]]; then
  log "installing NanoClaw chart"
  kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -
  helm upgrade --install nanoclaw "$CHART_DIR" \
    --namespace "$NAMESPACE" \
    --set images.controller.repository=nanoclaw-controller \
    --set images.controller.tag=e2e \
    --set images.controller.pullPolicy=IfNotPresent \
    --set postgres.cluster.instances=1 \
    --wait --timeout 5m
fi

# ────────────────────────────── wait for Postgres ──────────────────────────────

log "waiting for CNPG cluster Ready"
kubectl wait --for=condition=Ready --timeout=180s \
  cluster.postgresql.cnpg.io/nanoclaw-pg -n "$NAMESPACE"

# ────────────────────────────── schema check ──────────────────────────────

log "verifying Postgres schema is initialized"
PRIMARY=$(kubectl get pod -n "$NAMESPACE" -l cnpg.io/cluster=nanoclaw-pg,role=primary -o jsonpath='{.items[0].metadata.name}')
SCHEMA_TABLES=$(kubectl exec -n "$NAMESPACE" "$PRIMARY" -c postgres -- \
  psql -At -d nanoclaw -c "SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename IN ('messages_in','messages_out','sessions','heartbeats','processing_acks');")
[[ "$SCHEMA_TABLES" == "5" ]] || fail "expected 5 core tables in public schema, got '$SCHEMA_TABLES'"
log "  ✓ 5/5 core tables present"

log "verifying NOTIFY trigger present"
TRIG=$(kubectl exec -n "$NAMESPACE" "$PRIMARY" -c postgres -- \
  psql -At -d nanoclaw -c "SELECT count(*) FROM pg_trigger WHERE tgname='trg_notify_inbound_wake';")
[[ "$TRIG" == "1" ]] || fail "expected NOTIFY trigger 'trg_notify_inbound_wake' on messages_in, got count='$TRIG'"
log "  ✓ NOTIFY trigger present"

# ────────────────────────────── apply example CRs ──────────────────────────────

log "applying example NanoAgent + MessagingGroup + Wiring"
kubectl apply -n "$NAMESPACE" -f "${EXAMPLES_DIR}/agent-pr-worker.yaml"

# Wait for controller reconciliation. The controller stamps a
# SandboxTemplate named `ncl-<nanoagent-name>` and copies labels.
log "waiting for SandboxTemplate ncl-pr-worker"
for i in $(seq 1 30); do
  if kubectl get sandboxtemplate -n "$NAMESPACE" ncl-pr-worker >/dev/null 2>&1; then
    log "  ✓ SandboxTemplate ncl-pr-worker exists"
    break
  fi
  [[ $i -eq 30 ]] && fail "SandboxTemplate ncl-pr-worker not created within 60s"
  sleep 2
done

# Verify NetworkPolicy was stamped
log "verifying NetworkPolicy ncl-pr-worker"
kubectl get networkpolicy -n "$NAMESPACE" ncl-pr-worker >/dev/null 2>&1 \
  || fail "NetworkPolicy ncl-pr-worker not created"
log "  ✓ NetworkPolicy ncl-pr-worker exists"

# WarmPool was requested (spec.warmPool.replicas=1)
log "verifying SandboxWarmPool ncl-pr-worker"
kubectl get sandboxwarmpool -n "$NAMESPACE" ncl-pr-worker >/dev/null 2>&1 \
  || fail "SandboxWarmPool ncl-pr-worker not created"
log "  ✓ SandboxWarmPool ncl-pr-worker exists"

# ────────────────────────────── apply NanoSession ──────────────────────────────

log "applying a NanoSession"
cat <<YAML | kubectl apply -n "$NAMESPACE" -f -
apiVersion: nanoclaw.io/v1alpha1
kind: NanoSession
metadata:
  name: e2e-test-session
spec:
  agentRef: pr-worker
  messagingGroupRef: pr-factory-discord
  threadId: ""
YAML

log "waiting for SandboxClaim ncl-e2e-test-session"
for i in $(seq 1 30); do
  if kubectl get sandboxclaim -n "$NAMESPACE" ncl-e2e-test-session >/dev/null 2>&1; then
    log "  ✓ SandboxClaim ncl-e2e-test-session exists"
    break
  fi
  [[ $i -eq 30 ]] && fail "SandboxClaim ncl-e2e-test-session not created within 60s"
  sleep 2
done

# ────────────────────────────── summary ──────────────────────────────

log "─────────────────────────────────────────"
log "E2E PASS:"
log "  • kind cluster + CNPG + agent-sandbox installed"
log "  • NanoClaw chart deployed (host, controller, OneCLI, CNPG cluster)"
log "  • Postgres schema initialized via CNPG post-init"
log "  • NOTIFY trigger present on messages_in"
log "  • Controller reconciles NanoAgent → SandboxTemplate + NetworkPolicy + WarmPool"
log "  • Controller reconciles NanoSession → SandboxClaim"
log "─────────────────────────────────────────"
log ""
log "Not yet covered (waiting on host/container PG wire-up):"
log "  • End-to-end message round-trip (inject inbound → assert outbound)"
log "  • LISTEN/NOTIFY wake latency"
log "  • Heartbeat-driven stuck-container reaping"
