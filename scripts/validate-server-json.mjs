// Validate server.json against the published schema named by its $schema URL.
//
// Usage: node scripts/validate-server-json.mjs
//
// The schema host is fixed to the official MCP Registry schema host. Run this
// from the repository root.

import { readFileSync } from "node:fs";
import Ajv from "ajv";
import addFormats from "ajv-formats";

const SCHEMA_URL =
  /^https:\/\/static\.modelcontextprotocol\.io\/schemas\/[0-9]{4}-[0-9]{2}-[0-9]{2}\/server\.schema\.json$/;

function fail(message) {
  console.error(`error: ${message}`);
  return 1;
}

async function main() {
  const server = JSON.parse(readFileSync("server.json", "utf8"));
  const schemaUrl = server.$schema;
  if (typeof schemaUrl !== "string" || !SCHEMA_URL.test(schemaUrl)) {
    return fail(`server.json $schema must be a published MCP server schema, got ${JSON.stringify(schemaUrl)}`);
  }

  const response = await fetch(schemaUrl);
  if (!response.ok) {
    return fail(`GET ${schemaUrl} returned ${response.status}`);
  }
  const schema = await response.json();
  if (schema.$id !== schemaUrl) {
    return fail(`schema $id ${JSON.stringify(schema.$id)} does not match ${schemaUrl}`);
  }

  // The published schema uses annotation keywords such as "example".
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  if (validate(server)) {
    console.log(`ok: server.json matches ${schemaUrl}`);
    return 0;
  }
  console.error(`error: server.json does not match ${schemaUrl}`);
  for (const issue of validate.errors ?? []) {
    console.error(`  ${issue.instancePath || "/"} ${issue.message}`);
  }
  return 1;
}

process.exitCode = await main();
