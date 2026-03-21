{{/*
Expand the name of the chart.
*/}}
{{- define "ct-gate.name" -}}
{{- .Chart.Name | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "ct-gate.labels" -}}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Selector labels for a component
Usage: include "ct-gate.selectorLabels" (dict "component" "backend" "Release" .Release)
*/}}
{{- define "ct-gate.selectorLabels" -}}
app.kubernetes.io/name: {{ .component }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Postgres password: use existingSecret or fall back to values
*/}}
{{- define "ct-gate.postgresPassword" -}}
{{- if .Values.postgres.existingSecret -}}
secretKeyRef:
  name: {{ .Values.postgres.existingSecret }}
  key: postgres-password
{{- else -}}
secretKeyRef:
  name: {{ .Release.Name }}-postgres-secret
  key: postgres-password
{{- end -}}
{{- end }}

{{/*
Database URL built from postgres values
*/}}
{{- define "ct-gate.databaseUrl" -}}
postgresql://{{ .Values.postgres.user }}:$(POSTGRES_PASSWORD)@{{ .Release.Name }}-postgres:5432/{{ .Values.postgres.database }}
{{- end }}
