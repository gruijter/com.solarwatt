/*
Copyright 2025 - 2026, Robin de Gruijter (rmdegruijter@gmail.com)

This file is part of com.solarwatt.

com.solarwatt is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

com.solarwatt is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with com.solarwatt.  If not, see <http://www.gnu.org/licenses/>.
*/

'use strict';

const Homey = require('homey');
const ModbusPool = require('./lib/ModbusPool');

module.exports = class SolarwattApp extends Homey.App {

  async onInit() {
    // Shared Modbus clients: inverter, battery and meter devices all talk to the same server.
    this.pool = new ModbusPool();

    this.homey.flow.getActionCard('force_poll')
      .registerRunListener(async () => {
        this.homey.emit('poll');
        return true;
      });

    // A SOLARWATT Manager on the network can take control back from Homey (deviation D-08).
    this.managerDiscovery = this.homey.discovery.getStrategy('manager');
    this.managerDiscovery.on('result', () => this.homey.emit('energyManager'));

    this.log('Solarwatt app initialized');
  }

  /** "EVX01-200017651 (192.168.2.18)" for the first SOLARWATT Manager found, else ''. */
  energyManagerLabel() {
    const [result] = Object.values(this.managerDiscovery ? this.managerDiscovery.getDiscoveryResults() : {});
    if (!result) return '';
    return result.address ? `${result.name} (${result.address})` : result.name;
  }

  async onUninit() {
    if (this.pool) this.pool.destroy();
    this.log('Solarwatt app unloaded');
  }

};
