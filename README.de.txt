Verbinde deine SOLARWATT vision-Geräte über dein lokales Netzwerk (Modbus TCP) mit Homey. Ein Cloud-Konto ist nicht nötig.

Unterstützte Geräte:
- Inverter vision: Solarleistung und -ertrag, Wechselrichterleistung, Hausverbrauch, Netzwerte und Störungen. Du kannst die Ausgangsleistung und die Netzeinspeisung begrenzen.
- Battery vision: Ladezustand und Gesundheitszustand, Leistung, Energie, Temperaturen und Störungen. Homey kann die Batterie laden und entladen, und du kannst Betriebsmodus und SoC-Grenzen einstellen.
- Netzzähler am Wechselrichter: Leistung pro Phase, Bezug und Einspeisung, Spannungen.
- Charger vision: Ladeleistung, Energie und Phasenwerte. Laden aus Homey starten und stoppen.

Voraussetzungen: Modbus TCP muss an den Geräten aktiviert sein (frag deinen Installateur), und Homey muss im selben Netzwerk sein. Gib den Geräten eine feste IP-Adresse in deinem Router. Sie werden automatisch gefunden; sonst gib die IP-Adresse selbst ein.

SOLARWATT Manager: Ist einer installiert, kann er Homey die Steuerung der Batterie und der Leistungsgrenzen wieder abnehmen. Homey zeigt dann 'Steuerung überschrieben' und überlässt dem Manager die Steuerung, bis du selbst wieder etwas einstellst.
