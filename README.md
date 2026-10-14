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
