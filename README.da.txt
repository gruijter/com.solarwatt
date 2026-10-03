Forbind dine SOLARWATT vision-enheder med Homey via dit lokale netværk (Modbus TCP). Der kræves ingen cloudkonto.

Understøttede enheder:
- Inverter vision: soleffekt og -produktion, invertereffekt, husforbrug, netværdier og alarmer. Du kan begrænse udgangseffekten og leveringen til nettet.
- Battery vision: ladetilstand og sundhed, effekt, energi, temperaturer og alarmer. Homey kan oplade og aflade batteriet, og du kan indstille driftstilstand og SoC-grænser.
- Netmåler tilsluttet inverteren: effekt pr. fase, importeret og eksporteret energi, spændinger.
- Charger vision: ladeeffekt, energi og faseværdier. Start og stop opladning fra Homey.

Krav: Modbus TCP skal være slået til på enhederne (spørg din installatør), og Homey skal være på samme netværk. Giv enhederne en fast IP-adresse i din router. De findes automatisk; ellers indtaster du selv IP-adressen.

SOLARWATT Manager: Hvis en er installeret, kan den tage styringen af batteriet og effektgrænserne tilbage fra Homey. Homey viser så 'Styring overskrevet' og overlader styringen til Manageren, indtil du selv ændrer en indstilling igen.
