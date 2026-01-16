/**
 * @fileoverview Companion configuration field definitions
 * 
 * Defines the module's configuration UI including manager connection settings,
 * channel selection dropdown, and hidden fields for control interface ID and
 * definition caching.
 * 
 * @module companion-module-middleman-adit/config
 */
const { Regex } = require('@companion-module/base')

module.exports = {
  getConfigFields() {
    return [
      {
        type: 'static-text',
        id: 'info',
        label: 'Information',
        width: 12,
        value: `
          <div class="alert alert-warning">
            <div>
              <strong>To use this module:</strong>
              <br>
              <ol>
                <li>First enter your AdIT Management Service IP Address and Port.</li>
                <li>Click "Save"</li>
                <li>Then return to this Connection page, and a list of channels will be available.</li>
              </ol>
            </div>
          </div>
        `,
      },
      {
        type: 'textinput',
        id: 'manager_ip',
        label: 'AdIT Management Service IP Address',
        tooltip: 'The IP address of the server hosting the AdIT Management Service',
        default: '127.0.0.1',
        width: 6,
      },
      {
        type: 'textinput',
        id: 'manager_port',
        label: 'AdIT Management Service Port Number',
        tooltip: 'The port number of the AdIT Management Service',
        default: '8000',
        width: 6,
        regex: Regex.NUMBER,
      },
      {
        type: 'dropdown',
        id: 'channel',
        label: 'Channel',
        width: 12,
        choices: this.getChannelChoices.bind(this)(),
        default: 'none',
      },
      // Hidden field: auto-generated UUID for WebSocket identification
      {
        type: 'textinput',
        id: 'control_interface_id',
        label: 'Control Interface ID',
        width: 6,
        default: '',
        isVisible: () => false,
      },
      // Hidden field: caches manager definitions to allow operation when manager
      // is temporarily unreachable. Stores raw JSON from manager endpoints along
      // with metadata for validation (manager IP, channel ID, timestamp).
      {
        type: 'textinput',
        id: 'definition_cache',
        label: 'Definition Cache',
        width: 6,
        default: '{}',
        isVisible: () => false,
      },
      {
        type: 'static-text',
        id: 'hr2',
        width: 12,
        label: '',
        value: '<hr />',
      },
      {
        type: 'checkbox',
        id: 'verbose',
        label: 'Enable Verbose Logging',
        width: 3,
        default: false,
      },
      {
        type: 'static-text',
        id: 'info-verbose',
        label: 'Verbose Logging',
        width: 9,
        value: 'Enabling this option will put more detail in the log, which can be useful for troubleshooting purposes.',
      },
    ]
  },
}