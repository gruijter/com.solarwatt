Verbind je SOLARWATT vision-apparaten met Homey via je lokale netwerk (Modbus TCP). Een cloudaccount is niet nodig.

Ondersteunde apparaten:
- Inverter vision: zonnevermogen en -opbrengst, omvormervermogen, huisverbruik, netwaarden en storingen. Je kunt het uitgangsvermogen en de teruglevering aan het net begrenzen.
- Battery vision: laadtoestand en gezondheid, vermogen, energie, temperaturen en storingen. Homey kan de batterij laden en ontladen, en je kunt de werkmodus en SoC-grenzen instellen.
- Netmeter aangesloten op de omvormer: vermogen per fase, import- en exportenergie, spanningen.
- Charger vision: laadvermogen, energie en fasewaarden. Start en stop het laden vanuit Homey.

Vereisten: Modbus TCP moet aan staan op de apparaten (vraag je installateur), en Homey moet in hetzelfde netwerk zitten. Geef de apparaten een vast IP-adres in je router. Ze worden automatisch gevonden; anders vul je het IP-adres zelf in.

SOLARWATT Manager: als die aanwezig is, kan hij de sturing van de batterij en de vermogensgrenzen van Homey overnemen. Homey toont dan 'Sturing overschreven' en laat de sturing aan de Manager tot je zelf weer iets instelt. Wil je de batterij vanuit Homey sturen, zorg dan dat de Manager hem niet stuurt (vraag je installateur).
