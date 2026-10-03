Anslut dina SOLARWATT vision-enheter till Homey via ditt lokala nätverk (Modbus TCP). Inget molnkonto behövs.

Enheter som stöds:
- Inverter vision: soleffekt och solproduktion, växelriktareffekt, husets förbrukning, nätvärden och larm. Du kan begränsa uteffekten och inmatningen till nätet.
- Battery vision: laddningsnivå och hälsa, effekt, energi, temperaturer och larm. Homey kan ladda och ladda ur batteriet, och du kan ställa in driftläge och SoC-gränser.
- Nätmätare ansluten till växelriktaren: effekt per fas, importerad och exporterad energi, spänningar.
- Charger vision: laddeffekt, energi och fasvärden. Starta och stoppa laddning från Homey.

Krav: Modbus TCP måste vara aktiverat på enheterna (fråga din installatör), och Homey måste finnas i samma nätverk. Ge enheterna en fast IP-adress i routern. De hittas automatiskt; annars anger du IP-adressen själv.

SOLARWATT Manager: Om en sådan finns kan den ta tillbaka styrningen av batteriet och effektgränserna från Homey. Homey visar då 'Styrning överskriven' och lämnar styrningen till Managern tills du själv ändrar en inställning igen. Vill du styra batteriet från Homey måste Managern inte styra det (fråga din installatör).
