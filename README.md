# Zero Dark Games — I Giochi del Buio

App di gioco per il deathmatch a coppie della Zero Dark Team. Specifica completa in [ZERO-DARK-GAMES.md](ZERO-DARK-GAMES.md).

| Pagina | Chi | Indirizzo |
| --- | --- | --- |
| PWA dei Legati (coppie) | giocatori, da smartphone | `/` |
| Regia (utente MASTER) | organizzazione | `/regia` |
| La Soglia (validazione) | validatori o regia | `/soglia` |
| Tabellone (maxischermo al Cuore) | regia | `/tabellone?g=<id>` |
| Iscrizione | giocatori | `/iscrizione` |
| Regolamento (book) | tutti | `/regolamento.html` |

## Avvio con Docker

```bash
cp .env.example .env        # poi cambia almeno MASTER_PASSWORD
docker compose up -d --build
```

Apri <http://localhost:8090/regia> ed entra con `MASTER_USER` / `MASTER_PASSWORD` del file `.env`.
I dati (SQLite) restano nel volume `zdg-data` anche dopo aggiornamenti e riavvii.

Comandi utili:

```bash
docker compose logs -f zdg                       # log
docker compose up -d --build                     # aggiornare dopo una modifica
docker compose run --rm -v ./app/test:/app/test zdg npm test   # test dei criteri di accettazione
```

## Provare il gioco in pochi minuti

In **Impostazioni → Crea partita di prova** (o dalla schermata di benvenuto) nasce una partita già preparata: giocatori finti in coppia, Sigilli, calendario, Parola e un dono a 60 minuti.
Poi in **Regia**: Segna pronta → Apri il cerchio → VIA, e con i pulsanti **+1 / +5 / +15 / +30 / +60 min** fai passare il tempo di gioco: vedi tregua → caccia, tradimenti, doni, ultima mezz'ora e fine.
L'avanzamento del tempo esiste solo nelle partite di prova.

Per giocare come coppia: **Apri app** sulla scheda della coppia (Iscrizioni e coppie) oppure il suo codice d'accesso da un telefono.
Il browser tiene una sola coppia alla volta: per più coppie sullo stesso PC usa finestre in incognito o profili diversi.

## Flusso di una partita

0. **Settori e Altari** (una volta sola): l'elenco parte dai 12 Settori della specifica; puoi aggiungerne, modificarli (nome, articolo, elemento, motto, nome dell'Altare personalizzato, ordine) ed eliminarli. Un Settore assegnato a una coppia di una partita non terminata non si elimina; uno usato solo in partite finite viene archiviato e si può ripristinare.
1. **Impostazioni**: crea la partita (nome, data, canale radio, parametri).
2. **Iscrizioni e coppie**: dal modulo `/iscrizione` ci si candida per una delle tre strade, presentate come sfide:
   - **I Legati** (coppia): due persone che rappresenteranno un Settore;
   - **Il Temerario Solitario**: da solo, verrà accoppiato a caso con un altro temerario;
   - **Gli Eletti del Consiglio**: funzioni logistiche e difensive del gioco.
   Ogni candidatura resta **da approvare**: in regia la accetti o la rifiuti. Il Settore (e il suo Altare) lo assegna sempre il Consiglio.
   Poi formi le coppie (selezione manuale, "Accoppia come richiesto" o "Accoppia automaticamente"); i candidati agli Eletti accettati entrano subito nel gruppo.
   Puoi anche aggiungere persone a mano (già accettate) e spostare chiunque tra gli Eletti.
3. **Sigilli e tradimenti**: genera i Sigilli; si estraggono i mai rivelati e si calcola il calendario (sezione 7.1), modificabile fino al via.
4. **Altari e Parola**: scrivi la Parola, che viene divisa tra gli Altari; poi stampa i cartelli A4 con il QR.
5. **Doni** (facoltativo): finestre armamenti a orario o da lanciare a mano.
6. **Stampa credenziali**: un QR di accesso e un codice per coppia.
7. **Regia**: Segna pronta → Apri il cerchio (le coppie vedono il Sigillo) → **VIA!** Da qui il motore gestisce da solo tregua, caccia, rivelazioni, doni, ultima mezz'ora e fine; puoi sospendere, riprendere, rivelare a mano, posticipare o saltare.
8. **La Soglia**: il validatore sceglie la coppia e registra l'esito; vittoria e podio partono in automatico.

### I simulacri sfocati

Ogni segreto non ancora svelato occupa già il suo posto, ma come **simulacro fortemente sfocato**: caratteri casuali generati nel telefono, senza alcun legame con il codice vero, che non arriva al dispositivo prima del tempo.
Il Sigillo della coppia si svela all'apertura del cerchio, quelli degli altri Settori al momento del tradimento, i frammenti allo sblocco.
In regia i Sigilli veri sono sfocati e si leggono tenendo premuto; il prossimo tradimento ha un simulacro con il countdown, e sul tabellone negli ultimi 10 secondi i simulacri tremano.

## Eletti del Consiglio

Un gruppo per partita con un numero qualsiasi di persone e **un solo accesso** all'app (QR o codice, valido su tutti i loro telefoni, stampato insieme alle credenziali delle coppie).
Ricevono annunci, avvisi e messaggi della regia, hanno timer e regolamento; non hanno Sigillo, non usano gli Altari e non entrano in classifica.

## Avvisi e notifiche

In regia, pagina **Avvisi**: titolo, testo e destinatari (tutti, solo coppie, solo Eletti, una coppia).
Sul telefono l'avviso arriva come **notifica** (Android/Chrome, anche a schermo spento): toccandola si apre la pagina **Avvisi** dell'app.
Con l'app aperta compare subito, con vibrazione. Nell'app c'è un invito ad attivare le notifiche; la regia vede quanti dispositivi le hanno attive.
Le notifiche richiedono HTTPS (vedi sotto).

## Campo, mappe, doni, alleanze e scontri

- **Strumento di campo** (`/campo`, per Eletti e regia dal telefono): si scansiona il cartello di un Altare o di un Dono, il telefono dà la posizione GPS (o si tocca il punto sulla mappa), si scatta la foto e si conferma. Foto e coordinate arrivano in regia (**Mappa e campo**).
- **Mappe OpenTopoMap**: la regia vede Altari e doni (grigio = piazzato non comparso, colorato = comparso, barrato = preso); le coppie vedono Altari e doni comparsi più la propria posizione.
- **Posizioni GPS in mappa**: i telefoni delle coppie inviano la posizione solo a partita iniziata (dal VIA alla fine, anche in pausa), quelli degli Eletti già dalla preparazione. La regia vede tutti (coppie con il numero romano, Eletti con il colore della squadra), gli Eletti vedono solo gli Eletti. L'app avvisa chi è visibile; i browser inviano la posizione solo con l'app aperta. *Nota: la specifica iniziale escludeva il tracciamento delle coppie; è stato aggiunto su richiesta dell'organizzazione.*
- **Squadre di Eletti** (regia → Squadre Eletti): squadre con colore, membri, Altari e Doni da piazzare assegnati e incarichi liberi; ogni Eletto li trova nella scheda Incarichi dello strumento di campo.
- **Doni QR** (regia → Doni QR): catalogo di tipi modificabile, comparsa a mano / al piazzamento / a un minuto dal via, scadenza facoltativa, stampa dei cartelli. La prima coppia che scansiona il dono lo prende; tutti ricevono una notifica e il dono sparisce dalle mappe.
- **Scansione degli Altari a tempo**: vale i minuti impostati nella partita (default 15, 0 = sempre); poi va ripetuta. Se il Sigillo è già nel taccuino l'app lo propone, senza scriverlo.
- **Alleanze**: proposta e accettazione (massimo 3 coppie), rottura allo stesso modo; gli alleati ricevono i Sigilli gli uni degli altri.
- **Scontri**: VINTO / PERSO / PAREGGIO contro una coppia. "Perso" vale subito, "vinto" va confermato dallo sconfitto (se contesta decide la regia). I vincitori e i loro alleati ricevono i Sigilli di tutta la parte sconfitta; chi perde riceve in automatico il timer Veglia.

## Provare dai telefoni in Wi-Fi

In regia, **Impostazioni → Indirizzo per link e QR**: inserisci l'indirizzo del PC sulla rete Wi-Fi (es. `http://192.168.86.105:8090`), premi **Prova** e poi **Salva**.
Da quel momento cartelli degli Altari, credenziali, QR dell'iscrizione e link di accesso usano quell'indirizzo, e i telefoni sullo stesso Wi-Fi possono aprirli.
L'IP del PC si trova con `ipconfig` ("Indirizzo IPv4" della scheda Wi-Fi). Con DHCP può cambiare: se cambia, aggiorna l'impostazione e ristampa i QR.
L'impostazione ha la precedenza su `PUBLIC_URL` del file `.env`; con "Torna a…" si ripristina.

## Telefoni e HTTPS

Su `localhost` del PC funziona tutto. Dai telefoni in rete locale (`http://<IP-del-PC>:8090`) il gioco funziona, ma il browser **non** abilita installazione PWA, notifiche push, fotocamera in-app e schermo sempre acceso: questi richiedono **HTTPS**.
Per provarli sui telefoni prima della pubblicazione c'è un tunnel HTTPS temporaneo (Cloudflare, senza account):

```bash
docker compose --profile tunnel up -d
docker compose logs tunnel
```

Nei log trovi un indirizzo `https://….trycloudflare.com`: aprilo dai telefoni. **Finché il tunnel è acceso l'app è raggiungibile da Internet**; spegnilo con `docker compose --profile tunnel stop tunnel`. L'indirizzo cambia a ogni avvio, quindi non usarlo per stampare cartelli.
In produzione metti l'app dietro HTTPS e imposta `PUBLIC_URL` (es. `https://giochi.zerodarkteam.it`) **prima** di stampare cartelli e credenziali, perché il QR contiene quell'indirizzo.

Senza push, gli annunci arrivano comunque con vibrazione finché l'app è aperta; al ritorno della rete gli annunci persi si recuperano.

## Struttura

```
docker-compose.yml   .env.example
app/
  Dockerfile
  src/      server.js (API, pagine)  game.js (motore)  db.js (SQLite)  realtime.js (SSE + Web Push)  print.js (stampe A4)
  public/   index.html + js/app.js (PWA coppie)  regia.html + js/regia.js  soglia.html  tabellone.html  iscrizione.html  sw.js
  test/     engine.test.js (criteri di accettazione)
```

Stack: Node.js 24 senza framework frontend (nessuna build), Express 5, SQLite integrato (`node:sqlite`), Server-Sent Events, Web Push (chiavi VAPID generate al primo avvio e salvate nel database).

## Decisioni sulle domande aperte (sezione 14)

- I frammenti ricevuti a mano contano in classifica come quelli sbloccati.
- La Parola è una frase scritta dalla regia, divisa automaticamente tra gli Altari (ogni frammento resta modificabile).
- Alla Soglia il validatore sceglie la coppia dalla lista (niente QR personale).
- Le finestre armamenti possono essere sia a orario sia lanciate a mano.

## Pubblicazione automatica (GitHub Actions)

Il workflow [.github/workflows/deploy.yml](.github/workflows/deploy.yml) a ogni push su `main`:

1. esegue i test (se uno fallisce non si pubblica nulla);
2. costruisce l'immagine Docker e la carica su `ghcr.io/whiskas85/zerodarkgames` (`latest` e commit);
3. se `DEPLOY_ENABLED` è `true`, via SSH copia sul server [deploy/docker-compose.prod.yml](deploy/docker-compose.prod.yml), scrive il `.env` dai secrets, scarica la nuova immagine, riavvia il container e verifica che risponda. Facoltativamente aggiunge il sito a Caddy.

I dati restano nel volume `zdg-data` sul server: gli aggiornamenti non li toccano.

### Da configurare una volta

Solo tre secrets e il DNS: la procedura passo passo è in [deploy/CHIAVE-SSH.md](deploy/CHIAVE-SSH.md).

| Secret | Valore |
| --- | --- |
| `DEPLOY_SSH_KEY` | chiave privata dedicata (vedi procedura) |
| `DEPLOY_USER` | utente SSH sul server (che può usare `docker`) |
| `MASTER_PASSWORD` | password della regia in produzione |

Tutto il resto è già impostato nel workflow: server `209.227.239.117`, cartella `~/zerodarkgames`, porta locale `8090`, dominio `games.zerodarkteam.it`.
Senza i secrets il deploy viene saltato (i test e l'immagine girano lo stesso). Per spegnerlo: variabile `DEPLOY_ENABLED=false`.

Caddy viene rilevato da solo sul server (in un container o installato) e il sito viene aggiunto una volta: il workflow salva una copia del Caddyfile, valida la nuova configurazione e, se non è valida, ripristina la copia. Per disattivare questo passo: variabile `CADDY_AUTO=false`. Il blocco, se preferisci scriverlo a mano:

```
games.zerodarkteam.it {
	encode gzip
	reverse_proxy 127.0.0.1:8090   # oppure zero-dark-games:8080 se Caddy è in un container
}
```

Per pubblicare senza un nuovo commit: GitHub → Actions → "Test e pubblicazione" → Run workflow.
