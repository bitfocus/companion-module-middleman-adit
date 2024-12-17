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
				tooltip: 'How often to refresh channels, rules, variables, and instance information from the AdIT Management Service',
				default: 5,
				width: 6,
				regex: this.REGEX_NUMBER,
				isVisible: (configValues) => false,
			},
			{
				type: 'dropdown',
				id: 'channel',
				label: 'Channel',
				width: 12,
				choices: this.getChannelChoices.bind(this)(),
				default: 'none',
				//isVisible: (configValues) => configValues.channelsLoaded === true
			},
			{
				type: 'checkbox',
				id: 'log_control_interface_messages',
				label: 'Log Control Interface Messages',
				tooltip: 'Log all AdIT control interface messages sent and received',
				width: 6,
				default: false,
				isVisible: (configValues) => configValues.channel !== 'none',
			},
			{
				type: 'textinput',
				id: 'control_interface_id',
				label: 'Control Interface ID',
				tooltip: 'The ID of the control interface to use for this Companion instance',
				width: 6,
				default: '',
				isVisible: (configValues) => false,
			},
			{
				type: 'checkbox',
				id: 'clear_intervals',
				label: 'Clear All Intervals on Error',
				tooltip: 'Clear all intervals when an error occurs',
				width: 6,
				default: true,
			},
		]
	}
}