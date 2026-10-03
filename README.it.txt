Collega i tuoi dispositivi SOLARWATT vision a Homey tramite la rete locale (Modbus TCP). Non serve un account cloud.

Dispositivi supportati:
- Inverter vision: potenza e produzione solare, potenza dell'inverter, consumo della casa, valori di rete e allarmi. Puoi limitare la potenza in uscita e l'immissione in rete.
- Battery vision: stato di carica e di salute, potenza, energia, temperature e allarmi. Homey può caricare e scaricare la batteria e puoi impostare la modalità di lavoro e i limiti di SoC.
- Contatore di rete collegato all'inverter: potenza per fase, energia prelevata e immessa, tensioni.
- Charger vision: potenza di ricarica, energia e valori per fase. Avvia e ferma la ricarica da Homey.

Requisiti: Modbus TCP deve essere attivo sui dispositivi (chiedi al tuo installatore) e Homey deve essere nella stessa rete. Assegna ai dispositivi un IP fisso nel router. Vengono trovati automaticamente; altrimenti inserisci tu l'indirizzo IP.

SOLARWATT Manager: se è installato, può riprendere da Homey il controllo della batteria e dei limiti di potenza. Homey mostra allora «Controllo sovrascritto» e lascia il controllo al Manager finché non modifichi di nuovo un'impostazione. Per controllare la batteria da Homey, assicurati che il Manager non la controlli (chiedi al tuo installatore).
