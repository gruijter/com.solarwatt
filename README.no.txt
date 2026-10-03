Koble Solarwatt vision-systemet ditt til Homey via det lokale nettverket (Modbus TCP). Ingen skykonto trengs.

Støttede enheter:
- Inverter vision: soleffekt og solproduksjon, vekselretter-effekt, husforbruk, nettverdier og alarmer. Du kan begrense utgangseffekten og innmatingen til nettet.
- Battery vision: ladenivå og helse, effekt, energi, temperaturer og alarmer. Homey kan lade og utlade batteriet, og du kan stille inn driftsmodus og SoC-grenser.
- Nettmåler koblet til vekselretteren: effekt per fase, importert og eksportert energi, spenninger.
- Charger vision: ladeeffekt, energi og faseverdier. Start og stopp lading fra Homey.

Krav: Modbus TCP må være slått på på enhetene (spør installatøren din), og Homey må være på samme nettverk. Gi enhetene en fast IP-adresse i ruteren. De blir funnet automatisk; ellers skriver du inn IP-adressen selv.

SOLARWATT Manager: Hvis en er installert, kan den ta tilbake styringen av batteriet og effektgrensene fra Homey. Homey viser da 'Styring overstyrt' og overlater styringen til Manageren til du selv endrer en innstilling igjen.
