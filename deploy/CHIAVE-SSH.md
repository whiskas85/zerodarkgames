# Chiave SSH per la pubblicazione automatica

GitHub Actions pubblica l'app sul server `209.227.239.117` collegandosi via SSH.
Serve una **chiave dedicata** (non la tua personale): se un giorno va revocata, basta toglierla dal server.

I comandi sono per **PowerShell su Windows**. Sostituisci `UTENTE` con l'utente con cui entri oggi sul server (ad esempio `root`).

## 1. Crea la chiave (sul tuo PC)

```powershell
ssh-keygen -t ed25519 -C "github-actions-zerodarkgames" -f "$env:USERPROFILE\.ssh\zdg-deploy"
```

Quando chiede la *passphrase* premi **Invio due volte** (vuota): GitHub deve poterla usare senza che nessuno la digiti.
Nascono due file: `zdg-deploy` (privata, va solo su GitHub) e `zdg-deploy.pub` (pubblica, va sul server).

## 2. Autorizza la chiave sul server

Usa l'accesso che hai già (qui la chiave `zd-server`; se entri con un'altra chiave o con la password, togli `-i ...`):

```powershell
Get-Content "$env:USERPROFILE\.ssh\zdg-deploy.pub" | ssh -i "$env:USERPROFILE\.ssh\zd-server" UTENTE@209.227.239.117 "mkdir -p ~/.ssh && chmod 700 ~/.ssh && tr -d '\r' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"
```

## 3. Prova la chiave

```powershell
ssh -i "$env:USERPROFILE\.ssh\zdg-deploy" UTENTE@209.227.239.117 "docker ps --format '{{.Names}}'"
```

Deve elencare i container del server senza chiedere password.
Se risponde *permission denied* su docker, l'utente non è nel gruppo docker: sul server esegui `sudo usermod -aG docker UTENTE`, esci e rientra.

## 4. Copia la chiave privata

```powershell
Get-Content "$env:USERPROFILE\.ssh\zdg-deploy" -Raw | Set-Clipboard
```

## 5. Inseriscila su GitHub

Apri <https://github.com/whiskas85/zerodarkgames/settings/secrets/actions> → **New repository secret** e crea:

| Nome | Valore |
| --- | --- |
| `DEPLOY_SSH_KEY` | incolla (tutto, comprese le righe `-----BEGIN…` e `-----END…`) |
| `DEPLOY_USER` | `UTENTE` (lo stesso dei passi 2 e 3) |
| `MASTER_PASSWORD` | la password della regia in produzione (utente `master`) |

## In alternativa: tutto da una sessione sul server Linux

Se sei già collegato al server, i passi 1–4 diventano:

```bash
ssh-keygen -t ed25519 -C "github-actions-zerodarkgames" -f ~/.ssh/zdg-deploy -N ""
cat ~/.ssh/zdg-deploy.pub >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys
docker ps --format '{{.Names}}'   # se "permission denied": sudo usermod -aG docker $USER, poi rientra
whoami                            # questo è il valore di DEPLOY_USER
cat ~/.ssh/zdg-deploy             # copia tutto nel secret DEPLOY_SSH_KEY
```

## 6. DNS

Nel pannello del dominio `zerodarkteam.it` aggiungi il record **A** `games` → `209.227.239.117`.

## Poi

Il prossimo push su `main` pubblica tutto da solo; oppure GitHub → **Actions** → *Test e pubblicazione* → **Run workflow**.
Il workflow controlla Docker sul server, avvia l'app, aggiunge il sito a Caddy (con copia e ripristino del Caddyfile se qualcosa non va) e verifica `https://games.zerodarkteam.it`.

Per revocare l'accesso: togli la riga `github-actions-zerodarkgames` da `~/.ssh/authorized_keys` sul server e cancella il secret.
