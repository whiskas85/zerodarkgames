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

Apri <http://localhost:8090> ed entra con `MASTER_USER` / `MASTER_PASSWORD` del file `.env`: si finisce in regia.
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
2. **Account e iscrizioni**: ognuno crea il proprio **account** (username e password) dal modulo `/iscrizione`, oppure entra con l'account del gestionale della squadra (vedi [Accedi con Zero Dark Ops](#accedi-con-zero-dark-ops)); l'account resta valido anche per le partite successive. Dall'app (`/`) si entra con username e password: i **master** finiscono in automatico in regia, i validatori alla Soglia, i giocatori nella loro app (coppia, anteprima o Eletti). Nessuno può registrarsi come master: i master li crea un master in **Impostazioni**. QR e codici d'accesso stampati restano come scorciatoia per il giorno dell'evento. Se un giocatore dimentica la password, la regia ne imposta una nuova (pulsante **Password** accanto al nome).
   Con l'account ci si candida per una delle tre strade, presentate come sfide:
   - **I Legati** (coppia): due persone che rappresenteranno un Settore. Ognuno ha il suo account: il primo crea la coppia e riceve un **codice coppia**, il compagno lo inserisce scegliendo "I Legati";
   - **Il Temerario Solitario**: da solo, verrà accoppiato a caso con un altro temerario;
   - **Gli Eletti del Consiglio**: funzioni logistiche e difensive del gioco.
   Per ogni persona si chiede anche il **team di softair di appartenenza** (obbligatorio, si può scrivere "nessuno").
   Ogni candidatura resta **da approvare**: coppie e temerari in **Iscrizioni e coppie**, candidati agli Eletti in **Squadre Eletti** (accettandoli scegli subito la squadra). Il Settore (e il suo Altare) lo assegna sempre il Consiglio.
   Poi formi le coppie (selezione manuale, "Accoppia come richiesto" o "Accoppia automaticamente").
   Puoi anche aggiungere persone a mano (già accettate) e spostare chiunque tra gli Eletti.
3. **Sigilli e tradimenti**: genera i Sigilli; si estraggono i mai rivelati e si calcola il calendario (sezione 7.1), modificabile fino al via.
4. **Altari e Parola**: scrivi la Parola, che viene divisa tra gli Altari; poi stampa i cartelli A4 con il QR.
5. **Armamenti** (facoltativo): finestre con apertura (minuto dal via, orario o a mano) e durata, scelte sulla timeline del torneo.
6. **Stampa credenziali**: un QR di accesso e un codice per coppia.
7. **Regia**: Segna pronta → Apri il cerchio (le coppie vedono il Sigillo) → **VIA!** Da qui il motore gestisce da solo tregua, caccia, rivelazioni, doni, ultima mezz'ora e fine; puoi sospendere, riprendere, rivelare a mano, posticipare o saltare.
8. **La Soglia**: il validatore sceglie la coppia e registra l'esito; vittoria e podio partono in automatico.

### I simulacri sfocati

Ogni segreto non ancora svelato occupa già il suo posto, ma come **simulacro fortemente sfocato**: caratteri casuali generati nel telefono, senza alcun legame con il codice vero, che non arriva al dispositivo prima del tempo.
Il Sigillo della coppia si svela all'apertura del cerchio, quelli degli altri Settori al momento del tradimento, i frammenti allo sblocco.
In regia i Sigilli veri sono sfocati e si leggono tenendo premuto; il prossimo tradimento ha un simulacro con il countdown, e sul tabellone negli ultimi 10 secondi i simulacri tremano.

## Eletti del Consiglio

Un gruppo per partita con un numero qualsiasi di persone, divise in **squadre**. Non esiste un codice comune: ogni Eletto, una volta accettato, entra con il proprio **accesso personale** (QR o codice, stampato in "Stampa accessi").
**Spostamenti tra Eletti e Settori:** in *Squadre Eletti* «↔ Settore…» porta un Eletto in una coppia (in una incompleta, o al posto di un Legato che diventa Eletto nella stessa squadra); nelle schede delle coppie «→ Eletti…» fa il contrario, da solo o in scambio. L'accesso personale segue la persona.
Gli Eletti hanno la loro app (non la regia): incarichi della squadra, **Piazza Altari e Doni** (con scanner, GPS e foto), mappa del campo, messaggi con la regia (a tutti gli Eletti o solo alla propria squadra), avvisi, annunci, timer e regolamento. Non hanno Sigillo, non usano gli Altari e non entrano in classifica.

## Avvisi e notifiche

In regia, pagina **Avvisi**: titolo, testo e destinatari (tutti, solo coppie, solo Eletti, una coppia).
Sul telefono l'avviso arriva come **notifica** (Android/Chrome, anche a schermo spento): toccandola si apre la pagina **Avvisi** dell'app.
Con l'app aperta compare subito, con vibrazione. Nell'app c'è un invito ad attivare le notifiche; la regia vede quanti dispositivi le hanno attive.
Le notifiche richiedono HTTPS (vedi sotto).

## Campo, mappe, doni, alleanze e scontri

- **Piazzamento sul campo** (nell'app degli Eletti; per la regia dal telefono in `/campo`): si scansiona il cartello di un Altare o di un Dono, il telefono dà la posizione GPS (o si tocca il punto sulla mappa), si scatta la foto e si conferma. Foto e coordinate arrivano in regia (**Mappa e campo**).
- **Altari subito e Altari senza coppia**: l'Altare di una coppia nasce appena la coppia è formata (lo vedi subito in regia e sulla mappa del campo). In **Altari e Parola** puoi anche creare gli Altari dei Settori prima delle iscrizioni, per piazzarli nel bosco: finché nessuna coppia prende quel Settore restano **senza coppia**. Il loro Sigillo non si vince né si ruba, arriva solo dal tradimento, e uno di loro è sempre l'**ultimo** in calendario (il «lucchetto»: nessuno può finire prima). I mai rivelati si estraggono solo tra le coppie. Le coppie vedono gli Altari in mappa **solo dal via**.
- **Regia su telefono e tablet**: sotto gli 860 px la barra in alto non resta fissa (resta fissa la fila delle sezioni); sul telefono le tabelle diventano schede, la mappa ha l'elenco «Da piazzare» sotto, i messaggi funzionano come un'app di chat (elenco → conversazione → «‹ Conversazioni»).
- **Installare come app**: regia, Soglia e campo hanno ciascuna il proprio manifest, quindi si installano anche dal computer (icona di installazione nella barra dell'indirizzo di Chrome/Edge, o il pulsante «⤓ Installa app» in alto nella regia). Su iPhone: Condividi → Aggiungi a Home.
- **Posti per l'iscrizione**: in Iscrizioni e coppie (o in Impostazioni) decidi quanti **Settori aprire** (vuoto = tutti) e, se vuoi, un tetto ai temerari. N Settori sono 2N posti: la pagina di iscrizione mostra i Settori liberi per le coppie (N − coppie iscritte − temerari già accoppiabili) e i posti per i temerari (2N − 2 × coppie − temerari), e chiude la sfida quando sono finiti. Esempio: 9 Settori, 3 coppie e 1 temerario → 6 Settori per le coppie e 11 posti per i temerari. Chi entra con il codice del compagno usa il posto della sua coppia; gli Eletti non hanno limite.
- **Notifiche e Traccar** (regia → Notifiche e Traccar): elenco unico di coppie, Eletti, iscritti e organizzazione con lo stato delle notifiche (attive, solo sul telefono della coppia, non attive) e di Traccar (verificato, da attivare, non manda), il telefono e «Copia l'elenco» per il gruppo WhatsApp. Il numero accanto alla voce conta coppie ed Eletti con qualcosa da sistemare.
- **Traccar guidato** (app → avviso «Traccar da attivare» o Impostazioni → Traccar Client): procedura in 4 passi (installa, configura con i valori da copiare, permessi per Android/iPhone, prova). La prova chiede di bloccare lo schermo per un minuto: se dal telefono arrivano almeno 2 segnali, Traccar è verificato e l'avviso sparisce. A partita in corso, se Traccar tace da 10 minuti, l'avviso torna. Prima del via dei segnali si registra solo l'ora, non la posizione.
- **Accendi Traccar prima del via**: quando la partita è segnata «pronta» e quando si apre il cerchio, tutti i telefoni ricevono la notifica «Accendi Traccar Client» e nell'app compare, su tutte le pagine, l'avviso con il pulsante «Apri Traccar» (su Android apre direttamente l'app; su iPhone la sua pagina dell'App Store) o «Configura Traccar» per chi non l'ha mai fatto. L'avviso sparisce da solo al primo segnale ricevuto (negli ultimi 3 minuti prima del via, 10 durante la partita).
- **Notifiche della regia**: pulsante 🔔 in alto nella regia (anche in Impostazioni). Si attiva su ogni dispositivo dove vuoi riceverle e avvisa a ogni nuova iscrizione (coppie, temerari, candidature agli Eletti), ai messaggi delle coppie, agli scontri contestati e ai doni presi; con la regia aperta l'avviso compare anche nella pagina. Dal pulsante si invia una notifica di prova o si spengono su quel dispositivo. Su iPhone servono l'app aggiunta alla schermata Home.
- **Esporta KMZ (ATAK)**: regia (Mappa e campo, Altari e Parola) ed Eletti (mappa del campo) scaricano tutti i punti piazzati (luoghi, Altari, Doni, punti indicati) in un KMZ con le icone, da aprire in ATAK o Google Earth. Le coppie scaricano solo ciò che vedono nella loro mappa.
- **Piazza provvisorio**: senza cartello o foto (es. il sopralluogo prima dell'evento) si segna solo il punto. In mappa compare con il triangolo giallo ⚠ «!» e resta tra le cose da fare finché non lo si **conferma** col piazzamento normale (cartello e foto). Un Dono «appena piazzato» non viene annunciato finché è provvisorio.
- **Mappe OpenTopoMap**: la regia vede Altari e doni (grigio = piazzato non comparso, colorato = comparso, barrato = preso); le coppie vedono Altari e doni comparsi più la propria posizione.
- **Posizioni GPS in mappa**: i telefoni delle coppie inviano la posizione solo a partita iniziata (dal VIA alla fine, anche in pausa), quelli degli Eletti da quando la partita è **Pronta** (non durante la preparazione). La regia vede tutti (coppie con il numero romano, Eletti con il colore della squadra), gli Eletti vedono solo gli Eletti. L'app avvisa chi è visibile; i browser inviano la posizione solo con l'app aperta. *Nota: la specifica iniziale escludeva il tracciamento delle coppie; è stato aggiunto su richiesta dell'organizzazione.*
- **Squadre di Eletti** (regia → Squadre Eletti): candidature, squadre con colore, membri, accessi personali e incarichi liberi; ogni Eletto trova tutto nella voce **Incarichi** della sua app.
- **Incarichi di piazzamento** (Altari e Parola, Doni QR, Squadre Eletti): per ogni Altare, Dono o luogo vedi se è piazzato e da quale squadra, e lo assegni a una squadra con una finestra che chiede il **punto sulla mappa** (o lascia libera la scelta) e una nota. Un punto già piazzato si può **far spostare**: viene proposta la squadra che lo aveva piazzato.
- **Luoghi del gioco**: il **Cerchio di inizio** e la **Soglia** si piazzano come gli Altari (foto facoltativa) e compaiono sulle mappe di regia, Eletti e coppie.
- **Doni QR**: crea il dono, fallo piazzare a una squadra, **annuncialo** (ora, tra X minuti, alle HH:MM o a un minuto dal via) con la timeline del torneo; scadenza facoltativa. La prima coppia che lo scansiona lo prende; tutti ricevono una notifica e il dono sparisce dalle mappe.
- **Timeline del torneo**: ovunque si sceglie "quando e per quanto" (annuncio dei doni, finestre armamenti) si apre una finestra con la linea del tempo della partita: fasi, tradimenti, armamenti, doni e il momento attuale. Si tocca la timeline o si sceglie ora / tra X minuti / alle HH:MM / al minuto dal via.
- **Armamenti**: finestre con apertura e durata; all'apertura annuncio e conto alla rovescia nelle app, alla chiusura un secondo annuncio. Si possono aprire subito, anticipare, posticipare, prolungare o chiudere prima.
- **Annunci e messaggi**: vista ad albero — tutte le coppie (annunci) e sotto ogni coppia; tutti gli Eletti e sotto ogni squadra — con la conversazione a destra (testo e vocali).
- **Scansione degli Altari a tempo**: vale i minuti impostati nella partita (default 15, 0 = sempre); poi va ripetuta. Se il Sigillo è già nel taccuino l'app lo propone, senza scriverlo.
- **Alleanze** (pagina sua nell'app): proposta e accettazione (massimo 3 coppie), rottura allo stesso modo; gli alleati ricevono i Sigilli gli uni degli altri. Le alleanze sono **segrete**: le altre coppie non vedono chi è alleato con chi né quante coppie ha un'alleanza (il server non lo manda); se insieme si superano le 3 coppie, l'alleanza si rifiuta all'accettazione.
- **Scontri**: VINTO / PERSO / PAREGGIO contro una coppia. "Perso" vale subito, "vinto" va confermato dallo sconfitto (se contesta decide la regia). I vincitori e i loro alleati ricevono i Sigilli di tutta la parte sconfitta; chi perde riceve in automatico il timer Veglia (popup Sconfitta). Chi vince, e ogni suo alleato, vede il popup **Vittoria** con i Sigilli di tutta la parte sconfitta, anche quelli che conosceva già. Negli scontri della parte avversaria si vede solo la coppia con cui si è combattuto. Se la vittoria non porta nessun Sigillo nuovo (li conoscevate già tutti), la Vittoria propone quale **rubare**: i Sigilli che la parte sconfitta conosce (il taccuino di tutta l'alleanza, sommato) meno quelli che conoscete voi; scelto, si svela come negli ingaggi. Se si chiude il popup, la scelta resta nella pagina Scontri. In regia le uscite dalla Soglia (verde: Parola valida; rosso: respinta, con i frammenti mancanti o errati) e gli scontri compaiono sulla **timeline del torneo** (gli scontri sono rombi rossi): esito, parti (anche le alleanze, che la regia vede), Sigilli rubati; quelli da confermare o contestati si confermano o annullano cliccandoli.

## Accedi con Zero Dark Ops

Oltre a username e password, i giocatori possono entrare con l'account del **gestionale della loro squadra** (Zero Dark Ops), che fa da fornitore di identità OpenID Connect ([documentazione del gestionale](https://github.com/whiskas85/team-management/blob/main/docs/IDENTITA.md)).

1. Nel gestionale, da admin: **Sistema → App collegate → Nuova app**. Nome «I Giochi del Buio», indirizzo di ritorno `<indirizzo pubblico>/auth/ops/callback` (es. `https://games.zerodarkteam.it/auth/ops/callback`; la regia lo mostra già pronto da copiare). Tipo *con un suo server*: si ottengono `client_id` e `client_secret`.
2. Nei Giochi: **Impostazioni → Accesso con il gestionale → Aggiungi gestionale** (indirizzo, `client_id`, `client_secret`), oppure `OPS_ISSUER`, `OPS_CLIENT_ID`, `OPS_CLIENT_SECRET` nel file `.env`. In produzione il workflow li scrive dai secrets `OPS_CLIENT_ID` e `OPS_CLIENT_SECRET` (indirizzo `https://ops.zerodarkteam.it`, o la variabile `OPS_ISSUER`).

Da quel momento compare **Accedi con Zero Dark Ops** nell'app e nella pagina di iscrizione:

- **prima volta**: nasce un account dei Giochi con nome, callsign (come nome di battaglia) e squadra del gestionale, senza password; si passa subito alla scelta della sfida. La password si può aggiungere dal profilo;
- **chi ha già un account** lo collega dal profilo (**Collega Zero Dark Ops**) e poi entra con un tocco; dal profilo si scollega (se l'account non ha una password, prima va impostata);
- l'identità è la coppia (gestionale, `sub`): un account del gestionale vale per un solo account dei Giochi. Più squadre con il loro gestionale: un gestionale per ciascuna, ognuno con il suo pulsante.

### Regia e Soglia con il proprio account (inviti)

Nessuno diventa master o validatore da solo, neanche dal gestionale: i ruoli dei Giochi li dà solo un master, con un **link d'invito**.

1. In regia, **Impostazioni → Organizzazione → Invita con il suo account**: scegli *Master* o *Validatore* e premi **Crea link d'invito** (link e QR).
2. Chi lo apre arriva al login principale, entra con il suo account (username e password o **Accedi con Zero Dark Ops**) oppure si registra: l'invito si accetta da solo e si finisce in regia o alla Soglia.
3. Il link vale **una volta sola** e per **24 ore**; finché non è usato si può annullare. In *Organizzazione* si vede chi è entrato così (`@account · Zero Dark Ops`) e con **Togli** gli si toglie il ruolo (l'account dei Giochi resta).

Per entrare in regia con il tuo account di Zero Dark Ops: entra come `MASTER_USER`, crea un invito da master, aprilo e scegli **Accedi con Zero Dark Ops**. L'utente `MASTER_USER` del file `.env` resta come accesso d'emergenza (es. se il gestionale non risponde).

**I validatori** sono gli Ufficiali della Soglia: entrano solo in `/soglia`, dove registrano l'esito delle coppie che portano la Parola; non vedono la regia né i Sigilli.

Regia e Soglia non hanno un login proprio: tutto passa dal login principale (`/`), che manda ognuno al suo posto; **Esci** riporta lì.

Se il gestionale gira sulla stessa macchina dei Giochi, dal container il suo indirizzo pubblico spesso non risponde: i Giochi allora lo raggiungono dal Caddy interno (`PROXY_INTERNO`, scritto in automatico dal workflow), con lo stesso certificato. Il workflow controlla anche che i Giochi raggiungano il gestionale (passo «Il gioco raggiunge il gestionale?»).

Il giro è *authorization code* con PKCE S256; l'id_token è verificato (firma RS256 con le chiavi del gestionale, emittente, destinatario, scadenza, nonce). I Giochi non tengono token del gestionale: la sessione è quella solita dell'app. Il gestionale accetta solo indirizzi di ritorno `https://` (o `http://localhost` per le prove).

## Provare dai telefoni in Wi-Fi

In regia, **Impostazioni → Indirizzo per link e QR**: inserisci l'indirizzo del PC sulla rete Wi-Fi (es. `http://192.168.86.105:8090`), premi **Prova** e poi **Salva**.
Da quel momento cartelli degli Altari, credenziali, QR dell'iscrizione e link di accesso usano quell'indirizzo, e i telefoni sullo stesso Wi-Fi possono aprirli.
L'IP del PC si trova con `ipconfig` ("Indirizzo IPv4" della scheda Wi-Fi). Con DHCP può cambiare: se cambia, aggiorna l'impostazione e ristampa i QR.
L'impostazione ha la precedenza su `PUBLIC_URL` del file `.env`; con "Torna a…" si ripristina.

## Posizione anche a schermo spento (Traccar Client)

Il browser manda la posizione solo con l'app aperta e lo schermo acceso (limite di Android e iOS per le app web). Per averla sempre, ogni giocatore installa **Traccar Client** (gratis, [Android](https://play.google.com/store/apps/details?id=org.traccar.client) e [iPhone](https://apps.apple.com/app/traccar-client/id843156974)) e lo configura da **Impostazioni → Posizione anche a schermo spento** nell'app dei Giochi: indirizzo del server (`<indirizzo pubblico>/api/traccar`) e identificativo personale, da copiare. Frequenza consigliata 30 secondi, posizione «Sempre», niente ottimizzazione della batteria.

- Le posizioni arrivano a `/api/traccar` (protocollo OsmAnd: parametri nell'indirizzo o nel modulo, oppure JSON con `location.coords` delle versioni nuove) e valgono come quelle dell'app; il server risponde sempre `OK`.
- Se la stessa persona manda la posizione sia dall'app aperta sia da Traccar Client, in mappa c'è un solo punto (il più recente).
- I punti vecchi rimasti nel telefono senza rete (più di 2 minuti) non contano; come per l'app, le coppie compaiono solo a partita iniziata.
- Serve l'accesso personale (account o codice personale): con il codice comune della coppia non c'è un identificativo.

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
            accounts.js (account dei giocatori)  ops.js (accesso con Zero Dark Ops, OpenID Connect)  staff.js (inviti per regia e Soglia)
  public/   index.html + js/app.js (PWA coppie)  regia.html + js/regia.js  soglia.html  tabellone.html  iscrizione.html  sw.js
  test/     engine.test.js (criteri di accettazione)  ops.test.js (accesso con Zero Dark Ops)  staff.test.js (inviti)
```

Stack: Node.js 24 senza framework frontend (nessuna build), Express 5, SQLite integrato (`node:sqlite`), Server-Sent Events, Web Push (chiavi VAPID generate al primo avvio e salvate nel database).

## Decisioni sulle domande aperte (sezione 14)

- I frammenti ricevuti a mano contano in classifica come quelli sbloccati.
- La Parola è una frase scritta dalla regia, divisa automaticamente tra gli Altari (ogni frammento resta modificabile).
- Alla Soglia il validatore sceglie la coppia dalla lista (niente QR personale).
- Le finestre armamenti possono essere sia a orario sia lanciate a mano.

## Ambienti: test e produzione

| Ambiente | Indirizzo | Quando si aggiorna | Sul server |
| --- | --- | --- | --- |
| **Test** | <https://testgames.zerodarkteam.it> | a ogni push su `main` | `~/zerodarkgames-test`, container `zero-dark-games-test`, porta 8091, dati propri |
| **Produzione** | <https://games.zerodarkteam.it> | solo a mano: GitHub → Actions → «Test e pubblicazione» → *Run workflow* → ambiente **produzione** | `~/zerodarkgames`, container `zero-dark-games`, porta 8090 |

Il test ha una striscia gialla «Ambiente di test» in cima a ogni pagina. I due ambienti hanno database separati: provare in test non tocca la produzione.

**Azzerare i dati** (partite, account, inviti, impostazioni): *Run workflow* con l'ambiente scelto e, nel campo «Azzerare i dati», la parola `AZZERA`. Prima di svuotare il database il workflow ne salva una copia compressa sul server in `~/<cartella>/backup/zdg-data-<data>.tgz`; dopo resta solo il master del `.env`.

«Accedi con Zero Dark Ops» in test: nel gestionale va aggiunto anche l'indirizzo di ritorno `https://testgames.zerodarkteam.it/auth/ops/callback` (oppure un'app separata, configurata dalla regia del test).

## Pubblicazione automatica (GitHub Actions)

Il workflow [.github/workflows/deploy.yml](.github/workflows/deploy.yml) a ogni push su `main` (pubblica sul test; la produzione si pubblica a mano, vedi sopra):

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
