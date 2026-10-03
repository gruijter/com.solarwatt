Conecta tus dispositivos SOLARWATT vision a Homey a través de tu red local (Modbus TCP). No se necesita cuenta en la nube.

Dispositivos compatibles:
- Inverter vision: potencia y producción solar, potencia del inversor, consumo de la casa, valores de red y alarmas. Puedes limitar la potencia de salida y la inyección a la red.
- Battery vision: estado de carga y de salud, potencia, energía, temperaturas y alarmas. Homey puede cargar y descargar la batería, y puedes ajustar el modo de trabajo y los límites de SoC.
- Medidor de red conectado al inversor: potencia por fase, energía importada y exportada, tensiones.
- Charger vision: potencia de carga, energía y valores por fase. Inicia y detén la carga desde Homey.

Requisitos: Modbus TCP debe estar activado en los dispositivos (pregunta a tu instalador) y Homey debe estar en la misma red. Asigna a los dispositivos una IP fija en tu router. Se encuentran automáticamente; si no, introduce tú mismo la dirección IP.

SOLARWATT Manager: si hay uno instalado, puede retomar de Homey el control de la batería y de los límites de potencia. Homey muestra entonces «Control anulado» y deja el control al Manager hasta que vuelvas a cambiar un ajuste. Para controlar la batería desde Homey, asegúrate de que el Manager no la controle (pregunta a tu instalador).
