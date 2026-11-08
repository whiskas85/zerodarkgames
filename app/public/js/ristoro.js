// Il Ristoro del Consiglio ora è dentro l'app del Consiglio: /ristoro porta lì (con #gestione alla gestione).
location.replace(`/consiglio${location.hash === '#gestione' ? '#ristoro-gestione' : '#ristoro'}`);
