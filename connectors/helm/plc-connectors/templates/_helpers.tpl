{{- define "plc-connectors.fullname" -}}
{{- printf "%s" .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}