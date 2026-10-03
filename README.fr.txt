Connectez votre système Solarwatt vision à Homey via votre réseau local (Modbus TCP). Aucun compte cloud n'est nécessaire.

Appareils pris en charge :
- Inverter vision : puissance et production solaires, puissance de l'onduleur, consommation de la maison, valeurs réseau et alarmes. Vous pouvez limiter la puissance de sortie et l'injection sur le réseau.
- Battery vision : état de charge et de santé, puissance, énergie, températures et alarmes. Homey peut charger et décharger la batterie, et vous pouvez régler le mode de fonctionnement et les limites de SoC.
- Compteur réseau raccordé à l'onduleur : puissance par phase, énergie importée et exportée, tensions.
- Charger vision : puissance de charge, énergie et valeurs par phase. Démarrez et arrêtez la charge depuis Homey.

Prérequis : Modbus TCP doit être activé sur les appareils (demandez à votre installateur) et Homey doit être sur le même réseau. Donnez aux appareils une adresse IP fixe dans votre routeur. Ils sont trouvés automatiquement ; sinon, saisissez vous-même l'adresse IP.

SOLARWATT Manager : s'il est installé, il peut reprendre à Homey le pilotage de la batterie et des limites de puissance. Homey affiche alors « Pilotage écrasé » et laisse le pilotage au Manager jusqu'à ce que vous modifiiez à nouveau un réglage.
