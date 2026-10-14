#!/bin/sh
# Aggiunge UNA SOLA VOLTA il sito di Zero Dark Games a Caddy, rilevando come è installato sul server.
# Sicurezze: copia del Caddyfile, validazione prima della ricarica, ripristino della copia in caso di errore.
# Uso: caddy-site.sh <dominio> <porta-locale> <cartella-app>
set -eu
DOMAIN="$1"
PORT="$2"
DIR="$3"
APP=zero-dark-games
DOCKER="${DOCKER:-docker}"

warn() { echo "::warning::$*"; }

FILE=""
UP=""
VALIDATE=""
RELOAD=""

CT=$($DOCKER ps --format '{{.Names}} {{.Image}}' | awk 'tolower($2) ~ /caddy/ { print $1; exit }')
if [ -n "$CT" ]; then
  IMAGE=$($DOCKER inspect -f '{{.Config.Image}}' "$CT")
  case "$IMAGE" in
    *docker-proxy*)
      warn "Caddy in modalità docker-proxy ($IMAGE): aggiungi le etichette caddy=$DOMAIN e caddy.reverse_proxy={{upstreams 8080}} al container $APP"
      exit 0 ;;
  esac
  # Caddyfile montato nel container (file singolo o cartella /etc/caddy)
  FILE=$($DOCKER inspect -f '{{range .Mounts}}{{if eq .Destination "/etc/caddy/Caddyfile"}}{{.Source}}{{end}}{{end}}' "$CT")
  if [ -z "$FILE" ]; then
    D=$($DOCKER inspect -f '{{range .Mounts}}{{if eq .Destination "/etc/caddy"}}{{.Source}}{{end}}{{end}}' "$CT")
    [ -n "$D" ] && FILE="$D/Caddyfile"
  fi
  NETMODE=$($DOCKER inspect -f '{{.HostConfig.NetworkMode}}' "$CT")
  if [ "$NETMODE" = "host" ]; then
    UP="127.0.0.1:$PORT"
  else
    # Caddy in una rete Docker: l'app entra nella stessa rete (ricordata per i prossimi rilasci).
    NET=$($DOCKER inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{"\n"}}{{end}}' "$CT" | grep -v '^$' | head -1)
    echo "$NET" > "$DIR/.proxy-network"
    $DOCKER network connect "$NET" "$APP" 2>/dev/null || true
    UP="$APP:8080"
  fi
  VALIDATE="$DOCKER exec $CT caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile"
  RELOAD="$DOCKER exec $CT caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile"
elif command -v caddy >/dev/null 2>&1 && [ -f /etc/caddy/Caddyfile ]; then
  FILE=/etc/caddy/Caddyfile
  UP="127.0.0.1:$PORT"
  VALIDATE="caddy validate --config $FILE --adapter caddyfile"
  RELOAD="sudo -n systemctl reload caddy 2>/dev/null || caddy reload --config $FILE --adapter caddyfile"
else
  warn "Caddy non trovato sul server: aggiungi a mano il sito $DOMAIN → 127.0.0.1:$PORT"
  exit 0
fi

if [ -z "$FILE" ] || [ ! -f "$FILE" ]; then
  warn "Caddyfile non trovato (container $CT): aggiungi a mano il sito $DOMAIN → $UP"
  exit 0
fi
if grep -qE "^[[:space:]]*(https?://)?$DOMAIN([[:space:],{]|$)" "$FILE"; then
  echo "Il sito $DOMAIN è già nel Caddyfile ($FILE)"
  exit 0
fi
if [ ! -w "$FILE" ]; then
  warn "Il Caddyfile $FILE non è scrivibile da $(whoami): aggiungi a mano il sito $DOMAIN → $UP"
  exit 0
fi

cp "$FILE" "$FILE.bak-zdg"
printf '\n# Zero Dark Games (aggiunto dal workflow di pubblicazione)\n%s {\n\tencode gzip\n\treverse_proxy %s\n}\n' "$DOMAIN" "$UP" >> "$FILE"
if sh -c "$VALIDATE" >/dev/null 2>&1 && sh -c "$RELOAD"; then
  echo "Aggiunto a Caddy: $DOMAIN → $UP ($FILE)"
else
  cp "$FILE.bak-zdg" "$FILE"
  sh -c "$RELOAD" >/dev/null 2>&1 || true
  echo "::error::Configurazione di Caddy non valida: ripristinato il Caddyfile originale"
  exit 1
fi
