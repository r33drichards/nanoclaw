{{/*
Standard label set used across NanoClaw resources.
*/}}
{{- define "nanoclaw.labels" -}}
app.kubernetes.io/name: nanoclaw
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{- end -}}

{{- define "nanoclaw.host.selectorLabels" -}}
app.kubernetes.io/name: nanoclaw
app.kubernetes.io/component: host
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "nanoclaw.controller.selectorLabels" -}}
app.kubernetes.io/name: nanoclaw
app.kubernetes.io/component: controller
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "nanoclaw.onecli.selectorLabels" -}}
app.kubernetes.io/name: nanoclaw
app.kubernetes.io/component: onecli
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/*
Connection string parts for the Postgres cluster. When postgres.external
is set the chart uses those values; otherwise it points at the CNPG
Cluster's read-write Service.
*/}}
{{- define "nanoclaw.postgres.host" -}}
{{- if .Values.postgres.external.host -}}
{{- .Values.postgres.external.host -}}
{{- else -}}
{{- .Values.postgres.cluster.name }}-rw
{{- end -}}
{{- end -}}

{{- define "nanoclaw.postgres.port" -}}
{{- default 5432 .Values.postgres.external.port -}}
{{- end -}}

{{- define "nanoclaw.postgres.database" -}}
{{- if .Values.postgres.external.database -}}
{{- .Values.postgres.external.database -}}
{{- else -}}
{{- .Values.postgres.cluster.bootstrap.initdb.database -}}
{{- end -}}
{{- end -}}
