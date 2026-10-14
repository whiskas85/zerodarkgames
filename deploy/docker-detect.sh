#!/bin/sh
# Rileva come usare Docker sul server: "docker" o "sudo -n docker", "docker compose" o "docker-compose".
# Stampa: DOCKER=...|COMPOSE=...  oppure una diagnosi su stderr ed esce con errore.
D=""
if docker info >/dev/null 2>&1; then D="docker"
elif sudo -n docker info >/dev/null 2>&1; then D="sudo -n docker"
fi
C=""
if [ -n "$D" ]; then
  if $D compose version >/dev/null 2>&1; then C="$D compose"
  elif command -v docker-compose >/dev/null 2>&1; then
    case "$D" in sudo*) C="sudo -n docker-compose" ;; *) C="docker-compose" ;; esac
    $C version >/dev/null 2>&1 || C=""
  fi
fi
if [ -z "$D" ] || [ -z "$C" ]; then
  {
    echo "utente: $(id)"
    echo "docker: $(command -v docker || echo 'non trovato')"
    echo "docker info: $(docker info 2>&1 | head -1)"
    echo "sudo senza password: $(sudo -n true 2>&1 && echo si || echo no)"
    echo "docker compose: $(docker compose version 2>&1 | head -1)"
    echo "docker-compose: $(command -v docker-compose || echo 'non trovato')"
  } >&2
  exit 1
fi
echo "DOCKER=$D|COMPOSE=$C"
