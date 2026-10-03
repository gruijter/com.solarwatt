Połącz swój system Solarwatt vision z Homey przez sieć lokalną (Modbus TCP). Konto w chmurze nie jest potrzebne.

Obsługiwane urządzenia:
- Inverter vision: moc i uzysk z fotowoltaiki, moc falownika, zużycie domu, parametry sieci i alarmy. Możesz ograniczyć moc wyjściową i oddawanie energii do sieci.
- Battery vision: stan naładowania i zdrowia, moc, energia, temperatury i alarmy. Homey może ładować i rozładowywać akumulator, a Ty możesz ustawić tryb pracy i limity SoC.
- Licznik sieciowy podłączony do falownika: moc na fazę, energia pobrana i oddana, napięcia.
- Charger vision: moc ładowania, energia i wartości fazowe. Uruchamiaj i zatrzymuj ładowanie z Homey.

Wymagania: Modbus TCP musi być włączony na urządzeniach (zapytaj instalatora), a Homey musi być w tej samej sieci. Nadaj urządzeniom stały adres IP w routerze. Są wykrywane automatycznie; w przeciwnym razie wpisz adres IP samodzielnie.

SOLARWATT Manager: jeśli jest zainstalowany, może przejąć od Homey sterowanie akumulatorem i limitami mocy. Homey pokazuje wtedy „Sterowanie nadpisane” i pozostawia sterowanie Managerowi, dopóki sam ponownie czegoś nie ustawisz.
