#!/usr/bin/env bash
# opusgrid-inspect.sh — read-only inspection of exactly the Docker metadata OpusHub's discovery
# reads, so its model/URL decisions can be checked against a real host before anyone trusts them.
#
#   ./scripts/opusgrid-inspect.sh                       # every container
#   ./scripts/opusgrid-inspect.sh jellyfin seerr        # substring filter on container names
#   OPUSHUB_URL=http://127.0.0.1:3000 ./scripts/opusgrid-inspect.sh
#       # …plus a diff against what OpusHub resolved from the same labels
#
# It runs `docker ps -a` and `docker inspect` and nothing else: no exec, no write API, no sudo, and
# no network access of its own beyond one optional GET of $OPUSHUB_URL/api/*.
#
# Why this exists: OpusHub derives existence and stacks from com.docker.compose.* labels, browser
# URLs from traefik.http.* labels, and falls back to published ports. If a host routes its apps
# some other way, that shows up on this one screen instead of being guessed at.
set -euo pipefail

FILTERS=("$@")
OPUSHUB_URL="${OPUSHUB_URL:-}"
TMP="${TMPDIR:-/tmp}/opusgrid-inspect.$$"
trap 'rm -f "$TMP".*' EXIT

if ! command -v docker >/dev/null 2>&1; then
  echo "docker CLI not on PATH — run this on the Docker host itself." >&2
  exit 2
fi
if ! docker version --format '{{.Server.Version}}' >/dev/null 2>&1; then
  echo "cannot reach the Docker daemon (socket permissions? DOCKER_HOST? OPUSHUB_DOCKER_SOCKET?)" >&2
  exit 2
fi

# `<no value>` is what a missing label prints as; keep the rest verbatim.
label() { docker inspect -f "{{ index .Config.Labels \"$1\" }}" "$2" 2>/dev/null | sed 's/^<no value>$/none/' || true; }
alllabels() { docker inspect -f '{{range $k, $v := .Config.Labels}}{{$k}}={{$v}}{{"\n"}}{{end}}' "$1" 2>/dev/null | sort || true; }

# The router labels OpusHub reads, and the hostnames among them that are actual addresses.
# Wildcards (Host(`*.example.com`)), patterns (HostRegexp) and HostSNI are matchers, not addresses:
# OpusHub refuses to build a URL out of one, so this script refuses too — that agreement is the point.
router_rules() {
  alllabels "$1" | awk -F= '$1 ~ /^traefik\.(http|tcp)\.routers\.[^.]+\.(rule|entrypoints|tls|service|middlewares)$/ {print}' > "$TMP.rules" || true
}

rule_hosts() {
  # every Host() form: Host(`a`), Host(`a`, `b`), Host("a"), Host(`a:8443`)
  grep -oE 'Host\([^)]*\)' "$TMP.rules" 2>/dev/null \
    | sed -E 's/^Host\(//; s/\)$//' \
    | tr ',' '\n' \
    | sed -E "s/[\`\"']//g; s/^ +//; s/ +$//; s/:[0-9]+$//" \
    | grep -vE '^[[:space:]]*$|[*?{}]' \
    | grep -viE '^[a-z0-9+-]+:[a-z0-9+-]+$' \
    | sort -u || true
}

selected() {
  for id in $(docker ps -aq); do
    name=$(docker inspect -f '{{.Name}}' "$id" 2>/dev/null | sed 's|^/||')
    if [ ${#FILTERS[@]} -eq 0 ]; then printf '%s\n' "$id"; continue; fi
    for f in "${FILTERS[@]}"; do
      case "$(printf '%s' "$name" | tr '[:upper:]' '[:lower:]')" in
        *"$(printf '%s' "$f" | tr '[:upper:]' '[:lower:]')"*) printf '%s\n' "$id"; break ;;
      esac
    done
  done
}

total=0; running=0; withcompose=0; withtraefik=0; withhosts=0; withpublished=0; noendpoint=0; wildcards=0

printf '\n\033[1mOpusHub discovery inspection\033[0m  ·  engine %s  ·  %s\n' \
  "$(docker version --format '{{.Server.Version}}')" "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"

for id in $(selected); do
  name=$(docker inspect -f '{{.Name}}' "$id" | sed 's|^/||')
  state=$(docker inspect -f '{{.State.Status}}' "$id")
  health=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}no HEALTHCHECK{{end}}' "$id")
  image=$(docker inspect -f '{{.Config.Image}}' "$id")
  restarts=$(docker inspect -f '{{.RestartCount}}' "$id")
  nets=$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$id" | tr -s ' ')
  published=$(docker inspect -f '{{range $p, $b := .NetworkSettings.Ports}}{{if $b}}{{range $b}}{{.HostIp}}:{{.HostPort}}->{{$p}} {{end}}{{end}}{{end}}' "$id" | tr -s ' ')
  exposed=$(docker inspect -f '{{range $p, $b := .NetworkSettings.Ports}}{{if not $b}}{{$p}} {{end}}{{end}}' "$id" | tr -s ' ')

  total=$((total + 1)); [ "$state" = running ] && running=$((running + 1))
  project=$(label com.docker.compose.project "$id"); [ "$project" != none ] && withcompose=$((withcompose + 1))
  [ -n "$(alllabels "$id" | grep '^traefik\.' || true)" ] && withtraefik=$((withtraefik + 1))

  printf '\n\033[1m── %s\033[0m  (%s…)  %s/%s\n' "$name" "${id:0:12}" "$state" "$health"
  printf '   image        %s\n' "$image"
  printf '   restarts     %s\n' "$restarts"
  printf '   compose      project=%s  service=%s  number=%s\n' \
    "$project" "$(label com.docker.compose.service "$id")" "$(label com.docker.compose.container-number "$id")"
  printf '   compose dir  %s\n' "$(label com.docker.compose.project.working_dir "$id")"
  printf '   compose file %s\n' "$(label com.docker.compose.project.config_files "$id")"
  printf '   networks     %s\n' "${nets:-none}"
  if [ -n "${published// /}" ]; then
    printf '   published    %s\n' "$published"; withpublished=$((withpublished + 1))
  else
    printf '   published    none%s\n' "${exposed:+  (exposes $exposed inside the network — not a browser URL)}"
  fi

  alllabels "$id" | grep -E '^(traefik\.|opushub\.|homepage\.)' | grep -v '^traefik\.http\.(services|middlewares)\.' | sed 's/^/     │ /' || true

  enabled=$(alllabels "$id" | grep -E '^traefik\.enable=' | tail -1 | cut -d= -f2 || true)
  router_rules "$id"
  hosts=$(rule_hosts "$id")
  if [ "$enabled" = "false" ]; then
    hosts=""
    printf '   traefik      enable=false → OpusHub ignores every router label here and uses the published port\n'
  fi
  if grep -qE 'Host\(`\*|HostRegexp|HostSNI' "$TMP.rules" 2>/dev/null; then
    wildcards=$((wildcards + 1))
    printf '   rule patterns  wildcards/regexes here — OpusHub refuses to turn those into a URL\n'
  fi
  if [ -n "$hosts" ]; then
    withhosts=$((withhosts + 1))
    printf '   rule hosts     %s\n' "$(printf '%s\n' "$hosts" | paste -sd' ' -)"
    printf '   → URL OpusHub resolves   http(s)://<first rule host>  (no port: the proxy owns it)\n'
  elif [ -n "${published// /}" ]; then
    printf '   rule hosts     none → falls back to the published port + the host address from settings\n'
  else
    noendpoint=$((noendpoint + 1))
    printf '   rule hosts     none, nothing published → listed with url: null\n'
  fi
  [ "$state" != running ] && printf '   note           stopped: still discovered, listed, no URL expected\n'
done

printf '\n\033[1m── what this host actually does\033[0m\n'
printf '   containers                       %s (running %s)\n' "$total" "$running"
printf '   with com.docker.compose.project    %s  ← stack membership OpusHub can see\n' "$withcompose"
printf '   with any traefik.* label           %s\n' "$withtraefik"
printf '   with a concrete Host() in a rule   %s  ← label-derived URLs are reliable here only if this ≈ the line above\n' "$withhosts"
printf '   relying on wildcards/regexes only  %s\n' "$wildcards"
printf '   with published ports               %s  ← the fallback tier\n' "$withpublished"
printf '   with no browser endpoint at all    %s  ← listed, url: null\n' "$noendpoint"

if [ -n "$OPUSHUB_URL" ]; then
  printf '\n\033[1m── what OpusHub says (%s)\033[0m\n' "$OPUSHUB_URL"
  if command -v curl >/dev/null 2>&1 \
    && curl -fsS "$OPUSHUB_URL/api/services" -o "$TMP.services" \
    && curl -fsS "$OPUSHUB_URL/api/discovery" -o "$TMP.discovery"; then
    if command -v python3 >/dev/null 2>&1; then
      python3 - "$TMP" <<'PY'
import json, sys
base = sys.argv[1]
svc = json.load(open(f"{base}.services")); disc = json.load(open(f"{base}.discovery"))
rows = svc.get("services") or [s for g in svc.get("groups", []) for s in g.get("services", [])]
st = svc.get("stats", {})
eng = disc.get("engine", {}); url = disc.get("urlDiscovery", {})
print(f"   engine {eng.get('state')} · {eng.get('containers')} containers ({eng.get('running')} running)"
      f" · live={svc.get('live')}")
print(f"   url sources {url.get('sources')} · with url {url.get('withUrl')} · without {url.get('withoutUrl')}")
print(f"   host address {url.get('hostAddress') or 'unset'} (from {url.get('hostAddressSource')})"
      f" · entrypoints {url.get('entrypointPorts') or 'default'}")
print(f"   overlays: {disc.get('overlays',{})}")
print(f"\n   {'container':<34} {'state':<10} {'source':<15} url")
for s in sorted(rows, key=lambda x: x["name"]):
    print(f"   {s['name'][:33]:<34} {s['container']['state']:<10} {s.get('urlSource','?'):<15} {s.get('url') or '—'}")
un = svc.get("unmatched") or []
print("\n   config overlays that bind to no container (must be 0 unless you removed something):")
for u in un:
    print(f"     ! {u.get('name')} — {u.get('reason')}")
if not un:
    print("     none")
PY
    else
      echo "   python3 missing; raw payloads left in $TMP.services / $TMP.discovery"
    fi
  else
    echo "   could not reach $OPUSHUB_URL — is OpusHub running there? (override with OPUSHUB_URL=…)"
  fi
fi

printf '\n   Read-only inspection: nothing on this host was created, changed, stopped or restarted.\n'
