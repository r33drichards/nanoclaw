// NanoClaw controller — reconciles NanoAgent / NanoMessagingGroup /
// NanoWiring / NanoSession into agent-sandbox primitives (SandboxTemplate,
// SandboxWarmPool, SandboxClaim) plus per-agent NetworkPolicies.
//
// This is the entry point scaffold. The per-CRD reconcilers live in
// internal/controller/. They are stubs at this point — the reconcile
// methods log and return without doing work. Subsequent work fills them
// in.
package main

import (
	"flag"
	"net/http"
	"os"

	"k8s.io/apimachinery/pkg/runtime"
	utilruntime "k8s.io/apimachinery/pkg/util/runtime"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"

	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/log/zap"
	metricsserver "sigs.k8s.io/controller-runtime/pkg/metrics/server"

	nanoctrl "github.com/r33drichards/nanoclaw/controller/internal/controller"
)

var scheme = runtime.NewScheme()

func init() {
	utilruntime.Must(clientgoscheme.AddToScheme(scheme))
	// CRD groups (nanoclaw.io and agent-sandbox) get registered as
	// unstructured types until generated typed clients land. The
	// reconcilers below use dynamic clients for now.
}

func main() {
	var (
		leaderElect            bool
		namespace              string
		defaultAgentImage      string
		oneCliService          string
		postgresHost           string
		networkPolicyManaged   bool
		allowEgressOneCli      bool
		allowEgressPostgres    bool
		metricsAddr            string
		probeAddr              string
	)

	flag.BoolVar(&leaderElect, "leader-elect", false,
		"Enable leader election for controller manager.")
	flag.StringVar(&namespace, "namespace", "",
		"Restrict the controller to a single namespace (empty = cluster-wide).")
	flag.StringVar(&defaultAgentImage, "default-agent-image", "",
		"Default image for Sandbox pods when a NanoAgent omits spec.imageTag.")
	flag.StringVar(&oneCliService, "onecli-service", "",
		"In-cluster Service name of the OneCLI gateway.")
	flag.StringVar(&postgresHost, "postgres-host", "",
		"Postgres host the agent connects to (CNPG rw service or external).")
	flag.BoolVar(&networkPolicyManaged, "network-policy-managed", true,
		"Stamp a NetworkPolicy onto each per-agent SandboxTemplate.")
	flag.BoolVar(&allowEgressOneCli, "allow-egress-onecli", true,
		"Allow Sandbox → OneCLI egress in the managed NetworkPolicy.")
	flag.BoolVar(&allowEgressPostgres, "allow-egress-postgres", true,
		"Allow Sandbox → Postgres egress in the managed NetworkPolicy.")
	flag.StringVar(&metricsAddr, "metrics-bind-address", ":8080",
		"The address the metric endpoint binds to.")
	flag.StringVar(&probeAddr, "health-probe-bind-address", ":8081",
		"The address the probe endpoint binds to.")

	opts := zap.Options{Development: true}
	opts.BindFlags(flag.CommandLine)
	flag.Parse()

	ctrl.SetLogger(zap.New(zap.UseFlagOptions(&opts)))
	setupLog := ctrl.Log.WithName("setup")

	mgr, err := ctrl.NewManager(ctrl.GetConfigOrDie(), ctrl.Options{
		Scheme:                 scheme,
		LeaderElection:         leaderElect,
		LeaderElectionID:       "nanoclaw-controller.nanoclaw.io",
		HealthProbeBindAddress: probeAddr,
		Metrics:                metricsserver.Options{BindAddress: metricsAddr},
	})
	if err != nil {
		setupLog.Error(err, "unable to start manager")
		os.Exit(1)
	}

	cfg := nanoctrl.Config{
		Namespace:             namespace,
		DefaultAgentImage:     defaultAgentImage,
		OneCliService:         oneCliService,
		PostgresHost:          postgresHost,
		NetworkPolicyManaged:  networkPolicyManaged,
		AllowEgressOneCli:     allowEgressOneCli,
		AllowEgressPostgres:   allowEgressPostgres,
	}

	if err := nanoctrl.SetupWithManager(mgr, cfg); err != nil {
		setupLog.Error(err, "unable to set up reconcilers")
		os.Exit(1)
	}

	if err := mgr.AddHealthzCheck("healthz", healthAlwaysOK); err != nil {
		setupLog.Error(err, "unable to set up health check")
		os.Exit(1)
	}
	if err := mgr.AddReadyzCheck("readyz", healthAlwaysOK); err != nil {
		setupLog.Error(err, "unable to set up ready check")
		os.Exit(1)
	}

	setupLog.Info("starting manager",
		"namespace", namespace,
		"defaultAgentImage", defaultAgentImage,
		"oneCliService", oneCliService,
	)
	if err := mgr.Start(ctrl.SetupSignalHandler()); err != nil {
		setupLog.Error(err, "problem running manager")
		os.Exit(1)
	}
}

// healthAlwaysOK is a placeholder probe — replace with actual readiness
// checks once the reconcilers do real work.
func healthAlwaysOK(_ *http.Request) error { return nil }
