# Solarwatt

Local Homey integration for SOLARWATT vision devices.

Connect your SOLARWATT vision devices to Homey over your local network (Modbus TCP). No cloud account is needed.

Supported devices:
- Inverter vision: solar power and yield, inverter output, house consumption, grid values and alarms. You can limit the output power and the feed-in to the grid.
- Battery vision: state of charge and health, power, energy, temperatures and alarms. Homey can charge and discharge the battery, and you can set the work mode and SoC limits.
- Grid meter connected to the inverter: power per phase, imported and exported energy, voltages.
- Charger vision: charging power, energy and phase values. Start and stop charging from Homey.

Requirements: Modbus TCP must be enabled on the devices (ask your installer), and Homey must be on the same network. Give the devices a fixed IP address in your router. They are found automatically; otherwise enter the IP address yourself.
