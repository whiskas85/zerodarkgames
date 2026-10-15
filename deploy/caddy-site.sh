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
SITES=""
UP=""
VALIDATE=""
RELOAD=""
FIND=""

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
  # Un file per sito (import /etc/caddy/siti/*.caddy), come fa il gestionale: si scrive lì, non nel Caddyfile.
  SITES=$($DOCKER inspect -f '{{range .Mounts}}{{if eq .Destination "/etc/caddy/siti"}}{{.Source}}{{end}}{{end}}' "$CT")
  # Il sito si cerca in tutto ciò che Caddy legge (Caddyfile e file importati).
  FIND="$DOCKER exec $CT grep -rqsE"
  FIND_IN=/etc/caddy
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
  FIND="grep -rqsE"
  FIND_IN=/etc/caddy
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
PATTERN="^[[:space:]]*(https?://)?$DOMAIN([[:space:],{]|$)"
if grep -qE "$PATTERN" "$FILE" || { [ -n "$SITES" ] && grep -rqsE "$PATTERN" "$SITES"; } || sh -c "$FIND '$PATTERN' $FIND_IN" 2>/dev/null; then
  echo "Il sito $DOMAIN è già configurato in Caddy"
  exit 0
fi

BLOCK=$(printf '# Zero Dark Games (aggiunto dal workflow di pubblicazione)\n%s {\n\tencode gzip\n\treverse_proxy %s\n}\n' "$DOMAIN" "$UP")
if [ -n "$SITES" ] && grep -qE '^[[:space:]]*import[[:space:]]+/etc/caddy/siti/' "$FILE"; then
  # Un file tutto nostro nella cartella dei siti: niente da ripristinare nel Caddyfile se qualcosa va storto.
  TARGET="$SITES/zerodarkgames.caddy"
  if ! { [ -w "$SITES" ] || [ -w "$TARGET" ]; }; then
    warn "La cartella $SITES non è scrivibile da $(whoami): crea $TARGET con il sito $DOMAIN → $UP"
    exit 0
  fi
  printf '%s\n' "$BLOCK" > "$TARGET"
  if sh -c "$VALIDATE" >/dev/null 2>&1 && sh -c "$RELOAD"; then
    echo "Aggiunto a Caddy: $DOMAIN → $UP ($TARGET)"
  else
    sh -c "$VALIDATE" 2>&1 | tail -5 || true
    rm -f "$TARGET"
    sh -c "$RELOAD" >/dev/null 2>&1 || true
    echo "::error::Configurazione di Caddy non valida: tolto $TARGET"
    exit 1
  fi
  exit 0
fi
if [ ! -w "$FILE" ]; then
  warn "Il Caddyfile $FILE non è scrivibile da $(whoami): aggiungi a mano il sito $DOMAIN → $UP"
  exit 0
fi

cp "$FILE" "$FILE.bak-zdg"
printf '\n%s\n' "$BLOCK" >> "$FILE"
if sh -c "$VALIDATE" >/dev/null 2>&1 && sh -c "$RELOAD"; then
  echo "Aggiunto a Caddy: $DOMAIN → $UP ($FILE)"
else
  sh -c "$VALIDATE" 2>&1 | tail -5 || true
  cp "$FILE.bak-zdg" "$FILE"
  sh -c "$RELOAD" >/dev/null 2>&1 || true
  echo "::error::Configurazione di Caddy non valida: ripristinato il Caddyfile originale"
  exit 1
fi
