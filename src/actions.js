const xml2js = require('xml2js')

module.exports = {
	initActions() {
		this.setActionDefinitions({
			set_variable_value: {
				name: 'Set Variable Value',
				options: [
					{
						type: 'dropdown',
						id: 'variable',
						label: 'Variable',
						width: 6,
						choices: this.getVariableChoices(),
						required: true
					},
					{
						type: 'textinput',
						label: 'Value',
						id: 'value',
						default: '',
						useVariables: true,
					}
				],
				callback: async (action) => {
					this.log('debug', `Sending request to set variable: ${action.options.variable} to value: ${action.options.value}`)

					//Construct XML request to set variable value
					let val = await this.parseVariablesInString(action.options.value)

					let obj = { SetVariableValueRequest: { $: { ID: action.options.variable }, _: val} }

					let builder = new xml2js.Builder()
					let xml = builder.buildObject(obj)

					//Send XML to AdIT instance via Control Interface WebSocket
					this.sendMessage(xml + '\r\n')

					//Finally, if option is turned on, log the message that was sent
					if (this.config.log_control_interface_messages) {
						this.log('info', `AdIT control interface message sent: ${xml}`)
					}
				},
			},
			evaluate_manual_rule: {
				name: 'Evaluate Messaging Rule',
				options: [
					{
						type: 'dropdown',
						id: 'messaging_rule',
						label: 'Messaging Rule',
						tooltip: 'Only messaging rules with rule type Manual will appear in this list.',
						width: 6,
						choices: this.getManualRuleChoices(),
						required: true
					}
				],
				callback: (action) => {
					this.log('debug', `Sending request to evaluate messaging rule: ${action.options.messaging_rule}`)

					//Construct XML request to set variable value
					let obj = { EvaluateManualMessagingRuleRequest: { $: { ID: action.options.messaging_rule } } }
					let builder = new xml2js.Builder()
					let xml = builder.buildObject(obj)

					//Send XML to AdIT instance via Control Interface WebSocket
					this.sendMessage(xml + '\r\n')

					//Finally, if option is turned on, log the message that was sent
					if (this.config.log_control_interface_messages) {
						this.log('info', `AdIT control interface message sent: ${xml}`)
					}
				}
			}
		})
	},

	sendMessage(msg) {
		for (let i = 0; i < this.aditInstanceWebSockets.length; i++) {
			if (this.aditInstanceWebSockets[i].state == 'open') {
				let aditInstance = this.aditInstanceDefinitions.find(x => x.ID == this.aditInstanceWebSockets[i].ID);
				this.log('debug', `Sending message to AdIT instance: ${aditInstance.Name} (${aditInstance.ID})`);
				this.aditInstanceWebSockets[i].ws.send(msg);
			}
		}
	}
}