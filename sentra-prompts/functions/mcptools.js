import SentraMcpSDK from 'sentra-mcp/sdk';

export async function getMcpTools() {
	try {
		const sdk = new SentraMcpSDK();
		const result = await sdk.exportTools({ format: 'xml' });
		return result?.content || '';
	} catch (err) {
		const msg = err?.message || String(err);
		return `<sentra-mcp-tools><error>${msg}</error></sentra-mcp-tools>`;
	}
}