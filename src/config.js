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
				isVisible: (configValues) => configValues.channel == 'none',
			},
			{
				type: 'textinput',
				id: 'manager_ip',
				label: 'AdIT Management Service IP Address',
				tooltip: 'The IP address of the server hosting the AdIT Management Service',
				default: '127.0.0.1',
				width: 6
			},
			{
				type: 'textinput',
				id: 'manager_port',
				label: 'AdIT Management Service Port Number',
				tooltip: 'The port number of the AdIT Management Service',
				default: '8000',
				width: 6,
				regex: this.REGEX_NUMBER
			},
			{
				type: 'textinput',
				id: 'config_polling_rate',
				label: 'AdIT Management Service Refresh Rate (in seconds)',
				tooltip: 'How often to refresh the Channels, Management Rules, Variables, and Instance information from the Management Server',
				default: 5,
				width: 6,
				regex: this.REGEX_NUMBER
			},
			{
				type: 'dropdown',
				id: 'channel',
				label: 'Channel',
				width: 12,
				choices: this.getChannelChoices.bind(this)(),
				default: this.getChannelChoices.bind(this)()[0].id,
				isVisible: (configValues) => configValues.channel !== 'none',
			},
			{
				type: 'checkbox',
				id: 'log_control_interface_messages',
				label: 'Log Control Interface Messages',
				tooltip: 'Log all AdIT instance Control Interface messages',
				width: 6,
				default: true,
				isVisible: (configValues) => configValues.channel !== 'none',
			}
		]
	}
}