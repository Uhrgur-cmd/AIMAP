// OPC UA client using node-opcua for symbolic browse/read/write on S7-1200/1500.
// Enable the OPC UA Server on the CPU in TIA; node-opcua samples show client connect/browse/read. [2](https://www.docs.inductiveautomation.com/docs/8.3/ignition-modules/opc-ua/opc-ua-drivers/siemens/siemens-enhanced-driver)[3](https://dev.to/sanjaysundarmurthy/helm-charts-from-scratch-package-version-and-deploy-kubernetes-apps-like-a-pro-335)
const { OPCUAClient, AttributeIds, MessageSecurityMode, SecurityPolicy } = require('node-opcua');

async function withSession(endpointUrl, fn) {
  const client = OPCUAClient.create({
    endpointMustExist: false,
    securityMode: MessageSecurityMode.None,
    securityPolicy: SecurityPolicy.None
  });
  await client.connect(endpointUrl);
  const session = await client.createSession();
  try {
    return await fn(session);
  } finally {
    await session.close();
    await client.disconnect();
  }
}

async function browseOnce(endpointUrl, nodeId = 'ObjectsFolder') {
  return withSession(endpointUrl, async (session) => {
    const br = await session.browse(nodeId);
    return (br.references || []).map((r) => ({
      browseName: r.browseName.toString(),
      nodeId: r.nodeId.toString(),
      nodeClass: r.nodeClass
    }));
  });
}

async function readNode(endpointUrl, nodeId) {
  return withSession(endpointUrl, async (session) => {
    const dataValue = await session.read({ nodeId, attributeId: AttributeIds.Value });
    return { nodeId, value: dataValue.value?.value, statusCode: dataValue.statusCode?.toString() };
  });
}

async function writeNode(endpointUrl, nodeId, variant /* { dataType, value } */) {
  return withSession(endpointUrl, async (session) => {
    const statusCode = await session.write({ nodeId, attributeId: AttributeIds.Value, value: { value: variant } });
    return { nodeId, statusCode: statusCode.toString() };
  });
}

module.exports = { browseOnce, readNode, writeNode };