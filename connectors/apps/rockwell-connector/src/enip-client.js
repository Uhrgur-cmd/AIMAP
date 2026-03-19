// Rockwell EtherNet/IP helper using st-ethernet-ip.
// st-ethernet-ip automatically retrieves tag list and UDT templates after connect. [1](https://bing.com/search?q=cpppo+GitHub+pjkundert+cpppo+Ethernet%2fIP+CIP+browse)
const { Controller } = require('st-ethernet-ip');

/**
 * Connects to a PLC and returns basic properties and a sample tag read (optional).
 */
async function connectAndSample(ip, slot = 0, sampleTag) {
  const plc = new Controller();
  await plc.connect(ip, slot);

  const result = {
    properties: plc.properties || {},
    // Depending on controller/project, tagList is available after connect:
    tagCount: Array.isArray(plc.tagList) ? plc.tagList.length : undefined
  };

  if (sampleTag) {
    const tag = plc.newTag(sampleTag);
    await plc.readTag(tag);
    result.sample = { name: tag.name, value: tag.value };
  }
  await plc.disconnect?.();
  return result;
}

/**
 * Reads a tag value.
 */
async function readTag(ip, slot, tagName) {
  const plc = new Controller();
  await plc.connect(ip, slot);
  const tag = plc.newTag(tagName);
  await plc.readTag(tag);
  await plc.disconnect?.();
  return { name: tag.name, value: tag.value };
}

/**
 * Writes a tag value.
 */
async function writeTag(ip, slot, tagName, value) {
  const plc = new Controller();
  await plc.connect(ip, slot);
  const tag = plc.newTag(tagName);
  tag.value = value;
  await plc.writeTag(tag);
  await plc.disconnect?.();
  return { name: tag.name, value: tag.value };
}

module.exports = { connectAndSample, readTag, writeTag };