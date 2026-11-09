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
   In **Persone** ogni persona ha «Elimina…»: la toglie dalla partita (in attesa, senza coppia, tra gli Eletti o in coppia; la coppia rimasta vuota si scioglie) e, con la spunta, elimina anche il suo profilo (account). Chi è in coppia si toglie solo prima di aprire il cerchio: dopo si ritira la coppia.
3. **Sigilli e tradimenti**: genera i Sigilli; si estraggono i mai rivelati e si calcola il calendario (sezione 7.1), modificabile fino al via.
4. **Altari e Parola**: scrivi la Parola, che viene divisa tra gli Altari; poi stampa i cartelli A4 con il QR.
5. **Armamenti** (facoltativo): finestre con apertura (minuto dal via, orario o a mano) e durata, scelte sulla timeline del torneo.
6. **Stampa credenziali**: un QR di accesso e un codice per coppia. In **Stampe** c'è anche **Postazioni nel Cerchio**: un cartello A4 per ognuno dei Settori attivi (numero romano grande, colore, nome, elemento e motto), dove ogni coppia lascia il suo armamentario.
7. **Regia**: Segna pronta → Apri il cerchio (le coppie vedono il Sigillo) → **VIA!** (5 secondi di conto alla rovescia a tutto schermo con i bip 5, 4, 3, 2, 1 e il corno su tutte le regie aperte, anche se il VIA lo dà un telefono; si può annullare. Anche le app di coppie ed Eletti mostrano il 5, 4, 3, 2, 1, VIA! a tutto schermo, solo con la vibrazione e senza suoni. Volume e suoni in Impostazioni → Questo dispositivo, dove si possono anche **caricare i propri suoni** (MP3, WAV, OGG o M4A, massimo 3 MB, validi per tutte le regie): bip dei secondi, un suono per ogni numero 5…1 (facoltativo) e il VIA al posto del corno; senza file valgono i suoni predefiniti, generati per i Giochi (`app/public/sounds`: battito horror per i secondi, corno da guerra per il VIA; si rigenerano con `app/tools/genera-suoni-via.py`, serve Python con numpy e scipy); il browser suona solo dopo un clic sulla pagina: a cerchio aperto c'è «🔈 Attiva i suoni del VIA su questo computer») Da qui il motore gestisce da solo tregua, caccia, rivelazioni, doni, ultima mezz'ora e fine; puoi sospendere, riprendere, rivelare a mano, posticipare o saltare.
8. **La Soglia**: il validatore sceglie la coppia e registra l'esito; vittoria e podio partono in automatico. In alternativa la coppia **esfiltra da sola**: in Luoghi del gioco stampa il **QR di uscita** («Stampa QR di uscita») e appendilo alla Soglia. Con la Parola intera la mappa della coppia mostra «⌖ Leggi il codice di uscita»: se ha tutti i frammenti e nessun alleato esce (vittoria o podio) e il suo Sigillo viene rivelato a tutti come un tradimento; altrimenti compare «Uscita negata» (frammenti mancanti, oppure alleanza ancora in piedi, che finisce anche nel registro della regia).

### I simulacri sfocati

Ogni segreto non ancora svelato occupa già il suo posto, ma come **simulacro fortemente sfocato**: caratteri casuali generati nel telefono, senza alcun legame con il codice vero, che non arriva al dispositivo prima del tempo.
Il Sigillo della coppia si svela all'apertura del cerchio, quelli degli altri Settori al momento del tradimento, i frammenti allo sblocco.
In regia i Sigilli veri sono sfocati e si leggono tenendo premuto; il prossimo tradimento ha un simulacro con il countdown, e sul tabellone negli ultimi 10 secondi i simulacri tremano.

## Eletti del Consiglio

Un gruppo per partita con un numero qualsiasi di persone, divise in **squadre**. Non esiste un codice comune: ogni Eletto, una volta accettato, entra con il proprio **accesso personale** (QR o codice, stampato in "Stampa accessi").
**Spostamenti tra Eletti e Settori:** in *Squadre Eletti* «↔ Settore…» porta un Eletto in una coppia (in una incompleta, o al posto di un Legato che diventa Eletto nella stessa squadra); nelle schede delle coppie «→ Eletti…» fa il contrario, da solo o in scambio. L'accesso personale segue la persona.
Gli Eletti hanno la loro app (non la regia): incarichi della squadra, **Piazza Altari e Doni** (con scanner, GPS e foto), mappa del campo, messaggi con la regia (a tutti gli Eletti o solo alla propria squadra), avvisi, annunci, timer e regolamento. Non hanno Sigillo, non usano gli Altari e non entrano in classifica.

## Ristoro (panini e bevande)

Il Consiglio prepara un menù di panini e bevande e coppie, Eletti e Consiglio ordinano dall'app. I prezzi sono solo **un'offerta indicativa: si paga in offerta libera**, e l'app lo dice sempre.

- **Addetto**: in Consiglio Zero il master dà il permesso **Ristoro**. L'addetto, e il master, gestisce tutto dalla sua app del Consiglio (`/consiglio`, gruppo Ristoro: **Menù** e **Ordini e richieste**) o dalla regia (voci **Ristoro: menù** e **Ristoro: ordini e richieste**):
  - le voci del menù (titolo, descrizione, prezzo indicativo, ordine);
  - l'**ora limite** per ordinare;
  - in **Ordini e richieste** l'ora limite e un filtro Ordini / Richieste d'ordine, con il riepilogo «da preparare».
- **Chi ordina**:
  - Coppie ed Eletti: nell'app, sezione **Ristoro** in home e nel menu.
  - Consiglio: nella sua app (`/consiglio`), gruppo Ristoro → «Panini e bevande»; la regia dalla voce **Ristoro: ordina**.
  - Si sceglie quante ne vuoi di ogni voce, si aggiunge una nota e si invia.
  - I propri ordini si vedono, si modificano e si annullano fino all'ora limite.
- **Dopo l'ora limite** non si ordina più: si può solo mandare una **richiesta d'ordine**, segnalata come tale a chi la manda e all'addetto. L'addetto la accetta o la rifiuta, e la risposta arriva con una notifica. Una richiesta **accettata diventa un ordine** (segnato «da richiesta accettata»): finisce tra gli Ordini, nel totale da preparare e nel Ritiro. Una rifiutata si può rimettere in attesa. Gli ordini già fatti da quel momento non si cambiano più.
- **Storico**: ogni ordine e ogni richiesta tengono la data dell'invio e dell'ultima modifica, più lo storico di ogni passaggio (inviato, modificato, annullato, accettato, rifiutato).
- **Ritiro** (permesso Ristoro; regia: gruppo «Ristoro» → «Ritiro»): l'elenco di chi ha ordinato, con una **barra di ricerca** (nome o voce) e i filtri **Da consegnare**, **Da pagare** e **Fatti**. Consegna e pagamento sono separati e **vanno per ordine**: ogni ordine ha il suo stato (consegnato / da consegnare, pagato / da verificare / da pagare) e i suoi pulsanti **Consegna** e **Paga**; per il totale ci sono **Consegna tutto** e **Paga tutto** quando gli ordini aperti sono più di uno. Un ordine pagato **in parte** mostra quanto resta e tiene il pulsante (**Ricevi il resto** alla cassa, **Paga il resto** nell'app); «Salda l'ordine» (offerta libera) chiude solo gli ordini di quel pagamento, non tutto il conto. **Consegna** dà tutto o solo una parte (quantità per voce) e tiene il conto di cosa manca; **Paga** registra come ha pagato (contanti, Satispay, PayPal con il **QR** da far inquadrare) e quanto, prima o dopo il ritiro, anche a rate, e mostra quanto resta rispetto al totale indicativo. Siccome è offerta libera, «Chiudi il conto» azzera il resto. Ogni consegna e ogni pagamento resta nello storico e si può annullare; un ordine consegnato anche solo in parte non si modifica più. In alto l'incassato (diviso per metodo) e quanto c'è ancora da pagare. Chi ordina vede il proprio conto (pagato, quanto resta, ritirato) e cosa è già stato consegnato. Chi ordina può anche **pagare in anticipo** dall'app (dal pulsante **Paga** su ogni ordine, con «Paga tutti gli ordini» nel proprio conto, oppure subito dopo l'invio, quando l'app lo propone). Il pagamento è **legato agli ordini che paga**: l'ordine pagato mostra «Pagato … · in attesa che la cassa confermi» (poi «Pagato») e non si paga né si modifica più; gli altri restano da pagare con il loro importo. Anche alla cassa ogni pagamento copre gli ordini non ancora pagati: sceglie Satispay o PayPal (i contanti si danno alla cassa), apre il link (si esce dall'app), paga e torna a premere **Ho pagato**. Il pagamento resta **in attesa** finché la cassa non lo verifica nel Ritiro: **Arrivato** (con l'importo davvero arrivato, eventualmente chiudendo il conto) lo conta come pagato, **Non arrivato** avvisa la persona di passare alla cassa. In cima al Ritiro c'è l'avviso dei pagamenti da verificare; alla regia arriva una notifica. Nell'app del Consiglio, chi gestisce la cucina vede in apertura il Ristoro con un **mini cruscotto**: ordini aperti (da consegnare), evasi e da chiudere (consegnati ma non pagati); incassi attesi (totale indicativo), pagati in anticipo da verificare e ricevuti in cassa; più gli avvisi di richieste da decidere e pagamenti da verificare. Ogni casella porta al Ritiro sul filtro giusto. Se il master non gli ha aperto azioni di gioco, non compare il riquadro «Sei nel Consiglio Zero». I metodi di pagamento hanno una pagina a parte, **Metodi di pagamento** (regia: gruppo «Ristoro» → «Metodi di pagamento»): contanti sempre attivi, link Satispay e PayPal con l'anteprima del QR; chi ordina vede i link nella pagina del Ristoro.

## Canali radio

In **Impostazioni → Canali radio** la regia assegna canale e riserva al **Consiglio** (regia ed Eletti), a ogni **squadra di Eletti** e a ogni **coppia**. Nell'app ognuno vede solo i suoi, nella scheda «📻 I vostri canali radio» in home e nella pagina **Canali radio** (Info e impostazioni, anche dal menu) con banda e numero in grande (es. «LPD 12»), la frequenza in MHz, l'eventuale tono e il canale d'emergenza: la coppia solo i propri (privati, le altre coppie non li ricevono mai), l'Eletto quelli della sua squadra e del Consiglio. Il canale d'emergenza (SOS), con la sua **riserva**, resta nella barra in basso: si imposta solo qui, nella sezione rossa in cima («Canale d'emergenza (SOS)»), e la riserva compare nella finestra EMERGENZA, negli avvisi e nella pagina Canali radio dell'app. Accanto a ogni campo (anche quello d'emergenza) il pulsante 📻 apre l'elenco dei canali **PMR446** (16) e **LPD433** (69) con la ricerca per numero o frequenza; i canali già assegnati altrove sono disabilitati con il nome di chi li usa. Si può sempre scrivere a mano, per esempio per aggiungere il tono CTCSS. Il pulsante **⚡ Assegna in automatico…** assegna i canali in fila da un canale di partenza (LPD di base o PMR) a Consiglio, squadre di Eletti e coppie (e, se spuntata, all'emergenza), scegliendo se principali, di riserva o tutti e due (in quel caso principale e riserva di ogni riga sono uno dopo l'altro); salta i canali già usati altrove e mostra prima l'anteprima e su quale canale si arriva.

## Avvisi e notifiche

In regia, pagina **Avvisi**: titolo, testo e destinatari (tutti, solo coppie, solo Eletti, una coppia).
Sul telefono l'avviso arriva come **notifica** (Android/Chrome, anche a schermo spento): toccandola si apre la pagina **Avvisi** dell'app.
Con l'app aperta compare subito, con vibrazione. Nell'app c'è un invito ad attivare le notifiche; la regia vede quanti dispositivi le hanno attive.
Ogni avviso ha il pulsante **↗ Condividi** (la finestra si apre anche subito dopo l'invio): link e QR che aprono l'app sulla pagina Avvisi con quell'avviso in evidenza (chi non è entrato fa prima il login, anche con Zero Dark Ops), più «WhatsApp», «Copia link» e, sul telefono, la condivisione del sistema. L'avviso lo vede solo chi ne è destinatario.
Le notifiche richiedono HTTPS (vedi sotto).

## Campo, mappe, doni, alleanze e scontri

- **Emergenza reale (OFF GAME)**: nella barra in basso dell'app il pulsante **EMERGENZA** apre una finestra con il pulsantone; dopo la conferma il telefono manda subito chi è (persona, coppia o squadra di Eletti, telefono) e l'ultima posizione nota, poi la posizione GPS del momento appena arriva. Lo stesso fa il pulsante **SOS di Traccar Client** (`alarm=sos`). La regia salta alla pagina **🚨 Emergenze** con un allarme sonoro (ripetuto finché nessuno la prende in carico) e una fascia rossa su tutte le pagine: elenco delle emergenze (presa in carico — chi ha chiamato riceve la conferma — e chiusura con nota) e mappa con tutti i punti, il punto della chiamata (rosso) e l'ultima posizione di chi ha chiamato (arancione). Notifica push alla regia che resta finché non la si tocca.

- **Voto del pubblico · Analizza**: in regia, accanto a ogni coppia, «🔍 Analizza» apre da dove arrivano i suoi voti:
  - quanti voti, reti diverse, dispositivi, voti verificati e cambiati;
  - gli avvisi: voti da reti che l'hanno votata più volte, poche reti per tanti voti, programmi automatici, stesso telefono e browser, ritmo fisso;
  - i voti per ora;
  - le reti (impronta, non l'indirizzo vero) con quanti voti a questa coppia e ad altre, e un pulsante per annullarli;
  - telefono e browser;
  - l'elenco di tutti i voti, annullabili uno a uno.
- **Password dimenticata** (solo per chi non entra con Zero Dark Ops): in regia «🔑 Password» (in Persone, nelle schede delle coppie e degli Eletti, in Account dei giocatori) genera una password temporanea, chiude le sessioni aperte di quella persona e mostra username e password con «📋 Copia per WhatsApp» e «💬 Apri WhatsApp» sul suo numero. Al primo accesso con la password temporanea, nell'app o nella pagina d'iscrizione, deve sceglierne una sua prima di continuare. Per gli account di Zero Dark Ops il pulsante non compare: la password si gestisce lì.
- **Voto del pubblico · voti a ripetizione**: «🧹 Pulizia di tutte le coppie» (e «Pulisci questa coppia» dentro Analizza) tiene un voto per rete e per coppia, quello con l'account se c'è, e annulla gli altri. Si può scegliere tra «solo i casi evidenti» (4 o più voti dalla stessa rete) e «tutte le ripetizioni». Ogni annullamento, anche del singolo voto o di una rete, mostra prima le percentuali e il podio **prima e dopo**. **Blocco**: la pagina del voto manda un'impronta del browser che non cambia in navigazione privata, così sulla stessa rete lo stesso telefono cambia il voto invece di aggiungerne uno; c'è inoltre un tetto di voti nuovi in 24 ore dalla stessa rete (predefinito 3, si cambia in regia; chi vota con l'account non ha tetto).
- **Minigiochi** (regia → pagina **Minigiochi**: dove si usano, interruttore acceso/spento per ogni gioco e «▶ Prova» per giocarlo lì senza contare nulla; uno spento non esce né a caso né se scelto; anche da Altari e Parola → «Minigiochi»): una prova veloce sul telefono per sbloccare un Altare (dopo la scansione, prima del Sigillo) e per completare un Beacon degli Eletti (Altare: prima di spegnerlo; zona: alla fine della sequenza). Per gli Altari e per i Beacon si sceglie: nessuno, «A caso», «Ripeti il segnale» (sequenza di luci da ripetere), «Ricorda il codice» (cifre da memorizzare), «Ferma al momento giusto» (3 centri su 4) o «Tocca in ordine» (da 1 a 9 entro 12 secondi). Ogni Altare può avere il suo minigioco. Il server sceglie il gioco e verifica le risposte di «Ripeti il segnale» e «Ricorda il codice». Chi sbaglia riprova dopo 10 secondi. Il minigioco superato vale finché vale la scansione dell'Altare; per il Beacon vale una volta, entro 10 minuti.
- **Probabilità del Dono a caso** (regia → Skill e Doni, scheda «🎲 Probabilità del Dono a caso»): quando un Dono esce «a caso» (Autorità, Zona di Conquista, premi senza un dono scelto) c'è una doppia estrazione. Prima esce la rarità (predefinite: Comune 60%, Raro 25%, Epico 11%, Leggendario 4%), poi un dono di quella rarità in base al suo peso. Per ogni dono una sola scelta: **Comune, Raro, Epico, Leggendario o Non esce mai** (non esce dall'estrazione casuale, ma resta assegnabile come premio scelto o con un QR). Si sceglie toccando il badge sotto il titolo del dono, oppure nella scheda «Probabilità del Dono a caso» della stessa pagina, dove si cambiano anche le percentuali delle quattro rarità.
- **Sigilli dei Settori senza coppia**: nessuno li può conquistare negli scontri, quindi arrivano solo dal Tradimento e quel tradimento non salta mai. È sempre in calendario prima dell'ultima mezz'ora (dove i tradimenti rimasti si saltano). Se all'ultima mezz'ora non è ancora partito, parte in quel momento. La regia non lo può saltare: può solo spostarlo o rivelarlo subito.
- **Canale d'emergenza in uso**: in regia (pagina Emergenze e Canali radio, riquadro rosso) un interruttore «Emergenza / Emergenza backup». Con il backup tutte le app mostrano la riserva come canale d'emergenza (es. LPD 11 invece di LPD 10): per primo nella pagina Canali radio, nella barra «Radio SOS» e nella finestra EMERGENZA, con la scritta «riserva in uso»; a ogni cambio arriva una notifica a coppie ed Eletti.
- **Pronti per la gara · Copia per WhatsApp**: tasto destro su una persona (sul telefono tenendo premuto) → «💬 Copia per WhatsApp» copia il suo stato pronto da incollare, in grassetto e con emoji (App, Notifiche, Traccar, ICE, Avviso di sicurezza, con ✅ ⚠️ ❌), più l'elenco di cosa deve sistemare e il link all'app; se è tutto a posto lo dice.
- **Zona di Conquista contesa**: vince la prima coppia che accumula dentro il tempo scelto. Se nella zona entra un'altra coppia la zona è **contesa**: il tempo di tutte e due si ferma (nell'app l'anello diventa ambra, pulsa e dice «CONTESA», con vibrazione e avviso). Quando una delle due perde uno scontro esce dalla contesa (anello grigio «FUORI»: per tornare in gara deve uscire e rientrare, ripartendo da zero) e il conteggio di chi ha vinto riparte da dove si era fermato. In regia, sotto la zona, il tempo di ciascuna coppia e l'avviso «Contesa».
- **Skill e Doni con effetto** (fase 1, issue «Sistema Skill e Doni»): prima del via ogni coppia sceglie dalla pagina **Skill** dell'app le sue abilità (per partita, in Impostazioni → Settaggio coppie: «Skill attive o Ultimate scelte all'inizio», predefinito 1, e «Skill passive scelte all'inizio», predefinito 1; in più gli **slot**, cioè il massimo per coppia: gli slot oltre l'inizio sono «🔒 bloccati» nell'app e si riempiono in gioco con i doni Maestro per le attive e Saggio per le passive; con gli slot pieni il dono viene rifiutato; slot vuoto = senza limite). Le attive e le Ultimate hanno una ricarica indipendente; le passive valgono sempre. Le posizioni delle altre coppie non arrivano mai ai telefoni, tranne durante un effetto (Occhio del Consiglio, Rete del Consiglio, Tracker, Tracciamento, Taglia): le calcola il server e spariscono allo scadere. I **Doni** hanno ora un catalogo fisso con effetto automatico (Maestro: una Skill attiva o Ultimate in più; Saggio: una Skill passiva in più — oltre ai limiti scelti prima del via, ogni dono una volta sola e più doni aggiungono più Skill; Chiave Maestra, Grande Furto, Tracciamento, Archivio Proibito, Immunità, Seconda Possibilità, Sovraccarico, Taglia, Dossier Segreto, Benedizione del Consiglio): la regia sceglie il tipo quando crea il dono, la coppia lo usa dalla pagina «I vostri doni». In regia ogni coppia mostra le sue Skill e gli effetti in corso; il registro elenca scelte e usi. **Fase 2, scontri e alleanze**: Maestria delle armi e Immunità si usano sulla sconfitta (pulsante «PERSO» con la Skill, oppure confermando la vittoria dichiarata dall'avversario), Velenoso dallo storico degli scontri nei 10 minuti dopo uno scontro (rompe tutta l'alleanza avversaria), Diplomatico proponendo o accettando un'alleanza (gli alleati non ricevono il vostro Sigillo); i pulsanti delle Skill vanno tenuti premuti finché la barra si riempie. Passive: Veglia Forzata (chi perde contro di voi fa una Veglia doppia), Ritirata del Diplomatico (blocco di 8 minuti dopo una trattativa fallita), Devoto del Santuario (dentro un Santuario la ricarica accelera il triplo: ×2 diventa ×6). Dono Reliquia Antica: per 30 minuti il vostro Sigillo resta coperto se perdete e nessuno vi ruba Sigilli. Doni pensati anche come premi del voto del pubblico (vantaggio senza regalare Sigilli): **Sguardo della Folla** (raro, 5 minuti: accanto all'orologio direzione e distanza della coppia non alleata più vicina), **Sentinella** (comune, 20 minuti: come l'Allarme di Prossimità a 80 m, ma a tempo), **Contromossa** (comune, 60 minuti: la prima Taglia, Tracciamento o Tracker contro di voi viene respinto), **Maschera** (raro, 15 minuti: chi vi vede sulla mappa vi vede in un punto falso a circa 150 m). **Indietro senza perdere il punto**: nell'app delle coppie/Eletti e in quella del Consiglio, tornando indietro (‹ in alto o tasto «indietro» del telefono) si ritrova la pagina (es. la home con il menu) nella stessa posizione in cui la si era lasciata; aprendo una pagina nuova si parte dall'alto. **Sigilli e frammenti protetti** nell'app delle coppie: nell'app non si seleziona niente (tranne i campi di testo), così non si può nemmeno allargare una selezione fino a un Sigillo; la copia di una selezione che tocca un Sigillo o un frammento esce vuota (niente copia-incolla da girare in chat), niente menu del tasto destro o della pressione lunga su di essi; F12 e le scorciatoie degli strumenti per sviluppatori sono disattivate (solo deterrente: il server non manda mai Sigilli coperti o frammenti non presi, al loro posto c'è testo finto). **Altare con il Sigillo in mano**: se una coppia conosce già il Sigillo di un Altare (suo, rivelato, vinto, rubato, da dono o evento) e ne inquadra il QR (con il controllo di posizione superato, se acceso), l'Altare è sbloccato: senza minigioco il frammento arriva subito, senza pronunciare il Sigillo; con il minigioco l'Altare resta sbloccato («🔓 Sbloccato · minigioco» nell'app) e la scansione non scade più, così il frammento si prende superando il minigioco anche più tardi, toccando l'Altare. Vale anche se il Sigillo lo scopre mentre la scansione è ancora valida; se lo scopre dopo che è scaduta, deve tornare all'Altare. **Video coppie** (regia → Video coppie): presentazione delle coppie in tema Giochi del Buio, in ordine di Settore. Intro «I Giochi del Buio», poi per ogni coppia numero romano, Settore con l'effetto del suo elemento (braci, pioggia, polvere, vento, scintille, foglie, cenere, neve, fulmini…) e il motto, il logo che si apre con un lampo e sotto i nick dei due membri; chiusura del Consiglio. 1920×1080 con colonna sonora horror facoltativa (interruttore Sì/No): sotto un bordone grave e scuro con un filo di vento; per ogni coppia un risucchio grave che sale fino a un tonfo cupo all'apertura del logo e, sui nick, un respiro e un tonfo sordo per nome; tonfo anche sul titolo e in chiusura; secondi per coppia regolabili; anteprima a schermo intero oppure «Registra e scarica» (MP4 su Chrome/Edge, altrimenti WebM; la registrazione dura quanto il video). Le coppie senza logo mostrano il numero romano. **Ristoro · Ordina per altri** (regia e app del Consiglio con permesso Ristoro; pulsante anche in Ordini e Ritiro): prima si sceglie la persona dall'elenco dei giocatori (nome e cognome, nick, squadra; ricerca) oppure si scrive il nome a mano, poi si toccano le voci. «Crea l'ordine» lo crea a suo nome, come se l'avesse fatto lei (se è nell'elenco lo vede anche nella sua app), anche dopo l'ora limite; «Crea e chiudi» lo crea già consegnato e incassato (metodo e importo lasciato, proposto il totale indicativo). I nomi scritti a mano restano nell'elenco per i prossimi ordini. **Doni su NFC**: in regia → Doni QR, «📶 NFC» su ogni dono (o «📶 Generatore NFC» per sceglierlo da un elenco) scrive sul tag lo stesso link del QR (record URL; vanno bene NTAG213/215/216). La scrittura dal browser funziona con Chrome su Android con l'NFC acceso; da iPhone si copia il link e lo si scrive con un'app come «NFC Tools». Il tag vale come il QR: nell'app lo scanner «Scansiona» legge anche i tag NFC (Android, Chrome); fuori dall'app il telefono apre il link del dono (iPhone con la lettura NFC di sistema: si apre in Safari, quindi serve essere entrati anche lì). La regia vede quanti tag ha scritto per ogni dono. «🧽 Cancella un tag NFC» (nel Generatore NFC e nella finestra di scrittura) legge il tag e lo svuota, così non dà più niente e si può riusare; se conteneva un dono della partita il suo conteggio scende di uno (i tag bloccati in sola lettura non si cancellano). Negli **eventi**, con il premio «Dono a caso», si può scegliere la fascia di rarità con la barra Comune · Raro · Epico · Leggendario (un tocco = solo quella rarità, un secondo tocco = la fascia tra le due, «Tutte» = nessun limite): il dono esce con le probabilità della partita, ma solo tra quelle rarità; le coppie vedono «Un Dono a caso (da Raro a Epico)». Dono **Furto** (epico): si sceglie da un elenco una coppia non alleata entro 30 m; parte un conto alla rovescia di 15 minuti che vedono entrambe (la derubata riceve subito una notifica con il nome del ladro); uno scontro vinto o perso tra le due (o le loro alleanze) lo annulla, altrimenti allo scadere il ladro riceve il Sigillo della coppia derubata (se lo conosce già, uno a caso tra quelli che lei conosce e lui no). Reliquia Antica o Immunità attive allo scadere lo fanno fallire. **Fase 3, Eletti e incarichi**: gli incarichi delle squadre hanno un tipo e un bersaglio (libero, raggiungere un punto già piazzato, raggiungere una coppia, caccia, incontro); finché un incarico con una coppia bersaglio è aperto, la squadra la vede sulla sua mappa. Maestro della caccia crea un incarico di caccia «da assegnare» (la regia sceglie la squadra; il bersaglio non lo sa); Ombra annulla le cacce e gli incarichi contro chi la usa, con notifica agli Eletti di abortire. Alleanze sporche manda la squadra più vicina (o la sceglie la regia): la coppia la vede in mappa, a 40 m parte l'alleanza di 30 minuti, poi gli Eletti se ne vanno. In regia «Nuova squadra» e «Aggiungi Eletto» si aprono in una finestra.

- **Piazzamento sul campo** (nell'app degli Eletti; per la regia dal telefono in `/campo`): si scansiona il cartello di un Altare o di un Dono, il telefono dà la posizione GPS (o si tocca il punto sulla mappa), si scatta la foto e si conferma. Foto e coordinate arrivano in regia (**Mappa e campo**).
- **Altari subito e Altari senza coppia**: l'Altare di una coppia nasce appena la coppia è formata (lo vedi subito in regia e sulla mappa del campo). In **Altari e Parola** puoi anche creare gli Altari dei Settori prima delle iscrizioni, per piazzarli nel bosco: finché nessuna coppia prende quel Settore restano **senza coppia**. Il loro Sigillo non si vince né si ruba, arriva solo dal tradimento, e uno di loro è sempre l'**ultimo** in calendario (il «lucchetto»: nessuno può finire prima). I mai rivelati si estraggono solo tra le coppie. Le coppie vedono gli Altari in mappa **solo dal via**.
- **Regia su telefono e tablet**: sotto gli 860 px la barra in alto non resta fissa (resta fissa la fila delle sezioni); sul telefono le tabelle diventano schede, la mappa ha l'elenco «Da piazzare» sotto, i messaggi funzionano come un'app di chat (elenco → conversazione → «‹ Conversazioni»).
- **Installare come app**: regia, Soglia e campo hanno ciascuna il proprio manifest, quindi si installano anche dal computer (icona di installazione nella barra dell'indirizzo di Chrome/Edge, o il pulsante «⤓ Installa app» in alto nella regia). Su iPhone: Condividi → Aggiungi a Home.
- **Posti per l'iscrizione**: in Iscrizioni e coppie (o in Impostazioni) decidi quanti **Settori aprire** (vuoto = tutti) e, se vuoi, un tetto ai temerari. N Settori sono 2N posti: la pagina di iscrizione mostra i Settori liberi per le coppie (N − coppie − metà dei temerari in attesa, arrotondata in su) e i posti per i temerari (2N − 2 × coppie − temerari in attesa), e chiude la sfida quando sono finiti. Le coppie si contano da come sono davvero: ogni coppia formata è un Settore (anche se i due avevano creato ognuno il proprio codice, o è un Legato con un temerario), più le coppie iscritte e complete (i due entrati con lo stesso codice) non ancora formate. Chi ha creato la coppia e aspetta il compagno conta come un temerario (mezzo Settore): se un temerario prende l'ultimo posto, la regia li accoppia; il compagno con il codice può comunque entrare. Esempio: 10 Settori e 9 coppie formate → 1 Settore per le coppie e 2 posti per i temerari; con un temerario in attesa → 0 Settori e 1 posto. Chi entra con il codice del compagno usa il posto della sua coppia; gli Eletti non hanno limite. Con i Settori esauriti la sfida «I Legati» resta aperta solo per chi ha il codice del compagno. Un Legato non ancora in coppia può diventare **Temerario Solitario** fino al Cerchio (pagina di iscrizione o anteprima dell'app: «Divento Temerario Solitario»); se il compagno si era già unito, a lui resta il codice coppia per un altro Legato.
- **Pronti per la gara** (regia → Pronti per la gara, prima «Notifiche, Traccar e ICE»): elenco unico di coppie, Eletti, iscritti e organizzazione con notifiche (attive, solo sul telefono della coppia, non attive), Traccar (verificato, spento, da attivare, non manda), ICE, avviso di sicurezza, il telefono e «Copia l'elenco» per il gruppo WhatsApp. Una persona può usare più dispositivi: in tabella c'è il **dispositivo migliore** (quello con più cose attive: app installata, notifiche, posizione, aperta adesso) e con «N dispositivi ▾» si apre sotto la tabella di tutti i suoi dispositivi (sistema e browser, app installata o browser e versione, notifiche, ultima posizione dall'app, ultima apertura) più la riga di Traccar Client. Colori: **verde** = tutto a posto; **verdino** = le cose essenziali ci sono (app installata, notifiche, Traccar verificato) e manca solo l'avviso di sicurezza o l'ICE; il numero = quante cose essenziali mancano. Il numero accanto alla voce conta coppie ed Eletti con qualcosa da sistemare.
- **Installare l'app** (app → `#/installa`, da home, tour, Impostazioni e «Stato all'evento»): passo passo per iPhone (Safari → Condividi → «Aggiungi alla schermata Home», con avviso se la pagina è aperta da WhatsApp, Instagram o Chrome), Android e computer. Su iPhone, finché l'app non è installata, la home mostra «Installa l'app sull'iPhone» al posto dell'invito alle notifiche: su iPhone le notifiche funzionano solo dall'app installata.
- **Traccar guidato** (app → avviso «Traccar da attivare» o Impostazioni → Traccar Client): procedura in 4 passi (installa, configura con i valori da copiare, permessi per Android/iPhone, prova). La prova chiede di bloccare lo schermo per un minuto: se dal telefono arrivano almeno 2 segnali, Traccar è verificato e l'avviso sparisce. A partita in corso, se Traccar tace da 10 minuti, l'avviso torna. Prima del via dei segnali si registra solo l'ora, non la posizione. Se Traccar manda la posizione quando non serve (prima del cerchio, a partita finita o senza coppia), all'apertura l'app avvisa che si può spegnere.
- **Accendi Traccar prima del via**: quando la partita è segnata «pronta» e quando si apre il cerchio, tutti i telefoni ricevono la notifica «Accendi Traccar Client» e nell'app compare, su tutte le pagine, l'avviso con il pulsante «Apri Traccar» (su Android apre direttamente l'app; su iPhone la sua pagina dell'App Store) o «Configura Traccar» per chi non l'ha mai fatto. L'avviso sparisce da solo al primo segnale ricevuto (negli ultimi 3 minuti prima del via, 10 durante la partita).
- **Permessi all'inizio**: il tour del primo accesso chiede subito il permesso della posizione (spiegando a cosa serve) e propone Traccar Client con la procedura guidata; finché la posizione non è consentita, la home mostra «Consenti la posizione adesso». La procedura Traccar ha come primo passo la posizione dell'app. Così al via non compaiono richieste di permesso.
- **Rigiocare una partita finita (solo test)**: su testgames una partita terminata mostra «↺ Riparti da capo (test)». La partita torna «pronta» con il gioco azzerato (frammenti, Sigilli trovati, visite, scontri, alleanze, annunci, messaggi, validazioni, classifica; tradimenti e armamenti di nuovo in calendario, doni di nuovo non comparsi), mentre coppie, Settori, Sigilli, Altari, Parola e piazzamenti restano. In produzione il pulsante non c'è e il server lo rifiuta.
- **Notifiche della regia**: pulsante 🔔 in alto nella regia (anche in Impostazioni). Si attiva su ogni dispositivo dove vuoi riceverle e avvisa a ogni nuova iscrizione (coppie, temerari, candidature agli Eletti), ai messaggi delle coppie, agli scontri contestati e ai doni presi; con la regia aperta l'avviso compare anche nella pagina. Dal pulsante si invia una notifica di prova o si spengono su quel dispositivo. Su iPhone servono l'app aggiunta alla schermata Home.
- **Punti di interesse** (campo: regia in `/campo` ed Eletti nella pagina «Piazza Altari e Doni»): scheda **«Punti»** con «＋ Aggiungi punto di interesse» e l'elenco (dal più vicino, con ricerca, Mappa, Modifica, Elimina); anche dalla Mappa. Ogni punto salva una coordinata (GPS o tocco sulla mappa) con un nome e una descrizione. I punti compaiono come rombo viola sulla mappa del campo e della regia, nell'elenco sotto la mappa (dal più vicino, con Modifica ed Elimina) e nel KMZ. Quando si piazza un Altare, un Dono o un luogo, «🔎 Usa un punto di interesse» li cerca per nome o descrizione e usa quella coordinata come posizione.
- **Esporta KMZ (ATAK)**: regia (Mappa e campo, Altari e Parola) ed Eletti (mappa del campo) scaricano tutti i punti piazzati (luoghi, Altari, Doni, punti indicati) in un KMZ con le icone, da aprire in ATAK o Google Earth. Le coppie scaricano solo ciò che vedono nella loro mappa.
- **Piazza provvisorio**: senza cartello o foto (es. il sopralluogo prima dell'evento) si segna solo il punto. In mappa compare con il triangolo giallo ⚠ «!» e resta tra le cose da fare finché non lo si **conferma** col piazzamento normale (cartello e foto). Un Dono «appena piazzato» non viene annunciato finché è provvisorio.
- **Mappe OpenTopoMap**: la regia vede Altari e doni (grigio = piazzato non comparso, colorato = comparso, barrato = preso); le coppie vedono Altari e doni comparsi più la propria posizione.
- **Posizioni GPS in mappa**: i telefoni delle coppie inviano la posizione solo a partita iniziata (dal VIA alla fine, anche in pausa), quelli degli Eletti da quando la partita è **Pronta** (non durante la preparazione). La regia vede tutti (coppie con il numero romano, Eletti con il colore della squadra), gli Eletti vedono solo gli Eletti. L'app avvisa chi è visibile; i browser inviano la posizione solo con l'app aperta. *Nota: la specifica iniziale escludeva il tracciamento delle coppie; è stato aggiunto su richiesta dell'organizzazione.*
- **Mine traccianti degli Eletti** (app degli Eletti → «Mine traccianti»): ogni Eletto posa una mina dove si trova (GPS, al massimo ±50 m). La vede solo il Consiglio (💣 in mappa a regia ed Eletti, con il raggio). La prima coppia che passa entro il raggio (di base 20 m) la fa scattare: la coppia è **marcata** e per 5 minuti tutti la vedono in mappa (coppie ed Eletti, con «💣 marcata»); la coppia lo scopre sempre **il minuto dopo** (notifica e fascia rossa con la mina e il conto alla rovescia in home e in mappa). Chi è nascosto (Ombra, Cono d'Ombra) non la fa scattare. Ogni Eletto ha N mine (di base 3): si ricaricano alla **Base degli Eletti**, un nuovo luogo del gioco da piazzare come la Soglia (Altari e Parola → Luoghi del gioco; le coppie non lo vedono), stando entro 30 m. La regia toglie una mina dal popup in mappa o da Squadre Eletti → Punteggio e mine. Una mina che non scatta si spegne dopo una durata scelta dalla posa (di base **60 minuti**, 0 = senza scadenza). La regia può anche **ricaricare le mine** a un Eletto o a tutti da Squadre Eletti → Punteggio e mine, ovunque si trovino. Numero di mine, raggio, durata della marcatura e durata della mina in **Impostazioni → Eletti: mine e punteggio**.
- **Punteggio degli Eletti** (regia → Squadre Eletti → Punteggio e mine; app degli Eletti → «Punteggio» e riquadro in home): punti per squadra e per Eletto a ogni azione riuscita — ingaggio vinto (confermato, 3), taglia riscossa (incarico taglia chiuso, 5; riaperto, i punti si tolgono), Beacon riuscito (Altare attivo disattivato o zona accesa, 2), mina scattata (2). I valori si cambiano nei parametri e valgono anche per le azioni già fatte.
- **Squadre di Eletti** (regia → Squadre Eletti): candidature, squadre con colore, membri, accessi personali e incarichi liberi; ogni Eletto trova tutto nella voce **Incarichi** della sua app.
- **Incarichi di piazzamento** (Altari e Parola, Doni QR, Squadre Eletti): per ogni Altare, Dono o luogo vedi se è piazzato e da quale squadra, e lo assegni a una squadra con una finestra che chiede il **punto sulla mappa** (o lascia libera la scelta) e una nota. Un punto già piazzato si può **far spostare**: viene proposta la squadra che lo aveva piazzato.
- **Luoghi del gioco**: il **Cerchio di inizio** e la **Soglia** si piazzano come gli Altari (foto facoltativa) e compaiono sulle mappe di regia, Eletti e coppie.
- **Doni QR**: crea il dono, fallo piazzare a una squadra, **annuncialo** (ora, tra X minuti, alle HH:MM o a un minuto dal via) con la timeline del torneo; scadenza facoltativa. La prima coppia che lo scansiona lo prende; tutti ricevono una notifica e il dono sparisce dalle mappe.
- **Timeline del torneo**: ovunque si sceglie "quando e per quanto" (annuncio dei doni, finestre armamenti) si apre una finestra con la linea del tempo della partita: fasi, tradimenti, armamenti, doni e il momento attuale. Si tocca la timeline o si sceglie ora / tra X minuti / alle HH:MM / al minuto dal via.
- **Armamenti**: finestre con apertura e durata; all'apertura annuncio e conto alla rovescia nelle app, alla chiusura un secondo annuncio. Si possono aprire subito, anticipare, posticipare, prolungare o chiudere prima.
- **Annunci e messaggi**: vista ad albero — tutte le coppie (annunci) e sotto ogni coppia; tutti gli Eletti e sotto ogni squadra — con la conversazione a destra (testo e vocali).
- **Scansione degli Altari a tempo**: vale i minuti impostati nella partita (default 15, 0 = sempre); poi va ripetuta. Se il Sigillo è già nel taccuino l'app lo propone, senza scriverlo.
- **Alleanze** (pagina sua nell'app): proposta e accettazione (massimo 3 coppie), rottura allo stesso modo; gli alleati ricevono i Sigilli gli uni degli altri. Le alleanze sono **segrete**: le altre coppie non vedono chi è alleato con chi né quante coppie ha un'alleanza (il server non lo manda); se insieme si superano le 3 coppie, l'alleanza si rifiuta all'accettazione. **Rottura per distanza**: se una coppia resta per più di 5 minuti a più di 50 m da tutti gli alleati (ultime posizioni GPS/Traccar degli ultimi 3 minuti, controllo ogni 20 s), l'alleanza si rompe da sola come una rottura normale (blocco ingaggio 5 minuti), con notifica agli ex alleati e voce nel registro della regia.
- **Scontri**: VINTO / PERSO / PAREGGIO contro una coppia. "Vinto" va confermato dallo sconfitto e "perso" dal vincitore (se contesta decide la regia): Sigilli e Veglia partono alla conferma; il pareggio vale subito. I vincitori e i loro alleati ricevono i Sigilli di tutta la parte sconfitta; chi perde riceve in automatico il timer Veglia (popup Sconfitta). Chi vince, e ogni suo alleato, vede il popup **Vittoria** con i Sigilli di tutta la parte sconfitta, anche quelli che conosceva già. Negli scontri della parte avversaria si vede solo la coppia con cui si è combattuto. Se la vittoria non porta nessun Sigillo nuovo (li conoscevate già tutti), la Vittoria propone quale **rubare**: i Sigilli che la parte sconfitta conosce (il taccuino di tutta l'alleanza, sommato) meno quelli che conoscete voi; scelto, si svela come negli ingaggi. Se si chiude il popup, la scelta resta nella pagina Scontri. In regia le uscite dalla Soglia (verde: Parola valida; rosso: respinta, con i frammenti mancanti o errati) e gli scontri compaiono sulla **timeline del torneo** (gli scontri sono rombi rossi): esito, parti (anche le alleanze, che la regia vede), Sigilli rubati; quelli da confermare o contestati si confermano o annullano cliccandoli.
- **Voto del pubblico** (`/vota`, regia → Voto del pubblico): con il voto acceso, ogni coppia formata dopo entra da sola tra quelle votabili (la si può togliere); un voto per dispositivo; dalla stessa rete (stesso Wi-Fi o indirizzo) ogni voto **nuovo** dopo il primo aspetta 3, poi 10, poi 30 minuti dal precedente, con un popup e il conto alla rovescia (cambiare il proprio voto non aspetta mai; dopo 2 ore senza voti da quella rete si riparte da capo; il controllo è sul server, quindi incognito, cookie cancellati o un altro browser non lo aggirano; la rete è l'indirizzo IPv4 o il blocco /64 per IPv6, e l'indirizzo si legge solo dai proxy fidati, Caddy in locale o in rete privata, per cui un `X-Forwarded-For` inventato dal client non conta; `TRUST_PROXY` nel `.env` cambia la regola), voto con l'account che pesa di più, segnalazione dei picchi. **Tor**: il server scarica ogni ora l'elenco pubblico dei nodi di uscita di Tor (`check.torproject.org/torbulkexitlist`, resta salvato) e da lì non si vota; in regia «Voti da Tor» conta e annulla i voti già arrivati da quegli indirizzi. **Anti-robot**: Cloudflare Turnstile (gratis, senza spostare il dominio su Cloudflare) si attiva incollando le due chiavi in regia o con `TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET` nel `.env`.

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
